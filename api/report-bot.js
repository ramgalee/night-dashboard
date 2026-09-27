// 텔레그램 봇이 AI 로 요약한 리포트 (서버 report_bot.js)
//   GET /api/report-bot
export default async function handler(req, res) {
  try {
    const r = await fetch('http://141.164.40.229:3000/report-bot');
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
