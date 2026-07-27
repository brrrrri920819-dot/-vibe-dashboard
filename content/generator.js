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

/* 애드센스 심사 기준에 맞춘 프롬프트.
 * 구글이 '가치 없는 콘텐츠'로 거절하는 요인을 역으로 제거한다:
 *   깊이 부족 / 구조 없음 / 어디서나 볼 수 있는 내용 / 분량 미달 / 꾸며낸 후기
 * 이전 버전은 'AI 티 지우기'에 맞춰져 있어서 오타·산만한 구성·가짜 경험담을
 * 일부러 넣었는데, 그게 정확히 심사에서 감점되는 항목들이었다. */
const SYSTEM_PROMPT = `당신은 한 분야를 오래 다뤄 온 한국인 블로그 운영자입니다.
독자가 검색해서 들어왔을 때, 이 글 하나로 궁금증이 완전히 해결되어
다른 글을 더 찾아볼 필요가 없게 만드는 것이 목표입니다.

문체:
- 존댓말 기반의 편안한 블로그체 ("~해요", "~합니다" 혼용)
- 과장·낚시 없이 담백하게. 감탄사와 이모지는 글 전체에 1~2개면 충분
- 오타, 초성체(ㅎㅎ/ㅠㅠ), 유행어는 쓰지 않음
- 겪지 않은 일을 겪은 것처럼 쓰지 않음.
  "제가 직접 써봤는데" 같은 표현 금지. 대신 "일반적으로", "사례를 보면",
  "공식 기준에 따르면" 처럼 근거의 출처를 밝히며 서술

반드시 담아야 하는 것 (이게 없으면 검색해도 나오는 뻔한 글이 됩니다):
- 구체적인 숫자: 금액, 기간, 비율, 조건, 기준일
- 절차나 방법은 순서대로, 독자가 그대로 따라 할 수 있게
- 선택지가 있으면 비교표로 정리
- 사람들이 흔히 놓치는 예외·주의사항·불이익
- 상황별로 답이 갈리는 지점 ("A라면 이렇게, B라면 저렇게")

쓰지 말아야 하는 것:
- "매우 중요합니다", "다양한 방법이 있습니다" 같은 알맹이 없는 문장
- 같은 내용을 표현만 바꿔 반복하는 분량 늘리기
- 근거 없는 단정, 확인되지 않은 수치`;

async function generatePost(keyword, account) {
  const { topic = '라이프스타일', tone = '친근한', platform = 'blogger' } = account;

  const prompt = `
검색 키워드: "${keyword}"
블로그 주제: ${topic}
플랫폼: ${platform}

이 키워드로 검색한 사람이 무엇을 알고 싶어 하는지 먼저 파악한 뒤,
그 질문에 끝까지 답하는 글을 작성해주세요.

구성:
1. 제목 — 검색 의도에 그대로 답하는 제목. 낚시성 표현("충격", "발칵") 금지.
   "직접 해봤다", "솔직 후기" 같은 표현은 실제 체험 글이 아니면 쓰지 마세요.

2. 본문 — HTML, 공백 제외 2500~3500자
   · 도입(2~3문단): 독자가 처한 상황을 짚고, 이 글에서 무엇을 알게 되는지 제시
   · <h2> 소제목 4~5개. 각 소제목 아래 최소 3문단씩, 구체적 정보로 채움
   · 최소 1개의 비교표를 <table>로 (항목/조건/금액 등 실제로 비교되는 내용)
     표는 <table><thead><tr><th>…</th></tr></thead><tbody><tr><td>…</td></tr></tbody></table>
   · 핵심 목록은 <ul><li>로 정리
   · "자주 묻는 질문" <h2> 섹션에 실제로 궁금해할 질문 3개와 답변
   · 마무리: 핵심 3줄 요약 + 주의사항
   · 이미지 자리 3~4곳에 [IMAGE:영어키워드] 를 소제목 사이에 배치

3. 태그 8개 — 실제 검색어 형태로

4. 이미지 키워드 4개 — 영어, 각 섹션을 대표하는 사진이 나올 구체적 표현
   (예: "korean cafe interior", "person filling out documents", "container ship port")
   추상어 단독 사용 금지 ("technology", "lifestyle" 등)

JSON만 출력 (설명 문장 없이):
{
  "title": "제목",
  "content": "HTML 본문",
  "tags": ["태그1", "…", "태그8"],
  "imageKeywords": ["kw1", "kw2", "kw3", "kw4"]
}`;

  // 본문 글자 수 (HTML 태그·공백 제외) — 애드센스 심사에서 분량은 최소 조건
  const textLen = (html) => String(html).replace(/<[^>]+>/g, '').replace(/\s/g, '').length;
  const MIN_LEN = 2000;

  let json;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const raw     = await callClaude(prompt, SYSTEM_PROMPT, 8192);
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    let parsed = null;
    try { parsed = JSON.parse(cleaned); } catch (e) {
      if (attempt === 3) throw new Error(`JSON 파싱 실패: ${e.message}`);
      console.warn('[Generator] JSON 파싱 실패, 재시도 중...');
      continue;
    }
    if (!parsed.title || !parsed.content) {
      if (attempt === 3) throw new Error('글 생성 결과 불완전 (제목/본문 누락)');
      console.warn('[Generator] JSON 불완전, 재시도 중...');
      continue;
    }
    const len = textLen(parsed.content);
    if (len < MIN_LEN && attempt < 3) {
      console.warn(`[Generator] 분량 미달 (${len}자 < ${MIN_LEN}자) — 재생성`);
      continue;
    }
    if (len < MIN_LEN) console.warn(`[Generator] ⚠️ 분량 ${len}자로 최종 — 애드센스 심사에 불리할 수 있음`);
    json = parsed;
    break;
  }

  // 심사 감점 요소 점검 (로그로만 경고 — 발행은 막지 않음)
  const warns = [];
  if (!/<h2/i.test(json.content))    warns.push('h2 소제목 없음');
  if (!/<table/i.test(json.content)) warns.push('비교표 없음');
  if (!/자주 묻는 질문|FAQ/i.test(json.content)) warns.push('FAQ 섹션 없음');
  if (/직접 (써|해)봤|솔직 후기|찐후기/.test(json.title + json.content)) warns.push('꾸며낸 체험 표현 포함');
  if (warns.length) console.warn(`[Generator] ⚠️ 품질 점검: ${warns.join(', ')}`);

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
