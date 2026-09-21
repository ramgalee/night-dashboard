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
  { symbol: "2YY=F", cnbc: "US2Y", name: "미2년물", type: "yield", region: "us" },
  { symbol: "^TNX", cnbc: "US10Y", name: "미10년물", type: "yield", region: "us" },
  { symbol: "^TYX", cnbc: "US30Y", name: "미30년물", type: "yield", region: "us" },
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

async function fetchOne(inst) {
  // 미10년물은 CNBC를 먼저 시도하고, 실패하면 아래 Yahoo 로직으로 내려갑니다.
  if (inst.type === "yield" && inst.cnbc) {
    try {
      return await fetchCnbcYield(inst);
    } catch (e) {
      // 무시하고 Yahoo로 진행
    }
  }

  // 선물은 월물을 콕 집어 먼저 받고, 안 되면 원래 기호(YM=F 등)로 받습니다.
  const 월물 = 월물기호(inst.symbol);
  if (월물) {
    const q = await yahooOne({ ...inst, symbol: 월물 });
    if (q.live) return { ...q, symbol: inst.symbol, contract: 월물 };
  }
  return yahooOne(inst);
}

async function yahooOne(inst) {
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

    // 일봉 종가 목록에서 전일 종가를 직접 찾습니다.
    // 야후 요약값(previousClose / chartPreviousClose)은 종목에 따라
    // 장중에 엉뚱한 값으로 바뀌는 경우가 있어 쓰지 않습니다.
    //
    // 목록의 마지막 봉은 보통 '오늘'이지만, 개장 직후에는 오늘 봉이
    // 아직 안 만들어져 있기도 합니다. 그래서 마지막 봉의 종가가 현재가와
    // 같은지로 판단합니다. 같으면 그 봉이 오늘이므로 한 칸 앞이 전일 종가이고,
    // 다르면 마지막 봉 자체가 전일 종가입니다.
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const days = closes.filter(c => typeof c === "number" && isFinite(c));

    let prevClose = null;
    if (days.length) {
      const lastDay = days[days.length - 1];
      const isTodayBar = price != null && Math.abs(lastDay - price) < Math.abs(price) * 1e-6;
      prevClose = isTodayBar
        ? (days.length >= 2 ? days[days.length - 2] : null)
        : lastDay;
    }

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
