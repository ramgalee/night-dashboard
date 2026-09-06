// 종목별 일별 투자자 매매동향 (키움 ka10059)
// 한 번 호출로 여러 날짜가 오므로, 최신 날짜부터 거슬러 올라가며 모읍니다.
// 받은 데이터는 파일에 저장해 다시 부르지 않습니다.
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
const STORE = '/root/app/stock_flow.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function num(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s]/g, '');
  const neg = t.indexOf('-') >= 0;
  const n = Number(t.replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

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

const load = () => { try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return {}; } };
const save = db => fs.writeFileSync(STORE, JSON.stringify(db), 'utf8');

function pack(x) {
  return {
    종가: num(x.cur_prc) == null ? null : Math.abs(num(x.cur_prc)),
    등락률: num(x.flu_rt) == null ? null : num(x.flu_rt) / 100,
    거래량: num(x.acc_trde_qty),
    거래대금: num(x.acc_trde_prica),
    개인: num(x.ind_invsr),
    외국인: num(x.frgnr_invsr),
    기관계: num(x.orgn),
    금융투자: num(x.fnnc_invt),
    보험: num(x.insrnc),
    투신: num(x.invtrt),
    기타금융: num(x.etc_fnnc),
    은행: num(x.bank),
    연기금: num(x.penfnd_etc),
    사모펀드: num(x.samo_fund),
    국가: num(x.natn),
    기타법인: num(x.etc_corp),
    내외국인: num(x.natfor),
  };
}

// 기준일에서 거슬러 올라가며 채웁니다. 한 번에 여러 날짜가 옵니다.
async function collect(code, from, db) {
  let cursor = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  let guard = 0;

  while (cursor >= from && guard < 40) {
    guard++;
    const j = await call({
      dt: cursor, stk_cd: code, amt_qty_tp: '1', trde_tp: '0', unit_tp: '1000'
    });
    await sleep(300);
    if (j.return_code && j.return_code !== 0) break;

    const list = j.stk_invsr_orgn || [];
    if (!list.length) break;

    let oldest = null;
    for (const x of list) {
      const dt = String(x.dt || '').trim();
      if (dt.length !== 8) continue;
      db[code + '|' + dt] = pack(x);
      if (oldest === null || dt < oldest) oldest = dt;
    }
    if (!oldest || oldest <= from) break;

    // 가장 오래된 날짜 하루 전으로 커서를 옮깁니다.
    const d = new Date(Number(oldest.slice(0, 4)), Number(oldest.slice(4, 6)) - 1, Number(oldest.slice(6, 8)) - 1);
    const next = String(d.getFullYear()) + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    if (next >= cursor) break;
    cursor = next;
  }
}

module.exports = (app) => {
  app.get('/stock-flow', async (req, res) => {
    try {
      const codes = String(req.query.codes || '005930')
        .split(',').map(s => s.trim().replace(/\D/g, '').padStart(6, '0')).filter(Boolean);
      const from = String(req.query.from || '20260101').replace(/\D/g, '');
      const refresh = String(req.query.refresh || '') === '1';

      const db = load();
      const before = Object.keys(db).length;

      for (const code of codes) {
        const have = Object.keys(db).filter(k => k.startsWith(code + '|')).sort();
        // 이미 from 까지 모여 있고 최근 것도 있으면 최신 구간만 갱신합니다.
        const need = refresh || !have.length || have[0] > from;
        const start = need ? from : (have[have.length - 1] || from);
        await collect(code, start, db);
      }
      save(db);

      const out = {};
      for (const code of codes) {
        const rows = Object.keys(db)
          .filter(k => k.startsWith(code + '|') && k.slice(7) >= from)
          .sort()
          .map(k => Object.assign({ date: k.slice(7) }, db[k]));
        out[code] = rows;
      }

      res.json({ from, added: Object.keys(db).length - before, data: out });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
