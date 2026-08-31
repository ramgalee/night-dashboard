// 종목코드를 받아서:
// 1) 일봉 OHLCV (ka10081)
// 2) 기관+외국인 순매수금액 (ka10060)
// 3) 상장주식수/시가총액 (ka10001)
// 을 가져온 뒤, 원본 엑셀 파일과 동일한 공식으로 수급오실레이터를 계산합니다.
//
//   시기외 = (기관 순매수금액 + 외국인 순매수금액) / 시가총액
//   EMA12, EMA26 (계수 2/13, 2/27)
//   MACD = EMA12 - EMA26
//   Signal = MACD의 EMA9 (계수 2/10)
//   오실레이터 = MACD - Signal

const { getToken, callChart } = require("../lib/kiwoom");

function toNum(s) {
  if (s == null || s === "") return 0;
  return Number(String(s).replace(/,/g, "").replace(/\+/g, "")) || 0;
}

function todayYYYYMMDD() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  const code = String(req.query?.code || "000660").trim();
  const baseDt = todayYYYYMMDD();

  try {
    const token = await getToken();

    // 1) 상장주식수 / 시가총액 스냅샷
    const infoRes = await fetch("https://api.kiwoom.com/api/dostk/chart", {
      method: "POST",
      headers: {
        "Content-Type": "application/json;charset=UTF-8",
        authorization: "Bearer " + token,
        "api-id": "ka10001",
      },
      body: JSON.stringify({ stk_cd: code }),
    });
    if (!infoRes.ok) throw new Error("ka10001 호출 실패: HTTP " + infoRes.status);
    const info = await infoRes.json();
    const floStkRaw = toNum(info.flo_stk); // 상장주식 (단위 문서상 불명확 - 천주로 가정)
    const macEok = toNum(info.mac); // 시가총액 (억원, 검증용)

    // 2) 일봉 OHLCV
    const candleRaw = await callChart(
      "ka10081",
      { stk_cd: code, base_dt: baseDt, upd_stkpc_tp: "1" },
      "stk_dt_pole_chart_qry",
      4
    );

    // 3) 기관+외국인 순매수금액 (백만원 단위)
    const flowRaw = await callChart(
      "ka10060",
      { dt: baseDt, stk_cd: code, amt_qty_tp: "1", trde_tp: "0", unit_tp: "1" },
      "stk_invsr_orgn_chart",
      4
    );

    const candleMap = {};
    candleRaw.forEach((r) => {
      if (!r.dt) return;
      candleMap[r.dt] = {
        date: r.dt,
        open: toNum(r.open_pric),
        high: toNum(r.high_pric),
        low: toNum(r.low_pric),
        close: toNum(r.cur_prc),
        volume: toNum(r.trde_qty),
      };
    });

    const flowMap = {};
    flowRaw.forEach((r) => {
      if (!r.dt) return;
      flowMap[r.dt] = toNum(r.orgn) + toNum(r.frgnr_invsr); // 백만원
    });

    const dates = Object.keys(candleMap).sort(); // 오래된 -> 최신 순 정렬

    // 시가총액 단위 검증: 상장주식수(천주 가정) * 현재가로 계산한 값이
    // ka10001의 mac(억원)과 크게 다르면 단위 가정이 틀렸을 가능성이 있습니다.
    let unitWarning = null;
    if (dates.length > 0 && floStkRaw && macEok) {
      const lastClose = candleMap[dates[dates.length - 1]].close;
      const estimatedCapEok = (floStkRaw * 1000 * lastClose) / 1e8;
      const ratio = estimatedCapEok / macEok;
      if (ratio < 0.5 || ratio > 2) {
        unitWarning = `상장주식수 단위 가정이 실제와 다를 수 있습니다 (추정 시가총액 ${Math.round(estimatedCapEok)}억 vs 공식값 ${Math.round(macEok)}억).`;
      }
    }

    const series = dates.map((d) => {
      const candle = candleMap[d];
      const flowMil = flowMap[d] || 0; // 백만원
      // 시가총액(백만원) = 상장주식수(천주 가정) * 1000 * 종가(원) / 1,000,000
      const marketCapMil = floStkRaw ? (floStkRaw * 1000 * candle.close) / 1e6 : null;
      const ratio = marketCapMil ? flowMil / marketCapMil : 0;
      return { ...candle, ratio };
    });

    // EMA(12,26) -> MACD -> Signal(9) -> 오실레이터, 원본 파일과 동일한 계수 사용
    const k12 = 2 / 13;
    const k26 = 2 / 27;
    const k9 = 2 / 10;
    let ema12, ema26, signalPrev;

    const out = series.map((s, i) => {
      ema12 = i === 0 ? s.ratio : s.ratio * k12 + ema12 * (1 - k12);
      ema26 = i === 0 ? s.ratio : s.ratio * k26 + ema26 * (1 - k26);
      const macd = ema12 - ema26;
      const signal = i === 0 ? macd : macd * k9 + signalPrev * (1 - k9);
      signalPrev = signal;
      const oscillator = macd - signal;
      return {
        date: s.date,
        open: s.open,
        high: s.high,
        low: s.low,
        close: s.close,
        volume: s.volume,
        oscillator,
      };
    });

    res.status(200).json({
      code,
      count: out.length,
      series: out,
      unitWarning,
      warmupNotice:
        out.length < 60
          ? "데이터가 충분하지 않아(60거래일 미만) 오실레이터 초반 값의 정확도가 낮을 수 있습니다."
          : null,
    });
  } catch (e) {
    res.status(200).json({ error: true, message: String(e && e.message ? e.message : e) });
  }
};
