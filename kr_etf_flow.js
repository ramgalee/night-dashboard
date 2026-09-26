// 미국 iShares ETF 가 한국 주식을 얼마나 사고팔았나 (EWY · IEMG · EEM)
//   GET /kr-etf-flow          날짜별 한국 순매수 · 최근일 종목 상위 · 펀드별 요약
//   GET /kr-etf-flow/status   수집 상태 (펀드별로 며칠 모였나)
//
// ── 원리 ─────────────────────────────────────────────
//   iShares 는 날짜별 보유내역을 공개합니다(asOfDate). 거기에 종목별 보유 주식수가 있습니다.
//       (오늘 보유 주식수 − 전날 보유 주식수) × 주가 × 환율 = 그 종목을 사고판 금액
//   한국 종목만 더하면 '미국 ETF 에서 한국 주식으로 들어온(나간) 돈' 입니다.
//   설정·환매로 들어온 돈이든 비중 조정이든, 실제로 사고판 한국 주식은 다 잡힙니다.
//
// ── 구조 (leader_flow.js 와 같음) ─────────────────────
//   서버가 뜨고 45초 뒤 과거를 채우고(처음 한 번 10분 안팎), 그다음 3시간마다 새 날만 받습니다.
//   화면 요청에는 저장된 파일로 즉시 답합니다.
//
// ── 두 가지 숫자 ──────────────────────────────────────
//   현물 매매   보유 주식수 변화로 잰 값 — 펀드가 한국 시장에서 실제로 사고판 현물
//   투자자 자금  상장주식수 변화 × NAV × 한국 비중 — 투자자가 넣고 뺀 돈 중 한국 몫
//   보통은 비슷하지만, 비중 한도(EWY 25/50) 때문에 현물을 덜어내 현금·선물로 옮기면
//   현물 매매가 더 크게 나옵니다. 2026년 9월 EWY 가 하이닉스를 덜어낼 때 3주간 1.2조원 차이가 났습니다.
//
// ── 알아둘 것 ─────────────────────────────────────────
//   · 기준일은 펀드 보유내역 날짜(미국 날짜)입니다. 한국 시장 체결일과 하루 어긋날 수 있습니다.
//   · 주식 분할처럼 매매 없이 주식수가 바뀐 경우는 가격과 반대로 크게 움직인 것을 보고 뺍니다.
//   · 휴장일은 '-' 로 옵니다. 한 번 확인한 휴장일은 다시 묻지 않습니다(최근 4일은 예외).
const fs = require('fs');

const 펀드들 = [
  ['EWY', '239681', '한국'],
  ['IEMG', '244050', '신흥국(코어)'],
  ['EEM', '239637', '신흥국'],
];
const 주소 = 'https://www.blackrock.com/varnish-api/blk-one01-product-data/product-data/api/v1/get-fund-document'
  + '?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=us-ishares&locale=en_US'
  + '&userType=individual&component=holdings';
const CAP_URL = 'https://raw.githubusercontent.com/ramgalee/night-dashboard/main/marketcap.json';
const 저장 = '/root/app/kr_etf_history.json';

const 거슬러일수 = 190;           // 달력일 — 약 130거래일(6개월)
const 보관일수 = 400;
const 쉬기 = 1200;                // 요청 사이 쉬는 시간(ms) — 운용사에 부담 주지 않게
const 다시모으기 = 3 * 3600e3;    // 3시간마다
const sleep = ms => new Promise(r => setTimeout(r, ms));

const 머리 = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
  'Accept': 'text/csv,text/plain,*/*',
};

// ── 도구 ─────────────────────────────────────────────
function 숫자(s) {
  if (s == null) return null;
  const t = String(s).replace(/[$,%\s]/g, '');
  if (t === '' || t === '-') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// 따옴표 안의 쉼표를 지키며 한 줄을 칸으로 나눕니다
function 줄나누기(줄) {
  const 칸 = []; let 지금 = ''; let 따옴 = false;
  for (let i = 0; i < 줄.length; i++) {
    const c = 줄[i];
    if (따옴) {
      if (c === '"') { if (줄[i + 1] === '"') { 지금 += '"'; i++; } else 따옴 = false; }
      else 지금 += c;
    } else if (c === '"') 따옴 = true;
    else if (c === ',') { 칸.push(지금); 지금 = ''; }
    else 지금 += c;
  }
  칸.push(지금);
  return 칸;
}

const 달 = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
            Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
function 날짜로(s) {                       // "Sep 24, 2026" → "20260924"
  const m = String(s || '').trim().match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m || !달[m[1]]) return null;
  return m[3] + 달[m[1]] + String(m[2]).padStart(2, '0');
}
function 칸날(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function 날빼기(ymd, n) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - n);
  return 칸날(d);
}
function 주말(ymd) {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}
function 평일간격(a, b) {                  // a < b 사이의 평일 수 (b 포함)
  let n = 0, d = a;
  for (let i = 0; i < 20 && d < b; i++) { d = 날빼기(d, -1); if (!주말(d)) n++; }
  return n;
}

// ── 보유내역 한 장 읽기 ────────────────────────────────
function 읽기(글) {
  if (!글 || 글.trimStart().startsWith('<')) return { 오류: 'CSV 가 아님' };
  const 줄 = 글.replace(/\r/g, '').split('\n');
  let 기준일 = null, 주식수 = null, 머리줄 = -1;
  for (let i = 0; i < Math.min(줄.length, 25); i++) {
    const c = 줄나누기(줄[i]);
    const 첫 = (c[0] || '').trim();
    if (/^Fund Holdings as of/i.test(첫)) 기준일 = (c[1] || '').trim();
    else if (/^Shares Outstanding/i.test(첫)) 주식수 = 숫자(c[1]);
    else if (첫 === 'Ticker') { 머리줄 = i; break; }
  }
  if (기준일 === '-' || 기준일 === '') return { 휴장: true };
  const 날 = 날짜로(기준일);
  if (!날 || !주식수 || 머리줄 < 0) return { 오류: '머리글을 못 읽음' };

  const 열 = 줄나누기(줄[머리줄]).map(s => s.trim());
  const ix = n => 열.indexOf(n);
  const iT = ix('Ticker'), iN = ix('Name'), iA = ix('Asset Class'), iMV = ix('Market Value'),
        iQ = ix('Quantity'), iP = ix('Price'), iL = ix('Location'), iFX = ix('FX Rate');
  if ([iT, iMV, iQ, iP, iL].some(v => v < 0)) return { 오류: '열 이름이 바뀜' };

  let 총평가 = 0, 행수 = 0, 환율 = null;
  const kr = {}, 영문 = {};
  for (let i = 머리줄 + 1; i < 줄.length; i++) {
    if (!줄[i].trim()) break;                  // 표 끝 — 그 아래는 안내문
    const c = 줄나누기(줄[i]);
    if (c.length < 열.length - 2) break;
    행수++;
    const mv = 숫자(c[iMV]);
    if (mv) 총평가 += mv;
    if ((c[iL] || '').trim() !== 'Korea (South)') continue;
    if (iA >= 0 && (c[iA] || '').trim() !== 'Equity') continue;
    const 코드 = String(c[iT] || '').trim().toUpperCase();
    if (!/^[0-9A-Z]{6}$/.test(코드)) continue;  // KRX 6자리만
    const q = 숫자(c[iQ]), p = 숫자(c[iP]);
    if (q == null || p == null || p <= 0) continue;
    if (kr[코드]) kr[코드][0] += q; else kr[코드] = [q, p];
    if (iN >= 0) 영문[코드] = (c[iN] || '').trim();
    const f = iFX >= 0 ? 숫자(c[iFX]) : null;
    if (f) 환율 = f;
  }
  if (!행수) return { 오류: '표가 비어 있음' };
  return { 날, 하루: { sh: 주식수, mv: Math.round(총평가), fx: 환율, n: 행수, kr }, 영문 };
}

async function 받기(포트폴리오, 날) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), 45000);
  try {
    const u = `${주소}&portfolioId=${포트폴리오}` + (날 ? `&asOfDate=${날}` : '');
    const r = await fetch(u, { signal: ac.signal, headers: 머리 });
    if (!r.ok) return { 오류: 'HTTP ' + r.status };
    return 읽기(await r.text());
  } catch (e) {
    return { 오류: String((e && e.message) || e) };
  } finally { clearTimeout(시계); }
}

// ── 저장 ─────────────────────────────────────────────
function 파일읽기() {
  try { return JSON.parse(fs.readFileSync(저장, 'utf8')); } catch (e) { return {}; }
}
function 파일쓰기(h) {
  for (const [기호] of 펀드들) {
    const f = h[기호];
    if (!f || !f.days) continue;
    const 날들 = Object.keys(f.days).sort();
    while (날들.length > 보관일수) delete f.days[날들.shift()];
  }
  try {
    const 임시 = 저장 + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(h), 'utf8');
    fs.renameSync(임시, 저장);
  } catch (e) {}
}

// ── 종목명 (marketcap.json) ───────────────────────────
const 이름표 = { info: null, at: 0 };
async function 이름받기() {
  if (이름표.info && Date.now() - 이름표.at < 12 * 3600e3) return 이름표.info;
  try {
    const r = await fetch(CAP_URL, { headers: { 'Cache-Control': 'no-cache' } });
    const j = await r.json();
    if (j && j.info) { 이름표.info = j.info; 이름표.at = Date.now(); }
  } catch (e) {}
  return 이름표.info || {};
}

// ── 수집 ─────────────────────────────────────────────
const 상태 = { 모으는중: false, 마지막: null, 받음: 0, 오류: null, 시작: null };

async function 모으기(까닭) {
  if (상태.모으는중) return;
  상태.모으는중 = true; 상태.시작 = new Date().toISOString(); 상태.받음 = 0; 상태.오류 = null;
  const h = 파일읽기();
  const 오늘 = 칸날(new Date());               // 미국 날짜와 하루 차이는 아래 '최근 4일' 이 흡수
  const 가까운날 = 날빼기(오늘, 4);
  let 연속실패 = 0;

  try {
    for (const [기호, 번호] of 펀드들) {
      const f = h[기호] = h[기호] || {};
      f.days = f.days || {}; f.빈날 = f.빈날 || {}; f.영문 = f.영문 || {};

      for (let k = 0; k <= 거슬러일수; k++) {
        const 날 = 날빼기(오늘, k);
        if (주말(날) || f.days[날] || f.빈날[날]) continue;

        const r = await 받기(번호, 날);
        await sleep(쉬기);

        if (r.휴장) {
          if (날 < 가까운날) f.빈날[날] = 1;     // 최근 4일은 아직 안 나온 것일 수 있어 다시 묻습니다
          연속실패 = 0;
          continue;
        }
        if (r.오류 === '머리글을 못 읽음' && 날 < 가까운날) {
          f.빈날[날] = 1;                        // 휴장일인데 '-' 대신 다른 모양으로 온 경우 (6/19 준틴스 등)
          연속실패 = 0;
          continue;
        }
        if (r.오류) {
          상태.오류 = `${기호} ${날} ${r.오류}`;
          if (++연속실패 >= 6) throw new Error('연속 실패 — 이번 차례는 멈추고 다음에 다시 시도합니다');
          continue;
        }
        연속실패 = 0;
        f.days[r.날] = r.하루;
        Object.assign(f.영문, r.영문);
        if (r.날 !== 날 && 날 < 가까운날) f.빈날[날] = 1;
        상태.받음++;
        if (상태.받음 % 8 === 0) { 파일쓰기(h); 결과.at = 0; }
      }
    }
  } catch (e) {
    상태.오류 = String((e && e.message) || e);
  } finally {
    파일쓰기(h);
    결과.at = 0;
    상태.모으는중 = false;
    상태.마지막 = `${new Date().toISOString()} (${까닭}) · 새로 받은 날 ${상태.받음}`;
    console.log('[kr_etf_flow]', 상태.마지막, 상태.오류 ? '· ' + 상태.오류 : '');
  }
}

// ── 계산 ─────────────────────────────────────────────
const 결과 = { at: 0, data: null };

async function 계산() {
  if (결과.data && 결과.at) return 결과.data;
  const h = 파일읽기();
  const 한글 = await 이름받기();
  const 날별 = {};                            // 날 → { total, 펀드: {}, 종목: {코드: [원, 주]} }
  let 분할의심 = 0;

  for (const [기호, , 설명] of 펀드들) {
    const days = (h[기호] && h[기호].days) || {};
    const 날들 = Object.keys(days).sort();
    for (let i = 1; i < 날들.length; i++) {
      const d0 = 날들[i - 1], d = 날들[i];
      if (평일간격(d0, d) > 4) continue;        // 자료 구멍이 크면 비교하지 않음
      const a = days[d0], b = days[d];
      const na = Object.keys(a.kr).length, nb = Object.keys(b.kr).length;
      if (!na || !nb || nb < na * 0.8 || na < nb * 0.8) continue;   // 한쪽이 잘려 온 날

      const 환율 = b.fx || a.fx;
      if (!환율) continue;
      const 칸 = 날별[d] = 날별[d] || { total: 0, inv: 0, 펀드: {}, 종목: {} };
      let 합 = 0, 한국평가 = 0;
      const 코드들 = new Set([...Object.keys(a.kr), ...Object.keys(b.kr)]);
      for (const c of 코드들) {
        const qa = a.kr[c] ? a.kr[c][0] : 0, pa = a.kr[c] ? a.kr[c][1] : null;
        const qb = b.kr[c] ? b.kr[c][0] : 0, pb = b.kr[c] ? b.kr[c][1] : null;
        if (qb && pb) 한국평가 += qb * pb;
        const dq = qb - qa;
        if (!dq) continue;
        // 분할·병합: 주식수와 가격이 반대로 크게 움직였으면 매매가 아닙니다
        if (qa && qb && pa && pb) {
          const qr = qb / qa, pr = pb / pa;
          if ((qr > 1.5 && pr < 0.75) || (qr < 0.67 && pr > 1.33)) { 분할의심++; continue; }
        }
        const p = pb || pa;
        const 원 = dq * p * 환율;
        합 += 원;
        const s = 칸.종목[c] = 칸.종목[c] || [0, 0];
        s[0] += 원; s[1] += dq;
      }
      // 투자자 자금 = 상장주식수 변화 × NAV × 한국 비중 (그 펀드에 들어온 돈 중 한국 몫)
      const 한국비중 = b.mv ? 한국평가 / b.mv : 0;
      const 자금 = (b.sh - a.sh) * (b.mv / b.sh) * 환율 * 한국비중;
      칸.total += 합;
      칸.inv += 자금;
      칸.펀드[기호] = {
        krw: Math.round(합),
        invKrw: Math.round(자금),
        sharesChg: b.sh - a.sh,
        shares: b.sh,
        creationUsd: Math.round((b.sh - a.sh) * (b.mv / b.sh)),
        krWeight: b.mv ? Math.round(한국평가 / b.mv * 1000) / 10 : null,
        prev: d0,
      };
    }
  }

  const 날들 = Object.keys(날별).sort();
  const series = 날들.map(d => {
    const x = 날별[d], o = { date: d, total: Math.round(x.total), inv: Math.round(x.inv) };
    for (const [기호] of 펀드들) o[기호] = x.펀드[기호] ? x.펀드[기호].krw : null;
    return o;
  });

  let today = null;
  if (날들.length) {
    const d = 날들[날들.length - 1], x = 날별[d];
    const 이름 = c => {
      const k = 한글[c];
      if (k && k[0]) return k[0];
      for (const [기호] of 펀드들) { const e = h[기호] && h[기호].영문 && h[기호].영문[c]; if (e) return e; }
      return c;
    };
    const 줄 = Object.entries(x.종목).map(([c, [원, 주]]) => ({ code: c, name: 이름(c), krw: Math.round(원), qty: Math.round(주) }));
    today = {
      date: d,
      total: Math.round(x.total),
      inv: Math.round(x.inv),
      funds: 펀드들.map(([기호, , 설명]) => ({ symbol: 기호, name: 설명, ...(x.펀드[기호] || { missing: true }) })),
      buys: 줄.filter(r => r.krw > 0).sort((p, q) => q.krw - p.krw).slice(0, 10),
      sells: 줄.filter(r => r.krw < 0).sort((p, q) => p.krw - q.krw).slice(0, 10),
    };
  }

  const 누적 = n => {
    const 끝 = series.slice(-n);
    return { days: 끝.length, total: 끝.reduce((a, x) => a + x.total, 0), inv: 끝.reduce((a, x) => a + x.inv, 0) };
  };

  const 모인날 = {};
  for (const [기호] of 펀드들) 모인날[기호] = Object.keys((h[기호] && h[기호].days) || {}).length;

  결과.data = {
    generatedAt: new Date().toISOString(),
    funds: 펀드들.map(([s, , n]) => ({ symbol: s, name: n })),
    series,
    today,
    sum5: 누적(5),
    sum20: 누적(20),
    collected: 모인날,
    collecting: 상태.모으는중,
    splitSkipped: 분할의심,
  };
  결과.at = Date.now();
  return 결과.data;
}

module.exports = (app) => {
  app.get('/kr-etf-flow', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const d = await 계산();
      res.json({ ...d, collecting: 상태.모으는중 });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  app.get('/kr-etf-flow/status', (req, res) => {
    const h = 파일읽기();
    const 모인날 = {};
    for (const [기호] of 펀드들) {
      const ds = Object.keys((h[기호] && h[기호].days) || {}).sort();
      모인날[기호] = ds.length ? `${ds.length}일 (${ds[0]} ~ ${ds[ds.length - 1]})` : '0일';
    }
    res.json({ ...상태, 모인날 });
  });

  setTimeout(() => 모으기('서버 시작'), 45 * 1000);
  setInterval(() => 모으기('정기'), 다시모으기);
};
