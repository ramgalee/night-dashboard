// 오늘의 주도주 찾기
//   GET /leader-scan
//
// 거래대금 상위 150 중 등락률 상위 50을 후보로 두고, 종목마다
//   · 수급 오실레이터가 어떤 상태인지 (막 돌아섬 / 양수에서 상승 / 음수에서 반등)
//   · 며칠째 이어지는지
//   · 오늘 오른 테마에 속하는지
//   · 60일 신고가나 정배열인지
// 를 붙여 점수를 냅니다.
//
// 회원마다 종목을 하나씩 부르면 키움 호출이 감당이 안 되므로,
// 서버가 한 번 계산해 5분간 나눠 씁니다.
const fs = require('fs');
const path = require('path');

const 안 = 'http://127.0.0.1:3000';
const 신선 = 5 * 60 * 1000;
const 동시 = 4;                    // 한 번에 부르는 종목 수
const 테마상위 = 12;               // 오늘 오른 테마 몇 개까지를 '상위'로 볼지

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
  if (o > 0 && y <= 0) 상태 = '막 돌아섬';
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

const 캐시 = { data: null, at: 0, 도는중: null };

async function 훑기() {
  if (캐시.data && Date.now() - 캐시.at < 신선) return 캐시.data;
  if (캐시.도는중) return await 캐시.도는중;

  캐시.도는중 = (async () => {
    // 1) 후보 — 거래대금 상위 150 중 등락률 상위 50
    const tr = await 내부('/trade-rank');
    const 후보 = (tr.up50 || tr.up || []).map((r, i) => ({
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

    // 3) 종목마다 오실레이터 — 몇 개씩 나눠 부릅니다
    const 결과 = [];
    for (let i = 0; i < 후보.length; i += 동시) {
      const 묶음 = 후보.slice(i, i + 동시);
      const 받음 = await Promise.all(묶음.map(async x => {
        try {
          const d = await 내부('/flow-oscillator?code=' + encodeURIComponent(x.code), 1);
          return 상태보기(d.series);
        } catch (e) { return null; }
      }));
      묶음.forEach((x, k) => {
        const s = 받음[k];
        const v = rs[x.code] || {};
        const 테마 = 테마이름[x.code] || [];
        const 점수 =
          (x.changePct > 0 ? 1 : 0) +
          (s && s.osc > 0 ? 1 : 0) +
          (s && s.osc > s.prevOsc ? 1 : 0) +
          (테마.length ? 1 : 0) +
          ((v.high60 || v.aligned) ? 1 : 0);
        결과.push({
          ...x,
          osc: s ? s.osc : null, prevOsc: s ? s.prevOsc : null,
          상태: s ? s.상태 : '자료 없음', 연속: s ? s.연속 : null,
          테마, rs: v.rs ?? null, high60: !!v.high60, aligned: !!v.aligned,
          점수,
        });
      });
      await new Promise(r => setTimeout(r, 120));
    }

    결과.sort((a, b) => b.점수 - a.점수 || (b.changePct ?? -99) - (a.changePct ?? -99));

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

module.exports = (app) => {
  app.get('/leader-scan', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      res.json(await 훑기());
    } catch (e) {
      if (캐시.data) return res.json({ ...캐시.data, stale: true });
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
