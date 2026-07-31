/**
 * publisher/tistory-playwright.js
 * Playwright로 티스토리에 직접 로그인 후 글 발행 (OAuth 없음, 토큰 만료 없음)
 */

const { chromium } = require('playwright');

function delay(min, max) {
  return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
}

async function publishToTistoryPlaywright({ id, pw, blogName, title, content, tags = [] }) {
  /* 브라우저 실행 실패가 예외로 튀면 다른 블로그 발행까지 함께 중단된다.
     결과값으로 바꿔 돌려줘, 이 블로그만 실패로 남게 한다. */
  let browser, context, page;
  try {
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
    viewport: { width: 1280, height: 900 },
    locale: 'ko-KR',
  });

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
    return { success: false, error: m, platform: 'tistory' };
  }

  try {
    // ── 1. 티스토리 로그인 (카카오 계정) ─────────────────
    await page.goto('https://www.tistory.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await delay(1500, 2500);

    // 카카오 로그인 버튼 클릭
    const kakaoBtnSels = ['.btn_kakao', 'a[href*="kakao"]', 'button:has-text("카카오")'];
    for (const sel of kakaoBtnSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await delay(1500, 2500);
        break;
      }
    }

    // 카카오 이메일 입력
    const emailSels = ['#loginId', 'input[name="loginId"]', 'input[type="email"]', 'input[name="email"]'];
    let emailFilled = false;
    for (const sel of emailSels) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.fill(id);
        emailFilled = true;
        break;
      }
    }

    // 카카오 비밀번호 입력
    const pwSels = ['#loginPw', 'input[name="loginPw"]', 'input[type="password"]', 'input[name="password"]'];
    let pwFilled = false;
    for (const sel of pwSels) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.fill(pw);
        pwFilled = true;
        break;
      }
    }

    if (emailFilled && pwFilled) {
      await delay(400, 800);
      // 로그인 버튼 클릭
      const loginBtnSels = ['button[type="submit"]', '.btn_login', '#btnLogin', 'button:has-text("로그인")'];
      for (const sel of loginBtnSels) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) {
          await btn.click();
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
          await delay(2000, 3500);
          break;
        }
      }
    }

    const curUrl = page.url();
    console.log('[Tistory-PW] 로그인 후 URL:', curUrl);
    if (curUrl.includes('login') || curUrl.includes('accounts.kakao')) {
      // 잠깐 더 기다려봄 (리다이렉트 지연)
      await delay(3000, 5000);
      if (page.url().includes('login') || page.url().includes('accounts.kakao')) {
        throw new Error('로그인 실패 — TISTORY_ID(카카오 이메일)/TISTORY_PW(카카오 비번) 확인 필요');
      }
    }

    // ── 2. 글쓰기 페이지로 이동 ───────────────────────────
    const writeUrl = `https://${blogName}.tistory.com/manage/post/write`;
    await page.goto(writeUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2500, 4000);

    console.log('[Tistory-PW] 글쓰기 페이지:', page.url());

    // 로그인이 풀렸는지 확인
    if (page.url().includes('login')) {
      throw new Error('글쓰기 페이지 접근 실패 — 로그인 세션이 유지되지 않음');
    }

    // ── 3. 제목 입력 ──────────────────────────────────────
    const titleSels = [
      '#post-title-inp',
      'input[name="title"]',
      '.title-input input',
      '[placeholder*="제목"]',
      'input[placeholder*="Title"]',
    ];
    for (const sel of titleSels) {
      const el = await page.waitForSelector(sel, { timeout: 8000 }).catch(() => null);
      if (el) {
        await el.click();
        await el.fill(title);
        break;
      }
    }
    await delay(500, 1000);

    // ── 4. HTML 모드 전환 ─────────────────────────────────
    const htmlBtnSels = [
      'button:has-text("HTML")',
      'a:has-text("HTML")',
      '.btn_html',
      '[title="HTML"]',
      '[aria-label="HTML"]',
    ];
    let htmlMode = false;
    for (const sel of htmlBtnSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await delay(1000, 2000);
        htmlMode = true;
        break;
      }
    }

    // ── 5. 본문 HTML 삽입 ─────────────────────────────────
    let contentFilled = false;

    // 방법 1: textarea 직접
    const textareaSels = [
      'textarea#editor-content',
      'textarea[name="content"]',
      '.CodeMirror textarea',
      'textarea.CodeMirror-scroll',
    ];
    for (const sel of textareaSels) {
      const el = await page.$(sel).catch(() => null);
      if (el) {
        await el.click({ clickCount: 3 });
        await el.fill(content);
        contentFilled = true;
        break;
      }
    }

    // 방법 2: CodeMirror에 직접 주입
    if (!contentFilled) {
      const injected = await page.evaluate((html) => {
        // CodeMirror 인스턴스 찾기
        const cm = document.querySelector('.CodeMirror');
        if (cm && cm.CodeMirror) {
          cm.CodeMirror.setValue(html);
          return true;
        }
        // 일반 textarea
        const ta = document.querySelector('textarea');
        if (ta) {
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          nativeInputValueSetter.call(ta, html);
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }
        return false;
      }, content);
      if (injected) contentFilled = true;
    }

    // 방법 3: contenteditable
    if (!contentFilled) {
      const editorSels = [
        '[contenteditable="true"].editor',
        '#editor',
        '.editor-area [contenteditable]',
        '[contenteditable="true"]:not([data-field="title"])',
      ];
      for (const sel of editorSels) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          await page.evaluate((node, html) => {
            node.innerHTML = html;
            node.dispatchEvent(new Event('input', { bubbles: true }));
          }, el, content);
          contentFilled = true;
          break;
        }
      }
    }

    if (!contentFilled) console.warn('[Tistory-PW] 본문 삽입 실패 — 에디터를 찾지 못함');
    await delay(800, 1500);

    // ── 6. 태그 입력 ──────────────────────────────────────
    if (tags.length > 0) {
      const tagSels = ['#tag-inp', 'input[name="tag"]', '.tag-input input', '[placeholder*="태그"]'];
      for (const sel of tagSels) {
        const el = await page.$(sel).catch(() => null);
        if (el) {
          await el.click();
          await el.fill(tags.slice(0, 10).join(','));
          await page.keyboard.press('Enter');
          await delay(500, 800);
          break;
        }
      }
    }

    // ── 7. 발행 ───────────────────────────────────────────
    const pubSels = [
      'button:has-text("완료")',
      'button:has-text("발행")',
      '.btn_publish',
      '#publish-layer-btn',
      '[data-btn-publish]',
    ];
    let pubClicked = false;
    for (const sel of pubSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        pubClicked = true;
        break;
      }
    }
    if (!pubClicked) throw new Error('발행 버튼을 찾을 수 없습니다');
    await delay(1500, 2500);

    // 공개 설정 확인 팝업
    const confirmSels = ['button:has-text("발행")', '.btn_ok', 'button:has-text("확인")', 'button:has-text("공개")'];
    for (const sel of confirmSels) {
      const btn = await page.$(sel).catch(() => null);
      if (btn) {
        await btn.click();
        await delay(2000, 3500);
        break;
      }
    }

    const postUrl = page.url();
    console.log('[Tistory-PW] 발행 완료:', postUrl);
    return { success: true, url: postUrl, platform: 'tistory' };

  } catch (err) {
    // 스크린샷 저장 (디버깅용)
    try {
      await page.screenshot({ path: '/tmp/tistory-error.png' });
      console.error('[Tistory-PW] 오류 스크린샷 저장: /tmp/tistory-error.png');
    } catch {}
    console.error('[Tistory-PW] 발행 실패:', err.message);
    return { success: false, error: err.message, platform: 'tistory' };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { publishToTistoryPlaywright };
