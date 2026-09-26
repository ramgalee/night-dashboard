// 브리핑 · 투자자 동향 — 서버의 두 창구를 모아 화면 모양으로 묶습니다
//   GET /api/flow-diary
//
//   시장(코스피·코스닥)   서버 /flow-history   키움 ka10051 · 억원
//   종목(삼성·하이닉스·인버스2X)  서버 /stock-flow  키움 ka10059 · 백만원
//   거래대금(코스피·코스닥) 서버 /index-daily  키움 ka20006 · 억원
//   선물                  서버 /fut-flow  네이버 증권(키움에 선물 자료가 없어서) · 억원
//                         서버에 없는 옛날은 flow_diary.json(엑셀 씨앗)
//
//   씨앗 파일을 바탕에 깔고, 서버 자료가 있는 날은 서버 값으로 덮어씁니다.
//   그래서 서버가 멈춰도 씨앗으로 화면이 나오고, 서버가 돌면 매일 새 날이 붙습니다.
export const config = { maxDuration: 60 };

const 서버 = "http://141.164.40.229:3000";
const 씨앗주소 = "https://raw.githubusercontent.com/ramgalee/night-dashboard/main/flow_diary.json";
const 시작 = "20260320";                       // 4월 이후 누적 그래프에 넉넉히
const 종목들 = { "005930": "삼성전자", "000660": "SK하이닉스" };
const 곱버스 = "252670";                       // KODEX 200선물인버스2X

async function 받기(주소, 초) {
  const ac = new AbortController();
  const 시계 = setTimeout(() => ac.abort(), (초 || 40) * 1000);
  try {
    const r = await fetch(주소, { signal: ac.signal, headers: { "Cache-Control": "no-cache" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(시계); }
}
const 둘째 = v => Math.round(v * 100) / 100;
const 주말 = d => { const w = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8))).getUTCDay(); return w === 0 || w === 6; };

export default async function handler(req, res) {
  try {
    const 코드 = [...Object.keys(종목들), 곱버스].join(",");
    const [씨앗, 흐름, 종목, 대금피, 대금닥, 선물] = await Promise.all([
      받기(씨앗주소, 15).catch(() => null),
      받기(`${서버}/flow-history?from=${시작}`).catch(() => null),
      받기(`${서버}/stock-flow?codes=${코드}&from=${시작}`).catch(() => null),
      받기(`${서버}/index-daily?code=001&from=${시작}`, 20).catch(() => null),
      받기(`${서버}/index-daily?code=101&from=${시작}`, 20).catch(() => null),
      받기(`${서버}/fut-flow?from=${시작}`, 15).catch(() => null),
    ]);

    const out = 씨앗 ? JSON.parse(JSON.stringify(씨앗)) : {};
    out.market = out.market || {}; out.market.KOSPI = out.market.KOSPI || {}; out.market.KOSDAQ = out.market.KOSDAQ || {};
    out.futures = out.futures || {}; out.inverse = out.inverse || {}; out.samsungChart = out.samsungChart || {};
    out.stocks = out.stocks || {};
    for (const [c, n] of Object.entries(종목들)) out.stocks[c] = out.stocks[c] || { name: n, days: {} };

    const 쓴곳 = [];
    let 끝날 = null;

    // ── 시장 ─────────────────────────────────────
    //   휴장일·주말 줄은 전날 숫자가 반복돼 들어 있어 뺍니다(그대로 두면 주간 합이 부풀려짐).
    if (흐름 && Array.isArray(흐름.rows) && 흐름.rows.length) {
      쓴곳.push("키움 시장");
      for (const m of ["KOSPI", "KOSDAQ"]) {
        let 앞 = null;
        for (const r of [...흐름.rows].sort((a, b) => a.date < b.date ? -1 : 1)) {
          const x = r[m];
          if (!x || !r.date || 주말(r.date)) continue;
          const 지문 = JSON.stringify(x);
          const 다영 = ["개인", "외국인", "기관계"].every(k => !x[k]);
          if ((앞 && 앞.지문 === 지문) || 다영) continue;
          const 칸 = {
            close: x.index ?? null, 개인: x.개인, 외국인: x.외국인, 기관계: x.기관계,
            금융투자: x.금융투자, 보험: x.보험, 투신: x.투신, 연기금등: x.연기금, 사모펀드: x.사모펀드,
          };
          if (앞 && 앞.index && x.index) { 칸.chg = 둘째(x.index - 앞.index); 칸.pct = 둘째((x.index / 앞.index - 1) * 100); }
          const 기존 = out.market[m][r.date] || {};
          out.market[m][r.date] = { ...기존, ...칸 };       // 거래대금(amt)은 아래 /index-daily 로 채웁니다
          앞 = { 지문, index: x.index };
          if (!끝날 || r.date > 끝날) 끝날 = r.date;
        }
      }
    }

    // ── 거래대금 ─────────────────────────────────
    //   투자자 자료가 있는 날에만 붙입니다(휴장일 줄을 새로 만들지 않게).
    let 대금썼다 = false;
    for (const [m, 자] of [["KOSPI", 대금피], ["KOSDAQ", 대금닥]]) {
      for (const r of (자 && 자.rows) || []) {
        const 칸 = out.market[m][r.date];
        if (!칸 || r.amt == null || !r.amt) continue;
        칸.amt = r.amt;
        if (칸.close == null && r.close) 칸.close = r.close;
        대금썼다 = true;
      }
    }
    if (대금썼다) 쓴곳.push("키움 거래대금");

    // ── 선물 ─────────────────────────────────────
    let 선물썼다 = false;
    for (const r of (선물 && 선물.rows) || []) {
      if (!r.date || 주말(r.date) || r.외국인 == null) continue;
      out.futures[r.date] = { ...(out.futures[r.date] || {}), 개인: r.개인, 외국인: r.외국인, 기관계: r.기관계 };
      선물썼다 = true;
    }
    if (선물썼다) 쓴곳.push("네이버 선물");

    // ── 종목 ─────────────────────────────────────
    const 자료 = 종목 && 종목.data;
    if (자료) {
      let 썼다 = false;
      for (const c of Object.keys(종목들)) {
        for (const r of 자료[c] || []) {
          if (!r.date) continue;
          out.stocks[c].days[r.date] = { 개인: r.개인, 외국인: r.외국인, 기관계: r.기관계, 기타법인: r.기타법인 };
          썼다 = true;
        }
      }
      for (const r of 자료[곱버스] || []) {
        if (!r.date) continue;
        out.inverse[r.date] = { ...(out.inverse[r.date] || {}), 개인: r.개인, 외국인: r.외국인, 기관계: r.기관계 };
        썼다 = true;
      }
      // 삼성전자 & 개인 누적 — 서버 자료가 있는 구간은 통째로 서버 값으로 (엑셀 날짜 어긋남 바로잡힘)
      const 삼 = (자료["005930"] || []).filter(r => r.date);
      if (삼.length) {
        const 첫 = 삼.map(r => r.date).sort()[0];
        for (const d of Object.keys(out.samsungChart)) if (d >= 첫) delete out.samsungChart[d];
        for (const r of 삼) out.samsungChart[r.date] = { close: r.종가, 개인: r.개인 };
      }
      if (썼다) 쓴곳.push("키움 종목");
    }

    // 날짜순으로 정리
    const 정렬 = o => Object.fromEntries(Object.keys(o).sort().map(k => [k, o[k]]));
    out.market.KOSPI = 정렬(out.market.KOSPI); out.market.KOSDAQ = 정렬(out.market.KOSDAQ);
    out.inverse = 정렬(out.inverse); out.samsungChart = 정렬(out.samsungChart); out.futures = 정렬(out.futures);
    for (const c of Object.keys(out.stocks)) out.stocks[c].days = 정렬(out.stocks[c].days);

    out.generatedAt = new Date().toISOString();
    out.source = 쓴곳.length ? 쓴곳.join(" · ") + (선물썼다 ? "" : " · 선물은 엑셀") : (씨앗 ? "엑셀 씨앗" : "자료 없음");
    out.serverLast = 끝날;
    if (!out.market || !Object.keys(out.market.KOSPI).length) return res.status(502).json({ error: "자료를 받지 못했습니다" });

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1800");
    res.status(200).json(out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
}
