/**
 * publisher/naver.js
 * Playwright로 네이버 블로그에 직접 로그인 후 글 발행
 * - 스마트에디터 ONE 기반 (2024년 기준)
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const NAVER_LOGIN_URL = 'https://nid.naver.com/nidlogin.login';
const BLOG_WRITE_URL  = 'https://blog.naver.com/ArticleWrite.naver';

async function publishToNaver({ id, pw, blogId, title, content, tags = [], imagePaths = [], category = '' }) {
  // Docker 환경: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 또는 시스템 chromium 사용
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'ko-KR',
  });

  // 자동화 감지 우회
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // ── 1. 로그인 ─────────────────────────────────
    await page.goto(NAVER_LOGIN_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(randomDelay(800, 1500));

    // 아이디 입력 (사람처럼 타이핑)
    await page.click('#id');
    await humanType(page, '#id', id);
    await page.waitForTimeout(randomDelay(300, 700));

    await page.click('#pw');
    await humanType(page, '#pw', pw);
    await page.waitForTimeout(randomDelay(400, 900));

    await page.click('.btn_login');
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(randomDelay(1000, 2000));

    // 캡차 or 2차 인증 확인
    const currentUrl = page.url();
    if (currentUrl.includes('nidlogin') || currentUrl.includes('captcha')) {
      throw new Error('NAVER_LOGIN_BLOCKED: 캡차 또는 2차 인증이 필요합니다. 수동 로그인 후 쿠키를 저장하세요.');
    }

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
      await titleEl.click();
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
        await bodyEl.click();
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
    const publishBtn = await page.$('.publish_btn, [data-role="publishButton"], button:has-text("발행")');
    if (publishBtn) {
      await publishBtn.click();
      await page.waitForTimeout(randomDelay(1500, 2500));
    }

    // 발행 확인 모달 처리
    const confirmBtn = await page.$('[data-action="confirm"], .btn_confirm, button:has-text("확인")');
    if (confirmBtn) {
      await confirmBtn.click();
      await page.waitForTimeout(randomDelay(2000, 3000));
    }

    const postUrl = page.url();
    console.log(`[Naver] 발행 완료: ${postUrl}`);
    return { success: true, url: postUrl, platform: 'naver' };

  } catch (err) {
    console.error('[Naver] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'naver' };
  } finally {
    await browser.close();
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
