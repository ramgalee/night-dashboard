// 코스피·코스닥 Fear & Greed 지수
//
// 세 가지를 0~100으로 환산해 평균냅니다.
//   1) 125일 모멘텀   지수가 125일 이동평균 대비 어디에 있나
//   2) RSI 10일       단기 과열·과냉
//   3) 실현변동성 20일 최근 20일 등락률의 표준편차 (VKOSPI 대체, 낮을수록 탐욕)
//
// 과거 지수는 index_history.json(주피터에서 한 번 생성)을 읽고,
// 그 이후 날짜는 키움에서 받아 서버 파일에 이어 붙입니다.
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
const SEED_URL = 'https://raw.githubusercontent.com/ramgalee/night-dashboard/main/index_history.json';
const EXTRA_URL = 'https://raw.githubusercontent.com/ramgalee/night-dashboard/main/fg_extra.json';
const STORE = '/root/app/index_history.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARKETS = [
  { key: 'KOSPI', inds: '001' },
  { key: 'KOSDAQ', inds: '101' },
];

function num(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s]/g, '');
  const n = Number(t.replace(/-/g, ''));
  return Number.isFinite(n) ? n : null;
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

// 오늘 날짜(한국 기준). ka20006 은 base_dt 가 비어 있으면 오류가 납니다.
function today() {
  return new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
}

async function call(indsCd, force) {
  const token = await getToken(force);
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
  try { j = JSON.parse(t); } catch (e) { throw new Error(r.status + ' ' + t.slice(0, 100)); }
  if (!force && j.return_code && j.return_code !== 0 && /8005|token|만료|인증/i.test(String(j.return_msg || ''))) {
    TOKEN = null;
    return call(indsCd, true);
  }
  return j;
}

// ── 저장소 ────────────────────────────────────────────
const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return null; } };
const save = db => fs.writeFileSync(STORE, JSON.stringify(db), 'utf8');

async function seed() {
  const r = await fetch(SEED_URL);
  if (!r.ok) throw new Error('seed ' + r.status);
  const j = await r.json();
  if (!j.data || !j.data.KOSPI) throw new Error('seed empty');
  save(j);
  return j;
}

// 키움 업종일봉으로 최근 날짜를 이어 붙입니다.
async function extend(db) {
  let added = 0;
  for (const mkt of MARKETS) {
    let j;
    try { j = await call(mkt.inds, false); } catch (e) { continue; }
    await sleep(350);
    if (j.return_code && j.return_code !== 0) continue;

    const list = j.inds_dt_pole_qry || j.inds_day_pole_qry || [];
    if (!list.length) continue;

    const rows = db.data[mkt.key] || [];
    const have = new Set(rows.map(r => r.date));

    for (const x of list) {
      const dt = String(x.dt || x.cntr_tm || '').slice(0, 8);
      const close = num(x.cur_prc);
      if (dt.length !== 8 || close == null) continue;
      if (have.has(dt)) continue;
      rows.push({ date: dt, close: Number((close / 100).toFixed(2)) });
      have.add(dt);
      added++;
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    db.data[mkt.key] = rows;
  }
  return added;
}

// ── 보조 데이터 (VKOSPI · 국채금리차 · Put/Call) ─────────
// 주피터에서 피어앤그리드.xlsx 를 읽어 만든 fg_extra.json 입니다.
// 없으면 세 항목만으로 계산합니다.
const EXTRA = { data: null, at: 0 };

async function getExtra() {
  if (EXTRA.data && Date.now() - EXTRA.at < 30 * 60 * 1000) return EXTRA.data;
  try {
    const r = await fetch(EXTRA_URL, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) throw new Error('extra ' + r.status);
    const j = await r.json();
    if (j && j.data) { EXTRA.data = j.data; EXTRA.at = Date.now(); }
  } catch (e) {
    if (!EXTRA.data) EXTRA.data = {};
    EXTRA.at = Date.now();
  }
  return EXTRA.data || {};
}

// ── 지표 계산 ──────────────────────────────────────────
const clamp = v => Math.max(0, Math.min(100, v));

// 값을 0~100으로 옮깁니다. lo 이하면 0, hi 이상이면 100.
const scale = (v, lo, hi) => clamp(((v - lo) / (hi - lo)) * 100);

function sma(arr, n, i) {
  if (i + 1 < n) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += arr[k];
  return s / n;
}

function rsi(closes, n, i) {
  if (i < n) return null;
  let up = 0, down = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const d = closes[k] - closes[k - 1];
    if (d >= 0) up += d; else down -= d;
  }
  if (up + down === 0) return 50;
  return (up / (up + down)) * 100;
}

function realizedVol(closes, n, i) {
  if (i < n) return null;
  const rets = [];
  for (let k = i - n + 1; k <= i; k++) rets.push((closes[k] / closes[k - 1] - 1) * 100);
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const v = rets.reduce((a, b) => a + (b - m) * (b - m), 0) / rets.length;
  return Math.sqrt(v) * Math.sqrt(252);   // 연율화(%)
}

function ema(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  let prev = null;
  for (const v of arr) {
    if (v == null) { out.push(null); continue; }
    prev = prev == null ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

// 원본 코랩 코드와 같은 방식으로 계산합니다.
//   Momentum          125일 이동평균 대비 괴리율(%)
//   Put_Call_Ratio    PUT ATM / CALL ATM
//   Market_Volatility VKOSPI
//   Bond_Yield_Diff   10년 국채선물지수 - 5년 국채선물지수
//   RSI_10            10일 RSI
// 다섯 항목을 각각 MinMax(최솟값 0, 최댓값 1)로 정규화한 뒤
//   F&G = Mom*0.2 + (1-PC)*0.2 + (1-Vol)*0.2 + Bond*0.2 + RSI*0.2
// 오실레이터는 F&G 의 MACD(12,26,9) 히스토그램입니다.

function minmax(arr) {
  const v = arr.filter(x => x != null && isFinite(x));
  if (!v.length) return () => null;
  const lo = Math.min(...v), hi = Math.max(...v);
  if (hi === lo) return () => 0.5;
  return x => (x == null || !isFinite(x)) ? null : (x - lo) / (hi - lo);
}

function emaSeries(arr, n) {
  const k = 2 / (n + 1);
  let prev = null;
  return arr.map(v => {
    if (v == null) return null;
    prev = prev == null ? v : v * k + prev * (1 - k);
    return prev;
  });
}

function computeFG(rows, extra) {
  const ex = extra || {};
  const closes = rows.map(r => r.close);

  // 보조 데이터가 있는 날만 계산 대상으로 삼습니다(원본의 dropna 와 같습니다).
  const idx = [];
  for (let i = 0; i < rows.length; i++) {
    const e = ex[rows[i].date];
    if (!e || e.vkospi == null || e.putCall == null || e.bondDiff == null) continue;
    if (sma(closes, 125, i) == null || rsi(closes, 10, i) == null) continue;
    idx.push(i);
  }
  if (idx.length < 30) return [];

  const mom = idx.map(i => (closes[i] / sma(closes, 125, i) - 1) * 100);
  const pc = idx.map(i => ex[rows[i].date].putCall);
  const vol = idx.map(i => ex[rows[i].date].vkospi);
  const bond = idx.map(i => ex[rows[i].date].bondDiff);
  const rs = idx.map(i => rsi(closes, 10, i));

  const nm = minmax(mom), np = minmax(pc), nv = minmax(vol), nb = minmax(bond), nr = minmax(rs);

  // 0~1 로 나온 값을 화면에서 보기 쉽게 0~100 으로 표시합니다.
  const fg = idx.map((_, k) =>
    (nm(mom[k]) * 0.2 + (1 - np(pc[k])) * 0.2 + (1 - nv(vol[k])) * 0.2
      + nb(bond[k]) * 0.2 + nr(rs[k]) * 0.2) * 100);

  // MACD(12,26,9) 히스토그램
  const e12 = emaSeries(fg, 12);
  const e26 = emaSeries(fg, 26);
  const macd = fg.map((_, k) => e12[k] - e26[k]);
  const signal = emaSeries(macd, 9);
  const ema20 = emaSeries(fg, 20);
  const ema30 = emaSeries(fg, 30);
  const ema50 = emaSeries(fg, 50);

  return idx.map((i, k) => ({
    date: rows[i].date,
    close: closes[i],
    fg: Number(fg[k].toFixed(2)),
    ema20: Number(ema20[k].toFixed(2)),
    ema30: Number(ema30[k].toFixed(2)),
    ema50: Number(ema50[k].toFixed(2)),
    macd: Number(macd[k].toFixed(4)),
    signal: Number(signal[k].toFixed(4)),
    osc: Number((macd[k] - signal[k]).toFixed(4)),
    momentum: Number((nm(mom[k]) * 100).toFixed(2)),
    rsi: Number((nr(rs[k]) * 100).toFixed(2)),
    volScore: Number(((1 - nv(vol[k])) * 100).toFixed(2)),
    pcScore: Number(((1 - np(pc[k])) * 100).toFixed(2)),
    bondScore: Number((nb(bond[k]) * 100).toFixed(2)),
    vkospi: vol[k],
    putCall: Number(pc[k].toFixed(4)),
    vol: vol[k],
    parts: 5,
  }));
}

const CACHE = { data: null, at: 0 };

async function build(days) {
  let db = load();
  if (!db) db = await seed();
  const added = await extend(db);
  if (added) save(db);

  const extra = await getExtra();

  const out = {};
  for (const mkt of MARKETS) {
    const rows = db.data[mkt.key] || [];
    const series = computeFG(rows, extra[mkt.key] || extra.ALL || null);
    out[mkt.key] = series.slice(-days);
  }

  return {
    added,
    lastDate: (out.KOSPI && out.KOSPI.length) ? out.KOSPI[out.KOSPI.length - 1].date : null,
    parts: 5,
    data: out,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = (app) => {
  app.get('/fear-greed', async (req, res) => {
    try {
      const days = Math.min(Number(req.query.days) || 250, 500);
      if (CACHE.data && CACHE.days === days && Date.now() - CACHE.at < 30 * 60 * 1000) {
        return res.json(CACHE.data);
      }
      CACHE.data = await build(days);
      CACHE.days = days;
      CACHE.at = Date.now();
      res.json(CACHE.data);
    } catch (e) {
      if (CACHE.data) return res.json(Object.assign({}, CACHE.data, { stale: true, lastError: String((e && e.message) || e) }));
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
