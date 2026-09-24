// 시황 타임라인 (국내 · 미국)
//   GET /timeline            오늘 국내 장중 기록
//   GET /timeline?market=us  간밤 미국 기록
//   GET /timeline?date=YYYYMMDD
//
// 장중 30분마다 그 시각의 지수·수급·ADR·거래대금 비중·테마를 모아
// 두세 문장으로 적어 둡니다. 회원 모두가 같은 글을 보므로 서버가 한 번만 만듭니다.
//
// ★ Anthropic API 키가 필요합니다 — /root/app/.env 의 ANTHROPIC_API_KEY
const fs = require('fs');
const path = require('path');

const 안 = 'http://127.0.0.1:3000';
const 폴더 = '/root/app/timeline';
const 미국폴더 = '/root/app/timeline_us';
const 모델후보 = ['claude-opus-5-5', 'claude-sonnet-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];
let 쓰는모델 = null;

const 규칙 = `당신은 한국 경제지 증권부 기자입니다. 장중 시황을 짧게 적습니다.

형식
- 첫 줄: 제목 한 줄 (20자 안팎, 마침표 없이)
- 둘째 줄부터: 2~3문장 본문. 문장 끝은 '-했다', '-이다' 로 통일한다.
- 제목과 본문 사이에 빈 줄을 하나 둔다. 목록 기호나 머리글은 쓰지 않는다.

반드시 지킬 것
- 주어진 수치만으로 쓴다. 뉴스·발언·정책 같은 바깥 사정은 지어내지 않는다.
- 투자 권유로 읽힐 표현을 쓰지 않는다. ("매수 기회", "비중 확대", "주목" 등 금지)
- 앞으로의 전망을 쓰지 않는다. 지금까지 일어난 일만 적는다.
- 직전 시각의 글이 함께 주어지면, 그때와 달라진 점을 중심으로 쓴다.
  달라진 것이 거의 없으면 그 사실을 짧게 적는다. 같은 문장을 되풀이하지 않는다.
- 숫자는 주어진 그대로, 퍼센트는 소수점 둘째 자리까지 쓴다.`;

const 미국덧붙임 = `

미국 증시를 쓸 때
- 종목 이름은 주어진 한글 이름 그대로 쓴다.
- 뉴스 제목이 함께 주어지면 그 제목에 적힌 사실만 원인으로 쓸 수 있다. 크게 움직인 종목 한둘만 짚는다.
- 마감 정리를 요청받으면 그날 전체를 아우르되, 지수·금리·유가와 주도 업종을 먼저 적는다.`;

function 키읽기() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  for (const p of ['/root/app/.env', path.join(__dirname, '.env')]) {
    try {
      const m = fs.readFileSync(p, 'utf8').match(/ANTHROPIC_API_KEY\s*=\s*(\S+)/);
      if (m) return m[1].replace(/^["']|["']$/g, '');
    } catch (e) {}
  }
  return null;
}

async function 내부(경로) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(안 + 경로, { signal: ac.signal });
    if (!r.ok) throw new Error(경로 + ' → ' + r.status);
    return await r.json();
  } finally { clearTimeout(시계); }
}

const 한국시간 = () => new Date(Date.now() + 9 * 3600e3);
const 오늘날짜 = () => 한국시간().toISOString().slice(0, 10).replace(/-/g, '');
const 어느폴더 = 미국 => 미국 ? 미국폴더 : 폴더;
const 파일경로 = (d, 미국) => path.join(어느폴더(미국), `${d}.json`);

function 읽기(d, 미국) {
  try { return JSON.parse(fs.readFileSync(파일경로(d, 미국), 'utf8')); }
  catch (e) { return { date: d, items: [] }; }
}
function 쓰기(d, v, 미국) {
  const 폴 = 어느폴더(미국);
  try {
    fs.mkdirSync(폴, { recursive: true });
    const 임시 = 파일경로(d, 미국) + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(v), 'utf8');
    fs.renameSync(임시, 파일경로(d, 미국));
  } catch (e) {}
  // 오래된 날은 정리 (30일)
  try {
    const 목록 = fs.readdirSync(폴).filter(f => /^\d{8}\.json$/.test(f)).sort();
    for (const f of 목록.slice(0, Math.max(0, 목록.length - 30))) fs.unlinkSync(path.join(폴, f));
  } catch (e) {}
}

// ── 그 시각의 자료를 한 덩어리로 ────────────────────
function 숫자(v, 자리 = 2) {
  return (v == null || !isFinite(v)) ? null : Number(Number(v).toFixed(자리));
}

async function 자료모으기() {
  const 줄 = [];
  const [idx, bd, theme] = await Promise.all([
    내부('/index-intraday').catch(() => null),
    내부('/market-breadth').catch(() => null),
    내부('/infra-theme').catch(() => null),
  ]);

  if (idx) {
    for (const [이름, x] of [['코스피', idx.kospi], ['코스닥', idx.kosdaq]]) {
      if (!x) continue;
      줄.push(`${이름}: ${x.value ?? '-'} (${숫자(x.changePct)}%)` +
        (x.rising != null ? ` · 상승 ${x.rising} 하락 ${x.falling}종목` : ''));
    }
    const f = (idx.kospi && idx.kospi.flow) || {};
    const 억 = v => v == null ? null : Math.round(v / 1e8);
    if (f.foreign != null || f.institution != null) {
      줄.push(`코스피 순매수(억원): 개인 ${억(f.individual)}, 외국인 ${억(f.foreign)}, 기관 ${억(f.institution)}`);
    }
  }

  if (bd && bd.markets) {
    for (const [키, 이름] of [['KOSPI', '코스피'], ['KOSDAQ', '코스닥']]) {
      const m = bd.markets[키] || {};
      if (m.adr20 != null) 줄.push(`${이름} ADR(20일): ${m.adr20} · 당일 등락비율 ${m.adr}`);
    }
    const kp = bd.markets.KOSPI || {};
    if (kp.weightedChangePct != null) 줄.push(`코스피 거래대금 가중 등락률: ${kp.weightedChangePct}%`);
    if ((kp.sectors || []).length) {
      줄.push(`코스피 거래대금 비중: ` +
        kp.sectors.slice(0, 4).map(x => `${x.name} ${숫자(x.share, 1)}%(${숫자(x.changePct)}%)`).join(', '));
    }
    const kq = bd.markets.KOSDAQ || {};
    if ((kq.sectors || []).length) {
      줄.push(`코스닥 거래대금 비중: ` +
        kq.sectors.slice(0, 3).map(x => `${x.name} ${숫자(x.share, 1)}%(${숫자(x.changePct)}%)`).join(', '));
    }
  }

  if (theme && (theme.themes || []).length) {
    const a = theme.themes.filter(x => x.changePct != null).sort((x, y) => y.changePct - x.changePct);
    줄.push(`테마 상위: ${a.slice(0, 4).map(x => `${x.name} ${숫자(x.changePct)}%`).join(', ')}`);
    줄.push(`테마 하위: ${a.slice(-2).reverse().map(x => `${x.name} ${숫자(x.changePct)}%`).join(', ')}`);
  }

  return 줄.join('\n');
}

// ── 미국 자료 ───────────────────────────────────
async function 미국자료() {
  const 줄 = [];
  const [us, news] = await Promise.all([
    내부('/us-stocks').catch(() => null),
    내부('/us-news-lite').catch(() => null),          // 없으면 뉴스 없이 씁니다
  ]);
  if (!us || !(us.groups || []).length) return '';

  for (const g of us.groups) {
    const items = (g.items || []).filter(x => x.changePct != null);
    if (!items.length) continue;
    const 이름 = g.sub ? `${g.name} · ${g.sub}` : g.name;
    const a = items.slice().sort((x, y) => y.changePct - x.changePct);
    const 적기 = arr => arr.map(x => `${x.name} ${숫자(x.changePct)}%`).join(', ');
    줄.push(`[${이름}] 평균 ${숫자(g.avgChangePct)}% · 상위 ${적기(a.slice(0, 3))}` +
      (a.length > 4 ? ` · 하위 ${적기(a.slice(-2).reverse())}` : ''));
  }
  if (news && (news.items || []).length) {
    줄.push('\n[뉴스 제목]');
    for (const x of news.items.slice(0, 20)) 줄.push(`- (${x.source}) ${x.title}`);
  }
  return 줄.join('\n');
}

async function 글쓰기(본문, 직전, 시각, 옵션 = {}) {
  const 키 = 키읽기();
  if (!키) throw new Error('ANTHROPIC_API_KEY 가 없습니다');

  const 머리 = (옵션.미국
    ? `지금은 한국시간 ${시각} 이다. 아래는 이 시각의 미국 증시 자료다.` +
      (옵션.마감 ? ' 오늘 미국장은 방금 마감했다. 하루를 정리하는 글을 써라.' : '') + '\n\n'
    : `지금은 ${시각} 이다. 아래는 이 시각의 한국 증시 자료다.\n\n`) + 본문 +
    (직전 ? `\n\n[직전 ${직전.time} 에 적은 글]\n${직전.title}\n${직전.body}` : '');

  async function 부르기(model) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 키, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 500, temperature: 0.3,
        system: 규칙 + (옵션.미국 ? 미국덧붙임 : ''),
        messages: [{ role: 'user', content: 머리 }],
      }),
    });
    return { r, j: await r.json() };
  }

  let r, j;
  for (const m of (쓰는모델 ? [쓰는모델] : 모델후보)) {
    ({ r, j } = await 부르기(m));
    if (r.ok) { 쓰는모델 = m; break; }
    const 말 = String((j.error && j.error.message) || '');
    if (!/model/i.test(말) && r.status !== 404) break;
  }
  if (!r.ok) throw new Error((j.error && j.error.message) || '요약 실패');

  const 글 = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n').trim();
  const 조각 = 글.split(/\n\s*\n/);
  return {
    title: (조각[0] || '').replace(/^#+\s*/, '').trim().slice(0, 60),
    body: 조각.slice(1).join('\n').trim() || 글,
  };
}

// ── 30분마다 한 줄 ──────────────────────────────
function 장중인가() {
  const t = 한국시간();
  const 요일 = t.getUTCDay(), 분 = t.getUTCHours() * 60 + t.getUTCMinutes();
  return 요일 >= 1 && 요일 <= 5 && 분 >= 9 * 60 && 분 <= 15 * 60 + 40;
}

// ── 미국장 시간 (서머타임 자동 판정) ────────────────
// 미국 동부의 지금 시각을 직접 구해, 서머타임이든 아니든 09:30~16:00 사이인지 봅니다.
function 미국동부() {
  const s = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour12: false });
  const m = s.match(/(\d+)\/(\d+)\/(\d+),?\s+(\d+):(\d+)/);
  if (!m) return null;
  return { 월: +m[1], 일: +m[2], 요일: new Date(`${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}T12:00:00Z`).getUTCDay(),
           분: (+m[4] % 24) * 60 + (+m[5]) };
}
function 미국장중() {
  const t = 미국동부();
  if (!t) return false;
  return t.요일 >= 1 && t.요일 <= 5 && t.분 >= 9 * 60 + 30 && t.분 <= 16 * 60;
}
function 미국마감직후() {
  const t = 미국동부();
  if (!t) return false;
  return t.요일 >= 1 && t.요일 <= 5 && t.분 > 16 * 60 && t.분 <= 16 * 60 + 35;
}
// 미국 기록은 '그 장이 시작한 한국 날짜' 로 묶습니다 (밤에 시작해 새벽에 끝나므로).
function 미국날짜() {
  const t = 한국시간();
  const 분 = t.getUTCHours() * 60 + t.getUTCMinutes();
  const d = new Date(t);
  if (분 < 12 * 60) d.setUTCDate(d.getUTCDate() - 1);      // 새벽이면 전날 장
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

let 도는중 = { kr: false, us: false };
async function 한줄쌓기(강제, 미국 = false) {
  const 열쇠 = 미국 ? 'us' : 'kr';
  if (도는중[열쇠]) return;
  const 마감 = 미국 && 미국마감직후();
  if (!강제 && !(미국 ? (미국장중() || 마감) : 장중인가())) return;
  도는중[열쇠] = true;
  try {
    const d = 미국 ? 미국날짜() : 오늘날짜();
    const 지금 = 한국시간();
    const 시각 = `${String(지금.getUTCHours()).padStart(2, '0')}:${String(지금.getUTCMinutes()).padStart(2, '0')}`;
    const 파일 = 읽기(d, 미국);
    const 직전 = 파일.items[0] || null;

    // 같은 30분 칸에 이미 적었으면 건너뜁니다 (마감 정리는 예외).
    const 칸 = t => t.slice(0, 2) + (Number(t.slice(3, 5)) < 30 ? "A" : "B");
    if (직전 && 칸(직전.time) === 칸(시각) && !마감) return;
    if (마감 && 직전 && 직전.kind === 'close') return;      // 마감 정리는 하루 한 번

    const 본문 = 미국 ? await 미국자료() : await 자료모으기();
    if (!본문.trim()) return;

    const 글 = await 글쓰기(본문, 직전, 시각, { 미국, 마감 });
    파일.items.unshift({ time: 시각, at: new Date().toISOString(), kind: 마감 ? 'close' : 'live', ...글 });
    파일.date = d;
    쓰기(d, 파일, 미국);
    console.log(`[timeline${미국 ? '-us' : ''}] ${d} ${시각}${마감 ? ' 마감정리' : ''} · ${글.title}`);
  } catch (e) {
    console.log(`[timeline${미국 ? '-us' : ''}] 실패:`, String((e && e.message) || e));
  } finally { 도는중[열쇠] = false; }
}

// 5분마다 확인해, 30분 칸이 바뀌었으면 한 줄 적습니다.
setInterval(() => {
  한줄쌓기(false, false).catch(() => {});
  한줄쌓기(false, true).catch(() => {});
}, 5 * 60 * 1000);
setTimeout(() => {
  한줄쌓기(false, false).catch(() => {});
  한줄쌓기(false, true).catch(() => {});
}, 20 * 1000);

module.exports = (app) => {
  app.get('/timeline', (req, res) => {
    const 미국 = String(req.query.market || '').toLowerCase() === 'us';
    const d = /^\d{8}$/.test(String(req.query.date || '')) ? String(req.query.date)
            : (미국 ? 미국날짜() : 오늘날짜());
    res.setHeader('Cache-Control', 'no-store');
    const 파일 = 읽기(d, 미국);
    res.json({ date: d, market: 미국 ? 'us' : 'kr', count: 파일.items.length, items: 파일.items, model: 쓰는모델 });
  });

  // 손으로 한 줄 더 적고 싶을 때 (장 마감 뒤에도 됩니다)
  app.get('/timeline/now', async (req, res) => {
    const 미국 = String(req.query.market || '').toLowerCase() === 'us';
    await 한줄쌓기(true, 미국);
    res.json(읽기(미국 ? 미국날짜() : 오늘날짜(), 미국));
  });
};
