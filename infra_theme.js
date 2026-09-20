// 인포스탁 테마 히트맵 — 분류는 theme_map.json, 등락률은 우리가 계산
//   /infra-theme              테마별 등락률 (시총가중) · 2분 캐시
//   /infra-theme?code=전선    그 테마 구성종목
//
// 전 업종(ka20002)을 돌아 종목 시세를 모은 뒤 테마별로 묶습니다.
// 업종과 달리 한 종목이 여러 테마에 들어갈 수 있어, 시장 전체를 빈틈없이
// 나누지는 않습니다. "오늘 어떤 테마가 움직였나"를 보는 화면입니다.
const fs = require('fs');
const path = require('path');

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

// 업종 코드 — 이 둘을 돌면 상장 종목이 거의 다 모입니다.
const 업종 = {
  KOSPI: ['005','006','007','008','009','010','011','012','013','014','015','016',
          '017','018','019','020','021','024','025','026','045','046','047'],
  KOSDAQ: ['012','024','026','027','029','031','037','056','058','062','063','065',
           '066','067','068','070','072','074','075','077','114','118'],
};

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

async function 업종종목(시장, 코드, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + '/api/dostk/sect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka20002', 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify({ mrkt_tp: 시장 === 'KOSPI' ? '0' : '1', inds_cd: 코드 })
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch (e) { return []; }
  if (j.return_code && j.return_code !== 0) {
    if (/8005|token|만료|인증/i.test(String(j.return_msg || ''))) { TOKEN = null; throw new Error('retry'); }
    return [];
  }
  const 배열 = j.inds_stkpc || j.indsStkpc || [];
  return 배열.map(x => ({
    code: String(x.stk_cd || '').replace(/_AL$/, '').trim(),
    name: String(x.stk_nm || '').trim(),
    price: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
    changePct: num(x.flu_rt),
    volume: num(x.now_trde_qty) || num(x.trde_qty) || 0,
    tradeValue: (num(x.trde_prica) || 0) * 1e6,
  })).filter(x => x.code);
}

// ── 매핑표 ───────────────────────────────────────
let MAP = null, MAP_AT = 0;
function 매핑() {
  if (MAP && Date.now() - MAP_AT < 10 * 60 * 1000) return MAP;
  for (const p of ['/root/app/theme_map.json', path.join(__dirname, 'theme_map.json')]) {
    try {
      MAP = JSON.parse(fs.readFileSync(p, 'utf8'));
      MAP_AT = Date.now();
      return MAP;
    } catch (e) {}
  }
  throw new Error('theme_map.json 을 찾지 못했습니다');
}

// ── 전 종목 시세 모으기 ──────────────────────────
const 시세캐시 = { data: null, at: 0 };

async function 전종목() {
  if (시세캐시.data && Date.now() - 시세캐시.at < 120 * 1000) return 시세캐시.data;

  const 표 = new Map();
  for (const [시장, 목록] of Object.entries(업종)) {
    for (const 코드 of 목록) {
      let rows = [];
      try { rows = await 업종종목(시장, 코드, false); }
      catch (e) { try { rows = await 업종종목(시장, 코드, true); } catch (e2) { rows = []; } }
      for (const x of rows) if (!표.has(x.code)) 표.set(x.code, x);
      await new Promise(r => setTimeout(r, 120));   // 키움에 부담 주지 않게
    }
  }
  시세캐시.data = 표; 시세캐시.at = Date.now();
  return 표;
}

// ── 테마별 집계 ──────────────────────────────────
const 집계캐시 = { data: null, at: 0 };

async function 테마집계() {
  if (집계캐시.data && Date.now() - 집계캐시.at < 120 * 1000) return 집계캐시.data;

  const m = 매핑();
  const 시세 = await 전종목();

  const rows = [];
  for (const [이름, 코드들] of Object.entries(m.themes || {})) {
    const 값 = [];
    for (const c of 코드들) {
      const s = 시세.get(c);
      if (s && s.changePct != null) 값.push(s);
    }
    if (!값.length) {
      rows.push({ name: 이름, count: 코드들.length, matched: 0,
                  changePct: null, rising: 0, falling: 0, lead: [] });
      continue;
    }
    // 시가총액이 없어 거래대금으로 가중합니다. 큰 종목이 테마를 끄는 정도를 반영합니다.
    const W = 값.reduce((a, x) => a + (x.tradeValue || 0), 0);
    const 가중 = W > 0
      ? 값.reduce((a, x) => a + x.changePct * (x.tradeValue || 0), 0) / W
      : 값.reduce((a, x) => a + x.changePct, 0) / 값.length;
    const 단순 = 값.reduce((a, x) => a + x.changePct, 0) / 값.length;
    const 정렬 = 값.slice().sort((a, b) => b.changePct - a.changePct);
    rows.push({
      name: 이름,
      count: 코드들.length,
      matched: 값.length,
      changePct: Math.round(가중 * 100) / 100,
      simplePct: Math.round(단순 * 100) / 100,
      rising: 값.filter(x => x.changePct > 0).length,
      falling: 값.filter(x => x.changePct < 0).length,
      lead: 정렬.slice(0, 3).map(x => x.name),
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: m.source || '인포스탁 섹터',
    mapAt: m.generatedAt || null,
    count: rows.length,
    priced: 시세.size,
    themes: rows,
  };
  집계캐시.data = out; 집계캐시.at = Date.now();
  return out;
}

async function 테마종목(이름) {
  const m = 매핑();
  const 코드들 = (m.themes || {})[이름];
  if (!코드들) throw new Error('없는 테마: ' + 이름);
  const 시세 = await 전종목();
  const list = 코드들.map(c => {
    const s = 시세.get(c);
    return {
      code: c,
      name: (m.names || {})[c] || (s && s.name) || c,
      price: s ? s.price : null,
      changePct: s ? s.changePct : null,
      volume: s ? s.volume : null,
    };
  });
  list.sort((a, b) => (b.changePct ?? -99) - (a.changePct ?? -99));
  return { name: 이름, count: list.length, generatedAt: new Date().toISOString(), stocks: list };
}

module.exports = (app) => {
  app.get('/infra-theme', async (req, res) => {
    const 이름 = String(req.query.code || req.query.name || '').trim();
    try {
      res.json(이름 ? await 테마종목(이름) : await 테마집계());
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
