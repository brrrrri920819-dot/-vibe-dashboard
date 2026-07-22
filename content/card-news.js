'use strict';

/**
 * content/card-news.js
 * 블로그 포스팅 → 인스타그램 카드뉴스 6장 자동 생성
 * 출력: 1080×1080 (CSS 540×540 @2x) 완전 자급식 HTML
 */

const https = require('https');

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = 'claude-sonnet-5';

// ─── Claude API ───────────────────────────────────────────────────────────────

function callClaude(prompt, systemPrompt, maxTokens = 2048) {
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
          if (json.stop_reason === 'max_tokens') return reject(new Error('응답이 너무 길어 잘렸습니다 (max_tokens 초과)'));
          const text = json.content?.find(b => b.type === 'text')?.text;
          if (!text) return reject(new Error(`Claude 빈 응답 — blocks: ${JSON.stringify((json.content||[]).map(b=>b.type))}`));
          resolve(text);
        } catch (e) {
          reject(new Error(`응답 파싱 실패: ${e.message}`));
        }
      });
    });
    req.on('error', e => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Shared card chrome elements ──────────────────────────────────────────────

// 3px gradient bar across the top of every card
function accentBar() {
  return `<div style="position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,#ec4899,#f43f5e);z-index:20"></div>` +
    // subtle glow bleed below the bar
    `<div style="position:absolute;top:0;left:0;right:0;height:90px;background:linear-gradient(to bottom,rgba(236,72,153,0.07) 0%,transparent 100%);pointer-events:none;z-index:1"></div>`;
}

// Card N/6 pill badge – top right
function cardBadge(num, total) {
  return `<div style="position:absolute;top:20px;right:20px;padding:4px 11px;border-radius:20px;background:rgba(236,72,153,0.11);border:1px solid rgba(236,72,153,0.26);color:#ec4899;font-size:11px;font-weight:700;letter-spacing:0.5px;z-index:20;line-height:1.4">${num}/${total}</div>`;
}

// Subtle brand stamp – bottom right
function brand() {
  return `<div style="position:absolute;bottom:18px;right:22px;color:#252b4a;font-size:10px;font-weight:600;letter-spacing:0.7px;z-index:20;line-height:1">리리's 블로그</div>`;
}

// Faint grid pattern overlay – gives premium printed look
function gridOverlay() {
  return `<div style="position:absolute;inset:0;background-image:repeating-linear-gradient(0deg,rgba(255,255,255,0.016) 0,rgba(255,255,255,0.016) 1px,transparent 1px,transparent 54px),repeating-linear-gradient(90deg,rgba(255,255,255,0.016) 0,rgba(255,255,255,0.016) 1px,transparent 1px,transparent 54px);pointer-events:none;z-index:0"></div>`;
}

// ─── Card wrapper ─────────────────────────────────────────────────────────────

/**
 * Wraps inner HTML in the shared 540×540 card shell.
 * extraBg: additional background layers prepended before the base gradient.
 */
function cardWrap(inner, extraBg) {
  const bg = extraBg
    ? `${extraBg},linear-gradient(135deg,#080b14 0%,#0e1120 50%,#141728 100%)`
    : `linear-gradient(135deg,#080b14 0%,#0e1120 50%,#141728 100%)`;

  return (
    `<div style="width:540px;height:540px;overflow:hidden;position:relative;background:${bg};` +
    `font-family:'Pretendard Variable','Pretendard','Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;` +
    `box-sizing:border-box">` +
    inner +
    `</div>`
  );
}

// ─── Card type renderers ──────────────────────────────────────────────────────

function renderCoverCard(card, num, total) {
  const headline = escapeHtml(card.headline || '');
  const subtext  = escapeHtml(card.subtext  || '');
  const emoji    = escapeHtml(card.emoji    || '✨');

  const inner = [
    gridOverlay(),
    accentBar(),
    cardBadge(num, total),
    brand(),

    // Decorative corner glows
    `<div style="position:absolute;top:-70px;right:-70px;width:220px;height:220px;border-radius:50%;background:radial-gradient(circle,rgba(236,72,153,0.11) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,
    `<div style="position:absolute;bottom:-50px;left:-50px;width:180px;height:180px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,0.07) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,

    // Centered content column
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:44px 36px;text-align:center;z-index:10">`,

      // Emoji in a glowing halo circle
      `<div style="width:90px;height:90px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:50px;margin-bottom:24px;` +
        `background:radial-gradient(circle,rgba(236,72,153,0.18) 0%,rgba(244,63,94,0.04) 65%,transparent 100%);` +
        `box-shadow:0 0 32px rgba(236,72,153,0.12)">` +
        emoji +
      `</div>`,

      // Main headline
      `<div style="font-size:30px;font-weight:900;color:#f8fafc;line-height:1.35;letter-spacing:-0.8px;margin-bottom:14px;word-break:keep-all;max-width:400px">` +
        headline +
      `</div>`,

      // Pink divider line
      `<div style="width:32px;height:2px;background:linear-gradient(90deg,#ec4899,#f43f5e);border-radius:1px;margin-bottom:16px;flex-shrink:0"></div>`,

      // Subtext
      `<div style="font-size:14px;color:#64748b;line-height:1.72;word-break:keep-all;max-width:340px">` +
        subtext +
      `</div>`,

    `</div>`,
  ].join('');

  // Cover and CTA get a centered radial pink blush in the background
  return cardWrap(inner, 'radial-gradient(circle at 50% 44%,rgba(236,72,153,0.09) 0%,transparent 58%)');
}

function renderContentCard(card, num, total) {
  const headline  = escapeHtml(card.headline  || '');
  const body      = escapeHtml(card.body      || '');
  const highlight = escapeHtml(card.highlight || '');
  // POINT 01–04 derived from card.number (2–5) minus 1 → 1–4
  const pointIdx  = String((card.number || num) - 1).padStart(2, '0');

  const inner = [
    gridOverlay(),
    accentBar(),
    cardBadge(num, total),
    brand(),

    // Corner glows (smaller, subtler than cover)
    `<div style="position:absolute;top:-50px;right:-50px;width:170px;height:170px;border-radius:50%;background:radial-gradient(circle,rgba(236,72,153,0.07) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,
    `<div style="position:absolute;bottom:-35px;left:-35px;width:140px;height:140px;border-radius:50%;background:radial-gradient(circle,rgba(99,102,241,0.055) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,

    // Content column – left-aligned, vertically centered
    `<div style="position:absolute;inset:0;padding:48px 36px 36px;display:flex;flex-direction:column;justify-content:center;z-index:10">`,

      // POINT label
      `<div style="font-size:11px;font-weight:700;color:#ec4899;letter-spacing:1.8px;text-transform:uppercase;margin-bottom:14px;line-height:1">` +
        `POINT ${pointIdx}` +
      `</div>`,

      // Headline
      `<div style="font-size:26px;font-weight:800;color:#f1f5f9;line-height:1.42;letter-spacing:-0.5px;margin-bottom:18px;word-break:keep-all">` +
        headline +
      `</div>`,

      // Body text
      `<div style="font-size:14px;color:#7d8fa8;line-height:1.78;margin-bottom:22px;word-break:keep-all">` +
        body +
      `</div>`,

      // Highlight box (conditional)
      highlight
        ? `<div style="background:rgba(236,72,153,0.08);border-left:3px solid #ec4899;border-radius:0 8px 8px 0;padding:14px 18px">` +
            `<div style="font-size:13px;font-weight:700;color:#c9869e;line-height:1.55;word-break:keep-all">` +
              highlight +
            `</div>` +
          `</div>`
        : '',

    `</div>`,
  ].join('');

  return cardWrap(inner);
}

function renderCtaCard(card, num, total, hashtags) {
  const headline   = escapeHtml(card.headline || '');
  const body       = escapeHtml(card.body     || '저장해두고 실천해봐요 💪');
  const ctaLabel   = escapeHtml(card.cta      || '팔로우 + 저장하기');

  // Show up to 4 hashtags in muted ink at the bottom of the card
  const previewTags = (hashtags || [])
    .slice(0, 4)
    .map(h => escapeHtml(h))
    .join('  ');

  const inner = [
    gridOverlay(),
    accentBar(),
    cardBadge(num, total),
    brand(),

    // Corner glows – slightly warmer for the closing card
    `<div style="position:absolute;top:-60px;left:-60px;width:210px;height:210px;border-radius:50%;background:radial-gradient(circle,rgba(236,72,153,0.1) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,
    `<div style="position:absolute;bottom:-60px;right:-60px;width:200px;height:200px;border-radius:50%;background:radial-gradient(circle,rgba(244,63,94,0.07) 0%,transparent 70%);pointer-events:none;z-index:0"></div>`,

    // Centered content column
    `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 36px;text-align:center;z-index:10">`,

      // Mini eyebrow label
      `<div style="font-size:10px;font-weight:700;color:#ec4899;letter-spacing:2px;text-transform:uppercase;margin-bottom:18px;line-height:1">` +
        `오늘의 핵심` +
      `</div>`,

      // Headline
      `<div style="font-size:26px;font-weight:900;color:#f8fafc;line-height:1.42;letter-spacing:-0.5px;margin-bottom:16px;word-break:keep-all;max-width:380px">` +
        headline +
      `</div>`,

      // Body
      `<div style="font-size:14px;color:#64748b;line-height:1.72;margin-bottom:30px;word-break:keep-all;max-width:340px">` +
        body +
      `</div>`,

      // CTA gradient pill
      `<div style="display:inline-block;padding:14px 32px;border-radius:50px;` +
        `background:linear-gradient(135deg,#ec4899,#f43f5e);` +
        `color:#fff;font-size:15px;font-weight:800;letter-spacing:0.2px;` +
        `box-shadow:0 8px 28px rgba(236,72,153,0.34);margin-bottom:26px">` +
        ctaLabel +
      `</div>`,

      // Muted hashtag preview
      previewTags
        ? `<div style="font-size:11px;color:#252b4a;letter-spacing:0.3px;line-height:1.9">` +
            previewTags +
          `</div>`
        : '',

    `</div>`,
  ].join('');

  return cardWrap(inner, 'radial-gradient(circle at 50% 55%,rgba(236,72,153,0.09) 0%,transparent 58%)');
}

// ─── Card dispatcher ──────────────────────────────────────────────────────────

function renderCard(card, num, total, hashtags) {
  switch (card.type) {
    case 'cover':   return renderCoverCard(card, num, total);
    case 'cta':     return renderCtaCard(card, num, total, hashtags);
    default:        return renderContentCard(card, num, total);
  }
}

// ─── Full HTML page builder ───────────────────────────────────────────────────

function buildHtmlPage(cards, hashtags, title) {
  const total      = cards.length;
  const hashtagStr = (hashtags || []).join(' ');

  const cardSlots = cards
    .map((c, i) =>
      `    <div style="line-height:0">${renderCard(c, i + 1, total, hashtags)}</div>`
    )
    .join('\n');

  // Encode hashtag string for the clipboard button's data attribute
  const hashtagEscaped = escapeHtml(hashtagStr);

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>카드뉴스 — ${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@400;500;700;900&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }

    body {
      background: #020409;
      min-height: 100vh;
      padding: 60px 24px 100px;
      font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Page header ── */
    .ph {
      text-align: center;
      margin-bottom: 56px;
    }
    .ph-eye {
      font-size: 11px;
      font-weight: 700;
      color: #ec4899;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      margin-bottom: 14px;
    }
    .ph-title {
      font-size: 22px;
      font-weight: 900;
      color: #e2e8f0;
      letter-spacing: -0.5px;
      line-height: 1.45;
      max-width: 600px;
      margin: 0 auto 10px;
      word-break: keep-all;
    }
    .ph-meta {
      font-size: 12px;
      color: #232845;
      letter-spacing: 0.3px;
    }

    /* ── Cards grid ── */
    .cards-grid {
      display: grid;
      grid-template-columns: repeat(3, 540px);
      gap: 18px;
      width: fit-content;
      margin: 0 auto;
    }
    @media (max-width: 1720px) {
      .cards-grid { grid-template-columns: repeat(2, 540px) }
    }
    @media (max-width: 1140px) {
      .cards-grid { grid-template-columns: 540px }
    }

    /* ── Hashtags section ── */
    .ht-section {
      margin-top: 60px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 14px;
    }
    .ht-label {
      font-size: 11px;
      font-weight: 700;
      color: #2e3458;
      letter-spacing: 1.8px;
      text-transform: uppercase;
    }
    .ht-box {
      background: #07091a;
      border: 1px solid #10152e;
      border-radius: 14px;
      padding: 22px 30px;
      max-width: 660px;
      text-align: center;
    }
    .ht-text {
      font-size: 13px;
      color: #9333ea;
      line-height: 2.1;
      word-break: break-all;
    }
    .ht-text span { color: #ec4899 }
    .copy-btn {
      display: inline-block;
      padding: 10px 26px;
      border-radius: 8px;
      background: rgba(236,72,153,0.09);
      border: 1px solid rgba(236,72,153,0.22);
      color: #ec4899;
      font-size: 13px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      letter-spacing: 0.2px;
      transition: background 0.15s;
    }
    .copy-btn:hover  { background: rgba(236,72,153,0.17) }
    .copy-btn:active { background: rgba(236,72,153,0.24) }

    /* ── Retina hint banner ── */
    .retina-hint {
      display: none;
      margin-top: 20px;
      font-size: 12px;
      color: #2a3054;
    }
    @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
      .retina-hint { display: block }
    }
  </style>
</head>
<body>

  <header class="ph">
    <div class="ph-eye">Instagram Card News</div>
    <h1 class="ph-title">${escapeHtml(title)}</h1>
    <p class="ph-meta">총 ${total}장 · 1080 × 1080 px (CSS 540 @ 2×)</p>
  </header>

  <main class="cards-grid">
${cardSlots}
  </main>

  <section class="ht-section">
    <div class="ht-label">해시태그 (${(hashtags || []).length}개)</div>
    <div class="ht-box">
      <div class="ht-text" id="ht-text">${hashtagEscaped}</div>
    </div>
    <button class="copy-btn" id="copy-btn" data-tags="${hashtagEscaped}">해시태그 복사하기</button>
    <p class="retina-hint">Retina 디스플레이 감지됨 — 스크린샷 시 실제 1080×1080으로 저장됩니다.</p>
  </section>

  <script>
    (function () {
      var btn = document.getElementById('copy-btn');
      if (!btn) return;
      btn.addEventListener('click', function () {
        var text = btn.getAttribute('data-tags') || '';
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(function () {
            btn.textContent = '복사됨 ✓';
            setTimeout(function () { btn.textContent = '해시태그 복사하기'; }, 2200);
          }).catch(function () { fallbackCopy(text); });
        } else {
          fallbackCopy(text);
        }
      });

      function fallbackCopy(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); btn.textContent = '복사됨 ✓'; } catch (e) {}
        document.body.removeChild(ta);
        setTimeout(function () { btn.textContent = '해시태그 복사하기'; }, 2200);
      }
    })();
  </script>
</body>
</html>`;
}

// ─── Claude prompt ────────────────────────────────────────────────────────────

const CARD_SYSTEM = `당신은 인스타그램 카드뉴스 콘텐츠 전문가입니다.
한국 MZ세대 인플루언서 스타일의 감각적인 카피를 씁니다.

카드 카피 규칙:
- 헤드라인: 18자 이내, 강렬하고 직관적으로
- 본문: 65자 이내 (2-3문장), 실용적이고 공감 가는 내용
- 하이라이트: 핵심 수치 또는 기억에 남는 팁 한 줄 (38자 이내), "★ " 로 시작
- 표지 서브텍스트: 독자의 궁금증을 자극하는 한 줄 (42자 이내)
- 이모지는 표지(cover)에만 하나 사용, 나머지 필드에는 금지

반드시 순수 JSON만 응답하세요 (코드블록·마크다운·설명 없이).`;

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * 블로그 포스팅으로부터 인스타그램 카드뉴스 6장을 생성합니다.
 *
 * @param {string}   title    블로그 포스팅 제목
 * @param {string}   content  포스팅 본문 (HTML 허용)
 * @param {string[]} tags     포스팅 태그 배열
 * @returns {Promise<{ cardsHtml: string, hashtags: string[], cardCount: number }>}
 */
async function generateCardNews(title, content, tags) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('[CardNews] ANTHROPIC_API_KEY 환경변수가 필요합니다');
  }

  const cleanContent = stripHtml(content).slice(0, 1500);
  const tagStr       = (tags || []).slice(0, 6).join(', ');

  const userPrompt = `다음 블로그 포스팅으로 인스타그램 카드뉴스 6장을 만들어주세요.

제목: ${title}
주요 태그: ${tagStr}

내용 (요약):
${cleanContent}

위 내용에서 독자에게 가장 유용한 핵심 포인트 4가지를 뽑아 아래 형식의 JSON으로 응답하세요:

{
  "cards": [
    {
      "type": "cover",
      "headline": "클릭하고 싶어지는 짧은 제목 (18자 이내)",
      "subtext": "독자의 궁금증을 자극하는 한 줄 (42자 이내)",
      "emoji": "주제에 맞는 이모지 하나"
    },
    {
      "type": "content",
      "number": 2,
      "headline": "핵심 인사이트 제목 (18자 이내)",
      "body": "구체적이고 실용적인 내용 2-3문장 (65자 이내)",
      "highlight": "★ 핵심 수치나 기억에 남는 팁 (38자 이내)"
    },
    {
      "type": "content",
      "number": 3,
      "headline": "핵심 인사이트 제목 (18자 이내)",
      "body": "구체적이고 실용적인 내용 2-3문장 (65자 이내)",
      "highlight": "★ 핵심 수치나 기억에 남는 팁 (38자 이내)"
    },
    {
      "type": "content",
      "number": 4,
      "headline": "핵심 인사이트 제목 (18자 이내)",
      "body": "구체적이고 실용적인 내용 2-3문장 (65자 이내)",
      "highlight": "★ 핵심 수치나 기억에 남는 팁 (38자 이내)"
    },
    {
      "type": "content",
      "number": 5,
      "headline": "핵심 인사이트 제목 (18자 이내)",
      "body": "구체적이고 실용적인 내용 2-3문장 (65자 이내)",
      "highlight": "★ 핵심 수치나 기억에 남는 팁 (38자 이내)"
    },
    {
      "type": "cta",
      "headline": "글 전체를 관통하는 핵심 한 줄 (20자 이내)",
      "body": "저장해두고 실천해봐요 💪",
      "cta": "팔로우 + 저장하기"
    }
  ],
  "hashtags": ["#태그1", "#태그2", "#태그3", "#태그4", "#태그5", "#태그6", "#태그7", "#태그8", "#태그9", "#태그10"]
}`;

  // ── Call Claude ────────────────────────────────────────────────────────────
  const raw = await callClaude(userPrompt, CARD_SYSTEM, 2048);

  // Strip code fences if Claude wraps the JSON anyway
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(
      `[CardNews] JSON 파싱 실패: ${e.message}\n응답 앞부분: ${raw.slice(0, 300)}`
    );
  }

  let { cards = [], hashtags = [] } = parsed;

  if (cards.length === 0) {
    throw new Error('[CardNews] Claude가 카드를 생성하지 않았습니다');
  }

  // Defensive: pad to 6 cards (shouldn't happen with a well-formed response)
  while (cards.length < 6) {
    const n = cards.length + 1;
    cards.push({
      type:      'content',
      number:    n,
      headline:  `포인트 ${n - 1}`,
      body:      '',
      highlight: '',
    });
  }

  const finalCards = cards.slice(0, 6);
  const total      = finalCards.length;

  // Individual card HTML strings (for preview grid in the dashboard)
  const cardObjects = finalCards.map((c, i) => ({
    html: renderCard(c, i + 1, total, hashtags),
    type: c.type || 'content',
  }));

  const cardsHtml = buildHtmlPage(finalCards, hashtags, title);

  console.log(`[CardNews] "${title}" → 카드 ${total}장 생성 완료 (해시태그 ${hashtags.length}개)`);

  return {
    cardsHtml,
    cards: cardObjects,
    hashtags,
    cardCount: total,
  };
}

module.exports = { generateCardNews };
