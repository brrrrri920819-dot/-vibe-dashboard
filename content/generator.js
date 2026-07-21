/**
 * content/generator.js
 * 수익형 블로그 글 자동 생성 — AI 티 최소화, SEO 최적화
 */

const https = require('https');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-5';

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
        } catch (e) {
          reject(new Error(`응답 파싱 실패: ${e.message} | 원본: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// Unsplash 무료 이미지 — sig 파라미터로 매번 다른 사진
function getImageUrl(keyword) {
  const encoded = encodeURIComponent(keyword.replace(/\s+/g, ','));
  const sig = Math.floor(Math.random() * 9999);
  return `https://source.unsplash.com/1200x630/?${encoded}&sig=${sig}`;
}

// 이미지 HTML 태그 생성
function imageTag(keyword, alt) {
  const url = getImageUrl(keyword);
  return `<figure style="text-align:center;margin:28px 0"><img src="${url}" alt="${alt}" style="max-width:100%;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,0.12)"><figcaption style="color:#888;font-size:13px;margin-top:8px">${alt}</figcaption></figure>`;
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
4. 이미지 키워드: 영어로 4개 (각각 달라야 함, Unsplash 검색용)

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

  // 이미지 플레이스홀더를 실제 이미지 태그로 교체
  let content = json.content;
  const imgKeywords = json.imageKeywords || [keyword, topic];
  let imgIndex = 0;
  content = content.replace(/\[IMAGE:([^\]]+)\]/g, (match, imgKw) => {
    const kw = imgKw || imgKeywords[imgIndex] || keyword;
    imgIndex++;
    return imageTag(kw, kw);
  });

  // 남은 이미지 키워드가 있으면 본문 중간에 삽입
  if (imgIndex === 0 && imgKeywords.length > 0) {
    const mid = content.indexOf('</p>', Math.floor(content.length * 0.4));
    if (mid !== -1) {
      content = content.slice(0, mid + 4) + imageTag(imgKeywords[0], imgKeywords[0]) + content.slice(mid + 4);
    }
  }

  console.log(`[Generator] 생성 완료: "${json.title}" (이미지 ${imgIndex}개)`);
  return { title: json.title, content, tags: json.tags || [keyword] };
}

module.exports = { generatePost };
