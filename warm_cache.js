// ═══════════════════════════════════════════════════════════
//  warm_cache.js — 느린 창구를 미리 받아 두고, 화면에는 저장본을 바로 줍니다
//
//    GET /cached?path=/infra-theme       저장본을 즉시 돌려줍니다 (없으면 그때 한 번 받음)
//    GET /cached/status                  무엇을 얼마나 자주 받아 두는지 (확인용)
//
//  왜 — 2026-09-27 재어 보니 몇 창구가 요청이 올 때마다 키움을 새로 불러 느렸습니다.
//        stock-flow 27초(브리핑 투자자 동향) · infra-theme 25초(테마 히트맵·브리핑)
//        us-stocks 7초 · supply-ratio 5초 · us-flow 4초 · program-flow 1.7초 · fear-greed 1.2초
//  어떻게 — 한 번 받은 것은 저장해 두고 화면에는 저장본을 바로 줍니다(0.01초).
//        오래되면 뒤에서 새로 받아 바꿔 둡니다. 기다리는 사람이 없습니다.
//        누가 보고 있는 동안(최근 15분 안에 요청)은 자주, 아무도 안 볼 때는 드물게 받습니다.
//
//  ★ 화면 쪽(api 폴더의 Vercel 함수)이 /cached?path=… 로 부르도록 함께 바꿨습니다.
//    이 파일이 없거나 멈추면 Vercel 함수가 알아서 예전처럼 원래 창구를 부릅니다.
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

const 파일 = '/root/app/warm_cache.json';
const 안 = 'http://127.0.0.1:3000';
const 분 = 60 * 1000;

// 받아 둘 수 있는 창구와 주기 — [앞부분, 장중 볼 때, 장중 안 볼 때, 장 밖, 스스로 받기]
//   장중 = 평일 08:50~16:00 (미국 창구는 한국시간 22:00~07:00)
const 규칙 = [
  ['/stock-flow',   20 * 분, 20 * 분, 60 * 분, true,  '국내'],
  ['/infra-theme',  1.5 * 분, 10 * 분, 60 * 분, true,  '국내'],
  ['/supply-ratio', 1 * 분,  10 * 분, 60 * 분, true,  '국내'],
  ['/program-flow', 1 * 분,  10 * 분, 60 * 분, true,  '국내'],
  ['/fear-greed',   10 * 분, 20 * 분, 60 * 분, true,  '국내'],
  ['/us-stocks',    2 * 분,  10 * 분, 60 * 분, true,  '미국'],
  ['/us-flow',      15 * 분, 30 * 분, 60 * 분, true,  '미국'],
];
function 규칙찾기(경로) {
  const 앞 = 경로.split('?')[0];
  const r = 규칙.find(([p]) => 앞 === p);
  if (!r) return null;
  // 테마 하나(?code=)처럼 가짓수가 많은 것은 스스로 받지 않고, 요청이 올 때만 새로 받습니다
  const 스스로 = r[4] && !(앞 === '/infra-theme' && 경로.includes('code='));
  return { 앞, 볼때: r[1], 안볼때: r[2], 장밖: r[3], 스스로, 시장: r[5] };
}

function 한국시각() { const d = new Date(Date.now() + 9 * 3600e3); return { 요일: d.getUTCDay(), 분: d.getUTCHours() * 60 + d.getUTCMinutes() }; }
function 장중(시장) {
  const { 요일, 분: m } = 한국시각();
  if (시장 === '미국') return (요일 >= 1 && 요일 <= 5 && m >= 22 * 60) || (요일 >= 2 && 요일 <= 6 && m < 7 * 60);
  return 요일 >= 1 && 요일 <= 5 && m >= 8 * 60 + 50 && m < 16 * 60;
}

// 저장소 — { 경로: { body, status, at, took, asked, error } }
let 저장 = {};
try { 저장 = JSON.parse(fs.readFileSync(파일, 'utf8')); } catch (e) {}
let 쓰기예약 = null;
function 쓰기() {
  if (쓰기예약) return;
  쓰기예약 = setTimeout(() => {
    쓰기예약 = null;
    try { fs.writeFileSync(파일 + '.tmp', JSON.stringify(저장)); fs.renameSync(파일 + '.tmp', 파일); } catch (e) {}
  }, 5000);
}

function 주기(경로) {
  const r = 규칙찾기(경로), x = 저장[경로];
  if (!장중(r.시장)) return r.장밖;
  return x && x.asked && Date.now() - x.asked < 15 * 분 ? r.볼때 : r.안볼때;
}

const 받는중 = new Map();
function 새로받기(경로) {
  if (받는중.has(경로)) return 받는중.get(경로);
  const 시작 = Date.now();
  const p = (async () => {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 90 * 1000);
    try {
      const r = await fetch(안 + 경로, { signal: ac.signal });
      const body = await r.text();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + body.slice(0, 80));
      JSON.parse(body);                                  // 깨진 답은 저장하지 않습니다
      const x = 저장[경로] = { ...(저장[경로] || {}), body, status: r.status, at: Date.now(), took: Date.now() - 시작, error: null };
      쓰기();
      return x;
    } catch (e) {
      저장[경로] = { ...(저장[경로] || {}), error: String(e.message || e), errAt: Date.now() };
      throw e;
    } finally { clearTimeout(t); 받는중.delete(경로); }
  })();
  받는중.set(경로, p);
  return p;
}

// 뒤에서 차례로 — 한 번에 하나씩만 받아 키움에 몰리지 않게
let 도는중 = false;
async function 돌기() {
  if (도는중) return;
  도는중 = true;
  try {
    for (const 경로 of Object.keys(저장)) {
      const r = 규칙찾기(경로), x = 저장[경로];
      if (!r) { delete 저장[경로]; continue; }
      if (x.asked && Date.now() - x.asked > 3 * 86400e3) { delete 저장[경로]; 쓰기(); continue; }   // 3일 아무도 안 보면 그만
      if (!r.스스로) continue;
      if (x.at && Date.now() - x.at < 주기(경로)) continue;
      try { await 새로받기(경로); } catch (e) {}
    }
  } finally { 도는중 = false; }
}

// 처음부터 받아 둘 것 (화면이 부르는 모양 그대로)
const 씨앗 = ['/stock-flow?codes=005930,000660,252670&from=20260320', '/infra-theme', '/supply-ratio',
             '/program-flow', '/us-stocks', '/us-flow'];
for (const p of 씨앗) if (!저장[p]) 저장[p] = { asked: Date.now() };

module.exports = (app) => {
  setTimeout(돌기, 40 * 1000);            // 서버가 뜨고 40초 뒤 (다른 모듈이 준비된 다음)
  setInterval(돌기, 30 * 1000);

  app.get('/cached', async (req, res) => {
    const 경로 = String(req.query.path || '');
    if (!경로.startsWith('/') || !규칙찾기(경로)) return res.status(400).json({ error: '받아 둘 수 없는 창구입니다: ' + 경로 });
    let x = 저장[경로];
    if (x) { x.asked = Date.now(); 쓰기(); }
    try {
      if (!x || !x.body) x = await 새로받기(경로);                      // 처음 한 번만 기다립니다
      else if (Date.now() - x.at > 주기(경로)) 새로받기(경로).catch(() => {});   // 오래됐으면 뒤에서 새로
      x.asked = Date.now();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('X-Cache-Age', String(Math.round((Date.now() - x.at) / 1000)));
      res.status(x.status || 200).send(x.body);
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) });
    }
  });

  app.get('/cached/status', (req, res) => {
    const 목록 = Object.entries(저장).map(([경로, x]) => ({
      path: 경로, ageSec: x.at ? Math.round((Date.now() - x.at) / 1000) : null,
      tookSec: x.took ? Math.round(x.took / 100) / 10 : null,
      everySec: 규칙찾기(경로) ? Math.round(주기(경로) / 1000) : null,
      lastAskedMin: x.asked ? Math.round((Date.now() - x.asked) / 60000) : null,
      size: x.body ? x.body.length : 0, error: x.error || null,
    }));
    res.json({ entries: 목록.length, list: 목록 });
  });
};
