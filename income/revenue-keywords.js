/**
 * income/revenue-keywords.js
 * 돈이 되는 키워드를 고른다.
 *
 * 왜 따로 두나:
 *   지금까지는 '실시간 트렌드'로 글을 썼다. 트래픽은 잠깐 오지만 돈은 안 된다.
 *   "○○ 사건", "○○ 발표" 같은 글을 읽는 사람은 물건을 사러 온 게 아니다.
 *
 *   제휴 수익은 '살까 말까 고민하는 사람'이 읽을 때 난다.
 *   "○○ 추천", "○○ 비교", "○○ 후기" 같은 검색어가 그런 사람들의 말이다.
 *   같은 조회수라도 전환율이 몇 배 차이난다.
 *
 * 그리고 신규 블로그가 상위에 뜨려면 경쟁이 낮아야 한다.
 * 그래서 넓은 말(예: '노트북')이 아니라 좁은 말(예: '20만원대 무선이어폰 추천')을 쓴다.
 */

'use strict';

/** 구매 직전 검색어의 형태 — 이 말이 붙으면 사러 온 사람이다 */
const INTENT_PATTERNS = [
  { suffix: '추천',        weight: 10, note: '살 것을 고르는 중' },
  { suffix: '비교',        weight: 9,  note: '두세 개 중 고민 중' },
  { suffix: '후기',        weight: 8,  note: '마지막 확인 중' },
  { suffix: '가성비',      weight: 9,  note: '예산 안에서 고르는 중' },
  { suffix: '순위',        weight: 7,  note: '뭐가 좋은지 훑는 중' },
  { suffix: '차이',        weight: 6,  note: '어떤 걸 살지 헷갈리는 중' },
];

/** 계절·상황을 타는 주제 (검색이 몰리는 때가 있다) */
const SEED_TOPICS = [
  { topic: '무선 이어폰',      category: '디지털/가전',   budget: ['10만원대', '20만원대'] },
  { topic: '로봇청소기',        category: '디지털/가전',   budget: ['50만원대', '100만원 이하'] },
  { topic: '전기포트',          category: '생활/건강',     budget: ['3만원대', '5만원 이하'] },
  { topic: '캠핑 의자',         category: '스포츠/레저',   budget: ['5만원대', '10만원 이하'] },
  { topic: '러닝화',            category: '패션잡화',      budget: ['10만원대', '15만원 이하'] },
  { topic: '유아 물티슈',       category: '출산/육아',     budget: ['대용량', '민감성'] },
  { topic: '강아지 사료',       category: '생활/건강',     budget: ['소형견', '대형견'] },
  { topic: '수분 크림',         category: '화장품/미용',   budget: ['건성용', '지성용'] },
  { topic: '단백질 보충제',     category: '식품',          budget: ['입문용', '가성비'] },
  { topic: '노트북 거치대',     category: '디지털/가전',   budget: ['2만원대', '접이식'] },
  { topic: '무선 청소기',       category: '디지털/가전',   budget: ['30만원대', '원룸용'] },
  { topic: '공기청정기',        category: '디지털/가전',   budget: ['20만원대', '소형'] },
  { topic: '전기장판',          category: '생활/건강',     budget: ['1인용', '세탁 가능'] },
  { topic: '가습기',            category: '생활/건강',     budget: ['5만원 이하', '조용한'] },
];

/**
 * 오늘 쓸 키워드를 뽑는다.
 * 날짜를 씨앗으로 써서 매일 다른 조합이 나오되, 같은 날은 같은 결과가 나오게 한다
 * (하루에 여러 번 돌려도 같은 글을 반복해서 만들지 않는다).
 *
 * @param {number} count 뽑을 개수
 * @param {Date}   now
 * @returns {Array<{keyword:string, topic:string, category:string, intent:string, why:string, score:number}>}
 */
function pickRevenueKeywords(count = 3, now = new Date()) {
  const daySeed = Math.floor(now.getTime() / 86400000);
  const out = [];

  for (let i = 0; i < count; i++) {
    const t = SEED_TOPICS[(daySeed + i * 5) % SEED_TOPICS.length];
    const p = INTENT_PATTERNS[(daySeed + i * 3) % INTENT_PATTERNS.length];
    const b = t.budget[(daySeed + i) % t.budget.length];

    // 좁은 검색어로 만든다 — 넓은 말은 신규 블로그가 이길 수 없다
    const keyword = `${b} ${t.topic} ${p.suffix}`;
    out.push({
      keyword,
      topic: t.topic,
      category: t.category,
      intent: p.suffix,
      why: `${p.note} — 제휴 전환이 나오는 검색어`,
      score: p.weight,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 이 키워드로 쓸 글의 형식을 알려준다 (구매 결정을 돕는 구조) */
function articleShape(kw) {
  return {
    topic: `${kw.category} · 구매 가이드`,
    tone: '친근하고 솔직한',
    outline: [
      `${kw.topic} 고를 때 진짜 봐야 하는 것 3가지`,
      '가격대별로 뭐가 다른가',
      '이런 사람에겐 이게 맞다 (상황별 추천)',
      '살 때 흔히 하는 실수',
      '자주 묻는 질문',
    ],
    note: '없는 사용 경험을 지어내지 말 것. 사양·가격·후기 경향으로 판단 근거를 준다.',
  };
}

/** 일주일 계획 — 매일 몇 개씩, 어떤 키워드로 */
function weeklyPlan(perDay = 2, now = new Date()) {
  const days = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(now.getTime() + d * 86400000);
    days.push({
      date: date.toISOString().slice(0, 10),
      keywords: pickRevenueKeywords(perDay, date),
    });
  }
  return { perDay, total: perDay * 7, days };
}

module.exports = { pickRevenueKeywords, articleShape, weeklyPlan, INTENT_PATTERNS, SEED_TOPICS };
