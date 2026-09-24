export default async function handler(req, res) {
  try {
    const 조각 = [];
    if (/^\d{8}$/.test(String(req.query.date || ""))) 조각.push(`date=${req.query.date}`);
    if (String(req.query.market || "").toLowerCase() === "us") 조각.push("market=us");
    const q = 조각.length ? "?" + 조각.join("&") : "";

    const r = await fetch("http://141.164.40.229:3000/timeline" + q);
    const t = await r.text();
    res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
    try { res.status(r.status).json(JSON.parse(t)); }
    catch (e) { res.status(502).json({ error: "서버 응답을 읽지 못했습니다" }); }
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
