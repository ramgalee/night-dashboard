// ═══════════════════════════════════════════════════════════
//  index_daily.js — 코스피·코스닥 일별 종가 · 거래대금 (키움 ka20006 업종일봉)
//
//    GET /index-daily?code=001          001 코스피 · 101 코스닥
//        → { code, rows:[{ date, close, amt }] }   amt = 거래대금(억원)
//    GET /index-daily/probe?code=001    키움이 주는 칸 이름 그대로 (처음 확인용)
//
//  브리핑 '투자자 동향' 표의 거래대금 칸을 채웁니다.
//  (/flow-history 는 투자자별 순매수만 있고 거래대금이 없어서)
// ═══════════════════════════════════════════════════════════
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

function 숫자(v) {
  const t = String(v == null ? '' : v).replace(/[+,\s]/g, '');
  if (t === '') return null;
  const 음 = t.indexOf('-') >= 0;
  const n = Number(t.replace(/-/g, ''));
  if (!Number.isFinite(n)) return null;
  return 음 ? -n : n;
}
const 오늘 = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');

let 토큰 = null, 토큰때 = 0;
async function 토큰받기(새로) {
  if (!새로 && 토큰 && Date.now() - 토큰때 < 50 * 60 * 1000) return 토큰;
  const r = await fetch(BASE + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json;charset=UTF-8' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: APP_KEY, secretkey: APP_SECRET }),
  });
  const j = await r.json();
  if (!j.token) throw new Error('키움 토큰 실패');
  토큰 = j.token; 토큰때 = Date.now();
  return 토큰;
}

async function 일봉원본(code, 새로) {
  const t = await 토큰받기(새로);
  const r = await fetch(BASE + '/api/dostk/chart', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      authorization: 'Bearer ' + t,
      'api-id': 'ka20006', 'cont-yn': 'N', 'next-key': '',
    },
    body: JSON.stringify({ inds_cd: code, base_dt: 오늘() }),
  });
  const 글 = await r.text();
  let j;
  try { j = JSON.parse(글); } catch (e) { throw new Error('ka20006 ' + r.status + ' ' + 글.slice(0, 80)); }
  if (j.return_code && j.return_code !== 0) {
    if (!새로 && /8005|token|만료|인증/i.test(String(j.return_msg || ''))) return 일봉원본(code, true);
    throw new Error(j.return_msg || 'ka20006 오류');
  }
  return j;
}

const 캐시 = {};
async function 일봉(code) {
  const c = 캐시[code];
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.data;
  const j = await 일봉원본(code, false);
  const rows = (j.inds_dt_pole_qry || [])
    .map(x => {
      const 날 = String(x.dt || '').slice(0, 8);
      const 종가 = 숫자(x.cur_prc);
      const 대금 = 숫자(x.trde_prica);                 // 백만원
      return {
        date: 날,
        close: 종가 == null ? null : Math.abs(종가) / 100,
        amt: 대금 == null ? null : Math.round(Math.abs(대금) / 100),   // 억원
      };
    })
    .filter(x => x.date.length === 8)
    .sort((a, b) => a.date.localeCompare(b.date));
  const data = { code, rows, generatedAt: new Date().toISOString() };
  캐시[code] = { at: Date.now(), data };
  return data;
}

module.exports = (app) => {
  app.get('/index-daily', async (req, res) => {
    try {
      const code = String(req.query.code || '001').replace(/\D/g, '') || '001';
      const d = await 일봉(code);
      const 부터 = String(req.query.from || '').replace(/\D/g, '');
      res.json(부터 ? { ...d, rows: d.rows.filter(x => x.date >= 부터) } : d);
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });

  // 처음 한 번 — 키움이 어떤 칸을 주는지 그대로 봅니다
  app.get('/index-daily/probe', async (req, res) => {
    try {
      const code = String(req.query.code || '001').replace(/\D/g, '') || '001';
      const j = await 일봉원본(code, false);
      const a = j.inds_dt_pole_qry || [];
      res.json({ code, count: a.length, keys: a[0] ? Object.keys(a[0]) : [], first: a.slice(0, 3) });
    } catch (e) {
      res.status(500).json({ error: String((e && e.message) || e) });
    }
  });
};
