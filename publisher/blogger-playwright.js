/**
 * publisher/blogger-playwright.js
 * Playwright로 Blogger에 직접 로그인 후 글 발행 (OAuth 없음, 토큰 만료 없음)
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
    await page.goto('https://accounts.google.com/signin/v2/identifier', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(1500, 2500);

    // 이메일 입력
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    await page.fill('input[type="email"]', email);
    await delay(500, 900);
    await page.keyboard.press('Enter');
    await delay(2000, 3000);

    // 비밀번호 입력
    await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    await page.fill('input[type="password"]', pw);
    await delay(500, 900);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
    await delay(2500, 4000);

    const curUrl = page.url();
    console.log('[Blogger-PW] 로그인 후 URL:', curUrl);
    if (curUrl.includes('accounts.google.com') && !curUrl.includes('oauth') && !curUrl.includes('myaccount')) {
      // 2단계 인증 등 추가 확인이 있을 수 있음 — 잠깐 기다림
      await delay(3000, 5000);
      const stillLogin = page.url().includes('accounts.google.com');
      if (stillLogin) throw new Error('구글 로그인 실패 — BLOGGER_EMAIL/BLOGGER_PW 확인 또는 2단계 인증 해제/앱 비밀번호 사용 필요');
    }

    // ── 2. Blogger 새 글 쓰기 페이지 ─────────────────────
    // blogId 없으면 Blogger 메인에서 자동 감지
    let targetBlogId = blogId;
    if (!targetBlogId) {
      await page.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(2000, 3000);
      // URL에서 blogId 추출 시도
      const blogLink = await page.$('a[href*="/blog/posts/"]');
      if (blogLink) {
        const href = await blogLink.getAttribute('href');
        const match = href.match(/\/blog\/posts\/(\d+)/);
        if (match) targetBlogId = match[1];
      }
    }

    const newPostUrl = targetBlogId
      ? `https://www.blogger.com/blog/post/create/${targetBlogId}`
      : 'https://www.blogger.com/blogger.g?action=CREATE_POST';

    await page.goto(newPostUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await delay(3000, 5000);

    console.log('[Blogger-PW] 글쓰기 페이지:', page.url());

    // ── 3. 제목 입력 ──────────────────────────────────────
    // 여러 셀렉터 시도
    const titleSelectors = [
      'input[name="title"]',
      'textarea[name="title"]',
      '.title input',
      '[data-field="title"]',
      '[aria-label*="제목"]',
      '[aria-label*="Title"]',
      '[placeholder*="제목"]',
      '[placeholder*="Title"]',
    ];
    let titleFilled = false;
    for (const sel of titleSelectors) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        await el.fill(title);
        titleFilled = true;
        break;
      }
    }
    if (!titleFilled) {
      // contenteditable 제목 영역 시도
      const titleArea = await page.$('[contenteditable="true"]');
      if (titleArea) {
        await titleArea.click();
        await page.keyboard.type(title);
      }
    }
    await delay(500, 900);

    // ── 4. HTML 모드로 전환 ───────────────────────────────
    const htmlBtnSelectors = [
      'button:has-text("HTML")',
      'a:has-text("HTML")',
      '[data-view="html"]',
      '[aria-label="HTML"]',
      '.goog-tab:has-text("HTML")',
    ];
    for (const sel of htmlBtnSelectors) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await delay(1000, 1800);
        break;
      }
    }

    // ── 5. 본문 HTML 삽입 ─────────────────────────────────
    // HTML 모드 textarea 찾기
    const editorSelectors = [
      'textarea.textarea',
      '#postingHtmlBox',
      '.html-editor textarea',
      'textarea[aria-label*="Post body"]',
      'textarea[aria-label*="본문"]',
      '.edit-content textarea',
    ];
    let contentFilled = false;
    for (const sel of editorSelectors) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.click();
        await page.keyboard.shortcut('Control+a');
        await el.fill(content);
        contentFilled = true;
        break;
      }
    }
    if (!contentFilled) {
      // JavaScript로 직접 삽입 시도
      const injected = await page.evaluate((html) => {
        const ta = document.querySelector('textarea');
        if (ta) { ta.value = html; ta.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        const ce = document.querySelector('[contenteditable="true"]:not([data-field="title"])');
        if (ce) { ce.innerHTML = html; ce.dispatchEvent(new Event('input', { bubbles: true })); return true; }
        return false;
      }, content);
      if (!injected) console.warn('[Blogger-PW] 본문 삽입 실패 — 에디터를 찾지 못함');
    }
    await delay(1000, 2000);

    // ── 6. 라벨(태그) 입력 ────────────────────────────────
    if (tags.length > 0) {
      const labelBtnSels = [
        'button:has-text("라벨")',
        'button:has-text("Label")',
        '[aria-label*="label" i]',
        '[aria-label*="라벨"]',
      ];
      for (const sel of labelBtnSels) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) {
          await btn.click();
          await delay(500, 900);
          const labelInput = await page.$('input[placeholder*="라벨"], input[placeholder*="label" i]');
          if (labelInput) {
            for (const tag of tags.slice(0, 10)) {
              await labelInput.fill(tag);
              await page.keyboard.press('Enter');
              await delay(200, 400);
            }
          }
          break;
        }
      }
    }

    // ── 7. 발행 ───────────────────────────────────────────
    const pubBtnSels = [
      'button:has-text("게시")',
      'button:has-text("Publish")',
      'button:has-text("발행")',
      '[data-action="publish"]',
    ];
    let published = false;
    for (const sel of pubBtnSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        published = true;
        break;
      }
    }
    if (!published) throw new Error('발행 버튼을 찾을 수 없습니다');
    await delay(2000, 3500);

    // 확인 다이얼로그
    const okSels = ['button:has-text("확인")', 'button:has-text("OK")', 'button:has-text("게시")', '.btn-primary'];
    for (const sel of okSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await delay(2500, 4000);
        break;
      }
    }

    const postUrl = page.url();
    console.log('[Blogger-PW] 발행 완료:', postUrl);
    return { success: true, url: postUrl, platform: 'blogger' };

  } catch (err) {
    // 스크린샷 저장 (디버깅용)
    try {
      await page.screenshot({ path: '/tmp/blogger-error.png' });
      console.error('[Blogger-PW] 오류 스크린샷 저장: /tmp/blogger-error.png');
    } catch {}
    console.error('[Blogger-PW] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'blogger' };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { publishToBloggerPlaywright };
