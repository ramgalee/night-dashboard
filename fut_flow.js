// ═══════════════════════════════════════════════════════════
//  fut_flow.js — 코스피200 선물 투자자별 순매수 (네이버 증권)
//
//    GET /fut-flow            → { rows:[{ date, 개인, 외국인, 기관계 }], last, backfill }  단위 억원
//    GET /fut-flow/refresh    → 지금 바로 한 번 받기 (확인용)
//
//  키움 REST 에는 선물 자료가 없어 네이버 증권 모바일 자료를 씁니다.
//    https://m.stock.naver.com/api/index/FUT/trend
//  하루치만 주기 때문에 30분마다 받아 /root/app/fut_flow.json 에 쌓습니다.
//  (과거 날짜를 주는지 처음에 한 번 시험해서, 되면 60거래일을 채웁니다)
//  네이버가 주소를 바꾸면 멈추지만, 그동안 쌓인 날은 그대로 남습니다.
// ═══════════════════════════════════════════════════════════
const fs = require('fs');

const 파일 = '/root/app/fut_flow.json';
const 주소 = 'https://m.stock.naver.com/api/index/FUT/trend';
const 머리 = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Referer': 'https://m.stock.naver.com/domestic/index/FUT/total',
};
const 쉬기 = ms => new Promise(r => setTimeout(r, ms));

function 읽기() {
  try { return JSON.parse(fs.readFileSync(파일, 'utf8')); } catch (e) { return { days: {}, backfill: null }; }
}
function 쓰기(d) {
  try {
    const 임시 = 파일 + '.tmp';
    fs.writeFileSync(임시, JSON.stringify(d), 'utf8');
    fs.renameSync(임시, 파일);
  } catch (e) {}
}
const 숫자 = v => {
  const n = Number(String(v == null ? '' : v).replace(/[+,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};

async function 한날(날) {
  const r = await fetch(주소 + (날 ? `?bizdate=${날}` : ''), { headers: 머리 });
  if (!r.ok) throw new Error('네이버 ' + r.status);
  const j = await r.json();
  const x = Array.isArray(j) ? j[0] : j;
  if (!x || !x.bizdate) throw new Error('모양이 바뀜');
  return {
    date: String(x.bizdate).slice(0, 8),
    개인: 숫자(x.personalValue), 외국인: 숫자(x.foreignValue), 기관계: 숫자(x.institutionalValue),
  };
}

let 상태 = { at: null, error: null };
async function 모으기() {
  const d = 읽기();
  d.days = d.days || {};
  try {
    const x = await 한날(null);
    if (x.외국인 != null) d.days[x.date] = { 개인: x.개인, 외국인: x.외국인, 기관계: x.기관계 };
    상태 = { at: new Date().toISOString(), error: null };

    // 처음 한 번 — ?bizdate= 로 과거를 주는지 시험
    if (d.backfill == null) {
      const 시험날 = (() => {
        const t = new Date(Date.UTC(+x.date.slice(0, 4), +x.date.slice(4, 6) - 1, +x.date.slice(6, 8)));
        do { t.setUTCDate(t.getUTCDate() - 1); } while ([0, 6].includes(t.getUTCDay()));
        return t.toISOString().slice(0, 10).replace(/-/g, '');
      })();
      let 됨 = false;
      try { const y = await 한날(시험날); 됨 = y.date === 시험날 && JSON.stringify(y) !== JSON.stringify({ ...x, date: 시험날 }); } catch (e) {}
      d.backfill = 됨;
      if (됨) {
        // 평일만 거꾸로 90일(달력) — 휴장일은 네이버가 다른 날을 돌려주므로 날짜가 맞는 것만 씁니다
        const t = new Date(Date.UTC(+x.date.slice(0, 4), +x.date.slice(4, 6) - 1, +x.date.slice(6, 8)));
        for (let i = 0; i < 90; i++) {
          t.setUTCDate(t.getUTCDate() - 1);
          if ([0, 6].includes(t.getUTCDay())) continue;
          const 날 = t.toISOString().slice(0, 10).replace(/-/g, '');
          if (d.days[날]) continue;
          try {
            const y = await 한날(날);
            if (y.date === 날 && y.외국인 != null) d.days[날] = { 개인: y.개인, 외국인: y.외국인, 기관계: y.기관계 };
          } catch (e) {}
          await 쉬기(700);
        }
      }
    }
  } catch (e) {
    상태 = { at: new Date().toISOString(), error: String(e.message || e) };
  }
  // 400일만 보관
  const 날들 = Object.keys(d.days).sort();
  while (날들.length > 400) delete d.days[날들.shift()];
  쓰기(d);
  return d;
}

module.exports = (app) => {
  setTimeout(모으기, 50 * 1000);                  // 서버가 뜨고 50초 뒤
  setInterval(모으기, 30 * 60 * 1000);            // 그다음 30분마다

  app.get('/fut-flow', (req, res) => {
    const d = 읽기();
    const 부터 = String(req.query.from || '').replace(/\D/g, '');
    const rows = Object.keys(d.days || {}).sort().filter(k => !부터 || k >= 부터)
      .map(k => ({ date: k, ...d.days[k] }));
    res.json({ rows, last: rows.length ? rows[rows.length - 1].date : null, backfill: d.backfill, ...상태 });
  });

  app.get('/fut-flow/refresh', async (req, res) => {
    const d = await 모으기();
    const 날들 = Object.keys(d.days || {}).sort();
    res.json({ days: 날들.length, first: 날들[0] || null, last: 날들[날들.length - 1] || null,
               backfill: d.backfill, lastRow: d.days[날들[날들.length - 1]] || null, ...상태 });
  });
};
