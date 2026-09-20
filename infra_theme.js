// 인포스탁 테마 히트맵 — 분류는 theme_map.json, 등락률은 우리가 계산
//   /infra-theme              테마별 등락률 · 2분 캐시
//   /infra-theme?code=전선    그 테마 구성종목
//
// 키움을 직접 부르지 않고, 이미 잘 도는 /sector-map · /sector-stocks 를 빌려 씁니다.
// 업종 코드를 짐작할 필요가 없고, sector_map.js 가 고쳐지면 같이 따라갑니다.
const fs = require('fs');
const path = require('path');

const 안 = 'http://127.0.0.1:3000';

async function 내부(경로, 시도 = 3) {
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
      if (i < 시도 - 1) await new Promise(r => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw 마지막;
}

// ── 매핑표 ───────────────────────────────────────
let MAP = null, MAP_AT = 0;
function 매핑() {
  if (MAP && Date.now() - MAP_AT < 10 * 60 * 1000) return MAP;
  for (const p of ['/root/app/theme_map.json', path.join(__dirname, 'theme_map.json')]) {
    try {
      MAP = JSON.parse(fs.readFileSync(p, 'utf8'));
      MAP_AT = Date.now();
      return MAP;
    } catch (e) {}
  }
  throw new Error('theme_map.json 을 찾지 못했습니다');
}

// ── 전 종목 시세 모으기 ──────────────────────────
const 시세캐시 = { data: null, at: 0, 업종수: 0, 실패: [], 도는중: null };
const 최소종목 = 1800;      // 이보다 적게 모이면 부실한 것으로 봅니다

async function 전종목() {
  if (시세캐시.data && Date.now() - 시세캐시.at < 180 * 1000) return 시세캐시.data;
  // 한 바퀴에 25초쯤 걸리므로, 도는 중에 또 부르면 그 결과를 같이 기다립니다.
  if (시세캐시.도는중) return await 시세캐시.도는중;
  시세캐시.도는중 = (async () => {
  const 표 = new Map();
  let 업종수 = 0;
  const 실패 = [];

  for (const 시장 of ['KOSPI', 'KOSDAQ']) {
    let 목록 = [];
    try {
      const m = await 내부(`/sector-map?market=${시장}`);
      // 종목이 0인 것(변동성지수·선물지수 등)은 불러도 빈값이라 건너뜁니다.
      목록 = (m.sectors || m.items || m.data || [])
        .filter(x => (x.stocks == null) || x.stocks > 0)
        .map(x => String(x.code || x.inds_cd || '').trim())
        .filter(Boolean);
    } catch (e) { 실패.push(`${시장} 업종목록`); 목록 = []; }

    for (const 코드 of 목록) {
      try {
        const d = await 내부(`/sector-stocks?market=${시장}&code=${encodeURIComponent(코드)}`);
        const rows = d.items || d.stocks || [];
        if (!rows.length) 실패.push(`${시장}/${코드}(빈값)`);
        for (const x of rows) {
          const c = String(x.code || '').replace(/_AL$/, '').trim();
          if (!c || 표.has(c)) continue;
          표.set(c, {
            code: c,
            name: String(x.name || '').trim(),
            price: x.price ?? null,
            changePct: x.changePct ?? null,
            volume: x.volume ?? null,
            tradeValue: x.tradeValue ?? 0,
          });
        }
        업종수 += 1;
      } catch (e) {
        실패.push(`${시장}/${코드}`);
      }
      await new Promise(r => setTimeout(r, 400));   // 키움 호출 제한에 걸리지 않게
    }
  }

  // 지난번보다 줄었으면 지난 결과를 그대로 씁니다.
  // 업종 몇 개가 실패한 채로 2분간 부실한 값이 나가지 않게 합니다.
  // 상장·폐지로 하루에 5% 넘게 줄 일은 없으므로 그보다 적으면 실패로 봅니다.
  const 지난 = 시세캐시.data;
  if (지난 && 지난.size >= 최소종목 && 표.size < 지난.size * 0.95) {
    시세캐시.at = Date.now() - 150 * 1000;     // 30초 뒤 다시 시도
    시세캐시.실패 = 실패;
    return 지난;
  }

  시세캐시.data = 표; 시세캐시.at = Date.now();
  시세캐시.업종수 = 업종수; 시세캐시.실패 = 실패;
  return 표;
  })();
  try { return await 시세캐시.도는중; }
  finally { 시세캐시.도는중 = null; }
}

// ── 테마별 집계 ──────────────────────────────────
const 집계캐시 = { data: null, at: 0 };
const 집계주기 = 180 * 1000;   // 시세 캐시와 맞춥니다

async function 테마집계() {
  if (집계캐시.data && Date.now() - 집계캐시.at < 집계주기) return 집계캐시.data;

  const m = 매핑();
  const 시세 = await 전종목();

  const rows = [];
  for (const [이름, 코드들] of Object.entries(m.themes || {})) {
    const 값 = [];
    for (const c of 코드들) {
      const s = 시세.get(c);
      if (s && s.changePct != null) 값.push(s);
    }
    if (!값.length) {
      rows.push({ name: 이름, count: 코드들.length, matched: 0,
                  changePct: null, rising: 0, falling: 0, lead: [] });
      continue;
    }
    // 거래대금으로 가중합니다. 큰 종목이 테마를 끄는 정도를 반영합니다.
    const W = 값.reduce((a, x) => a + (x.tradeValue || 0), 0);
    const 가중 = W > 0
      ? 값.reduce((a, x) => a + x.changePct * (x.tradeValue || 0), 0) / W
      : 값.reduce((a, x) => a + x.changePct, 0) / 값.length;
    const 단순 = 값.reduce((a, x) => a + x.changePct, 0) / 값.length;
    const 정렬 = 값.slice().sort((a, b) => b.changePct - a.changePct);
    rows.push({
      name: 이름,
      count: 코드들.length,
      matched: 값.length,
      changePct: Math.round(가중 * 100) / 100,
      simplePct: Math.round(단순 * 100) / 100,
      rising: 값.filter(x => x.changePct > 0).length,
      falling: 값.filter(x => x.changePct < 0).length,
      lead: 정렬.slice(0, 3).map(x => x.name),
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: m.source || '인포스탁 섹터',
    mapAt: m.generatedAt || null,
    count: rows.length,
    priced: 시세.size,
    sectors: 시세캐시.업종수,
    failed: 시세캐시.실패.length,
    failedList: 시세캐시.실패.slice(0, 10),
    themes: rows,
  };
  집계캐시.data = out; 집계캐시.at = Date.now();
  return out;
}

async function 테마종목(이름) {
  const m = 매핑();
  const 코드들 = (m.themes || {})[이름];
  if (!코드들) throw new Error('없는 테마: ' + 이름);
  const 시세 = await 전종목();
  const list = 코드들.map(c => {
    const s = 시세.get(c);
    return {
      code: c,
      name: (m.names || {})[c] || (s && s.name) || c,
      price: s ? s.price : null,
      changePct: s ? s.changePct : null,
      volume: s ? s.volume : null,
    };
  });
  list.sort((a, b) => (b.changePct ?? -99) - (a.changePct ?? -99));
  return { name: 이름, count: list.length, generatedAt: new Date().toISOString(), stocks: list };
}

module.exports = (app) => {
  app.get('/infra-theme', async (req, res) => {
    const 이름 = String(req.query.code || req.query.name || '').trim();
    try {
      res.json(이름 ? await 테마종목(이름) : await 테마집계());
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 업종 목록·종목이 어떤 이름으로 오는지 확인용
  app.get('/infra-raw', async (req, res) => {
    try {
      const m = await 내부('/sector-map?market=KOSPI');
      const 키 = Object.keys(m);
      const 배열 = m.sectors || m.items || m.data || [];
      const 첫 = 배열[0] || null;
      let 종목 = null;
      if (첫) {
        const c = String(첫.code || 첫.inds_cd || '');
        const d = await 내부(`/sector-stocks?market=KOSPI&code=${encodeURIComponent(c)}`);
        종목 = { 키: Object.keys(d), 개수: (d.items || d.stocks || []).length,
                 첫줄: (d.items || d.stocks || [])[0] || null };
      }
      res.json({ 업종응답키: 키, 업종개수: 배열.length, 업종첫줄: 첫, 종목: 종목 });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
