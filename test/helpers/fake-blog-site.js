/**
 * test/helpers/fake-blog-site.js
 * 네이버·티스토리를 흉내낸 가짜 사이트.
 *
 * 왜 만들었나:
 *   지금까지는 실제 블로그에 올려보기 전에는 발행이 되는지 알 수 없었다.
 *   그래서 "고쳤습니다 → 눌러보세요 → 또 실패" 를 반복했다.
 *   여기서 진짜 브라우저로 로그인·글쓰기·발행을 끝까지 돌려보면,
 *   적어도 우리 코드가 흐름을 제대로 타는지는 올려보기 전에 확인할 수 있다.
 *
 * 무엇을 확인할 수 있나 (정직하게):
 *   ○ 쿠키를 넣으면 로그인 화면을 건너뛰는가
 *   ○ 쿠키가 없으면 로그인 절차를 밟는가
 *   ○ 제목·본문·태그를 채우고 발행 버튼까지 누르는가
 *   ○ 버튼 위치가 화면 밖이어도 눌리는가
 *   ○ 실패하면 화면을 남기고 원인을 돌려주는가
 *   ✗ 실제 네이버의 화면 구조·캡차·기기 인증까지는 알 수 없다
 */

'use strict';

const http = require('http');

/** 발행된 글을 담아둔다 (검증용) */
const posted = [];

function page(body, opts = {}) {
  return `<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>${opts.title || '테스트'}</title>
<style>body{font-family:sans-serif;margin:0;padding:20px}
  /* 실제로 겪은 "element is outside of the viewport" 를 재현하려고
     발행 버튼을 일부러 화면 한참 아래에 둔다 */
  .far{margin-top:2400px}
  input,textarea{display:block;width:90%;padding:8px;margin:8px 0}
</style></head><body>${body}</body></html>`;
}

function createFakeSite({ requireLogin = true, blockLogin = false } = {}) {
  const sessions = new Set();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cookies = String(req.headers.cookie || '');
    const loggedIn = /FAKE_SESSION=ok/.test(cookies) || sessions.has(cookies);

    const send = (html, status = 200, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', ...headers });
      res.end(html);
    };

    // ── 로그인 화면 ──────────────────────────────────────
    if (url.pathname === '/login') {
      if (blockLogin) {
        return send(page('<h1>보안 확인이 필요합니다</h1><div id="captcha">캡차</div>', { title: '캡차' }));
      }
      return send(page(`
        <h1>로그인</h1>
        <form method="POST" action="/login">
          <input id="id" name="id" placeholder="아이디">
          <input id="pw" name="pw" type="password" placeholder="비밀번호">
          <button class="btn_login" type="submit">로그인</button>
        </form>`, { title: '로그인' }));
    }

    if (url.pathname === '/login' && req.method === 'POST') {
      return send('', 302, { Location: '/', 'Set-Cookie': 'FAKE_SESSION=ok; Path=/' });
    }

    // ── 글쓰기 화면 ──────────────────────────────────────
    if (url.pathname === '/write') {
      if (requireLogin && !loggedIn) return send('', 302, { Location: '/login' });
      return send(page(`
        <h1>글쓰기</h1>
        <input id="title" class="se-title-text" placeholder="제목">
        <textarea id="editor-content" name="content" placeholder="본문"></textarea>
        <input id="tag" class="tag_input" placeholder="태그">
        <div class="far"><button class="publish_btn" onclick="done()">발행</button></div>
        <div id="result"></div>
        <script>
          function done(){
            var t=document.getElementById('title').value;
            var c=document.getElementById('editor-content').value;
            fetch('/api/posted',{method:'POST',headers:{'Content-Type':'application/json'},
              body:JSON.stringify({title:t,content:c})})
              .then(function(){ location.href='/post/1'; });
          }
        </script>`, { title: '글쓰기' }));
    }

    // ── 발행 결과 저장 ───────────────────────────────────
    if (url.pathname === '/api/posted' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      return req.on('end', () => {
        try { posted.push(JSON.parse(body)); } catch (_) {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      });
    }

    if (url.pathname.startsWith('/post/')) {
      const last = posted[posted.length - 1] || {};
      return send(page(`<h1>${last.title || '글'}</h1><div id="body">${last.content || ''}</div>`, { title: '발행됨' }));
    }

    // ── 첫 화면 ──────────────────────────────────────────
    if (requireLogin && !loggedIn) return send('', 302, { Location: '/login' });
    return send(page('<h1>내 블로그</h1><a href="/write">글쓰기</a>', { title: '블로그' }));
  });

  return {
    server,
    posted,
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
    reset: () => { posted.length = 0; },
  };
}

module.exports = { createFakeSite };
