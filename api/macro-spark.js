const SYMBOLS = [
  "^N225", "^HSI", "000001.SS", "^TWII", "KRW=X",
  "YM=F", "NQ=F", "ES=F", "RTY=F", "^SOX",
  "DRAM", "CL=F", "GC=F"
];

async function one(sym) {
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
