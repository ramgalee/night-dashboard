// 대만 가권지수(TAIEX)를 대만거래소에서 직접 가져옵니다.
// Yahoo의 ^TWII는 20분 지연이라 방송용으로 부적합해 예외 처리했습니다.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const num = v => {
  const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

// 실시간 현재가 / 전일 종가
async function live() {
  const r = await fetch(
    "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0",
    { headers: { "User-Agent": UA, "Referer": "https://mis.twse.com.tw/stock/index.jsp" } }
  );
  if (!r.ok) throw new Error("mis " + r.status);
  const j = await r.json();
  const q = j && j.msgArray && j.msgArray[0];
  if (!q) throw new Error("mis empty");

  const price = num(q.z);
  const prev = num(q.y);
  if (price == null || prev == null) throw new Error("mis no price");

  return {
    price, prevClose: prev,
    high: num(q.h), low: num(q.l),
    quoteTime: q.t || "", date: q.d || ""
  };
}

// 당일 5분 단위 지수 (그래프용)
async function series() {
  try {
    const r = await fetch(
      "https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_INDEX?response=json",
      { headers: { "User-Agent": UA, "Referer": "https://www.twse.com.tw/" } }
    );
    if (!r.ok) return [];
    const j = await r.json();
    const rows = (j && j.data) || [];
    const pts = rows.map(row => num(row[1])).filter(v => v != null);
    const step = Math.max(1, Math.ceil(pts.length / 60));
    return pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
  } catch (e) {
    return [];
  }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  try {
    const q = await live();
    const points = await series();
    const changePts = q.price - q.prevClose;
    res.status(200).json({
      symbol: "^TWII",
      live: true,
      primary: q.price,
      prevClose: q.prevClose,
      changePts: Number(changePts.toFixed(2)),
      changePct: Number(((changePts / q.prevClose) * 100).toFixed(2)),
      quoteTime: q.quoteTime,
      date: q.date,
      points
    });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e), live: false });
  }
};
