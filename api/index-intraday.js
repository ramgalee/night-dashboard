// 국내 지수 (코스피·코스닥·코스피200) + 개인·외국인·기관 순매수
//   GET /api/index-intraday
//
// ★ 2026-09-29 고침 — 장 마감 뒤 순매수가 0 으로 '리셋' 되던 문제
//   15:30 에 정규장이 끝나고 넥스트레이드 애프터마켓(15:30~20:00)으로 넘어가면,
//   키움의 '지금 시각' 투자자 매매동향이 새 세션 기준으로 바뀌어 순매수가 처음부터 다시 쌓입니다.
//   그래서 장 밖(평일 15:30~다음 날 08:00 · 주말)에는 그날 하루 합계(서버 /flow-history,
//   KRX+NXT 통합 · 억원)로 바꿔 보여 줍니다. 다음 날 08:00 넥스트레이드 프리마켓이 열리면 다시 실시간입니다.
//   하루 합계를 못 받으면 예전처럼 서버 값을 그대로 씁니다.
//
// ★ 2026-09-30 — 단위를 억원으로 통일합니다. 서버(키움 ka10051)는 억원으로 주고,
//   야간 증시·브리핑도 억원으로 읽습니다. 혹시 원 단위(1e6 이상)가 섞여 오면 억으로 바꿉니다.
const 서버 = 'http://141.164.40.229:3000';

async function 받기(주소, 초) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), (초 || 20) * 1000);
  try {
    const r = await fetch(주소, { signal: ac.signal });
    if (!r.ok) throw new Error('relay ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function 장밖() {
  const 한국 = new Date(Date.now() + 9 * 3600e3);
  const 요일 = 한국.getUTCDay(), 분 = 한국.getUTCHours() * 60 + 한국.getUTCMinutes();
  if (요일 === 0 || 요일 === 6) return true;
  return 분 >= 15 * 60 + 30 || 분 < 8 * 60;
}
const 며칠전 = (ymd, n) => {
  const d = new Date(Date.UTC(+ymd.slice(0, 4), +ymd.slice(4, 6) - 1, +ymd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
};

const 억으로 = v => (typeof v === 'number' && Math.abs(v) >= 1e6) ? Math.round(v / 1e8) : v;
function 단위맞춤(f) {
  if (!f) return f;
  for (const k of ['individual', 'foreign', 'institution']) f[k] = 억으로(f[k]);
  if (f.detail) for (const k of Object.keys(f.detail)) f.detail[k] = 억으로(f.detail[k]);
  return f;
}

export default async function handler(req, res) {
  try {
    const data = await 받기(`${서버}/index-intraday`, 20);
    for (const 키 of ['kospi', 'kosdaq']) if (data[키] && data[키].flow) 단위맞춤(data[키].flow);

    if (장밖()) {
      try {
        const 날 = String((data.kospi && data.kospi.date) || '').replace(/\D/g, '');
        if (날.length === 8) {
          const h = await 받기(`${서버}/flow-history?from=${며칠전(날, 7)}&to=${날}`, 8);
          const 줄 = (h.rows || []).find(r => r.date === 날);
          for (const [키, 시장] of [['kospi', 'KOSPI'], ['kosdaq', 'KOSDAQ']]) {
            const x = 줄 && 줄[시장];
            if (!x || !data[키] || [x.개인, x.외국인, x.기관계].some(v => v == null)) continue;
            // flow-history 도 억원 — 그대로 넣습니다
            data[키].flow = { ...(data[키].flow || {}),
              individual: x.개인, foreign: x.외국인, institution: x.기관계,
              basis: '하루 합계 (KRX+NXT)' };
          }
          data.flowBasis = 줄 ? 'day-total' : 'live';
        }
      } catch (e) { data.flowBasis = 'live'; }
    }

    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
