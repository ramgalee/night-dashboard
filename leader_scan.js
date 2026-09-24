// 오늘의 주도주 찾기
//   GET /leader-scan
//
// 거래대금 상위 150 중 등락률 상위 50을 후보로 두고, 종목마다
//   · 수급 오실레이터가 어떤 상태인지
//     (양수 전환 / 음수에서 반등 / 양수에서 상승 / 양수이나 둔화 / 음수 전환 / 내림세)
//   · 며칠째 이어지는지
//   · 오늘 오른 테마에 속하는지
//   · 60일 신고가나 정배열인지
// 를 붙여 돌려줍니다. 점수로 줄이지 않습니다.
// (양수에서 오래 오른 종목은 과매수일 수 있어, 한 숫자로 합치면 판단이 흐려집니다.)
//
// 회원마다 종목을 하나씩 부르면 키움 호출이 감당이 안 되므로,
// 서버가 한 번 계산해 5분간 나눠 씁니다.
const fs = require('fs');
const path = require('path');

const 안 = 'http://127.0.0.1:3000';
const 신선 = 5 * 60 * 1000;
const 간격 = 300;                  // 종목 사이 쉬는 시간(ms) — 키움이 밀리지 않게 하나씩 천천히
const 테마상위 = 12;               // 오늘 오른 테마 몇 개까지를 '상위'로 볼지
// ETF·레버리지·리츠는 주도주를 찾는 목록에서 뺍니다.
const 뺄이름 = /(^|\s)(KODEX|TIGER|PLUS|ACE|SOL|RISE|HANARO|KOSEF|ARIRANG|TIMEFOLIO|KIWOOM|SMART|FOCUS|BNK|WOORI|마이다스|히어로즈|파워|TREX|UNICORN|VITA|이지스|하이|마이티)\s|(레버리지|인버스|선물\s?ETN|\bETN\b|스팩|리츠)/i;

async function 내부(경로, 시도 = 2) {
  let 마지막;
  for (let i = 0; i < 시도; i++) {
    try {
      const ac = new AbortController();
      const 시계 = setTimeout(() => ac.abort(), 15000);
      const r = await fetch(안 + 경로, { signal: ac.signal });
      clearTimeout(시계);
      if (!r.ok) throw new Error(경로 + ' → ' + r.status);
      return await r.json();
    } catch (e) {
      마지막 = e;
      if (i < 시도 - 1) await new Promise(r => setTimeout(r, 400));
    }
  }
  throw 마지막;
}

// rs.json 은 GitHub 에 올리는 파일이라 그쪽에서 읽습니다 (6시간 보관).
let RS = null, RS_AT = 0;
async function rs읽기() {
  if (RS && Date.now() - RS_AT < 6 * 3600 * 1000) return RS;
  try {
    const r = await fetch('https://raw.githubusercontent.com/ramgalee/night-dashboard/main/rs.json');
    if (!r.ok) throw new Error('rs ' + r.status);
    const j = await r.json();
    RS = j.data || {};
    RS_AT = Date.now();
  } catch (e) {
    if (!RS) RS = {};
  }
  return RS;
}

function 테마표읽기() {
  for (const p of ['/root/app/theme_map.json', path.join(__dirname, 'theme_map.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) {}
  }
  return null;
}

// 오실레이터 상태를 읽습니다.
function 상태보기(series) {
  const a = (series || []).filter(x => typeof x.oscillator === 'number');
  if (a.length < 2) return null;
  const 오늘 = a[a.length - 1], 어제 = a[a.length - 2];
  const o = 오늘.oscillator, y = 어제.oscillator;

  let 상태 = '해당 없음';
  if (o > 0 && y <= 0) 상태 = '양수 전환';          // 0 아래에서 위로 올라선 첫날
  else if (o <= 0 && y > 0) 상태 = '음수 전환';      // 0 위에서 아래로 내려선 첫날
  else if (o > 0 && o > y) 상태 = '양수에서 상승';
  else if (o > 0) 상태 = '양수이나 둔화';
  else if (o > y) 상태 = '음수에서 반등';
  else 상태 = '내림세';

  // 며칠째 같은 흐름인지
  let 연속 = 1;
  for (let i = a.length - 2; i >= 1; i--) {
    const 위 = o > 0 ? a[i].oscillator > 0 : a[i].oscillator > a[i - 1].oscillator;
    if (!위) break;
    연속 += 1;
  }
  return { osc: o, prevOsc: y, 상태, 연속: Math.min(연속, 60), date: 오늘.date, close: 오늘.close };
}

const 캐시 = { data: null, at: 0, 도는중: null, 진행: 0, 전체: 0 };

async function 훑기() {
  if (캐시.도는중) return await 캐시.도는중;

  캐시.도는중 = (async () => {
    // 1) 후보 — 거래대금 상위 150 에서 ETF 를 먼저 빼고, 등락률 상위 50을 다시 세웁니다.
    //    서버가 주는 up50 은 ETF 를 포함해 고른 것이라, 거기서 빼면 50개가 안 채워집니다.
    const tr = await 내부('/trade-rank');
    const 바탕 = (tr.top150 || []).filter(x => x && x.code && !뺄이름.test(String(x.name || '')));
    const 골라낸 = 바탕.length
      ? 바탕.filter(x => x.changePct != null)
            .sort((a, b) => b.changePct - a.changePct)
            .slice(0, 50)
      : (tr.up50 || tr.up || []).filter(x => x && x.code && !뺄이름.test(String(x.name || '')));
    const 후보 = 골라낸.map((r, i) => ({
      code: String(r.code || '').trim(), name: r.name, market: r.market,
      changePct: r.changePct, 등락순위: i + 1,
    })).filter(x => x.code);

    // 2) 오늘 오른 테마와, 그 테마에 든 종목
    let 테마이름 = {}, 오른테마 = [];
    try {
      const th = await 내부('/infra-theme');
      오른테마 = (th.themes || []).filter(x => x.changePct != null)
        .sort((a, b) => b.changePct - a.changePct).slice(0, 테마상위);
      const 표 = 테마표읽기();
      if (표 && 표.themes) {
        for (const t of 오른테마) {
          for (const c of (표.themes[t.name] || [])) {
            (테마이름[c] = 테마이름[c] || []).push(t.name);
          }
        }
      }
    } catch (e) {}

    const rs = await rs읽기();

    // 3) 종목마다 오실레이터 — 하나씩 천천히 부릅니다.
    //    한꺼번에 부르면 키움이 밀려 대부분 빈손으로 돌아옵니다.
    const 결과 = [];
    캐시.진행 = 0; 캐시.전체 = 후보.length;
    for (const x of 후보) {
      캐시.진행 += 1;
      let s = null;
      try {
        const d = await 내부('/flow-oscillator?code=' + encodeURIComponent(x.code), 2);
        s = 상태보기(d.series);
      } catch (e) { s = null; }
      {
        const v = rs[x.code] || {};
        const 테마 = 테마이름[x.code] || [];
        결과.push({
          ...x,
          osc: s ? s.osc : null, prevOsc: s ? s.prevOsc : null,
          상태: s ? s.상태 : '자료 없음', 연속: s ? s.연속 : null,
          테마, rs: v.rs ?? null, high60: !!v.high60, aligned: !!v.aligned,
        });
      }
      await new Promise(r => setTimeout(r, 간격));
    }

    // 양수 전환을 맨 위로, 그다음 음수에서 반등, 나머지는 뒤로.
    // 같은 상태끼리는 등락률 순입니다.
    const 순서 = { '양수 전환': 0, '음수에서 반등': 1, '양수에서 상승': 2,
                   '양수이나 둔화': 3, '음수 전환': 4, '내림세': 5, '자료 없음': 6 };
    결과.sort((a, b) =>
      (순서[a.상태] ?? 9) - (순서[b.상태] ?? 9) ||
      (b.changePct ?? -99) - (a.changePct ?? -99));

    const out = {
      generatedAt: new Date().toISOString(),
      count: 결과.length,
      themes: 오른테마.map(t => ({ name: t.name, changePct: t.changePct })),
      items: 결과,
    };
    캐시.data = out; 캐시.at = Date.now();
    return out;
  })();

  try { return await 캐시.도는중; }
  finally { 캐시.도는중 = null; }
}

// 뒤에서 미리 계산해 둡니다. 화면은 계산이 끝난 결과만 받아 가므로 기다리지 않습니다.
function 뒤에서() {
  if (캐시.도는중) return;
  훑기().catch(() => {});
}

// 장중에는 5분마다, 장이 닫혀 있으면 30분마다 새로 훑습니다.
function 장중인가() {
  const t = new Date(Date.now() + 9 * 3600e3);          // 한국 시간
  const 요일 = t.getUTCDay(), 분 = t.getUTCHours() * 60 + t.getUTCMinutes();
  return 요일 >= 1 && 요일 <= 5 && 분 >= 8 * 60 + 50 && 분 <= 15 * 60 + 45;
}
let 마지막시작 = 0;
setInterval(() => {
  const 주기 = 장중인가() ? 5 * 60 * 1000 : 30 * 60 * 1000;
  if (Date.now() - 마지막시작 < 주기) return;
  마지막시작 = Date.now();
  뒤에서();
}, 60 * 1000);

module.exports = (app) => {
  app.get('/leader-scan', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');

    // 결과가 낡았으면 뒤에서 새로 계산을 시작하되, 응답은 기다리지 않습니다.
    if (!캐시.도는중 && (!캐시.data || Date.now() - 캐시.at > 신선)) {
      마지막시작 = Date.now();
      뒤에서();
    }
    if (캐시.data) {
      return res.json({
        ...캐시.data,
        stale: Date.now() - 캐시.at > 신선,
        계산중: !!캐시.도는중,
      });
    }
    res.json({ ready: false, 계산중: true, 진행: 캐시.진행, 전체: 캐시.전체, items: [] });
  });
};

뒤에서();                                                 // 서버가 켜질 때 한 번
