/**
 * affiliates/recommender.js
 * 글 주제에 맞는 제휴 프로그램을 고르고, 본문에 넣을 제휴 블록과 고지문을 만든다.
 *
 * 원칙
 * - 네이버 블로그는 외부 제휴 링크 정책이 까다로워, 네이버에서 허용되는
 *   프로그램(naverBlogCompatible)만 고른다.
 * - 공정거래위원회 추천·보증 심사지침상 대가성 문구는 본문 안에,
 *   독자가 읽기 전에 보이도록 넣어야 한다. 글 맨 앞과 링크 근처 양쪽에 표시한다.
 */

const { crawlAffiliates } = require('./crawler');
const { trackingStatus } = require('./tracking');

// 주제 → 어울리는 제휴 카테고리 힌트
const TOPIC_HINTS = [
  { re: /여행|호텔|항공|숙박|펜션|리조트/,               want: ['여행', '숙박'] },
  { re: /뷰티|화장품|스킨|메이크업|다이어트|헬스|건강/,   want: ['뷰티', '건강', '종합쇼핑'] },
  { re: /패션|옷|신발|가방|의류/,                        want: ['패션', '종합쇼핑'] },
  { re: /가전|노트북|폰|스마트폰|컴퓨터|전자/,           want: ['가전', '종합쇼핑'] },
  { re: /육아|아기|유아|출산|임신/,                      want: ['육아', '종합쇼핑'] },
  { re: /금융|카드|대출|보험|적금|투자|재테크/,          want: ['금융'] },
  { re: /책|도서|강의|교육|자격증/,                      want: ['교육', '종합쇼핑'] },
  { re: /식품|음식|맛집|요리|간식/,                      want: ['식품', '종합쇼핑'] },
];

/**
 * 글 주제에 맞는 제휴 프로그램 추천
 * @param {string} topicText  키워드 + 제목 등 주제를 나타내는 텍스트
 * @param {object} opts       { platform: 'naver'|'tistory'|'blogger', limit: number }
 */
async function recommendAffiliates(topicText = '', opts = {}) {
  const { platform = 'blogger', limit = 2 } = opts;

  let programs = [];
  try {
    const data = await crawlAffiliates();
    programs = data.programs || [];
  } catch (e) {
    console.warn('[Affiliate] 제휴 데이터 조회 실패:', e.message);
    return [];
  }

  // 네이버는 허용되는 프로그램만
  let pool = platform === 'naver'
    ? programs.filter(p => p.naverBlogCompatible)
    : programs.slice();

  if (!pool.length) return [];

  // 주제와 맞는 카테고리에 가산점
  const hint = TOPIC_HINTS.find(h => h.re.test(topicText));
  const wanted = hint ? hint.want : [];

  const scored = pool.map(p => {
    let score = (p.hotScore || 0) + (p.commissionAvg || 0) * 3;   // 인기 + 수익률
    if (wanted.some(w => (p.category || '').includes(w) || (p.bestFor || '').includes(w))) score += 40;
    if (p.trending) score += 10;
    return { ...p, _score: score };
  }).sort((a, b) => b._score - a._score);

  return scored.slice(0, Math.max(1, limit));
}

/** 글 맨 앞에 넣는 대가성 고지 (공정위 지침) */
function disclosureBanner() {
  return '<div style="background:#fff8e6;border:1px solid #f5d78e;border-radius:10px;'
    + 'padding:12px 15px;margin:0 0 24px;font-size:14px;line-height:1.7;color:#7a5b00">'
    + '<strong style="color:#7a5b00">알림</strong> · 이 글에는 제휴 링크가 포함되어 있으며, '
    + '링크를 통해 구매가 이루어지면 작성자가 일정액의 수수료를 받을 수 있습니다. '
    + '구매자에게 추가되는 비용은 없습니다.</div>';
}

/** 본문 하단에 넣는 제휴 추천 블록 */
function affiliateBlock(programs, topicText = '') {
  if (!programs || !programs.length) return '';

  const cards = programs.map(p => {
    const pros = (p.pros || []).slice(0, 2).map(x =>
      `<li style="font-size:14.5px;line-height:1.7;color:#374151;margin-bottom:5px">${x}</li>`).join('');
    return '<div style="border:1px solid #e5e9f0;border-radius:12px;padding:16px 18px;margin-bottom:12px;background:#fff">'
      + `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">`
      + `<span style="font-size:16px;font-weight:700;color:#111">${p.name}</span>`
      + `<span style="font-size:12px;font-weight:700;color:#2563eb;background:#eff6ff;border-radius:20px;padding:3px 10px">수수료 ${p.commissionRate || '-'}</span>`
      + `</div>`
      + `<div style="font-size:14.5px;line-height:1.75;color:#4b5563;margin-bottom:8px">추천 분야: ${p.bestFor || p.category || '-'}</div>`
      + (pros ? `<ul style="margin:0 0 10px;padding-left:20px">${pros}</ul>` : '')
      + `<a href="${p.url}" target="_blank" rel="sponsored nofollow noopener" `
      + `style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;`
      + `padding:11px 20px;border-radius:9px;font-size:15px;font-weight:600">${p.name} 바로가기 →</a>`
      + '</div>';
  }).join('');

  return '<h2 style="font-size:22px;line-height:1.5;font-weight:700;color:#111;margin:48px 0 18px;'
    + 'padding:2px 0 2px 14px;border-left:5px solid #2563eb;word-break:keep-all">함께 보면 좋은 제휴 서비스</h2>'
    + '<p style="font-size:17px;line-height:1.9;color:#2b2b2b;margin:0 0 20px;word-break:keep-all">'
    + '이 주제와 관련해 실제로 수익이 잘 나오는 제휴 프로그램을 정리했어요. '
    + '아래 링크는 제휴 링크이며, 구매 시 작성자에게 수수료가 지급될 수 있습니다.</p>'
    + cards;
}

/**
 * 본문에 제휴 구조를 통째로 적용
 * @returns {{content:string, used:Array}}
 */
async function applyAffiliates(content, topicText, opts = {}) {
  const platform = opts.platform || 'blogger';
  const tokens = opts.tokens || null;
  const programs = await recommendAffiliates(topicText, opts);

  /* 추적 ID가 없으면 상품 링크를 걸어도 수익이 0원이다.
     그 사실을 로그로 분명히 남긴다 — 조용히 0원인 게 제일 나쁘다. */
  const track = tokens ? trackingStatus(tokens) : { ok: false, reason: '추적 ID 확인 불가' };
  if (!track.ok) console.warn(`[Affiliate] ⚠️ ${track.reason}`);

  /* 상품 링크는 플랫폼을 가리지 않고 넣는다.
     예전엔 네이버에서만 넣었는데, 정작 지금 발행이 되는 곳은 구글 블로그다.
     수익이 날 수 있는 곳에 링크가 없으면 아무 의미가 없다. */
  let productHtml = '';
  let products = [];
  {
    try {
      const { recommendProducts, productBlock } = require('./shopping-connect');
      const rec = await recommendProducts(topicText, 3);
      if (rec.ok) {
        productHtml = productBlock(rec, tokens);
        products = rec.products.map(p => ({ title: p.title, price: p.price, link: p.link, rate: p.commissionRate }));
        console.log(`[ShoppingConnect] 상품 ${products.length}개 삽입 (${rec.category})`);
      } else if (rec.reason) {
        console.warn(`[ShoppingConnect] 상품 추천 생략 — ${rec.reason}`);
      }
    } catch (e) {
      console.warn('[ShoppingConnect] 상품 추천 실패:', e.message);
    }
  }

  if (!programs.length && !productHtml) return { content, used: [], products: [] };

  const withBanner = disclosureBanner() + content + productHtml + affiliateBlock(programs, topicText);
  if (programs.length) console.log(`[Affiliate] ${platform} — 적용: ${programs.map(p => p.name).join(', ')}`);
  return {
    content: withBanner,
    used: programs.map(p => ({ id: p.id, name: p.name, rate: p.commissionRate })),
    products,
    tracked: track.ok,        // 이 글의 링크로 수익이 발생할 수 있는가
    trackingReason: track.reason,
  };
}

module.exports = { recommendAffiliates, applyAffiliates, disclosureBanner, affiliateBlock };
