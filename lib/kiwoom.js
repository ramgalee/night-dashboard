// 키움 REST API 공용 함수
// - 토큰 발급 (au10001)
// - /api/dostk/chart 계열 TR 페이지네이션 호출 공용 함수

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;

  const r = await fetch("https://api.kiwoom.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.KIWOOM_APP_KEY,
      secretkey: process.env.KIWOOM_APP_SECRET,
    }),
  });
  if (!r.ok) {
    throw new Error("키움 토큰 발급 실패: HTTP " + r.status);
  }
  const j = await r.json();
  if (!j.token) {
    throw new Error("키움 토큰 발급 실패: 응답에 token 없음 - " + JSON.stringify(j));
  }
  cachedToken = j.token;
  // expires_dt 포맷이 문서에 명시되어 있지 않아, 안전하게 25분만 캐시하고 재발급합니다.
  cachedTokenExpiry = Date.now() + 25 * 60 * 1000;
  return cachedToken;
}

// api-id(TR코드)를 호출하고, cont-yn/next-key로 이어지는 페이지를 maxPages까지 모아서 반환합니다.
// listField: 응답 JSON에서 배열이 들어있는 필드명 (예: 'stk_dt_pole_chart_qry', 'stk_invsr_orgn_chart')
async function callChart(apiId, body, listField, maxPages = 4) {
  const token = await getToken();
  let results = [];
  let contYn = "N";
  let nextKey = "";

  for (let page = 0; page < maxPages; page++) {
    const headers = {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: "Bearer " + token,
      "api-id": apiId,
    };
    if (contYn === "Y") {
      headers["cont-yn"] = contYn;
      headers["next-key"] = nextKey;
    }

    const r = await fetch("https://api.kiwoom.com/api/dostk/chart", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      throw new Error(apiId + " 호출 실패: HTTP " + r.status);
    }
    const j = await r.json();
    const list = j[listField] || [];
    results = results.concat(list);

    contYn = r.headers.get("cont-yn") || "N";
    nextKey = r.headers.get("next-key") || "";
    if (contYn !== "Y" || !nextKey) break;
  }

  return results;
}

module.exports = { getToken, callChart };
