// 시장 요약 — 화면이 보고 있는 값을 그대로 받아 문장으로 만듭니다.
//   POST /api/summary   { market: "kr" | "us", data: {...} }
//   → { text, at, cached }
//
// Vercel 환경변수 ANTHROPIC_API_KEY 가 있어야 합니다.
// 값을 새로 받아오지 않고 화면이 준 숫자만 쓰므로, 요약과 화면이 어긋나지 않습니다.
// 계정마다 쓸 수 있는 모델 이름이 달라, 앞에서부터 되는 것을 씁니다.
// 한 번 성공하면 그 이름을 기억해 다음부터는 바로 씁니다.
const 모델후보 = [
  "claude-opus-5-5",              // 계정에서 쓸 수 있는 것이 확인된 이름
  "claude-sonnet-5",
  "claude-sonnet-4-5",
  "claude-haiku-4-5-20251001",
];
let 쓰는모델 = null;
// Vercel 기본 제한(10초)으로는 모자랄 수 있어 늘려 둡니다.
export const config = { maxDuration: 60 };

const 캐시 = new Map();          // 열쇠 → { text, at }
const 캐시시간 = 20 * 60 * 1000;

// 지표 하나만 놓고 짧게 해석할 때 쓰는 규칙
const 지표규칙 = `당신은 한국 경제지 증권부 기자입니다. 지표 하나를 놓고 지금 상태를 짚어 줍니다.

문체
- 경제지 기사체. 문장 끝은 '-했다', '-이다' 로 통일한다.
- 2~3문장, 한 문단. 제목이나 목록 기호를 쓰지 않는다.
- 숫자는 주어진 그대로 쓴다.

반드시 지킬 것
- 주어진 수치만으로 말한다. 뉴스·발언·정책 같은 바깥 사정은 지어내지 않는다.
- 투자 권유로 읽힐 표현을 쓰지 않는다. ("매수 기회", "비중 확대", "지금 사야" 등 금지)
- 앞으로 오를지 내릴지 예측하지 않는다. 지금이 어떤 상태인지, 최근 흐름이 어느 쪽인지까지만 쓴다.
- 과열이나 위축 같은 상태 서술은 해도 된다.`;

const 규칙 = `당신은 한국 경제지 증권부 기자입니다. 주어진 수치만으로 마감 시황 기사를 씁니다.

문체
- 경제지 기사체. 문장 끝은 '-했다', '-했습니다' 가 아니라 '-했다' 로 통일한다.
- 5~7문장, 한 문단. 제목이나 머리글, 목록 기호를 쓰지 않는다.
- 숫자는 자료에 있는 그대로 쓴다. 퍼센트는 소수점 둘째 자리까지.

반드시 지킬 것
- 주어진 자료에 없는 사실을 쓰지 않는다. 특히 뉴스·발언·정책·실적 같은 원인은 자료에 없으므로 절대 지어내지 않는다.
  ("미 연준 발언에", "실적 기대에" 같은 표현 금지)
- 자료 안의 수치끼리의 관계는 해석해도 된다. (예: 외국인 순매수와 업종 등락의 방향이 같다)
- 뉴스 제목이 함께 주어지면, 그 제목에 적힌 사실만 원인으로 언급할 수 있다.
  제목에 없는 내용을 덧붙이거나 제목 문장을 그대로 번역해 옮기지 않는다. 우리 문장으로 다시 쓴다.
  오늘 크게 움직인 종목과 관련된 제목을 우선 쓰고, 관련 없는 제목은 버린다.
- [종목 뉴스] 로 묶인 제목은 그 종목이 왜 움직였는지 알려주는 단서다.
  크게 오른 종목과 크게 내린 종목 가운데 2~3개는 이유를 한 구절로 덧붙인다.
  (예: "○○는 실적 전망 상향 소식에 4.2% 올랐다")
  뉴스에 근거가 없는 종목은 이유를 쓰지 말고 등락만 적는다. 추측해서 붙이지 않는다.
- 투자 권유로 읽힐 표현을 쓰지 않는다. ("매수 기회", "비중 확대", "주목할 만하다" 등 금지)
- 전망이나 예측을 쓰지 않는다. 오늘 일어난 일만 서술한다.
- 자료가 비어 있는 항목은 언급하지 않는다.

국내 자료에만 있는 지표 (주어졌을 때만 쓴다)
- 업종 쏠림지수: 그날 가장 많이 오른 상위 업종에 얼마나 몰렸는지를 나타낸다.
  오실레이터가 0보다 크고 오르면 주도 업종으로 쏠리는 장, 0보다 작거나 내리면 순환매 성격이 강한 장이다.
  동조화는 업종들이 얼마나 같이 움직였는지다. 높으면 시장 전체가 한 방향, 낮으면 업종별로 따로 움직였다는 뜻이다.
  주도 업종 이름과 함께 한 문장으로 적는다.
- 테마: 인포스탁 분류 기준으로 오른 테마와 내린 테마다. 상위 2~3개를 등락률과 함께 적는다.
- 시장 폭: 지수가 아니라 종목이 어땠는지다.
  ADR 은 최근 20일 동안 오른 종목 수를 내린 종목 수로 나눈 값이다. 80 아래면 침체권, 120 위면 과열권으로 본다.
  당일 등락비율은 그날 하루만 본 것으로, ADR 과 방향이 다를 수 있다.
  거래대금 가중 등락률이 지수 등락률보다 높으면 큰 종목이 장을 끌었고, 낮으면 큰 종목이 부진했다는 뜻이다.
  거래대금이 한 업종에 절반 넘게 몰렸다면 그 사실을 적는다.
- 공포탐욕지수: 0에 가까울수록 공포, 100에 가까울수록 탐욕이다. 전일과 비교해 한 구절로 적는다.`;

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
    for (const [시장, x] of Object.entries(d.tilt)) {
      if (!x || typeof x !== "object" || !x.top) continue;
      const 이름 = 시장 === "KOSPI" ? "코스피" : 시장 === "KOSDAQ" ? "코스닥" : 시장;
      줄.push(`${이름} 업종 쏠림지수: 주도 업종 ${(x.top || []).join(", ")}` +
        (x.osc != null ? ` · 오실레이터 ${짧게(x.osc, 3)}` +
          (x.전osc != null ? ` (전일 ${짧게(x.전osc, 3)})` : "") : "") +
        (x.corr != null ? ` · 동조화 ${짧게(x.corr, 3)}` : ""));
    }
  }
  if (d.theme && (d.theme.오름 || []).length) {
    const 적기 = a => a.map(x => `${x.name} ${짧게(x.changePct)}%`).join(", ");
    줄.push(`테마 상승 상위: ${적기(d.theme.오름)}`);
    if ((d.theme.내림 || []).length) 줄.push(`테마 하락 상위: ${적기(d.theme.내림)}`);
  }
  if (d.breadth) {
    const b = d.breadth;
    for (const [시장, x] of Object.entries(b.adr || {})) {
      if (!x) continue;
      줄.push(`${시장} ADR(20일): ${짧게(x.adr20, 1)} · 당일 등락비율 ${짧게(x.adr, 1)}` +
        (x.rising != null ? ` (오른 ${x.rising}종목 내린 ${x.falling}종목)` : ""));
    }
    if (b.weightedChangePct != null) 줄.push(`코스피 거래대금 가중 등락률: ${짧게(b.weightedChangePct)}%`);
    if ((b.sectors || []).length) 줄.push(`거래대금 비중: ` +
      b.sectors.slice(0, 3).map(x => `${x.name} ${짧게(x.share, 1)}%`).join(", "));
    if (b.high60 != null) 줄.push(`60일 신고가 ${b.high60}종목 · 정배열 ${b.aligned}종목`);
  }
  if (d.streak && d.streak.length) 줄.push(`연속 순매수 종목: ${d.streak.slice(0, 5).join(", ")}`);
  return 줄.join("\n");
}

// ── 지표 하나 해석 ───────────────────────────────
function 공포탐욕정리(d) {
  const 줄 = [];
  if (d.date) 줄.push(`기준일: ${d.date} · 시장: ${d.market || "코스피"}`);
  줄.push(`공포탐욕지수: ${짧게(d.fg, 1)} (0에 가까울수록 공포, 100에 가까울수록 탐욕)`);
  if (d.label) 줄.push(`구간: ${d.label}`);
  if (d.prev != null) 줄.push(`전일: ${짧게(d.prev, 1)}`);
  if (d.ema20 != null) 줄.push(`20일 지수이동평균: ${짧게(d.ema20, 1)} — 지수가 이 선 위면 오름세, 아래면 내림세`);
  if (d.osc != null) 줄.push(`오실레이터(MACD 히스토그램): ${짧게(d.osc, 3)}` +
    (d.prevOsc != null ? ` (전일 ${짧게(d.prevOsc, 3)})` : ""));
  if (d.close != null) 줄.push(`${d.market || "코스피"} 종가: ${d.close}`);
  if (d.parts) {
    const a = Object.entries(d.parts).filter(([, v]) => v != null)
      .map(([k, v]) => `${k} ${짧게(v, 1)}`);
    if (a.length) 줄.push(`구성 항목(각 20% 가중, 0~100 환산): ${a.join(", ")}`);
  }
  return 줄.join("\n");
}

function 쏠림정리(d) {
  const 줄 = [];
  if (d.date) 줄.push(`기준일: ${d.date} · 시장: ${d.market || "코스피"}`);
  줄.push(`업종 쏠림지수는 그날 많이 오른 상위 ${d.topN || 5}개 업종에 상승이 얼마나 몰렸는지를 나타낸다.`);
  if (d.top && d.top.length) 줄.push(`오늘 주도 업종: ${d.top.join(", ")}`);
  if (d.osc != null) 줄.push(`오실레이터: ${짧게(d.osc, 3)}` +
    (d.prevOsc != null ? ` (전일 ${짧게(d.prevOsc, 3)})` : "") +
    ` — 0보다 크고 오르면 주도 업종 쏠림, 0보다 작거나 내리면 순환매 성격`);
  if (d.corr != null) 줄.push(`동조화(30일): ${짧게(d.corr, 3)}` +
    (d.prevCorr != null ? ` (전일 ${짧게(d.prevCorr, 3)})` : "") +
    ` — 높으면 업종이 한 몸처럼, 낮으면 업종별로 따로 움직였다는 뜻`);
  if (d.recent && d.recent.length) {
    줄.push(`최근 주도 업종 흐름: ` + d.recent.map(x => `${x.date.slice(4)} ${x.top.slice(0, 3).join("·")}`).join(" / "));
  }
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
  const 시장 = ["us", "fg", "tilt"].includes(body.market) ? body.market : "kr";
  const 자료 = body.data || {};
  const 지표들 = { fg: 공포탐욕정리, tilt: 쏠림정리 };
  const 지표냐 = !!지표들[시장];
  let 본문 = 지표냐 ? 지표들[시장](자료)
           : 시장 === "us" ? 미국정리(자료) : 국내정리(자료);
  // 종목 뉴스를 먼저, 시장 뉴스를 그다음에 넣습니다.
  // 시각순으로 자르면 정작 필요한 종목 뉴스가 잘려나갑니다.
  const 전부 = body.news || [];
  const 종목뉴스 = 전부.filter(x => /^야후 [A-Z.\-]+$/.test(x.source || ""));
  const 시장뉴스 = 전부.filter(x => !/^야후 [A-Z.\-]+$/.test(x.source || ""));
  const 적기 = a => a.map(x => `- (${x.source}) ${x.title}`).join("\n");
  if (종목뉴스.length) 본문 += "\n\n[종목 뉴스 — 괄호 안이 해당 종목]\n" + 적기(종목뉴스.slice(0, 25));
  if (시장뉴스.length) 본문 += "\n\n[시장 뉴스]\n" + 적기(시장뉴스.slice(0, 15));
  if (!본문.trim()) return res.status(400).json({ error: "요약할 자료가 없습니다" });

  const 열쇠 = 시장 + "|" + 본문;
  const 있 = 캐시.get(열쇠);
  if (있 && Date.now() - 있.at < 캐시시간 && !body.force) {
    return res.status(200).json({ text: 있.text, at: 있.at, cached: true });
  }

  const 머리 = 시장 === "us"
    ? "다음은 한국시간 기준 간밤 미국 증시 자료다. 지수·선물·금리·유가와 업종별 종목 등락이다.\n\n"
    : 시장 === "fg" ? "다음은 오늘 공포탐욕지수 자료다. 지금 상태를 짚어 달라.\n\n"
    : 시장 === "tilt" ? "다음은 오늘 업종 쏠림지수 자료다. 지금 상태를 짚어 달라.\n\n"
    : "다음은 오늘 한국 증시 마감 자료다.\n\n";

  async function 부르기(model) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": 키,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 지표냐 ? 400 : 900,
        temperature: 0.3,
        system: 지표냐 ? 지표규칙 : 규칙,
        messages: [{ role: "user", content: 머리 + 본문 }],
      }),
    });
    return { r, j: await r.json() };
  }

  try {
    let r, j;
    for (const m of (쓰는모델 ? [쓰는모델] : 모델후보)) {
      ({ r, j } = await 부르기(m));
      if (r.ok) { 쓰는모델 = m; break; }
      const 말 = String((j.error && j.error.message) || "");
      if (!/model/i.test(말) && r.status !== 404) break;   // 모델 이름 문제일 때만 다음 후보로
    }
    if (!r.ok) {
      return res.status(r.status).json({
        error: (j.error && j.error.message) || "요약 실패",
        tried: 쓰는모델 ? [쓰는모델] : 모델후보,
      });
    }
    const text = (j.content || []).filter(x => x.type === "text").map(x => x.text).join("\n").trim();
    if (!text) return res.status(502).json({ error: "빈 응답" });
    const at = Date.now();
    캐시.set(열쇠, { text, at });
    if (캐시.size > 40) 캐시.delete(캐시.keys().next().value);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ text, at, cached: false, model: 쓰는모델 });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
