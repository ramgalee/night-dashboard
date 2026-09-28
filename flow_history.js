// 일별 투자자 매매동향 (코스피/코스닥)
// 키움 ka10051 을 날짜별로 호출해 모아두고 파일에 저장합니다.
// 한 번 받은 날짜는 다시 부르지 않아, 처음만 오래 걸리고 이후에는 빠릅니다.
//
// ★ 2026-09-28 고침 — 오늘·최근 날짜가 '덜 된 값' 으로 굳어 버리던 문제
//   예전에는 아무 때나 한 번 받으면 끝이었습니다. 그래서 9/28 낮(서버 재시작 때) 받은 값이
//   직전 거래일(9/23) 숫자 그대로였는데, 그게 '9/28' 로 저장된 뒤 다시 받지 않았습니다.
//   이제는 그날 20:00(넥스트레이드 마감) 뒤에 받은 값만 '확정' 으로 보고,
//   그 전에 받은 값은 10분이 지나면 다시 받습니다. 확정된 옛날 날짜는 예전처럼 다시 부르지 않습니다.
//   또 받은 값이 직전 거래일과 똑같으면(아직 오늘 자료가 없거나 휴장일) 그날은 비워 둡니다.
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
  fs.writeFileSync(STORE + '.tmp', JSON.stringify(db), 'utf8');
  fs.renameSync(STORE + '.tmp', STORE);
}
// 받은 시각 기록 — db._at[날짜|시장] = 받은 때(ms)
const 확정시각 = dt => Date.UTC(+dt.slice(0, 4), +dt.slice(4, 6) - 1, +dt.slice(6, 8), 20 - 9, 0);   // 그날 한국시간 20:00
const 다시받을까 = (db, key, dt) => {
  if (db[key] === undefined) return true;
  const at = (db._at || {})[key];
  if (!at) return Date.now() - 확정시각(dt) < 7 * 86400e3;       // 기록이 없는 옛 값 — 최근 7일치만 한 번 다시
  if (at >= 확정시각(dt)) return false;                           // 20시 뒤에 받은 값 = 확정
  return Date.now() - at > 10 * 60 * 1000;                        // 덜 된 값 — 10분 지나면 다시
};
const 같은값 = (a, b) => a && b && a.index === b.index && a.개인 === b.개인 && a.외국인 === b.외국인 && a.기관계 === b.기관계;
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
      db._at = db._at || {};
      const days = businessDays(from, to);
      let added = 0, 바뀜 = false;
      for (let i = 0; i < days.length; i++) {
        const dt = days[i];
        for (const mkt of MARKETS) {
          const key = dt + '|' + mkt.key;
          if (!다시받을까(db, key, dt)) continue;       // 확정된 날은 건너뜁니다
          let q = await fetchDay(dt, mkt);
          // 직전 거래일 값과 똑같으면 아직 그날 자료가 없거나 휴장일 → 비워 둡니다
          let 앞 = null;
          for (let k = i - 1; k >= 0 && !앞; k--) 앞 = db[days[k] + '|' + mkt.key] || null;
          if (같은값(q, 앞)) q = null;
          db[key] = q;                                  // 휴장일이면 null (20시 뒤에 확정)
          db._at[key] = Date.now();
          바뀜 = true;
          if (q) added++;
          await sleep(280);
        }
        if (added && added % 20 === 0) save(db);
      }
      if (바뀜) save(db);
      const rows = [];
      for (const dt of days) {
        const kp = db[dt + '|KOSPI'], kq = db[dt + '|KOSDAQ'];   // (_at 은 날짜가 아니라 건너뜀)
        if (!kp && !kq) continue;
        rows.push({ date: dt, KOSPI: kp || null, KOSDAQ: kq || null });      }
      res.json({ from, to, added, days: rows.length, rows });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
