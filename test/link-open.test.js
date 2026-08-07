/**
 * test/link-open.test.js
 * "글이 발행됐는지 클릭해도 안 보인다" 의 재발 방지.
 *
 * 원인: 홈화면 앱(주소창 없는 standalone)에서는 target="_blank" 링크가
 *       아무 동작도 하지 않는다. 그래서 발행된 글 링크를 눌러도 반응이 없었고,
 *       올라간 건지 아닌지 확인할 방법이 없었다.
 *
 * 그리고 네이버는 발행 뒤 '편집기 주소'를 글 주소라며 돌려줬다.
 * 눌러도 글이 안 보이는 링크를 주면 확인이 안 되는 건 마찬가지다.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'blog.html'), 'utf8');

(async () => {
  console.log('\n🔗 링크 열기 테스트\n');

  // ── 1) 결과 화면에 target="_blank" 가 남아 있으면 안 된다 ──
  const realBlanks = html.split('\n')
    .filter(l => /target="_blank"/.test(l) && !/^\s*\/\*|^\s*\*/.test(l));
  ok('결과 링크에 target="_blank" 가 남아있지 않다', realBlanks.length === 0);

  ok('링크 열기 helper 가 있다', /function openExternal\(/.test(html));
  ok('링크 만들기 helper 가 있다', /function extLink\(/.test(html));

  // ── 2) 새 창이 막히면 현재 창에서 열어야 한다 ─────────────
  const parts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const slice = (name) => {
    const i = parts.indexOf(`function ${name}(`);
    let depth = 0, started = false, j = i;
    for (; j < parts.length; j++) {
      if (parts[j] === '{') { depth++; started = true; }
      else if (parts[j] === '}') { depth--; if (started && depth === 0) { j++; break; } }
    }
    return parts.slice(i, j);
  };
  const escHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const make = new Function('window', 'escHtml',
    `${slice('openExternal')}\n${slice('extLink')}\nreturn { openExternal, extLink };`);

  // 새 창이 열리는 보통 브라우저
  let navigated = '';
  let api = make({ open: () => ({ closed: false }), location: { set href(v) { navigated = v; } } }, escHtml);
  api.openExternal('https://example.com/post');
  ok('새 창이 열리면 현재 창을 옮기지 않는다', navigated === '');

  // 홈화면 앱처럼 새 창이 막히는 경우
  navigated = '';
  api = make({ open: () => null, location: { set href(v) { navigated = v; } } }, escHtml);
  api.openExternal('https://example.com/post');
  ok('새 창이 막히면 현재 창에서 연다', navigated === 'https://example.com/post');

  // window.open 자체가 예외를 던지는 경우도 있다
  navigated = '';
  api = make({ open: () => { throw new Error('blocked'); }, location: { set href(v) { navigated = v; } } }, escHtml);
  api.openExternal('https://example.com/post');
  ok('새 창 열기가 오류를 내도 현재 창에서 연다', navigated === 'https://example.com/post');

  ok('주소가 없으면 아무 것도 하지 않는다', api.openExternal('') === false);

  // ── 3) 만들어지는 링크 태그 ──────────────────────────────
  const tag = api.extLink('https://b.example/1', '글 보기', 'color:red');
  ok('링크에 주소가 들어간다', tag.includes('href="https://b.example/1"'));
  ok('클릭을 가로채 직접 연다', tag.includes('onclick="return openExternal('));
  ok('target="_blank" 를 쓰지 않는다', !tag.includes('target="_blank"'));
  const evil = api.extLink('https://x/"onmouseover="alert(1)', '보기');
  ok('주소에 든 따옴표를 막는다', !evil.includes('onmouseover="alert'));

  // ── 4) 네이버가 편집기 주소를 글 주소라고 하지 않는가 ─────
  const naver = fs.readFileSync(path.join(root, 'publisher', 'naver.js'), 'utf8');
  ok('편집기 주소를 걸러낸다', /ArticleWrite\|postwrite/.test(naver));
  ok('걸러지면 블로그 주소로 바꾼다', /blog\.naver\.com\/\$\{blogId\}/.test(naver));

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
