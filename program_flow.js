// 시총대비 프로그램 순매수 상위 (키움 ka90003)
// 주피터 program_realtime 노트북과 같은 계산을 서버에서 합니다.
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
const API_PATH = '/api/dostk/stkinfo';
const CAP_URL = 'https://night-dashboard-deploy-1.vercel.app/marketcap.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARKETS = [
  { name: 'KOSPI', code: 'P00101' },
  { name: 'KOSDAQ', code: 'P10102' },
];
const EXCHANGE = '3';   // 통합(KRX+NXT)
const TOP_N = 50;

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
  const r = await fetch(BASE + API_PATH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka90003', 'cont-yn': 'N', 'next-key': ''
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

// 시가총액 — 하루 한 번만 받아 캐시합니다.
const CAP = { data: null, at: 0, date: null };

async function getCaps() {
  if (CAP.data && Date.now() - CAP.at < 30 * 60 * 1000) return CAP;
  try {
    const r = await fetch(CAP_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('cap ' + r.status);
    const j = await r.json();
    if (j && j.caps) { CAP.data = j.caps; CAP.date = j.date || null; CAP.at = Date.now(); }
  } catch (e) {}
  return CAP;
}

// 스팩·리츠 제외. (?<!메) 는 '메리츠'가 걸리지 않게 막아둔 장치입니다.
const RE_SPAC = /스팩|기업인수목적/;
const RE_REIT = /(?<!메)리츠|리얼티|부동산투자/;
const excluded = n => RE_SPAC.test(String(n || '')) || RE_REIT.test(String(n || ''));

async function build() {
  const caps = await getCaps();
  const rows = [];

  for (const mkt of MARKETS) {
    // trde_upper_tp: 1 = 순매도상위, 2 = 순매수상위
    for (const tp of ['2', '1']) {
      const j = await call({
        trde_upper_tp: tp, mrkt_tp: mkt.code, amt_qty_tp: '1', stex_tp: EXCHANGE
      });
      await sleep(280);
      if (j.return_code && j.return_code !== 0) continue;

      for (const it of (j.prm_netprps_upper_50 || [])) {
        const m = String(it.stk_cd || '').match(/(\d{6})/);
        if (!m) continue;
        const net = num(it.prm_netprps_amt);
        if (net == null) continue;
        rows.push({
          code: m[1],
          name: String(it.stk_nm || '').trim(),
          market: mkt.name,
          price: Math.abs(num(it.cur_prc) || 0),
          changePct: num(it.flu_rt),
          volume: num(it.acc_trde_qty),
          net,                                   // 백만원
        });
      }
    }
  }

  if (!rows.length) throw new Error('프로그램 수급이 비어 있습니다(장중이 아닐 수 있음)');

  // 같은 종목이 두 번 잡히면 절댓값이 큰 쪽만 남깁니다.
  const best = new Map();
  for (const r of rows) {
    const prev = best.get(r.code);
    if (!prev || Math.abs(r.net) > Math.abs(prev.net)) best.set(r.code, r);
  }

  const out = [];
  for (const r of best.values()) {
    if (excluded(r.name)) continue;
    const cap = caps.data ? caps.data[r.code] : null;
    if (!cap) continue;
    out.push(Object.assign({}, r, {
      cap,
      ratio: Number(((r.net * 1e6) / cap * 100).toFixed(4)),
    }));
  }

  const buy = out.filter(r => r.ratio > 0).sort((a, b) => b.ratio - a.ratio).slice(0, TOP_N);
  const sell = out.filter(r => r.ratio < 0).sort((a, b) => a.ratio - b.ratio).slice(0, TOP_N);

  return {
    capDate: caps.date,
    exchange: EXCHANGE,
    buy, sell,
    generatedAt: new Date().toISOString(),
  };
}

const CACHE = { data: null, at: 0 };

module.exports = (app) => {
  app.get('/program-flow', async (req, res) => {
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
