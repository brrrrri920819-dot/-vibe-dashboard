/**
 * affiliates/shopping-connect.js
 * 네이버 쇼핑에서 실제 판매 중인 상품을 수집해,
 * 쇼핑커넥트 기준 수익성(수수료율 × 인기)이 높은 순으로 추천한다.
 *
 * 목적: 글을 쓸 때마다 어떤 상품을 걸지 고민하지 않도록,
 *       주제에 맞는 상품 링크를 미리 골라 본문에 넣을 수 있게 준비해 둔다.
 */

'use strict';

const https = require('https');

// 쇼핑커넥트 카테고리별 수수료 (네이버 공지 기준 대략치)
const CATEGORY_RATE = {
  '패션의류':    { min: 10, max: 15 },
  '패션잡화':    { min: 8,  max: 12 },
  '화장품/미용': { min: 8,  max: 12 },
  '생활/건강':   { min: 5,  max: 10 },
  '스포츠/레저': { min: 5,  max: 10 },
  '출산/육아':   { min: 5,  max: 8  },
  '식품':        { min: 3,  max: 7  },
  '디지털/가전': { min: 2,  max: 5  },
  '가구/인테리어': { min: 4, max: 8 },
  '여가/생활편의': { min: 4, max: 8 },
};
const DEFAULT_RATE = { min: 3, max: 7 };

// 주제 → 네이버 쇼핑 검색어 힌트
const TOPIC_TO_QUERY = [
  { re: /뷰티|화장품|스킨|메이크업|피부/,        q: '스킨케어 세트',   cat: '화장품/미용' },
  { re: /다이어트|헬스|운동|피트니스/,           q: '다이어트 보조제', cat: '생활/건강' },
  { re: /패션|옷|의류|코디|자켓|원피스/,         q: '여성 자켓',       cat: '패션의류' },
  { re: /가방|신발|운동화|지갑/,                 q: '운동화',          cat: '패션잡화' },
  { re: /육아|아기|유아|출산|기저귀/,            q: '유아 용품',       cat: '출산/육아' },
  { re: /반려|강아지|고양이|펫/,                 q: '반려동물 사료',   cat: '생활/건강' },
  { re: /캠핑|등산|자전거|골프|레저/,            q: '캠핑 용품',       cat: '스포츠/레저' },
  { re: /가전|노트북|폰|모니터|이어폰|전자/,     q: '무선 이어폰',     cat: '디지털/가전' },
  { re: /인테리어|가구|수납|조명/,               q: '수납장',          cat: '가구/인테리어' },
  { re: /식품|음식|간식|건강식|영양제/,          q: '건강 영양제',     cat: '식품' },
];

/* 벽시계 타임아웃으로 감싼다.
 * req.setTimeout은 소켓 비활성 타임아웃이라, 연결이 걸린 채 응답만
 * 오지 않는 상황에서는 작동하지 않아 호출이 영원히 멈춘다.
 * 발행 도중 여기서 멈추면 글이 올라가지 않으므로 반드시 끊어야 한다. */
function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 응답 시간 초과 (${ms / 1000}초)`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); },
                 e => { clearTimeout(timer); reject(e); });
  });
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/html,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/** 주제에 맞는 검색어와 카테고리 고르기 */
function pickQuery(topicText = '') {
  const hit = TOPIC_TO_QUERY.find(t => t.re.test(topicText));
  if (hit) return { query: hit.q, category: hit.cat };
  // 못 찾으면 수수료가 높은 카테고리를 기본으로
  return { query: '스킨케어 세트', category: '화장품/미용' };
}

/** 네이버 쇼핑 검색 API (공식 오픈API — 키가 있을 때만) */
async function searchNaverShopping(query, count = 20) {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) return null;

  const url = `https://openapi.naver.com/v1/search/shop.json?query=${encodeURIComponent(query)}&display=${count}&sort=sim`;
  const json = await withDeadline(new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'X-Naver-Client-Id': id, 'X-Naver-Client-Secret': secret },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`파싱 실패: ${d.slice(0, 120)}`)); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  }), 12000, '네이버 쇼핑 검색');

  if (json.errorMessage) throw new Error(json.errorMessage);
  return (json.items || []).map(it => ({
    title:    String(it.title || '').replace(/<[^>]+>/g, ''),
    link:     it.link,
    image:    it.image,
    price:    Number(it.lprice) || 0,
    mall:     it.mallName || '',
    category: it.category1 || '',
    productId: it.productId || '',
  }));
}

/** 수익성 점수 — 수수료율과 가격대를 함께 본다 */
function scoreProduct(p, category) {
  const rate = CATEGORY_RATE[category] || CATEGORY_RATE[p.category] || DEFAULT_RATE;
  const avgRate = (rate.min + rate.max) / 2;
  const expected = p.price * (avgRate / 100);      // 1건당 기대 수수료

  let score = Math.min(expected / 100, 60);        // 기대 수수료 (상한)
  score += avgRate * 2;                            // 수수료율 자체
  // 너무 비싸면 구매 전환이 떨어지고, 너무 싸면 수수료가 남지 않는다
  if (p.price >= 20000 && p.price <= 200000) score += 15;
  if (p.mall && /스마트스토어|네이버/.test(p.mall)) score += 10;   // 쇼핑커넥트 대상

  return { score: Math.round(score), avgRate, expectedFee: Math.round(expected) };
}

/**
 * 주제에 맞는 수익 좋은 상품 추천
 * @returns {{ok:boolean, query:string, category:string, products:Array, reason?:string}}
 */
async function recommendProducts(topicText = '', limit = 5) {
  const { query, category } = pickQuery(topicText);

  // 키가 없는 것과 검색이 실패한 것을 구분해서 알려준다
  // (원인이 다른데 같은 안내를 하면 엉뚱한 곳을 고치게 된다)
  const hasKey = !!(process.env.NAVER_CLIENT_ID && process.env.NAVER_CLIENT_SECRET);
  if (!hasKey) {
    return {
      ok: false, query, category, products: [],
      reason: 'NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 미설정 — 설정 탭에서 입력하면 실제 상품을 추천합니다',
    };
  }

  let items = null;
  let failReason = '';
  try {
    items = await searchNaverShopping(query, 20);
  } catch (e) {
    failReason = e.message;
    console.warn('[ShoppingConnect] 검색 실패:', e.message);
  }

  if (!items) {
    return {
      ok: false, query, category, products: [],
      reason: `네이버 쇼핑 검색 실패 — ${failReason || '알 수 없는 오류'}`,
    };
  }
  if (!items.length) {
    return { ok: false, query, category, products: [], reason: `"${query}" 검색 결과가 없습니다` };
  }

  const scored = items.map(p => {
    const s = scoreProduct(p, category);
    const rate = CATEGORY_RATE[category] || DEFAULT_RATE;
    return {
      ...p,
      score: s.score,
      commissionRate: `${rate.min}~${rate.max}%`,
      expectedFee: s.expectedFee,
    };
  }).sort((a, b) => b.score - a.score);

  return { ok: true, query, category, products: scored.slice(0, limit) };
}

/** 추천 상품을 본문에 넣을 HTML로 (발행용 인라인 서식) */
function productBlock(rec) {
  if (!rec || !rec.ok || !rec.products.length) return '';

  const cards = rec.products.slice(0, 3).map(p => {
    const price = p.price ? p.price.toLocaleString('ko-KR') + '원' : '가격 문의';
    return '<div style="display:flex;gap:14px;align-items:center;border:1px solid #e5e9f0;border-radius:12px;'
      + 'padding:14px;margin-bottom:10px;background:#fff">'
      + (p.image ? `<img src="${p.image}" alt="" style="width:82px;height:82px;object-fit:cover;border-radius:9px;flex-shrink:0">` : '')
      + '<div style="min-width:0;flex:1">'
      + `<div style="font-size:15px;font-weight:600;color:#111;line-height:1.5;margin-bottom:5px;word-break:keep-all">${p.title}</div>`
      + `<div style="font-size:15px;font-weight:700;color:#2563eb;margin-bottom:8px">${price}</div>`
      + `<a href="${p.link}" target="_blank" rel="sponsored nofollow noopener" `
      + 'style="display:inline-block;background:#03c75a;color:#fff;text-decoration:none;'
      + 'padding:9px 16px;border-radius:8px;font-size:14px;font-weight:600">상품 보러가기 →</a>'
      + '</div></div>';
  }).join('');

  return '<h2 style="font-size:22px;line-height:1.5;font-weight:700;color:#111;margin:48px 0 18px;'
    + 'padding:2px 0 2px 14px;border-left:5px solid #03c75a;word-break:keep-all">이 글과 어울리는 상품</h2>'
    + '<p style="font-size:17px;line-height:1.9;color:#2b2b2b;margin:0 0 20px;word-break:keep-all">'
    + '아래 상품은 네이버 쇼핑에서 이 주제와 관련해 많이 찾는 상품이에요. '
    + '링크는 제휴 링크이며, 구매 시 작성자에게 수수료가 지급될 수 있습니다.</p>'
    + cards;
}

module.exports = { recommendProducts, productBlock, pickQuery, CATEGORY_RATE };
