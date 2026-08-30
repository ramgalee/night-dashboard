// 이 파일은 브라우저가 아니라 Vercel 서버에서 실행됩니다.
// 그래서 업비트/Hyperliquid가 브라우저 요청을 막아도(CORS) 여기서는 문제없이 데이터를 가져올 수 있습니다.

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");

  let fx = null, fxLive = false; // 업비트 USDC/KRW (크립토 환율, 김프 포함)
  let bankFx = null, bankFxLive = false; // 은행간 환율 (김프 미포함)
  let mark = null, oracle = null, funding = null, oi = null, vol24h = null, skhxLive = false;

  // 1) 업비트 USDC/KRW 환율 (크립토 시장 환율 - 김치프리미엄 포함)
  try {
    const r = await fetch("https://api.upbit.com/v1/ticker?markets=KRW-USDC");
    if (r.ok) {
      const j = await r.json();
      if (j?.[0]?.trade_price) {
        fx = j[0].trade_price;
        fxLive = true;
      }
    }
  } catch (e) {
    // 실패하면 fx는 null로 남고, 프론트엔드에서 데모값으로 대체됩니다.
  }

  // 1-b) 은행간 USD/KRW 환율 (김치프리미엄 미포함 - Yahoo Finance 비공식 조회)
  try {
    const r = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/KRW=X", {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
    });
    if (r.ok) {
      const j = await r.json();
      const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (p) {
        bankFx = p;
        bankFxLive = true;
      }
    }
  } catch (e) {
    // 실패하면 bankFx는 null로 남고, 프론트엔드에서 업비트 환율로 대체됩니다.
  }

  // 2) Hyperliquid HIP-3 (xyz dex) SKHX
  try {
    const r = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
    });
    if (r.ok) {
      const [meta, ctxs] = await r.json();
      const idx = meta?.universe?.findIndex(
        (a) => a.name === "SKHX" || a.name === "xyz:SKHX"
      );
      if (idx != null && idx >= 0 && ctxs?.[idx]) {
        const m = ctxs[idx];
        mark = Number(m.markPx);
        oracle = Number(m.oraclePx);
        funding = Number(m.funding);
        oi = Number(m.openInterest);
        vol24h = Number(m.dayNtlVlm);
        skhxLive = true;
      }
    }
  } catch (e) {
    // 실패하면 mark 등은 null로 남고, 프론트엔드에서 데모값으로 대체됩니다.
  }

  res.status(200).json({
    fx, fxLive, bankFx, bankFxLive, mark, oracle, funding, oi, vol24h, skhxLive,
    timestamp: Date.now(),
  });
};
