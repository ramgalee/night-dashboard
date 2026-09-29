// ═══════════════════════════════════════════════════════════
//  report_bot.js — 텔레그램에 올린 리포트 PDF 를 AI 가 읽고 요약합니다
//
//    봇에게 PDF 를 보내면(1:1 대화) → 3줄 요약 · 본문 요약 · 종목·증권사·의견·목표가를 뽑아
//    /root/app/report_bot.json 에 쌓고, 봇이 요약을 답장으로 돌려줍니다.
//    채널에 올려도 됩니다(봇을 채널 관리자로 넣었을 때). 채널에는 답장하지 않습니다.
//
//    GET /report-bot          쌓인 요약 (리포트 요약 페이지가 읽음)
//    GET /report-bot/status   봇 상태 · 최근 대화방 · 오류 (확인용)
//
//  ★ /root/app/.env 에 필요한 것
//      TELEGRAM_BOT_TOKEN=123456:ABC...        (BotFather 가 준 토큰)
//      REPORT_CHAT_IDS=12345678                 (받을 대화방 번호. 쉼표로 여러 개. 비우면 아무도 못 씀)
//      ANTHROPIC_API_KEY=...                    (이미 있음 — 타임라인이 씀)
//  ★ 대화방 번호는 봇에게 아무 말이나 보낸 뒤 /report-bot/status 의 seenChats 에서 확인합니다.
//  ★ 요약은 PDF 원문을 다시 배포하지 않습니다. 원문 파일은 저장하지 않습니다.
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

const 저장파일 = '/root/app/report_bot.json';
const 보관수 = 600;
const 모델후보 = ['claude-sonnet-5', 'claude-sonnet-4-5', 'claude-haiku-4-5-20251001'];
const 최대크기 = 20 * 1024 * 1024;      // 텔레그램 봇이 받을 수 있는 한도
// 앞쪽 몇 쪽만 AI 에 보냅니다 — 요약·목표가·추정치 변경 표는 대개 앞 3~6쪽에 있고, 비용은 쪽수에 비례합니다.
// (서버에 pdf-lib 이 있을 때만 잘라 보냅니다. 없으면 통째로 보냅니다: cd /root/app && npm install pdf-lib)
const 최대쪽 = () => Number(환경('REPORT_MAX_PAGES') || 6);

function 환경(이름) {
  if (process.env[이름]) return process.env[이름];
  try {
    const m = fs.readFileSync('/root/app/.env', 'utf8').match(new RegExp('^\\s*' + 이름 + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}
const 쉬기 = ms => new Promise(r => setTimeout(r, ms));
const 한국날 = (초) => new Date((초 ? 초 * 1000 : Date.now()) + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

function 읽기() {
  try { return JSON.parse(fs.readFileSync(저장파일, 'utf8')); } catch (e) { return { offset: 0, items: [] }; }
}
function 쓰기(d) {
  d.items = (d.items || []).slice(-보관수);
  const 임시 = 저장파일 + '.tmp';
  fs.writeFileSync(임시, JSON.stringify(d), 'utf8');
  fs.renameSync(임시, 저장파일);
}

// ── 종목명 → 코드 (GitHub 의 marketcap.json) ──────────
let 이름표 = null, 이름표때 = 0;
async function 코드찾기(이름) {
  if (!이름표 || Date.now() - 이름표때 > 12 * 3600e3) {
    try {
      const j = await (await fetch('https://raw.githubusercontent.com/ramgalee/night-dashboard/main/marketcap.json')).json();
      이름표 = {};
      for (const [c, v] of Object.entries(j.info || {})) {
        const n = Array.isArray(v) ? v[0] : v && v.name, m = Array.isArray(v) ? v[1] : v && v.market;
        if (n) 이름표[String(n).replace(/\s/g, '')] = [String(c).padStart(6, '0'), m];
      }
      이름표때 = Date.now();
    } catch (e) { 이름표 = 이름표 || {}; }
  }
  return 이름표[String(이름 || '').replace(/\s/g, '')] || [null, null];
}

// ── 텔레그램 ─────────────────────────────────────────
const 상태 = { running: false, lastPoll: null, lastError: null, seenChats: {}, done: 0, failed: 0, queue: 0 };
async function tg(메서드, 내용) {
  const r = await fetch(`https://api.telegram.org/bot${환경('TELEGRAM_BOT_TOKEN')}/${메서드}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(내용 || {}),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${메서드}: ${j.description || r.status}`);
  return j.result;
}
async function 파일받기(file_id) {
  const f = await tg('getFile', { file_id });
  const r = await fetch(`https://api.telegram.org/file/bot${환경('TELEGRAM_BOT_TOKEN')}/${f.file_path}`);
  if (!r.ok) throw new Error('파일 받기 ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
const 답장 = (chat_id, reply_to_message_id, text) =>
  tg('sendMessage', { chat_id, reply_to_message_id, text: text.slice(0, 4000), disable_web_page_preview: true }).catch(() => {});

// ── AI 로 읽기 ───────────────────────────────────────
const 지시 = `당신은 증권사 리포트를 정리하는 애널리스트 보조입니다. 첨부된 PDF 리포트를 읽고 아래 JSON 한 개만 출력하세요. 다른 말은 쓰지 마세요.
{
 "type": "종목" 또는 "산업" 또는 "시황" 또는 "기타",
 "name": 종목명 (산업·시황 리포트면 업종·주제명),
 "broker": 증권사명, "author": 애널리스트 이름(여럿이면 쉼표),
 "date": 리포트 작성일 YYYYMMDD (없으면 null),
 "title": 리포트 제목,
 "opinion": 투자의견 (예: BUY, 매수, HOLD, 없으면 null),
 "target": 목표주가 숫자(원, 없으면 null), "targetPrev": 이전 목표주가 숫자(명시된 경우만, 없으면 null),
 "epsYear": 아래 EPS 의 기준 연도 (예: 2026). 올해 연간 추정치를 우선, 올해가 없으면 내년,
 "epsPrev": '실적 추정치 변경'·'추정 변경' 표의 변경 전 EPS (원, 숫자). 표가 없으면 null,
 "epsNow":  같은 표의 변경 후 EPS. 표가 없으면 리포트의 해당 연도 EPS 추정치, 그것도 없으면 null,
 "summary": [핵심 3줄. 각 줄 60자 안팎, 숫자 근거 포함],
 "body": 본문 요약 5~8문장. 실적 전망·투자 포인트·리스크를 리포트에 적힌 내용만으로
}
규칙: 리포트에 없는 내용·숫자는 지어내지 마세요. 확실하지 않은 칸은 null. EPS 는 지배주주 EPS 를 우선. 한국어로.`;

async function 앞쪽만(pdf) {
  let lib;
  try { lib = require('pdf-lib'); } catch (e) { return { pdf, pages: null, cut: false }; }
  try {
    const 원본 = await lib.PDFDocument.load(pdf, { ignoreEncryption: true });
    const 전체 = 원본.getPageCount(), n = Math.min(전체, 최대쪽());
    if (n >= 전체) return { pdf, pages: 전체, cut: false };
    const 새 = await lib.PDFDocument.create();
    const 쪽들 = await 새.copyPages(원본, [...Array(n).keys()]);
    쪽들.forEach(p => 새.addPage(p));
    return { pdf: Buffer.from(await 새.save()), pages: 전체, cut: n };
  } catch (e) { return { pdf, pages: null, cut: false }; }
}

// AI 답 속 곧은 따옴표(")가 JSON 을 깨뜨렸을 때 고칩니다 (report_blog.js 와 같은 방법)
function 따옴표고치기(t) {
  let 안 = false, 결과 = '', 열림 = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && 안) { 결과 += c + (t[i + 1] || ''); i++; continue; }
    if (c === '"') {
      if (!안) { 안 = true; 열림 = false; 결과 += c; continue; }
      let k = i + 1; while (k < t.length && /\s/.test(t[k])) k++;
      if (k >= t.length || ',:}]'.includes(t[k])) { 안 = false; 결과 += c; }
      else { 결과 += 열림 ? '”' : '“'; 열림 = !열림; }
      continue;
    }
    if (안 && (c === '\n' || c === '\r')) { 결과 += '\\n'; continue; }
    결과 += c;
  }
  return 결과;
}

async function AI읽기(원본pdf) {
  const { pdf, pages, cut } = await 앞쪽만(원본pdf);
  const 키 = 환경('ANTHROPIC_API_KEY');
  if (!키) throw new Error('ANTHROPIC_API_KEY 가 없습니다');
  let 마지막오류 = null, 한번더 = 0, 토큰 = 4000;
  const 차례 = [...모델후보];
  while (차례.length) {
    const model = 차례.shift();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 키, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 토큰,          // temperature 는 넣지 않습니다 — Sonnet 5 부터 받지 않음(400). 토큰은 넉넉히(모자라면 빈 답)
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: 지시 },
        ] }],
      }),
    });
    // ★ 2026-09-30 — AI 쪽이 붐빌 때 빈 답(본문 없음)이 오면 예전에는 'Unexpected end of JSON input' 으로 끝났습니다.
    //   이제 글로 먼저 받아 보고, 비었으면 '다시 될 오류' 로 넘겨 30분 뒤 저절로 다시 시도합니다.
    const 원문 = await r.text();
    let j;
    try { j = JSON.parse(원문); }
    catch (e) {
      if (한번더 < 1) { 한번더++; await 쉬기(5000); 차례.unshift(model); continue; }   // 5초 쉬고 한 번 더
      throw new Error(`AI 응답이 비었거나 잘림 (HTTP ${r.status}) — timeout`);
    }
    if (!r.ok) {
      마지막오류 = (j.error && j.error.message) || String(r.status);
      상태.modelNote = `${new Date().toISOString()} ${model} → ${r.status} ${마지막오류}`.slice(0, 400);   // 왜 다음 모델로 넘어갔나
      if (/model/i.test(마지막오류) || r.status === 404) continue;     // 없는 모델이면 다음 후보
      throw new Error(마지막오류);
    }
    const 글 = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    // 글이 길어 도중에 잘렸으면(max_tokens) 토큰을 늘려 한 번 더
    if (j.stop_reason === 'max_tokens' && 한번더 < 1) { 한번더++; 토큰 = 8000; 차례.unshift(model); continue; }
    const m = 글.match(/\{[\s\S]*\}/);
    let 결과 = null;
    if (m) {
      try { 결과 = JSON.parse(m[0]); }
      catch (e) { try { 결과 = JSON.parse(따옴표고치기(m[0])); } catch (e2) { 결과 = null; } }
    }
    if (!결과) {
      if (한번더 < 1) { 한번더++; 차례.unshift(model); continue; }   // 모양이 깨졌으면 한 번만 다시 쓰게
      throw new Error('AI 답을 읽지 못했습니다(모양이 깨짐)');
    }
    결과._model = model; 결과._pages = pages; 결과._cut = cut;
    결과._tokens = j.usage ? (j.usage.input_tokens || 0) + (j.usage.output_tokens || 0) : null;
    return 결과;
  }
  throw new Error(마지막오류 || 'AI 호출 실패');
}

const 숫자 = v => { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

// ── PDF 한 건 처리 ───────────────────────────────────
async function 처리(메시지, 채널, 재시도) {
  const 문서 = 메시지.document, chat = 메시지.chat;
  const 이름 = 문서.file_name || 'report.pdf';
  if (문서.file_size && 문서.file_size > 최대크기) {
    if (!채널) await 답장(chat.id, 메시지.message_id, `⚠ ${이름}: 20MB 가 넘어 봇이 받을 수 없습니다.`);
    return;
  }
  if (!채널 && !재시도) await 답장(chat.id, 메시지.message_id, `📄 ${이름} 읽는 중… (30초~1분)`);
  const pdf = await 파일받기(문서.file_id);
  const a = await AI읽기(pdf);
  const [code, market] = a.type === '종목' || !a.type ? await 코드찾기(a.name) : [null, null];
  const 목표 = 숫자(a.target);
  let 이전 = 숫자(a.targetPrev), 이전출처 = 이전 != null ? '리포트' : null;
  const epsYear = 숫자(a.epsYear), epsNow = 숫자(a.epsNow);
  let epsPrev = 숫자(a.epsPrev), eps출처 = epsPrev != null ? '리포트' : null;

  // 리포트에 이전 값이 없으면 — 같은 증권사의 그 종목 직전 리포트(봇이 전에 받은 것)와 견줍니다
  const 같은증권사 = (x, y) => String(x || '').replace(/증권|투자|\s/g, '') === String(y || '').replace(/증권|투자|\s/g, '');
  const 전것들 = (읽기().items || []).filter(x =>
    x.id !== `${chat.id}_${메시지.message_id}` && 같은증권사(x.broker, a.broker) &&
    ((code && x.code === code) || (!code && x.name && a.name && x.name.replace(/\s/g, '') === String(a.name).replace(/\s/g, ''))));
  const 직전 = 전것들.sort((x, y) => (x.date + x.postedAt < y.date + y.postedAt ? 1 : -1))[0];
  if (이전 == null && 목표 != null && 직전 && 직전.target != null && 직전.target !== 목표) { 이전 = 직전.target; 이전출처 = '직전 리포트 ' + 직전.date; }
  if (epsPrev == null && epsNow != null && 직전 && 직전.epsNow != null && 직전.epsYear === epsYear && 직전.epsNow !== epsNow) {
    epsPrev = 직전.epsNow; eps출처 = '직전 리포트 ' + 직전.date;
  }
  const 비율 = (지금, 전) => 지금 != null && 전 ? Math.round((지금 / 전 - 1) * 1000) / 10 : null;

  const 항목 = {
    id: `${chat.id}_${메시지.message_id}`,
    date: /^\d{8}$/.test(String(a.date || '')) ? String(a.date) : 한국날(메시지.date),
    postedAt: new Date(메시지.date * 1000).toISOString(),
    fileName: 이름, type: a.type || null,
    name: a.name || null, code, market,
    broker: a.broker || null, author: a.author || null, title: a.title || null,
    opinion: a.opinion || null, target: 목표, tpPrev: 이전, tpPrevFrom: 이전출처,
    tpPct: 비율(목표, 이전),
    epsYear, epsPrev, epsNow, epsFrom: eps출처,
    epsPct: epsPrev > 0 ? 비율(epsNow, epsPrev) : null,
    pages: a._pages, cutPages: a._cut,
    summary: Array.isArray(a.summary) ? a.summary.slice(0, 3).map(String) : [],
    body: a.body ? String(a.body) : '',
    source: '텔레그램 · AI 요약', model: a._model,
  };
  const d = 읽기();
  // 같은 파일을 다시 보내면 예전 요약을 새 것으로 바꿉니다 (한 줄만 남게)
  d.items = (d.items || []).filter(x => x.id !== 항목.id && !(x.fileName && x.fileName === 항목.fileName)).concat(항목);
  쓰기(d);
  상태.done += 1;
  if (!채널) {
    const 목표글 = 목표 ? ` · 목표가 ${목표.toLocaleString('ko-KR')}원${항목.tpPct != null ? ` (${항목.tpPct > 0 ? '▲' : '▼'}${Math.abs(항목.tpPct)}%)` : ''}` : '';
    await 답장(chat.id, 메시지.message_id,
      `✅ ${항목.name || ''} · ${항목.broker || ''}${항목.opinion ? ' · ' + 항목.opinion : ''}${목표글}\n` +
      `「${항목.title || 이름}」\n` +
      (항목.epsPrev != null && 항목.epsNow != null && 항목.epsPrev !== 항목.epsNow
        ? `EPS(${항목.epsYear || ''}) ${항목.epsPrev.toLocaleString('ko-KR')} → ${항목.epsNow.toLocaleString('ko-KR')}` +
          `${항목.epsPct != null ? ` (${항목.epsPct > 0 ? '▲' : '▼'}${Math.abs(항목.epsPct)}%)` : ` (${항목.epsNow > 항목.epsPrev ? '▲' : '▼'})`}` +
          `${항목.epsFrom && 항목.epsFrom !== '리포트' ? ' · ' + 항목.epsFrom + ' 대비' : ''}\n` : '') +
      (항목.tpPrevFrom && 항목.tpPrevFrom !== '리포트' ? `(목표가 이전 값은 ${항목.tpPrevFrom} 기준)\n` : '') +
      `\n` + 항목.summary.map(s => '• ' + s).join('\n') +
      `\n\n${항목.body}\n\n— 리포트 요약 페이지에 올렸습니다 (${항목.date})`);
  }
}

// ── 받기 순서 (한 번에 하나씩) ───────────────────────
const 줄 = [];
// 받은 PDF 는 파일에도 적어 둡니다 — 요약 도중 서버가 재시작돼도 잃어버리지 않게(다시 켜지면 이어서 처리)
function 대기적기(m, 채널) {
  const d = 읽기(); d.pending = d.pending || [];
  const id = `${m.chat.id}_${m.message_id}`;
  if (!d.pending.some(x => x.id === id)) { d.pending.push({ id, m, 채널 }); 쓰기(d); }
}
function 대기지우기(m) {
  const d = 읽기(); const id = `${m.chat.id}_${m.message_id}`;
  if ((d.pending || []).some(x => x.id === id)) { d.pending = d.pending.filter(x => x.id !== id); 쓰기(d); }
}
let 처리중 = false;
// 크레딧 부족·한도 초과·AI 혼잡처럼 '기다리면 풀리는' 실패는 따로 적어 두었다가
// 30분마다 다시 시도합니다. 충전하면 밀린 PDF 가 저절로 요약됩니다(최대 3일, 20번).
const 다시될오류 = /credit|balance|billing|limit|quota|overload|rate|529|503|502|500|timeout|ETIMEDOUT|ECONNRESET|fetch failed|Unexpected end of JSON|비었거나 잘림|모양이 깨짐/i;
function 밀린것저장(m, 채널, 오류) {
  const d = 읽기(); d.retry = d.retry || [];
  const id = `${m.chat.id}_${m.message_id}`, 기존 = d.retry.find(x => x.id === id);
  if (기존) { 기존.tries += 1; 기존.error = 오류; 기존.at = new Date().toISOString(); }
  else d.retry.push({ id, m, 채널, tries: 1, error: 오류, first: new Date().toISOString(), at: new Date().toISOString() });
  d.retry = d.retry.filter(x => x.tries <= 20 && Date.now() - new Date(x.first).getTime() < 3 * 86400e3);
  쓰기(d);
}
function 밀린것지우기(m) {
  const d = 읽기(); const id = `${m.chat.id}_${m.message_id}`;
  if ((d.retry || []).some(x => x.id === id)) { d.retry = d.retry.filter(x => x.id !== id); 쓰기(d); return true; }
  return false;
}

async function 돌리기() {
  if (처리중) return;
  처리중 = true;
  while (줄.length) {
    const [m, 채널, 재시도] = 줄.shift();
    상태.queue = 줄.length;
    try {
      await 처리(m, 채널, 재시도);
      if (밀린것지우기(m) && !채널) await 답장(m.chat.id, m.message_id, '↻ 밀려 있던 리포트를 다시 시도해 요약했습니다.');
    } catch (e) {
      const 오류 = String(e.message || e);
      상태.failed += 1; 상태.lastError = `${new Date().toISOString()} ${오류}`;
      if (다시될오류.test(오류)) {
        밀린것저장(m, 채널, 오류);
        if (!채널 && !재시도) await 답장(m.chat.id, m.message_id,
          `⏸ 지금은 요약하지 못했습니다 (${오류.slice(0, 120)}).\n` +
          `크레딧 충전·한도 문제라면 충전 후 30분 안에 저절로 다시 시도합니다. 바로 하려면 /retry 를 보내 주세요.`);
      } else if (!채널) {
        await 답장(m.chat.id, m.message_id, `⚠ 요약하지 못했습니다: ${오류.slice(0, 200)}`);
      }
    }
    if (!재시도) 대기지우기(m);             // 끝난 뒤에 지웁니다 (도중에 꺼지면 다시 켜질 때 이어서)
    await 쉬기(1500);
  }
  처리중 = false;
}

function 밀린것다시() {
  const d = 읽기();
  for (const x of d.retry || []) if (!줄.some(([m]) => `${m.chat.id}_${m.message_id}` === x.id)) 줄.push([x.m, x.채널, true]);
  돌리기();
  return (d.retry || []).length;
}
setInterval(() => { try { 밀린것다시(); } catch (e) {} }, 30 * 60 * 1000);

async function 듣기() {
  if (!환경('TELEGRAM_BOT_TOKEN')) { 상태.lastError = 'TELEGRAM_BOT_TOKEN 이 .env 에 없습니다'; return; }
  상태.running = true;
  const d = 읽기();
  let offset = d.offset || 0;
  for (const x of d.pending || []) if (x.m) 줄.push([x.m, x.채널]);     // 재시작 전에 못 끝낸 것
  if ((d.pending || []).length) 돌리기();
  for (;;) {
    try {
      const 받은 = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'channel_post'] });
      상태.lastPoll = new Date().toISOString();
      const 허용 = String(환경('REPORT_CHAT_IDS') || '').split(',').map(s => s.trim()).filter(Boolean);
      for (const u of 받은) {
        offset = u.update_id + 1;
        const m = u.message || u.channel_post, 채널 = !!u.channel_post;
        if (!m || !m.chat) continue;
        상태.seenChats[m.chat.id] = { type: m.chat.type, title: m.chat.title || m.chat.username || m.chat.first_name || '', at: new Date().toISOString() };
        const 허락 = 허용.includes(String(m.chat.id));
        const 문서 = m.document;
        // 휴대폰·PC 에 따라 PDF 가 'application/octet-stream' 으로 오기도 해서, 형식과 파일 이름을 둘 다 봅니다
        const PDF다 = 문서 && (/pdf/i.test(문서.mime_type || '') || /\.pdf$/i.test(문서.file_name || ''));
        if (PDF다) {
          if (허락) {
            줄.push([m, 채널]); 대기적기(m, 채널);
            const 앞 = 줄.length - 1 + (처리중 ? 1 : 0);
            if (!채널 && 앞 > 0) await 답장(m.chat.id, m.message_id, `📥 접수했습니다 — 앞에 ${앞}건이 있어 차례로 읽습니다.`);
          }
          else if (!채널) await 답장(m.chat.id, m.message_id, `이 대화방(${m.chat.id})은 아직 허락되지 않았습니다. 서버 .env 의 REPORT_CHAT_IDS 에 이 번호를 넣어 주세요.`);
        } else if (문서 && 허락 && !채널) {
          await 답장(m.chat.id, m.message_id, `PDF 만 읽을 수 있습니다 (받은 파일: ${문서.file_name || '이름 없음'} · ${문서.mime_type || '형식 모름'}).`);
        } else if (!채널 && 허락 && m.text && /^\/retry/.test(m.text)) {
          const n = 밀린것다시();
          await 답장(m.chat.id, m.message_id, n ? `↻ 밀린 리포트 ${n}건을 다시 시도합니다.` : '밀린 리포트가 없습니다.');
        } else if (!채널 && m.text && /^\/(start|id)/.test(m.text)) {
          await 답장(m.chat.id, m.message_id, `이 대화방 번호: ${m.chat.id}\n${허락 ? '✅ 허락됨 — PDF 를 보내 주세요.' : '서버 .env 의 REPORT_CHAT_IDS 에 이 번호를 넣으면 PDF 요약을 시작합니다.'}`);
        }
      }
      if (받은.length) { const x = 읽기(); x.offset = offset; 쓰기(x); }
      돌리기();
    } catch (e) {
      상태.lastError = `${new Date().toISOString()} ${String(e.message || e)}`;
      await 쉬기(15000);
    }
  }
}

module.exports = (app) => {
  setTimeout(듣기, 20 * 1000);

  app.get('/report-bot', (req, res) => {
    const d = 읽기();
    const 부터 = String(req.query.from || '').replace(/\D/g, '');
    res.json({ items: (d.items || []).filter(x => !부터 || x.date >= 부터), generatedAt: new Date().toISOString() });
  });
  app.get('/report-bot/status', (req, res) => {
    const d = 읽기();
    res.json({ ...상태, pending: (d.pending || []).length, retry: (d.retry || []).map(x => ({ id: x.id, file: x.m.document && x.m.document.file_name, tries: x.tries, error: x.error })),
               token: !!환경('TELEGRAM_BOT_TOKEN'), allowed: 환경('REPORT_CHAT_IDS') || '',
               anthropic: !!환경('ANTHROPIC_API_KEY'), stored: (d.items || []).length,
               last: (d.items || []).slice(-1)[0] || null });
  });
};
