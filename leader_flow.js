// 시가총액 상위 종목의 일자별 시총대비 수급 + 수급오실레이터
//   시총·종목명·시장: marketcap.json (GitHub Raw) — info 항목이 있어야 합니다
//   수급: 키움 ka10059 종목별투자자기관별 (_AL 통합 기준)
//
// 구조: 서버가 뒤에서 3시간마다 혼자 모아 파일에 저장하고,
//       화면 요청은 저장된 파일을 그대로 즉시 돌려줍니다.
//       (요청 안에서 모으면 20초 넘게 걸려 Vercel 함수가 끊깁니다)
const fs = require('fs');

const env = {};
try {
  for (const line of fs.readFileSync('/root/app/.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (e) {}

const pick = (...ns) => { for (const n of ns) if (env[n]) return env[n]; return null; };
const APP_KEY = pick('KIWOOM_APP_KEY', 'APP_KEY', 'KIWOOM_APPKEY', 'APPKEY', 'KIWOOM_KEY');
const APP_SECRET = pick('KIWOOM_APP_SECRET', 'APP_SECRET', 'KIWOOM_SECRETKEY', 'SECRETKEY', 'SECRET_KEY', 'KIWOOM_SECRET');

const BASE = 'https://api.kiwoom.com';
const CAP_URL = 'https://raw.githubusercontent.com/ramgalee/night-dashboard/main/marketcap.json';
const STORE = '/root/app/leader_flow.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOP_N = 30;                 // 시장별 시총 상위 몇 종목
const DAYS = 20;                  // 며칠치 수급
const REFRESH_MS = 3 * 3600e3;    // 3시간마다 다시 모음
const SKIP_PREF = true;           // 우선주 제외 (삼성전자우 등)

function num(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s]/g, '');
  const neg = t.indexOf('-') >= 0;
  const n = Number(t.replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const 우선주 = name => /우(B|C)?$/.test(String(name || '').trim());

let TOKEN = null, TOKEN_AT = 0;

async function getToken(force) {
  if (!force && TOKEN && Date.now() - TOKEN_AT < 50 * 60 * 1000) return TOKEN;
  const r = await fetch(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, secretkey: APP_SECRET })
  });
  const j = await r.json();
  if (!j.token) throw new Error('token fail');
  TOKEN = j.token; TOKEN_AT = Date.now();
  return TOKEN;
}

async function callOnce(body, force) {
  const token = await getToken(force);
  const r = await fetch(BASE + '/api/dostk/stkinfo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka10059', 'cont-yn': 'N', 'next-key': ''
    },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { throw new Error(r.status + ' ' + t.slice(0, 100)); }
}

async function call(body) {
  let j;
  try { j = await callOnce(body, false); }
  catch (e) { TOKEN = null; return await callOnce(body, true); }
  if (j && j.return_code && j.return_code !== 0 && /8005|token|만료|인증/i.test(String(j.return_msg || ''))) {
    TOKEN = null;
    j = await callOnce(body, true);
  }
  return j;
}

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

// ── 시가총액 ─────────────────────────────────────
const CAP = { data: null, info: null, at: 0, date: null };

async function getCaps() {
  if (CAP.data && Date.now() - CAP.at < 30 * 60 * 1000) return CAP;
  const r = await fetch(CAP_URL, { headers: { 'Cache-Control': 'no-cache' } });
  if (!r.ok) throw new Error('marketcap ' + r.status);
  const j = await r.json();
  if (!j || !j.caps) throw new Error('marketcap empty');
  CAP.data = j.caps;
  CAP.info = j.info || null;
  CAP.date = j.date || null;
  CAP.at = Date.now();
  return CAP;
}

// ── 종목 하나의 일별 수급 ─────────────────────────
let 단위확인함 = false;

async function flowOf(code) {
  const j = await call({
    dt: today(), stk_cd: code + '_AL',
    amt_qty_tp: '1', trde_tp: '0', unit_tp: '1000'
  });
  if (j.return_code && j.return_code !== 0) throw new Error(j.return_msg || 'ka10059');

  const raw = j.stk_invsr_orgn || [];

  // 단위 확인용 — 서버 시작 후 첫 종목 한 번만 원본을 찍습니다.
  // pm2 logs 에서 외국인 값의 자릿수를 눈으로 확인하세요.
  if (!단위확인함 && raw.length) {
    단위확인함 = true;
    const s = raw[0];
    console.log('[leader_flow] 단위확인', code,
      'dt=' + s.dt, 'cur_prc=' + s.cur_prc,
      'frgnr_invsr=' + s.frgnr_invsr, 'orgn=' + s.orgn);
  }

  return raw
    .map(x => ({
      date: String(x.dt || '').slice(0, 8),
      close: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
      changePct: num(x.flu_rt) == null ? null : num(x.flu_rt) / 100,
      개인: num(x.ind_invsr),
      외국인: num(x.frgnr_invsr),
      기관: num(x.orgn),
    }))
    .filter(x => x.date.length === 8)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-DAYS);
}

// ── 수급오실레이터 ────────────────────────────────
function emaArr(a, n) {
  const k = 2 / (n + 1);
  let p = null;
  return a.map(v => { p = p == null ? v : v * k + p * (1 - k); return p; });
}

// 외국인+기관 시총대비 순매수의 누적선에 MACD(5,10,4)를 겁니다.
// 20일치라 기간이 짧아 12·26·9 대신 짧은 값을 씁니다.
function oscillator(rows, cap) {
  const ratio = rows.map(r => ((r.외국인 || 0) + (r.기관 || 0)) * 1e6 / cap * 100);
  let acc = 0;
  const cum = ratio.map(v => (acc += v));
  const e5 = emaArr(cum, 5), e10 = emaArr(cum, 10);
  const macd = cum.map((_, i) => e5[i] - e10[i]);
  const sig = emaArr(macd, 4);
  return macd.map((v, i) => Number((v - sig[i]).toFixed(4)));
}

// ── 모으기 ───────────────────────────────────────
const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return null; } };
const save = d => { try { fs.writeFileSync(STORE, JSON.stringify(d), 'utf8'); } catch (e) { console.log('[leader_flow] 저장 실패', e.message); } };

async function build() {
  const t0 = Date.now();
  const caps = await getCaps();
  if (!caps.info) throw new Error('marketcap.json 에 info(종목명·시장)가 없습니다. 노트북 marketcap 칸을 새로 돌려 올려주세요.');

  const 후보 = { KOSPI: [], KOSDAQ: [] };
  let 우선주뺌 = 0;
  for (const [code, cap] of Object.entries(caps.data)) {
    const meta = caps.info[code];
    if (!meta) continue;
    const [name, market] = meta;
    if (!후보[market]) continue;
    if (SKIP_PREF && 우선주(name)) { 우선주뺌++; continue; }
    후보[market].push({ code, name, market, cap });
  }
  for (const k of Object.keys(후보)) {
    후보[k].sort((a, b) => b.cap - a.cap);
    후보[k] = 후보[k].slice(0, TOP_N);
  }

  const out = { KOSPI: [], KOSDAQ: [] };
  const 실패 = [];

  for (const market of ['KOSPI', 'KOSDAQ']) {
    for (const s of 후보[market]) {
      let rows = null;
      try {
        rows = await flowOf(s.code);
      } catch (e) {
        실패.push({ code: s.code, name: s.name, why: String((e && e.message) || e).slice(0, 60) });
        await sleep(500);
        continue;
      }
      await sleep(320);
      if (!rows.length) { 실패.push({ code: s.code, name: s.name, why: '빈 응답' }); continue; }

      const last = rows[rows.length - 1];
      out[market].push({
        code: s.code, name: s.name, market, cap: s.cap,
        close: last.close,
        changePct: last.changePct,
        dates: rows.map(r => r.date),
        flow: {
          외국인: rows.map(r => Number((((r.외국인 || 0) * 1e6) / s.cap * 100).toFixed(4))),
          기관: rows.map(r => Number((((r.기관 || 0) * 1e6) / s.cap * 100).toFixed(4))),
          개인: rows.map(r => Number((((r.개인 || 0) * 1e6) / s.cap * 100).toFixed(4))),
        },
        osc: oscillator(rows, s.cap),
      });
    }
  }

  const 초 = Math.round((Date.now() - t0) / 1000);
  console.log(`[leader_flow] 완료 ${초}초 · 코스피 ${out.KOSPI.length} · 코스닥 ${out.KOSDAQ.length} · 실패 ${실패.length} · 우선주제외 ${우선주뺌}`);

  return {
    capDate: caps.date,
    days: DAYS,
    topN: TOP_N,
    data: out,
    failed: 실패,
    buildSec: 초,
    generatedAt: new Date().toISOString(),
  };
}

// ── 뒤에서 혼자 모으기 ────────────────────────────
let 모으는중 = false;
let 마지막오류 = null;

async function refresh(why) {
  if (모으는중) return;
  모으는중 = true;
  console.log('[leader_flow] 수집 시작 (' + why + ')');
  try {
    const db = await build();
    save(db);
    마지막오류 = null;
  } catch (e) {
    마지막오류 = String((e && e.message) || e);
    console.log('[leader_flow] 수집 실패:', 마지막오류);
  } finally {
    모으는중 = false;
  }
}

module.exports = (app) => {
  // 서버가 뜨고 30초 뒤 첫 수집, 그다음 3시간마다.
  setTimeout(() => refresh('서버 시작'), 30 * 1000);
  setInterval(() => refresh('정기'), REFRESH_MS);

  app.get('/leader-flow', (req, res) => {
    // ?refresh=1 을 붙이면 수집을 시작시키되 기다리지는 않습니다.
    if (String(req.query.refresh || '') === '1') refresh('수동');

    const db = load();
    if (!db) {
      return res.status(503).json({
        error: 마지막오류 || '아직 모으는 중입니다. 1~2분 뒤 새로고침해 주세요.',
        building: 모으는중,
      });
    }

    const 나이 = Date.now() - new Date(db.generatedAt).getTime();
    if (나이 > REFRESH_MS) refresh('오래됨');

    res.json(Object.assign({}, db, {
      ageMin: Math.round(나이 / 60000),
      building: 모으는중,
      lastError: 마지막오류,
    }));
  });
};
