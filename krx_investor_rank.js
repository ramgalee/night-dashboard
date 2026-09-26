// 코스피+코스닥 대형주/중형주를 대상으로 ka10060을 반복 호출해서
// 외국인/기관 순매수 상위·하위 10종목을 계산합니다.
// ETF/우선주는 ka10099의 upSizeName이 비어있는 특성을 이용해 자동 제외합니다.
//
// 2026-09-26 고침
//   ① 종목코드 뒤에 _AL — 한국거래소 + 넥스트레이드 통합 수치 (다른 화면과 같은 기준)
//      전에는 한국거래소 몫만 세서 삼성전자 외국인이 통합의 82%, SK스퀘어는 27%로 잡혔습니다.
//   ② 날짜 = 실제 거래일 (키움이 돌려준 dt). 전에는 돌린 날 날짜를 찍어서
//      휴장일(추석 9/25)에도 '9/25 기준'으로 나왔습니다.
//
//   확인용:  node /root/app/krx_investor_rank.js 005930 20260923
//            → 그 종목 하나만 통합(_AL)과 거래소만(KRX) 값을 나란히 보여 주고 끝납니다.

require('dotenv').config();
const fs = require('fs');

const APP_KEY = process.env.KIWOOM_APP_KEY;
const APP_SECRET = process.env.KIWOOM_APP_SECRET;
const OUTPUT_PATH = '/root/app/investor_rank.json';
const TOP_N = 10;
const SLEEP_MS = 300;
const 통합 = '_AL';          // 넥스트레이드까지 합친 수치

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function toNum(s) {
  if (s == null || s === "") return 0;
  const t = String(s).replace(/,/g, "").replace(/\+/g, "");
  const 음 = t.indexOf("-") >= 0;                       // 키움의 이중 마이너스(--123) 대비
  const n = Number(t.replace(/-/g, "")) || 0;
  return 음 ? -n : n;
}
function todayYYYYMMDD() {
  const d = new Date();
  return d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
}

let cachedToken = null;
let cachedExpiry = 0;
async function getToken() {
  if (cachedToken && Date.now() < cachedExpiry) return cachedToken;
  const r = await fetch("https://api.kiwoom.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: APP_KEY, secretkey: APP_SECRET }),
  });
  const j = await r.json();
  if (!j.token) throw new Error("토큰 발급 실패: " + JSON.stringify(j));
  cachedToken = j.token;
  cachedExpiry = Date.now() + 25 * 60 * 1000;
  return cachedToken;
}

async function getStockList(mrktTp) {
  const token = await getToken();
  const r = await fetch("https://api.kiwoom.com/api/dostk/stkinfo", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", authorization: "Bearer " + token, "api-id": "ka10099" },
    body: JSON.stringify({ mrkt_tp: mrktTp }),
  });
  const j = await r.json();
  return j.list || [];
}

async function getFlowForStock(code, baseDt, 붙임 = 통합) {
  const token = await getToken();
  const r = await fetch("https://api.kiwoom.com/api/dostk/chart", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8", authorization: "Bearer " + token, "api-id": "ka10060" },
    body: JSON.stringify({ dt: baseDt, stk_cd: code + 붙임, amt_qty_tp: "1", trde_tp: "0", unit_tp: "1" }),
  });
  const j = await r.json();
  const list = j.stk_invsr_orgn_chart || [];
  if (list.length === 0) return null;
  const row = list[0];
  return {
    date: String(row.dt || "").slice(0, 8),
    foreignNet: toNum(row.frgnr_invsr), // 백만원
    orgnNet: toNum(row.orgn), // 백만원
  };
}

// 확인용 — node krx_investor_rank.js 005930 20260923
async function probe(code, dt) {
  const a = await getFlowForStock(code, dt, 통합);
  await sleep(SLEEP_MS);
  const b = await getFlowForStock(code, dt, "");
  console.log(`${code} · 요청일 ${dt}`);
  console.log("  통합(_AL)  ", JSON.stringify(a));
  console.log("  거래소만    ", JSON.stringify(b));
}

async function main() {
  const baseDt = todayYYYYMMDD();
  console.log("종목 목록 조회 중...");
  const kospi = await getStockList("0");
  const kosdaq = await getStockList("10");
  let all = [...kospi, ...kosdaq];
  console.log(`전체 ${all.length}종목`);

  // ETF/우선주는 upSizeName이 빈값이라 자연스럽게 제외됨. 소형주도 빼서 호출 수를 줄임.
  all = all.filter((s) => s.upSizeName === "대형주" || s.upSizeName === "중형주");
  console.log(`대형주/중형주만 필터링 후 ${all.length}종목`);

  const results = [];
  for (let i = 0; i < all.length; i++) {
    const s = all[i];
    try {
      const flow = await getFlowForStock(s.code, baseDt);
      if (flow) results.push({ code: s.code, name: s.name, ...flow });
    } catch (e) {
      console.log(`  !! ${s.code} 실패: ${e.message}`);
    }
    if (i % 20 === 0) console.log(`진행: ${i}/${all.length}`);
    await sleep(SLEEP_MS);
  }

  // 실제 거래일 — 종목들이 돌려준 날짜 중 가장 많은 것 (휴장일에 돌리면 직전 거래일이 됩니다)
  const 셈 = {};
  for (const x of results) if (x.date) 셈[x.date] = (셈[x.date] || 0) + 1;
  const 거래일 = Object.keys(셈).sort((a, b) => 셈[b] - 셈[a] || (a < b ? 1 : -1))[0] || baseDt;
  const 쓸것 = results.filter((x) => x.date === 거래일);       // 거래정지 등으로 날짜가 다른 종목은 뺌
  console.log(`거래일 ${거래일} · ${쓸것.length}종목 (돌린 날 ${baseDt})`);

  const byForeignDesc = [...쓸것].sort((a, b) => b.foreignNet - a.foreignNet);
  const byForeignAsc = [...쓸것].sort((a, b) => a.foreignNet - b.foreignNet);
  const byOrgnDesc = [...쓸것].sort((a, b) => b.orgnNet - a.orgnNet);
  const byOrgnAsc = [...쓸것].sort((a, b) => a.orgnNet - b.orgnNet);

  const output = {
    date: 거래일,
    runDate: baseDt,
    basis: "KRX+NXT 통합(_AL)",
    generatedAt: new Date().toISOString(),
    totalStocks: 쓸것.length,
    foreign: { buy: byForeignDesc.slice(0, TOP_N), sell: byForeignAsc.slice(0, TOP_N) },
    institution: { buy: byOrgnDesc.slice(0, TOP_N), sell: byOrgnAsc.slice(0, TOP_N) },
  };

  if (쓸것.length < 50) throw new Error(`받은 종목이 ${쓸것.length}개뿐이라 저장하지 않습니다 (기존 파일 유지)`);
  const 임시 = OUTPUT_PATH + ".tmp";
  fs.writeFileSync(임시, JSON.stringify(output, null, 2), "utf-8");
  fs.renameSync(임시, OUTPUT_PATH);
  console.log("저장 완료:", OUTPUT_PATH);
}

const [, , 코드, 날] = process.argv;
(코드 ? probe(코드, 날 || todayYYYYMMDD()) : main()).catch((e) => {
  console.error(e);
  process.exit(1);
});
