/**
 * test/cookie-session.test.js
 * 아이디·비밀번호 로그인 대신 쿠키로 붙는 길이 제대로 동작하는가.
 *
 * 왜 필요한가:
 *   네이버·카카오는 자동 로그인을 막는다. 로그인 버튼 선택자를 맞춰놔도
 *   캡차·기기 인증·화면 개편으로 금방 다시 깨진다.
 *   쿠키를 쓰면 로그인 단계가 통째로 사라져 막힐 구간이 없어진다.
 *
 * 사람이 어디서 복사해오든(확장앱 JSON / 개발자도구 문자열) 받아들여야 한다.
 */

'use strict';

const assert = require('assert');
const { parseCookies, applyCookies, looksLoggedOut } = require('../publisher/session');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

(async () => {
  console.log('\n🍪 쿠키 로그인 테스트\n');

  // ── 1) 개발자도구에서 그대로 복사한 문자열 ───────────────
  const r1 = parseCookies('NID_AUT=abc123; NID_SES=def456', '.naver.com');
  ok('"a=1; b=2" 형태를 받는다', r1.ok === true && r1.cookies.length === 2);
  ok('이름과 값을 제대로 나눈다', r1.cookies[0].name === 'NID_AUT' && r1.cookies[0].value === 'abc123');
  ok('도메인을 채워준다', r1.cookies[0].domain === '.naver.com');
  ok('경로 기본값을 넣어준다', r1.cookies[0].path === '/');

  // 값에 = 가 들어 있어도 잘라먹으면 안 된다 (실제 토큰에 흔하다)
  const r1b = parseCookies('T=aGVsbG8=; U=x', '.naver.com');
  ok('값 안의 = 를 잘라먹지 않는다', r1b.cookies[0].value === 'aGVsbG8=');

  // ── 2) 확장앱이 내보낸 JSON 배열 ─────────────────────────
  const json = JSON.stringify([
    { name: 'NID_AUT', value: 'v1', domain: '.naver.com', path: '/', httpOnly: true, secure: true,
      expirationDate: Math.floor(Date.now() / 1000) + 86400 },
    { name: 'NID_SES', value: 'v2', domain: '.naver.com' },
  ]);
  const r2 = parseCookies(json, '.naver.com');
  ok('확장앱 JSON 배열을 받는다', r2.ok === true && r2.cookies.length === 2);
  ok('만료 시각을 살려서 넣는다', typeof r2.cookies[0].expires === 'number');
  ok('httpOnly 를 유지한다', r2.cookies[0].httpOnly === true);

  // 이미 지난 만료는 넣지 않는다 — 넣자마자 사라져 로그인이 안 된 것처럼 보인다
  const expired = parseCookies(JSON.stringify([
    { name: 'OLD', value: 'x', domain: '.naver.com', expirationDate: 1000 },
  ]), '.naver.com');
  ok('이미 지난 만료는 세션 쿠키로 둔다', expired.cookies[0].expires === undefined);

  // ── 3) 잘못 붙여넣은 경우 ────────────────────────────────
  ok('빈 값은 분명히 거절한다', parseCookies('', '.naver.com').ok === false);
  const broken = parseCookies('[{"name":"a","value":', '.naver.com');
  ok('잘린 JSON 은 이유를 알려준다', broken.ok === false && /읽지 못했|잘렸/.test(broken.error));
  ok('형식 불명은 형식 문제라고 알려준다', parseCookies('그냥아무말', '.naver.com').ok === false);

  // ── 4) 브라우저에 실제로 심는 부분 ───────────────────────
  const added = [];
  const fakeCtx = { addCookies: async (list) => { added.push(...list); } };
  const applied = await applyCookies(fakeCtx, 'A=1; B=2', '.tistory.com');
  ok('컨텍스트에 쿠키를 넣는다', applied.ok === true && applied.count === 2);
  ok('넣은 개수가 맞는다', added.length === 2);
  ok('도메인이 티스토리로 붙는다', added.every(c => c.domain === '.tistory.com'));

  const failCtx = { addCookies: async () => { throw new Error('형식 오류'); } };
  const failed = await applyCookies(failCtx, 'A=1', '.naver.com');
  ok('브라우저가 거부하면 이유를 돌려준다', failed.ok === false && /넣지 못했/.test(failed.error));

  // ── 5) 쿠키가 만료됐는지 판단 ────────────────────────────
  ok('네이버 로그인 화면이면 만료로 본다', looksLoggedOut('https://nid.naver.com/nidlogin.login') === true);
  ok('카카오 로그인 화면이면 만료로 본다', looksLoggedOut('https://accounts.kakao.com/login') === true);
  ok('티스토리 로그인 화면이면 만료로 본다', looksLoggedOut('https://www.tistory.com/auth/login') === true);
  ok('정상 화면은 만료로 보지 않는다', looksLoggedOut('https://blog.naver.com/me') === false);

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
