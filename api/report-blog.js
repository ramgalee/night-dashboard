// 리포트 해설 글 (서버 report_blog.js 가 AI 로 써서 저장해 둠)
//   GET /api/report-blog?d=20260928          그날 글 (없으면 쓰기 시작 → {status:"writing"})
//   (다시 쓰기는 서버 안에서만 됩니다 — 여기서는 넘기지 않습니다)
export default async function handler(req, res) {
  try {
    const d = String(req.query.d || '').replace(/\D/g, '');
    const r = await fetch(`http://141.164.40.229:3000/report-blog?d=${d}`);
    const data = await r.json();
    res.setHeader('Cache-Control', 'no-store');
    res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
