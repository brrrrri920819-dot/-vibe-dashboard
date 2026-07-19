/**
 * income/analyzer.js
 * 부업 트렌드 실시간 분석 + 일일 수익 리포트 AI 생성
 * 구글 트렌드·네이버·커뮤니티 크롤 → Claude 분석 → 블로그 포스팅
 */

const https = require('https');
const http  = require('http');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-5';

// ── HTTP 헬퍼 ────────────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
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

function callClaude(prompt, systemPrompt, maxTokens = 5000) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });
  return new Promise((resolve, reject) => {
    const req = https.request(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key':         process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type':      'application/json',
        'Content-Length':    Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          resolve(json.content?.[0]?.text || '');
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── 부업 기본 데이터 (한국 시장 실제 데이터 기반) ────────
const SIDE_HUSTLES = [
  {
    id: 'naver_blog',
    name: '네이버 블로그 + 쇼핑커넥트',
    category: '콘텐츠 수익',
    emoji: '✍️',
    monthlyMin: 30, monthlyMax: 300,
    startupCost: 0,
    timePerWeek: { min: 5, max: 15 },
    difficulty: 2,
    passive: true,
    mobile: true,
    baseHotScore: 98,
    pros: ['완전 무자본', '스마트폰만으로 가능', '쇼핑커넥트 2~15% 수수료', 'AI로 글 자동화'],
    platform: 'https://section.blog.naver.com',
    realData: '100포스팅 기준 월 50~150만원 (상위 20% 기준)',
    action: '네이버 블로그 개설 → AI 글 자동화 → 쇼핑커넥트 링크 삽입',
  },
  {
    id: 'ai_freelance',
    name: 'AI 활용 프리랜서 (번역·글쓰기·디자인)',
    category: '프리랜서',
    emoji: '🤖',
    monthlyMin: 30, monthlyMax: 200,
    startupCost: 0,
    timePerWeek: { min: 10, max: 30 },
    difficulty: 2,
    passive: false,
    mobile: false,
    baseHotScore: 93,
    pros: ['ChatGPT로 작업 5배 속도', '크몽·숨고 즉시 시작', '전문 스킬 불필요'],
    platform: 'https://kmong.com',
    realData: 'AI 번역 건당 1~3만원, 월 50~100건 처리 가능',
    action: '크몽 가입 → AI 번역·문서작성 서비스 등록 → 첫 클라이언트 확보',
  },
  {
    id: 'shorts',
    name: '유튜브 쇼츠 / 인스타 릴스',
    category: '숏폼 콘텐츠',
    emoji: '🎬',
    monthlyMin: 10, monthlyMax: 500,
    startupCost: 0,
    timePerWeek: { min: 5, max: 20 },
    difficulty: 3,
    passive: true,
    mobile: true,
    baseHotScore: 91,
    pros: ['스마트폰만 있으면 가능', '광고 + 제휴 수익 조합', 'AI 영상 편집 활용'],
    platform: 'https://youtube.com',
    realData: '구독자 1만 → 월 제휴 포함 30~80만원 (뷰티·맛집·리뷰 채널)',
    action: 'CapCut·클로바더빙으로 일 1편 → 30일 후 알고리즘 진입',
  },
  {
    id: 'smart_store',
    name: '스마트스토어 위탁판매',
    category: '이커머스',
    emoji: '🏪',
    monthlyMin: 50, monthlyMax: 300,
    startupCost: 0,
    timePerWeek: { min: 10, max: 25 },
    difficulty: 3,
    passive: false,
    mobile: false,
    baseHotScore: 84,
    pros: ['무재고 시작 가능', '네이버 쇼핑 검색 트래픽', '자동화 도구 다수'],
    platform: 'https://sell.smartstore.naver.com',
    realData: '월 매출 100~500만원, 순이익 20~30% / 사방넷 연동 시 운영 효율 3배',
    action: '스마트스토어 개설 → 사방넷 위탁상품 등록 → 네이버쇼핑 광고 최적화',
  },
  {
    id: 'ebook',
    name: '전자책 / AI 자동화 템플릿 판매',
    category: '디지털상품',
    emoji: '📚',
    monthlyMin: 10, monthlyMax: 200,
    startupCost: 0,
    timePerWeek: { min: 1, max: 3 },
    difficulty: 2,
    passive: true,
    mobile: false,
    baseHotScore: 80,
    pros: ['한 번 만들고 계속 판매', 'AI로 제작 가능', '크몽·노션 템플릿 마켓'],
    platform: 'https://kmong.com',
    realData: 'ChatGPT 활용법 전자책 1권 → 수강생 300명, 월 50~90만원',
    action: '미리캔버스로 전자책 제작 → 크몽 등록 → 블로그로 홍보',
  },
  {
    id: 'class101',
    name: '클래스101 / 탈잉 온라인 강의',
    category: '교육',
    emoji: '🎓',
    monthlyMin: 20, monthlyMax: 500,
    startupCost: 0,
    timePerWeek: { min: 1, max: 5 },
    difficulty: 3,
    passive: true,
    mobile: false,
    baseHotScore: 78,
    pros: ['패시브 인컴 최강', 'AI 강의 수요 폭발', '플랫폼 마케팅 지원'],
    platform: 'https://class101.net',
    realData: 'AI 노코드 강의 → 수강생 500명, 월 수익 150만원 (실제 크리에이터 사례)',
    action: 'Zoom으로 강의 녹화 → 클래스101 입점 → SNS 홍보',
  },
  {
    id: 'app_tech',
    name: '앱테크 + 리워드앱 조합',
    category: '앱 수익',
    emoji: '📱',
    monthlyMin: 3, monthlyMax: 20,
    startupCost: 0,
    timePerWeek: { min: 1, max: 3 },
    difficulty: 1,
    passive: true,
    mobile: true,
    baseHotScore: 68,
    pros: ['완전 무자본', '리스크 제로', '자동 적립 가능'],
    platform: 'https://toss.im',
    realData: '앱 7~10개 조합 시 월 5~12만원 자동 적립 (토스·캐시워크·머니트리 등)',
    action: '토스 걷기·캐시워크·머니트리·리워드앱 동시 설치 → 자동 적립',
  },
];

// ── 실시간 트렌드 크롤링 ──────────────────────────────────
async function fetchGoogleNewsForSideHustles() {
  const results = [];
  try {
    const res = await fetchUrl('https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR');
    const regex = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>|<title>([^<]+)<\/title>/g;
    let m; let i = 0;
    while ((m = regex.exec(res.body)) !== null && i < 30) {
      const kw = (m[1] || m[2] || '').trim();
      if (kw && !kw.toLowerCase().includes('google') && i > 0) {
        results.push(kw); i++;
      }
    }
  } catch {}
  return results;
}

async function fetchNaverBlogTrends() {
  const sideHustleKws = ['부업', 'AI 부업', '재택 부업', '스마트스토어', '블로그 수익', '쇼핑커넥트'];
  const results = [];
  try {
    const res = await fetchUrl('https://www.naver.com/');
    const kw = /"keyword":"([^"]{2,20})"/g;
    let m;
    while ((m = kw.exec(res.body)) !== null && results.length < 20) {
      results.push(m[1].trim());
    }
  } catch {}
  return results;
}

async function fetchCommunityBuzz() {
  // 뽐뿌·클리앙·인벤 부업 관련 인기글 키워드
  const communityHints = [];
  try {
    const ppom = await fetchUrl('https://www.ppomppu.co.kr/zboard/zboard.php?id=freeboard');
    const titles = ppom.body.match(/class="list[^"]*"[^>]*>([^<]{5,40})</g) || [];
    titles.forEach(t => {
      const clean = t.replace(/class="[^"]*"[^>]*>/, '').trim();
      if (clean.includes('부업') || clean.includes('수익') || clean.includes('돈버')) {
        communityHints.push(clean.slice(0, 30));
      }
    });
  } catch {}
  return communityHints.slice(0, 5);
}

// ── 트렌드 기반 HOT 스코어 계산 ─────────────────────────
async function rankHustles() {
  const [googleTrends, naverTrends, communityBuzz] = await Promise.allSettled([
    fetchGoogleNewsForSideHustles(),
    fetchNaverBlogTrends(),
    fetchCommunityBuzz(),
  ]);

  const allTrends = [
    ...(googleTrends.status === 'fulfilled' ? googleTrends.value : []),
    ...(naverTrends.status === 'fulfilled' ? naverTrends.value : []),
    ...(communityBuzz.status === 'fulfilled' ? communityBuzz.value : []),
  ].map(k => k.toLowerCase());

  const season = getSeason();

  return SIDE_HUSTLES.map(h => {
    let boost = 0;
    // 트렌드 키워드 매칭 보너스
    const matchKws = [h.name, h.category, h.id].join(' ').toLowerCase();
    allTrends.forEach(t => {
      if (matchKws.includes(t) || t.includes(h.id.split('_')[0])) boost += 5;
    });
    // 계절성 보너스
    if (season === 'summer' && h.mobile) boost += 3;
    if (h.passive) boost += 2;

    return {
      ...h,
      hotScore: Math.min(99, h.baseHotScore + boost),
      trendBoost: boost,
    };
  }).sort((a, b) => b.hotScore - a.hotScore);
}

function getSeason() {
  const m = new Date().getMonth() + 1;
  if (m >= 6 && m <= 8) return 'summer';
  if (m >= 12 || m <= 2) return 'winter';
  return 'spring_fall';
}

// ── Claude로 리포트 생성 ─────────────────────────────────
const REPORT_SYSTEM = `당신은 대한민국 최고의 경제 분석가이자 부업 전문 블로거입니다.
매일 실제 시장 데이터와 커뮤니티 트렌드를 분석해 현실적이고 실질적인 부업 정보를 제공합니다.

작성 원칙:
- 실제 수치와 구체적인 전략만 포함 (추상적 내용 절대 금지)
- 스캠·사기성 부업은 절대 포함하지 않음
- 모바일로 바로 시작할 수 있는 부업 우선 순위
- 초기 비용 최소화 관점에서 분석
- 한국 시장 특화 (네이버·쿠팡·카카오 생태계 고려)
- 2025~2026년 트렌드 반영 (AI 활용 부업 강조)
- 글 톤: 선배가 후배에게 솔직하게 알려주는 느낌으로 쓰되, 친근하고 실용적으로`;

async function generateDailyReport(rankedHustles) {
  const today = new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const top5  = rankedHustles.slice(0, 5);

  const hustleData = top5.map((h, i) => `
${i + 1}위: ${h.name} (HOT: ${h.hotScore}/100)
- 카테고리: ${h.category}
- 월 수익: ${h.monthlyMin}~${h.monthlyMax}만원
- 초기 비용: ${h.startupCost === 0 ? '무자본' : h.startupCost.toLocaleString() + '원'}
- 주간 시간 투자: ${h.timePerWeek.min}~${h.timePerWeek.max}시간
- 패시브 수입: ${h.passive ? '가능' : '불가'}
- 모바일 가능: ${h.mobile ? '예' : '부분 가능'}
- 실제 데이터: ${h.realData}
- 시작 방법: ${h.action}
`).join('\n');

  const prompt = `
오늘 날짜: ${today}

아래 분석 데이터를 바탕으로 오늘의 부업 인사이트 리포트 블로그 포스팅을 작성해주세요.

[오늘의 TOP 5 부업 데이터]
${hustleData}

요구사항:
1. 제목: 오늘 날짜 포함, 클릭율 높은 제목 (예: "2026년 7월 실전 부업 리포트: AI로 지금 당장 월 100만원 버는 법")
2. 본문: HTML 형식, 2000~2500자
   - 도입: 오늘 부업 시장 현황 (2~3문장, 공감 유발)
   - TOP 5 순위별 상세 분석: 각 부업마다
     * 수익 규모 강조 (구체적 수치)
     * 시작 방법 3단계
     * 현실적인 주의사항 1개
     * [IMAGE:관련 영어 키워드] 포함
   - 마무리: 지금 당장 시작할 수 있는 최우선 순위 추천
3. 태그: 8개 (부업, AI부업, 재택부업, 온라인부업, 스마트폰부업, 블로그수익, 투잡, 수익화)
4. 이미지 키워드: 영어로 4개

JSON 형식으로만 응답:
{
  "title": "제목",
  "content": "HTML 본문",
  "tags": ["태그1",...],
  "imageKeywords": ["keyword1","keyword2","keyword3","keyword4"],
  "summary": "50자 이내 오늘의 핵심 한줄 요약"
}`;

  const raw     = await callClaude(prompt, REPORT_SYSTEM, 5000);
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  const json    = JSON.parse(cleaned);

  if (!json.title || !json.content) throw new Error('리포트 생성 불완전');

  // 이미지 교체
  const imgKws = json.imageKeywords || ['side hustle income', 'mobile work', 'passive income', 'korean business'];
  let content  = json.content;
  let imgIdx   = 0;
  content = content.replace(/\[IMAGE:([^\]]*)\]/g, (_, kw) => {
    const keyword = kw || imgKws[imgIdx] || 'side hustle';
    imgIdx++;
    const sig = Math.floor(Math.random() * 9999);
    const url = `https://source.unsplash.com/1200x630/?${encodeURIComponent(keyword.replace(/\s+/g, ','))}&sig=${sig}`;
    return `<figure style="text-align:center;margin:28px 0"><img src="${url}" alt="${keyword}" style="max-width:100%;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.15)"><figcaption style="color:#888;font-size:13px;margin-top:8px">${keyword}</figcaption></figure>`;
  });

  console.log(`[Income] 리포트 생성: "${json.title}" | 요약: ${json.summary || ''}`);
  return {
    title:   json.title,
    content,
    tags:    json.tags || ['부업', 'AI부업', '재택부업'],
    summary: json.summary || '',
    rankedHustles: top5.map(h => ({
      name: h.name, category: h.category, emoji: h.emoji,
      monthlyMin: h.monthlyMin, monthlyMax: h.monthlyMax,
      hotScore: h.hotScore, passive: h.passive, mobile: h.mobile,
      difficulty: h.difficulty, realData: h.realData, platform: h.platform,
    })),
  };
}

// ── 메인 함수 ─────────────────────────────────────────────
async function generateIncomeReport() {
  console.log('[Income] 부업 트렌드 분석 시작...');
  const ranked = await rankHustles();
  const report = await generateDailyReport(ranked);
  console.log('[Income] 분석 완료');
  return report;
}

module.exports = { generateIncomeReport, SIDE_HUSTLES };
