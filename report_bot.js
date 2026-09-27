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
 "summary": [핵심 3줄. 각 줄 60자 안팎, 숫자 근거 포함],
 "body": 본문 요약 5~8문장. 실적 전망·투자 포인트·리스크를 리포트에 적힌 내용만으로
}
규칙: 리포트에 없는 내용·숫자는 지어내지 마세요. 확실하지 않은 칸은 null. 한국어로.`;

async function AI읽기(pdf) {
  const 키 = 환경('ANTHROPIC_API_KEY');
  if (!키) throw new Error('ANTHROPIC_API_KEY 가 없습니다');
  let 마지막오류 = null;
  for (const model of 모델후보) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 키, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model, max_tokens: 1500, temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
          { type: 'text', text: 지시 },
        ] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) {
      마지막오류 = (j.error && j.error.message) || String(r.status);
      if (/model/i.test(마지막오류) || r.status === 404) continue;     // 없는 모델이면 다음 후보
      throw new Error(마지막오류);
    }
    const 글 = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    const m = 글.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('AI 답이 JSON 이 아닙니다');
    const 결과 = JSON.parse(m[0]);
    결과._model = model;
    결과._tokens = j.usage ? (j.usage.input_tokens || 0) + (j.usage.output_tokens || 0) : null;
    return 결과;
  }
  throw new Error(마지막오류 || 'AI 호출 실패');
}

const 숫자 = v => { const n = Number(String(v ?? '').replace(/[^\d.\-]/g, '')); return v == null || v === '' || !Number.isFinite(n) ? null : n; };

// ── PDF 한 건 처리 ───────────────────────────────────
async function 처리(메시지, 채널) {
  const 문서 = 메시지.document, chat = 메시지.chat;
  const 이름 = 문서.file_name || 'report.pdf';
  if (문서.file_size && 문서.file_size > 최대크기) {
    if (!채널) await 답장(chat.id, 메시지.message_id, `⚠ ${이름}: 20MB 가 넘어 봇이 받을 수 없습니다.`);
    return;
  }
  if (!채널) await 답장(chat.id, 메시지.message_id, `📄 ${이름} 읽는 중… (30초~1분)`);
  const pdf = await 파일받기(문서.file_id);
  const a = await AI읽기(pdf);
  const [code, market] = a.type === '종목' || !a.type ? await 코드찾기(a.name) : [null, null];
  const 목표 = 숫자(a.target), 이전 = 숫자(a.targetPrev);
  const 항목 = {
    id: `${chat.id}_${메시지.message_id}`,
    date: /^\d{8}$/.test(String(a.date || '')) ? String(a.date) : 한국날(메시지.date),
    postedAt: new Date(메시지.date * 1000).toISOString(),
    fileName: 이름, type: a.type || null,
    name: a.name || null, code, market,
    broker: a.broker || null, author: a.author || null, title: a.title || null,
    opinion: a.opinion || null, target: 목표, tpPrev: 이전,
    tpPct: 목표 && 이전 ? Math.round((목표 / 이전 - 1) * 1000) / 10 : null,
    summary: Array.isArray(a.summary) ? a.summary.slice(0, 3).map(String) : [],
    body: a.body ? String(a.body) : '',
    source: '텔레그램 · AI 요약', model: a._model,
  };
  const d = 읽기();
  d.items = (d.items || []).filter(x => x.id !== 항목.id).concat(항목);
  쓰기(d);
  상태.done += 1;
  if (!채널) {
    const 목표글 = 목표 ? ` · 목표가 ${목표.toLocaleString('ko-KR')}원${항목.tpPct != null ? ` (${항목.tpPct > 0 ? '▲' : '▼'}${Math.abs(항목.tpPct)}%)` : ''}` : '';
    await 답장(chat.id, 메시지.message_id,
      `✅ ${항목.name || ''} · ${항목.broker || ''}${항목.opinion ? ' · ' + 항목.opinion : ''}${목표글}\n` +
      `「${항목.title || 이름}」\n\n` + 항목.summary.map(s => '• ' + s).join('\n') +
      `\n\n${항목.body}\n\n— 리포트 요약 페이지에 올렸습니다 (${항목.date})`);
  }
}

// ── 받기 순서 (한 번에 하나씩) ───────────────────────
const 줄 = [];
let 처리중 = false;
async function 돌리기() {
  if (처리중) return;
  처리중 = true;
  while (줄.length) {
    const [m, 채널] = 줄.shift();
    상태.queue = 줄.length;
    try { await 처리(m, 채널); }
    catch (e) {
      상태.failed += 1; 상태.lastError = `${new Date().toISOString()} ${String(e.message || e)}`;
      if (!채널) await 답장(m.chat.id, m.message_id, `⚠ 요약하지 못했습니다: ${String(e.message || e).slice(0, 200)}`);
    }
    await 쉬기(1500);
  }
  처리중 = false;
}

async function 듣기() {
  if (!환경('TELEGRAM_BOT_TOKEN')) { 상태.lastError = 'TELEGRAM_BOT_TOKEN 이 .env 에 없습니다'; return; }
  상태.running = true;
  const d = 읽기();
  let offset = d.offset || 0;
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
        if (문서 && /pdf$/i.test(문서.mime_type || 문서.file_name || '')) {
          if (허락) 줄.push([m, 채널]);
          else if (!채널) await 답장(m.chat.id, m.message_id, `이 대화방(${m.chat.id})은 아직 허락되지 않았습니다. 서버 .env 의 REPORT_CHAT_IDS 에 이 번호를 넣어 주세요.`);
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
    res.json({ ...상태, token: !!환경('TELEGRAM_BOT_TOKEN'), allowed: 환경('REPORT_CHAT_IDS') || '',
               anthropic: !!환경('ANTHROPIC_API_KEY'), stored: (d.items || []).length,
               last: (d.items || []).slice(-1)[0] || null });
  });
};
