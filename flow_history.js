// 일별 투자자 매매동향 (코스피/코스닥)
// 키움 ka10051 을 날짜별로 호출해 모아두고 파일에 저장합니다.
// 한 번 받은 날짜는 다시 부르지 않아, 처음만 오래 걸리고 이후에는 빠릅니다.
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
const STORE = '/root/app/flow_history.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const MARKETS = [
  { key: 'KOSPI', mrkt: '0', inds: '001_AL' },
  { key: 'KOSDAQ', mrkt: '1', inds: '101_AL' },
];

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
  const r = await fetch(BASE + '/api/dostk/sect', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + token,
      'api-id': 'ka10051', 'cont-yn': 'N', 'next-key': ''
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

function load() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { return {}; }
}
function save(db) {
  fs.writeFileSync(STORE, JSON.stringify(db), 'utf8');
}

// YYYYMMDD 목록을 만듭니다(주말 제외. 공휴일은 응답이 비면 자동으로 걸러집니다).
function businessDays(from, to) {
  const out = [];
  const d = new Date(Number(from.slice(0, 4)), Number(from.slice(4, 6)) - 1, Number(from.slice(6, 8)));
  const end = new Date(Number(to.slice(0, 4)), Number(to.slice(4, 6)) - 1, Number(to.slice(6, 8)));
  while (d <= end) {
    const w = d.getDay();
    if (w !== 0 && w !== 6) {
      out.push(String(d.getFullYear())
        + String(d.getMonth() + 1).padStart(2, '0')
        + String(d.getDate()).padStart(2, '0'));
    }
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function fetchDay(dt, mkt) {
  const j = await call({ mrkt_tp: mkt.mrkt, amt_qty_tp: '0', base_dt: dt, stex_tp: '3' });
  if (j.return_code && j.return_code !== 0) return null;
  const row = (j.inds_netprps || []).find(x => String(x.inds_cd || '').trim() === mkt.inds);
  if (!row) return null;
  return {
    index: num(row.cur_prc) == null ? null : Math.abs(num(row.cur_prc)) / 100,
    개인: num(row.ind_netprps),
    외국인: num(row.frgnr_netprps),
    기관계: num(row.orgn_netprps),
    금융투자: num(row.sc_netprps),
    보험: num(row.insrnc_netprps),
    투신: num(row.invtrt_netprps),
    은행: num(row.bank_netprps),
    연기금: num(row.endw_netprps),
    사모펀드: num(row.samo_fund_netprps),
    기타법인: num(row.etc_corp_netprps),
  };
}

module.exports = (app) => {
  app.get('/flow-history', async (req, res) => {
    try {
      const from = String(req.query.from || '20260101').replace(/\D/g, '');
      const to = String(req.query.to || '').replace(/\D/g, '')
        || new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

      const db = load();
      const days = businessDays(from, to);
      let added = 0;

      for (const dt of days) {
        for (const mkt of MARKETS) {
          const key = dt + '|' + mkt.key;
          if (db[key] !== undefined) continue;   // 이미 받은 날은 건너뜁니다
          const q = await fetchDay(dt, mkt);
          db[key] = q;                            // 휴장일이면 null 로 기록해 다시 안 부릅니다
          if (q) added++;
          await sleep(280);
        }
        if (added && added % 20 === 0) save(db);
      }
      save(db);

      const rows = [];
      for (const dt of days) {
        const kp = db[dt + '|KOSPI'], kq = db[dt + '|KOSDAQ'];
        if (!kp && !kq) continue;
        rows.push({ date: dt, KOSPI: kp || null, KOSDAQ: kq || null });
      }

      res.json({ from, to, added, days: rows.length, rows });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
