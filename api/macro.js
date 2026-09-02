// 참고 지표(다우존스, 나스닥 등)를 서버에서 대신 가져오는 함수입니다.
// Yahoo Finance의 비공식 차트 API를 씁니다 (업비트/은행간 환율과 같은 방식).
// 공식 API가 아니므로, Yahoo가 정책을 바꾸면 예고 없이 안 뜰 수 있습니다.
//
// 미10년물만 예외로 CNBC를 먼저 시도합니다.
// Yahoo의 ^TNX는 미국 정규장이 닫히면 값이 멈추지만,
// CNBC는 Tradeweb 시세라 아시아 시간대에도 계속 움직입니다.
// CNBC가 실패하면 자동으로 기존 Yahoo 방식으로 되돌아갑니다.
const INSTRUMENTS = [
  // 아시아 증시
  { symbol: "^N225", name: "니케이225", type: "index", region: "asia" },
  { symbol: "^HSI", name: "홍콩항셍", type: "index", region: "asia" },
  { symbol: "000001.SS", name: "상해종합", type: "index", region: "asia" },
  { symbol: "^TWII", name: "대만가권", type: "index", region: "asia" },
  { symbol: "KRW=X", name: "달러/원", type: "fx", region: "asia" },
  // 미국/원자재 (다우·나스닥·S&P500·러셀2000은 선물 티커 사용 — 정규장 마감 후에도 움직임)
  { symbol: "YM=F", name: "다우선물", type: "index", region: "us" },
  { symbol: "NQ=F", name: "나스닥선물", type: "index", region: "us" },
  { symbol: "ES=F", name: "S&P500선물", type: "index", region: "us" },
  { symbol: "RTY=F", name: "러셀2000선물", type: "index", region: "us" },
  { symbol: "^SOX", name: "반도체지수", type: "index", region: "us" }, // 유동성 있는 선물 티커가 없어 정규장 지수 유지
  { symbol: "DRAM", name: "DRAM ETF", type: "stock", region: "us" }, // Roundhill Memory ETF
  { symbol: "^TNX", cnbc: "US10Y", name: "미10년물", type: "yield", region: "us" },
  { symbol: "CL=F", name: "WTI유", type: "commodity", region: "us" },
  { symbol: "GC=F", name: "금선물", type: "commodity", region: "us" },
];

// CNBC 응답의 "4.782%", "+0.018" 같은 문자열을 숫자로 바꿉니다.
function toNum(s) {
  const n = Number(String(s).replace("%", "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function fetchCnbcYield(inst) {
  const url =
    "https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol" +
    `?symbols=${encodeURIComponent(inst.cnbc)}` +
    "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json";
  const r = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36",
      Referer: `https://www.cnbc.com/quotes/${inst.cnbc}`,
    },
  });
  if (!r.ok) throw new Error("cnbc " + r.status);
  const j = await r.json();
  const q = j?.FormattedQuoteResult?.FormattedQuote?.[0];
  const price = toNum(q?.last);
  if (price == null) throw new Error("cnbc empty");

  let changePts = toNum(q?.change);
  if (changePts == null) {
    const prev = toNum(q?.previous_day_closing);
    if (prev == null) throw new Error("cnbc no change");
    changePts = price - prev;
  }
  return {
    ...inst,
    live: true,
    primary: price,
    changePts,
    source: "cnbc",
    quoteTime: q?.last_timedate || "",
  };
}

async function fetchOne(inst) {
  // 미10년물은 CNBC를 먼저 시도하고, 실패하면 아래 Yahoo 로직으로 내려갑니다.
  if (inst.type === "yield" && inst.cnbc) {
    try {
      return await fetchCnbcYield(inst);
    } catch (e) {
      // 무시하고 Yahoo로 진행
    }
  }

  try {
    // 일봉 5일치를 받아 전일 종가를 직접 계산합니다.
    // 야후가 요약으로 주는 previousClose / chartPreviousClose 는
    // 종목에 따라 장중에 엉뚱한 값으로 바뀌는 경우가 있어(예: ^TWII) 쓰지 않습니다.
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(inst.symbol)}?interval=1d&range=5d`,
      { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" } }
    );
    if (!r.ok) return { ...inst, live: false };
    const j = await r.json();
    const result = j?.chart?.result?.[0];
    const meta = result?.meta;
    const price = meta?.regularMarketPrice;

    // 일봉 목록의 마지막 값은 항상 '현재 진행 중이거나 가장 최근에 끝난 장'입니다.
    // 따라서 그 바로 앞 값이 전일 종가입니다. 시간대 계산이 필요 없어 24시간 거래되는
    // 선물·환율이나 장이 닫힌 시장에서도 똑같이 동작합니다.
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const days = closes.filter(c => typeof c === "number" && isFinite(c));

    let prevClose = days.length >= 2 ? days[days.length - 2] : null;

    // 일봉으로 못 구하면 기존 방식으로 물러섭니다.
    if (prevClose == null) prevClose = meta?.chartPreviousClose ?? meta?.previousClose;
    if (price == null || prevClose == null) return { ...inst, live: false };
    if (inst.type === "yield") {
      // ^TNX는 이미 실제 수익률(%) 값 그대로 제공됩니다 (예: 4.73 = 4.73%).
      return { ...inst, live: true, primary: price, changePts: price - prevClose, source: "yahoo" };
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
