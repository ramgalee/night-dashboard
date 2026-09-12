export default async function handler(req, res) {
  try {
    const days = Math.min(Number(req.query.days) || 250, 500);
    const r = await fetch(`http://141.164.40.229:3000/fear-greed?days=${days}`);
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
