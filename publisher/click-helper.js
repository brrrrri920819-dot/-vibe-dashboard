/**
 * publisher/click-helper.js
 * 브라우저 자동화에서 "버튼을 못 눌러" 실패하는 경우를 줄인다.
 *
 * 실제로 겪은 두 가지 실패:
 *  1) page.click('.btn_login') → 30초 대기 후 실패.
 *     사이트가 클래스 이름을 바꾸면 선택자 하나로는 못 찾는다.
 *  2) element is outside of the viewport → 요소가 보이는데도 클릭이 계속 재시도되다 실패.
 *     화면 밖에 있으면 플레이라이트가 스스로 스크롤하다 포기한다.
 *
 * 그래서 선택자를 여러 개 시도하고, 스크롤해서 화면 안에 넣고,
 * 그래도 안 되면 자바스크립트로 직접 누른다.
 */

'use strict';

/** 요소를 화면 안으로 끌어온 뒤 누른다. 안 되면 방법을 바꿔가며 시도한다. */
async function clickElement(el, { timeout = 8000 } = {}) {
  // 화면 밖이면 먼저 끌어온다 — 이걸 안 하면 "outside of the viewport"로 실패한다
  await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});

  try {
    await el.click({ timeout });
    return 'click';
  } catch (_) { /* 다음 방법 */ }

  try {
    // 가려져 있어도 좌표로 누른다
    await el.click({ timeout: 3000, force: true });
    return 'force';
  } catch (_) { /* 다음 방법 */ }

  // 마지막 수단 — 자바스크립트로 직접 누른다. 화면 위치와 무관하게 동작한다
  await el.evaluate((node) => node.click());
  return 'js';
}

/**
 * 여러 선택자를 순서대로 시도해 처음 찾은 것을 누른다.
 * @param {import('playwright').Page|import('playwright').Frame} scope
 * @param {string[]} selectors  먼저 쓸 것부터
 * @param {{timeout?:number, label?:string, optional?:boolean}} opts
 * @returns {Promise<{ok:boolean, used?:string, how?:string, error?:string}>}
 */
async function clickAny(scope, selectors, { timeout = 10000, label = '버튼', optional = false } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;

  // 아직 안 뜬 요소를 기다려야 하므로 마감 시각까지 반복해서 훑는다
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      let el = null;
      try { el = await scope.$(sel); } catch (_) { continue; }
      if (!el) continue;

      const visible = await el.isVisible().catch(() => false);
      if (!visible) continue;

      try {
        const how = await clickElement(el, { timeout: 4000 });
        return { ok: true, used: sel, how };
      } catch (e) { lastErr = e; }
    }
    await scope.waitForTimeout(300).catch(() => {});
  }

  if (optional) return { ok: false, error: `${label} 없음 (건너뜀)` };
  return {
    ok: false,
    error: `${label}을 찾지 못했습니다 — 사이트 구조가 바뀌었을 수 있습니다`
         + (lastErr ? ` (${lastErr.message.split('\n')[0]})` : ''),
  };
}

/** 여러 선택자 중 처음 보이는 요소를 돌려준다 (입력칸 찾기용) */
async function findAny(scope, selectors, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      let el = null;
      try { el = await scope.$(sel); } catch (_) { continue; }
      if (el && await el.isVisible().catch(() => false)) return { el, sel };
    }
    await scope.waitForTimeout(300).catch(() => {});
  }
  return { el: null, sel: null };
}

module.exports = { clickAny, clickElement, findAny };
