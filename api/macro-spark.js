const SYMBOLS = [
  "^N225", "^HSI", "000001.SS", "^TWII", "KRW=X",
  "YM=F", "NQ=F", "ES=F", "RTY=F", "^SOX",
  "DRAM", "2YY=F", "^TNX", "^TYX", "CL=F", "GC=F"
];

// ── 선물 월물 고정 (롤오버 때 등락률 부풀림 막기) ─────────────
// 야후 YM=F 같은 연속 선물은 만기 뒤 다음 월물로 갈아타는데, 일봉의 '어제' 칸에는
// 옛 월물 종가가 남아 등락률이 부풀려집니다(9월→12월물이면 금리 몇 달치만큼).
// 그래서 선물은 12월물처럼 월물을 콕 집어 받고, 안 되면 원래 기호로 물러섭니다.
const 월코드 = ["F","G","H","J","K","M","N","Q","U","V","X","Z"];
function 셋째금요일(y, m) {
  const d = new Date(Date.UTC(y, m - 1, 1));
  return new Date(Date.UTC(y, m - 1, 1 + ((5 - d.getUTCDay() + 7) % 7) + 14));
}
function 영업일빼기(d, n) {
  const x = new Date(d);
  while (n > 0) { x.setUTCDate(x.getUTCDate() - 1); const w = x.getUTCDay(); if (w && w !== 6) n--; }
  return x;
}
function 영업일로(d) {
  const x = new Date(d);
  while (x.getUTCDay() === 0 || x.getUTCDay() === 6) x.setUTCDate(x.getUTCDate() - 1);
  return x;
}
const 날더하기 = (d, n) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; };
const 지수넘김 = (y, m) => 날더하기(셋째금요일(y, m), -8);
const 선물표 = {
  "ES=F":  { 앞: "ES",  뒤: ".CME", 달: [3, 6, 9, 12], 넘김: 지수넘김 },
  "NQ=F":  { 앞: "NQ",  뒤: ".CME", 달: [3, 6, 9, 12], 넘김: 지수넘김 },
  "YM=F":  { 앞: "YM",  뒤: ".CBT", 달: [3, 6, 9, 12], 넘김: 지수넘김 },
  "RTY=F": { 앞: "RTY", 뒤: ".CME", 달: [3, 6, 9, 12], 넘김: 지수넘김 },
  "CL=F":  { 앞: "CL",  뒤: ".NYM", 달: [1,2,3,4,5,6,7,8,9,10,11,12],
             넘김: (y, m) => 날더하기(영업일빼기(영업일로(new Date(Date.UTC(y, m - 2, 25))), 3), -2) },
  "GC=F":  { 앞: "GC",  뒤: ".CMX", 달: [2, 4, 6, 8, 12],
             넘김: (y, m) => 날더하기(영업일로(new Date(Date.UTC(y, m - 1, 0))), -3) },
};
function 월물기호(sym, 지금 = new Date()) {
  const t = 선물표[sym];
  if (!t) return null;
  const 오늘 = new Date(Date.UTC(지금.getUTCFullYear(), 지금.getUTCMonth(), 지금.getUTCDate()));
  for (let y = 오늘.getUTCFullYear(); y <= 오늘.getUTCFullYear() + 1; y++)
    for (const m of t.달)
      if (t.넘김(y, m) > 오늘) return `${t.앞}${월코드[m - 1]}${String(y).slice(2)}${t.뒤}`;
  return null;
}

async function one(sym) {
  // 선물은 월물을 콕 집어 먼저 받습니다 (점선 기준선이 옛 월물 값이 되지 않게).
  const 월물 = 월물기호(sym);
  if (월물) {
    const [, v] = await oneRaw(월물);
    if (v) return [sym, v];
  }
  return oneRaw(sym);
}

async function oneRaw(sym) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=1d`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    if (!r.ok) return [sym, null];
    const j = await r.json();
    const res = j && j.chart && j.chart.result && j.chart.result[0];
    if (!res) return [sym, null];

    const closes = res.indicators && res.indicators.quote && res.indicators.quote[0]
      ? res.indicators.quote[0].close : null;
    if (!closes) return [sym, null];

    const pts = closes.filter(v => typeof v === "number" && isFinite(v));
    if (pts.length < 2) return [sym, null];

    const step = Math.max(1, Math.ceil(pts.length / 60));
    const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);

    const meta = res.meta || {};
    const prev = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;

    return [sym, { points: thin.map(v => Number(v.toFixed(4))), prevClose: prev ?? null }];
  } catch (e) {
    return [sym, null];
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  const pairs = await Promise.all(SYMBOLS.map(one));
  const out = {};
  for (const [k, v] of pairs) if (v) out[k] = v;
  res.status(200).json({ series: out });
};
