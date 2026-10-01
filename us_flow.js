// 미국 업종별 등락 · ETF 자금 흐름
//   GET /us-sectors        업종 11개 + 참고 지수
//   GET /us-flow           주요 ETF 자금 유출입
//   GET /us-flow/probe     두 갈래가 살아 있는지 확인용
//
// 업종은 섹터 ETF 로 봅니다. 미국은 업종 지수를 공짜로 주는 곳이 마땅치 않은데,
// 섹터 ETF 가 그 업종을 그대로 담고 있어 등락률이 사실상 같습니다.
//
// ── 자금 유출입을 두 갈래로 구합니다 ─────────────────
//
//  1) 정확  — iShares 공시 (EWY · EEM · IEMG)
//     운용사가 매일 상장주식수를 공시합니다. 주식수가 늘면 새 돈이 들어온 것이고
//     줄면 나간 것입니다. 가격과 무관하게 딱 떨어집니다.
//         유출입 = (오늘 주식수 − 어제 주식수) × 오늘 NAV
//     상장주식수는 설정단위(보통 5만 주) 로만 움직여서 변화가 0 인 날이 자주 있습니다.
//     고장이 아니라 그날 신규 설정·환매가 없었다는 뜻입니다.
//
//  1-2) 정확 — State Street 공시 (SPY · 섹터 SPDR 11개)
//     설정일부터의 NAV · 상장주식수를 엑셀로 받아 같은 방식으로 셉니다. 과거까지 바로 나옵니다.
//
//  1-3) 정확 — 운용사 직접 공시 (QQQ 인베스코 · SMH 반에크 · DRAM 라운드힐) — 10/1 추가, 아래 '운용사' 참고
//     이틀치가 쌓이기 전에는 아래 추정으로 보여 줍니다.
//
//  2) 추정  — 야후 순자산 (나머지)
//     운용사마다 공시 형식이 달라 전부 읽으려면 파서가 다섯 개 필요합니다.
//     그래서 나머지는 순자산에서 가격 상승분을 빼는 표준 추정식을 씁니다.
//         유출입 = 오늘 순자산 − 어제 순자산 × (1 + 오늘 등락률)
//     야후는 쿠키와 임시 열쇠(crumb) 를 받아야 순자산을 내줍니다.
//
//     ★ 야후 순자산은 며칠 묵은 값일 때가 있습니다. 갱신이 멈춘 구간에서
//       위 식을 그대로 쓰면 없던 자금 유출입이 만들어집니다.
//       (순자산 그대로 + 가격 +3% → 순자산의 3% 가 유출로 계산됨)
//       그래서 어제와 순자산이 한 푼도 다르지 않으면 계산하지 않고 '미갱신' 으로 둡니다.
const fs = require('fs');

const 신선 = 5 * 60 * 1000;
const 자금파일 = '/root/app/us_flow_history.json';
// kr_etf_flow.js 가 모아둔 iShares 날짜별 보유내역 (EWY · IEMG · EEM 의 상장주식수가 들어 있음)
const 보유파일 = '/root/app/kr_etf_history.json';

function 보유읽기() {
  try { return JSON.parse(fs.readFileSync(보유파일, 'utf8')); } catch (e) { return null; }
}
const ymd = 날 => String(날 || '').replace(/-/g, '');
const 대시 = d => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// 기준일보다 앞선 가장 최근 상장주식수
function 보유앞날(보유, 기호, 날) {
  const days = 보유 && 보유[기호] && 보유[기호].days;
  if (!days) return null;
  const 기준 = ymd(날);
  const 앞 = Object.keys(days).filter(d => d < 기준 && days[d] && days[d].sh).sort().pop();
  return 앞 ? { date: 대시(앞), sh: days[앞].sh } : null;
}

// 최근 n 거래일 누적 유출입 (달러) — 날마다 (주식수 변화 × 그날 NAV) 를 더합니다
function 보유누적(보유, 기호, n) {
  const days = 보유 && 보유[기호] && 보유[기호].days;
  if (!days) return null;
  const 날들 = Object.keys(days).filter(d => days[d] && days[d].sh && days[d].mv).sort();
  if (날들.length < 2) return null;
  const 끝 = 날들.slice(-(n + 1));
  let 합 = 0;
  for (let i = 1; i < 끝.length; i++) {
    const a = days[끝[i - 1]], b = days[끝[i]];
    합 += (b.sh - a.sh) * (b.mv / b.sh);
  }
  return { usd: Math.round(합), days: 끝.length - 1, to: 끝[끝.length - 1] };
}
const 보관일수 = 400;

// ── 업종 11개 (+ 참고) ───────────────────────────────
const 업종들 = [
  ['XLK', '기술', 'tech'],
  ['XLC', '커뮤니케이션', 'comm'],
  ['XLY', '경기소비재', 'disc'],
  ['XLF', '금융', 'fin'],
  ['XLV', '헬스케어', 'health'],
  ['XLI', '산업재', 'indu'],
  ['XLP', '필수소비재', 'staple'],
  ['XLE', '에너지', 'energy'],
  ['XLU', '유틸리티', 'util'],
  ['XLB', '소재', 'mat'],
  ['XLRE', '리츠·부동산', 'reit'],
];
const 참고들 = [
  ['SMH', '반도체'],
  ['SPY', 'S&P500'],
  ['QQQ', '나스닥100'],
  ['IWM', '러셀2000'],
];

// ── 자금 흐름을 볼 ETF ───────────────────────────────
//   iShares 쪽은 정확, 나머지는 추정입니다.
const 자금ETF = [
  ['EWY', '한국', '외국인이 한국을 어떻게 보는지'],
  ['EEM', '신흥국', 'MSCI 신흥국'],
  ['IEMG', '신흥국(코어)', 'EEM 보다 덩치가 큽니다'],
  ['DRAM', '메모리 반도체', '삼성전자·SK하이닉스 비중이 높습니다'],
  ['SMH', '반도체', '엔비디아·TSMC 중심'],
  ['SPY', 'S&P500', ''],
  ['QQQ', '나스닥100', ''],
  ['XLK', '미국 기술', ''],
];

// iShares 공시를 읽을 종목 — [상품번호, 주소이름]
const 아이셰어즈 = {
  EWY: ['239681', 'ishares-msci-south-korea-etf'],
  EEM: ['239637', 'ishares-msci-emerging-markets-etf'],
  IEMG: ['244050', 'ishares-core-msci-emerging-markets-etf'],
};

const 머리 = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
};

async function 가져오기(주소, 초 = 12) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 초 * 1000);
  try {
    const r = await fetch(주소, { signal: ac.signal, headers: 머리 });
    if (!r.ok) throw new Error(r.status + '');
    return await r.json();
  } finally { clearTimeout(시계); }
}

async function 글가져오기(주소, 더할머리, 초 = 20) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 초 * 1000);
  try {
    const r = await fetch(주소, { signal: ac.signal, headers: { ...머리, ...(더할머리 || {}) } });
    if (!r.ok) throw new Error(r.status + '');
    return await r.text();
  } finally { clearTimeout(시계); }
}

async function 시세(기호) {
  const j = await 가져오기(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(기호)}?range=5d&interval=1d`);
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error('빈 결과');
  const m = r.meta || {};
  const 종가들 = ((r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}).close || [];
  const 값 = 종가들.filter(v => v != null);
  const 지금 = m.regularMarketPrice ?? 값[값.length - 1];
  // ★ 2026-09-29 고침 — range=5d 에서 chartPreviousClose 는 '어제 종가' 가 아니라 '5일 전 종가' 입니다.
  //   그래서 등락률이 5일 등락률로 나왔습니다(반도체 SMH 가 하락한 날 +0.67% 로 표시).
  //   이제 일봉 목록에서 전날 종가를 직접 찾습니다. 마지막 봉이 오늘(마지막 체결일) 봉이면 한 칸 앞이 전날입니다.
  const 시각들 = r.timestamp || [];
  const 봉 = 시각들.map((t, i) => [t, 종가들[i]]).filter(([t, c]) => t != null && c != null);
  let 전날 = null;
  if (봉.length) {
    const [끝시각, 끝값] = 봉[봉.length - 1];
    const 오늘봉 = m.regularMarketTime
      ? Math.abs(m.regularMarketTime - 끝시각) < 20 * 3600
      : (지금 != null && Math.abs(끝값 - 지금) < Math.abs(지금) * 1e-6);
    전날 = 오늘봉 ? (봉.length >= 2 ? 봉[봉.length - 2][1] : null) : 끝값;
  }
  if (전날 == null) 전날 = m.previousClose ?? null;
  return {
    price: 지금 == null ? null : Number(지금),
    prev: 전날 == null ? null : Number(전날),
    changePct: (지금 != null && 전날) ? (지금 / 전날 - 1) * 100 : null,
    volume: m.regularMarketVolume ?? null,
    date: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString().slice(0, 10) : null,
    closes: 값.slice(-5),
  };
}

// ── 야후 열쇠 (쿠키 + crumb) ─────────────────────────
//   fc.yahoo.com 은 404 를 돌려주지만 쿠키는 심어줍니다. 그게 정상입니다.
//   열쇠는 한동안 살아 있으므로 여섯 시간마다만 새로 받습니다.
const 열쇠 = { 쿠키: null, 크럼: null, at: 0 };

async function 열쇠받기(다시) {
  if (!다시 && 열쇠.크럼 && Date.now() - 열쇠.at < 6 * 3600 * 1000) return 열쇠;
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 15000);
  try {
    const r = await fetch('https://fc.yahoo.com/', { signal: ac.signal, headers: 머리, redirect: 'manual' });
    let 조각 = [];
    try { 조각 = r.headers.getSetCookie ? r.headers.getSetCookie() : []; } catch (e) {}
    if (!조각.length) {
      const 한줄 = r.headers.get('set-cookie');
      if (한줄) 조각 = [한줄];
    }
    열쇠.쿠키 = 조각.map(s => String(s).split(';')[0]).filter(Boolean).join('; ') || null;
  } catch (e) {
    열쇠.쿠키 = null;
  } finally { clearTimeout(시계); }

  try {
    const t = await 글가져오기(
      'https://query1.finance.yahoo.com/v1/test/getcrumb',
      열쇠.쿠키 ? { Cookie: 열쇠.쿠키 } : {}, 12);
    const c = String(t || '').trim();
    // 열쇠는 짧은 글자입니다. 오류 페이지가 오면 길거나 < 로 시작합니다.
    열쇠.크럼 = (c && c.length <= 32 && !c.startsWith('<')) ? c : null;
  } catch (e) {
    열쇠.크럼 = null;
  }
  열쇠.at = Date.now();
  return 열쇠;
}

// 야후 순자산 — 열쇠가 상하면 한 번만 다시 받아 재시도합니다
async function 순자산(기호, 다시함) {
  const k = await 열쇠받기(false);
  if (!k.크럼) return null;
  const 주소 = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(기호)}`
    + `?modules=defaultKeyStatistics&crumb=${encodeURIComponent(k.크럼)}`;
  try {
    const t = await 글가져오기(주소, k.쿠키 ? { Cookie: k.쿠키 } : {}, 12);
    const j = JSON.parse(t);
    const d = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    const v = d?.totalAssets?.raw ?? d?.totalAssets;
    if (typeof v === 'number' && v > 0) return v;
    return null;
  } catch (e) {
    if (!다시함) {                       // 열쇠가 상했을 수 있으니 한 번만 새로 받아 다시
      await 열쇠받기(true);
      return 순자산(기호, true);
    }
    return null;
  }
}

// ── iShares 공시 ─────────────────────────────────────
//   상품 페이지 안에 KeyFundFactsV3 라는 덩어리가 박혀 있고,
//   그 안에 상장주식수와 순자산이 기준일과 함께 들어 있습니다.
function 숫자로(s) {
  const n = Number(String(s == null ? '' : s).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function 덩어리에서(본문, 이름) {
  // 따옴표가 &quot; 로 바뀌어 있기도 하고 그냥 " 이기도 합니다. 둘 다 봅니다.
  for (const q of ['&quot;', '"']) {
    const 끝 = 본문.indexOf(`${q}name${q}:${q}${이름}${q}`);
    if (끝 < 0) continue;
    const 앞 = 본문.slice(Math.max(0, 끝 - 1200), 끝);
    const 값표 = `${q}formattedValue${q}:${q}`;
    const 날표 = `${q}formattedAsOfDate${q}:${q}`;
    const i = 앞.lastIndexOf(값표);
    if (i < 0) continue;
    const 값 = 앞.slice(i + 값표.length, 앞.indexOf(q, i + 값표.length));
    let 날 = null;
    const j = 앞.lastIndexOf(날표);
    if (j >= 0) 날 = 앞.slice(j + 날표.length, 앞.indexOf(q, j + 날표.length));
    return { value: 숫자로(값), asOf: 날 || null };
  }
  return null;
}

async function 아이셰어즈받기(기호) {
  const 짝 = 아이셰어즈[기호];
  if (!짝) return null;
  const 본문 = await 글가져오기(
    `https://www.ishares.com/us/products/${짝[0]}/${짝[1]}`,
    { Accept: 'text/html' }, 20);
  const 주식수 = 덩어리에서(본문, 'sharesOutstanding');
  const 순 = 덩어리에서(본문, 'totalNetAssetsFundLevel');
  if (!주식수 || !주식수.value) return null;
  const nav = (순 && 순.value && 주식수.value) ? 순.value / 주식수.value : null;
  return { shares: 주식수.value, netAssets: 순 ? 순.value : null, nav, asOf: 주식수.asOf || null };
}

// ── State Street 공시 (SPY · 섹터 SPDR 11개) ─────────────
//   운용사가 설정일부터의 NAV · 상장주식수를 엑셀로 공개합니다.
//     https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-<티커>.xlsx
//   서버가 뜨고 1분 뒤, 그다음 6시간마다 받아 /root/app/ssga_nav.json 에 저장합니다.
//   유출입 = (그날 상장주식수 − 전날 상장주식수) × 그날 NAV  — iShares 와 같은 정확한 방식
const zlib = require('zlib');
const 스테이트 = ['SPY', 'XLK', 'XLC', 'XLY', 'XLF', 'XLV', 'XLI', 'XLP', 'XLE', 'XLU', 'XLB', 'XLRE'];
const 스테이트파일 = '/root/app/ssga_nav.json';
const 스테이트보관 = 400;
const 스테이트주소 = t =>
  `https://www.ssga.com/library-content/products/fund-data/etfs/us/navhist-us-en-${t.toLowerCase()}.xlsx`;

// 엑셀(.xlsx) 읽기 — 설치 없이 zlib 만 씁니다. xlsx 는 zip 안에 xml 이 든 파일입니다.
function zip풀기(buf) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('엑셀 파일이 아님');
  const 개수 = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const 파일 = {};
  for (let i = 0; i < 개수; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const 방식 = buf.readUInt16LE(p + 10), 크기 = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    const 위치 = buf.readUInt32LE(p + 42);
    const 이름 = buf.slice(p + 46, p + 46 + n).toString('utf8');
    p += 46 + n + x + c;
    const ln = buf.readUInt16LE(위치 + 26), lx = buf.readUInt16LE(위치 + 28);
    const 몸 = buf.slice(위치 + 30 + ln + lx, 위치 + 30 + ln + lx + 크기);
    파일[이름] = 방식 === 8 ? zlib.inflateRawSync(몸) : 몸;
  }
  return 파일;
}
const 엑셀풀이 = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
function 엑셀읽기(buf) {
  const f = zip풀기(buf);
  const 공유 = [];
  if (f['xl/sharedStrings.xml']) {
    for (const m of f['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      공유.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => 엑셀풀이(x[1])).join(''));
    }
  }
  const 시트 = Object.keys(f).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!시트) throw new Error('시트가 없음');
  const 열번호 = r => { let n = 0; for (const ch of r.match(/^[A-Z]+/)[0]) n = n * 26 + ch.charCodeAt(0) - 64; return n - 1; };
  const 줄들 = [];
  for (const 줄 of f[시트].toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const 칸들 = [];
    for (const c of 줄[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const 속 = c[1], 안 = c[2] || '';
      const r = (속.match(/\br="([A-Z]+\d+)"/) || [])[1];
      const t = (속.match(/\bt="(\w+)"/) || [])[1];
      const v = (안.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      let 값 = null;
      if (t === 's') 값 = v != null ? 공유[+v] : null;
      else if (t === 'inlineStr') 값 = 엑셀풀이(((안.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1]) || '');
      else if (t === 'str' || t === 'e') 값 = v != null ? 엑셀풀이(v) : null;
      else 값 = v != null ? Number(v) : null;
      칸들[r ? 열번호(r) : 칸들.length] = 값;
    }
    for (let i = 0; i < 칸들.length; i++) if (칸들[i] === undefined) 칸들[i] = null;
    줄들.push(칸들);
  }
  return 줄들;
}

const 영달 = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
              Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function 날짜풀기(v) {                        // "24-Sep-2026" 또는 엑셀 날짜 숫자 → "20260924"
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  }
  const m = String(v || '').trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  return m && 영달[m[2]] ? m[3] + 영달[m[2]] + m[1].padStart(2, '0') : null;
}

function 스테이트파일읽기() {
  try { return JSON.parse(fs.readFileSync(스테이트파일, 'utf8')); } catch (e) { return {}; }
}
let 스테이트저장 = 스테이트파일읽기();
const 스테이트상태 = { 모으는중: false, 마지막: null, 됨: 0, 오류: null };

async function 스테이트한개(기호) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(스테이트주소(기호), { signal: ac.signal, headers: { 'User-Agent': 머리['User-Agent'] } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const 줄 = 엑셀읽기(Buffer.from(await r.arrayBuffer()));
    const 머리줄 = 줄.findIndex(x => String(x[0] || '').trim() === 'Date');
    if (머리줄 < 0) throw new Error('머리글 없음');
    const 열 = 줄[머리줄].map(x => String(x || '').trim());
    const iN = 열.indexOf('NAV'), iS = 열.indexOf('Shares Outstanding');
    if (iN < 0 || iS < 0) throw new Error('열 이름이 바뀜');
    const 표 = {};
    for (const x of 줄.slice(머리줄 + 1)) {
      const d = 날짜풀기(x[0]), nav = Number(x[iN]), sh = Number(x[iS]);
      if (d && nav > 0 && sh > 0) 표[d] = [Math.round(nav * 1e6) / 1e6, sh];
    }
    const 날들 = Object.keys(표).sort();
    if (!날들.length) throw new Error('자료 없음');
    const 남길 = {};
    for (const d of 날들.slice(-스테이트보관)) 남길[d] = 표[d];
    return 남길;
  } finally { clearTimeout(시계); }
}

async function 스테이트모으기() {
  if (스테이트상태.모으는중) return;
  스테이트상태.모으는중 = true; 스테이트상태.됨 = 0; 스테이트상태.오류 = null;
  const 새 = { ...스테이트저장 };
  for (const 기호 of 스테이트) {
    try { 새[기호] = await 스테이트한개(기호); 스테이트상태.됨++; }
    catch (e) { 스테이트상태.오류 = `${기호} ${(e && e.message) || e}`; }
    await new Promise(r => setTimeout(r, 800));
  }
  스테이트저장 = 새;
  try {
    const 임시 = 스테이트파일 + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(새), 'utf8');
    fs.renameSync(임시, 스테이트파일);
  } catch (e) {}
  스테이트상태.모으는중 = false;
  스테이트상태.마지막 = new Date().toISOString();
  업종캐시.at = 0; 자금캐시.at = 0;             // 새 자료로 다시 계산하게
  console.log('[us_flow] State Street', 스테이트상태.됨 + '/' + 스테이트.length, 스테이트상태.오류 || '');
}

// 한 종목의 최근 유출입 · 5일 · 20일 (달러)
function 스테이트흐름(기호) {
  const h = 스테이트저장[기호];
  if (!h) return null;
  const a = Object.keys(h).sort();
  if (a.length < 2) return null;
  const 합 = n => {
    const 끝 = a.slice(-(n + 1));
    let t = 0;
    for (let i = 1; i < 끝.length; i++) t += (h[끝[i]][1] - h[끝[i - 1]][1]) * h[끝[i]][0];
    return { usd: Math.round(t), days: 끝.length - 1, to: 끝[끝.length - 1] };
  };
  const 끝 = h[a[a.length - 1]], 앞 = h[a[a.length - 2]];
  return {
    date: a[a.length - 1], prev: a[a.length - 2],
    shares: 끝[1], sharesChg: 끝[1] - 앞[1], nav: 끝[0],
    aum: Math.round(끝[0] * 끝[1]),
    flow: Math.round((끝[1] - 앞[1]) * 끝[0]),
    flowPct: 앞[1] ? Math.round((끝[1] - 앞[1]) / 앞[1] * 100000) / 1000 : null,
    sum5: 합(5), sum20: 합(20),
  };
}

// ── 운용사 직접 공시 (QQQ 인베스코 · SMH 반에크 · DRAM 라운드힐) — 10/1 추가 ─────────────
//   야후 순자산(며칠씩 안 바뀜)으로 '추정'하던 셋을, 운용사가 공시한 상장주식수로 '정확'하게 셉니다.
//     QQQ   인베스코 공개 JSON — 그날 순자산(날짜 붙음) ÷ 같은 날 NAV(이력) = 상장주식수
//     DRAM  라운드힐 홈페이지가 쓰는 CSV — Shares Outstanding · NAV · Rate Date
//     SMH   반에크 NAV 이력 엑셀(쿠키를 받아야 내려줌 → curl 로) — AUM ÷ NAV = 상장주식수, 과거까지 한 번에
//   그날 숫자만 주는 곳이 많아 서버가 하루에 한 줄씩 /root/app/issuer_flow.json 에 쌓습니다.
//   그래서 붙인 뒤 둘째 거래일부터 '정확' 값이 나오고, 그 전에는 예전처럼 추정으로 보여 줍니다.
//   GET /us-flow/issuers   — 쌓인 날수 · 마지막 날 · 오류 (반에크 엑셀 모양이 다르면 앞줄을 보여 줌)
const { execFile } = require('child_process');
const 운용사파일 = '/root/app/issuer_flow.json';
const 운용사들 = ['QQQ', 'SMH', 'DRAM'];
let 운용사저장 = (() => { try { return JSON.parse(fs.readFileSync(운용사파일, 'utf8')); } catch (e) { return {}; } })();
const 운용사상태 = { 마지막: null, 결과: {} };
const 브라우저 = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function 날로(v) {                                    // 여러 날짜 모양 → "20260930"
  const s = String(v == null ? '' : v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + m[2] + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) return (m[3].length === 2 ? '20' + m[3] : m[3]) + m[1].padStart(2, '0') + m[2].padStart(2, '0');
  m = s.match(/([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})/); if (m && 영달[m[1]]) return m[3] + 영달[m[1]] + m[2].padStart(2, '0');
  if (typeof v === 'number') return 날짜풀기(v);
  return 날짜풀기(s);
}
function 한줄넣기(기호, 날, nav, 주식수) {
  if (!날 || !(nav > 0) || !(주식수 > 0)) throw new Error(`숫자가 이상함 (날 ${날} · NAV ${nav} · 주식수 ${주식수})`);
  const h = 운용사저장[기호] = 운용사저장[기호] || {};
  h[날] = [Math.round(nav * 1e6) / 1e6, Math.round(주식수)];
  const 날들 = Object.keys(h).sort();
  for (const d of 날들.slice(0, Math.max(0, 날들.length - 스테이트보관))) delete h[d];
  return `${날} · NAV ${nav} · 주식수 ${Math.round(주식수).toLocaleString('en-US')}`;
}

// QQQ — 인베스코
async function 인베스코() {
  const base = 'https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103';
  // 인베스코 방화벽이 주소마다 받아 주는 Accept 머리말이 달라(406) 세 가지를 차례로 써 봅니다
  const 받 = async u => {
    let 마지막 = '';
    for (const accept of ['application/json', 'application/json,*/*', '*/*']) {
      const r = await fetch(u, { headers: { Accept: accept, Referer: 'https://www.invesco.com/', 'User-Agent': 브라우저 } });
      if (r.ok) return r.json();
      마지막 = 'HTTP ' + r.status;
    }
    throw new Error(마지막 + ' · ' + u.split('?')[0].split('/').pop());
  };
  const fd = await 받(`${base}?idType=cusip&productType=ETF&expand=nav&variationType=fundDetails`);
  const 날 = 날로(fd.shareclassTotalNetAssetsEffectiveDate || fd.effectiveDate);
  const 순 = Number(fd.shareclassTotalNetAssets);
  const navs = await 받(`${base}/navs?idType=cusip&productType=ETF`);
  const 줄 = ((navs.lineChartData || []).find(x => x.type === 'NAV') || {}).data || [];
  const nav표 = {};
  for (const p of 줄) { const d = 날로(p.date); if (d && p.value > 0) nav표[d] = Number(p.value); }
  if (!nav표[날]) throw new Error(`${날} NAV 가 이력에 아직 없음`);
  // 순자산 ÷ NAV — 설정단위가 5만 주라 100주 단위로 반올림해 계산 잔돈을 없앱니다
  return 한줄넣기('QQQ', 날, nav표[날], Math.round(순 / nav표[날] / 100) * 100);
}

// DRAM — 라운드힐 (홈페이지가 읽는 CSV)
function csv줄(t) {
  const 줄들 = [];
  for (const 줄 of t.split(/\r?\n/)) {
    if (!줄.trim()) continue;
    const 칸 = []; let 값 = '', 안 = false;
    for (let i = 0; i < 줄.length; i++) {
      const c = 줄[i];
      if (c === '"') { if (안 && 줄[i + 1] === '"') { 값 += '"'; i++; } else 안 = !안; }
      else if (c === ',' && !안) { 칸.push(값); 값 = ''; }
      else 값 += c;
    }
    칸.push(값); 줄들.push(칸.map(x => x.trim()));
  }
  return 줄들;
}
async function 라운드힐() {
  const r = await fetch('https://www.roundhillinvestments.com/assets/data/FilepointRoundhill.40RU.RU_DailyNAV.csv',
    { headers: { 'User-Agent': 브라우저, Accept: 'text/csv,*/*', Referer: 'https://www.roundhillinvestments.com/etf/dram/' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const 줄 = csv줄(await r.text());
  const 머 = 줄[0] || [], 칸 = n => 머.findIndex(x => x.toLowerCase() === n.toLowerCase());
  const [iT, iD, iS, iN] = ['Fund Ticker', 'Rate Date', 'Shares Outstanding', 'NAV'].map(칸);
  if ([iT, iD, iS, iN].some(i => i < 0)) throw new Error('CSV 열 이름이 바뀜: ' + 머.join(' | ').slice(0, 200));
  const 행들 = 줄.slice(1).filter(x => x[iT] === 'DRAM');
  if (!행들.length) throw new Error('CSV 에 DRAM 줄이 없음');
  let 끝 = '';
  for (const x of 행들) 끝 = 한줄넣기('DRAM', 날로(x[iD]), 숫자로(x[iN]), 숫자로(x[iS]));
  return 끝 + (행들.length > 1 ? ` (${행들.length}줄)` : '');
}

// SMH — 반에크 (Cloudflare 쿠키를 받아야 엑셀을 내줘서 curl 로) · 10/2 보유내역 엑셀엔 주식수가 없어 NAV 이력의 AUM 으로
function curl받기(주소) {
  return new Promise((ok, no) => {
    const 쿠키 = `/tmp/vaneck_${process.pid}.jar`;
    execFile('curl', ['-s', '-L', '--max-redirs', '8', '-m', '60', '-A', 브라우저, '-c', 쿠키, '-b', 쿠키, 주소],
      { encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 }, (e, out) => {
        try { fs.unlinkSync(쿠키); } catch (x) {}
        if (e) return no(new Error('curl ' + (e.code || e.message)));
        ok(out);
      });
  });
}
// .NET 이 만든 엑셀은 <x:row> 처럼 앞에 이름표가 붙습니다 — 붙어 있어도 읽습니다
function 엑셀표(buf) {
  const f = zip풀기(buf);
  const 공유 = [];
  const ss = Object.keys(f).find(k => /sharedStrings\.xml$/i.test(k));
  if (ss) for (const m of f[ss].toString('utf8').matchAll(/<(?:\w+:)?si>([\s\S]*?)<\/(?:\w+:)?si>/g))
    공유.push([...m[1].matchAll(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)].map(x => 엑셀풀이(x[1])).join(''));
  const 시트 = Object.keys(f).filter(k => /worksheets\/sheet\d+\.xml$/i.test(k)).sort()[0];
  if (!시트) throw new Error('시트가 없음');
  const 표 = [];
  for (const 줄 of f[시트].toString('utf8').matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    const 칸들 = [];
    for (const c of 줄[1].matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const t = (c[1].match(/\bt="(\w+)"/) || [])[1], 안 = c[2] || '';
      const v = (안.match(/<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
      const is = (안.match(/<(?:\w+:)?t[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/) || [])[1];
      칸들.push(t === 's' ? 공유[+v] : t === 'inlineStr' ? 엑셀풀이(is || '') : v == null ? null : (isNaN(+v) ? 엑셀풀이(v) : +v));
    }
    표.push(칸들);
  }
  return 표;
}
let 반에크앞줄 = null;                                // 읽기 실패 때 /us-flow/issuers 에 보여 줄 앞줄
function 큰수(v) {                                    // "$74,820,045,123.45" · "74.82B" 둘 다
  const t = String(v == null ? '' : v).trim(), n = 숫자로(t);
  if (n == null) return null;
  return /\d\s*B$/i.test(t) ? n * 1e9 : /\d\s*M$/i.test(t) ? n * 1e6 : n;
}
async function 반에크() {
  // NAV 이력 엑셀 — Date · NAV · … · AUM. AUM ÷ NAV = 상장주식수 (과거까지 한 번에 채워짐)
  const 이력 = 엑셀표(await curl받기('https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/fundhistoprices/'));
  const hi = 이력.findIndex(r => r.some(x => /^date$/i.test(String(x || '').trim())) && r.some(x => /^nav$/i.test(String(x || '').trim())));
  if (hi < 0) { 반에크앞줄 = { 이력앞줄: 이력.slice(0, 8) }; throw new Error('NAV 이력 엑셀 머리글을 못 찾음'); }
  const 머 = 이력[hi].map(x => String(x || '').trim().toLowerCase());
  const iD = 머.indexOf('date'), iN = 머.indexOf('nav'), iA = 머.findIndex(x => /^aum$|net assets/.test(x));
  if (iA < 0) { 반에크앞줄 = { 이력머리: 이력[hi] }; throw new Error('NAV 이력 엑셀에 AUM 열이 없음'); }
  let 채움 = 0, 끝 = '', 거친값 = 0;
  const 줄들 = 이력.slice(hi + 1).map(r => ({ d: 날로(r[iD]), nav: 숫자로(r[iN]), a: 큰수(r[iA]), 원: String(r[iA] || '') }))
    .filter(x => x.d && x.nav > 0 && x.a > 0).sort((p, q) => p.d < q.d ? -1 : 1).slice(-스테이트보관);
  for (const x of 줄들) {
    if (/[BM]\s*$/i.test(x.원)) 거친값++;                // "74.82B" 처럼 반올림된 값이면 주식수가 거칠어짐
    // 설정단위가 5만 주라 1,000주 단위로 반올림해 계산 잔돈을 없앱니다
    끝 = 한줄넣기('SMH', x.d, x.nav, Math.round(x.a / x.nav / 1000) * 1000); 채움++;
  }
  if (!채움) { 반에크앞줄 = { 이력머리: 이력[hi], 이력앞줄: 이력.slice(hi + 1, hi + 6) }; throw new Error('NAV 이력에서 읽은 날이 없음'); }
  반에크앞줄 = 거친값 ? { 주의: `AUM 이 반올림된 값(B·M)이 ${거친값}일 — 주식수가 거칠 수 있음`, 예: 줄들.slice(-2).map(x => x.원) } : null;
  return `${끝} · NAV 이력 ${채움}일`;
}

async function 운용사모으기() {
  for (const [기호, 함수] of [['QQQ', 인베스코], ['DRAM', 라운드힐], ['SMH', 반에크]]) {
    try { 운용사상태.결과[기호] = '됨 · ' + await 함수(); }
    catch (e) { 운용사상태.결과[기호] = '실패 · ' + ((e && e.message) || e); }
  }
  try {
    fs.writeFileSync(운용사파일 + '.tmp', JSON.stringify(운용사저장), 'utf8');
    fs.renameSync(운용사파일 + '.tmp', 운용사파일);
  } catch (e) {}
  운용사상태.마지막 = new Date().toISOString();
  자금캐시.at = 0;
  console.log('[us_flow] 운용사 공시', JSON.stringify(운용사상태.결과));
}

// 스테이트흐름 과 같은 계산 (저장소만 다름) — 이틀치가 모여야 계산됩니다
function 운용사흐름(기호) {
  const h = 운용사저장[기호];
  if (!h) return null;
  const a = Object.keys(h).sort();
  if (a.length < 2) return null;
  const 합 = n => {
    const 끝 = a.slice(-(n + 1));
    let t = 0;
    for (let i = 1; i < 끝.length; i++) t += (h[끝[i]][1] - h[끝[i - 1]][1]) * h[끝[i]][0];
    return { usd: Math.round(t), days: 끝.length - 1, to: 끝[끝.length - 1] };
  };
  const 끝 = h[a[a.length - 1]], 앞 = h[a[a.length - 2]];
  return {
    date: a[a.length - 1], prev: a[a.length - 2],
    shares: 끝[1], sharesChg: 끝[1] - 앞[1], nav: 끝[0],
    aum: Math.round(끝[0] * 끝[1]),
    flow: Math.round((끝[1] - 앞[1]) * 끝[0]),
    flowPct: 앞[1] ? Math.round((끝[1] - 앞[1]) / 앞[1] * 100000) / 1000 : null,
    sum5: 합(5), sum20: 합(20), 쌓인날: a.length,
  };
}

// ── 업종 ────────────────────────────────────────────
const 업종캐시 = { at: 0, data: null };
async function 업종받기() {
  if (업종캐시.data && Date.now() - 업종캐시.at < 신선) return 업종캐시.data;

  async function 묶음(목록) {
    const 결과 = [];
    for (let i = 0; i < 목록.length; i += 4) {
      const 조각 = 목록.slice(i, i + 4);
      const 받음 = await Promise.all(조각.map(async ([기호, 이름, 키]) => {
        try {
          const s = await 시세(기호);
          return { symbol: 기호, name: 이름, key: 키 || null, ...s };
        } catch (e) { return { symbol: 기호, name: 이름, key: 키 || null, changePct: null }; }
      }));
      결과.push(...받음);
    }
    return 결과;
  }

  const [업종, 참고] = await Promise.all([묶음(업종들), 묶음(참고들)]);
  const 쓸것 = 업종.filter(x => x.changePct != null);
  쓸것.sort((a, b) => b.changePct - a.changePct);

  // 섹터별 자금 (State Street 공시 상장주식수)
  let 자금날 = null;
  for (const x of [...쓸것, ...참고]) {
    const f = 스테이트.includes(x.symbol) ? 스테이트흐름(x.symbol) : null;
    if (!f) continue;
    x.fund = { date: f.date, flow: f.flow, sharesChg: f.sharesChg, aum: f.aum, sum5: f.sum5, sum20: f.sum20 };
    if (!자금날 || f.date > 자금날) 자금날 = f.date;
  }

  const out = {
    generatedAt: new Date().toISOString(),
    date: (업종.find(x => x.date) || {}).date || null,
    sectors: 쓸것,
    others: 참고,
    best: 쓸것[0] || null,
    worst: 쓸것[쓸것.length - 1] || null,
    avg: 쓸것.length ? Math.round(쓸것.reduce((a, x) => a + x.changePct, 0) / 쓸것.length * 100) / 100 : null,
    fundDate: 자금날,
  };
  업종캐시.at = Date.now();          // ★ const 라 통째로 대입하면 안 됩니다
  업종캐시.data = out;
  return out;
}

// ── 자금 흐름 ────────────────────────────────────────
function 이력읽기() {
  try { return JSON.parse(fs.readFileSync(자금파일, 'utf8')); } catch (e) { return {}; }
}
function 이력쓰기(h) {
  const 날들 = Object.keys(h).sort();
  while (날들.length > 보관일수) delete h[날들.shift()];
  try {
    const 임시 = 자금파일 + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(h), 'utf8');
    fs.renameSync(임시, 자금파일);
  } catch (e) {}
}

const 자금캐시 = { at: 0, data: null };
async function 자금받기() {
  if (자금캐시.data && Date.now() - 자금캐시.at < 30 * 60 * 1000) return 자금캐시.data;

  const 이력 = 이력읽기();
  const 보유 = 보유읽기();
  const 줄들 = [];
  let 정확수 = 0, 추정수 = 0;

  for (const [기호, 이름, 메모] of 자금ETF) {
    let s = null;
    try { s = await 시세(기호); } catch (e) {}
    if (!s || s.price == null) {
      줄들.push({ symbol: 기호, name: 이름, note: 메모, error: '시세 실패' });
      continue;
    }
    const 날 = s.date || new Date().toISOString().slice(0, 10);
    이력[날] = 이력[날] || {};
    const 칸 = 이력[날][기호] = 이력[날][기호] || {};
    칸.p = s.price;

    // State Street (SPY · XLK) — 공시 상장주식수로 정확하게, 과거까지
    const 스 = 스테이트.includes(기호) ? 스테이트흐름(기호) : 운용사들.includes(기호) ? 운용사흐름(기호) : null;
    if (스) {
      정확수 += 1;
      줄들.push({
        symbol: 기호, name: 이름, note: 메모,
        price: s.price,
        changePct: s.changePct == null ? null : Math.round(s.changePct * 100) / 100,
        aum: 스.aum, shares: 스.shares, asOf: 대시(스.date),
        method: '정확',
        status: 스.sharesChg === 0 ? '설정·환매 없음' : null,
        flow: 스.flow, flowPct: 스.flowPct, prevDate: 대시(스.prev),
        sum5: 스.sum5, sum20: 스.sum20,
      });
      continue;
    }

    let 정확 = null;
    if (아이셰어즈[기호]) {
      try { 정확 = await 아이셰어즈받기(기호); } catch (e) {}
    }
    let aum = null;
    if (정확 && 정확.shares) {
      칸.sh = 정확.shares;
      칸.nav = 정확.nav || null;
      칸.asOf = 정확.asOf || null;
      aum = 정확.netAssets || null;
      if (aum) 칸.a = aum;
      정확수 += 1;
    } else {
      aum = await 순자산(기호);
      if (aum) { 칸.a = aum; 추정수 += 1; }
    }

    // ── 어제치 찾기 ──
    const 앞날들 = Object.keys(이력).filter(d => d < 날).sort();
    let 유출입 = null, 비율 = null, 방식 = null, 상태 = null, 앞날 = null;

    // 1) 정확 — 주식수가 있는 가장 최근 날과 견줍니다
    if (칸.sh) {
      앞날 = 앞날들.filter(d => 이력[d][기호] && 이력[d][기호].sh).pop() || null;
      let 어제 = 앞날 ? 이력[앞날][기호] : null;
      if (!어제) {                                   // 자기 기록이 없으면 보유내역 이력에서
        const k = 보유앞날(보유, 기호, 날);
        if (k) { 앞날 = k.date; 어제 = { sh: k.sh }; }
      }
      if (어제) {
        const 주식차 = 칸.sh - 어제.sh;
        const nav = 칸.nav || s.price;
        유출입 = 주식차 * nav;
        비율 = 어제.sh ? (주식차 / 어제.sh) * 100 : null;
        방식 = '정확';
        if (주식차 === 0) 상태 = '설정·환매 없음';
      } else {
        방식 = '정확'; 상태 = '첫날 — 다음 거래일부터 비교됩니다';
      }
    // 2) 추정 — 순자산에서 가격 상승분을 뺍니다
    } else if (칸.a) {
      앞날 = 앞날들.filter(d => 이력[d][기호] && 이력[d][기호].a).pop() || null;
      if (앞날) {
        const 어제 = 이력[앞날][기호];
        if (어제.a === 칸.a) {
          방식 = '추정'; 상태 = '순자산 미갱신';      // ★ 가짜 유출입을 막습니다
        } else {
          const 수익률 = 어제.p ? s.price / 어제.p : 1;
          유출입 = 칸.a - 어제.a * 수익률;
          비율 = 어제.a ? (유출입 / 어제.a) * 100 : null;
          방식 = '추정';
          // 하루에 순자산의 15% 가 드나드는 일은 이 덩치에서 사실상 없습니다.
          if (비율 != null && Math.abs(비율) > 15) 상태 = '값이 튐 — 참고만';
        }
      } else {
        방식 = '추정'; 상태 = '첫날 — 다음 거래일부터 비교됩니다';
      }
    } else {
      상태 = '순자산을 받지 못했습니다';
    }

    줄들.push({
      symbol: 기호, name: 이름, note: 메모,
      price: s.price,
      changePct: s.changePct == null ? null : Math.round(s.changePct * 100) / 100,
      aum: 칸.a || null,
      shares: 칸.sh || null,
      asOf: 칸.asOf || null,
      method: 방식,                       // '정확' | '추정' | null
      status: 상태,                       // 사람이 읽을 안내 문구
      flow: 유출입 == null ? null : Math.round(유출입),
      flowPct: 비율 == null ? null : Math.round(비율 * 1000) / 1000,
      prevDate: 앞날,
      // 정확 갈래만 — 보유내역 이력으로 최근 5일 · 20일 누적
      sum5: 방식 === '정확' ? 보유누적(보유, 기호, 5) : null,
      sum20: 방식 === '정확' ? 보유누적(보유, 기호, 20) : null,
    });
  }
  이력쓰기(이력);

  const 잰것 = 줄들.filter(x => x.flow != null).length;
  const out = {
    generatedAt: new Date().toISOString(),
    date: 줄들.find(x => x.price) ? Object.keys(이력).sort().pop() : null,
    items: 줄들,
    exactOk: 정확수,
    aumOk: 추정수,
    note: 잰것 ? null
      : (정확수 || 추정수)
        ? '견줄 어제 자료가 아직 없습니다. 내일부터 계산됩니다.'
        : '순자산을 받지 못해 자금 유출입을 계산하지 못했습니다',
  };
  자금캐시.at = Date.now();
  자금캐시.data = out;
  return out;
}

module.exports = (app) => {
  setTimeout(스테이트모으기, 60 * 1000);            // 서버가 뜨고 1분 뒤
  setInterval(스테이트모으기, 1 * 3600 * 1000);     // 그다음 1시간마다 (9/29: 6시간 → 1시간 — State Street 가 한국시간 밤에 올리면 바로 받게)
  setTimeout(운용사모으기, 90 * 1000);              // 운용사 공시 (QQQ · SMH · DRAM) — 1분 30초 뒤, 그다음 1시간마다
  setInterval(운용사모으기, 1 * 3600 * 1000);

  // 운용사 공시가 쌓이는지 확인용
  app.get('/us-flow/issuers', (req, res) => {
    const 요약 = {};
    for (const 기호 of 운용사들) {
      const h = 운용사저장[기호], a = h ? Object.keys(h).sort() : [];
      const f = 운용사흐름(기호);
      요약[기호] = a.length ? `${a.length}일 (${a[0]}~${a[a.length - 1]})`
        + (f ? ` · 최근 ${(f.flow / 1e8).toFixed(1)}억$ · 5일 ${(f.sum5.usd / 1e8).toFixed(1)}억$` : ' · 이틀치부터 계산') : '없음';
    }
    res.json({ ...운용사상태, 요약, 반에크앞줄 });
  });
  app.get('/us-flow/issuers/refresh', async (req, res) => { await 운용사모으기(); res.json(운용사상태); });

  // State Street 자료가 모였는지 확인용
  app.get('/us-flow/ssga', (req, res) => {
    const 요약 = {};
    for (const 기호 of 스테이트) {
      const h = 스테이트저장[기호], a = h ? Object.keys(h).sort() : [];
      const f = 스테이트흐름(기호);
      요약[기호] = a.length ? `${a.length}일 (${a[0]}~${a[a.length - 1]})`
        + (f ? ` · 5일 ${(f.sum5.usd / 1e8).toFixed(1)}억$ · 20일 ${(f.sum20.usd / 1e8).toFixed(1)}억$` : '') : '없음';
    }
    res.json({ ...스테이트상태, 요약 });
  });

  app.get('/us-sectors', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await 업종받기());
    } catch (e) {
      if (업종캐시.data) return res.json({ ...업종캐시.data, stale: true });
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.get('/us-flow', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await 자금받기());
    } catch (e) {
      if (자금캐시.data) return res.json({ ...자금캐시.data, stale: true });
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 두 갈래가 살아 있는지 확인용
  app.get('/us-flow/probe', async (req, res) => {
    const k = await 열쇠받기(true);
    const 야후 = {};
    for (const 기호 of ['DRAM', 'SPY', 'SMH']) 야후[기호] = await 순자산(기호);
    const 공시 = {};
    for (const 기호 of ['EWY', 'EEM', 'IEMG']) {
      try { 공시[기호] = await 아이셰어즈받기(기호); } catch (e) { 공시[기호] = null; }
    }
    res.json({
      열쇠: { 쿠키: !!k.쿠키, crumb: k.크럼 || null },
      야후순자산: 야후,
      야후됨: Object.values(야후).filter(Boolean).length,
      iShares공시: 공시,
      공시됨: Object.values(공시).filter(Boolean).length,
    });
  });
};
