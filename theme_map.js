// 인포스탁 테마 — 히트맵용
//   /theme-map              테마 목록 (ka90001) · 1분 캐시
//   /theme-stocks?code=551  테마 구성종목 (ka90002) · 1분 캐시
//
// 업종(ka20003)과 달리 한 종목이 여러 테마에 들어갈 수 있습니다.
// 그래서 시장 전체를 빈틈없이 나누지 않으며, 쏠림지수 계산에는 쓰지 않습니다.
const fs = require('fs');

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
const PATH = '/api/dostk/thme';

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

async function callOnce(apiId, body, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': apiId, 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(r.status + ' ' + t.slice(0, 100)); }
}

async function call(apiId, body) {
  let j;
  try { j = await callOnce(apiId, body, false); }
  catch (e) { TOKEN = null; return await callOnce(apiId, body, true); }
  if (j && j.return_code && j.return_code !== 0 && /8005|token|만료|인증/i.test(String(j.return_msg || ''))) {
    TOKEN = null;
    j = await callOnce(apiId, body, true);
  }
  return j;
}

// ── 테마 목록 ────────────────────────────────────
const 목록캐시 = { data: null, at: 0 };

async function 테마목록() {
  if (목록캐시.data && Date.now() - 목록캐시.at < 60 * 1000) return 목록캐시.data;

  const j = await call('ka90001', {
    qry_tp: '0',            // 0=전체검색
    stk_cd: '',
    date_tp: '1',           // 기간수익률 계산일 (1일)
    thema_nm: '',
    flu_pl_amt_tp: '3',     // 3=상위등락률
    stex_tp: '3',           // 3=통합(KRX+NXT)
  });
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka90001');

  const rows = (j.thema_grp || []).map(x => ({
    code: String(x.thema_grp_cd || '').trim(),
    name: String(x.thema_nm || '').trim(),
    count: num(x.stk_num) || 0,
    changePct: num(x.flu_rt),
    rising: num(x.rising_stk_num) || 0,
    falling: num(x.fall_stk_num) || 0,
    periodPct: num(x.dt_prft_rt),
    lead: String(x.main_stk || '').split(',').map(s => s.trim()).filter(Boolean),
  })).filter(x => x.code && x.name);

  const out = {
    count: rows.length,
    generatedAt: new Date().toISOString(),
    themes: rows,
  };
  목록캐시.data = out; 목록캐시.at = Date.now();
  return out;
}

// ── 테마 구성종목 ────────────────────────────────
const 종목캐시 = new Map();   // code -> { data, at }

async function 테마종목(code) {
  const c = 종목캐시.get(code);
  if (c && Date.now() - c.at < 60 * 1000) return c.data;

  const j = await call('ka90002', {
    date_tp: '1',
    thema_grp_cd: code,
    stex_tp: '3',
  });
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka90002');

  // 응답 배열 이름이 판에 따라 다를 수 있어 넓게 찾습니다.
  const 배열 = j.thema_comp_stk || j.themaComp || j.thema_grp || [];
  const rows = 배열.map(x => ({
    code: String(x.stk_cd || '').replace(/_AL$/, '').trim(),
    name: String(x.stk_nm || '').trim(),
    price: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
    changePct: num(x.flu_rt),
    volume: num(x.acc_trde_qty),
    periodPct: num(x.dt_prft_rt),
  })).filter(x => x.code && x.name);

  const out = { code, count: rows.length, generatedAt: new Date().toISOString(), stocks: rows };
  종목캐시.set(code, { data: out, at: Date.now() });
  return out;
}

module.exports = (app) => {
  app.get('/theme-map', async (req, res) => {
    try {
      res.json(await 테마목록());
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.get('/theme-stocks', async (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'code 가 필요합니다' });
    try {
      res.json(await 테마종목(code));
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 응답 원본을 그대로 보고 싶을 때 (항목 이름 확인용)
  app.get('/theme-raw', async (req, res) => {
    try {
      const code = String(req.query.code || '').trim();
      const j = code
        ? await call('ka90002', { date_tp: '1', thema_grp_cd: code, stex_tp: '3' })
        : await call('ka90001', { qry_tp: '0', stk_cd: '', date_tp: '1',
                                  thema_nm: '', flu_pl_amt_tp: '3', stex_tp: '3' });
      res.json(j);
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
