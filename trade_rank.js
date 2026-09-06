// 거래대금 상위 (키움 ka10032) — 코스피·코스닥을 합쳐 순위를 다시 매깁니다.
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
const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s]/g, '');
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

async function callOnce(body, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + '/api/dostk/rkinfo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka10032', 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(r.status + ' ' + t.slice(0, 100)); }
}

async function call(body) {
  let j;
  try { j = await callOnce(body, false); }
  catch (e) { TOKEN = null; return await callOnce(body, true); }
  if (j && j.return_code && j.return_code !== 0 && /8005|token|만료|인증/i.test(String(j.return_msg || ''))) {
    TOKEN = null;
    j = await callOnce(body, true);
  }
  return j;
}

const MARKETS = [{ code: '001', name: 'KOSPI' }, { code: '101', name: 'KOSDAQ' }];

async function build() {
  const rows = [];
  for (const mkt of MARKETS) {
    const j = await call({ mrkt_tp: mkt.code, mang_stk_incls: '0', stex_tp: '3' });
    await sleep(300);
    if (j.return_code && j.return_code !== 0) continue;

    for (const x of (j.trde_prica_upper || [])) {
      const code = String(x.stk_cd || '').trim().replace('_AL', '').replace('_NX', '');
      const price = num(x.cur_prc);
      if (!code || price == null) continue;
      rows.push({
        code,
        name: String(x.stk_nm || '').trim(),
        market: mkt.name,
        price: Math.abs(price),
        changePct: num(x.flu_rt),
        volume: num(x.now_trde_qty),
        tradeValue: num(x.trde_prica),   // 백만원
      });
    }
  }

  // 코스피·코스닥을 합쳐 거래대금 순으로 다시 정렬합니다.
  rows.sort((a, b) => (b.tradeValue || 0) - (a.tradeValue || 0));
  const top150 = rows.slice(0, 150).map((r, i) => Object.assign({ rank: i + 1 }, r));

  // 그중 상승률 상위 50
  const up50 = top150
    .filter(r => r.changePct != null && r.changePct > 0)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 50)
    .map((r, i) => Object.assign({}, r, { upRank: i + 1 }));

  return {
    total: rows.length,
    top150,
    up50,
    generatedAt: new Date().toISOString()
  };
}

const CACHE = { data: null, at: 0 };

module.exports = (app) => {
  app.get('/trade-rank', async (req, res) => {
    try {
      if (CACHE.data && Date.now() - CACHE.at < 60000) return res.json(CACHE.data);
      CACHE.data = await build();
      CACHE.at = Date.now();
      res.json(CACHE.data);
    } catch (e) {
      if (CACHE.data) {
        return res.json(Object.assign({}, CACHE.data, { stale: true, lastError: String((e && e.message) || e) }));
      }
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
