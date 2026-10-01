// 한 번만 돌리는 확인용 — QQQ(인베스코) · SMH(반에크) · DRAM(라운드힐) 공시에서 상장주식수를 받을 수 있는지
//   cd /root/app && node etf_probe.js
// 서버에 아무것도 저장하지 않고, 받은 모양만 화면에 찍습니다. 결과를 대화에 붙여 주세요.
const zlib = require('zlib');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function 받기(url, 머리 = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), 25000);
  try {
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: '*/*', ...머리 } });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, type: r.headers.get('content-type') || '', buf, url: r.url };
  } catch (e) { return { status: 'ERR ' + ((e && e.message) || e), type: '', buf: Buffer.alloc(0) }; }
  finally { clearTimeout(t); }
}

// xlsx 첫 줄들 (us_flow.js 와 같은 방식)
function zip풀기(buf) {
  const e = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('zip 아님');
  const 개수 = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const 파일 = {};
  for (let i = 0; i < 개수; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const 방식 = buf.readUInt16LE(p + 10), 크기 = buf.readUInt32LE(p + 20);
    const n = buf.readUInt16LE(p + 28), x = buf.readUInt16LE(p + 30), c = buf.readUInt16LE(p + 32);
    const 위치 = buf.readUInt32LE(p + 42), 이름 = buf.slice(p + 46, p + 46 + n).toString('utf8');
    p += 46 + n + x + c;
    const ln = buf.readUInt16LE(위치 + 26), lx = buf.readUInt16LE(위치 + 28);
    const 몸 = buf.slice(위치 + 30 + ln + lx, 위치 + 30 + ln + lx + 크기);
    파일[이름] = 방식 === 8 ? zlib.inflateRawSync(몸) : 몸;
  }
  return 파일;
}
function 엑셀줄(buf, 몇 = 14) {
  const f = zip풀기(buf), 공유 = [];
  if (f['xl/sharedStrings.xml']) for (const m of f['xl/sharedStrings.xml'].toString('utf8').matchAll(/<si>([\s\S]*?)<\/si>/g))
    공유.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
  const 시트 = Object.keys(f).filter(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  const 줄들 = [];
  for (const 줄 of f[시트].toString('utf8').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const 칸 = [];
    for (const c of 줄[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const t = (c[1].match(/\bt="(\w+)"/) || [])[1], v = ((c[2] || '').match(/<v>([\s\S]*?)<\/v>/) || [])[1];
      const is = ((c[2] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1];
      칸.push(t === 's' ? 공유[+v] : t === 'inlineStr' ? is : v);
    }
    줄들.push(칸.filter(x => x != null && x !== '').join(' | '));
    if (줄들.length >= 몇) break;
  }
  return 줄들;
}

// json 에서 관심 있는 키만
function 키찾기(o, 길 = '', out = []) {
  if (out.length > 40 || o == null) return out;
  if (Array.isArray(o)) { o.slice(0, 3).forEach((v, i) => 키찾기(v, `${길}[${i}]`, out)); return out; }
  if (typeof o === 'object') { for (const [k, v] of Object.entries(o)) 키찾기(v, 길 ? `${길}.${k}` : k, out); return out; }
  if (/share|outstanding|nav|asset|date|asof|effective/i.test(길)) out.push(`${길} = ${String(o).slice(0, 60)}`);
  return out;
}

function 보이기(이름, r) {
  console.log(`\n■ ${이름}\n  ${r.status} · ${r.type.split(';')[0]} · ${r.buf.length.toLocaleString()} bytes${r.url ? ' · ' + r.url.slice(0, 110) : ''}`);
  if (!r.buf.length) return;
  const 앞 = r.buf.slice(0, 4).toString('hex');
  if (앞 === '504b0304') {
    try { 엑셀줄(r.buf).forEach(x => console.log('   ' + x.slice(0, 160))); } catch (e) { console.log('   xlsx 읽기 실패 ' + e.message); }
    return;
  }
  const 글 = r.buf.toString('utf8');
  if (/json/.test(r.type) || /^\s*[\[{]/.test(글)) {
    try { 키찾기(JSON.parse(글)).forEach(x => console.log('   ' + x)); } catch (e) { console.log('   ' + 글.slice(0, 300)); }
    return;
  }
  if (/csv|text\/plain/.test(r.type)) { 글.split(/\r?\n/).slice(0, 10).forEach(x => console.log('   ' + x.slice(0, 160))); return; }
  // html — 숫자 문구와 자료 주소 찾기
  for (const 말 of ['Shares Outstanding', 'Shares outstanding', 'sharesOutstanding', 'Net Assets', 'NAV']) {
    const i = 글.indexOf(말);
    if (i >= 0) console.log(`   "${말}" 근처: ${글.slice(i, i + 220).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 160)}`);
  }
  const 주소 = new Set();
  for (const m of 글.matchAll(/["'(]((?:https?:)?\/[^"'()\s]+?(?:\.json|\.csv|\.xlsx?|\/api\/[^"'()\s]*|assets\/data[^"'()\s]*|GetDataset[^"'()\s]*))["')]/gi)) 주소.add(m[1]);
  [...주소].slice(0, 25).forEach(x => console.log('   자료 주소: ' + x.slice(0, 160)));
}

(async () => {
  const 인베 = { Referer: 'https://www.invesco.com/', Accept: 'application/json' };
  const 쿠 = '46090E103';   // QQQ CUSIP
  const base = `https://dng-api.invesco.com/cache/v1/accounts/en_US/shareclasses/${쿠}`;
  보이기('QQQ 인베스코 prices', await 받기(`${base}/prices?idType=cusip&productType=ETF&variationType=priceListing`, 인베));
  보이기('QQQ 인베스코 fundDetails', await 받기(`${base}?idType=cusip&productType=ETF&expand=nav&variationType=fundDetails`, 인베));
  보이기('QQQ 인베스코 navs', await 받기(`${base}/navs?idType=cusip&productType=ETF`, 인베));

  보이기('SMH 반에크 NAV 이력', await 받기('https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/fundhistoprices/'));
  보이기('SMH 반에크 보유내역', await 받기('https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/holdings/'));
  보이기('SMH 반에크 상품 페이지', await 받기('https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/', { Accept: 'text/html' }));

  보이기('DRAM 라운드힐 상품 페이지', await 받기('https://www.roundhillinvestments.com/etf/dram/', { Accept: 'text/html' }));
  console.log('\n— 끝. 위 내용을 대화에 붙여 주세요.');
})();
