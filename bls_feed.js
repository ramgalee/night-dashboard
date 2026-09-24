// BLS 달력 중계
//   GET /bls-ics
//
// 미국 노동부(bls.gov)가 클라우드 서버(Vercel)의 접속을 막는 경우가 있어,
// 우리 서버가 대신 받아 6시간 보관했다가 그대로 넘겨줍니다.
const 주소 = 'https://www.bls.gov/schedule/news_release/bls.ics';
const 신선 = 6 * 3600 * 1000;

const 캐시 = { at: 0, 글: null, 오류: null };

async function 받아오기() {
  if (캐시.글 && Date.now() - 캐시.at < 신선) return 캐시.글;
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 20000);
  try {
    const r = await fetch(주소, {
      signal: ac.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
        'Accept': 'text/calendar,text/plain,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!r.ok) throw new Error('bls ' + r.status);
    const 글 = await r.text();
    if (!글.includes('BEGIN:VEVENT')) throw new Error('달력 형식이 아님 (' + 글.length + '자)');
    캐시.글 = 글; 캐시.at = Date.now(); 캐시.오류 = null;
    return 글;
  } catch (e) {
    캐시.오류 = String((e && e.message) || e);
    if (캐시.글) return 캐시.글;                 // 실패하면 지난 것이라도
    throw e;
  } finally { clearTimeout(시계); }
}

module.exports = (app) => {
  app.get('/bls-ics', async (req, res) => {
    try {
      const 글 = await 받아오기();
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=1800');
      res.send(글);
    } catch (e) {
      res.status(502).send('BLS 달력을 받지 못했습니다: ' + String((e && e.message) || e));
    }
  });
};
