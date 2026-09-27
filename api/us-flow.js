// 서버가 미리 받아 둔 것(warm_cache)을 먼저, 안 되면 원래 창구를
const 서버 = 'http://141.164.40.229:3000';
async function 받기(경로) {
  try { const r = await fetch(`${서버}/cached?path=${encodeURIComponent(경로)}`); if (r.ok) return r; } catch (e) {}
  return fetch(서버 + 경로);
}
export default async function handler(req, res) {
  try {
    const r = await 받기('/us-flow');
    const t = await r.text();
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    try { res.status(r.status).json(JSON.parse(t)); }
    catch (e) { res.status(502).json({ error: "서버 응답을 읽지 못했습니다" }); }
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
