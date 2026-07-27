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

// JSON GET 헬퍼 (10초 타임아웃, 헤더 지정 가능)
function getJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'vibe-dashboard/1.0', ...headers } }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 120)}`));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(`파싱 실패: ${d.slice(0, 120)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/* ── 이미지 소스 정책 ────────────────────────────────────────
 * 발행된 글은 외부 도메인(blogspot/tistory/naver)에서 이미지를 불러오므로
 * "핫링크 허용" 소스만 써야 한다. 핫링크를 막는 곳(Pixabay 등)의 URL을 넣으면
 * 발행 직후 403으로 사진이 깨진다.
 *   Unsplash  — 핫링크가 필수 요건 (API 가이드라인). 최우선.
 *   Openverse — 키 불필요. Flickr/Wikimedia 등 핫링크 가능한 원본만 골라 사용.
 *   Wikimedia — 핫링크 허용. 인물·지명·사건 등 고유명사에 강함.
 *   picsum    — 주제 무관 랜덤. 위가 전부 실패했을 때만.
 * ──────────────────────────────────────────────────────── */

// 핫링크가 가능한 호스트만 통과
const HOTLINK_SAFE = /(^|\.)(staticflickr\.com|upload\.wikimedia\.org|images\.unsplash\.com|live\.staticflickr\.com|nasa\.gov|si\.edu)$/i;
function isHotlinkSafe(url) {
  try { return HOTLINK_SAFE.test(new URL(url).hostname); } catch { return false; }
}

// 1순위: Unsplash (UNSPLASH_ACCESS_KEY 필요 — 무료, 핫링크 필수 정책)
// 긴 키워드는 결과가 0건 나오기 쉬워서, 점점 줄여가며 재시도한다.
// (여기서 못 찾으면 품질 낮은 소스로 떨어지므로 히트율이 곧 사진 품질)
function broadenQueries(q) {
  const words = q.split(' ').filter(Boolean);
  const tries = [q];
  if (words.length > 2) tries.push(words.slice(0, 2).join(' '));
  if (words.length > 1) tries.push(words[words.length - 1]); // 핵심 명사는 보통 뒤쪽
  return [...new Set(tries)];
}

async function searchUnsplash(q, index) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;

  for (const term of broadenQueries(q)) {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(term)}&per_page=20&orientation=landscape&content_filter=high`;
    const json = await getJson(url, { Authorization: `Client-ID ${key}` });
    const items = (json.results || []).filter(r => r.urls && r.urls.regular);
    if (items.length) {
      const p = items[index % items.length];
      if (term !== q) console.log(`[Image] Unsplash 키워드 완화: "${q}" → "${term}"`);
      return {
        url: p.urls.regular,
        credit: p.user && p.user.name ? `Photo by ${p.user.name} on Unsplash` : '',
        source: 'Unsplash',
      };
    }
  }
  return null;
}

// 2순위: Openverse (키 불필요) — 핫링크 가능한 원본만 채택
async function searchOpenverse(q, index) {
  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20&license_type=commercial&mature=false`;
  const json = await getJson(url);
  const items = (json.results || []).filter(r => r.url && isHotlinkSafe(r.url));
  if (!items.length) return null;
  const p = items[index % items.length];
  return {
    url: p.url,
    credit: p.creator ? `${p.creator} (${p.license ? p.license.toUpperCase() : 'CC'})` : '',
    source: 'Openverse',
  };
}

// 3순위: Wikimedia Commons (키 불필요) — 고유명사/시사 주제에 강함
async function searchWikimedia(q, index) {
  const url = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search'
    + `&gsrsearch=${encodeURIComponent('filetype:bitmap ' + q)}&gsrnamespace=6&gsrlimit=20`
    + '&prop=imageinfo&iiprop=url&iiurlwidth=1200';
  const json = await getJson(url);
  const pages = json.query && json.query.pages ? Object.values(json.query.pages) : [];
  const items = pages
    .map(pg => pg.imageinfo && pg.imageinfo[0])
    .filter(ii => ii && ii.thumburl && isHotlinkSafe(ii.thumburl));
  if (!items.length) return null;
  const p = items[index % items.length];
  return { url: p.thumburl, credit: 'Wikimedia Commons', source: 'Wikimedia' };
}

// 키워드에 맞는 사진 찾기 — 위 순서대로 시도, 실패 로그 남김
async function fetchImage(keyword, index) {
  const clean = String(keyword || '').toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim() || 'business';

  if (!process.env.UNSPLASH_ACCESS_KEY) {
    console.warn('[Image] UNSPLASH_ACCESS_KEY 미설정 — Openverse/Wikimedia만 사용 (품질 낮음)');
  }

  for (const [name, fn] of [['Unsplash', searchUnsplash], ['Openverse', searchOpenverse], ['Wikimedia', searchWikimedia]]) {
    try {
      const hit = await fn(clean, index);
      if (hit) {
        console.log(`[Image] ✅ ${name} "${clean}" → ${hit.url.slice(0, 70)}`);
        return hit;
      }
      if (name !== 'Unsplash' || process.env.UNSPLASH_ACCESS_KEY) {
        console.warn(`[Image] ${name} "${clean}" 결과 없음`);
      }
    } catch (e) {
      console.warn(`[Image] ${name} 실패 (${clean}): ${e.message}`);
    }
  }

  console.warn(`[Image] ⚠️ "${clean}" — 전부 실패, 랜덤 사진 사용`);
  const seed = clean.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + index * 97;
  return { url: `https://picsum.photos/seed/${seed % 9999}/1200/630`, credit: '', source: 'picsum' };
}

// 이미지 HTML 태그 생성
function imageTag(img, alt) {
  const caption = img.credit ? `${alt} · ${img.credit}` : alt;
  return `<figure style="text-align:center;margin:28px 0">`
    + `<img src="${img.url}" alt="${alt}" loading="lazy" style="max-width:100%;height:auto;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.12)">`
    + `<figcaption style="color:#888;font-size:13px;margin-top:8px">${caption}</figcaption></figure>`;
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

  // 이미지 병렬 가져오기 (핫링크 허용 소스만)
  const images = await Promise.all(placeholders.map((kw, i) => fetchImage(kw, i)));
  const bySource = images.reduce((a, im) => { a[im.source] = (a[im.source] || 0) + 1; return a; }, {});
  console.log(`[Generator] 이미지 ${images.length}개 준비 — ${JSON.stringify(bySource)}`);

  // 플레이스홀더 교체
  let urlIdx = 0;
  content = content.replace(/\[IMAGE:([^\]]+)\]/g, (_, kw) => {
    const img = images[urlIdx++] || images[0];
    return imageTag(img, kw);
  });

  // 플레이스홀더가 없었으면 본문 중간에 삽입
  if (urlIdx === 0 && images.length > 0) {
    const mid = content.indexOf('</p>', Math.floor(content.length * 0.4));
    if (mid !== -1) {
      content = content.slice(0, mid + 4) + imageTag(images[0], imgKeywords[0] || keyword) + content.slice(mid + 4);
    }
  }

  console.log(`[Generator] 생성 완료: "${json.title}" (이미지 ${urlIdx}개)`);
  return { title: json.title, content, tags: json.tags || [keyword] };
}

module.exports = { generatePost, fetchImage };
