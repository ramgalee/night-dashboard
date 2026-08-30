// 참고 지표(다우존스, 나스닥 등)를 서버에서 대신 가져오는 함수입니다.
// Yahoo Finance의 비공식 차트 API를 씁니다 (업비트/은행간 환율과 같은 방식).
// 공식 API가 아니므로, Yahoo가 정책을 바꾸면 예고 없이 안 뜰 수 있습니다.

const INSTRUMENTS = [
  { symbol: "^DJI", name: "다우존스", type: "index" },
  { symbol: "^IXIC", name: "나스닥", type: "index" },
  { symbol: "^GSPC", name: "S&P500", type: "index" },
  { symbol: "^RUT", name: "러셀2000", type: "index" },
  { symbol: "^SOX", name: "반도체지수", type: "index" },
  { symbol: "DRAM", name: "DRAM ETF", type: "stock" }, // Roundhill Memory ETF
  { symbol: "^TNX", name: "미10년물", type: "yield" },
  { symbol: "CL=F", name: "WTI유", type: "commodity" },
  { symbol: "GC=F", name: "금선물", type: "commodity" },
];

async function fetchOne(inst) {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.symbol)}`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    if (!r.ok) return { ...inst, live: false };
    const j = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    const prevClose = meta?.previousClose ?? meta?.chartPreviousClose;
    if (price == null || prevClose == null) return { ...inst, live: false };

    if (inst.type === "yield") {
      // ^TNX는 실제 수익률의 10배로 표시되는 값입니다.
      const yieldNow = price / 10;
      const yieldPrev = prevClose / 10;
      return { ...inst, live: true, primary: yieldNow, changePts: yieldNow - yieldPrev };
    }

    const changePct = (price / prevClose - 1) * 100;
    return { ...inst, live: true, primary: price, changePct };
  } catch (e) {
    return { ...inst, live: false };
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const items = await Promise.all(INSTRUMENTS.map(fetchOne));
  res.status(200).json({ items });
};
