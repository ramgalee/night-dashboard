// 거래대금 상위 자료를 그대로 넘기되, ETF·스팩·리츠를 빼고 등락률 50을 다시 채웁니다.
//
// 서버는 상위 150에서 ETF 를 포함한 채 50개를 고릅니다.
// 화면에서 ETF 만 지우면 41개처럼 모자라게 보여, 여기서 빼고 50개를 다시 세웁니다.
const ETF꼴 = /(^|\s)(KODEX|TIGER|PLUS|ACE|SOL|RISE|HANARO|KOSEF|ARIRANG|TIMEFOLIO|KIWOOM|SMART|FOCUS|BNK|WOORI|마이다스|히어로즈|파워|TREX|UNICORN|VITA|이지스|하이|마이티)\s|(레버리지|인버스|선물\s?ETN|\bETN\b|스팩|리츠)/i;

const 종목만 = a => (a || []).filter(x => !ETF꼴.test(String(x.name || "")));

export default async function handler(req, res) {
  try {
    const r = await fetch('http://141.164.40.229:3000/trade-rank');
    if (!r.ok) throw new Error('relay ' + r.status);
    const data = await r.json();

    const top150 = 종목만(data.top150);
    const up50 = top150
      .filter(x => x.changePct != null)
      .sort((a, b) => b.changePct - a.changePct)
      .slice(0, 50)
      .map((x, i) => ({ ...x, upRank: i + 1 }));

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    res.status(200).json({ ...data, top150, up50, etfExcluded: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
