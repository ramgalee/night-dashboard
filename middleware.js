// 대시보드 전체에 비밀번호를 겁니다.
//
// 비밀번호는 코드에 넣지 않고 Vercel 환경변수 SITE_PASSWORD 에 둡니다.
// (Vercel → 프로젝트 → Settings → Environment Variables)
// 비밀번호를 바꾸면 기존 접속자도 다시 입력해야 합니다.
//
// marketcap.json 만 예외입니다. Vultr 중계 서버가 그 파일을 읽어가기 때문에
// 막으면 시총대비 수급 기능이 멈춥니다. 종목코드와 시가총액뿐이라 공개해도 무방합니다.

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|marketcap.json).*)'],
};

const COOKIE = 'site_auth';

// 비밀번호가 바뀌면 쿠키 값도 달라지도록, 비밀번호에서 표식을 만들어 둡니다.
async function tokenOf(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('nd:' + pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function loginPage(message) {
  return `<!DOCTYPE html>
<html lang="ko"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>이가람 증시 모니터</title>
<style>
  :root { --void:#F2F4F9; --surface:#FFFFFF; --hair:#E1E5F0;
          --textPri:#131A2C; --textSec:#5B6483; --textTer:#8B94B0; --signature:#6D4FE0;
          --mono: ui-monospace,'SF Mono','Roboto Mono',Menlo,Consolas,monospace;
          --sans: -apple-system,'Apple SD Gothic Neo','Malgun Gothic',system-ui,sans-serif; }
  * { box-sizing:border-box; }
  body { background:var(--void); color:var(--textPri); font-family:var(--sans);
         margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:24px; }
  .box { background:var(--surface); border:1px solid var(--hair); border-radius:16px;
         padding:32px 28px; width:100%; max-width:360px; box-shadow:0 1px 3px rgba(19,26,44,.06); }
  .eyebrow { font-size:11px; letter-spacing:2px; color:var(--textTer); font-family:var(--mono); }
  h1 { font-size:20px; margin:4px 0 22px; }
  input { width:100%; background:#F0F2F8; border:1px solid var(--hair); border-radius:10px;
          padding:12px 14px; font-size:15px; font-family:var(--sans); color:var(--textPri); }
  button { width:100%; margin-top:10px; background:var(--signature); border:none; color:#fff;
           padding:12px; border-radius:10px; font-size:14px; font-weight:600;
           font-family:var(--sans); cursor:pointer; }
  .msg { margin-top:12px; font-size:12px; color:#E5484D; min-height:16px; }
  .note { margin-top:18px; font-size:11px; color:var(--textTer); line-height:1.6; }
</style>
</head><body>
  <form class="box" method="POST">
    <div class="eyebrow">SUBSCRIBER ONLY</div>
    <h1>이가람 증시 모니터</h1>
    <input type="password" name="password" placeholder="비밀번호" autofocus autocomplete="current-password" />
    <button type="submit">들어가기</button>
    <div class="msg">${message || ''}</div>
    <div class="note">구독자 전용 페이지입니다. 비밀번호는 매주 일요일에 변경됩니다.</div>
  </form>
</body></html>`;
}

export default async function middleware(req) {
  const pw = process.env.SITE_PASSWORD;

  // 비밀번호를 설정하지 않았으면 잠그지 않습니다(설정 전에 사이트가 막히는 것을 막기 위함).
  if (!pw) return;

  const expected = await tokenOf(pw);

  // 로그인 제출
  if (req.method === 'POST') {
    let entered = '';
    try {
      const form = await req.formData();
      entered = String(form.get('password') || '');
    } catch (e) {}

    if (entered === pw) {
      const res = new Response('', { status: 303, headers: { Location: req.nextUrl.pathname } });
      res.headers.append('Set-Cookie',
        `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      return res;
    }
    return new Response(loginPage('비밀번호가 맞지 않습니다.'), {
      status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // 이미 통과한 사람
  const cookie = req.cookies.get(COOKIE);
  if (cookie && cookie.value === expected) return;

  return new Response(loginPage(''), {
    status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
