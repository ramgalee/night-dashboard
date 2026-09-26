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
  const 전날 = m.chartPreviousClose ?? m.previousClose ?? 값[값.length - 2];
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

  const out = {
    generatedAt: new Date().toISOString(),
    date: (업종.find(x => x.date) || {}).date || null,
    sectors: 쓸것,
    others: 참고,
    best: 쓸것[0] || null,
    worst: 쓸것[쓸것.length - 1] || null,
    avg: 쓸것.length ? Math.round(쓸것.reduce((a, x) => a + x.changePct, 0) / 쓸것.length * 100) / 100 : null,
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
      if (앞날) {
        const 어제 = 이력[앞날][기호];
        const 주식차 = 칸.sh - 어제.sh;
        const nav = 칸.nav || s.price;
        유출입 = 주식차 * nav;
        비율 = 어제.sh ? (주식차 / 어제.sh) * 100 : null;
        방식 = '정확';
        if (주식차 === 0) 상태 = '설정·환매 없음';
      } else {
        방식 = '정확'; 상태 = '첫날 — 내일부터 비교됩니다';
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
        방식 = '추정'; 상태 = '첫날 — 내일부터 비교됩니다';
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
