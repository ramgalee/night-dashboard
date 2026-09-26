// 미국 업종별 등락 · ETF 자금 흐름
//   GET /us-sectors        업종 11개 + 참고 지수
//   GET /us-flow           주요 ETF 자금 유출입 (순자산 조회가 되는 경우)
//   GET /us-flow/probe     야후가 순자산을 주는지 확인용
//
// 업종은 섹터 ETF 로 봅니다. 미국은 업종 지수를 공짜로 주는 곳이 마땅치 않은데,
// 섹터 ETF 가 그 업종을 그대로 담고 있어 등락률이 사실상 같습니다.
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
const 자금ETF = [
  ['EWY', '한국', '외국인이 한국을 어떻게 보는지'],
  ['DRAM', '메모리 반도체', '삼성전자·SK하이닉스 비중이 높습니다'],
  ['SMH', '반도체', '엔비디아·TSMC 중심'],
  ['EEM', '신흥국', 'MSCI 신흥국'],
  ['VWO', '신흥국(뱅가드)', ''],
  ['SPY', 'S&P500', ''],
  ['QQQ', '나스닥100', ''],
  ['XLK', '미국 기술', ''],
];

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

// ── 시세 (차트 창구 — 막히지 않습니다) ──────────────────
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

// ── 순자산 (막혀 있을 수 있습니다) ────────────────────
async function 순자산(기호) {
  const 길들 = [
    `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${기호}?modules=defaultKeyStatistics`,
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${기호}?modules=defaultKeyStatistics`,
  ];
  for (const 주소 of 길들) {
    try {
      const j = await 가져오기(주소, 10);
      const d = j?.quoteSummary?.result?.[0]?.defaultKeyStatistics;
      const v = d?.totalAssets?.raw ?? d?.totalAssets;
      if (typeof v === 'number' && v > 0) return v;
    } catch (e) {}
  }
  return null;
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
  업종캐시 = Object.assign(업종캐시, { at: Date.now(), data: out });
  return out;
}

// ── 자금 흐름 ────────────────────────────────────────
// 오늘 순자산 − 어제 순자산 × (1 + 오늘 등락률) = 새로 들어오거나 나간 돈
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
  let 순자산됨 = 0;

  for (const [기호, 이름, 메모] of 자금ETF) {
    let s = null, aum = null;
    try { s = await 시세(기호); } catch (e) {}
    if (!s || s.price == null) { 줄들.push({ symbol: 기호, name: 이름, note: 메모, error: '시세 실패' }); continue; }
    aum = await 순자산(기호);
    if (aum) 순자산됨 += 1;

    const 날 = s.date || new Date().toISOString().slice(0, 10);
    이력[날] = 이력[날] || {};
    이력[날][기호] = { p: s.price, a: aum };

    // 어제치를 찾아 유출입을 계산합니다
    const 앞날 = Object.keys(이력).filter(d => d < 날 && 이력[d][기호] && 이력[d][기호].a).sort().pop();
    let 유출입 = null, 비율 = null;
    if (aum && 앞날) {
      const 어제 = 이력[앞날][기호];
      const 수익률 = 어제.p ? s.price / 어제.p : 1;
      유출입 = aum - 어제.a * 수익률;
      비율 = 어제.a ? 유출입 / 어제.a * 100 : null;
    }
    줄들.push({
      symbol: 기호, name: 이름, note: 메모,
      price: s.price, changePct: s.changePct == null ? null : Math.round(s.changePct * 100) / 100,
      aum, flow: 유출입 == null ? null : Math.round(유출입),
      flowPct: 비율 == null ? null : Math.round(비율 * 1000) / 1000,
      prevDate: 앞날 || null,
    });
  }
  이력쓰기(이력);

  const out = {
    generatedAt: new Date().toISOString(),
    date: 줄들.find(x => x.price) ? Object.keys(이력).sort().pop() : null,
    items: 줄들,
    aumOk: 순자산됨,
    note: 순자산됨 ? null : '야후가 순자산을 주지 않아 자금 유출입을 계산하지 못했습니다',
  };
  자금캐시.at = Date.now(); 자금캐시.data = out;
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

  // 야후가 순자산을 주는지 확인용
  app.get('/us-flow/probe', async (req, res) => {
    const 결과 = {};
    for (const 기호 of ['EWY', 'DRAM', 'SPY']) {
      결과[기호] = await 순자산(기호);
    }
    res.json({ 순자산: 결과, 됨: Object.values(결과).filter(Boolean).length });
  });
};
