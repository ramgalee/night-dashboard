export default async function handler(req, res) {
  try {
    const code = String(req.query.code || '').trim();
    const 경로 = code ? `/theme-stocks?code=${encodeURIComponent(code)}` : '/theme-map';
    const r = await fetch(`http://141.164.40.229:3000${경로}`);
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
