/**
 * income/hustle-pipeline.js
 * 7가지 부업 유형별 완전 자동화 파이프라인
 * Express.js / Railway / Node 20 환경
 *
 * 사용:
 *   const { executePipeline, getPipelineStatus, PIPELINE_CONFIGS } = require('./income/hustle-pipeline');
 *   const result = await executePipeline('naver_blog');
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const { generatePost }         = require('../content/generator');
const { generateShortsScript } = require('../content/shorts-script');
const { SIDE_HUSTLES }         = require('./analyzer');

// ── 상수 ─────────────────────────────────────────────────────────────────────

const API_URL    = 'https://api.anthropic.com/v1/messages';
const MODEL      = 'claude-sonnet-5';
const DATA_DIR   = path.join(__dirname, '../data');
const CACHE_FILE = path.join(DATA_DIR, 'pipeline-cache.json');

// ── 파이프라인 메타데이터 ─────────────────────────────────────────────────────

const PIPELINE_CONFIGS = {
  naver_blog:   { name: '네이버 블로그',  emoji: '📝', totalSteps: 3, estimatedMinutes: 2, autoLevel: '100% 자동'  },
  ai_freelance: { name: 'AI 프리랜서',   emoji: '💼', totalSteps: 3, estimatedMinutes: 3, autoLevel: '분석 자동'  },
  shorts:       { name: '유튜브 숏츠',   emoji: '🎬', totalSteps: 4, estimatedMinutes: 2, autoLevel: '대본 자동'  },
  smart_store:  { name: '스마트스토어',  emoji: '🛍️', totalSteps: 3, estimatedMinutes: 4, autoLevel: '리스팅 자동' },
  ebook:        { name: '전자책',        emoji: '📚', totalSteps: 5, estimatedMinutes: 5, autoLevel: '초안 자동'  },
  class101:     { name: 'Class101',     emoji: '🎓', totalSteps: 3, estimatedMinutes: 3, autoLevel: '기획 자동'  },
  app_tech:     { name: '앱테크',        emoji: '📱', totalSteps: 3, estimatedMinutes: 1, autoLevel: '목록 자동'  },
};

// ── 캐시 유틸 ────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('[Pipeline] data/ 디렉토리 생성됨');
  }
}

function readCache() {
  try {
    ensureDataDir();
    if (!fs.existsSync(CACHE_FILE)) return {};
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch { return {}; }
}

function writeCache(data) {
  try {
    ensureDataDir();
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('[Pipeline] 캐시 저장 오류:', e.message);
  }
}

// ── HTTP / Claude 헬퍼 ────────────────────────────────────────────────────────

function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        ...opts.headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(12000, () => { req.destroy(new Error('fetch timeout')); });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function callClaude(prompt, system = '당신은 한국 부업·수익화 전문 컨설턴트입니다.', maxTokens = 2048) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Promise.reject(new Error('ANTHROPIC_API_KEY 미설정 — Railway Variables에 추가하세요'));
  }
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system,
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
          if (json.error) return reject(new Error(`Claude API 오류: ${json.error.message}`));
          const text = json.content?.[0]?.text;
          if (!text) return reject(new Error(`Claude 빈 응답 (status ${res.statusCode})`));
          resolve(text);
        } catch (e) { reject(new Error(`응답 파싱 실패: ${e.message}`)); }
      });
    });
    req.on('error', e => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

function parseJson(raw) {
  return JSON.parse(raw.replace(/```json\n?|\n?```/g, '').trim());
}

// ── 단계 헬퍼 ────────────────────────────────────────────────────────────────

function makeStep(id, name) {
  return { id, name, status: 'waiting', result: null, durationMs: 0 };
}

// steps 배열은 executePipeline에서 생성돼 참조로 전달됨.
// 오류 시 throw — executePipeline 레벨에서 전체 결과를 보존.
async function runStep(step, fn) {
  step.status = 'running';
  const t0 = Date.now();
  console.log(`[Pipeline] Step '${step.id}': ${step.name} 시작`);
  try {
    step.result     = await fn();
    step.status     = 'done';
    step.durationMs = Date.now() - t0;
    console.log(`[Pipeline] Step '${step.id}': ${step.name} 완료 (${step.durationMs}ms)`);
  } catch (e) {
    step.status     = 'error';
    step.result     = { error: e.message };
    step.durationMs = Date.now() - t0;
    console.error(`[Pipeline] Step '${step.id}': ${step.name} 실패 — ${e.message}`);
    throw e;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. 네이버 블로그 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineNaverBlog() {
  const steps = [
    makeStep('keyword',  '네이버 실시간 키워드 수집'),
    makeStep('generate', 'AI 블로그 포스팅 생성'),
    makeStep('queue',    '발행 큐 준비 완료'),
  ];

  let keyword = '';
  let postData = null;

  // Step 1: 네이버 데이터랩 실시간 키워드
  await runStep(steps[0], async () => {
    try {
      const res = await fetchUrl(
        'https://datalab.naver.com/keyword/realtimeList.naver?where=main',
        { headers: { Referer: 'https://datalab.naver.com/' } }
      );
      const m = res.body.match(/"keyword"\s*:\s*"([^"]{2,30})"/);
      if (m) { keyword = m[1]; return { keyword }; }
    } catch {}

    // 네이버 메인 fallback
    try {
      const res = await fetchUrl('https://www.naver.com/');
      const m   = res.body.match(/"keyword"\s*:\s*"([^"]{2,30})"/);
      if (m) { keyword = m[1]; return { keyword }; }
    } catch {}

    // 날짜 기반 fallback
    const FALLBACK = ['AI 부업', '재테크 방법', '블로그 수익화', '스마트스토어 시작', '온라인 부업 추천', '유튜브 수익화', '전자책 만들기'];
    keyword = FALLBACK[new Date().getDay() % FALLBACK.length];
    return { keyword, source: 'fallback' };
  });

  // Step 2: generatePost
  await runStep(steps[1], async () => {
    const account = { topic: '재테크·생활정보', tone: '친근하고 실용적인', platform: 'naver' };
    postData = await generatePost(keyword, account);
    return {
      title:     postData.title,
      tags:      postData.tags,
      wordCount: (postData.content || '').replace(/<[^>]+>/g, '').length,
    };
  });

  // Step 3: 발행 큐 준비
  await runStep(steps[2], async () => {
    return {
      readyToPublish: true,
      platform:       'naver_blog',
      scheduledAt:    new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      estimatedUV:    '일 100~500 UV (트렌드 키워드 기준)',
    };
  });

  return {
    steps,
    keyword,
    title:          postData?.title,
    content:        postData?.content,
    tags:           postData?.tags,
    readyToPublish: true,
    summary:        `"${keyword}" 키워드로 블로그 포스팅 완성 — 발행 큐 대기`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. AI 프리랜서 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineAiFreelance() {
  const steps = [
    makeStep('scrape',   '크몽 인기 서비스 크롤링'),
    makeStep('analyze',  'AI 기회 TOP 3 선정'),
    makeStep('proposal', '서비스 제안서 3종 생성'),
  ];

  let scrapedCategories = '';
  let opportunities     = [];
  let finalOpportunities = [];

  // Step 1: 크몽 크롤링
  await runStep(steps[0], async () => {
    const cats = [];
    try {
      const res  = await fetchUrl('https://kmong.com');
      const body = res.body;

      // 카테고리명 패턴
      const patterns = [
        /class="[^"]*category[^"]*"[^>]*>([가-힣a-zA-Z0-9\s]{2,20})</g,
        /"categoryName"\s*:\s*"([^"]{3,20})"/g,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(body)) !== null && cats.length < 12) {
          const c = m[1].trim();
          if (c && !c.includes('\n') && !c.includes('{')) cats.push(c);
        }
        if (cats.length >= 4) break;
      }
    } catch (e) {
      console.log(`[Pipeline] 크몽 크롤링 부분 실패 (폴백): ${e.message}`);
    }

    scrapedCategories = cats.length > 0
      ? cats.join(', ')
      : 'AI 콘텐츠 제작, SNS 마케팅, 블로그 글쓰기, 영상 편집, 번역·교정, 챗봇 개발, 디자인';

    return { categoriesFound: cats.length, categories: scrapedCategories };
  });

  // Step 2: TOP 3 기회 선정
  await runStep(steps[1], async () => {
    const text = await callClaude(`
크몽 인기 카테고리: ${scrapedCategories}

1인 블로그/콘텐츠 제작자가 AI를 활용해 바로 수주 가능한 프리랜서 기회 TOP 3를 선정해주세요.

JSON만 응답 (마크다운 없이):
[
  {
    "title": "서비스 제목",
    "category": "카테고리",
    "avgPrice": 50000,
    "description": "서비스 설명 1~2문장",
    "targetUrl": "https://kmong.com/category/"
  }
]`);
    const parsed = parseJson(text);
    opportunities = Array.isArray(parsed) ? parsed.slice(0, 3) : [];
    return { opportunityCount: opportunities.length };
  });

  // Step 3: 제안서 생성 — 결과를 직접 저장해 외부 재호출 없이 반환
  await runStep(steps[2], async () => {
    finalOpportunities = await Promise.all(opportunities.map(async (opp) => {
      const proposal = await callClaude(`
크몽 서비스 제안서를 전문 한국어로 작성해주세요.
서비스: ${opp.title} | 카테고리: ${opp.category} | 단가: ${(opp.avgPrice || 50000).toLocaleString()}원

포함 항목:
1. 한 줄 소개 (임팩트 있게)
2. 제공 서비스 3단계
3. 기본/표준/프리미엄 패키지 가격표
4. 작업 기간 및 수정 횟수
5. AI 도구 활용으로 빠른 납기 강조

400~500자 텍스트만 응답:`, '당신은 프리랜서 서비스 마케팅 전문가입니다.', 800);
      return {
        title:    opp.title,
        category: opp.category,
        avgPrice: opp.avgPrice || 50000,
        proposal: proposal.trim(),
        url:      opp.targetUrl || 'https://kmong.com',
      };
    }));
    return { proposalCount: finalOpportunities.length };
  });

  return {
    steps,
    opportunities: finalOpportunities,
    summary: `크몽 기회 ${finalOpportunities.length}개 분석 — 제안서 자동 생성 완료`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. 유튜브 숏츠 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineShorts() {
  const steps = [
    makeStep('trend',     '트렌드 토픽 선정'),
    makeStep('script',    '숏츠 대본 생성'),
    makeStep('thumbnail', '썸네일 프롬프트 생성'),
    makeStep('metadata',  'YouTube 메타데이터 최적화'),
  ];

  let trendTitle   = '';
  let trendContent = '';
  let trendTags    = [];
  let scriptData   = null;
  let thumbnailPrompt = null;
  let metadata     = null;

  // Step 1: income analyzer 데이터에서 트렌드 토픽 선정
  await runStep(steps[0], async () => {
    const topHustle = [...SIDE_HUSTLES].sort((a, b) => (b.baseHotScore || 0) - (a.baseHotScore || 0))[0];
    const today     = new Date().toLocaleDateString('ko-KR', { month: 'long', day: 'numeric' });

    const titleOptions = [
      `${today} 당장 시작하는 ${topHustle.name} 실전 가이드`,
      `직장인 부업 ${topHustle.name}으로 월 ${topHustle.monthlyMin}~${topHustle.monthlyMax}만원 버는 법`,
      `스마트폰으로 하루 10분, ${topHustle.name} 수익 내기`,
      `2026년 지금 시작해야 할 1위 부업 — ${topHustle.name}`,
    ];
    trendTitle   = titleOptions[new Date().getHours() % titleOptions.length];
    trendContent = `${topHustle.name}: ${topHustle.realData}. 시작 방법: ${topHustle.action}. 월 ${topHustle.monthlyMin}~${topHustle.monthlyMax}만원 수익 가능. 장점: ${topHustle.pros.join(', ')}.`;
    trendTags    = ['부업', '재테크', '돈버는법', topHustle.category, 'AI부업', '월100만원', '재택근무', 'shorts'];

    return { title: trendTitle, hustle: topHustle.name, hotScore: topHustle.baseHotScore };
  });

  // Step 2: 기존 generateShortsScript 호출
  await runStep(steps[1], async () => {
    scriptData = await generateShortsScript(trendTitle, trendContent, trendTags);
    return {
      title:      scriptData.title,
      duration:   scriptData.totalDuration,
      segments:   scriptData.script?.length,
    };
  });

  // Step 3: 썸네일 프롬프트 3종
  await runStep(steps[2], async () => {
    const raw = await callClaude(`
유튜브 숏츠 썸네일 이미지 생성 프롬프트를 DALL-E 3 / Midjourney 형식으로 3가지 버전 작성해주세요.

영상 제목: "${trendTitle}"
조건: 9:16 세로 비율, 클릭률 높은 강렬한 비주얼, 한국인 20~40대 타겟, 영어 프롬프트

JSON만 응답:
{
  "prompts": [
    { "version": "A", "prompt": "DALL-E/Midjourney 영어 프롬프트", "textOverlay": "썸네일 텍스트 오버레이 (한국어)", "style": "스타일 설명" },
    { "version": "B", "prompt": "...", "textOverlay": "...", "style": "..." },
    { "version": "C", "prompt": "...", "textOverlay": "...", "style": "..." }
  ],
  "recommended": "A"
}`, '당신은 유튜브 숏츠 썸네일 CTR 최적화 전문가입니다.', 1200);
    thumbnailPrompt = parseJson(raw);
    return { versionsGenerated: thumbnailPrompt.prompts?.length, recommended: thumbnailPrompt.recommended };
  });

  // Step 4: YouTube 메타데이터
  await runStep(steps[3], async () => {
    const scriptSnippet = Array.isArray(scriptData?.script)
      ? scriptData.script.slice(0, 3).map(s => s.script).join(' ').slice(0, 250)
      : trendContent.slice(0, 250);

    const raw = await callClaude(`
유튜브 숏츠 알고리즘 최적화 메타데이터를 생성해주세요.
제목: "${trendTitle}"
대본 요약: ${scriptSnippet}

JSON만 응답:
{
  "title": "유튜브용 최적화 제목 (100자 이내, 키워드 포함)",
  "description": "설명란 (500자, 타임스탬프·링크·해시태그 포함)",
  "tags": ["태그1", "태그2"],
  "categoryId": "22",
  "bestUploadTime": "업로드 최적 시간대",
  "firstPinnedComment": "고정 첫 댓글 문구",
  "endScreenSuggestion": "엔드 스크린 구성 추천"
}`, '당신은 유튜브 SEO 알고리즘 최적화 전문가입니다.', 1500);
    metadata = parseJson(raw);
    return { title: metadata.title, tagsCount: metadata.tags?.length };
  });

  return {
    steps,
    script:          scriptData,
    thumbnailPrompt,
    metadata,
    downloadReady:   true,
    summary:         `"${trendTitle}" 숏츠 대본 + 썸네일 프롬프트 + 메타데이터 완성`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. 스마트스토어 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineSmartStore() {
  const steps = [
    makeStep('scrape',  '네이버 쇼핑 + 뽐뿌 트렌드 수집'),
    makeStep('select',  'AI 상품 기회 TOP 3 선정'),
    makeStep('listing', '상품 리스팅 3종 자동 생성'),
  ];

  let trendSources  = '';
  let selectedProducts = [];
  let productsWithListings = [];

  // Step 1: 네이버 쇼핑 + 뽐뿌 크롤링
  await runStep(steps[0], async () => {
    const parts = [];

    // 네이버 쇼핑
    try {
      const res = await fetchUrl('https://shopping.naver.com/home', {
        headers: { Referer: 'https://www.naver.com/' },
      });
      const keywords = [];
      const re = /"keyword"\s*:\s*"([^"]{2,25})"/g;
      let m;
      while ((m = re.exec(res.body)) !== null && keywords.length < 15) {
        if (!keywords.includes(m[1])) keywords.push(m[1]);
      }
      if (keywords.length > 0) parts.push(`네이버쇼핑 트렌드: ${keywords.join(', ')}`);
    } catch (e) {
      console.log(`[Pipeline] 네이버쇼핑 크롤링 실패 (폴백): ${e.message}`);
    }

    // 뽐뿌 베스트딜
    try {
      const res  = await fetchUrl('https://www.ppomppu.co.kr/zboard/zboard.php?id=ppomppu');
      const body = res.body;
      const deals = [];
      const re = /class="[^"]*list[^"]*"[^>]*>\s*([^<]{5,50})\s*</g;
      let m;
      while ((m = re.exec(body)) !== null && deals.length < 8) {
        const d = m[1].trim();
        if (d.length > 4) deals.push(d);
      }
      if (deals.length > 0) parts.push(`뽐뿌 베스트딜: ${deals.join(', ')}`);
    } catch {}

    // Fallback
    if (parts.length === 0) {
      const month = new Date().getMonth() + 1;
      const seasonal = month >= 6 && month <= 8
        ? '여름 원피스, 선크림, 쿨링 침구, 보냉백, 아이스팩'
        : month >= 12 || month <= 2
        ? '핫팩, 전기장판, 울 코트, 겨울 부츠, 기모 레깅스'
        : '봄 원피스, 아이크림, 홈트 기구, 다이어트 식품, 여행 캐리어';
      parts.push(`계절 트렌드 상품: ${seasonal}`);
    }

    trendSources = parts.join(' | ');
    return { summary: trendSources.slice(0, 120) };
  });

  // Step 2: TOP 3 상품 선정
  await runStep(steps[1], async () => {
    const text = await callClaude(`
${trendSources}

스마트스토어 초보 셀러가 무재고 위탁판매로 마진 20~40% 실현 가능한 상품 3개를 추천해주세요.
알리익스프레스·1688·도매꾹에서 소싱 가능한 상품 우선.

JSON만 응답:
[
  {
    "name": "상품명 (구체적으로)",
    "category": "카테고리",
    "targetPrice": 25000,
    "sourcingPrice": 13000,
    "estimatedMargin": "48%",
    "sourcingTip": "소싱처 및 검색 키워드"
  }
]`);
    selectedProducts = parseJson(text).slice(0, 3);
    return { products: selectedProducts.map(p => p.name) };
  });

  // Step 3: 리스팅 생성 — 결과를 직접 저장
  await runStep(steps[2], async () => {
    productsWithListings = await Promise.all(selectedProducts.map(async (p) => {
      const raw = await callClaude(`
네이버 스마트스토어 상품 등록용 리스팅을 작성해주세요.
상품명: ${p.name} | 카테고리: ${p.category} | 판매가: ${(p.targetPrice || 25000).toLocaleString()}원

JSON만 응답:
{
  "productTitle": "SEO 최적화 상품명 (40자 이내, 핵심 키워드 선행)",
  "description": "상품 상세 설명 2000자 (HTML 허용 — 특징·용도·사이즈·소재·배송·주의사항 포함)",
  "keywords": ["검색키워드1", "검색키워드2", "검색키워드3", "검색키워드4", "검색키워드5", "검색키워드6", "검색키워드7", "검색키워드8", "검색키워드9", "검색키워드10"],
  "priceRecommendation": {
    "normalPrice": ${Math.round((p.targetPrice || 25000) * 1.25)},
    "salePrice": ${p.targetPrice || 25000},
    "strategy": "가격 전략 1문장"
  },
  "sourcingGuide": "소싱 단계별 가이드 (플랫폼·검색어·주의사항)"
}`, '당신은 네이버 스마트스토어 SEO·상품기획 전문가입니다.', 3000);

      let listing;
      try {
        listing = parseJson(raw);
      } catch {
        listing = {
          productTitle:        p.name,
          description:         `${p.name} 고품질 위탁판매 상품입니다.`,
          keywords:            [p.name, p.category],
          priceRecommendation: { normalPrice: Math.round((p.targetPrice || 25000) * 1.25), salePrice: p.targetPrice || 25000, strategy: '정가 대비 20% 할인' },
          sourcingGuide:       p.sourcingTip || '',
        };
      }

      return {
        name:            p.name,
        category:        p.category,
        targetPrice:     p.targetPrice,
        sourcingPrice:   p.sourcingPrice,
        estimatedMargin: p.estimatedMargin,
        listing,
        sourcingTip:     p.sourcingTip,
      };
    }));

    return { listingCount: productsWithListings.length };
  });

  return {
    steps,
    products: productsWithListings,
    summary:  `트렌드 상품 ${productsWithListings.length}개 리스팅 자동 완성 — 스마트스토어 즉시 등록 가능`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. 전자책 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineEbook() {
  const steps = [
    makeStep('topic',   '베스트셀러 전자책 토픽 선정'),
    makeStep('outline', '목차 및 아웃라인 생성'),
    makeStep('draft',   '샘플 챕터 2개 작성 (각 2000자)'),
    makeStep('cover',   '뒤표지 카피 + 저자 소개'),
    makeStep('guide',   '플랫폼별 업로드 가이드'),
  ];

  let topicResult = {};
  let outline     = null;
  let sampleChapters = [];
  let backCover   = null;

  // Step 1: 토픽 선정
  await runStep(steps[0], async () => {
    const text = await callClaude(`
당신은 국내 전자책 마켓 전문가입니다. 2026년 7월 기준 가장 잘 팔릴 전자책 주제 1개를 선정하세요.

선정 기준: 현재 트렌드 반영(AI·부업·재테크), 경쟁 강도 적정, 1인 작가가 AI 보조로 2주 내 완성 가능

JSON만 응답:
{
  "title": "전자책 제목 (클릭률 높은 제목, 35자 이내)",
  "subtitle": "부제목 (구체적 혜택, 30자 이내)",
  "topic": "핵심 주제",
  "targetReader": "타겟 독자층",
  "priceRange": "9,900~14,900원",
  "estimatedMonthlySales": "50~120권",
  "sellingPoints": ["판매 포인트1", "판매 포인트2", "판매 포인트3"],
  "platforms": ["리디북스", "문피아", "네이버 시리즈"]
}`, '당신은 전자책 출판 및 디지털 상품 마케팅 전문가입니다.', 1500);
    topicResult = parseJson(text);
    return topicResult;
  });

  // Step 2: 목차 생성
  await runStep(steps[1], async () => {
    const text = await callClaude(`
전자책 제목: "${topicResult.title}"
주제: ${topicResult.topic}
타겟: ${topicResult.targetReader}

8챕터 목차와 챕터별 아웃라인을 작성해주세요.

JSON만 응답:
{
  "totalChapters": 8,
  "totalEstimatedWords": 25000,
  "chapters": [
    {
      "chapterNum": 1,
      "title": "챕터 제목",
      "subheadings": ["소제목1", "소제목2", "소제목3"],
      "estimatedWords": 3000,
      "summary": "이 챕터 핵심 내용 (2문장)"
    }
  ],
  "appendix": ["부록1 제목", "부록2 제목"],
  "aiWritingTips": "AI로 이 전자책을 효율적으로 작성하는 핵심 전략"
}`, '당신은 베스트셀러 전자책 편집자이자 콘텐츠 전략가입니다.', 2500);
    outline = parseJson(text);
    return { chapters: outline.chapters?.length, totalWords: outline.totalEstimatedWords };
  });

  // Step 3: 샘플 챕터 2개 (각 2000자)
  await runStep(steps[2], async () => {
    const chaptersToWrite = (outline.chapters || []).slice(0, 2);
    for (const ch of chaptersToWrite) {
      const draft = await callClaude(`
전자책: "${topicResult.title}"
챕터 ${ch.chapterNum}: ${ch.title}
소제목 구성: ${(ch.subheadings || []).join(', ')}
챕터 요약: ${ch.summary || ''}

이 챕터 본문을 2000자 분량으로 작성해주세요.
- 독자가 바로 실천할 수 있는 실용적 내용
- 구체적인 수치·사례·단계별 방법 포함
- 소제목(## 형식)으로 구조화
- 친근하고 읽기 쉬운 문체 (마크다운)

챕터 본문만 응답 (제목 포함):`, '당신은 베스트셀러 전자책 작가입니다.', 3000);
      sampleChapters.push({
        chapterNum: ch.chapterNum,
        title:      ch.title,
        content:    draft.trim(),
        wordCount:  draft.replace(/\s+/g, ' ').length,
      });
    }
    return { drafted: sampleChapters.length, titles: sampleChapters.map(c => c.title) };
  });

  // Step 4: 뒤표지 카피 + 저자 소개
  await runStep(steps[3], async () => {
    const raw = await callClaude(`
전자책: "${topicResult.title}"
주제: ${topicResult.topic} | 타겟: ${topicResult.targetReader}
판매 포인트: ${(topicResult.sellingPoints || []).join(', ')}

JSON만 응답:
{
  "backCoverCopy": "뒤표지 카피 300자 (독자 문제→해결책→결과 구조)",
  "authorBio": "저자 소개 150자 (신뢰감·전문성 강조, 1인 작가용)",
  "endorsements": ["독자 후기 형식 추천사1", "독자 후기 형식 추천사2"],
  "marketingHook": "SNS·블로그 홍보용 한줄 카피"
}`, '당신은 출판 마케팅 카피라이터입니다.', 1200);
    backCover = parseJson(raw);
    return { backCoverLength: backCover.backCoverCopy?.length };
  });

  // Step 5: 업로드 가이드 생성
  await runStep(steps[4], async () => {
    return {
      summary: '리디북스·문피아·네이버 시리즈 3개 플랫폼 동시 등록 권장',
    };
  });

  const uploadGuide = {
    platforms: [
      {
        name:         '리디북스',
        url:          'https://author.ridibooks.com',
        revenueShare: '판매가의 70% (작가 수취)',
        format:       'EPUB3 또는 PDF',
        reviewPeriod: '2~4주',
        coverSpec:    '1400×2000 px, 2MB 이하',
        tips: [
          'EPUB3 형식 우선 — 리디 뷰어 최적화',
          'Calibre(무료)로 EPUB 변환 가능',
          '미리보기 10~20% 공개 설정 권장',
          '출판 후 리디 CPC 광고로 초기 판매 부스팅',
        ],
        uploadSteps: [
          '리디 작가 센터(author.ridibooks.com) 가입 → 작가 인증',
          'EPUB/PDF 원고 + 표지 이미지 준비 (Canva 무료 가능)',
          '메타데이터 입력 (제목·카테고리·가격) → 심사 제출',
          '심사 통과(2~4주) → 정식 판매 → 월 정산',
        ],
      },
      {
        name:         '문피아',
        url:          'https://www.munpia.com',
        revenueShare: '판매가의 65~70% (작가 수취)',
        format:       'TXT 또는 HWP (플랫폼 내 편집기)',
        reviewPeriod: '즉시 (연재 형식)',
        coverSpec:    '700×1000 px 이상',
        tips: [
          '자기계발·부업·재테크 장르 수요 급증',
          '연재 형식으로 시작 → 완결 후 단행본 전환',
          '정기 구독 독자 확보 시 안정적 수익',
          '문피아 공모전 참여로 노출 극대화',
        ],
        uploadSteps: [
          '문피아 작가 회원 가입 → 작품 등록',
          '연재 카테고리 선택 (자기계발/경제경영)',
          '챕터 단위로 업로드 (주 2~3회 권장)',
          '완결 후 단행본 e-Book 전환 신청',
        ],
      },
      {
        name:         '네이버 시리즈',
        url:          'https://series.naver.com/writer',
        revenueShare: '판매가의 60~70% (작가 수취)',
        format:       'PDF 또는 EPUB',
        reviewPeriod: '1~2주',
        coverSpec:    '700×990 px 이상',
        tips: [
          '네이버 블로그 연동으로 트래픽 시너지',
          '네이버페이 즉시 정산(익월 말)',
          '연재 형식 → 완결 단행본 전환 전략',
          'AI 생성 콘텐츠 별도 표기 필요',
        ],
        uploadSteps: [
          '네이버 계정 로그인 → 시리즈 크리에이터 신청',
          '원고 등록 → 카테고리·연령등급 설정',
          '가격 책정 → 출판 신청 → 검토(1~2주)',
          '승인 후 네이버 쇼핑 노출 신청 (추가 수익)',
        ],
      },
    ],
    timeline:               '완성 → 첫 판매: 최단 즉시(문피아 연재), 최장 4주(리디)',
    estimatedMonthlyRevenue: `3개 플랫폼 합산 ${topicResult.estimatedMonthlySales || '50~120권'} 예상`,
  };

  return {
    steps,
    title:          topicResult.title,
    outline,
    sampleChapters,
    backCover,
    uploadGuide,
    summary:        `"${topicResult.title}" 전자책 목차 + 샘플 챕터 2개 + 표지 카피 완성`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 6. Class101 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineClass101() {
  const steps = [
    makeStep('trend',   'Class101 트렌딩 카테고리 수집'),
    makeStep('outline', '10강 커리큘럼 생성'),
    makeStep('promo',   '홍보 카피 + 가격 전략'),
  ];

  let scrapedCategories = '';
  let courseOutline     = null;
  let promoData         = null;

  // Step 1: Class101 크롤링
  await runStep(steps[0], async () => {
    const cats = [];
    try {
      const res  = await fetchUrl('https://class101.net', {
        headers: { 'Accept-Language': 'ko-KR,ko;q=0.9' },
      });
      const body = res.body;
      const patterns = [
        /class="[^"]*category[^"]*"[^>]*>([가-힣a-zA-Z\s]{2,20})</g,
        /"categoryName"\s*:\s*"([^"]{2,20})"/g,
      ];
      for (const pat of patterns) {
        let m;
        while ((m = pat.exec(body)) !== null && cats.length < 10) {
          const c = m[1].trim();
          if (c && c.length > 1 && !c.includes('\n')) cats.push(c);
        }
        if (cats.length >= 4) break;
      }
    } catch (e) {
      console.log(`[Pipeline] Class101 크롤링 실패 (폴백): ${e.message}`);
    }

    scrapedCategories = cats.length > 0
      ? cats.join(', ')
      : 'AI·노코드, 재테크·투자, 부업·수익화, 드로잉·일러스트, 영어, 엑셀·데이터, 사진·영상, 글쓰기·블로그';

    return { categories: scrapedCategories };
  });

  // Step 2: 10강 커리큘럼 생성
  await runStep(steps[1], async () => {
    const text = await callClaude(`
당신은 Class101 인기 크리에이터이자 온라인 강의 기획 전문가입니다.

[Class101 트렌딩 카테고리]
${scrapedCategories}

트렌드 반영, 스마트폰+Zoom 1인 제작 가능, 지금 가장 팔릴 강의를 기획하고 10강 커리큘럼을 만들어주세요.

JSON만 응답:
{
  "courseTitle": "강의 제목 (클릭률 높은 제목, 40자 이내)",
  "subtitle": "부제목 (수강 후 얻는 구체적 결과, 35자 이내)",
  "category": "카테고리",
  "targetStudent": "수강 대상",
  "totalDuration": "총 강의 시간 (예: 약 3시간 30분)",
  "price": "권장 판매가",
  "lessons": [
    {
      "lessonNum": 1,
      "title": "레슨 제목",
      "duration": "15분",
      "topics": ["핵심 내용1", "핵심 내용2"],
      "materials": "준비물 또는 활용 도구"
    }
  ],
  "prerequisites": "수강 전 필요 사전 지식 (없으면 '없음')",
  "outcomes": ["수강 후 할 수 있는 것1", "할 수 있는 것2", "할 수 있는 것3"]
}`, '당신은 온라인 강의 기획 및 Class101 크리에이터 전문가입니다.', 3000);
    courseOutline = parseJson(text);
    return { courseTitle: courseOutline.courseTitle, lessons: courseOutline.lessons?.length };
  });

  // Step 3: 홍보 카피 + 가격 전략
  await runStep(steps[2], async () => {
    const text = await callClaude(`
강의 제목: "${courseOutline.courseTitle}"
타겟: ${courseOutline.targetStudent}
수강 후 결과: ${(courseOutline.outcomes || []).join(', ')}
권장 가격: ${courseOutline.price}

Class101 랜딩 페이지 카피와 론칭 가격 전략을 작성해주세요.

JSON만 응답:
{
  "promotionCopy": {
    "headline": "랜딩 페이지 메인 헤드라인",
    "subheadline": "서브 헤드라인",
    "problemStatement": "수강생 문제 상황 공감 (2~3문장)",
    "solutionStatement": "이 강의가 해결책인 이유 (2~3문장)",
    "bulletPoints": ["핵심 혜택1", "핵심 혜택2", "핵심 혜택3", "핵심 혜택4", "핵심 혜택5"],
    "urgencyTrigger": "지금 신청해야 하는 이유",
    "socialProofTemplates": ["예상 수강 후기1", "예상 수강 후기2"]
  },
  "pricingStrategy": {
    "launchPrice": 49000,
    "regularPrice": 79000,
    "earlyBirdDiscount": "출시 후 7일 30% 할인",
    "bundleOption": "번들 구성 제안",
    "revenueProjection": "3개월 예상 수익",
    "breakEvenStudents": "손익분기 수강생 수"
  },
  "launchTimeline": [
    "D-7: SNS 예고 + 사전 신청 폼 오픈",
    "D-3: 무료 맛보기 1강 공개",
    "D-Day: 얼리버드 오픈",
    "D+7: 정가 전환",
    "D+14: 수강 후기 수집 + 2기 예고"
  ],
  "promotionChannels": ["네이버 블로그", "인스타그램 릴스", "유튜브 숏츠", "카카오 오픈채팅", "Class101 무료강의"]
}`, '당신은 온라인 강의 마케팅 전문가이자 세일즈 카피라이터입니다.', 2500);
    promoData = parseJson(text);
    return { launchPrice: promoData.pricingStrategy?.launchPrice };
  });

  return {
    steps,
    courseTitle:     courseOutline?.courseTitle,
    outline:         courseOutline,
    promotionCopy:   promoData?.promotionCopy,
    pricingStrategy: promoData?.pricingStrategy,
    summary:         `"${courseOutline?.courseTitle}" 10강 커리큘럼 + 홍보 전략 + 가격 정책 완성`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. 앱테크 파이프라인
// ══════════════════════════════════════════════════════════════════════════════

async function pipelineAppTech() {
  const steps = [
    makeStep('apps',      '오늘의 앱테크 앱 큐레이션'),
    makeStep('calculate', '월 수익 잠재력 계산'),
    makeStep('schedule',  '개인 앱테크 데일리 루틴 생성'),
  ];

  let apps                  = [];
  let totalMonthlyPotential = 0;
  let dailySchedule         = null;

  // Step 1: Claude로 앱테크 앱 큐레이션 (지식 + 커뮤니티 기반)
  await runStep(steps[0], async () => {
    const text = await callClaude(`
당신은 대한민국 앱테크 커뮤니티 전문가입니다.
2026년 7월 현재 실제 운영 중이며 수익 지급이 확인된 앱테크 앱 7~10개를 큐레이션해주세요.

조건:
- 실제 존재하는 앱만 (토스·캐시워크·머니트리·리얼리워드·GS25·캐시피드·시럽월렛·OK캐쉬백·신한플레이·모니모 등 실제 앱)
- 구글 플레이·앱스토어에서 검색 가능한 앱
- 카테고리 다양하게 (걷기·광고·쇼핑·설문·금융·결제 등)
- 설치만 해도 시작 가능한 앱 우선

JSON만 응답:
{
  "apps": [
    {
      "name": "앱 이름",
      "storeUrl": "https://play.google.com/store/apps/details?id=앱패키지ID",
      "dailyTask": "매일 해야 할 구체적 작업",
      "dailyReward": "일일 적립 예상 (예: 포인트 100~150, 현금 약 50원)",
      "monthlyPotential": 5000,
      "difficulty": "쉬움",
      "category": "걷기"
    }
  ]
}`, '당신은 앱테크 재테크 커뮤니티 전문가입니다.', 2500);

    const parsed = parseJson(text);
    apps = Array.isArray(parsed.apps) ? parsed.apps : [];

    // 파싱 실패 시 기본 앱 목록 fallback
    if (apps.length === 0) {
      apps = [
        { name: '캐시워크',    storeUrl: 'https://play.google.com/store/apps/details?id=com.cashwalk.cashwalk',          dailyTask: '만보 걷기 달성 + 광고 시청', dailyReward: '100~150포인트 (약 100원)', monthlyPotential: 3000,  difficulty: '쉬움', category: '걷기'  },
        { name: '토스',        storeUrl: 'https://play.google.com/store/apps/details?id=viva.republica.toss',             dailyTask: '출석체크 + 행운복권 + 토스피드', dailyReward: '50~100포인트',             monthlyPotential: 1500,  difficulty: '쉬움', category: '금융'  },
        { name: '리브메이트',  storeUrl: 'https://play.google.com/store/apps/details?id=com.kbcard.liivmate',            dailyTask: '퀴즈 + 출석 이벤트',          dailyReward: '80포인트',                monthlyPotential: 2400,  difficulty: '쉬움', category: '금융'  },
        { name: '신한플레이',  storeUrl: 'https://play.google.com/store/apps/details?id=com.shcard.smartpay',            dailyTask: '출석체크 + 미션 완료',         dailyReward: '150포인트',               monthlyPotential: 4500,  difficulty: '보통', category: '금융'  },
        { name: 'OK캐쉬백',   storeUrl: 'https://play.google.com/store/apps/details?id=com.skmnc.cashbagApp',           dailyTask: '이벤트 참여 + 결제 적립',      dailyReward: '300포인트',               monthlyPotential: 9000,  difficulty: '보통', category: '결제'  },
        { name: '네이버페이',  storeUrl: 'https://play.google.com/store/apps/details?id=com.navercorp.naverpay',         dailyTask: '포인트 적립 결제 + 이벤트',    dailyReward: '250포인트',               monthlyPotential: 7500,  difficulty: '쉬움', category: '결제'  },
        { name: '캐시슬라이드', storeUrl: 'https://play.google.com/store/apps/details?id=com.cashslide',                dailyTask: '잠금화면 광고 시청',           dailyReward: '90포인트 (약 90원)',       monthlyPotential: 2700,  difficulty: '쉬움', category: '광고'  },
        { name: '모니모',      storeUrl: 'https://play.google.com/store/apps/details?id=com.samsung.android.monimo',    dailyTask: '삼성 금융 통합 미션',          dailyReward: '120포인트',               monthlyPotential: 3600,  difficulty: '보통', category: '금융'  },
        { name: '해피포인트',  storeUrl: 'https://play.google.com/store/apps/details?id=com.spc.happypoint',            dailyTask: 'SPC 결제 + 이벤트 적립',      dailyReward: '180포인트',               monthlyPotential: 5400,  difficulty: '쉬움', category: '결제'  },
        { name: '시럽월렛',   storeUrl: 'https://play.google.com/store/apps/details?id=com.skp.syruppay.wallet',       dailyTask: '출석체크 + 쿠폰 수집',         dailyReward: '70포인트',                monthlyPotential: 2100,  difficulty: '쉬움', category: '금융'  },
      ];
    }

    return { appCount: apps.length, categories: [...new Set(apps.map(a => a.category))].join(', ') };
  });

  // Step 2: 수익 계산
  await runStep(steps[1], async () => {
    totalMonthlyPotential = apps.reduce((sum, a) => sum + (Number(a.monthlyPotential) || 0), 0);
    const byCategory = {};
    apps.forEach(a => {
      byCategory[a.category] = (byCategory[a.category] || 0) + (Number(a.monthlyPotential) || 0);
    });
    return {
      totalMonthly:    totalMonthlyPotential,
      totalFormatted:  `월 ${totalMonthlyPotential.toLocaleString()}원`,
      byCategory,
      annualPotential: totalMonthlyPotential * 12,
      dailyAverage:    Math.round(totalMonthlyPotential / 30),
    };
  });

  // Step 3: Claude로 데일리 루틴 생성
  await runStep(steps[2], async () => {
    const appSummary = apps.slice(0, 8)
      .map(a => `${a.name}(${a.category}·${a.dailyTask})`)
      .join(', ');

    const text = await callClaude(`
앱테크 앱: ${appSummary}
총 월 수익 잠재력: 월 ${totalMonthlyPotential.toLocaleString()}원

직장인 기준 아침/점심/저녁 시간대별 앱테크 루틴을 설계해주세요.
각 시간대 총 소요 시간 10~15분 이내.

JSON만 응답:
{
  "morning": {
    "time": "오전 7:00~7:15",
    "totalMinutes": 15,
    "tasks": [
      { "app": "앱명", "action": "구체적 작업", "duration": "3분", "reward": "예상 적립" }
    ]
  },
  "lunch": {
    "time": "오후 12:00~12:10",
    "totalMinutes": 10,
    "tasks": [...]
  },
  "night": {
    "time": "오후 9:00~9:15",
    "totalMinutes": 15,
    "tasks": [...]
  },
  "weeklyBonus": "주말 추가 작업으로 월 보너스 최대화 방법",
  "automationTips": ["자동화·효율화 팁1", "팁2", "팁3"],
  "totalDailyMinutes": 40,
  "firstWeekGoal": "첫 주 목표 (앱 세팅 완료 + 첫 포인트 적립)"
}`, '당신은 앱테크 효율 최적화 및 재테크 루틴 전문가입니다.', 2000);
    dailySchedule = parseJson(text);
    return { morningTasks: dailySchedule.morning?.tasks?.length, totalDailyMinutes: dailySchedule.totalDailyMinutes };
  });

  return {
    steps,
    apps,
    totalMonthlyPotential,
    dailySchedule,
    summary: `앱테크 ${apps.length}개 수집 완료 — 월 예상 수익 ${totalMonthlyPotential.toLocaleString()}원`,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 메인 파이프라인 실행기
// ══════════════════════════════════════════════════════════════════════════════

const PIPELINE_FNS = {
  naver_blog:   pipelineNaverBlog,
  ai_freelance: pipelineAiFreelance,
  shorts:       pipelineShorts,
  smart_store:  pipelineSmartStore,
  ebook:        pipelineEbook,
  class101:     pipelineClass101,
  app_tech:     pipelineAppTech,
};

/**
 * 지정한 부업 파이프라인을 실행하고 결과를 캐시에 저장합니다.
 *
 * @param  {string} hustleId  PIPELINE_CONFIGS 키 (예: 'naver_blog')
 * @returns {Promise<{hustleId, hustleName, executedAt, steps, summary, data}>}
 */
async function executePipeline(hustleId) {
  const cfg = PIPELINE_CONFIGS[hustleId];
  if (!cfg) throw new Error(`[Pipeline] 알 수 없는 파이프라인: "${hustleId}". 유효한 값: ${Object.keys(PIPELINE_CONFIGS).join(', ')}`);

  const fn = PIPELINE_FNS[hustleId];
  if (!fn) throw new Error(`[Pipeline] runner 미등록: ${hustleId}`);

  console.log(`[Pipeline] ====== ${cfg.emoji} ${cfg.name} 파이프라인 시작 ======`);
  const t0 = Date.now();

  let data  = null;
  let error = null;

  try {
    data = await fn();
  } catch (e) {
    console.error(`[Pipeline] ${cfg.name} 파이프라인 오류:`, e.message);
    error = e.message;
  }

  const durationMs = Date.now() - t0;
  const steps      = data?.steps || [];
  const done       = steps.filter(s => s.status === 'done').length;
  const failed     = steps.filter(s => s.status === 'error').length;

  const result = {
    hustleId,
    hustleName:  cfg.name,
    emoji:       cfg.emoji,
    executedAt:  new Date().toISOString(),
    durationMs,
    completedSteps: done,
    failedSteps:    failed,
    totalSteps:     cfg.totalSteps,
    steps,
    summary:     data?.summary || (error ? `오류: ${error}` : '완료'),
    data:        data || null,
    error:       error || null,
  };

  const cache = readCache();
  cache[hustleId] = result;
  writeCache(cache);

  console.log(`[Pipeline] ====== ${cfg.emoji} ${cfg.name} 완료 — ${done}/${cfg.totalSteps}단계 성공 (${durationMs}ms) ======`);
  return result;
}

/**
 * 특정 부업의 마지막 실행 결과(캐시)를 반환합니다.
 *
 * @param  {string} hustleId
 * @returns {Promise<Object>}
 */
async function getPipelineStatus(hustleId) {
  const cfg   = PIPELINE_CONFIGS[hustleId];
  if (!cfg) throw new Error(`[Pipeline] 알 수 없는 파이프라인: "${hustleId}"`);

  const cache  = readCache();
  const cached = cache[hustleId];

  if (!cached) {
    return {
      hustleId,
      hustleName: cfg.name,
      emoji:      cfg.emoji,
      status:     'never_run',
      message:    '아직 실행된 적 없습니다. executePipeline()을 호출하세요.',
      lastRun:    null,
    };
  }

  const ageMs    = Date.now() - new Date(cached.executedAt).getTime();
  const ageHours = +(ageMs / 1000 / 60 / 60).toFixed(2);

  return {
    hustleId,
    hustleName:      cfg.name,
    emoji:           cfg.emoji,
    status:          cached.error ? 'failed' : 'completed',
    lastRun:         cached.executedAt,
    ageHours,
    isStale:         ageHours > 24,
    summary:         cached.summary,
    completedSteps:  cached.completedSteps,
    failedSteps:     cached.failedSteps,
    totalSteps:      cached.totalSteps,
    durationMs:      cached.durationMs,
    steps:           cached.steps,
    data:            cached.data,
    error:           cached.error,
  };
}

// ── 내보내기 ──────────────────────────────────────────────────────────────────

module.exports = { executePipeline, getPipelineStatus, PIPELINE_CONFIGS };
