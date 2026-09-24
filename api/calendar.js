// 증시 일정 달력
//   GET /api/calendar            앞뒤 6개월
//   GET /api/calendar?from=202601&to=202612
//
// 두 곳에서 모아 합칩니다.
//   1) 미국 노동부(BLS) 공식 달력 — CPI·고용보고서·PPI 등 발표 예정일
//   2) calendar.json — 직접 적는 국내 일정 (주피터에서 엑셀 → json)
//
// 미국 시각(동부)을 한국 시각으로 바꿔 넣습니다. 서머타임은 자동으로 가립니다.
const BLS_ICS = "https://www.bls.gov/schedule/news_release/bls.ics";
const 내일정 = "https://raw.githubusercontent.com/ramgalee/night-dashboard/main/calendar.json";

// BLS 발표 중 증시에 쓰이는 것만 골라 한글 이름을 붙입니다.
const 골라쓰기 = [
  [/^Employment Situation$/i, "미국 고용보고서", "높음"],
  [/^Consumer Price Index$/i, "미국 소비자물가 CPI", "높음"],
  [/^Producer Price Index$/i, "미국 생산자물가 PPI", "보통"],
  [/^Job Openings and Labor Turnover Survey$/i, "미국 구인·이직 JOLTS", "보통"],
  [/^Employment Cost Index$/i, "미국 고용비용지수 ECI", "보통"],
  [/^U\.S\. Import and Export Price Indexes$/i, "미국 수출입물가", "낮음"],
  [/^Productivity and Costs$/i, "미국 생산성·단위노동비용", "낮음"],
  [/^Real Earnings$/i, "미국 실질임금", "낮음"],
];

// ── 동부 시각 → 한국 시각 ─────────────────────────
// 같은 시각을 뉴욕에서 읽어 차이를 재는 방식이라, 서머타임을 따로 계산할 필요가 없습니다.
function 동부를한국으로(y, mo, d, hh, mm) {
  const 어림 = Date.UTC(y, mo - 1, d, hh, mm);
  const 뉴욕 = new Date(어림).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  const m = 뉴욕.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+)/);
  if (!m) return null;
  const 읽힌값 = Date.UTC(+m[3], +m[1] - 1, +m[2], +m[4] % 24, +m[5]);
  const 시차 = 어림 - 읽힌값;                  // 동부가 UTC 보다 몇 시간 뒤인지
  const 진짜UTC = 어림 + 시차;
  const k = new Date(진짜UTC + 9 * 3600e3);    // 한국 시각
  return {
    date: `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`,
    time: `${String(k.getUTCHours()).padStart(2, "0")}:${String(k.getUTCMinutes()).padStart(2, "0")}`,
  };
}

// ── BLS 달력 읽기 ────────────────────────────────
function ics풀기(글) {
  const 줄들 = String(글).replace(/\r\n[ \t]/g, "").split(/\r?\n/);   // 접힌 줄 펴기
  const 결과 = [];
  let 지금 = null;
  for (const 줄 of 줄들) {
    if (줄.startsWith("BEGIN:VEVENT")) { 지금 = {}; continue; }
    if (줄.startsWith("END:VEVENT")) {
      if (지금 && 지금.when && 지금.summary) 결과.push(지금);
      지금 = null; continue;
    }
    if (!지금) continue;
    if (줄.startsWith("SUMMARY:")) 지금.summary = 줄.slice(8).replace(/\\,/g, ",").trim();
    else if (줄.startsWith("DTSTART")) {
      const m = 줄.match(/:(\d{8})T(\d{2})(\d{2})/);
      if (m) 지금.when = { y: +m[1].slice(0, 4), mo: +m[1].slice(4, 6), d: +m[1].slice(6, 8), hh: +m[2], mm: +m[3] };
    }
  }
  return 결과;
}

let BLS캐시 = { at: 0, items: null };
async function bls가져오기() {
  if (BLS캐시.items && Date.now() - BLS캐시.at < 12 * 3600e3) return BLS캐시.items;
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch(BLS_ICS, {
      signal: ac.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (!r.ok) throw new Error("bls " + r.status);
    const 원본 = ics풀기(await r.text());
    const 결과 = [];
    for (const x of 원본) {
      const 짝 = 골라쓰기.find(([re]) => re.test(x.summary));
      if (!짝) continue;
      const k = 동부를한국으로(x.when.y, x.when.mo, x.when.d, x.when.hh, x.when.mm);
      if (!k) continue;
      결과.push({
        date: k.date, time: k.time, title: 짝[1], importance: 짝[2],
        market: "US", source: "BLS", original: x.summary,
      });
    }
    BLS캐시 = { at: Date.now(), items: 결과 };
    return 결과;
  } catch (e) {
    return BLS캐시.items || [];                 // 실패하면 지난 것이라도
  } finally { clearTimeout(시계); }
}

// ── 직접 적은 일정 ───────────────────────────────
let 내캐시 = { at: 0, items: null };
async function 내일정가져오기() {
  if (내캐시.items && Date.now() - 내캐시.at < 10 * 60e3) return 내캐시.items;
  try {
    const r = await fetch(내일정, { headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) throw new Error("calendar.json " + r.status);
    const j = await r.json();
    const 결과 = (j.events || j.items || []).map(x => ({
      date: String(x.date || "").replace(/[^0-9]/g, "").slice(0, 8),
      time: x.time || "",
      title: String(x.title || "").trim(),
      importance: x.importance || "보통",
      market: x.market || "KR",
      memo: x.memo || "",
      source: "직접",
    })).filter(x => x.date.length === 8 && x.title);
    내캐시 = { at: Date.now(), items: 결과 };
    return 결과;
  } catch (e) {
    return 내캐시.items || [];
  }
}

export default async function handler(req, res) {
  try {
    const [us, mine] = await Promise.all([bls가져오기(), 내일정가져오기()]);
    let 모두 = [...mine, ...us];

    const from = /^\d{6}$/.test(String(req.query.from || "")) ? String(req.query.from) : null;
    const to = /^\d{6}$/.test(String(req.query.to || "")) ? String(req.query.to) : null;
    if (from) 모두 = 모두.filter(x => x.date.slice(0, 6) >= from);
    if (to) 모두 = 모두.filter(x => x.date.slice(0, 6) <= to);

    모두.sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));

    // 날짜별로 묶어 보냅니다 — 화면이 달력을 그리기 쉽게
    const 날짜별 = {};
    for (const x of 모두) (날짜별[x.date] = 날짜별[x.date] || []).push(x);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=7200");
    res.status(200).json({
      generatedAt: new Date().toISOString(),
      count: 모두.length,
      counts: { 직접: mine.length, BLS: us.length },
      byDate: 날짜별,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e), byDate: {} });
  }
}
