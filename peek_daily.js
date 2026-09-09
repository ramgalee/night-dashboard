const fs = require('fs');
const e = {};
for (const l of fs.readFileSync('/root/app/.env', 'utf8').split('\n')) {
  const m = l.match(/^\s*(\w+)\s*=\s*(.*)$/);
  if (m) e[m[1]] = m[2].trim().replace(/["']/g, '');
}
const K = e.KIWOOM_APP_KEY || e.APP_KEY || e.APPKEY;
const S = e.KIWOOM_APP_SECRET || e.APP_SECRET || e.SECRETKEY;
const B = 'https://api.kiwoom.com';

(async () => {
  const t = await (await fetch(B + '/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: K, secretkey: S })
  })).json();

  for (const id of ['ka20006', 'ka20007', 'ka20009']) {
    const r = await fetch(B + '/api/dostk/chart', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: 'Bearer ' + t.token,
        'api-id': id, 'cont-yn': 'N', 'next-key': ''
      },
      body: JSON.stringify({ inds_cd: '001', base_dt: '' })
    });
    const j = await r.json();
    const k = Object.keys(j).filter(x => Array.isArray(j[x]));
    console.log(id, 'rc=' + j.return_code, String(j.return_msg || '').slice(0, 30), '배열=' + k.join(','));
    if (k.length) console.log('   ', JSON.stringify(j[k[0]][0]).slice(0, 200));
    await new Promise(z => setTimeout(z, 500));
  }
})().catch(x => console.log('err', x.message));
