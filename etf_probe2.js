// 확인용 2번째 — 한 번만 돌립니다.  cd /root/app && node etf_probe2.js
const { execSync } = require('child_process');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function 받기(url, 머리 = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA, ...머리 } });
    return { status: r.status, type: r.headers.get('content-type') || '', text: await r.text() };
  } catch (e) { return { status: 'ERR ' + (e && e.message) + ' / ' + (e && e.cause && (e.cause.code || e.cause.message)), type: '', text: '' }; }
  finally { clearTimeout(t); }
}
const 줄 = s => s.replace(/\s+/g, ' ').slice(0, 700);

(async () => {
  // 1) 인베스코 — Accept 를 'application/json,*/*' 로
  const 머 = { Accept: 'application/json,*/*', Referer: 'https://www.invesco.com/' };
  const base = 'https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/46090E103';
  const p = await 받기(`${base}/prices?idType=cusip&productType=ETF&variationType=priceListing`, 머);
  console.log('■ QQQ prices', p.status, p.text.slice(0, 500));
  const n = await 받기(`${base}/navs?idType=cusip&productType=ETF`, 머);
  console.log('\n■ QQQ navs', n.status, n.text.slice(0, 200), '…', n.text.slice(-200));

  // 2) 반에크 — 왜 막히는지 + curl 로도
  const v = await 받기('https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/', { Accept: 'text/html' });
  console.log('\n■ SMH node fetch', v.status, v.text.length);
  for (const u of ['https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/',
                   'https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/holdings/']) {
    try {
      const out = execSync(`curl -s -m 25 -A "${UA}" -o /tmp/vk.bin -w "%{http_code} %{content_type} %{size_download}" "${u}"`, { encoding: 'utf8' });
      console.log('■ SMH curl', out, '·', u.split('/').slice(-3).join('/'));
      const head = execSync('head -c 4 /tmp/vk.bin | od -An -tx1', { encoding: 'utf8' }).trim();
      console.log('   첫 바이트', head);
    } catch (e) { console.log('■ SMH curl 실패', (e.stderr || e.message || '').toString().slice(0, 200)); }
  }
  try { console.log('   IPv4 확인', execSync('curl -4 -s -m 15 -o /dev/null -w "%{http_code}" https://www.vaneck.com/', { encoding: 'utf8' })); } catch (e) { console.log('   IPv4 실패'); }

  // 3) 라운드힐 — 숫자 칸이 어디서 채워지는지
  const d = await 받기('https://www.roundhillinvestments.com/etf/dram/', { Accept: 'text/html' });
  const h = d.text;
  for (const 말 of ['Shares Outstanding', 'dailyna', 'Net Assets', 'AUM']) {
    const i = h.indexOf(말);
    if (i >= 0) console.log(`\n■ DRAM "${말}" 원문: ${줄(h.slice(Math.max(0, i - 150), i + 500))}`);
  }
  const 스크립트 = [...h.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  console.log('\n■ DRAM script src:', 스크립트.slice(0, 20).join('  '));
  const 안 = [...h.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).filter(s => /nav|share|fetch|ajax|csv|json/i.test(s));
  안.slice(0, 4).forEach((s, i) => console.log(`\n■ DRAM inline script ${i + 1}: ${줄(s)}`));
  console.log('\n— 끝. 위 내용을 대화에 붙여 주세요.');
})();
