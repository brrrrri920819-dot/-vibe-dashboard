/**
 * affiliates/login-manager.js
 * Playwright 기반 제휴사 포털 자동 로그인 및 통계 수집
 *
 * Required env vars (per site):
 *   LINKPRICE_ID / LINKPRICE_PW
 *   COUPANG_PARTNERS_ID / COUPANG_PARTNERS_PW
 *   NAVER_SHOPPING_ID / NAVER_SHOPPING_PW
 *   KAKAO_MOMENT_ID / KAKAO_MOMENT_PW
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'affiliate-sessions.json');
const SESSION_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6시간
const CHROMIUM_PATH = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium';

// ── 지원 사이트 목록 ──────────────────────────────────────
const SUPPORTED_SITES = {
  linkprice: {
    name: '링크프라이스',
    loginUrl: 'https://www.linkprice.com/cpm/member/login_form.php',
    dashboardUrl: 'https://www.linkprice.com/cpm/member/main.php',
    envId: 'LINKPRICE_ID',
    envPw: 'LINKPRICE_PW',
    description: '국내 대표 제휴마케팅 네트워크 (20년+ 운영)',
  },
  coupang_partners: {
    name: '쿠팡파트너스',
    loginUrl: 'https://partners.coupang.com',
    dashboardUrl: 'https://partners.coupang.com/home',
    envId: 'COUPANG_PARTNERS_ID',
    envPw: 'COUPANG_PARTNERS_PW',
    description: '쿠팡 공식 제휴 프로그램 (국내 최대 전환율)',
  },
  naver_shopping: {
    name: '네이버 쇼핑파트너',
    loginUrl: 'https://adcenter.shopping.naver.com',
    dashboardUrl: 'https://adcenter.shopping.naver.com/partner/dashboard',
    envId: 'NAVER_SHOPPING_ID',
    envPw: 'NAVER_SHOPPING_PW',
    description: '네이버 쇼핑파트너센터 (쇼핑커넥트 포함)',
  },
  kakao_moment: {
    name: '카카오모먼트',
    loginUrl: 'https://moment.kakao.com',
    dashboardUrl: 'https://moment.kakao.com/campaigns',
    envId: 'KAKAO_MOMENT_ID',
    envPw: 'KAKAO_MOMENT_PW',
    description: '카카오 공식 광고/제휴 플랫폼',
  },
};

// ── 세션 파일 유틸 ────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[AffLogin] data/ 디렉토리 생성됨:', DATA_DIR);
  }
}

function loadSessions() {
  try {
    ensureDataDir();
    if (!fs.existsSync(SESSIONS_FILE)) return {};
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.log('[AffLogin] 세션 파일 읽기 실패 (초기화):', e.message);
    return {};
  }
}

function saveSession(siteKey, cookies) {
  try {
    ensureDataDir();
    const sessions = loadSessions();
    sessions[siteKey] = { cookies, savedAt: Date.now() };
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    console.log(`[AffLogin] ${siteKey} 세션 저장됨 (쿠키 ${cookies.length}개)`);
  } catch (e) {
    console.log(`[AffLogin] ${siteKey} 세션 저장 실패:`, e.message);
  }
}

function invalidateSession(siteKey) {
  try {
    const sessions = loadSessions();
    delete sessions[siteKey];
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf8');
    console.log(`[AffLogin] ${siteKey} 세션 무효화됨`);
  } catch (e) {
    console.log(`[AffLogin] ${siteKey} 세션 무효화 실패:`, e.message);
  }
}

function getValidSession(siteKey) {
  const sessions = loadSessions();
  const session = sessions[siteKey];
  if (!session || !session.cookies || !session.savedAt) return null;
  const ageMs = Date.now() - session.savedAt;
  if (ageMs > SESSION_MAX_AGE_MS) {
    console.log(`[AffLogin] ${siteKey} 세션 만료됨 (${Math.round(ageMs / 60000)}분 경과, 최대 ${SESSION_MAX_AGE_MS / 60000}분)`);
    return null;
  }
  console.log(`[AffLogin] ${siteKey} 유효한 세션 재사용 (${Math.round(ageMs / 60000)}분 경과)`);
  return session.cookies;
}

// ── 브라우저 공통 런처 ────────────────────────────────────
async function launchBrowser() {
  console.log(`[AffLogin] Chromium 실행: ${CHROMIUM_PATH}`);
  return chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--lang=ko-KR,ko',
    ],
  });
}

async function newKoreanContext(browser, cookies = null) {
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
    extraHTTPHeaders: { 'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  });
  if (cookies && cookies.length > 0) {
    await context.addCookies(cookies);
  }
  return context;
}

// ── 로그인 후 리다이렉트 URL이 로그인 페이지인지 확인 ───
function isLoginPage(url) {
  return (
    url.includes('login') ||
    url.includes('signin') ||
    url.includes('nidlogin') ||
    url.includes('accounts.kakao.com') ||
    url.includes('/auth/')
  );
}

// ── 숫자 파싱 헬퍼 ────────────────────────────────────────
function parseKoreanNumber(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').replace(/\s/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? 0 : num;
}

function parseKoreanFloat(text) {
  if (!text) return 0;
  const cleaned = text.replace(/,/g, '').replace(/\s/g, '').replace(/%/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ── 사이트별 로그인 핸들러 ────────────────────────────────

async function loginLinkprice(page, id, pw) {
  console.log('[AffLogin] LinkPrice 로그인 폼 진입...');
  await page.goto('https://www.linkprice.com/cpm/member/login_form.php', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await page.fill('input[name="user_id"]', id);
  await page.fill('input[name="user_pw"]', pw);

  // 로그인 버튼: image submit 또는 일반 submit
  await page.click('input[type="submit"], input[type="image"], button[type="submit"], .btn_login');

  await page.waitForURL(/linkprice\.com\/cpm\/member\/(main|mypage)/, { timeout: 20000 });
  console.log('[AffLogin] LinkPrice 로그인 성공:', page.url());
}

async function loginCoupangPartners(page, id, pw) {
  console.log('[AffLogin] 쿠팡파트너스 로그인 페이지 진입...');
  await page.goto('https://partners.coupang.com', { waitUntil: 'networkidle', timeout: 30000 });

  // SPA 초기 로드 후 로그인 버튼이 노출될 수 있음
  const loginLink = page.locator(
    'a[href*="login"], a[href*="signin"], button:has-text("로그인"), button:has-text("Sign In"), .login-btn'
  ).first();

  const loginLinkVisible = await loginLink.isVisible({ timeout: 5000 }).catch(() => false);
  if (loginLinkVisible) {
    await loginLink.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
  }

  // 이메일/ID 필드 (이메일 로그인 우선)
  const idField = page.locator(
    'input[type="email"], input[name="email"], input[name="username"], input[placeholder*="이메일"], input[placeholder*="아이디"], input[id*="email"], input[id*="id"]'
  ).first();
  await idField.waitFor({ state: 'visible', timeout: 15000 });
  await idField.fill(id);

  const pwField = page.locator('input[type="password"]').first();
  await pwField.waitFor({ state: 'visible', timeout: 5000 });
  await pwField.fill(pw);

  await page.click(
    'button[type="submit"], input[type="submit"], .btn-login, .btn_login, button:has-text("로그인"), button:has-text("로그인하기"), button:has-text("Sign In")'
  );

  // 대시보드 또는 홈 URL 대기
  await page.waitForURL(/partners\.coupang\.com\/(home|dashboard|\/)/, { timeout: 25000 });
  console.log('[AffLogin] 쿠팡파트너스 로그인 성공:', page.url());
}

async function loginNaverShopping(page, id, pw) {
  console.log('[AffLogin] 네이버 쇼핑파트너 로그인 진입...');
  await page.goto('https://adcenter.shopping.naver.com', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  // 네이버 통합 로그인으로 리다이렉트 여부 확인
  await page.waitForURL(/nid\.naver\.com\/nidlogin|adcenter\.shopping\.naver\.com/, {
    timeout: 15000,
  });

  if (page.url().includes('nid.naver.com')) {
    console.log('[AffLogin] 네이버 로그인 폼 감지, 계정 입력 중...');

    await page.waitForSelector('#id', { state: 'visible', timeout: 10000 });
    await page.fill('#id', id);
    await page.fill('#pw', pw);

    // 네이버 로그인 버튼 — .btn_login 또는 #log_login
    await page.click('.btn_login, #log_login, button[type="submit"]');

    // 쇼핑파트너센터로 리다이렉트 완료 대기
    await page.waitForURL(/adcenter\.shopping\.naver\.com/, { timeout: 25000 });
  }

  console.log('[AffLogin] 네이버 쇼핑파트너 로그인 성공:', page.url());
}

async function loginKakaoMoment(page, id, pw) {
  console.log('[AffLogin] 카카오모먼트 로그인 진입...');
  await page.goto('https://moment.kakao.com', { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 카카오 통합 인증으로 리다이렉트 여부 확인
  await page.waitForURL(/accounts\.kakao\.com|moment\.kakao\.com/, { timeout: 15000 });

  if (page.url().includes('accounts.kakao.com')) {
    console.log('[AffLogin] 카카오 계정 로그인 폼 감지...');

    // 카카오 로그인 폼 — loginId 또는 email 필드
    const loginIdField = page.locator(
      'input[name="loginId"], input[id="loginId--1"], input[type="email"], input[placeholder*="이메일"], input[placeholder*="카카오계정"]'
    ).first();
    await loginIdField.waitFor({ state: 'visible', timeout: 10000 });
    await loginIdField.fill(id);

    const pwField = page.locator('input[type="password"]').first();
    await pwField.waitFor({ state: 'visible', timeout: 5000 });
    await pwField.fill(pw);

    await page.click('.btn_g.highlight, button[type="submit"], .btn_confirm, button:has-text("로그인")');

    await page.waitForURL(/moment\.kakao\.com/, { timeout: 25000 });
  }

  console.log('[AffLogin] 카카오모먼트 로그인 성공:', page.url());
}

const LOGIN_HANDLERS = {
  linkprice: loginLinkprice,
  coupang_partners: loginCoupangPartners,
  naver_shopping: loginNaverShopping,
  kakao_moment: loginKakaoMoment,
};

// ── 사이트별 통계 스크레이퍼 ──────────────────────────────

async function scrapeLinkpriceStats(page) {
  console.log('[AffLogin] LinkPrice 통계 스크레이핑 시작...');
  const stats = {
    balance: 0,
    pendingPayout: 0,
    clickCount: 0,
    conversionCount: 0,
    conversionRate: 0,
    lastUpdated: new Date().toISOString(),
  };

  // 마이페이지 메인에서 잔액 수집
  try {
    await page.goto('https://www.linkprice.com/cpm/member/main.php', {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    const bodyText = await page.locator('body').innerText();

    // 누적 수익 / 잔액 (ex: "123,456원")
    const balanceMatch = bodyText.match(/(?:누적\s*수익|잔액|정산\s*예정)\s*[:\s]*([0-9,]+)\s*원/);
    if (balanceMatch) stats.balance = parseKoreanNumber(balanceMatch[1]);

    // 미지급 금액
    const pendingMatch = bodyText.match(/(?:미지급|지급\s*예정|보류)\s*[:\s]*([0-9,]+)\s*원/);
    if (pendingMatch) stats.pendingPayout = parseKoreanNumber(pendingMatch[1]);
  } catch (e) {
    console.log('[AffLogin] LinkPrice 마이페이지 파싱 실패:', e.message);
  }

  // 링크 리포트에서 클릭/전환 수집 (당월 기준)
  try {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const reportUrl = `https://www.linkprice.com/cpm/report/report_link.php?start_date=${yyyy}${mm}01&end_date=${yyyy}${mm}${String(today.getDate()).padStart(2, '0')}`;
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

    // 테이블에서 집계 행 수집
    const rows = await page.locator('table tr').all();
    let totalClicks = 0;
    let totalConv = 0;

    for (const row of rows) {
      const cells = await row.locator('td').allInnerTexts().catch(() => []);
      if (cells.length >= 4) {
        // 일반적인 컬럼 순서: 날짜, 프로그램명, 클릭수, 실적수, 수수료
        const clicks = parseKoreanNumber(cells[2]);
        const conv = parseKoreanNumber(cells[3]);
        if (clicks > 0) totalClicks += clicks;
        if (conv > 0) totalConv += conv;
      }
    }

    // 합계 행 우선 (th 포함된 마지막 tr)
    const summaryText = await page.locator('table tfoot td, table tr.total td, table tr.sum td').allInnerTexts().catch(() => []);
    if (summaryText.length >= 3) {
      const sc = parseKoreanNumber(summaryText[summaryText.length - 3]);
      const sv = parseKoreanNumber(summaryText[summaryText.length - 2]);
      if (sc > 0) totalClicks = sc;
      if (sv > 0) totalConv = sv;
    }

    if (totalClicks > 0) stats.clickCount = totalClicks;
    if (totalConv > 0) {
      stats.conversionCount = totalConv;
      stats.conversionRate =
        stats.clickCount > 0
          ? parseFloat(((stats.conversionCount / stats.clickCount) * 100).toFixed(2))
          : 0;
    }
  } catch (e) {
    console.log('[AffLogin] LinkPrice 리포트 파싱 실패:', e.message);
  }

  console.log('[AffLogin] LinkPrice 통계:', stats);
  return stats;
}

async function scrapeCoupangPartnersStats(page) {
  console.log('[AffLogin] 쿠팡파트너스 통계 스크레이핑 시작...');
  const stats = {
    balance: 0,
    pendingPayout: 0,
    clickCount: 0,
    conversionCount: 0,
    conversionRate: 0,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await page.goto('https://partners.coupang.com/home', { waitUntil: 'networkidle', timeout: 30000 });

    // React SPA — 데이터 로드 대기
    await page.waitForSelector(
      '[class*="dashboard"], [class*="earning"], [class*="income"], [class*="stat"], [data-testid]',
      { timeout: 10000 }
    ).catch(() => {});

    const bodyText = await page.locator('body').innerText();

    // 수익 잔액 (원 단위)
    const earningPatterns = [
      /수익\s*금액\s*[:\s]*([0-9,]+)\s*원/,
      /예상\s*수익\s*[:\s]*([0-9,]+)\s*원/,
      /누적\s*수익\s*[:\s]*([0-9,]+)\s*원/,
      /총\s*수익\s*[:\s]*([0-9,]+)\s*원/,
    ];
    for (const pat of earningPatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.balance = parseKoreanNumber(m[1]); break; }
    }

    // 미지급 금액
    const pendingMatch = bodyText.match(/(?:미지급|지급\s*예정|보류)\s*[:\s]*([0-9,]+)\s*원/);
    if (pendingMatch) stats.pendingPayout = parseKoreanNumber(pendingMatch[1]);

    // 클릭 수
    const clickMatch = bodyText.match(/클릭\s*(?:수)?\s*[:\s]*([0-9,]+)/);
    if (clickMatch) stats.clickCount = parseKoreanNumber(clickMatch[1]);

    // 주문/전환 수
    const orderMatch = bodyText.match(/(?:주문|구매|전환)\s*(?:수|건수)?\s*[:\s]*([0-9,]+)/);
    if (orderMatch) stats.conversionCount = parseKoreanNumber(orderMatch[1]);
  } catch (e) {
    console.log('[AffLogin] 쿠팡파트너스 홈 파싱 실패:', e.message);
  }

  // 퍼포먼스 리포트에서 추가 집계
  try {
    await page.goto('https://partners.coupang.com/performance/reports', {
      waitUntil: 'networkidle',
      timeout: 25000,
    });
    await page.waitForSelector('table, [class*="report"], [class*="summary"]', { timeout: 8000 }).catch(() => {});

    const bodyText = await page.locator('body').innerText();

    // 클릭 수 갱신 (리포트 페이지 우선)
    const clickMatch = bodyText.match(/(?:총\s*)?클릭\s*(?:수)?\s*[:\s]*([0-9,]+)/);
    if (clickMatch) stats.clickCount = parseKoreanNumber(clickMatch[1]);

    const orderMatch = bodyText.match(/(?:총\s*)?(?:주문|구매)\s*(?:수|건수)?\s*[:\s]*([0-9,]+)/);
    if (orderMatch) stats.conversionCount = parseKoreanNumber(orderMatch[1]);

    if (stats.balance === 0) {
      const earningMatch = bodyText.match(/([0-9,]+)\s*원/);
      if (earningMatch) stats.balance = parseKoreanNumber(earningMatch[1]);
    }
  } catch (e) {
    console.log('[AffLogin] 쿠팡파트너스 리포트 파싱 실패:', e.message);
  }

  if (stats.clickCount > 0 && stats.conversionCount > 0) {
    stats.conversionRate = parseFloat(((stats.conversionCount / stats.clickCount) * 100).toFixed(2));
  }

  console.log('[AffLogin] 쿠팡파트너스 통계:', stats);
  return stats;
}

async function scrapeNaverShoppingStats(page) {
  console.log('[AffLogin] 네이버 쇼핑파트너 통계 스크레이핑 시작...');
  const stats = {
    balance: 0,
    pendingPayout: 0,
    clickCount: 0,
    conversionCount: 0,
    conversionRate: 0,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await page.goto('https://adcenter.shopping.naver.com/partner/dashboard', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    // Vue/React SPA — 컨텐츠 로드 대기
    await page.waitForSelector(
      '[class*="dashboard"], [class*="summary"], [class*="stat"], .content-wrap, .total',
      { timeout: 12000 }
    ).catch(() => {});

    const bodyText = await page.locator('body').innerText();

    // 예상 정산 금액 / 누적 수익
    const balancePatterns = [
      /예상\s*정산\s*금액\s*[:\s]*([0-9,]+)\s*원/,
      /누적\s*수익\s*[:\s]*([0-9,]+)\s*원/,
      /수익\s*금액\s*[:\s]*([0-9,]+)\s*원/,
      /정산\s*예정액\s*[:\s]*([0-9,]+)\s*원/,
    ];
    for (const pat of balancePatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.balance = parseKoreanNumber(m[1]); break; }
    }

    // 미지급
    const pendingMatch = bodyText.match(/(?:미지급|지급\s*대기)\s*[:\s]*([0-9,]+)\s*원/);
    if (pendingMatch) stats.pendingPayout = parseKoreanNumber(pendingMatch[1]);

    // 클릭 수
    const clickPatterns = [
      /클릭\s*수\s*[:\s]*([0-9,]+)/,
      /총\s*클릭\s*[:\s]*([0-9,]+)/,
      /클릭\s*[:\s]*([0-9,]+)(?:\s*회)?/,
    ];
    for (const pat of clickPatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.clickCount = parseKoreanNumber(m[1]); break; }
    }

    // 구매 전환 수
    const convPatterns = [
      /구매\s*(?:건수|수)\s*[:\s]*([0-9,]+)/,
      /전환\s*(?:건수|수)\s*[:\s]*([0-9,]+)/,
      /주문\s*(?:건수|수)\s*[:\s]*([0-9,]+)/,
    ];
    for (const pat of convPatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.conversionCount = parseKoreanNumber(m[1]); break; }
    }

    // 전환율 (직접 표시된 경우)
    const rateMatch = bodyText.match(/전환율\s*[:\s]*([0-9.]+)\s*%/);
    if (rateMatch) {
      stats.conversionRate = parseKoreanFloat(rateMatch[1]);
    } else if (stats.clickCount > 0 && stats.conversionCount > 0) {
      stats.conversionRate = parseFloat(((stats.conversionCount / stats.clickCount) * 100).toFixed(2));
    }
  } catch (e) {
    console.log('[AffLogin] 네이버 쇼핑파트너 대시보드 파싱 실패:', e.message);
  }

  console.log('[AffLogin] 네이버 쇼핑파트너 통계:', stats);
  return stats;
}

async function scrapeKakaoMomentStats(page) {
  console.log('[AffLogin] 카카오모먼트 통계 스크레이핑 시작...');
  const stats = {
    balance: 0,
    pendingPayout: 0,
    clickCount: 0,
    conversionCount: 0,
    conversionRate: 0,
    lastUpdated: new Date().toISOString(),
  };

  try {
    await page.goto('https://moment.kakao.com/campaigns', {
      waitUntil: 'networkidle',
      timeout: 30000,
    });

    await page.waitForSelector(
      '[class*="dashboard"], [class*="summary"], [class*="stat"], [class*="campaign"]',
      { timeout: 10000 }
    ).catch(() => {});

    const bodyText = await page.locator('body').innerText();

    // 충전금 / 잔액
    const balancePatterns = [
      /충전금\s*[:\s]*([0-9,]+)\s*원/,
      /잔액\s*[:\s]*([0-9,]+)\s*원/,
      /보유\s*금액\s*[:\s]*([0-9,]+)\s*원/,
      /포인트\s*[:\s]*([0-9,]+)/,
    ];
    for (const pat of balancePatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.balance = parseKoreanNumber(m[1]); break; }
    }

    // 클릭 수 (카카오모먼트는 노출/클릭 구분)
    const clickPatterns = [
      /클릭\s*수\s*[:\s]*([0-9,]+)/,
      /총\s*클릭\s*[:\s]*([0-9,]+)/,
      /클릭\s*[:\s]*([0-9,]+)/,
    ];
    for (const pat of clickPatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.clickCount = parseKoreanNumber(m[1]); break; }
    }

    // 전환 수 (액션 / CV)
    const convPatterns = [
      /전환\s*(?:수)?\s*[:\s]*([0-9,]+)/,
      /CV\s*[:\s]*([0-9,]+)/,
      /액션\s*(?:수)?\s*[:\s]*([0-9,]+)/,
    ];
    for (const pat of convPatterns) {
      const m = bodyText.match(pat);
      if (m) { stats.conversionCount = parseKoreanNumber(m[1]); break; }
    }

    // 전환율
    const rateMatch = bodyText.match(/(?:전환율|CVR)\s*[:\s]*([0-9.]+)\s*%/);
    if (rateMatch) {
      stats.conversionRate = parseKoreanFloat(rateMatch[1]);
    } else if (stats.clickCount > 0 && stats.conversionCount > 0) {
      stats.conversionRate = parseFloat(((stats.conversionCount / stats.clickCount) * 100).toFixed(2));
    }
  } catch (e) {
    console.log('[AffLogin] 카카오모먼트 통계 파싱 실패:', e.message);
  }

  console.log('[AffLogin] 카카오모먼트 통계:', stats);
  return stats;
}

const STATS_SCRAPERS = {
  linkprice: scrapeLinkpriceStats,
  coupang_partners: scrapeCoupangPartnersStats,
  naver_shopping: scrapeNaverShoppingStats,
  kakao_moment: scrapeKakaoMomentStats,
};

// ── 쿠키 주입 후 통계 수집 내부 함수 ─────────────────────
async function _scrapeWithCookies(siteKey, site, cookies) {
  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newKoreanContext(browser, cookies);
    const page = await context.newPage();

    // 대시보드로 이동 — 세션 만료 여부 확인
    await page.goto(site.dashboardUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const currentUrl = page.url();

    if (isLoginPage(currentUrl)) {
      console.log(`[AffLogin] ${siteKey} 쿠키 주입 후 로그인 페이지 리다이렉트 감지 — 세션 만료`);
      await browser.close();
      browser = null;
      return null; // 세션 만료 신호
    }

    const scraper = STATS_SCRAPERS[siteKey];
    const statsData = await scraper(page);

    await browser.close();
    browser = null;
    return statsData;
  } catch (e) {
    if (browser) await browser.close().catch(() => {});
    throw e;
  }
}

// ── 퍼블릭 API ───────────────────────────────────────────

/**
 * Playwright 헤드리스 로그인 수행
 *
 * @param {string} siteKey - SUPPORTED_SITES의 키 (예: 'linkprice')
 * @returns {Promise<{ success: boolean, sessionCookies?: object[], error?: string, configured?: boolean }>}
 */
async function loginAffiliate(siteKey) {
  const site = SUPPORTED_SITES[siteKey];
  if (!site) {
    console.log(`[AffLogin] 알 수 없는 사이트 키: ${siteKey}`);
    return { success: false, error: `알 수 없는 사이트 키: ${siteKey}` };
  }

  const id = process.env[site.envId];
  const pw = process.env[site.envPw];

  if (!id || !pw) {
    console.log(`[AffLogin] ${siteKey} 계정 미설정 (필요: ${site.envId}, ${site.envPw})`);
    return { success: false, error: '계정 미설정', configured: false };
  }

  console.log(`[AffLogin] ${site.name} 로그인 시작 → ${site.loginUrl}`);

  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newKoreanContext(browser);
    const page = await context.newPage();

    const handler = LOGIN_HANDLERS[siteKey];
    await handler(page, id, pw);

    const sessionCookies = await context.cookies();
    saveSession(siteKey, sessionCookies);

    await browser.close();
    browser = null;

    console.log(`[AffLogin] ${site.name} 로그인 완료 (쿠키 ${sessionCookies.length}개 저장)`);
    return { success: true, sessionCookies };
  } catch (e) {
    console.log(`[AffLogin] ${site.name} 로그인 실패:`, e.message);
    if (browser) await browser.close().catch(() => {});
    return { success: false, error: e.message };
  }
}

/**
 * 제휴사 통계 대시보드 스크레이핑
 * 유효한 세션이 있으면 재사용, 없거나 만료되면 재로그인 수행
 *
 * @param {string} siteKey - SUPPORTED_SITES의 키
 * @returns {Promise<{
 *   success: boolean,
 *   siteKey: string,
 *   siteName: string,
 *   balance?: number,
 *   pendingPayout?: number,
 *   clickCount?: number,
 *   conversionCount?: number,
 *   conversionRate?: number,
 *   lastUpdated?: string,
 *   error?: string,
 *   configured?: boolean
 * }>}
 */
async function getAffiliateStats(siteKey) {
  const site = SUPPORTED_SITES[siteKey];
  if (!site) {
    return { success: false, siteKey, error: `알 수 없는 사이트 키: ${siteKey}` };
  }

  const id = process.env[site.envId];
  const pw = process.env[site.envPw];

  if (!id || !pw) {
    console.log(`[AffLogin] ${siteKey} 계정 미설정 — 통계 수집 건너뜀`);
    return {
      success: false,
      siteKey,
      siteName: site.name,
      error: '계정 미설정',
      configured: false,
    };
  }

  console.log(`[AffLogin] ${site.name} 통계 수집 시작...`);

  // 1단계: 저장된 세션 확인
  let savedCookies = getValidSession(siteKey);

  // 2단계: 세션 없으면 로그인
  if (!savedCookies) {
    console.log(`[AffLogin] ${siteKey} 저장된 세션 없음 — 신규 로그인`);
    const loginResult = await loginAffiliate(siteKey);
    if (!loginResult.success) {
      return {
        success: false,
        siteKey,
        siteName: site.name,
        error: `로그인 실패: ${loginResult.error}`,
      };
    }
    savedCookies = loginResult.sessionCookies;
  }

  // 3단계: 쿠키 주입 후 통계 수집
  try {
    const statsData = await _scrapeWithCookies(siteKey, site, savedCookies);

    // null 반환 = 세션 만료로 재로그인 필요
    if (statsData === null) {
      console.log(`[AffLogin] ${siteKey} 세션 만료 확인 — 재로그인 수행`);
      invalidateSession(siteKey);

      const loginResult = await loginAffiliate(siteKey);
      if (!loginResult.success) {
        return {
          success: false,
          siteKey,
          siteName: site.name,
          error: `재로그인 실패: ${loginResult.error}`,
        };
      }

      // 재로그인 후 재수집
      const retryStats = await _scrapeWithCookies(siteKey, site, loginResult.sessionCookies);
      if (retryStats === null) {
        return {
          success: false,
          siteKey,
          siteName: site.name,
          error: '재로그인 후에도 세션 확립 실패',
        };
      }

      console.log(`[AffLogin] ${site.name} 재시도 통계 수집 완료`);
      return { success: true, siteKey, siteName: site.name, ...retryStats };
    }

    console.log(`[AffLogin] ${site.name} 통계 수집 완료`);
    return { success: true, siteKey, siteName: site.name, ...statsData };
  } catch (e) {
    console.log(`[AffLogin] ${site.name} 통계 수집 중 오류:`, e.message);
    return { success: false, siteKey, siteName: site.name, error: e.message };
  }
}

/**
 * 모든 지원 사이트의 통계를 순차적으로 수집
 *
 * @returns {Promise<Array>} 각 사이트의 통계 결과 배열
 */
async function getAllStats() {
  const siteKeys = Object.keys(SUPPORTED_SITES);
  console.log(`[AffLogin] 전체 통계 수집 시작 (${siteKeys.length}개 사이트)`);

  const results = [];
  for (let i = 0; i < siteKeys.length; i++) {
    const siteKey = siteKeys[i];
    console.log(`[AffLogin] [${i + 1}/${siteKeys.length}] ${SUPPORTED_SITES[siteKey].name} 처리 중...`);
    const result = await getAffiliateStats(siteKey);
    results.push(result);
  }

  const successCount = results.filter((r) => r.success).length;
  const configuredCount = results.filter((r) => r.configured !== false).length;
  console.log(
    `[AffLogin] 전체 통계 수집 완료 — 성공 ${successCount}개 / 설정됨 ${configuredCount}개 / 전체 ${results.length}개`
  );
  return results;
}

module.exports = { loginAffiliate, getAffiliateStats, getAllStats, SUPPORTED_SITES };
