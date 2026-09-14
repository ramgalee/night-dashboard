export default async function handler(req, res) {
  try {
    const refresh = String(req.query.refresh || '') === '1' ? '?refresh=1' : '';
    const r = await fetch(`http://141.164.40.229:3000/leader-flow${refresh}`);
    const data = await r.json();

    // 서버가 아직 모으는 중이면 503 이 옵니다. 그대로 넘겨 화면에서 안내하게 합니다.
    if (!r.ok) return res.status(r.status).json(data);

    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
