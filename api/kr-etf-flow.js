export default async function handler(req, res) {
  try {
    const r = await fetch("http://141.164.40.229:3000/kr-etf-flow");
    const t = await r.text();
    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
    try { res.status(r.status).json(JSON.parse(t)); }
    catch (e) { res.status(502).json({ error: "서버 응답을 읽지 못했습니다" }); }
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
