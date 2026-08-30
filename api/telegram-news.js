// 텔레그램 공개 채널의 웹 미리보기 페이지(t.me/s/채널명)를 서버에서 읽어와
// 글 제목과 링크만 뽑아내는 함수입니다. 별도 API 키가 필요 없습니다.
//
// 주의: 이건 텔레그램의 공식 API가 아니라 공개 페이지의 구조를 읽는 방식이라,
// 텔레그램이 페이지 구조를 바꾸면 예고 없이 결과가 비어버릴 수 있습니다.
// 그럴 땐 이 파일을 다시 손봐야 합니다.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const CHANNEL = "dada_news2";

  try {
    const r = await fetch(`https://t.me/s/${CHANNEL}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!r.ok) {
      res.status(200).json({ items: [], error: true });
      return;
    }
    const html = await r.text();

    const clean = (s) =>
      s
        .replace(/<br\s*\/?>/gi, " ")
        .replace(/<[^>]+>/g, "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\s+/g, " ")
        .trim();

    // 각 글의 본문 텍스트 추출 (메시지 텍스트에는 보통 <div>가 중첩되지 않으므로,
    // 여는 태그 다음 첫 번째 </div>를 닫는 태그로 간주합니다)
    const texts = [];
    const textRe = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
    let m;
    while ((m = textRe.exec(html)) !== null) {
      texts.push(clean(m[1]));
    }

    // 각 글의 원문 링크(permalink) + 작성 시각 추출
    const links = [];
    const linkRe =
      /class="tgme_widget_message_date"\s+href="([^"]+)"[\s\S]*?datetime="([^"]+)"/g;
    while ((m = linkRe.exec(html)) !== null) {
      links.push({ link: m[1], date: m[2] });
    }

    const count = Math.min(texts.length, links.length);
    const items = [];
    for (let i = 0; i < count; i++) {
      if (!texts[i]) continue;
      items.push({
        title: texts[i].length > 140 ? texts[i].slice(0, 140) + "…" : texts[i],
        link: links[i].link,
        pubDate: links[i].date,
      });
    }

    items.reverse(); // 페이지에는 오래된 글이 위, 최신 글이 아래에 있어서 뒤집어줌

    res.status(200).json({ items: items.slice(0, 15), error: false });
  } catch (e) {
    res.status(200).json({ items: [], error: true });
  }
};
