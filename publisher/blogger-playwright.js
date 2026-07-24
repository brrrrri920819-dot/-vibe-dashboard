/**
 * publisher/blogger-playwright.js
 * Playwright + Stealth로 Blogger 발행 — 봇 감지 우회 + 쿠키 영구 저장
 */

const fs   = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, '../data/google-cookies.json');

function delay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

function saveCookies(cookies) {
  try {
    const dir = path.dirname(COOKIE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    console.log('[Blogger-PW] 쿠키 저장 완료');
  } catch (e) {
    console.warn('[Blogger-PW] 쿠키 저장 실패:', e.message);
  }
}

function loadCookies() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

async function launchBrowser() {
  // playwright-extra + stealth 시도, 실패 시 일반 playwright 사용
  try {
    const { chromium: chromiumExtra } = require('playwright-extra');
    const stealth = require('puppeteer-extra-plugin-stealth');
    chromiumExtra.use(stealth());
    console.log('[Blogger-PW] 스텔스 모드 활성화');
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    return await chromiumExtra.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
             '--disable-blink-features=AutomationControlled', '--disable-features=IsolateOrigins'],
    });
  } catch (e) {
    console.warn('[Blogger-PW] 스텔스 모듈 없음, 기본 모드 사용:', e.message);
    const { chromium } = require('playwright');
    const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
    return await chromium.launch({
      headless: true,
      executablePath: execPath,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });
  }
}

async function publishToBloggerPlaywright({ email, pw, blogId, title, content, tags = [] }) {
  const browser = await launchBrowser();

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['ko-KR', 'ko'] });
    window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {}, app: {} };
  });

  const page = await context.newPage();

  try {
    // ── 1. 저장된 쿠키로 세션 복원 시도 ─────────────────
    const savedCookies = loadCookies();
    if (savedCookies && savedCookies.length > 0) {
      await context.addCookies(savedCookies);
      console.log('[Blogger-PW] 저장된 쿠키 로드, 세션 복원 시도...');

      // Blogger 접속해서 로그인 상태 확인
      await page.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(2000, 3000);

      const isLoggedIn = !page.url().includes('accounts.google.com') &&
                         !page.url().includes('login');
      if (isLoggedIn) {
        console.log('[Blogger-PW] 쿠키로 로그인 유지됨 ✅');
        return await doPost({ page, context, blogId, title, content, tags });
      }
      console.log('[Blogger-PW] 쿠키 만료, 재로그인 필요');
    }

    // ── 2. 구글 로그인 ────────────────────────────────────
    await page.goto('https://accounts.google.com/signin/v2/identifier?hl=ko', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await delay(2000, 3500);

    // 이메일
    await page.waitForSelector('input[type="email"]', { timeout: 10000 });
    // 자연스럽게 한 글자씩 타이핑
    await page.click('input[type="email"]');
    await delay(300, 600);
    for (const ch of email) {
      await page.keyboard.type(ch, { delay: 30 + Math.random() * 60 });
    }
    await delay(600, 1000);
    await page.keyboard.press('Enter');
    await delay(2500, 4000);

    // 비밀번호
    await page.waitForSelector('input[type="password"]', { timeout: 12000 });
    await page.click('input[type="password"]');
    await delay(300, 600);
    for (const ch of pw) {
      await page.keyboard.type(ch, { delay: 30 + Math.random() * 60 });
    }
    await delay(600, 1000);
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
    await delay(3000, 5000);

    const curUrl = page.url();
    console.log('[Blogger-PW] 로그인 후 URL:', curUrl);

    if (curUrl.includes('accounts.google.com')) {
      // 추가 인증 단계 — 잠깐 더 기다림
      await delay(4000, 6000);
      if (page.url().includes('accounts.google.com')) {
        // 스크린샷 찍어서 원인 파악
        await page.screenshot({ path: '/tmp/blogger-login-fail.png' }).catch(() => {});
        throw new Error('구글 로그인 차단됨 — Google 계정 보안 설정에서 "보안 수준이 낮은 앱의 액세스"를 허용하거나, 다른 구글 계정 사용 권장');
      }
    }

    // 로그인 성공 — 쿠키 저장
    const cookies = await context.cookies();
    saveCookies(cookies);

    return await doPost({ page, context, blogId, title, content, tags });

  } catch (err) {
    await page.screenshot({ path: '/tmp/blogger-error.png' }).catch(() => {});
    console.error('[Blogger-PW] 실패:', err.message);
    return { success: false, error: err.message, platform: 'blogger' };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function doPost({ page, context, blogId, title, content, tags }) {
  // blogId 없으면 첫 번째 블로그에서 자동 감지
  let targetBlogId = blogId;
  if (!targetBlogId) {
    await page.goto('https://www.blogger.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(1500, 2500);
    // URL 또는 링크에서 blogId 추출
    const href = await page.$eval(
      'a[href*="/blog/posts/"], a[href*="blog/post/create"]',
      el => el.href
    ).catch(() => null);
    if (href) {
      const m = href.match(/\/(\d{10,})/);
      if (m) targetBlogId = m[1];
    }
    if (!targetBlogId) {
      // 대시보드 페이지 소스에서 추출
      const bodyText = await page.content();
      const m = bodyText.match(/"blogID"\s*:\s*"?(\d{10,})"?/);
      if (m) targetBlogId = m[1];
    }
    console.log('[Blogger-PW] 감지된 blogId:', targetBlogId || '없음 (기본 URL 사용)');
  }

  const newPostUrl = targetBlogId
    ? `https://www.blogger.com/blog/post/create/${targetBlogId}`
    : 'https://www.blogger.com/blogger.g?action=CREATE_POST';

  await page.goto(newPostUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await delay(3000, 5000);
  console.log('[Blogger-PW] 글쓰기 페이지:', page.url());

  // ── 제목 입력 ──────────────────────────────────────────
  const titleSels = [
    'input[name="title"]', 'textarea[name="title"]',
    '.title input', '[data-field="title"]',
    '[aria-label*="제목"]', '[aria-label*="Title"]',
    '[placeholder*="제목"]', '[placeholder*="Title"]',
  ];
  for (const sel of titleSels) {
    const el = await page.$(sel).catch(() => null);
    if (el) { await el.click(); await el.fill(title); break; }
  }
  await delay(500, 900);

  // ── HTML 모드 전환 ─────────────────────────────────────
  for (const sel of ['button:has-text("HTML")', 'a:has-text("HTML")', '[data-view="html"]', '[aria-label="HTML"]']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click(); await delay(1000, 1800); break; }
  }

  // ── 본문 삽입 ──────────────────────────────────────────
  let filled = false;
  for (const sel of ['textarea.textarea', '#postingHtmlBox', '.html-editor textarea', 'textarea[aria-label*="body" i]']) {
    const el = await page.$(sel).catch(() => null);
    if (el) {
      await el.click();
      await page.keyboard.shortcut('Control+a');
      await el.fill(content);
      filled = true;
      break;
    }
  }
  if (!filled) {
    await page.evaluate((html) => {
      const ta = document.querySelector('textarea');
      if (ta) { ta.value = html; ta.dispatchEvent(new Event('input', { bubbles: true })); return; }
      const ce = document.querySelector('[contenteditable="true"]:not([data-field="title"])');
      if (ce) { ce.innerHTML = html; ce.dispatchEvent(new Event('input', { bubbles: true })); }
    }, content);
  }
  await delay(1000, 2000);

  // ── 라벨 입력 ──────────────────────────────────────────
  if (tags.length > 0) {
    for (const sel of ['button:has-text("라벨")', 'button:has-text("Label")', '[aria-label*="label" i]']) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await delay(500, 900);
        const inp = await page.$('input[placeholder*="라벨"], input[placeholder*="label" i]');
        if (inp) {
          for (const tag of tags.slice(0, 10)) {
            await inp.fill(tag);
            await page.keyboard.press('Enter');
            await delay(150, 350);
          }
        }
        break;
      }
    }
  }

  // ── 발행 ───────────────────────────────────────────────
  let published = false;
  for (const sel of ['button:has-text("게시")', 'button:has-text("Publish")', 'button:has-text("발행")', '[data-action="publish"]']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click(); published = true; break; }
  }
  if (!published) throw new Error('발행 버튼을 찾을 수 없습니다');
  await delay(2000, 3500);

  // 확인 팝업
  for (const sel of ['button:has-text("확인")', 'button:has-text("OK")', 'button:has-text("게시")', '.btn-primary']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click(); await delay(2500, 4000); break; }
  }

  // 쿠키 갱신 저장
  saveCookies(await context.cookies());

  const postUrl = page.url();
  const blogIdMatch = newPostUrl.match(/\/(\d{10,})/);
  console.log('[Blogger-PW] 발행 완료:', postUrl);
  return { success: true, url: postUrl, platform: 'blogger', blogId: blogIdMatch ? blogIdMatch[1] : targetBlogId };
}

module.exports = { publishToBloggerPlaywright };
