// 참고 지표(다우존스, 나스닥 등)를 서버에서 대신 가져오는 함수입니다.
// Yahoo Finance의 비공식 차트 API를 씁니다 (업비트/은행간 환율과 같은 방식).
// 공식 API가 아니므로, Yahoo가 정책을 바꾸면 예고 없이 안 뜰 수 있습니다.

const INSTRUMENTS = [
  // 아시아 증시
  { symbol: "^N225", name: "니케이225", type: "index", region: "asia" },
  { symbol: "^HSI", name: "홍콩항셍", type: "index", region: "asia" },
  { symbol: "000001.SS", name: "상해종합", type: "index", region: "asia" },
  { symbol: "^TWII", name: "대만가권", type: "index", region: "asia" },
  { symbol: "KRW=X", name: "달러/원", type: "fx", region: "asia" },
  // 미국/원자재
  { symbol: "^DJI", name: "다우존스", type: "index", region: "us" },
  { symbol: "^IXIC", name: "나스닥", type: "index", region: "us" },
  { symbol: "^GSPC", name: "S&P500", type: "index", region: "us" },
  { symbol: "^RUT", name: "러셀2000", type: "index", region: "us" },
  { symbol: "^SOX", name: "반도체지수", type: "index", region: "us" },
  { symbol: "DRAM", name: "DRAM ETF", type: "stock", region: "us" }, // Roundhill Memory ETF
  { symbol: "^TNX", name: "미10년물", type: "yield", region: "us" },
  { symbol: "CL=F", name: "WTI유", type: "commodity", region: "us" },
  { symbol: "GC=F", name: "금선물", type: "commodity", region: "us" },
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
      // ^TNX는 이미 실제 수익률(%) 값 그대로 제공됩니다 (예: 4.73 = 4.73%).
      return { ...inst, live: true, primary: price, changePts: price - prevClose };
    }

    if (inst.type === "fx") {
      const changePct = (price / prevClose - 1) * 100;
      const changeWon = price - prevClose;
      return { ...inst, live: true, primary: price, changePct, changeWon };
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
