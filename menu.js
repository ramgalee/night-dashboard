// ═══════════════════════════════════════════════════════════
//  menu.js — 모든 페이지 윗단 메뉴를 한 곳에서 관리합니다
//
//  ★ 새 페이지를 만들면 아래 '메뉴' 목록에 한 줄만 넣으세요.
//    그러면 모든 페이지의 메뉴에 한꺼번에 생깁니다.
//  ★ 지금 보고 있는 페이지는 연보라색 ● 표시로 '여기'임을 알려 줍니다.
//
//  페이지 쪽에는 메뉴 자리에 아래 두 줄만 있으면 됩니다.
//    <span id="hgMenu" style="display:contents"></span><script src="/menu.js"></script>
// ═══════════════════════════════════════════════════════════
(function () {
  const 메뉴 = [
    // [주소, 이름]  — 이 순서대로 보입니다
    ["/brief.html",           "오늘의 브리핑"],
    ["/index.html",           "주간 증시"],
    ["/signal.html",          "시장 신호등"],
    ["/calendar.html",        "증시 일정"],
    ["/supply-rank.html",     "순매수 순위"],
    ["/flow-oscillator.html", "수급오실레이터"],
    ["/leader.html",          "대형주 수급"],
    ["/etf-flow.html",        "액티브 ETF"],
    ["/map.html",             "히트맵"],
    ["/fg.html",              "F&amp;G 지수"],
    ["/night.html",           "야간 증시"],
    ["/us.html",              "미국 증시"],
    ["/holiday-brief.html",   "연휴 정리"],
  ];

  // 주소 끝의 .html 이 있든 없든, 맨 앞 / 만 있든 같은 페이지로 봅니다
  const 이름만 = p => {
    p = (p || "/").split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (p === "") p = "/index";
    return p.replace(/\.html$/, "").toLowerCase();
  };
  const 지금 = 이름만(location.pathname);

  const 자리 = document.getElementById("hgMenu");
  if (!자리) return;

  자리.innerHTML = 메뉴.map(([주소, 이름]) => {
    if (이름만(주소) === 지금) {
      return `<a href="${주소}" style="text-decoration:none;" aria-current="page">` +
             `<button style="background:#EEEAFB;color:#5B3FD0;border:1px solid #BFB1F2;font-weight:700;">● ${이름}</button></a>`;
    }
    return `<a href="${주소}" style="text-decoration:none;"><button>${이름}</button></a>`;
  }).join("");

  // 메뉴가 길어도 화면 밖으로 나가지 않고 다음 줄로 내려가게
  const 통 = 자리.parentElement;
  if (통) { 통.style.flexWrap = "wrap"; 통.style.minWidth = "0"; }
})();
