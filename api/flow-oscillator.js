// 수급오실레이터 — 중계 서버(Vultr)의 /flow-oscillator 를 그대로 전해 줍니다.
//   GET /api/flow-oscillator?code=000660
//
// ★ 2026-09-29 고침 — 서버·키움이 잠깐 바쁠 때(대형주 수급 수집과 겹칠 때 등) 차트가 안 나오던 문제
//   · 기다리는 시간을 넉넉히(최대 55초) — 예전에는 Vercel 기본 제한에 걸려 끊길 수 있었습니다.
//   · 실패하면 2초 쉬고 한 번 더 받아 봅니다.
// ★ 2026-10-01 — 서버 osc_cache 를 거쳐 받습니다(같은 종목 3분 저장 · 키움 호출을 한 줄로).
//   서버에 osc_cache 가 아직 없으면(404) 예전 길로 받습니다.
export const config = { maxDuration: 60 };
const RELAY_URL = process.env.KIWOOM_RELAY_URL || "http://141.164.40.229:3000";
const 쉬기 = ms => new Promise(r => setTimeout(r, ms));

async function 한번(code) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 28000);
  try {
    let r = await fetch(`${RELAY_URL}/flow-oscillator-cached?code=${encodeURIComponent(code)}`, { signal: ac.signal });
    if (r.status === 404) r = await fetch(`${RELAY_URL}/flow-oscillator?code=${encodeURIComponent(code)}`, { signal: ac.signal });
    const data = await r.json();
    if (data && !data.error && Array.isArray(data.series) && data.series.length) return data;
    throw new Error((data && (data.message || data.error)) || "빈 결과");
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const code = String((req.query && req.query.code) || "000660").trim();
  let 마지막 = null;
  for (let k = 0; k < 2; k++) {
    try { return res.status(200).json(await 한번(code)); }
    catch (e) { 마지막 = e; if (k === 0) await 쉬기(2000); }
  }
  res.status(200).json({ error: true, message: "중계 서버 응답 실패: " + String((마지막 && 마지막.message) || 마지막) });
}
