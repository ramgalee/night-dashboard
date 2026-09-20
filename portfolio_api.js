// 모의 포트폴리오 — 저장소 + 시세
//   GET  /pf/state           포트폴리오 전체 불러오기
//   POST /pf/state           통째로 저장
//   GET  /pf/quote?codes=..  종목 현재가 (쉼표로 여러 개)
//   GET  /pf/search?q=..     종목 이름·코드로 찾기
//
// 대시보드와 같은 서버에 얹지만 주소가 /pf 로 분리되어 있습니다.
const fs = require('fs');
const path = require('path');

const 파일 = '/root/app/portfolio.json';
const 백업 = '/root/app/portfolio_bak.json';

const 기본값 = {
  seed: 10000000,          // 시작 자금
  feeRate: 0.015,          // 수수료 %
  taxRate: 0.15,           // 매도 거래세 %
  cashAdjust: 0,           // 입출금 조정
  watch: [],               // 관심종목 [{code, name}]
  trades: [],              // 매매 기록
  priceOverride: {},       // 손으로 고친 현재가 {code: price}
  updatedAt: null,
};

function 읽기() {
  for (const p of [파일, 백업]) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      return { ...기본값, ...j };
    } catch (e) {}
  }
  return { ...기본값 };
}

function 쓰기(state) {
  const 담을것 = { ...기본값, ...state, updatedAt: new Date().toISOString() };
  const 글 = JSON.stringify(담을것, null, 1);
  // 백업을 먼저 남기고 본 파일을 씁니다. 쓰다 끊겨도 직전 것이 남습니다.
  try { if (fs.existsSync(파일)) fs.copyFileSync(파일, 백업); } catch (e) {}
  fs.writeFileSync(파일, 글, 'utf8');
  return 담을것;
}

// ── 시세 ─────────────────────────────────────────
const env = {};
try {
  for (const line of fs.readFileSync('/root/app/.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (e) {}
const pick = (...ns) => { for (const n of ns) if (env[n]) return env[n]; return null; };
const APP_KEY = pick('KIWOOM_APP_KEY', 'APP_KEY', 'KIWOOM_APPKEY', 'APPKEY', 'KIWOOM_KEY');
const APP_SECRET = pick('KIWOOM_APP_SECRET', 'APP_SECRET', 'KIWOOM_SECRETKEY', 'SECRETKEY', 'SECRET_KEY', 'KIWOOM_SECRET');
const BASE = 'https://api.kiwoom.com';

function num(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s%]/g, '');
  const neg = t.indexOf('-') >= 0;
  const n = Number(t.replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

let TOKEN = null, TOKEN_AT = 0;
async function getToken(force) {
  if (!force && TOKEN && Date.now() - TOKEN_AT < 50 * 60 * 1000) return TOKEN;
  const r = await fetch(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, secretkey: APP_SECRET })
  });
  const j = await r.json();
  if (!j.token) throw new Error('token fail');
  TOKEN = j.token; TOKEN_AT = Date.now();
  return TOKEN;
}

async function 한종목(code, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + '/api/dostk/stkinfo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka10001', 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify({ stk_cd: code + '_AL' })
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error('parse'); }
  if (j.return_code && j.return_code !== 0) {
    if (/8005|token|만료|인증/i.test(String(j.return_msg || ''))) { TOKEN = null; throw new Error('retry'); }
    return null;
  }
  const 값 = num(j.cur_prc);
  return {
    code,
    name: String(j.stk_nm || '').trim(),
    price: 값 == null ? null : Math.abs(값),
    changePct: num(j.flu_rt),
    prevClose: num(j.base_pric) == null ? null : Math.abs(num(j.base_pric)),
  };
}

const 시세캐시 = new Map();   // code -> { data, at }
const 신선 = 60 * 1000;

async function 시세(codes) {
  const 결과 = {};
  for (const c of codes) {
    const 있 = 시세캐시.get(c);
    if (있 && Date.now() - 있.at < 신선) { 결과[c] = 있.data; continue; }
    let d = null;
    try { d = await 한종목(c, false); }
    catch (e) { try { d = await 한종목(c, true); } catch (e2) { d = null; } }
    if (d) { 시세캐시.set(c, { data: d, at: Date.now() }); 결과[c] = d; }
    else if (있) 결과[c] = 있.data;           // 실패하면 지난 값이라도
    await new Promise(r => setTimeout(r, 120));
  }
  return 결과;
}

module.exports = (app) => {
  app.use('/pf', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.get('/pf/state', (req, res) => {
    try { res.json(읽기()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  app.post('/pf/state', (req, res) => {
    try {
      const b = req.body;
      if (!b || typeof b !== 'object') return res.status(400).json({ error: 'body 없음' });
      res.json(쓰기(b));
    } catch (e) {
      res.status(500).json({ error: String(e.message || e) });
    }
  });

  app.get('/pf/quote', async (req, res) => {
    const codes = String(req.query.codes || '')
      .split(',').map(x => x.trim().replace(/_AL$/, '')).filter(x => /^[0-9A-Z]{6}$/.test(x));
    if (!codes.length) return res.json({});
    try { res.json(await 시세(codes.slice(0, 60))); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });

  // marketcap.json 으로 이름·코드 찾기 (대시보드가 매일 올리는 파일)
  let 목록 = null, 목록AT = 0;
  app.get('/pf/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json([]);
    try {
      if (!목록 || Date.now() - 목록AT > 30 * 60 * 1000) {
        const j = JSON.parse(fs.readFileSync('/root/app/marketcap.json', 'utf8'));
        목록 = Object.entries(j.info || {}).map(([c, v]) => ({ code: c, name: v[0], market: v[1] }));
        목록AT = Date.now();
      }
      const 아래 = q.toLowerCase();
      const 맞음 = 목록.filter(x =>
        x.code.startsWith(q) || x.name.toLowerCase().includes(아래));
      맞음.sort((a, b) => a.name.length - b.name.length);
      res.json(맞음.slice(0, 20));
    } catch (e) {
      res.json([]);
    }
  });
};
