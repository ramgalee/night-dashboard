// 네이버 뉴스 검색 API(NAVER API HUB)를 대신 호출해주는 서버 함수입니다.
// 2026년 7월, 네이버가 뉴스 검색 API를 예전 개발자센터에서 NAVER Cloud Platform의
// API HUB로 이전했습니다. 그래서 자격증명 이름과 호출 주소가 예전과 다릅니다.
// Key ID/Key는 코드에 직접 적지 않고, Vercel 프로젝트의 "환경변수"에 저장합니다.
// (배포방법.md의 "뉴스 API 연결하기" 항목 참고)

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const KEY_ID = process.env.NAVER_CLIENT_ID;
  const KEY = process.env.NAVER_CLIENT_SECRET;

  if (!KEY_ID || !KEY) {
    res.status(200).json({ items: [], configured: false });
    return;
  }

  const query = req.query?.q || "미국증시";

  try {
    const url =
      "https://naverapihub.apigw.ntruss.com/search/v1/news?query=" +
      encodeURIComponent(query) +
      "&display=10&sort=date";

    const r = await fetch(url, {
      headers: {
        "X-NCP-APIGW-API-KEY-ID": KEY_ID,
        "X-NCP-APIGW-API-KEY": KEY,
      },
    });

    if (!r.ok) {
      res.status(200).json({ items: [], configured: true, error: true });
      return;
    }

    const data = await r.json();
    // 제목/설명에 섞여오는 HTML 태그(<b>, &quot; 등)를 정리해서 순수 텍스트로 변환
    const clean = (s) =>
      (s || "")
        .replace(/<[^>]*>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");

    const items = (data.items || []).map((it) => ({
      title: clean(it.title),
      link: it.originallink || it.link,
      pubDate: it.pubDate,
    }));

    res.status(200).json({ items, configured: true });
  } catch (e) {
    res.status(200).json({ items: [], configured: true, error: true });
  }
};
