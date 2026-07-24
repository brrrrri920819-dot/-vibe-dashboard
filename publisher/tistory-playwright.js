/**
 * publisher/tistory-playwright.js
 * OAuth 없이 Playwright로 티스토리에 직접 로그인 후 글 발행
 * 토큰 만료 없음
 */

const { chromium } = require('playwright');

const KAKAO_LOGIN_URL  = 'https://accounts.kakao.com/login';
const TISTORY_WRITE    = 'https://www.tistory.com/apis/post/write';

function delay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function publishToTistoryPlaywright({ id, pw, blogName, title, content, tags = [] }) {
  const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const browser = await chromium.launch({
    headless: true,
    executablePath: execPath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();

  try {
    // ── 1. 티스토리 로그인 (카카오 계정) ─────────────────
    await page.goto('https://www.tistory.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(1500, 2500);

    // 카카오 로그인 버튼
    const kakaoBtn = await page.$('.btn_kakao, a[href*="kakao"], button:has-text("카카오")');
    if (kakaoBtn) {
      await kakaoBtn.click();
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
      await delay(1500, 2500);
    }

    // 카카오 이메일/ID 입력
    const emailInput = await page.$('#loginId, input[name="loginId"], input[type="email"]');
    if (emailInput) {
      await emailInput.fill(id);
      await delay(400, 800);
      const pwInput = await page.$('#loginPw, input[name="loginPw"], input[type="password"]');
      if (pwInput) {
        await pwInput.fill(pw);
        await delay(400, 800);
        const loginBtn = await page.$('button[type="submit"], .btn_login, #btnLogin');
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await delay(2000, 3000);
        }
      }
    }

    const curUrl = page.url();
    console.log('[Tistory-PW] 로그인 후 URL:', curUrl);
    if (curUrl.includes('login') || curUrl.includes('accounts.kakao')) {
      throw new Error('로그인 실패 — TISTORY_ID/TISTORY_PW 확인 필요 (카카오 계정 사용 시 이메일/비번 입력)');
    }

    // ── 2. 글쓰기 페이지로 이동 ───────────────────────────
    const writeUrl = `https://${blogName}.tistory.com/manage/post/write`;
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2000, 3000);

    console.log('[Tistory-PW] 글쓰기 페이지:', page.url());

    // ── 3. 제목 입력 ──────────────────────────────────────
    const titleSel = '#post-title-inp, input[name="title"], .title-input input';
    await page.waitForSelector(titleSel, { timeout: 10000 }).catch(() => {});
    const titleEl = await page.$(titleSel);
    if (titleEl) {
      await titleEl.click();
      await titleEl.fill(title);
    }
    await delay(500, 1000);

    // ── 4. 본문 입력 (HTML 모드 진입) ────────────────────
    // HTML 직접 입력 버튼 찾기
    const htmlModeBtn = await page.$('button:has-text("HTML"), a:has-text("HTML"), .btn_html');
    if (htmlModeBtn) {
      await htmlModeBtn.click();
      await delay(800, 1500);
    }

    // textarea 또는 contenteditable에 HTML 삽입
    const textarea = await page.$('textarea#editor-content, textarea[name="content"], .CodeMirror textarea');
    if (textarea) {
      await textarea.click();
      await textarea.fill(content);
    } else {
      // contenteditable 에디터에 삽입
      const editor = await page.$('[contenteditable="true"].editor, #editor, .editor-area [contenteditable]');
      if (editor) {
        await editor.click();
        await page.evaluate((el, html) => { el.innerHTML = html; }, editor, content);
      }
    }
    await delay(800, 1500);

    // ── 5. 태그 입력 ──────────────────────────────────────
    if (tags.length > 0) {
      const tagInput = await page.$('#tag-inp, input[name="tag"], .tag-input input');
      if (tagInput) {
        await tagInput.click();
        await tagInput.fill(tags.slice(0, 10).join(','));
        await page.keyboard.press('Enter');
        await delay(500, 800);
      }
    }

    // ── 6. 발행 ───────────────────────────────────────────
    const publishBtn = await page.$('button:has-text("완료"), button:has-text("발행"), .btn_publish, #publish-layer-btn');
    if (!publishBtn) throw new Error('발행 버튼을 찾을 수 없습니다');
    await publishBtn.click();
    await delay(1500, 2500);

    // 공개 설정 → 완료
    const confirmPublish = await page.$('button:has-text("발행"), .btn_ok, button:has-text("확인")');
    if (confirmPublish) {
      await confirmPublish.click();
      await delay(2000, 3000);
    }

    const postUrl = page.url();
    console.log('[Tistory-PW] 발행 완료:', postUrl);
    return { success: true, url: postUrl, platform: 'tistory' };

  } catch (err) {
    console.error('[Tistory-PW] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'tistory' };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { publishToTistoryPlaywright };
