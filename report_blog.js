// ═══════════════════════════════════════════════════════════
//  report_blog.js — 그날 리포트를 AI 가 읽고 '해설 글' 로 정리합니다 (블로그용)
//
//    GET /report-blog?d=20260928           그날 글 (없으면 쓰기 시작 → {status:"writing"})
//    GET /report-blog?d=20260928&force=1   다시 쓰기 (하루 3번까지 · 서버 안에서만)
//      서버에서: curl -s "http://127.0.0.1:3000/report-blog?d=20260928&force=1"
//
//  글 모양 — 3줄 요약 → 주제 3개(표 + 해설) → 그 밖의 리포트
//    · 오늘 리포트 + 같은 종목의 최근 10일 리포트를 함께 넘겨 "증권사끼리 어디서 갈리는지" 를 씁니다.
//    · 자료에 없는 숫자·사실은 쓰지 않게 합니다.
//  비용 — 하루 한 번 쓰고 파일에 저장해 둡니다. 누가 몇 번을 열어도 다시 쓰지 않습니다.
//         (Sonnet 5 기준 한 번에 약 50~100원)
//  ★ .env 의 ANTHROPIC_API_KEY 를 씁니다 (이미 있음).
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

const 저장파일 = '/root/app/report_blog.json';
const 봇파일 = '/root/app/report_bot.json';
const 엑셀주소 = 'https://raw.githubusercontent.com/ramgalee/night-dashboard/main/reports.json';
const 모델후보 = ['claude-sonnet-5', 'claude-sonnet-4-5'];
const 하루최대 = 3;

function 환경(이름) {
  if (process.env[이름]) return process.env[이름];
  try {
    const m = fs.readFileSync('/root/app/.env', 'utf8').match(new RegExp('^\\s*' + 이름 + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch (e) { return null; }
}
function 읽기() { try { return JSON.parse(fs.readFileSync(저장파일, 'utf8')); } catch (e) { return {}; } }
function 쓰기(d) {
  const 날들 = Object.keys(d).sort().slice(-40);             // 40일치만 보관
  const 남길 = {}; for (const k of 날들) 남길[k] = d[k];
  fs.writeFileSync(저장파일 + '.tmp', JSON.stringify(남길)); fs.renameSync(저장파일 + '.tmp', 저장파일);
}

// ── 리포트 모으기 (엑셀 reports.json + 텔레그램 봇) ──────
const 같은증권사 = (a, b) => String(a || '').replace(/증권|투자|\s/g, '') === String(b || '').replace(/증권|투자|\s/g, '');
const 같은종목 = (a, b) => a.name && b.name && a.name.replace(/\s/g, '') === b.name.replace(/\s/g, '');
async function 모으기() {
  const 날별 = {};
  try {
    const j = await (await fetch(엑셀주소, { cache: 'no-store' })).json();
    for (const [d, v] of Object.entries(j.days || {})) 날별[d] = (v.reports || []).map(x => ({ ...x }));
  } catch (e) {}
  try {
    const b = JSON.parse(fs.readFileSync(봇파일, 'utf8'));
    for (const x of b.items || []) {
      if (!x.date) continue;
      const a = 날별[x.date] = 날별[x.date] || [];
      const 짝 = a.find(y => 같은종목(x, y) && 같은증권사(x.broker, y.broker));
      if (짝) { for (const k of ['body', 'tpPrev', 'tpPct', 'epsPrev', 'epsNow', 'epsPct', 'epsYear', 'type']) if (짝[k] == null && x[k] != null) 짝[k] = x[k]; }
      else a.push({ ...x });
    }
  } catch (e) {}
  return 날별;
}
const 짧게 = x => ({
  종목: x.name, 종류: x.type || (x.code ? '종목' : null), 증권사: x.broker, 작성자: x.author || undefined,
  제목: x.title, 의견: x.opinion || undefined, 목표가: x.target ?? undefined,
  이전목표가: x.tpPrev ?? undefined, 목표가변화: x.tpPct != null ? x.tpPct + '%' : undefined,
  EPS: x.epsNow != null ? { 연도: x.epsYear, 전: x.epsPrev, 후: x.epsNow } : undefined,
  요약: (x.summary || []).slice(0, 3), 본문: x.body ? String(x.body).slice(0, 600) : undefined,
});

// ── AI 에게 부탁하는 글 모양 ─────────────────────────
const 예시글 = `3줄 요약
삼성전자 목표주가가 35만에서 63만까지 벌어졌습니다
AI 데이터센터가 이번엔 강관과 GPU 클라우드를 끌어올렸습니다
고유가인데 항공주는 걱정 없다는 리포트가 나왔습니다
1. 삼성전자, 나흘 새 네 곳이 갈렸습니다
오늘 두 곳이 추가되면서 그림이 이렇게 됐습니다.
증권사
목표주가
한 줄
유안타증권
630,000원 (상향)
가격 상승폭 둔화보다 사이클 장기화
골드만삭스
490,000원
2027년이 2026년보다 더 타이트
JP모건
400,000원
환율은 단기 리스크
키움증권
350,000원
3분기 기대치 하회 예상
가장 높은 곳과 가장 낮은 곳이 28만원 차이입니다. 거의 두 배입니다.
갈리는 지점이 보입니다
유안타증권은 제목부터 답입니다. “메모리 가격 상승폭 둔화보다 사이클 장기화”. 가격이 얼마나 오르냐보다 이 흐름이 얼마나 오래 가느냐를 봤습니다.
반대로 키움증권은 3분기 영업이익이 기대치를 밑돌 것으로 봤습니다. 다만 업종 최선호주는 유지했습니다.
흥미로운 건 분기 전망도 다르다는 점입니다. 같은 3분기를 두고 유안타는 100조원, 키움은 107조원을 제시했습니다.
어제 정리한 내용과 이어집니다. JP모건은 환율과 주주환원을 단기 악재로 보고, 골드만은 수급 구조에 무게를 뒀습니다. 여기에 오늘 사이클의 길이를 보는 시각과 분기 실적을 보는 시각이 더해진 셈입니다.
방향은 대체로 같은데, 어느 시점의 무엇을 보느냐에서 갈립니다.

2. AI 인프라 목록이 또 길어졌습니다
세아제강 (다올투자증권, 매수 / 목표주가 20만원)
제목이 “강관 병목 발생 중”입니다.
미국에서 데이터센터와 LNG터미널 수요가 늘면서 강관 판매량이 증가하고 있고, 리드타임이 늘어나면서 가격도 오르는 중입니다. 미국 열연 가격 상승도 겹쳤습니다.
환율이 내렸는데도 수출 판가 상승세가 이어지고 있다는 점이 눈에 띕니다.

엘리스그룹 (리포트 3개 동시)- 해외
유진투자증권, NH투자증권, DB증권이 같은 날 냈습니다. AI PMDC 기반 GPU 클라우드 기업입니다.
수도권과 호남에 AI PMDC 12동 증설이 예정돼 있고, 정부 주도 AI 인프라 확충 정책의 직접 수혜로 봤습니다. AI 교육 사업에서 클라우드 인프라로 확장하는 중입니다.
목록이 이렇게 쌓였습니다
그동안 정리해온 AI 데이터센터 관련 품목입니다.
전력(가스터빈·연료전지) → 냉각(칠러·CDU) → 광통신 → 기판 소재(CCL) → 비상발전기 → 강관 → GPU 클라우드
데이터센터 하나 지으면 딸려 들어가는 목록이 계속 길어지고 있습니다.

3. 고유가인데 항공주는 괜찮다?
대한항공 리포트가 두 곳에서 나왔습니다.
증권사
목표주가
핵심
KB증권
42,000원 (5% 상향)
2027년 영업이익 159% 증가 예상
하나증권
41,000원
“유가 걱정은 마세요”
근거가 뭘까
세 가지입니다. 해외 발권 항공권 가격 인상, 화물 수요 초과 지속, 그리고 아시아나항공 손익 개선입니다.
KB증권이 덧붙인 단서가 인상적입니다. 지금 전망 자체가 고환율·고유가·고금리를 가정하고 만든 것이라, 이 조건이 완화되면 추가 상향 여지가 있다는 겁니다.

며칠 전과 대비됩니다
같은 유가를 두고 하나투어는 “인고의 시기”라며 유류할증료 상승으로 여행 심리가 약해진다고 했습니다. 오늘 대한항공은 “유가 걱정은 마세요”입니다.
차이는 가격 전가력입니다. 항공사는 운임을 올릴 수 있고, 여행사는 올라간 값을 고객에게 설득해야 합니다. 같은 업종군이라도 누가 가격을 정하느냐에 따라 갈립니다.
나머지는 한 줄씩
종목
핵심
증권사 / 목표주가
삼성전기
CPU 아래엔 ABF, 옆엔 MLCC. 환율을 이기는 업황
메리츠 / 220만원
삼성물산
10월 가시화될 할인율 축소, 기대치 상회할 배당
SK / 55만원
파두
3분기 매출 +376%, 컨센서스 상회 전망
유진 / 11만원
CJ
3분기 영업이익 +13%, 하반기 추세적 반전
흥국 / 18만원
현대백화점
지누스 회복, 연결 실적 턴어라운드
NH / 17만원
휴젤
미국 직접 판매 체제 전환, 목표가 하향
대신 / 34만원
티앤엘
3분기 영업이익 +35%, 12개월 선행 PER 7배
하나
우리넷
통신사 레퍼런스 기반 양자암호 생태계 주축
하나 / 2.5만원
인바디
GLP-1 애프터케어 시장 개화, 미국 병원향 매출
한국투자
채비
민간 급속충전 1위, 로보택시엔 급속충전 필수
한국투자
티로보틱스
기존 사업 회복 + 휴머노이드 신사업
SK증권
포스코퓨처엠에 실제 수주가 나왔습니다. SK온향 LFP 양극재 1조 742억원, 2027년부터 3년간 공급입니다. SK온 LFP 조달 물량의 87%를 가져왔습니다.
며칠 전 이 종목을 두고 시각이 갈렸던 걸 정리했는데(다올 매수 29만원 vs NH 중립 18만원), 당시 다올이 단기 촉매로 꼽았던 LFP 수주가 실제로 나온 경우입니다.
LG생활건강은 두 곳 다 3분기 부진을 봤습니다. NH투자증권은 중립으로 “비움의 미학”, 한국투자증권은 매수지만 “밋밋한 실적이 아쉬울 뿐”입니다. 의견은 갈렸는데 실적 전망은 같습니다.

본 글은 증권사 리서치 자료를 요약한 것으로, 투자의견과 목표주가는 해당 증권사의 견해입니다. 매매를 권유하는 글이 아니며 투자 판단의 책임은 본인에게 있습니다.
#삼성전자 #삼성전자목표주가 #세아제강 #엘리스그룹 #AI데이터센터 #대한항공 #항공주 #포스코퓨처엠 #LFP #삼성전기 #삼성물산 #파두 #휴젤 #우리넷 #증권사리포트 #주식공부 #국내주식`;

const 지시 = `당신은 증권 블로그에 매일 아침 '리포트 핵심' 글을 쓰는 작가입니다. [오늘 리포트] 와 [최근 10일 같은 종목 리포트], [최근에 쓴 글] 만 근거로 씁니다.
아래 [예시 글] 과 같은 모양·말투로 쓰세요. 예시의 내용(종목·숫자)은 절대 가져오지 마세요.

글 짜임:
1) summary3 — 오늘 가장 눈에 띄는 이야기 3개를 한 문장씩. 숫자를 넣고 '~습니다' 로 끝냅니다.
2) sections — summary3 순서대로 주제 3개.
   - heading: 짧고 궁금해지는 제목 (예시: "삼성전자, 나흘 새 네 곳이 갈렸습니다", "고유가인데 항공주는 괜찮다?")
   - lead: 한 문장 도입 (없으면 "")
   - tableHead: 표 셋째 칸 이름 ("한 줄" 또는 "핵심")
   - table: 같은 종목을 다룬 증권사가 2곳 이상이면 표로. 최근 10일 리포트도 넣습니다.
            각 줄 {"broker","target" (예: "630,000원 (상향)", "42,000원 (5% 상향)", 없으면 "-"),"line" (25자 안팎)}. 한 곳뿐이면 [].
   - blocks: 작은 제목이 붙은 문단 묶음 1~4개. {"sub": 작은 제목 또는 "", "paragraphs": [문단들]}
            작은 제목 예: "갈리는 지점이 보입니다", "근거가 뭘까", "며칠 전과 대비됩니다", "목록이 이렇게 쌓였습니다",
            또는 종목 하나를 소개할 때 "세아제강 (다올투자증권, 매수 / 목표주가 20만원)" 처럼.
            증권사끼리 어디서 같고 어디서 갈리는지, 숫자 차이(가장 높은 곳과 낮은 곳의 차이, 몇 배), 근거를 씁니다.
            [최근에 쓴 글] 과 이어지면 "어제 정리한 내용과 이어집니다" 처럼 짚어 줍니다 (실제로 그 글에 있는 내용만).
            중요한 말은 **굵게**.
3) others — "나머지는 한 줄씩" 표. 위 주제에 안 들어간 종목 리포트 8~14개.
   {"name","line" (핵심 한 줄, 25자 안팎),"broker" (짧게: 메리츠, 유진, 한국투자),"target" (짧게: "220만원", "2.5만원", 없으면 "")}
4) notes — 표만으로 아쉬운 종목 1~2개를 한 문단씩 (예시의 포스코퓨처엠·LG생활건강 문단처럼). 없으면 [].
5) tags — 해시태그 12~17개 (# 없이). 오늘 다룬 종목·주제 + "증권사리포트","주식공부","국내주식".
6) title — 글 제목 (예: "9월 28일 오늘 아침 리포트 핵심 3가지").

규칙:
- 자료에 없는 숫자·사실·전망은 절대 지어내지 마세요. 계산은 자료 숫자로만.
- 매수·매도를 권하지 마세요. 리포트가 이렇게 봤다고만 씁니다.
- 문장은 짧게, '~습니다/~입니다' 체. 영어 리포트는 한국어로 옮깁니다. 해외 종목은 이름 뒤에 "- 해외" 를 붙입니다.
- 글 안에서 인용할 때는 반드시 둥근 따옴표 “ ” 를 쓰세요. 곧은 따옴표(\")는 JSON 을 깨뜨립니다.
- 아래 JSON 한 개만 출력하세요. 다른 말은 쓰지 마세요.
{"title":"","summary3":["","",""],
 "sections":[{"heading":"","lead":"","tableHead":"한 줄","table":[{"broker":"","target":"","line":""}],"blocks":[{"sub":"","paragraphs":[""]}]}],
 "others":[{"name":"","line":"","broker":"","target":""}],"notes":[""],"tags":[""]}

[예시 글]
${예시글}`;

// 문장 속 곧은 따옴표(")가 JSON 을 깨뜨렸을 때 고칩니다 —
//   문자열 안에서 만난 " 뒤에 , : } ] 가 오지 않으면 '글자 속 따옴표' 로 보고 “ 로 바꿉니다
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

async function AI쓰기(날, 오늘, 최근, 지난글) {
  const 키 = 환경('ANTHROPIC_API_KEY');
  if (!키) throw new Error('ANTHROPIC_API_KEY 가 없습니다');
  const 자료 = `[날짜] ${날}\n\n[오늘 리포트 ${오늘.length}건]\n${JSON.stringify(오늘.map(짧게))}\n\n` +
               `[최근 10일 같은 종목 리포트]\n${JSON.stringify(최근.map(x => ({ 날짜: x.date, ...짧게(x), 본문: undefined })))}\n\n` +
               `[최근에 쓴 글]\n${JSON.stringify(지난글)}`;
  let 마지막 = null, 재시도 = 0;
  const 모델들 = [...모델후보];
  while (모델들.length) {
    const model = 모델들.shift();
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 키, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 8000,       // temperature 는 넣지 않습니다 (Sonnet 5 는 받지 않음)
        messages: [{ role: 'user', content: 지시 + '\n\n' + 자료 }] }),
    });
    const j = await r.json();
    if (!r.ok) { 마지막 = (j.error && j.error.message) || String(r.status); if (/model/i.test(마지막) || r.status === 404) continue; throw new Error(마지막); }
    const 글 = (j.content || []).filter(x => x.type === 'text').map(x => x.text).join('');
    const m = 글.match(/\{[\s\S]*\}/);
    if (!m) { 마지막 = '빈 답 또는 JSON 아님'; continue; }
    let post;
    try { post = JSON.parse(m[0]); }
    catch (e) {
      try { post = JSON.parse(따옴표고치기(m[0])); }
      catch (e2) { 마지막 = 'AI 답을 읽지 못함: ' + e.message; if (++재시도 <= 1) { 모델들.unshift(model); continue; } throw new Error(마지막); }
    }
    return { post, model, tokens: j.usage ? (j.usage.input_tokens || 0) + (j.usage.output_tokens || 0) : null };
  }
  throw new Error(마지막 || 'AI 호출 실패');
}

const 쓰는중 = new Map();
async function 쓰기시작(날) {
  if (쓰는중.has(날)) return 쓰는중.get(날);
  const p = (async () => {
    const 날별 = await 모으기();
    const 오늘 = 날별[날] || [];
    if (!오늘.length) throw new Error('이 날은 리포트가 없습니다');
    const 이름들 = new Set(오늘.map(x => String(x.name || '').replace(/\s/g, '')).filter(Boolean));
    const 앞날 = Object.keys(날별).filter(d => d < 날).sort().slice(-10);
    const 최근 = 앞날.flatMap(d => (날별[d] || []).filter(x => 이름들.has(String(x.name || '').replace(/\s/g, ''))).map(x => ({ ...x, date: x.date || d })));
    const 저장 = 읽기();
    const 지난글 = Object.keys(저장).filter(k => k < 날 && 저장[k].post).sort().slice(-5).map(k => ({
      날짜: k, 요약: 저장[k].post.summary3, 주제: (저장[k].post.sections || []).map(x => ({ 제목: x.heading,
        내용: (x.blocks || []).flatMap(b => b.paragraphs || []).join(' ').slice(0, 400) })) }));
    const 결과 = await AI쓰기(날, 오늘, 최근, 지난글);
    const d = 읽기();
    const 전 = d[날] || {};
    d[날] = { date: 날, at: new Date().toISOString(), count: 오늘.length, tries: (전.tries || 0) + 1,
              model: 결과.model, tokens: 결과.tokens, post: 결과.post, error: null };
    쓰기(d);
    return d[날];
  })().catch(e => {
    const d = 읽기(); d[날] = { ...(d[날] || {}), date: 날, error: String(e.message || e), errAt: new Date().toISOString() }; 쓰기(d);
    throw e;
  }).finally(() => 쓰는중.delete(날));
  쓰는중.set(날, p);
  return p;
}

module.exports = (app) => {
  app.get('/report-blog', async (req, res) => {
    const 날 = String(req.query.d || '').replace(/\D/g, '');
    if (!/^\d{8}$/.test(날)) return res.status(400).json({ error: '?d=YYYYMMDD 로 날짜를 주세요' });
    // 다시 쓰기는 서버 안(127.0.0.1)에서 부를 때만 — 화면(회원)에서는 못 부릅니다
    const 안에서 = /^(::1|127\.0\.0\.1|::ffff:127\.0\.0\.1)$/.test(req.ip || (req.socket && req.socket.remoteAddress) || '');
    const 다시 = req.query.force === '1' && 안에서;
    const x = 읽기()[날];
    if (쓰는중.has(날)) return res.json({ date: 날, status: 'writing' });
    if (x && x.post && !다시) return res.json({ ...x, status: 'done', left: Math.max(0, 하루최대 - (x.tries || 0)) });
    // 방금(10분 안) 실패했으면 다시 부르지 않고 오류를 알려 줍니다 — 열 때마다 AI 를 부르지 않게
    if (x && x.error && !다시 && x.errAt && Date.now() - new Date(x.errAt).getTime() < 10 * 60 * 1000)
      return res.json({ date: 날, status: 'error', error: x.error, post: x.post || null });
    if (다시 && x && (x.tries || 0) >= 하루최대)
      return res.json({ ...x, status: 'done', left: 0, note: `다시 쓰기는 하루 ${하루최대}번까지입니다` });
    쓰기시작(날).catch(() => {});
    res.json({ date: 날, status: 'writing' });
  });
  app.get('/report-blog/status', (req, res) => {
    const d = 읽기();
    res.json({ writing: [...쓰는중.keys()], days: Object.values(d).map(x => ({ date: x.date, count: x.count, tries: x.tries, model: x.model, tokens: x.tokens, error: x.error })) });
  });
};
