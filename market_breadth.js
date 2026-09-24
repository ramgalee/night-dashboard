// 시장 폭 지표
//   GET /market-breadth
//
//   · ADR(등락비율)      오른 종목 ÷ 내린 종목 × 100 · 20일 평균과 함께
//   · 섹터 거래비중       오늘 거래대금이 어느 업종에 몰렸는지
//   · 거래대금 가중 등락률  큰 종목 중심으로 본 시장 등락
//   · 60일 신고가 종목 수
//
// 지수 등락률만으로는 "몇 종목이 올랐나"를 알 수 없어, 장의 속을 보는 지표입니다.
const fs = require('fs');

const 안 = 'http://127.0.0.1:3000';
const 신선 = 60 * 1000;
const 이력파일 = '/root/app/breadth_history.json';
const 이력일수 = 80;

// 업종 목록에는 규모별(대형주·중형주·소형주)과 대분류(제조), 지수(KOSDAQ 150 등)가 섞여 있습니다.
// 그대로 더하면 같은 종목이 두세 번 세어지므로 빼야 합니다.
//   코스피 — 규모별 3개 · 제조(대분류) · 증권/보험(금융에 포함) · 지수 3개
//   코스닥 — 제조(대분류) · 규모별·전략 지수들
// 이렇게 고르면 종목 수 합이 시장 전체의 98.5% 안쪽으로 맞습니다.
const 뺄코드 = {
  KOSPI: new Set(['002', '003', '004', '024', '025', '027', '603', '604', '605']),
  KOSDAQ: new Set(['106', '138', '139', '140', '142', '143', '144', '145', '150', '151', '160', '165']),
};

async function 내부(경로) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 12000);
  try {
    const r = await fetch(안 + 경로, { signal: ac.signal });
    if (!r.ok) throw new Error(경로 + ' → ' + r.status);
    return await r.json();
  } finally { clearTimeout(시계); }
}

let RS = null, RS_AT = 0;
async function rs읽기() {
  if (RS && Date.now() - RS_AT < 3 * 3600 * 1000) return RS;
  try {
    const r = await fetch('https://raw.githubusercontent.com/ramgalee/night-dashboard/main/rs.json');
    if (!r.ok) throw new Error('rs ' + r.status);
    RS = await r.json();
    RS_AT = Date.now();
  } catch (e) { if (!RS) RS = { data: {} }; }
  return RS;
}

function 이력읽기() {
  try { return JSON.parse(fs.readFileSync(이력파일, 'utf8')); } catch (e) { return {}; }
}
function 이력쓰기(h) {
  const 날들 = Object.keys(h).sort();
  while (날들.length > 이력일수) delete h[날들.shift()];
  try {
    const 임시 = 이력파일 + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(h), 'utf8');
    fs.renameSync(임시, 이력파일);
  } catch (e) {}
}

const 오늘날짜 = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

function 시장하나(m, 이름) {
  const 전체 = m.total || {};
  const 오름 = 전체.rising || 0, 내림 = 전체.falling || 0, 보합 = 전체.flat || 0;

  // 겹치지 않는 업종만 골라 거래비중을 냅니다.
  const 뺄것 = 뺄코드[이름] || new Set();
  const 쓸것 = (m.sectors || []).filter(s =>
    (s.stocks || 0) > 0 && !뺄것.has(String(s.code || '')));
  const 합종목 = 쓸것.reduce((a, s) => a + (s.stocks || 0), 0);
  const 합대금 = 쓸것.reduce((a, s) => a + (s.tradeValue || 0), 0);

  // 스스로 검산 — 골라낸 업종의 종목 수가 시장 전체와 크게 어긋나면 쓰지 않습니다.
  const 믿을만 = 전체.stocks ? Math.abs(합종목 - 전체.stocks) / 전체.stocks < 0.15 : false;

  const 업종 = !믿을만 ? [] : 쓸것
    .map(s => ({
      name: s.name, code: s.code, changePct: s.changePct,
      tradeValue: s.tradeValue || 0,
      share: 합대금 ? (s.tradeValue || 0) / 합대금 * 100 : null,
      stocks: s.stocks,
    }))
    .sort((a, b) => b.tradeValue - a.tradeValue);

  // 거래대금이 큰 업종에 무게를 둔 등락률
  const 가중 = (믿을만 && 합대금)
    ? 쓸것.reduce((a, s) => a + (s.changePct || 0) * (s.tradeValue || 0), 0) / 합대금
    : null;

  return {
    index: 전체.index ?? null, changePct: 전체.changePct ?? null,
    rising: 오름, falling: 내림, flat: 보합, stocks: 전체.stocks || 0,
    adr: 내림 ? Math.round(오름 / 내림 * 1000) / 10 : null,
    weightedChangePct: 가중 == null ? null : Math.round(가중 * 100) / 100,
    sectors: 업종.slice(0, 8),
    믿을만,
  };
}

const 캐시 = { data: null, at: 0, 도는중: null };

async function 재기() {
  if (캐시.data && Date.now() - 캐시.at < 신선) return 캐시.data;
  if (캐시.도는중) return await 캐시.도는중;

  캐시.도는중 = (async () => {
    const [kp, kq, rs] = await Promise.all([
      내부('/sector-map?market=KOSPI'),
      내부('/sector-map?market=KOSDAQ'),
      rs읽기(),
    ]);

    const 시장 = { KOSPI: 시장하나(kp, 'KOSPI'), KOSDAQ: 시장하나(kq, 'KOSDAQ') };
    const 합 = {
      rising: 시장.KOSPI.rising + 시장.KOSDAQ.rising,
      falling: 시장.KOSPI.falling + 시장.KOSDAQ.falling,
      flat: 시장.KOSPI.flat + 시장.KOSDAQ.flat,
    };
    합.adr = 합.falling ? Math.round(합.rising / 합.falling * 1000) / 10 : null;

    // 60일 신고가·정배열 (하루 한 번 갱신되는 rs.json 기준)
    const d = (rs && rs.data) || {};
    let 신고가 = 0, 정배열 = 0, 종목 = 0;
    for (const v of Object.values(d)) {
      종목 += 1;
      if (v && v.high60) 신고가 += 1;
      if (v && v.aligned) 정배열 += 1;
    }

    // ADR 이력 — 하루에 한 줄씩 덮어씁니다.
    const 오늘 = 오늘날짜();
    const 이력 = 이력읽기();
    if (합.adr != null) 이력[오늘] = { adr: 합.adr, rising: 합.rising, falling: 합.falling };
    이력쓰기(이력);
    const 값들 = Object.keys(이력).sort().slice(-20).map(k => 이력[k].adr).filter(v => v != null);
    const adr20 = 값들.length ? Math.round(값들.reduce((a, b) => a + b, 0) / 값들.length * 10) / 10 : null;
    const 어제열쇠 = Object.keys(이력).sort().filter(k => k < 오늘).pop();

    const out = {
      generatedAt: new Date().toISOString(),
      date: 오늘,
      markets: 시장,
      total: 합,
      adr20, adrPrev: 어제열쇠 ? 이력[어제열쇠].adr : null,
      adrDays: 값들.length,
      high60: 신고가, aligned: 정배열, rsCount: 종목, rsDate: (rs && rs.date) || null,
    };
    캐시.data = out; 캐시.at = Date.now();
    return out;
  })();

  try { return await 캐시.도는중; }
  finally { 캐시.도는중 = null; }
}

module.exports = (app) => {
  app.get('/market-breadth', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await 재기());
    } catch (e) {
      if (캐시.data) return res.json({ ...캐시.data, stale: true });
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
