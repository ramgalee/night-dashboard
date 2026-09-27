// 서버가 미리 받아 둔 것(warm_cache)을 먼저, 안 되면 원래 창구를
const 서버 = 'http://141.164.40.229:3000';
async function 받기(경로) {
  try { const r = await fetch(`${서버}/cached?path=${encodeURIComponent(경로)}`); if (r.ok) return r; } catch (e) {}
  return fetch(서버 + 경로);
}
export default async function handler(req, res) {
  try {
    const r = await 받기('/us-stocks');
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
