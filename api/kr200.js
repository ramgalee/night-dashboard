// 코스피200 야간 참고지표 — Hyperliquid xyz dex의 KR200 perp
// KRX 공식 시세가 아니라 해외 파생상품 거래소에서 형성된 참고값입니다.
const HL = "https://api.hyperliquid.xyz/info";
const COIN = "xyz:KR200";
const KST = 9 * 3600 * 1000;

async function hl(body) {
  const r = await fetch(HL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error("hl " + r.status);
  return r.json();
}

// 야간 세션(18:00~익일 06:00 KST)의 시작 시각을 구합니다.
function sessionStart(now) {
  const k = new Date(now + KST);
  let s = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 18) - KST;
  if (s > now) s -= 24 * 3600 * 1000;
  return s;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=30");
  try {
    const [meta, ctxs] = await hl({ type: "metaAndAssetCtxs", dex: "xyz" });
    const i = meta.universe.findIndex(u => u.name === COIN);
    if (i < 0) throw new Error("KR200 없음");
    const c = ctxs[i];

    const mark = Number(c.markPx);
    const oracle = Number(c.oraclePx);
    const prevDay = Number(c.prevDayPx);

    const now = Date.now();
    const start = sessionStart(now);
    const end = Math.min(now, start + 12 * 3600 * 1000);

    let points = [];
    try {
      const candles = await hl({
        type: "candleSnapshot",
        req: { coin: COIN, interval: "5m", startTime: start, endTime: end }
      });
      points = (candles || [])
        .filter(x => x.t >= start && x.t <= end)
        .map(x => Number(x.c))
        .filter(v => Number.isFinite(v));
    } catch (e) {
      points = [];
    }

    res.status(200).json({
      coin: COIN,
      live: Number.isFinite(mark),
      mark, oracle, prevDay,
      openInterest: Number(c.openInterest),
      changePts: Number.isFinite(prevDay) ? Number((mark - prevDay).toFixed(2)) : null,
      changePct: Number.isFinite(prevDay) && prevDay ? Number(((mark / prevDay - 1) * 100).toFixed(2)) : null,
      sessionStart: start,
      points
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), live: false });
  }
};
