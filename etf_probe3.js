// 확인용 3번째 — 한 번만 돌립니다.  cd /root/app && node etf_probe3.js
const zlib = require('zlib');
const fs = require('fs');
const { execSync } = require('child_process');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const 줄 = s => s.replace(/\s+/g, ' ');
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


const sh = c => { try { return execSync(c, { encoding: 'utf8', maxBuffer: 50e6 }); } catch (e) { return 'ERR ' + (e.stdout || '') + (e.stderr || e.message || '').toString().slice(0, 200); } };

(async () => {
  // 1) 라운드힐 — app.js 에서 숫자 칸을 채우는 곳
  const js = sh(`curl -s -m 25 -A "${UA}" https://www.roundhillinvestments.com/assets/js/app.js`);
  console.log('■ DRAM app.js', js.length, 'bytes');
  const 본 = new Set();
  for (const 말 of ['Shares_Outstanding', 'NetAssets', 'of-holdings', 'dailynav', '.csv', '.json', 'ajax', 'fetch(', '$.get', 'getJSON', 'Papa']) {
    let i = -1, n = 0;
    while ((i = js.indexOf(말, i + 1)) >= 0 && n < 2) {
      const a = Math.max(0, i - 250), 조각 = 줄(js.slice(a, i + 350));
      if ([...본].some(x => x.includes(조각.slice(200, 300)))) { n++; continue; }
      본.add(조각); console.log(`\n  [${말}] ${조각}`); n++;
    }
  }

  // 2) 반에크 — 어디로 돌려보내는지, 쿠키를 들고 따라가면 받아지는지
  console.log('\n■ SMH 첫 응답 머리글');
  console.log(sh(`curl -s -m 20 -A "${UA}" -D - -o /dev/null https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/`).split(/\r?\n/)
    .filter(l => /^(HTTP|location|set-cookie|server|cf-)/i.test(l)).map(l => '  ' + l.slice(0, 160)).join('\n'));
  for (const [이름, u] of [['NAV 이력', 'https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/fundhistoprices/'],
                         ['보유내역', 'https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/downloads/holdings/']]) {
    try { fs.unlinkSync('/tmp/vk.jar'); } catch (e) {}
    const 결과 = sh(`curl -s -L --max-redirs 8 -m 40 -A "${UA}" -c /tmp/vk.jar -b /tmp/vk.jar -o /tmp/vk.bin -w "%{http_code} %{content_type} %{size_download} %{url_effective}" "${u}"`);
    console.log(`\n■ SMH ${이름} (쿠키 따라가기) ${결과.slice(0, 220)}`);
    try {
      const b = fs.readFileSync('/tmp/vk.bin');
      if (b.slice(0, 4).toString('hex') === '504b0304') 엑셀줄(b, 14).forEach(x => console.log('   ' + x.slice(0, 170)));
      else console.log('   ' + 줄(b.toString('utf8').slice(0, 300)));
    } catch (e) { console.log('   파일 없음'); }
  }
  console.log('\n— 끝. 위 내용을 대화에 붙여 주세요.');
})();
