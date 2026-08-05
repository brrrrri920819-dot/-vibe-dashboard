/**
 * test/click-helper.test.js
 * "버튼을 못 눌러서" 발행이 실패하던 두 경우의 재발 방지.
 *
 * 실제로 겪은 실패:
 *  1) page.click('.btn_login') → 30초 대기 후 실패 (선택자 하나만 봤다)
 *  2) element is outside of the viewport → 보이는데도 클릭이 계속 재시도되다 실패
 *
 * 진짜 브라우저 없이, 플레이라이트 요소가 하는 행동만 흉내내어 검증한다.
 */

'use strict';

const assert = require('assert');
const { clickAny, clickElement, findAny } = require('../publisher/click-helper');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

/** 가짜 요소 — 상황에 따라 클릭이 실패하도록 만든다 */
function makeEl({ visible = true, failNormal = false, failForce = false, scrollFails = false } = {}) {
  const log = [];
  return {
    log,
    isVisible: async () => visible,
    scrollIntoViewIfNeeded: async () => {
      log.push('scroll');
      if (scrollFails) throw new Error('scroll 실패');
    },
    click: async (opts = {}) => {
      if (opts.force) {
        log.push('force');
        if (failForce) throw new Error('element is outside of the viewport');
        return;
      }
      log.push('click');
      if (failNormal) throw new Error('Timeout 30000ms exceeded');
    },
    evaluate: async (fn) => { log.push('js'); return fn({ click: () => {} }); },
  };
}

/** 가짜 페이지 — 선택자별로 요소를 돌려준다 */
function makeScope(map) {
  return {
    $: async (sel) => map[sel] || null,
    waitForTimeout: async () => {},
  };
}

(async () => {
  console.log('\n🖱 클릭 보강 테스트\n');

  // ── 1) 평범하게 눌리는 경우 ──────────────────────────────
  const plain = makeEl();
  const how1 = await clickElement(plain);
  ok('먼저 화면 안으로 스크롤한다', plain.log[0] === 'scroll');
  ok('그냥 눌리면 그대로 끝난다', how1 === 'click');

  // ── 2) 화면 밖이라 일반 클릭이 실패하는 경우 ─────────────
  // 이게 티스토리에서 났던 "outside of the viewport" 상황이다
  const outside = makeEl({ failNormal: true });
  const how2 = await clickElement(outside);
  ok('일반 클릭이 실패하면 강제 클릭으로 넘어간다', how2 === 'force');
  ok('시도 순서가 스크롤 → 클릭 → 강제 다', outside.log.join(',') === 'scroll,click,force');

  // ── 3) 강제 클릭도 막히면 자바스크립트로 누른다 ──────────
  const stubborn = makeEl({ failNormal: true, failForce: true });
  const how3 = await clickElement(stubborn);
  ok('마지막엔 자바스크립트로 누른다', how3 === 'js');

  // ── 4) 스크롤이 실패해도 클릭은 계속 시도한다 ────────────
  const noScroll = makeEl({ scrollFails: true });
  const how4 = await clickElement(noScroll);
  ok('스크롤 실패가 클릭을 막지 않는다', how4 === 'click');

  // ── 5) 선택자가 바뀌어도 다른 후보로 찾는다 ──────────────
  // 이게 네이버 로그인 버튼(.btn_login)이 사라졌을 때의 상황이다
  const newBtn = makeEl();
  const scope = makeScope({ 'button[type="submit"]': newBtn });
  const r5 = await clickAny(scope, ['.btn_login', '#log\\.login', 'button[type="submit"]'],
                            { timeout: 2000, label: '로그인 버튼' });
  ok('첫 선택자가 없어도 다음 후보로 찾는다', r5.ok === true);
  ok('어떤 선택자로 찾았는지 알려준다', r5.used === 'button[type="submit"]');

  // ── 6) 다 없으면 오래 기다리지 않고 이유를 알려준다 ──────
  const t0 = Date.now();
  const r6 = await clickAny(makeScope({}), ['.a', '.b'], { timeout: 1200, label: '발행 버튼' });
  const spent = Date.now() - t0;
  ok('없으면 실패로 돌려준다', r6.ok === false);
  ok('사이트 변경 가능성을 알려준다', /사이트 구조가 바뀌/.test(r6.error));
  ok('정해진 시간 안에 포기한다 (30초씩 멈추지 않는다)', spent < 3000);

  // ── 7) 없어도 되는 버튼은 조용히 넘어간다 ────────────────
  const r7 = await clickAny(makeScope({}), ['.confirm'], { timeout: 600, label: '확인 버튼', optional: true });
  ok('선택적인 버튼은 실패해도 안내만 한다', r7.ok === false && /건너뜀/.test(r7.error));

  // ── 8) 안 보이는 요소는 건너뛴다 ─────────────────────────
  const hidden = makeEl({ visible: false });
  const shown = makeEl();
  const r8 = await clickAny(makeScope({ '.hidden': hidden, '.shown': shown }),
                            ['.hidden', '.shown'], { timeout: 2000 });
  ok('숨은 요소는 누르지 않는다', r8.used === '.shown');
  ok('숨은 요소는 건드리지도 않는다', hidden.log.length === 0);

  // ── 9) 입력칸 찾기 ───────────────────────────────────────
  const input = makeEl();
  const f = await findAny(makeScope({ 'input[name="id"]': input }),
                          ['#id', 'input[name="id"]'], { timeout: 1500 });
  ok('입력칸도 후보 중에서 찾아준다', f.sel === 'input[name="id"]');
  const none = await findAny(makeScope({}), ['#none'], { timeout: 600 });
  ok('없으면 없다고 돌려준다', none.el === null);

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
