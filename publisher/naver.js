/**
 * publisher/naver.js
 * Playwright로 네이버 블로그에 직접 로그인 후 글 발행
 * - 스마트에디터 ONE 기반 (2024년 기준)
 */

const { chromium } = require('playwright');
const { clickAny, clickElement, findAny } = require('./click-helper');
const { applyCookies, looksLoggedOut } = require('./session');
const { saveFailureShot } = require('./failure-shot');
const path = require('path');
const fs = require('fs');

const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const BLOG_WRITE_URL  = 'https://blog.naver.com/ArticleWrite.naver';

async function publishToNaver({ id, pw, blogId, title, content, tags = [], imagePaths = [], category = '', cookies = '' }) {
  /* 쿠키가 있으면 로그인 단계를 통째로 건너뛴다.
     네이버는 자동 로그인을 막기 때문에, 아이디·비밀번호 방식은
     캡차·기기 인증·화면 개편으로 계속 깨진다. */
  const useCookies = !!String(cookies || '').trim();
  if (!useCookies && (!id || !pw)) {
    return {
      success: false,
      error: '네이버 로그인 정보가 없습니다 — 설정에서 쿠키(권장) 또는 아이디/비밀번호를 넣으세요',
      platform: 'naver',
    };
  }
  /* 브라우저 실행부터 예외로 터지면 호출한 쪽이 통째로 죽어
     다른 블로그 발행까지 못 하게 된다. 여기서 결과값으로 바꿔 돌려준다. */
  let browser, context, page;
  try {
  // Docker 환경: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 또는 시스템 chromium 사용
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    // Railway 컨테이너는 메모리가 작아 기본 설정으로는 크로미움이 컨테이너를
    // 통째로 죽인다(OOM). 공유메모리·GPU·부가기능을 줄여 사용량을 낮춘다.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled',
           '--disable-dev-shm-usage', '--disable-gpu', '--single-process', '--no-zygote',
           '--disable-extensions', '--disable-background-networking', '--mute-audio',
           '--js-flags=--max-old-space-size=256'],
  });

  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
  });

  // 쿠키를 먼저 심는다 — 이게 있으면 로그인 화면을 볼 일이 없다
  if (useCookies) {
    const applied = await applyCookies(context, cookies, '.naver.com');
    if (!applied.ok) {
      await browser.close().catch(() => {});
      return { success: false, error: `네이버 쿠키 오류 — ${applied.error}`, platform: 'naver' };
    }
    console.log(`[Naver] 쿠키 ${applied.count}개 적용 — 로그인 단계 건너뜀`);
  }

  // 자동화 감지 우회
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  page = await context.newPage();
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    const m = /Executable doesn't exist|ENOENT/.test(err.message)
      ? '브라우저(Chromium)가 서버에 없습니다 — 배포 이미지 확인 필요'
      : `브라우저 실행 실패: ${err.message}`;
    return { success: false, error: m, platform: 'naver' };
  }

  try {
    // ── 1. 로그인 ─────────────────────────────────
    if (useCookies) {
      // 쿠키가 살아있는지만 확인한다
      await page.goto('https://blog.naver.com', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(randomDelay(800, 1500));
      if (looksLoggedOut(page.url())) {
        throw new Error('NAVER_COOKIE_EXPIRED: 쿠키가 만료됐습니다 — 설정에서 쿠키를 다시 복사해 넣어주세요');
      }
      console.log('[Naver] 쿠키 로그인 확인됨');
    } else {
    await page.goto(NAVER_LOGIN_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(randomDelay(800, 1500));

    // 아이디 입력 (사람처럼 타이핑)
    // 네이버가 입력칸 id를 바꾼 적이 있어 후보를 여러 개 둔다
    const idField = await findAny(page, ['#id', 'input[name="id"]', 'input#loginId'], { timeout: 10000 });
    if (!idField.el) throw new Error('네이버 로그인 화면에서 아이디 입력칸을 찾지 못했습니다');
    await clickElement(idField.el);
    await humanType(page, idField.sel, id);
    await page.waitForTimeout(randomDelay(300, 700));

    const pwField = await findAny(page, ['#pw', 'input[name="pw"]', 'input[type="password"]'], { timeout: 8000 });
    if (!pwField.el) throw new Error('네이버 로그인 화면에서 비밀번호 입력칸을 찾지 못했습니다');
    await clickElement(pwField.el);
    await humanType(page, pwField.sel, pw);
    await page.waitForTimeout(randomDelay(400, 900));

    /* 로그인 버튼.
       예전엔 '.btn_login' 하나만 봤는데, 못 찾으면 30초를 기다렸다 실패했다.
       (실제로 "page.click: Timeout 30000ms exceeded - waiting for locator('.btn_login')" 로 발행이 멈췄다)
       후보를 여러 개 두고, 그래도 못 찾으면 엔터로 제출한다 — 폼은 엔터로도 넘어간다. */
    const loginClick = await clickAny(page, [
      '.btn_login', '#log\\.login', 'button[type="submit"]',
      'input[type="submit"]', '.btn_login_wrap button', 'button:has-text("로그인")',
    ], { timeout: 8000, label: '로그인 버튼', optional: true });

    if (!loginClick.ok) {
      console.warn('[Naver] 로그인 버튼을 못 찾아 엔터로 제출합니다');
      await page.keyboard.press('Enter');
    }

    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(randomDelay(1000, 2000));

    // 캡차 or 2차 인증 확인
    const currentUrl = page.url();
    if (currentUrl.includes('nidlogin') || currentUrl.includes('captcha')) {
      throw new Error('NAVER_LOGIN_BLOCKED: 네이버가 자동 로그인을 막았습니다 (캡차 또는 기기 인증). '
        + '설정에서 쿠키를 넣으면 로그인 단계를 건너뛸 수 있습니다.');
    }
    }   // 아이디/비밀번호 로그인 끝

    // ── 2. 글쓰기 페이지 이동 ─────────────────────
    await page.goto(`${BLOG_WRITE_URL}?blogId=${blogId}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(randomDelay(2000, 3500));

    // 스마트에디터 iframe 대기
    const editorFrame = await waitForEditorFrame(page);

    // ── 3. 제목 입력 ──────────────────────────────
    await page.waitForTimeout(randomDelay(500, 1000));
    const titleSel = '.se-title-text, [placeholder="제목"], #title';
    const titleEl = await page.$(titleSel);
    if (titleEl) {
      await clickElement(titleEl);
      await humanType(page, titleSel, title);
    }

    await page.waitForTimeout(randomDelay(600, 1200));

    // ── 4. 본문 입력 (에디터 내부) ────────────────
    if (editorFrame) {
      await inputContentInFrame(editorFrame, content, imagePaths);
    } else {
      // 폴백: contenteditable 직접 사용
      const bodyEl = await page.$('.se-component-content, [contenteditable="true"]');
      if (bodyEl) {
        await clickElement(bodyEl);
        await page.keyboard.type(content, { delay: randomDelay(20, 60) });
      }
    }

    await page.waitForTimeout(randomDelay(800, 1500));

    // ── 5. 태그 입력 ──────────────────────────────
    if (tags.length > 0) {
      await inputTags(page, tags);
    }

    // ── 6. 발행 ───────────────────────────────────
    await page.waitForTimeout(randomDelay(1000, 2000));

    // 발행 버튼 클릭
    const published = await clickAny(page, [
      '.publish_btn', '[data-role="publishButton"]', '.btn_publish',
      'button:has-text("발행")', 'button:has-text("등록")',
    ], { timeout: 10000, label: '발행 버튼' });
    if (!published.ok) throw new Error(published.error);
    await page.waitForTimeout(randomDelay(1500, 2500));

    // 발행 확인 모달 — 안 뜰 수도 있으므로 없으면 그냥 넘어간다
    await clickAny(page, [
      '[data-action="confirm"]', '.btn_confirm', '.se-popup-button-confirm',
      'button:has-text("확인")', 'button:has-text("발행")',
    ], { timeout: 5000, label: '확인 버튼', optional: true });
    await page.waitForTimeout(randomDelay(2000, 3000));

    const postUrl = page.url();
    console.log(`[Naver] 발행 완료: ${postUrl}`);
    return { success: true, url: postUrl, platform: 'naver' };

  } catch (err) {
    console.error('[Naver] 발행 실패:', err.message);
    // 막힌 화면을 남긴다 — 캡차인지, 비번 오류인지, 화면이 바뀐 건지 눈으로 봐야 고칠 수 있다
    const shot = await saveFailureShot(page, 'naver').catch(() => null);
    return { success: false, error: err.message, screenshot: shot, platform: 'naver' };
  } finally {
    // 닫기 실패가 발행 결과를 덮어쓰지 않게 한다
    if (browser) await browser.close().catch(() => {});
  }
}

// ── 헬퍼 함수 ────────────────────────────────────────────

function randomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** 사람처럼 한 글자씩 타이핑 (오타 없이, 속도 변화만) */
async function humanType(page, selector, text) {
  for (const char of text) {
    await page.type(selector, char, { delay: randomDelay(40, 120) });
    // 가끔 짧게 멈춤
    if (Math.random() < 0.05) {
      await page.waitForTimeout(randomDelay(200, 500));
    }
  }
}

async function waitForEditorFrame(page) {
  try {
    await page.waitForSelector('iframe[name*="editor"], .se-frame iframe, iframe#mainFrame', { timeout: 10000 });
    const frames = page.frames();
    return frames.find(f => f.name().includes('editor') || f.url().includes('editor')) || null;
  } catch {
    return null;
  }
}

async function inputContentInFrame(frame, content, imagePaths) {
  try {
    await frame.waitForSelector('[contenteditable="true"], .se-content', { timeout: 8000 });
    const el = await frame.$('[contenteditable="true"]');
    if (el) {
      await el.click();
      // 내용을 문단별로 나눠서 타이핑
      const paragraphs = content.split('\n');
      for (let i = 0; i < paragraphs.length; i++) {
        if (paragraphs[i].trim()) {
          await frame.keyboard.type(paragraphs[i], { delay: randomDelay(15, 50) });
        }
        if (i < paragraphs.length - 1) {
          await frame.keyboard.press('Enter');
          await new Promise(r => setTimeout(r, randomDelay(100, 300)));
        }
      }
    }
  } catch (err) {
    console.warn('[Naver] 에디터 프레임 입력 실패:', err.message);
  }
}

async function inputTags(page, tags) {
  try {
    const tagInput = await page.$('.tag_area input, #tagInput, input[placeholder*="태그"]');
    if (!tagInput) return;
    for (const tag of tags.slice(0, 10)) {
      await tagInput.click();
      await humanType(page, '.tag_area input, #tagInput, input[placeholder*="태그"]', tag);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(randomDelay(300, 600));
    }
  } catch (err) {
    console.warn('[Naver] 태그 입력 실패:', err.message);
  }
}

module.exports = { publishToNaver };
