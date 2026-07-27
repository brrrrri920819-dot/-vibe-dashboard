/**
 * content/generator.js
 * 수익형 블로그 글 자동 생성 — AI 티 최소화, SEO 최적화
 */

const https = require('https');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-5';

const CLAUDE_TIMEOUT_MS = 100000; // 100초 — Claude API 최대 대기

function callClaude(prompt, systemPrompt, maxTokens = 4096) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Promise.reject(new Error('ANTHROPIC_API_KEY 미설정 — Railway Variables에 추가하세요'));
  }

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; clearTimeout(wallTimer); fn(val); } };

    // 벽시계 타임아웃 (req.setTimeout은 소켓 비활성 타임아웃이라 응답 대기 중엔 작동 안 함)
    const wallTimer = setTimeout(() => {
      req.destroy();
      done(reject, new Error(`Claude API 응답 시간 초과 (${CLAUDE_TIMEOUT_MS / 1000}초)`));
    }, CLAUDE_TIMEOUT_MS);

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
        console.log(`[Claude] HTTP ${res.statusCode}, body length: ${data.length}`);
        try {
          const json = JSON.parse(data);
          if (json.error) return done(reject, new Error(`Claude API 오류: ${json.error.type} — ${json.error.message}`));
          if (json.stop_reason === 'max_tokens') return done(reject, new Error('응답이 너무 길어 잘렸습니다 (max_tokens 초과)'));
          const textBlock = json.content?.find(b => b.type === 'text');
          const text = textBlock?.text;
          if (!text) {
            console.error('[Claude] 빈 응답 원본:', data.slice(0, 500));
            return done(reject, new Error(`Claude 빈 응답 — stop_reason: ${json.stop_reason}`));
          }
          done(resolve, text);
        } catch (e) {
          console.error('[Claude] 파싱 실패 원본:', data.slice(0, 500));
          done(reject, new Error(`응답 파싱 실패: ${e.message} | 원본: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', e => done(reject, new Error(`네트워크 오류: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// JSON GET 헬퍼 (10초 타임아웃)
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'vibe-dashboard/1.0' } }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// 키워드에 맞는 사진 URL 가져오기 — Pixabay → Openverse(키 불필요) → picsum 폴백
async function fetchImageUrl(keyword, index) {
  const clean = keyword.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'business';

  // 1순위: Pixabay (PIXABAY_API_KEY 있을 때 — 품질 가장 좋음)
  const apiKey = process.env.PIXABAY_API_KEY;
  if (apiKey) {
    try {
      const url = `https://pixabay.com/api/?key=${apiKey}&q=${encodeURIComponent(clean)}&image_type=photo&orientation=horizontal&per_page=20&safesearch=true&min_width=800&order=popular`;
      const json = await getJson(url);
      const hits = json.hits || [];
      if (hits.length > 0) {
        const pick = hits[index % hits.length];
        console.log(`[Image] Pixabay "${clean}" → ${hits.length}건`);
        return pick.largeImageURL || pick.webformatURL;
      }
      console.warn(`[Image] Pixabay "${clean}" 결과 없음`);
    } catch (e) {
      console.warn(`[Image] Pixabay 실패 (${clean}):`, e.message);
    }
  }

  // 2순위: Openverse — API 키 불필요, CC 라이선스 실사진
  try {
    const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(clean)}&page_size=20&license_type=commercial&mature=false`;
    const json = await getJson(url);
    const items = (json.results || []).filter(r => r.url);
    if (items.length > 0) {
      const pick = items[index % items.length];
      console.log(`[Image] Openverse "${clean}" → ${items.length}건`);
      return pick.url;
    }
    console.warn(`[Image] Openverse "${clean}" 결과 없음`);
  } catch (e) {
    console.warn(`[Image] Openverse 실패 (${clean}):`, e.message);
  }

  // 최종 폴백: picsum (주제 무관 — 여기까지 오면 키워드 검색이 다 실패한 것)
  console.warn(`[Image] "${clean}" — 검색 전부 실패, 랜덤 사진 사용`);
  const seed = clean.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + index * 97;
  return `https://picsum.photos/seed/${seed % 9999}/1200/630`;
}

// 이미지 HTML 태그 생성 (URL 직접 받음)
function imageTag(url, alt) {
  return `<figure style="text-align:center;margin:28px 0"><img src="${url}" alt="${alt}" loading="lazy" style="max-width:100%;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.12)"><figcaption style="color:#888;font-size:13px;margin-top:8px">${alt}</figcaption></figure>`;
}

const SYSTEM_PROMPT = `당신은 대한민국 MZ세대가 즐겨 보는 정보성 블로그를 운영하는 20-30대 여성입니다.

글쓰기 스타일:
- 친구에게 카톡으로 얘기하듯 자연스러운 구어체
- "저도 처음엔 몰랐는데요~", "근데 진짜로", "솔직히 말하면" 같은 표현 자연스럽게 사용
- 가끔 오타나 줄임말 섞기 ("ㅎㅎ", "ㅠㅠ", "진짜루", "대박이더라고요")
- 개인 경험담처럼 서술 ("제가 직접 써봤는데", "친구한테 물어보니까")
- AI가 절대 쓰지 않는 한국어 표현들: "이게 뭐야 싶었는데", "알고보니", "완전 꿀팁"
- 완벽하게 구조화된 글 금지 — 약간 산만하고 자연스럽게
- 이모지는 2~4개만, 제목 말고 본문 중간에 자연스럽게

SEO 전략:
- 키워드를 첫 문단과 소제목에 자연스럽게 포함
- 롱테일 키워드 변형 3~5회 사용
- 1500~2000자 분량 (정보 충실도 높게)
- 독자가 끝까지 읽도록 궁금증 유발 구조`;

async function generatePost(keyword, account) {
  const { topic = '라이프스타일', tone = '친근한', platform = 'blogger' } = account;

  const prompt = `
트렌딩 키워드: "${keyword}"
블로그 주제: ${topic}
글 톤: ${tone}
플랫폼: ${platform}

이 키워드로 수익형 블로그 포스팅을 작성해주세요.

요구사항:
1. 제목: 실제로 클릭하고 싶은 제목 (숫자/후기/비교/놀라운 사실 활용)
2. 본문: HTML 형식, 1800~2200자
   - 첫 문단: 공감 or 충격 사실로 시작 (독자를 잡아당겨야 함)
   - 소제목 3개 (h3 태그)로 구성 — 각 섹션마다 실용 정보
   - 이미지 플레이스홀더 3~4곳에 [IMAGE:영어키워드] 형식으로 각 섹션 사이에 배치
   - 중간: 개인 경험담, 꿀팁, 비교 정보 섞기
   - 마지막: 핵심 요약 + 댓글 유도
3. 태그: 검색량 높은 태그 8개
4. 이미지 키워드: 영어로 4개 — 각 섹션 내용을 가장 잘 표현하는 사진이 나올 구체적 명사+형용사 조합
   (예: "korean street food market", "woman using smartphone cafe", "stock market graph decline")
   절대 추상적인 단어 금지 (예: "technology", "lifestyle" 단독 사용 금지)

JSON 형식으로만 응답:
{
  "title": "제목",
  "content": "HTML 본문 ([IMAGE:영어키워드] 3~4개 포함)",
  "tags": ["태그1", ..., "태그8"],
  "imageKeywords": ["english keyword 1", "english keyword 2", "english keyword 3", "english keyword 4"]
}`;

  let json;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw     = await callClaude(prompt, SYSTEM_PROMPT, 4096);
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch (e) {
      if (attempt === 2) throw new Error(`JSON 파싱 실패: ${e.message}`);
      console.warn('[Generator] JSON 파싱 실패, 재시도 중...');
      continue;
    }
    if (parsed.title && parsed.content) { json = parsed; break; }
    if (attempt === 2) throw new Error('글 생성 결과 불완전 (제목/본문 누락)');
    console.warn('[Generator] JSON 불완전, 재시도 중...');
  }

  // 이미지 플레이스홀더 수집
  let content = json.content;
  const imgKeywords = json.imageKeywords || [keyword, topic];
  const placeholders = [];
  content.replace(/\[IMAGE:([^\]]+)\]/g, (_, kw) => { placeholders.push(kw || keyword); });

  // 플레이스홀더가 없으면 imageKeywords 사용
  if (placeholders.length === 0 && imgKeywords.length > 0) {
    placeholders.push(...imgKeywords.slice(0, 3));
  }

  // 이미지 URL 병렬 가져오기 (Pixabay → picsum 폴백)
  const imageUrls = await Promise.all(placeholders.map((kw, i) => fetchImageUrl(kw, i)));
  console.log(`[Generator] 이미지 ${imageUrls.length}개 준비 완료`);

  // 플레이스홀더 교체
  let urlIdx = 0;
  content = content.replace(/\[IMAGE:([^\]]+)\]/g, (_, kw) => {
    const url = imageUrls[urlIdx++] || imageUrls[0];
    return imageTag(url, kw);
  });

  // 플레이스홀더가 없었으면 본문 중간에 삽입
  if (urlIdx === 0 && imageUrls.length > 0) {
    const mid = content.indexOf('</p>', Math.floor(content.length * 0.4));
    if (mid !== -1) {
      content = content.slice(0, mid + 4) + imageTag(imageUrls[0], imgKeywords[0] || keyword) + content.slice(mid + 4);
    }
  }

  console.log(`[Generator] 생성 완료: "${json.title}" (이미지 ${urlIdx}개)`);
  return { title: json.title, content, tags: json.tags || [keyword] };
}

module.exports = { generatePost };
