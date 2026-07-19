/**
 * content/shorts-script.js
 * 블로그 포스팅 → 유튜브 숏츠 / 인스타 릴스 대본 자동 생성
 * 55-60초 완성형 대본 (타이밍 마커 + 비주얼 큐 + 후킹 포함)
 */

const https = require('https');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-5';

// 세그먼트별 색상 팔레트
const SEGMENT_COLORS = {
  HOOK:    { bg: '#fff1f0', border: '#ff4d4f', badge: '#ff4d4f', label: '🎣 HOOK' },
  INTRO:   { bg: '#fff7e6', border: '#fa8c16', badge: '#fa8c16', label: '👋 INTRO' },
  POINT_1: { bg: '#e6f4ff', border: '#1677ff', badge: '#1677ff', label: '💡 POINT 1' },
  POINT_2: { bg: '#e6f4ff', border: '#1677ff', badge: '#1677ff', label: '💡 POINT 2' },
  POINT_3: { bg: '#e6f4ff', border: '#1677ff', badge: '#1677ff', label: '💡 POINT 3' },
  POINT_4: { bg: '#e6f4ff', border: '#1677ff', badge: '#1677ff', label: '💡 POINT 4' },
  CTA:     { bg: '#f6ffed', border: '#52c41a', badge: '#52c41a', label: '📣 CTA' },
  OUTRO:   { bg: '#f9f0ff', border: '#9254de', badge: '#9254de', label: '🎬 OUTRO' },
};

const DEFAULT_SEGMENT_COLOR = { bg: '#fafafa', border: '#8c8c8c', badge: '#8c8c8c', label: '📌 SEGMENT' };

// ─── Claude API 호출 헬퍼 ──────────────────────────────────────────────────────

function callClaude(prompt, systemPrompt, maxTokens = 2048) {
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
      res.on('data', chunk => { data += chunk; });
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

// ─── 숏츠 대본 생성 ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `당신은 유튜브 숏츠 전문 PD입니다. MZ세대가 3초만에 스킵하지 않는 임팩트 있는 숏폼 대본을 만듭니다.`;

/**
 * 블로그 포스팅으로부터 숏츠 대본 생성
 * @param {string} title   - 블로그 포스팅 제목
 * @param {string} content - 블로그 본문 (500자 이상 권장)
 * @param {string[]} tags  - 포스팅 태그 목록
 * @returns {Promise<Object>} 구조화된 대본 JSON
 */
async function generateShortsScript(title, content, tags) {
  const snippet = content.replace(/<[^>]+>/g, '').trim().slice(0, 500);
  const tagStr  = Array.isArray(tags) ? tags.join(', ') : (tags || '');

  const prompt = `
다음 블로그 포스팅을 55~60초짜리 유튜브 숏츠 대본으로 변환해주세요.

[블로그 제목]
${title}

[핵심 내용 (앞부분 500자)]
${snippet}

[태그]
${tagStr}

요구사항:
- 총 길이 55~60초 (과도하게 길거나 짧으면 안 됨)
- HOOK에서 충격적인 통계, 질문, 발언으로 스크롤을 멈춰야 함
- 구어체 사용 — 실제 유튜버가 말하듯이 자연스럽게
- 각 POINT는 10~15초 분량으로 핵심만
- CTA는 팔로우 + 저장 동시 유도
- 해시태그 8개는 검색량 높은 것으로

아래 JSON 형식으로만 응답하세요 (마크다운 코드블록 없이 JSON만):
{
  "title": "숏츠 제목 (60자 이하, SEO 최적화)",
  "description": "유튜브 설명란 (150자, 해시태그 포함)",
  "hashtags": ["#유튜브쇼츠", "#shorts", "#한국", "#꿀팁", "#정보", "#알고리즘", "#viral", "#trending"],
  "script": [
    {
      "segment": "HOOK",
      "timing": "0-3초",
      "script": "실제 말할 대본 (구어체)",
      "visual": "화면에 보여줄 것 (텍스트 오버레이, 영상 소재 등)",
      "tone": "충격적/호기심유발"
    },
    {
      "segment": "POINT_1",
      "timing": "3-18초",
      "script": "...",
      "visual": "...",
      "tone": "정보전달"
    },
    {
      "segment": "POINT_2",
      "timing": "18-33초",
      "script": "...",
      "visual": "...",
      "tone": "정보전달"
    },
    {
      "segment": "POINT_3",
      "timing": "33-48초",
      "script": "...",
      "visual": "...",
      "tone": "정보전달"
    },
    {
      "segment": "CTA",
      "timing": "48-58초",
      "script": "팔로우+저장 유도 멘트",
      "visual": "팔로우 버튼 강조 화면",
      "tone": "친근하게"
    },
    {
      "segment": "OUTRO",
      "timing": "58-60초",
      "script": "...",
      "visual": "채널 로고/아웃트로",
      "tone": "마무리"
    }
  ],
  "totalDuration": "59초",
  "tips": ["편집 팁1", "촬영 팁2", "업로드 최적 시간"]
}`;

  const raw     = await callClaude(prompt, SYSTEM_PROMPT, 2048);
  const cleaned = raw.replace(/```json\n?|\n?```/g, '').trim();
  const result  = JSON.parse(cleaned);

  if (!result.script || !Array.isArray(result.script) || result.script.length === 0) {
    throw new Error('숏츠 대본 생성 결과 불완전 — script 배열이 없습니다');
  }

  console.log(`[ShortsScript] 대본 생성 완료: "${result.title}" | ${result.totalDuration} | 세그먼트 ${result.script.length}개`);
  return result;
}

// ─── HTML 렌더러 ──────────────────────────────────────────────────────────────

/**
 * 대본 데이터를 대시보드에 표시할 HTML 문자열로 변환
 * @param {Object} scriptData - generateShortsScript() 반환값
 * @returns {string} HTML 문자열
 */
function renderScriptHtml(scriptData) {
  if (!scriptData || !scriptData.script) {
    return `<div style="color:#ff4d4f;padding:20px;text-align:center">⚠️ 대본 데이터가 없습니다.</div>`;
  }

  const { title, description, hashtags = [], script = [], totalDuration = '—', tips = [] } = scriptData;

  // 전체 대본 텍스트 (클립보드용)
  const fullScriptText = script
    .map(seg => `[${seg.segment} | ${seg.timing}]\n${seg.script}\n📷 ${seg.visual}`)
    .join('\n\n');

  // 세그먼트 카드 렌더링
  const segmentCards = script.map((seg, idx) => {
    const color = SEGMENT_COLORS[seg.segment] || DEFAULT_SEGMENT_COLOR;
    const label = color.label || seg.segment;

    return `
      <div style="
        background:${color.bg};
        border-left:4px solid ${color.border};
        border-radius:10px;
        padding:16px 18px;
        margin-bottom:12px;
        position:relative;
      ">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap">
          <span style="
            background:${color.badge};
            color:#fff;
            font-size:11px;
            font-weight:700;
            letter-spacing:0.5px;
            padding:3px 10px;
            border-radius:20px;
            white-space:nowrap;
          ">${label}</span>
          <span style="
            background:#fff;
            border:1px solid ${color.border};
            color:${color.border};
            font-size:11px;
            font-weight:600;
            padding:3px 10px;
            border-radius:20px;
            white-space:nowrap;
          ">⏱ ${seg.timing}</span>
          <span style="
            background:#f5f5f5;
            color:#595959;
            font-size:11px;
            padding:3px 10px;
            border-radius:20px;
            white-space:nowrap;
          ">${seg.tone || ''}</span>
        </div>

        <div style="
          font-size:15px;
          color:#1a1a1a;
          line-height:1.65;
          margin-bottom:10px;
          font-weight:500;
        ">${escHtml(seg.script)}</div>

        <div style="
          display:flex;
          align-items:flex-start;
          gap:8px;
          background:rgba(0,0,0,0.04);
          border-radius:8px;
          padding:10px 12px;
          font-size:13px;
          color:#595959;
          line-height:1.5;
        ">
          <span style="font-size:15px;flex-shrink:0">📷</span>
          <span><b style="color:#333">비주얼:</b> ${escHtml(seg.visual)}</span>
        </div>
      </div>`;
  }).join('');

  // 해시태그 칩
  const hashtagChips = hashtags.map(tag =>
    `<span style="
      display:inline-block;
      background:#e6f4ff;
      color:#1677ff;
      font-size:12px;
      font-weight:600;
      padding:4px 10px;
      border-radius:20px;
      margin:3px 3px 3px 0;
      cursor:default;
    ">${escHtml(tag)}</span>`
  ).join('');

  // 촬영/편집 팁
  const tipItems = tips.map((tip, i) =>
    `<li style="
      padding:8px 0;
      border-bottom:${i < tips.length - 1 ? '1px dashed #e8e8e8' : 'none'};
      color:#434343;
      font-size:13px;
      line-height:1.5;
    ">💬 ${escHtml(tip)}</li>`
  ).join('');

  // 클립보드 복사 스크립트 (인라인, ID 기반)
  const uid = `shorts_${Date.now()}`;

  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Apple SD Gothic Neo',sans-serif;max-width:720px">

  <!-- 헤더 -->
  <div style="
    background:linear-gradient(135deg,#18181b 0%,#27272a 100%);
    border-radius:14px;
    padding:22px 24px;
    margin-bottom:20px;
    color:#fff;
  ">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <span style="font-size:22px">🎬</span>
      <span style="
        background:#ff4d4f;
        color:#fff;
        font-size:11px;
        font-weight:700;
        letter-spacing:1px;
        padding:2px 10px;
        border-radius:4px;
      ">SHORTS SCRIPT</span>
      <span style="
        background:rgba(255,255,255,0.15);
        color:#fff;
        font-size:11px;
        font-weight:600;
        padding:2px 10px;
        border-radius:4px;
      ">⏱ ${escHtml(totalDuration)}</span>
    </div>
    <h2 style="margin:0 0 6px;font-size:18px;font-weight:700;line-height:1.4">${escHtml(title || '제목 없음')}</h2>
    <p style="margin:0;font-size:13px;color:rgba(255,255,255,0.65);line-height:1.5">${escHtml(description || '')}</p>
  </div>

  <!-- 해시태그 -->
  ${hashtags.length > 0 ? `
  <div style="
    background:#fafafa;
    border:1px solid #f0f0f0;
    border-radius:10px;
    padding:14px 16px;
    margin-bottom:20px;
  ">
    <div style="font-size:12px;font-weight:600;color:#8c8c8c;margin-bottom:8px;letter-spacing:0.5px">HASHTAGS</div>
    <div>${hashtagChips}</div>
  </div>` : ''}

  <!-- 대본 세그먼트 -->
  <div style="margin-bottom:20px">
    <div style="
      display:flex;
      align-items:center;
      justify-content:space-between;
      margin-bottom:12px;
    ">
      <span style="font-size:13px;font-weight:700;color:#1a1a1a;letter-spacing:0.3px">📝 대본</span>
      <button
        id="${uid}_copy_btn"
        onclick="(function(){
          var t = document.getElementById('${uid}_full_text');
          navigator.clipboard.writeText(t.value).then(function(){
            var btn = document.getElementById('${uid}_copy_btn');
            btn.textContent = '✅ 복사됨!';
            btn.style.background = '#52c41a';
            setTimeout(function(){ btn.textContent = '📋 전체 복사'; btn.style.background = '#1677ff'; }, 2000);
          }).catch(function(){
            t.select(); document.execCommand('copy');
          });
        })()"
        style="
          background:#1677ff;
          color:#fff;
          border:none;
          border-radius:8px;
          padding:7px 14px;
          font-size:12px;
          font-weight:600;
          cursor:pointer;
          transition:background 0.2s;
        "
      >📋 전체 복사</button>
    </div>
    <textarea
      id="${uid}_full_text"
      readonly
      aria-hidden="true"
      style="position:absolute;left:-9999px;top:-9999px;opacity:0;pointer-events:none"
    >${escHtml(fullScriptText)}</textarea>
    ${segmentCards}
  </div>

  <!-- 촬영/편집 팁 -->
  ${tips.length > 0 ? `
  <div style="
    background:#fffbe6;
    border:1px solid #ffe58f;
    border-radius:10px;
    padding:14px 16px;
  ">
    <div style="font-size:12px;font-weight:700;color:#d48806;margin-bottom:10px;letter-spacing:0.5px">⚡ 제작 팁</div>
    <ul style="list-style:none;margin:0;padding:0">${tipItems}</ul>
  </div>` : ''}

</div>`;
}

// ─── 내부 유틸 ────────────────────────────────────────────────────────────────

function escHtml(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── 내보내기 ─────────────────────────────────────────────────────────────────

module.exports = { generateShortsScript, renderScriptHtml };
