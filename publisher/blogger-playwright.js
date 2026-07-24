/**
 * publisher/blogger-playwright.js
 * OAuth 없이 Playwright로 Blogger에 직접 로그인 후 글 발행
 * 토큰 만료 없음
 */

const { chromium } = require('playwright');

function delay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function publishToBloggerPlaywright({ email, pw, blogId, blogUrl, title, content, tags = [] }) {
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
    // ── 1. 구글 로그인 ────────────────────────────────────
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(1500, 2500);

    // 이메일 입력
    const emailInput = await page.$('input[type="email"]');
    if (!emailInput) throw new Error('구글 로그인 페이지를 찾을 수 없습니다');
    await emailInput.fill(email);
    await delay(500, 900);
    await page.click('#identifierNext, button:has-text("다음"), button:has-text("Next")');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await delay(1500, 2500);

    // 비밀번호 입력
    const pwInput = await page.$('input[type="password"]');
    if (!pwInput) throw new Error('비밀번호 입력창을 찾을 수 없습니다 (2단계 인증 또는 보안 차단)');
    await pwInput.fill(pw);
    await delay(500, 900);
    await page.click('#passwordNext, button:has-text("다음"), button:has-text("Next")');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2000, 3500);

    const curUrl = page.url();
    console.log('[Blogger-PW] 로그인 후 URL:', curUrl);
    if (curUrl.includes('accounts.google.com') && !curUrl.includes('oauth')) {
      throw new Error('구글 로그인 실패 — BLOGGER_EMAIL/BLOGGER_PW 확인 또는 2단계 인증 해제 필요');
    }

    // ── 2. Blogger 새 글 쓰기 페이지 ─────────────────────
    const newPostUrl = blogId
      ? `https://www.blogger.com/blog/post/create/${blogId}`
      : 'https://www.blogger.com/blogger.g?action=CREATE_POST';

    await page.goto(newPostUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000, 4500);

    console.log('[Blogger-PW] 글쓰기 페이지:', page.url());

    // ── 3. 제목 입력 ──────────────────────────────────────
    const titleEl = await page.$('input[name="title"], textarea[name="title"], .title input, [data-field="title"]');
    if (titleEl) {
      await titleEl.click();
      await titleEl.fill(title);
      await delay(500, 900);
    }

    // ── 4. HTML 모드로 전환 후 본문 입력 ─────────────────
    const htmlTab = await page.$('button:has-text("HTML"), a:has-text("HTML"), [data-view="html"]');
    if (htmlTab) {
      await htmlTab.click();
      await delay(800, 1500);
    }

    // 에디터에 HTML 삽입
    const editorEl = await page.$('textarea.textarea, #postingHtmlBox, .html-editor textarea, [contenteditable="true"]');
    if (editorEl) {
      await editorEl.click();
      const tag = await editorEl.evaluate(el => el.tagName);
      if (tag === 'TEXTAREA') {
        await editorEl.fill(content);
      } else {
        await page.evaluate((el, html) => { el.innerHTML = html; }, editorEl, content);
      }
    }
    await delay(1000, 2000);

    // ── 5. 라벨(태그) 입력 ────────────────────────────────
    if (tags.length > 0) {
      const labelBtn = await page.$('button:has-text("라벨"), button:has-text("Label"), [aria-label*="label"], [aria-label*="라벨"]');
      if (labelBtn) {
        await labelBtn.click();
        await delay(500, 900);
        const labelInput = await page.$('input[placeholder*="라벨"], input[placeholder*="label"]');
        if (labelInput) {
          for (const tag of tags.slice(0, 10)) {
            await labelInput.fill(tag);
            await page.keyboard.press('Enter');
            await delay(200, 400);
          }
        }
      }
    }

    // ── 6. 발행 ───────────────────────────────────────────
    const publishBtn = await page.$('button:has-text("게시"), button:has-text("Publish"), button:has-text("발행"), [data-action="publish"]');
    if (!publishBtn) throw new Error('발행 버튼을 찾을 수 없습니다');
    await publishBtn.click();
    await delay(2000, 3500);

    // 확인 다이얼로그
    const okBtn = await page.$('button:has-text("확인"), button:has-text("OK"), button:has-text("게시"), .btn-primary');
    if (okBtn) {
      await okBtn.click();
      await delay(2500, 4000);
    }

    const postUrl = page.url();
    console.log('[Blogger-PW] 발행 완료:', postUrl);
    return { success: true, url: postUrl, platform: 'blogger' };

  } catch (err) {
    console.error('[Blogger-PW] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'blogger' };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { publishToBloggerPlaywright };
