// 미국 증시 뉴스 제목 모으기
//   GET /api/us-news            시장 전체 헤드라인
//   GET /api/us-news?symbols=NVDA,AMD   종목별 헤드라인도 함께
//
// 각 사가 공개해 둔 RSS 만 씁니다. 본문은 가져오지 않고 제목·출처·링크만 담습니다.
// 요약문은 이 제목들만 근거로 쓰이고, 화면에는 원문 링크가 함께 나갑니다.
const 매체 = [
  { name: "CNBC 시장", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258" },
  { name: "CNBC 기술", url: "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19854910" },
  { name: "마켓워치", url: "https://feeds.content.dowjones.io/public/rss/mw_topstories" },
  { name: "야후 파이낸스", url: "https://finance.yahoo.com/news/rssindex" },
];
const 종목피드 = s =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`;

const 캐시 = new Map();
const 신선 = 10 * 60 * 1000;

function 태그(글, 이름) {
  const m = 글.match(new RegExp(`<${이름}[^>]*>([\\s\\S]*?)</${이름}>`, "i"));
  if (!m) return null;
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .trim();
}

async function 한곳(이름, 주소, 표시) {
  const 있 = 캐시.get(주소);
  if (있 && Date.now() - 있.at < 신선) return 있.rows;
  try {
    const ac = new AbortController();
    const 시계 = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(주소, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    clearTimeout(시계);
    if (!r.ok) return [];
    const 글 = await r.text();
    const 덩어리 = 글.split(/<item[\s>]/i).slice(1);
    const rows = [];
    for (const 조각 of 덩어리.slice(0, 25)) {
      const t = 태그(조각, "title");
      if (!t || t.length < 12) continue;
      rows.push({
        title: t.slice(0, 180),
        link: 태그(조각, "link") || "",
        at: 태그(조각, "pubDate") || "",
        source: 표시 || 이름,
      });
    }
    캐시.set(주소, { rows, at: Date.now() });
    return rows;
  } catch (e) {
    return [];
  }
}

function 시각(s) {
  const t = Date.parse(s || "");
  return isFinite(t) ? t : 0;
}

export default async function handler(req, res) {
  const 종목 = String(req.query.symbols || "")
    .split(",").map(x => x.trim().toUpperCase())
    .filter(x => /^[A-Z]{1,5}([.-][A-Z])?$/.test(x))
    .slice(0, 8);

  try {
    const 뭉치 = await Promise.all([
      ...매체.map(m => 한곳(m.name, m.url)),
      ...종목.map(s => 한곳("야후 " + s, 종목피드(s), "야후 " + s)),
    ]);

    const 본것 = new Set();
    const rows = [];
    for (const 묶음 of 뭉치) {
      for (const x of 묶음) {
        const 열쇠 = x.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
        if (본것.has(열쇠)) continue;      // 같은 기사가 여러 곳에 오는 경우
        본것.add(열쇠);
        rows.push(x);
      }
    }
    rows.sort((a, b) => 시각(b.at) - 시각(a.at));

    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");
    res.status(200).json({ count: rows.length, generatedAt: new Date().toISOString(), items: rows.slice(0, 60) });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e), items: [] });
  }
}
