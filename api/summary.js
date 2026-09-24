// 시장 요약 — 화면이 보고 있는 값을 그대로 받아 문장으로 만듭니다.
//   POST /api/summary   { market: "kr" | "us", data: {...} }
//   → { text, at, cached }
//
// Vercel 환경변수 ANTHROPIC_API_KEY 가 있어야 합니다.
// 값을 새로 받아오지 않고 화면이 준 숫자만 쓰므로, 요약과 화면이 어긋나지 않습니다.
const MODEL = "claude-sonnet-5";
const 캐시 = new Map();          // 열쇠 → { text, at }
const 캐시시간 = 20 * 60 * 1000;

const 규칙 = `당신은 한국 경제지 증권부 기자입니다. 주어진 수치만으로 마감 시황 기사를 씁니다.

문체
- 경제지 기사체. 문장 끝은 '-했다', '-했습니다' 가 아니라 '-했다' 로 통일한다.
- 3~5문장, 한 문단. 제목이나 머리글, 목록 기호를 쓰지 않는다.
- 숫자는 자료에 있는 그대로 쓴다. 퍼센트는 소수점 둘째 자리까지.

반드시 지킬 것
- 주어진 자료에 없는 사실을 쓰지 않는다. 특히 뉴스·발언·정책·실적 같은 원인은 자료에 없으므로 절대 지어내지 않는다.
  ("미 연준 발언에", "실적 기대에" 같은 표현 금지)
- 자료 안의 수치끼리의 관계는 해석해도 된다. (예: 외국인 순매수와 업종 등락의 방향이 같다)
- 뉴스 제목이 함께 주어지면, 그 제목에 적힌 사실만 원인으로 언급할 수 있다.
  제목에 없는 내용을 덧붙이거나 제목 문장을 그대로 번역해 옮기지 않는다. 우리 문장으로 다시 쓴다.
  오늘 크게 움직인 종목과 관련된 제목을 우선 쓰고, 관련 없는 제목은 버린다.
- 투자 권유로 읽힐 표현을 쓰지 않는다. ("매수 기회", "비중 확대", "주목할 만하다" 등 금지)
- 전망이나 예측을 쓰지 않는다. 오늘 일어난 일만 서술한다.
- 자료가 비어 있는 항목은 언급하지 않는다.`;

function 짧게(n, 자리 = 2) {
  return (n == null || !isFinite(n)) ? null : Number(Number(n).toFixed(자리));
}

// 화면이 보낸 것에서 필요한 것만 추려 프롬프트로 만듭니다(토큰 절약 + 헛소리 방지).
function 국내정리(d) {
  const 줄 = [];
  const 지수 = (이름, x) => {
    if (!x) return;
    줄.push(`${이름}: ${x.value ?? "-"} (${짧게(x.changePct)}%)` +
      (x.rising != null ? ` 상승 ${x.rising}종목 하락 ${x.falling}종목` : ""));
  };
  if (d.date) 줄.push(`날짜: ${d.date}`);
  지수("코스피", d.kospi);
  지수("코스닥", d.kosdaq);
  const f = (d.kospi && d.kospi.flow) || {};
  const 억 = v => v == null ? null : Math.round(v / 1e8);
  if (f.individual != null || f.foreign != null || f.institution != null) {
    줄.push(`코스피 투자자 순매수(억원): 개인 ${억(f.individual)}, 외국인 ${억(f.foreign)}, 기관 ${억(f.institution)}`);
  }
  for (const [시장, s] of Object.entries(d.sectors || {})) {
    if (!s || !s.length) continue;
    const a = s.filter(x => x.changePct != null).sort((x, y) => y.changePct - x.changePct);
    const n = Math.min(4, Math.floor(a.length / 2));      // 업종이 적으면 상·하위가 겹치지 않게
    if (!n) continue;
    const 쓰기 = arr => arr.map(x => `${x.name} ${짧게(x.changePct)}%`).join(", ");
    줄.push(`${시장} 업종 상위: ${쓰기(a.slice(0, n))}`);
    줄.push(`${시장} 업종 하위: ${쓰기(a.slice(-n).reverse())}`);
  }
  if (d.fg && d.fg.value != null) 줄.push(`공포탐욕지수: ${짧게(d.fg.value, 1)}${d.fg.prev != null ? ` (전일 ${짧게(d.fg.prev, 1)})` : ""}`);
  if (d.tilt) {
    줄.push(`업종 쏠림지수: 주도 업종 ${(d.tilt.top || []).join(", ")}` +
      (d.tilt.osc != null ? ` · 오실레이터 ${짧게(d.tilt.osc, 3)}` : ""));
  }
  if (d.streak && d.streak.length) 줄.push(`연속 순매수 종목: ${d.streak.slice(0, 5).join(", ")}`);
  return 줄.join("\n");
}

function 미국정리(d) {
  const 줄 = [];
  for (const g of (d.groups || [])) {
    const items = (g.items || []).filter(x => x.changePct != null);
    if (!items.length) continue;
    const 이름 = g.sub ? `${g.name} · ${g.sub}` : g.name;
    const a = items.slice().sort((x, y) => y.changePct - x.changePct);
    const 뽑기 = arr => arr.map(x => `${x.name} ${짧게(x.changePct)}%`).join(", ");
    줄.push(`[${이름}] 평균 ${짧게(g.avgChangePct)}% · 상위 ${뽑기(a.slice(0, 3))}` +
      (a.length > 4 ? ` · 하위 ${뽑기(a.slice(-2).reverse())}` : ""));
  }
  return 줄.join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST 로 보내주세요" });
  const 키 = process.env.ANTHROPIC_API_KEY;
  if (!키) return res.status(500).json({ error: "ANTHROPIC_API_KEY 가 없습니다" });

  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const 시장 = body.market === "us" ? "us" : "kr";
  const 자료 = body.data || {};
  let 본문 = 시장 === "us" ? 미국정리(자료) : 국내정리(자료);
  const 뉴스 = (body.news || []).slice(0, 40)
    .map(x => `- (${x.source}) ${x.title}`).join("\n");
  if (뉴스) 본문 += "\n\n[오늘 나온 뉴스 제목]\n" + 뉴스;
  if (!본문.trim()) return res.status(400).json({ error: "요약할 자료가 없습니다" });

  const 열쇠 = 시장 + "|" + 본문;
  const 있 = 캐시.get(열쇠);
  if (있 && Date.now() - 있.at < 캐시시간 && !body.force) {
    return res.status(200).json({ text: 있.text, at: 있.at, cached: true });
  }

  const 머리 = 시장 === "us"
    ? "다음은 한국시간 기준 간밤 미국 증시 자료다. 지수·선물·금리·유가와 업종별 종목 등락이다.\n\n"
    : "다음은 오늘 한국 증시 마감 자료다.\n\n";

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": 키,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        temperature: 0.3,
        system: 규칙,
        messages: [{ role: "user", content: 머리 + 본문 }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      return res.status(r.status).json({ error: (j.error && j.error.message) || "요약 실패" });
    }
    const text = (j.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
    if (!text) return res.status(502).json({ error: "빈 응답" });
    const at = Date.now();
    캐시.set(열쇠, { text, at });
    if (캐시.size > 40) 캐시.delete(캐시.keys().next().value);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ text, at, cached: false });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
