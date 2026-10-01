// ═══════════════════════════════════════════════════════════
//  osc_cache.js — 수급오실레이터 결과를 종목마다 잠깐 저장하고, 키움 호출을 한 줄로 세웁니다
//
//    GET /flow-oscillator-cached?code=000660          회원 화면용 (api/flow-oscillator.js 가 부름)
//    GET /flow-oscillator-cached?code=000660&bg=1     '오늘의 주도주' 계산용 (leader_scan.js · 뒤로 양보)
//    GET /flow-oscillator-cached/status               저장한 종목 수 · 기다리는 줄 · 오늘 실패 수
//
//  왜 — 장 초반에는 주도주 계산(50종목 · 5분마다)과 거래대금·프로그램·잠정 수급이 한꺼번에 키움을 불러
//        회원이 누른 종목이 빈손으로 돌아오곤 했습니다(차트가 보였다 안 보였다, 2026-10-01).
//  어떻게
//    · 같은 종목은 장중(평일 08~20시) 3분, 그 밖에는 30분 동안 저장해 둔 것을 그대로 줍니다.
//      주도주 계산이 이미 받아 둔 종목을 회원이 누르면 키움을 다시 부르지 않습니다.
//    · 키움 호출은 한 번에 하나씩, 회원 요청이 주도주 계산보다 먼저 갑니다.
//    · 같은 종목을 여럿이 동시에 눌러도 키움에는 한 번만 묻습니다.
//    · 키움이 실패하면 하루 안에 받아 둔 옛 결과라도 줍니다(stale 표시).
//  실제 계산은 server.js 의 /flow-oscillator 가 그대로 합니다.
// ═══════════════════════════════════════════════════════════
const 안 = 'http://127.0.0.1:3000';
const 최대 = 400;                      // 저장해 둘 종목 수
const 저장 = new Map();                // code → { data, at }
const 진행중 = new Map();              // code → Promise
const 줄 = { 앞: [], 뒤: [] };          // 앞 = 회원, 뒤 = 주도주 계산
let 일하는중 = false;
const 오늘 = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
let 통계 = { day: 오늘(), hits: 0, kiwoom: 0, fails: 0, stale: 0 };
const 세기 = k => { if (통계.day !== 오늘()) 통계 = { day: 오늘(), hits: 0, kiwoom: 0, fails: 0, stale: 0 }; 통계[k]++; };

function 장중() {
  const t = new Date(Date.now() + 9 * 3600e3), 요일 = t.getUTCDay(), 분 = t.getUTCHours() * 60 + t.getUTCMinutes();
  return 요일 >= 1 && 요일 <= 5 && 분 >= 8 * 60 && 분 < 20 * 60;
}
const 신선 = () => (장중() ? 3 : 30) * 60 * 1000;

async function 키움에서(code) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(`${안}/flow-oscillator?code=${encodeURIComponent(code)}`, { signal: ac.signal });
    const d = await r.json();
    if (d && !d.error && Array.isArray(d.series) && d.series.length) return d;
    throw new Error((d && (d.message || d.error)) || '빈 결과');
  } finally { clearTimeout(t); }
}

// 한 번에 하나씩 — 회원(앞) 줄을 먼저 비웁니다
async function 돌리기() {
  if (일하는중) return;
  일하는중 = true;
  try {
    while (줄.앞.length || 줄.뒤.length) {
      const 일 = 줄.앞.length ? 줄.앞.shift() : 줄.뒤.shift();
      세기('kiwoom');
      try {
        let d;
        try { d = await 키움에서(일.code); }
        catch (e) { await new Promise(r => setTimeout(r, 1500)); d = await 키움에서(일.code); }   // 한 번 더
        저장.delete(일.code); 저장.set(일.code, { data: d, at: Date.now() });
        while (저장.size > 최대) 저장.delete(저장.keys().next().value);
        일.ok(d);
      } catch (e) { 세기('fails'); 일.no(e); }
      await new Promise(r => setTimeout(r, 150));
    }
  } finally { 일하는중 = false; }
}

function 받기(code, 뒤로) {
  if (진행중.has(code)) {
    // 주도주 계산 줄에 있던 종목을 회원이 누르면 앞줄로 옮깁니다
    if (!뒤로) { const i = 줄.뒤.findIndex(x => x.code === code); if (i >= 0) 줄.앞.push(...줄.뒤.splice(i, 1)); }
    return 진행중.get(code);
  }
  const p = new Promise((ok, no) => { (뒤로 ? 줄.뒤 : 줄.앞).push({ code, ok, no }); })
    .finally(() => 진행중.delete(code));
  진행중.set(code, p);
  돌리기();
  return p;
}

module.exports = (app) => {
  app.get('/flow-oscillator-cached', async (req, res) => {
    const code = String(req.query.code || '000660').trim();
    const 뒤로 = req.query.bg === '1';
    const 있던것 = 저장.get(code);
    if (있던것 && Date.now() - 있던것.at < 신선()) {
      세기('hits');
      return res.json({ ...있던것.data, cachedAt: new Date(있던것.at).toISOString() });
    }
    try {
      const d = await 받기(code, 뒤로);
      res.json(d);
    } catch (e) {
      if (있던것 && Date.now() - 있던것.at < 24 * 3600 * 1000) {
        세기('stale');
        return res.json({ ...있던것.data, cachedAt: new Date(있던것.at).toISOString(), stale: true });
      }
      res.json({ error: true, message: String((e && e.message) || e) });
    }
  });

  app.get('/flow-oscillator-cached/status', (req, res) => {
    res.json({ ...통계, stored: 저장.size, waitingMember: 줄.앞.length, waitingScan: 줄.뒤.length,
               working: 일하는중, freshMin: 신선() / 60000 });
  });
};
