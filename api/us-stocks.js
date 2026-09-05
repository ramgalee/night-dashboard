export default async function handler(req, res) {
  try {
    const r = await fetch('http://141.164.40.229:3000/us-stocks');
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
