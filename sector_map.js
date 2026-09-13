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
      tradeValue: (num(x.cur_prc) && num(x.now_trde_qty)) ? Math.abs(num(x.cur_prc)) * num(x.now_trde_qty) : 0,
    };
  }).filter(x => x.code);
}

// ── 업종 일봉 → F&G · MACD ─────────────────────────
// ka20006 업종일봉조회. base_dt 가 비어 있으면 오류가 나므로 오늘 날짜를 넣습니다.
function today() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}

async function dailyBars(indsCd) {
  const token = await getToken(false);
  const r = await fetch(BASE + '/api/dostk/chart', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka20006', 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify({ inds_cd: indsCd, base_dt: today() })
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error('ka20006 ' + r.status); }
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka20006');

  const rows = (j.inds_dt_pole_qry || [])
    .map(x => ({ date: String(x.dt || '').slice(0, 8), close: num(x.cur_prc) }))
    .filter(x => x.date.length === 8 && x.close != null)
    .map(x => ({ date: x.date, close: Math.abs(x.close) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

function emaArr(a, n) {
  const k = 2 / (n + 1);
  let p = null;
  return a.map(v => { p = p == null ? v : v * k + p * (1 - k); return p; });
}
function smaAt(a, n, i) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += a[k];
  return s / n;
}
function rsiAt(a, n, i) {
  if (i < n) return null;
  let up = 0, dn = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = a[k] - a[k - 1];
    if (d >= 0) up += d; else dn -= d;
  }
  return up + dn === 0 ? 50 : (up / (up + dn)) * 100;
}
function minmax(arr) {
  const lo = Math.min(...arr), hi = Math.max(...arr);
  return x => (hi === lo ? 0.5 : (x - lo) / (hi - lo));
}

function indicators(rows) {
  const px = rows.map(r => r.close);

  // 업종 F&G: 60일선 대비 괴리 + RSI10 을 전체 기간 최소~최대로 정규화해 평균
  const idx = [];
  const mom = [], rs = [];
  for (let i = 0; i < px.length; i++) {
    const m = smaAt(px, 60, i), r = rsiAt(px, 10, i);
    if (m == null || r == null) continue;
    idx.push(i); mom.push(px[i] / m - 1); rs.push(r);
  }
  if (idx.length < 40) return [];

  const nm = minmax(mom), nr = minmax(rs);
  const fg = idx.map((_, k) => (nm(mom[k]) * 0.5 + nr(rs[k]) * 0.5) * 100);
  const fgE = emaArr(fg, 20);

  // MACD(12,26,9) 는 F&G 에 겁니다.
  // 코스피·코스닥 F&G 페이지와 같은 방식이라 두 화면의 값이 일치합니다.
  const e12 = emaArr(fg, 12), e26 = emaArr(fg, 26);
  const macd = fg.map((_, k) => e12[k] - e26[k]);
  const signal = emaArr(macd, 9);

  return idx.map((i, k) => ({
    date: rows[i].date,
    close: Number(px[i].toFixed(2)),
    fg: Number(fg[k].toFixed(1)),
    fgEma: Number(fgE[k].toFixed(1)),
    macd: Number(macd[k].toFixed(4)),
    signal: Number(signal[k].toFixed(4)),
    hist: Number((macd[k] - signal[k]).toFixed(4)),
  }));
}

const CACHE = { sectors: {}, stocks: {}, ind: {} };
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

  // 업종 지표 (F&G · MACD)
  // 코스피(001)·코스닥(101) 종합은 F&G 페이지와 같은 값을 쓰도록
  // 서버 안의 /fear-greed 결과를 그대로 가져옵니다.
  const MARKET_OF = { '001': 'KOSPI', '101': 'KOSDAQ' };

  app.get('/sector-indicator', async (req, res) => {
    try {
      const code = String(req.query.code || '').replace(/\D/g, '');
      if (!code) throw new Error('업종코드가 없습니다');

      if (MARKET_OF[code]) {
        const c = CACHE.ind[code];
        if (c && Date.now() - c.at < 10 * 60 * 1000) return res.json(c.data);

        const r = await fetch('http://127.0.0.1:3000/fear-greed?days=400');
        const j = await r.json();
        const rows = (j.data && j.data[MARKET_OF[code]]) || [];
        if (!rows.length) throw new Error('fear-greed 결과가 비어 있습니다');

        const series = rows.map(x => ({
          date: x.date,
          close: x.close,
          fg: x.fg,
          fgEma: x.ema20,
          macd: x.macd,
          signal: x.signal,
          hist: x.osc,
        }));
        const data = {
          code,
          source: 'fear-greed',
          bars: series.length,
          series,
          last: series[series.length - 1],
          generatedAt: new Date().toISOString(),
        };
        CACHE.ind[code] = { data, at: Date.now() };
        return res.json(data);
      }

      const c = CACHE.ind[code];
      if (c && Date.now() - c.at < 10 * 60 * 1000) return res.json(c.data);

      const rows = await dailyBars(code);
      const series = indicators(rows);
      const data = {
        code,
        bars: rows.length,
        series,
        last: series.length ? series[series.length - 1] : null,
        generatedAt: new Date().toISOString(),
      };
      CACHE.ind[code] = { data, at: Date.now() };
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
