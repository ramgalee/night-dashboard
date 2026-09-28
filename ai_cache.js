// ═══════════════════════════════════════════════════════════
//  ai_cache.js — AI 요약 글을 서버 한 곳에 저장해 두고 모두가 같이 씁니다
//
//    GET  /ai-cache?k=열쇠          저장된 글 { text, at, model, forced } (없으면 404)
//    POST /ai-cache                 { k, text, model, forced }  — Vercel(api/summary.js)만 씁니다
//    GET  /ai-cache/status          오늘 AI 를 몇 번 불렀는지 · 저장본을 몇 번 돌려줬는지
//
//  왜 — 예전에는 Vercel 함수 안에만 잠깐 기억해 두어, 회원이 페이지를 열 때마다
//        AI 가 새로 쓰는 일이 많았습니다(그만큼 비용). 이제 한 시간 단위·마감 뒤 하루 한 번만 씁니다.
//  쓰기 허락 — ANTHROPIC_API_KEY 로 만든 비밀값을 함께 보내야 저장됩니다
//        (Vercel 과 서버에 같은 키가 들어 있어 따로 설정할 것이 없습니다).
// ═══════════════════════════════════════════════════════════
const fs = require('fs');
const crypto = require('crypto');

const 파일 = '/root/app/ai_cache.json';
const 최대 = 400;

function 환경(이름) {
  if (process.env[이름]) return process.env[이름];
  try {
    const m = fs.readFileSync('/root/app/.env', 'utf8').match(new RegExp('^\\s*' + 이름 + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}
const 비밀 = () => { const k = 환경('ANTHROPIC_API_KEY'); return k ? crypto.createHash('sha256').update(k + '|ai-cache').digest('hex').slice(0, 32) : null; };

let 저장 = {};
try { 저장 = JSON.parse(fs.readFileSync(파일, 'utf8')); } catch (e) {}
let 예약 = null;
function 쓰기() {
  if (예약) return;
  예약 = setTimeout(() => {
    예약 = null;
    const 열쇠들 = Object.keys(저장).sort((a, b) => (저장[a].at || 0) - (저장[b].at || 0));
    while (열쇠들.length > 최대) delete 저장[열쇠들.shift()];
    try { fs.writeFileSync(파일 + '.tmp', JSON.stringify(저장)); fs.renameSync(파일 + '.tmp', 파일); } catch (e) {}
  }, 2000);
}

// 오늘 통계 (한국 날짜 기준)
const 오늘 = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
let 통계 = { day: 오늘(), writes: 0, hits: 0, misses: 0, byMarket: {} };
function 세기(칸, k) {
  if (통계.day !== 오늘()) 통계 = { day: 오늘(), writes: 0, hits: 0, misses: 0, byMarket: {} };
  통계[칸] += 1;
  if (칸 === 'writes') { const m = String(k).split('|')[0]; 통계.byMarket[m] = (통계.byMarket[m] || 0) + 1; }
}

function 본문읽기(req) {
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length) return Promise.resolve(req.body);
  return new Promise((ok) => {
    let t = '';
    req.on('data', c => { t += c; if (t.length > 200000) req.destroy(); });
    req.on('end', () => { try { ok(JSON.parse(t || '{}')); } catch (e) { ok({}); } });
    req.on('error', () => ok({}));
  });
}

module.exports = (app) => {
  app.get('/ai-cache', (req, res) => {
    const x = 저장[String(req.query.k || '')];
    if (!x) { 세기('misses'); return res.status(404).json({ error: 'none' }); }
    세기('hits');
    res.json(x);
  });
  app.post('/ai-cache', async (req, res) => {
    const b = await 본문읽기(req);
    const s = 비밀();
    if (!s || req.headers['x-ai-cache'] !== s) return res.status(403).json({ error: '허락되지 않음' });
    if (!b.k || !b.text) return res.status(400).json({ error: 'k · text 가 필요합니다' });
    저장[String(b.k)] = { text: String(b.text).slice(0, 8000), at: Date.now(), model: b.model || null, forced: !!b.forced };
    세기('writes', b.k);
    쓰기();
    res.json({ ok: true });
  });
  app.get('/ai-cache/status', (req, res) => {
    const 최근 = Object.entries(저장).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 12)
      .map(([k, x]) => ({ key: k, at: new Date(x.at).toISOString(), model: x.model, forced: x.forced }));
    res.json({ ...통계, stored: Object.keys(저장).length, recent: 최근 });
  });
};
