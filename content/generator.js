/**
 * content/generator.js
 * Claude API로 블로그 글 자동 생성
 * 모델: claude-haiku-4-5 (속도/비용 최적)
 */

const https = require('https');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-haiku-4-5-20251001';

function callClaude(prompt, systemPrompt) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 2048,
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
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 트렌딩 키워드 + 계정 주제 기반 블로그 글 생성
 * @param {string} keyword   - 트렌딩 키워드
 * @param {object} account   - 계정 설정 (topic, tone, platform)
 * @returns {{ title, content, tags }}
 */
async function generatePost(keyword, account) {
  const { topic, tone = '친근하고 자연스러운', platform = 'naver' } = account;

  const systemPrompt = `당신은 한국 블로그 작가입니다. 다음 규칙을 반드시 따르세요:
- 구어체, 자연스러운 문체 사용 (AI 느낌 없애기)
- 1인칭 시점, 개인 경험 담은 듯한 서술
- 너무 완벽하지 않게 — 가끔 "사실...", "솔직히", "개인적으로" 같은 표현 섞기
- 이모지 2~3개 자연스럽게 삽입
- 단락 나누기 잘 하기 (모바일 가독성)
- SEO를 위해 키워드 자연스럽게 3~5회 반복
- 절대로 목록(bullet) 남발하지 말 것 — 자연스러운 산문체 위주`;

  const prompt = `
주제: ${topic}
트렌딩 키워드: "${keyword}"
블로그 플랫폼: ${platform}
글 톤: ${tone}

위 트렌딩 키워드를 활용해서 주제에 맞는 블로그 글을 써주세요.

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "title": "글 제목 (SEO 최적화, 30자 이내)",
  "content": "HTML 형식의 본문 (p, br 태그 사용, 600~900자)",
  "tags": ["태그1", "태그2", "태그3", "태그4", "태그5"]
}`;

  try {
    const raw = await callClaude(prompt, systemPrompt);

    // JSON 파싱 (마크다운 코드블록 제거)
    const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
    const json = JSON.parse(cleaned);

    if (!json.title || !json.content) throw new Error('글 생성 결과 불완전');

    console.log(`[Generator] 생성 완료: "${json.title}"`);
    return json;

  } catch (err) {
    console.error('[Generator] 생성 실패:', err.message);
    // 폴백: 최소한의 글 반환
    return {
      title: `${keyword} 관련 정보`,
      content: `<p>오늘은 <b>${keyword}</b>에 대해 이야기해볼게요.</p><p>${topic}에 관심 있으신 분들께 도움이 되길 바랍니다.</p>`,
      tags: [keyword, topic],
    };
  }
}

module.exports = { generatePost };
