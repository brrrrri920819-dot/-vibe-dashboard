/**
 * affiliates/crawler.js
 * 제휴 마케팅 프로그램 수집·분석 + 네이버 쇼핑커넥트 트렌드
 */

const https = require('https');
const http  = require('http');

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9',
        ...opts.headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── 주요 제휴 프로그램 정보 (curated + live 스코어) ──────
const PROGRAMS = [
  {
    id: 'coupang',
    name: '쿠팡파트너스',
    url: 'https://partners.coupang.com',
    type: 'CPS',
    category: '종합쇼핑',
    commissionRate: '1~3%',
    commissionAvg: 2.0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 24,
    pros: ['국내 최대 쇼핑몰', '로켓배송으로 전환율 최고', '모든 카테고리 커버'],
    cons: ['쿠키 24시간으로 짧음', '패션 카테고리 낮은 수수료'],
    bestFor: '생활용품, 가전, 뷰티, 식품',
    hotScore: 97,
    trending: true,
    naverBlogCompatible: true,
    tag: '🏆 1위',
  },
  {
    id: 'naver_shopping',
    name: '네이버 쇼핑파트너',
    url: 'https://adcenter.naver.com/partner',
    type: 'CPS',
    category: '종합쇼핑',
    commissionRate: '2~5%',
    commissionAvg: 3.0,
    payment: '월 정산',
    minPayout: 20000,
    cookieDays: 30,
    pros: ['네이버 블로그 직접 연동', '검색 노출 시너지 최강', '긴 쿠키 (30일)'],
    cons: ['네이버 블로그 전용', '심사 기준 있음'],
    bestFor: '네이버 블로그 운영자 필수',
    hotScore: 94,
    trending: true,
    naverBlogCompatible: true,
    tag: '⚡ 네이버 전용',
  },
  {
    id: 'shopping_connect',
    name: '네이버 쇼핑커넥트',
    url: 'https://connect.shopping.naver.com',
    type: 'CPS',
    category: '스마트스토어',
    commissionRate: '2~15%',
    commissionAvg: 5.0,
    payment: '월 정산',
    minPayout: 0,
    cookieDays: 30,
    pros: ['스마트스토어 직접 연동', '수수료율 최고 15%', '네이버 검색 연동', '실시간 재고 확인'],
    cons: ['네이버 블로그 전용', '스마트스토어 상품만 가능'],
    bestFor: '네이버 블로그 수익화 핵심 수단',
    hotScore: 99,
    trending: true,
    naverBlogCompatible: true,
    tag: '🔥 지금 핫',
    isShoppingConnect: true,
  },
  {
    id: 'tenping',
    name: '텐핑',
    url: 'https://www.tenping.kr',
    type: 'CPS/CPA',
    category: '종합',
    commissionRate: '최대 10%',
    commissionAvg: 4.0,
    payment: '실시간 정산',
    minPayout: 0,
    cookieDays: 7,
    pros: ['실시간 정산', '최소 지급액 없음', '다양한 카테고리', '쉬운 가입'],
    cons: ['쿠키 기간 짧음', '브랜드 인지도 낮음'],
    bestFor: '초보 블로거, 다양한 시도',
    hotScore: 82,
    trending: false,
    naverBlogCompatible: true,
    tag: '💸 실시간 정산',
  },
  {
    id: 'linkprice',
    name: '링크프라이스',
    url: 'https://www.linkprice.com',
    type: 'CPS/CPA',
    category: '종합',
    commissionRate: '1~8%',
    commissionAvg: 3.5,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 30,
    pros: ['20년+ 운영 안정성', '대형 브랜드 다수 (신세계, 11번가 등)', '긴 쿠키'],
    cons: ['UI 구식', '지원 느림'],
    bestFor: '패션, 여행, 뷰티',
    hotScore: 74,
    trending: false,
    naverBlogCompatible: true,
    tag: '🏛 안정적',
  },
  {
    id: 'edpick',
    name: '에드픽',
    url: 'https://edpick.co.kr',
    type: 'CPS',
    category: '뷰티/패션',
    commissionRate: '3~15%',
    commissionAvg: 6.0,
    payment: '월 정산',
    minPayout: 30000,
    cookieDays: 14,
    pros: ['뷰티/패션 특화', '수수료 최고 15%', '인플루언서 친화적'],
    cons: ['카테고리 제한', '심사 엄격'],
    bestFor: '뷰티/패션 특화 블로거',
    hotScore: 70,
    trending: false,
    naverBlogCompatible: true,
    tag: '💄 뷰티 특화',
  },
  {
    id: 'ilike',
    name: '아이라이크',
    url: 'https://www.ilike.co.kr',
    type: 'CPA',
    category: '금융/서비스',
    commissionRate: '건당 5,000~50,000원',
    commissionAvg: 0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 30,
    pros: ['금융/보험 특화', '건당 단가 높음', '긴 쿠키'],
    cons: ['전환 어려움', '금융 콘텐츠 제한'],
    bestFor: '금융, 보험, 카드 리뷰 블로그',
    hotScore: 65,
    trending: false,
    naverBlogCompatible: false,
    tag: '💳 금융 특화',
  },
  {
    id: 'ably',
    name: '에이블리',
    url: 'https://ablycorp.com/affiliate',
    type: 'CPS',
    category: '여성패션',
    commissionRate: '5~12%',
    commissionAvg: 7.0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 7,
    pros: ['MZ 여성 타겟 최강', '앱 설치 전환율 높음', '데일리룩 콘텐츠 연동 쉬움'],
    cons: ['쿠키 7일', '앱 전용'],
    bestFor: '패션·데일리룩 블로그',
    hotScore: 95,
    trending: true,
    naverBlogCompatible: true,
    tag: '👗 MZ 여성 1위',
  },
  {
    id: 'musinsa',
    name: '무신사',
    url: 'https://www.musinsa.com/affiliate',
    type: 'CPS',
    category: '스트릿패션',
    commissionRate: '3~8%',
    commissionAvg: 5.0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 14,
    pros: ['남성 MZ 타겟', '한정판·협업 제품 인기', '유니크한 브랜드 다수'],
    cons: ['남성 편중', '심사 필요'],
    bestFor: '스트릿패션·남성패션 블로그',
    hotScore: 92,
    trending: true,
    naverBlogCompatible: true,
    tag: '🧢 스트릿 1위',
  },
  {
    id: 'oliveyoung',
    name: 'CJ 올리브영',
    url: 'https://affiliate.oliveyoung.co.kr',
    type: 'CPS',
    category: '뷰티/헬스',
    commissionRate: '3~7%',
    commissionAvg: 4.5,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 30,
    pros: ['오프라인 연동 강점', '쿠키 30일', '뷰티 전 카테고리 커버'],
    cons: ['수수료 낮음'],
    bestFor: '뷰티·스킨케어 블로그',
    hotScore: 91,
    trending: true,
    naverBlogCompatible: true,
    tag: '💚 뷰티 필수',
  },
  {
    id: 'zigzag',
    name: '지그재그',
    url: 'https://zigzag.kr/affiliate',
    type: 'CPS',
    category: '여성패션',
    commissionRate: '5~10%',
    commissionAvg: 6.5,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 7,
    pros: ['카카오 생태계', '20대 여성 핵심', '개인화 추천 강점'],
    cons: ['쿠키 7일', '경쟁 심함'],
    bestFor: '20대 여성 패션 블로그',
    hotScore: 88,
    trending: true,
    naverBlogCompatible: true,
    tag: '💜 카카오 패션',
  },
  {
    id: 'ohouse',
    name: '오늘의집',
    url: 'https://ohou.se/affiliate',
    type: 'CPS',
    category: '인테리어/라이프',
    commissionRate: '3~8%',
    commissionAvg: 5.0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 14,
    pros: ['라이프스타일 트렌드 선도', '단가 높은 제품군', '인스타 친화적'],
    cons: ['구매 결정 길어짐'],
    bestFor: '인테리어·홈스타일링 블로그',
    hotScore: 86,
    trending: true,
    naverBlogCompatible: true,
    tag: '🏠 인테리어 1위',
  },
  {
    id: 'kurly',
    name: '마켓컬리',
    url: 'https://www.kurly.com/affiliate',
    type: 'CPS',
    category: '식품/프리미엄',
    commissionRate: '2~5%',
    commissionAvg: 3.5,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 14,
    pros: ['프리미엄 식품 전문', '충성고객 많음', '새벽배송 인기'],
    cons: ['수수료 낮음', '서울·수도권 중심'],
    bestFor: '푸드·건강 라이프스타일 블로그',
    hotScore: 82,
    trending: false,
    naverBlogCompatible: true,
    tag: '🥬 프리미엄 식품',
  },
  {
    id: 'kream',
    name: '크림 (KREAM)',
    url: 'https://kream.co.kr/affiliate',
    type: 'CPS',
    category: '한정판/리셀',
    commissionRate: '1~3%',
    commissionAvg: 2.0,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 7,
    pros: ['고단가 제품 (평균 20만원+)', '스니커즈 MZ 열풍', '네이버 운영 안정성'],
    cons: ['수수료 낮지만 단가 높아 금액은 큼', '경쟁 심함'],
    bestFor: '스니커즈·한정판 리뷰 블로그',
    hotScore: 80,
    trending: true,
    naverBlogCompatible: true,
    tag: '👟 한정판 리셀',
  },
  {
    id: 'wconcept',
    name: 'W컨셉',
    url: 'https://www.wconcept.co.kr/affiliate',
    type: 'CPS',
    category: '디자이너패션',
    commissionRate: '5~10%',
    commissionAvg: 7.0,
    payment: '월 정산',
    minPayout: 20000,
    cookieDays: 14,
    pros: ['프리미엄 패션', '단가 높음', '패션 인플루언서 선호'],
    cons: ['좁은 타겟', '높은 최소 지급액'],
    bestFor: '프리미엄 패션·스타일 블로그',
    hotScore: 76,
    trending: false,
    naverBlogCompatible: true,
    tag: '✨ 디자이너 패션',
  },
  {
    id: 'twentynine',
    name: '29CM',
    url: 'https://www.29cm.co.kr/affiliate',
    type: 'CPS',
    category: '감성라이프',
    commissionRate: '4~8%',
    commissionAvg: 5.5,
    payment: '월 정산',
    minPayout: 10000,
    cookieDays: 14,
    pros: ['20~30대 감성 타겟', '패션+리빙 복합', '브랜드 충성도 높음'],
    cons: ['타겟 좁음'],
    bestFor: '감성 라이프스타일·패션 블로그',
    hotScore: 78,
    trending: false,
    naverBlogCompatible: true,
    tag: '🎨 감성 라이프',
  },
  {
    id: 'balaan',
    name: '발란',
    url: 'https://www.balaan.co.kr/affiliate',
    type: 'CPS',
    category: '명품/럭셔리',
    commissionRate: '2~5%',
    commissionAvg: 3.5,
    payment: '월 정산',
    minPayout: 20000,
    cookieDays: 30,
    pros: ['명품 고단가 (평균 50만원+)', '쿠키 30일', '럭셔리 블로그 필수'],
    cons: ['타겟 제한적', '전환율 낮음'],
    bestFor: '명품·럭셔리 리뷰 블로그',
    hotScore: 73,
    trending: false,
    naverBlogCompatible: true,
    tag: '👜 명품 플랫폼',
  },
];

// ── 네이버 쇼핑 트렌드 크롤링 ────────────────────────────
async function fetchNaverShoppingTrends() {
  const results = [];

  // 네이버 쇼핑 인기 섹션 크롤
  try {
    const res = await fetchUrl('https://shopping.naver.com/home/p/index.nhn');
    const kw = /"keyword":"([^"]{2,30})"/g;
    const nm = /"productName":"([^"]{3,40})"/g;
    const seen = new Set();
    let m;
    while ((m = kw.exec(res.body)) !== null && results.length < 15) {
      const word = m[1].trim();
      if (!seen.has(word) && !word.includes('\\') && word.length >= 2) {
        results.push({ keyword: word, type: 'keyword', score: 90 - results.length * 2 });
        seen.add(word);
      }
    }
    while ((m = nm.exec(res.body)) !== null && results.length < 25) {
      const word = m[1].trim();
      if (!seen.has(word) && !word.includes('\\') && word.length >= 4) {
        results.push({ keyword: word, type: 'product', score: 70 - results.length });
        seen.add(word);
      }
    }
  } catch {}

  // 네이버 데이터랩 쇼핑 인사이트 (공개)
  try {
    const res = await fetchUrl('https://datalab.naver.com/shoppingInsight/sCategory.naver');
    const kw = /"keyword":"([^"]{2,20})"/g;
    const seen2 = new Set(results.map(r => r.keyword));
    let m;
    while ((m = kw.exec(res.body)) !== null && results.length < 30) {
      const word = m[1].trim();
      if (!seen2.has(word) && word.length >= 2) {
        results.push({ keyword: word, type: 'shopping_insight', score: 60 });
        seen2.add(word);
      }
    }
  } catch {}

  if (results.length === 0) return getDefaultShoppingTrends();
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

function getDefaultShoppingTrends() {
  const month = new Date().getMonth() + 1;
  const seasonal = month >= 6 && month <= 8
    ? ['여름 원피스', '선크림', '에어컨 추천', '쿨링 침구', '여름 샌들', '제습기']
    : month >= 12 || month <= 2
    ? ['패딩 추천', '핫팩', '전기장판', '울 코트', '겨울 부츠', '난방텐트']
    : ['봄 코디', '다이어트 식품', '홈트레이닝', '아이크림', '여행 캐리어', '봄 원피스'];

  const base = ['쿠팡 추천', '베스트셀러', '오늘의딜', '특가 상품', '인기 브랜드'];
  return [...seasonal, ...base].map((k, i) => ({ keyword: k, type: 'seasonal', score: 85 - i * 3 }));
}

// ── 쇼핑커넥트 카테고리별 평균 수수료 ──────────────────
const SHOPPING_CONNECT_RATES = {
  '패션의류': { rate: '10~15%', hotScore: 92 },
  '뷰티/화장품': { rate: '8~12%', hotScore: 90 },
  '생활건강': { rate: '5~10%', hotScore: 85 },
  '식품': { rate: '3~7%', hotScore: 80 },
  '가전디지털': { rate: '2~5%', hotScore: 72 },
  '스포츠/레저': { rate: '5~10%', hotScore: 78 },
  '유아동': { rate: '5~8%', hotScore: 75 },
  '반려동물': { rate: '5~10%', hotScore: 82 },
};

// ── 전략 추천 ────────────────────────────────────────────
function getStrategy(shoppingTrends) {
  const topKws = shoppingTrends.slice(0, 3).map(t => t.keyword).join(', ');
  return {
    primary: {
      name: '네이버 블로그 + 쇼핑커넥트',
      description: `네이버 블로그 포스팅에 쇼핑커넥트 링크 2~3개 자연 삽입. 검색 노출과 쇼핑 수익 동시 극대화.`,
      expectedCpm: '2만~15만원/월 (포스팅 수에 따라)',
      step: [
        '네이버 블로그 포스팅 → 쇼핑커넥트 스마트스토어 상품 링크 삽입',
        `지금 핫한 키워드: "${topKws}" 관련 포스팅 최우선`,
        '뷰티/패션/생활건강 카테고리 우선 (수수료 5~15%)',
        '쿠팡파트너스 보조 활용 (비네이버 트래픽용)',
      ],
    },
    secondary: {
      name: '쿠팡파트너스 + 텐핑 병행',
      description: '모든 블로그 플랫폼에서 쿠팡 링크 활용. 전환율 높고 배송 빠름.',
    },
  };
}

// ── 메인 수집 함수 ────────────────────────────────────────
async function crawlAffiliates() {
  console.log('[Affiliates] 제휴 데이터 수집 시작...');

  const shoppingTrends = await fetchNaverShoppingTrends().catch(() => getDefaultShoppingTrends());

  const result = {
    programs: PROGRAMS,
    shoppingConnect: {
      description: '네이버 스마트스토어 상품을 블로그에 연결해 수익을 얻는 네이버 공식 제휴 프로그램. 2024년 가장 핫한 블로그 수익화 수단.',
      categoryRates: SHOPPING_CONNECT_RATES,
      trendingKeywords: shoppingTrends,
      howTo: [
        '네이버 블로그 → 글쓰기 → 상품 링크 삽입',
        '스마트스토어 상품 검색 → 링크 삽입',
        '포스팅 공개 후 구매 발생 시 수수료 자동 적립',
      ],
    },
    strategy: getStrategy(shoppingTrends),
    topPrograms: PROGRAMS.filter(p => p.hotScore >= 90).sort((a, b) => b.hotScore - a.hotScore),
    fetchedAt: new Date().toISOString(),
  };

  console.log('[Affiliates] 수집 완료');
  return result;
}

module.exports = { crawlAffiliates };
