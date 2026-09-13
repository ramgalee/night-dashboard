export default async function handler(req, res) {
  try {
    const code = String(req.query.code || '').replace(/\D/g, '');
    const r = await fetch(`http://141.164.40.229:3000/sector-indicator?code=${code}`);
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
