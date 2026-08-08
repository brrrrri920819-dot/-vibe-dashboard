/**
 * test/revenue.test.js
 * 실제로 돈이 되는 구조인가.
 *
 * 두 가지가 동시에 맞아야 수익이 난다.
 *   1) 물건을 살까 고민하는 사람이 검색하는 말로 글을 쓴다
 *      (트렌드 글은 조회수는 나와도 사러 온 사람이 아니다)
 *   2) 상품 링크에 내 추적 ID가 붙어 있다
 *      (없으면 구매가 일어나도 수익은 0원이다)
 *
 * 예전엔 2번이 아예 없었다. '제휴 링크'라며 넣던 건 제휴사 가입 페이지였다.
 */

'use strict';

const assert = require('assert');
const { pickRevenueKeywords, articleShape, weeklyPlan } = require('../income/revenue-keywords');
const { withTracking, trackAll, trackingStatus } = require('../affiliates/tracking');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

const fakeTokens = (v = {}) => ({ get: (k) => v[k] || null });

(async () => {
  console.log('\n💰 수익 구조 테스트\n');

  // ── 1) 구매 의도 키워드 ──────────────────────────────────
  const picks = pickRevenueKeywords(3);
  ok('요청한 개수만큼 뽑는다', picks.length === 3);
  ok('전부 구매 직전 검색어다',
    picks.every(k => /추천|비교|후기|가성비|순위|차이/.test(k.keyword)));
  ok('좁은 검색어다 (예산·조건이 붙는다)', picks.every(k => k.keyword.split(' ').length >= 3));
  ok('왜 이 키워드인지 이유가 붙는다', picks.every(k => !!k.why));
  ok('전환 가능성 높은 순으로 정렬된다', picks[0].score >= picks[picks.length - 1].score);

  // 같은 날은 같은 결과 — 하루에 여러 번 돌려도 같은 글을 또 만들지 않는다
  const again = pickRevenueKeywords(3);
  ok('같은 날엔 같은 키워드가 나온다', JSON.stringify(picks) === JSON.stringify(again));
  const tomorrow = pickRevenueKeywords(3, new Date(Date.now() + 86400000));
  ok('다음 날엔 다른 키워드가 나온다', JSON.stringify(picks) !== JSON.stringify(tomorrow));

  // ── 2) 글 형식이 구매 결정을 돕는가 ──────────────────────
  const shape = articleShape(picks[0]);
  ok('가격대별 비교가 들어간다', shape.outline.some(o => /가격대/.test(o)));
  ok('상황별 추천이 들어간다', shape.outline.some(o => /이런 사람/.test(o)));
  ok('없는 경험을 지어내지 말라고 못박는다', /지어내지 말/.test(shape.note));

  // ── 3) 일주일 계획 ───────────────────────────────────────
  const plan = weeklyPlan(2);
  ok('7일치를 세운다', plan.days.length === 7);
  ok('하루 개수가 반영된다', plan.days.every(d => d.keywords.length === 2));
  ok('총 편수를 알려준다', plan.total === 14);

  // ── 4) 추적 ID — 이게 없으면 전부 무의미하다 ─────────────
  const none = trackingStatus(fakeTokens());
  ok('추적 ID가 없으면 그렇다고 한다', none.ok === false);
  ok('수익이 0원이라고 분명히 말한다', /수익이 발생하지 않습니다/.test(none.reason));

  const coupang = fakeTokens({ COUPANG_PARTNERS_TAG: 'AF1234567' });
  ok('추적 ID가 있으면 정상으로 본다', trackingStatus(coupang).ok === true);

  // 쿠팡 링크에 실제로 붙는가
  const t1 = withTracking('https://www.coupang.com/vp/products/123', coupang);
  ok('쿠팡 링크에 추적 ID를 붙인다', t1.tracked === true && t1.url.includes('lptag=AF1234567'));
  ok('어느 제휴사인지 알려준다', t1.network === 'coupang');

  // 이미 있으면 덮어쓰지 않는다
  const t2 = withTracking('https://www.coupang.com/vp/products/1?lptag=EXIST', coupang);
  ok('이미 붙은 추적 ID를 덮어쓰지 않는다', t2.url.includes('lptag=EXIST'));

  // ID가 없으면 붙이지 않고, 붙인 척도 하지 않는다
  const t3 = withTracking('https://www.coupang.com/vp/products/123', fakeTokens());
  ok('ID가 없으면 붙이지 않는다', t3.tracked === false && !t3.url.includes('lptag'));
  ok('붙인 척하지 않는다', t3.url === 'https://www.coupang.com/vp/products/123');

  // 네이버
  const naver = fakeTokens({ NAVER_CONNECT_ID: 'myconnect' });
  const t4 = withTracking('https://smartstore.naver.com/shop/products/1', naver);
  ok('네이버 상품 링크에도 붙인다', t4.tracked === true && t4.url.includes('nt_detail=myconnect'));

  // 이상한 주소에도 안 깨진다
  ok('빈 주소에 깨지지 않는다', withTracking('', coupang).tracked === false);
  ok('주소가 아닌 값에도 깨지지 않는다', withTracking('그냥글자', coupang).tracked === false);

  // ── 5) 목록 전체 처리 ────────────────────────────────────
  const res = trackAll([
    { link: 'https://www.coupang.com/vp/products/1' },
    { link: 'https://example.com/x' },
  ], coupang);
  ok('붙은 개수를 세어 알려준다', res.trackedCount === 1 && res.total === 2);
  ok('붙지 않은 링크도 그대로 남긴다', res.products[1].link === 'https://example.com/x');

  // ── 6) 제휴 목록이 대세를 따라가는가 ─────────────────────
  const { programsAgeMonths } = require('../affiliates/crawler');
  const crawlerSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'affiliates', 'crawler.js'), 'utf8');
  ok('토스쇼핑 쉐어링크가 목록에 있다', /toss_sharelink/.test(crawlerSrc));
  ok('토스 수수료가 쿠팡보다 높게 잡혀 있다', /commissionAvg: 10\.0/.test(crawlerSrc));
  ok('알리익스프레스가 목록에 있다', /aliexpress/.test(crawlerSrc));
  ok('테무가 목록에 있다', /temu/.test(crawlerSrc));
  ok('언제 확인한 목록인지 적혀 있다', /PROGRAMS_VERIFIED_AT/.test(crawlerSrc));
  ok('목록 나이를 셀 수 있다', typeof programsAgeMonths() === 'number');

  // 토스 쉐어링크는 링크에 이미 ID가 박혀 나온다
  const share = withTracking('https://toss.im/share/abc123', fakeTokens());
  ok('토스 쉐어링크는 추적되는 링크로 본다', share.tracked === true && share.network === 'toss');
  const plainToss = withTracking('https://toss.im/', fakeTokens());
  ok('그냥 토스 주소는 추적 안 된다고 말한다', plainToss.tracked === false);

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
