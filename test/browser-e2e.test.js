/**
 * test/browser-e2e.test.js
 * 진짜 브라우저로, 발행 흐름을 끝까지 돌려본다.
 *
 * 가짜 블로그 사이트를 띄우고 실제 Chromium 으로 로그인·작성·발행까지 진행한다.
 * 실제 블로그에 올려보기 전에 우리 코드가 흐름을 제대로 타는지 확인하기 위한 것.
 *
 * 확인되는 것 / 확인 안 되는 것을 분명히 해둔다:
 *   ○ 쿠키를 넣으면 로그인 화면을 건너뛰는가
 *   ○ 화면 밖에 있는 버튼도 눌리는가 (실제로 여기서 실패했었다)
 *   ○ 캡차 같은 화면에 막히면 이유를 돌려주고 화면을 남기는가
 *   ✗ 실제 네이버·카카오의 화면 구조와 자동화 차단까지는 알 수 없다
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createFakeSite } = require('./helpers/fake-blog-site');
const { applyCookies, looksLoggedOut } = require('../publisher/session');
const { clickAny, clickElement, findAny } = require('../publisher/click-helper');
const { saveFailureShot } = require('../publisher/failure-shot');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

/** 이 환경에 설치된 크로미움 찾기 (없으면 테스트를 건너뛴다) */
function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH || '';
  if (!base || !fs.existsSync(base)) return null;
  for (const dir of fs.readdirSync(base)) {
    const p = path.join(base, dir, 'chrome-linux', 'chrome');
    if (dir.startsWith('chromium-') && fs.existsSync(p)) return p;
  }
  return null;
}

const LAUNCH_ARGS = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                     '--disable-gpu', '--single-process', '--no-zygote'];

(async () => {
  console.log('\n🌐 실제 브라우저 발행 흐름 테스트\n');

  const executablePath = findChromium();
  if (!executablePath) {
    console.log('  ⏭  이 환경에 크로미움이 없어 건너뜁니다 (배포 환경에서는 Dockerfile 이 설치합니다)\n');
    return;
  }

  // ── 1) 쿠키로 로그인 건너뛰고 발행까지 ────────────────────
  {
    const site = createFakeSite({ requireLogin: true });
    const port = await site.listen();
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ executablePath, args: LAUNCH_ARGS });
    try {
      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

      const applied = await applyCookies(context, 'FAKE_SESSION=ok', '127.0.0.1');
      ok('쿠키를 브라우저에 넣는다', applied.ok === true);

      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      ok('쿠키가 있으면 로그인 화면으로 튕기지 않는다', !looksLoggedOut(page.url()) && !page.url().includes('/login'));

      await page.goto(`${base}/write`, { waitUntil: 'domcontentloaded' });
      ok('글쓰기 화면까지 들어간다', page.url().includes('/write'));

      // 제목·본문 채우기 — 서버 코드와 같은 방식으로 찾는다
      const titleField = await findAny(page, ['.se-title-text', '#title', '[placeholder="제목"]']);
      ok('제목 칸을 찾는다', !!titleField.el);
      await titleField.el.fill('가짜 사이트 발행 테스트');

      const bodyField = await findAny(page, ['textarea#editor-content', 'textarea[name="content"]']);
      ok('본문 칸을 찾는다', !!bodyField.el);
      await bodyField.el.fill('<p>본문입니다</p>');

      /* 발행 버튼은 화면 한참 아래에 있다.
         실제로 티스토리에서 "element is outside of the viewport" 로 실패했던 상황이다. */
      const clicked = await clickAny(page, ['.publish_btn', 'button:has-text("발행")'],
                                     { timeout: 8000, label: '발행 버튼' });
      ok('화면 밖에 있는 발행 버튼도 눌린다', clicked.ok === true);

      await page.waitForURL(/\/post\//, { timeout: 8000 }).catch(() => {});
      ok('발행 후 글 주소로 이동한다', /\/post\//.test(page.url()));
      ok('사이트에 글이 실제로 저장됐다', site.posted.length === 1);
      ok('제목이 그대로 전달됐다', site.posted[0].title === '가짜 사이트 발행 테스트');
      ok('본문이 그대로 전달됐다', site.posted[0].content.includes('본문입니다'));
    } finally {
      await browser.close().catch(() => {});
      await site.close();
    }
  }

  // ── 2) 쿠키 없이 아이디·비밀번호로 로그인 ─────────────────
  {
    const site = createFakeSite({ requireLogin: true });
    const port = await site.listen();
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ executablePath, args: LAUNCH_ARGS });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${base}/write`, { waitUntil: 'domcontentloaded' });
      ok('쿠키가 없으면 로그인 화면으로 보낸다', page.url().includes('/login'));

      const idField = await findAny(page, ['#id', 'input[name="id"]']);
      const pwField = await findAny(page, ['#pw', 'input[type="password"]']);
      ok('아이디 칸을 찾는다', !!idField.el);
      ok('비밀번호 칸을 찾는다', !!pwField.el);
      await idField.el.fill('tester');
      await pwField.el.fill('secret');

      // 로그인 버튼 후보 중 하나로 눌린다
      const login = await clickAny(page, ['.btn_login', 'button[type="submit"]'],
                                   { timeout: 6000, label: '로그인 버튼' });
      ok('로그인 버튼을 찾아 누른다', login.ok === true);
    } finally {
      await browser.close().catch(() => {});
      await site.close();
    }
  }

  // ── 3) 캡차처럼 막힌 화면 — 이유를 알고 화면을 남기는가 ───
  {
    const site = createFakeSite({ requireLogin: true, blockLogin: true });
    const port = await site.listen();
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ executablePath, args: LAUNCH_ARGS });
    try {
      const page = await (await browser.newContext()).newPage();
      await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });

      const login = await clickAny(page, ['.btn_login', 'button[type="submit"]'],
                                   { timeout: 2000, label: '로그인 버튼' });
      ok('막힌 화면에서는 버튼을 못 찾는다고 알려준다', login.ok === false);
      ok('오래 멈춰 있지 않고 이유를 준다', /찾지 못했습니다/.test(login.error));

      const shot = await saveFailureShot(page, 'e2e');
      ok('막힌 화면을 사진으로 남긴다', !!shot && shot.startsWith('/uploads/'));
      const file = path.join(__dirname, '..', shot.replace('/uploads/', 'uploads/'));
      ok('사진 파일이 실제로 생긴다', fs.existsSync(file) && fs.statSync(file).size > 1000);
      fs.unlinkSync(file);
    } finally {
      await browser.close().catch(() => {});
      await site.close();
    }
  }

  // ── 4) 만료된 쿠키를 넣었을 때 ───────────────────────────
  {
    const site = createFakeSite({ requireLogin: true });
    const port = await site.listen();
    const base = `http://127.0.0.1:${port}`;
    const browser = await chromium.launch({ executablePath, args: LAUNCH_ARGS });
    try {
      const context = await browser.newContext();
      await applyCookies(context, 'FAKE_SESSION=만료됨', '127.0.0.1');
      const page = await context.newPage();
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      ok('쿠키가 죽었으면 로그인 화면으로 튕긴다', page.url().includes('/login'));
    } finally {
      await browser.close().catch(() => {});
      await site.close();
    }
  }

  console.log(`\n✅ ${pass}개 통과 — 실제 브라우저로 끝까지 확인\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
