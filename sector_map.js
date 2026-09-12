// 국내 업종별 히트맵 + 업종 안 종목 목록
//   ka20003 전업종지수  → 업종 목록과 등락률
//   ka20002 업종별주가  → 업종에 속한 종목들 (클릭했을 때만 받습니다)
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

const MARKETS = {
  KOSPI: { mrkt: '0', seed: '001' },
  KOSDAQ: { mrkt: '1', seed: '101' },
};

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

async function callOnce(apiId, body, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + '/api/dostk/sect', {
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

// ── 업종 목록 ────────────────────────────────────
async function sectors(mktKey) {
  const m = MARKETS[mktKey];
  const j = await call('ka20003', { mrkt_tp: m.mrkt, inds_cd: m.seed });
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka20003');

  const list = j.all_inds_idex || [];
  const out = [];
  for (const x of list) {
    const code = String(x.stk_cd || '').trim();
    const name = String(x.stk_nm || '').trim();
    if (!code) continue;
    out.push({
      code, name,
      index: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
      changePct: num(x.flu_rt),
      tradeValue: num(x.trde_prica),      // 백만원
      rising: num(x.rising),
      flat: num(x.stdns),
      falling: num(x.fall),
      stocks: num(x.flo_stk_num),
      isTotal: /종합/.test(name),
    });
  }
  return out;
}

// ── 업종 안 종목 ──────────────────────────────────
async function stocksOf(mktKey, indsCd) {
  const m = MARKETS[mktKey];
  const j = await call('ka20002', { mrkt_tp: m.mrkt, inds_cd: indsCd, stex_tp: '3' });
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka20002');

  const list = j.inds_stkpc || [];
  return list.map(x => {
    const mm = String(x.stk_cd || '').match(/(\d{6})/);
    return {
      code: mm ? mm[1] : null,
      name: String(x.stk_nm || '').trim(),
      price: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
      changePct: num(x.flu_rt),
      volume: num(x.now_trde_qty),
    };
  }).filter(x => x.code);
}

const CACHE = { sectors: {}, stocks: {} };
const FRESH = 60 * 1000;

module.exports = (app) => {
  // 업종 목록
  app.get('/sector-map', async (req, res) => {
    try {
      const mkt = (req.query.market || 'KOSPI').toUpperCase();
      if (!MARKETS[mkt]) throw new Error('시장 구분이 잘못되었습니다');

      const c = CACHE.sectors[mkt];
      if (c && Date.now() - c.at < FRESH) return res.json(c.data);

      const list = await sectors(mkt);
      const total = list.find(x => x.isTotal) || null;
      const data = {
        market: mkt,
        total,
        sectors: list.filter(x => !x.isTotal),
        generatedAt: new Date().toISOString(),
      };
      CACHE.sectors[mkt] = { data, at: Date.now() };
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 업종 하나에 속한 종목
  app.get('/sector-stocks', async (req, res) => {
    try {
      const mkt = (req.query.market || 'KOSPI').toUpperCase();
      const code = String(req.query.code || '').replace(/\D/g, '');
      if (!MARKETS[mkt] || !code) throw new Error('시장 또는 업종코드가 잘못되었습니다');

      const key = mkt + '|' + code;
      const c = CACHE.stocks[key];
      if (c && Date.now() - c.at < FRESH) return res.json(c.data);

      const items = await stocksOf(mkt, code);
      const data = { market: mkt, code, count: items.length, items, generatedAt: new Date().toISOString() };
      CACHE.stocks[key] = { data, at: Date.now() };
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
