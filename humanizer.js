/**
 * humanizer.js
 * 문체를 한국 블로그 톤으로 다듬는다.
 *
 * 주의: 예전 버전은 "제가 직접 써봤는데요", "친구한테 물어보니까" 같은
 * 문구와 "[찐후기]", "직접 해봤어요" 같은 제목 접미사를 무작위로 붙였다.
 * 겪지 않은 일을 겪은 것처럼 쓰는 것이라 독자를 속이는 데다,
 * 애드센스 심사에서 '가치 없는 콘텐츠'로 감점되는 항목이라 전부 제거했다.
 */

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 번역투·기계적인 문장을 자연스러운 한국어 블로그체로
function softenTone(text) {
  return text
    .replace(/결론적으로\s*/g, '정리하면 ')
    .replace(/요약하자면\s*/g, '정리하면 ')
    .replace(/주목할 만한\s*/g, '눈여겨볼 ')
    .replace(/중요한 것은\s*/g, '핵심은 ')
    .replace(/활용할 수 있습니다/g, '활용하시면 됩니다')
    .replace(/것으로 사료됩니다/g, '것으로 보입니다')
    .replace(/바 있습니다/g, '적이 있습니다');
}

function humanizeHtml(html) {
  html = softenTone(html);
  // 연속 br 정리
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  return html;
}

// 제목은 내용을 바꾸지 않는다. 공백·중복 문장부호만 정리.
function humanizeTitle(title) {
  return String(title)
    .replace(/\s+/g, ' ')
    .replace(/([?!])\1+/g, '$1')
    .trim();
}

// 발행 시각을 ±15분 흩어 기계적인 정시 발행을 피함
function humanizePostTime(baseTime) {
  const jitter = randomBetween(-15, 15) * 60 * 1000;
  return new Date(baseTime.getTime() + jitter);
}

/* 플랫폼별 변형.
 * 예전엔 본문의 '블로그'를 전부 '포스팅'으로 바꿔서
 * "이 블로그를 운영하며" → "이 포스팅을 운영하며" 처럼 문장이 깨졌다.
 * 의미를 훼손하지 않도록 변형을 하지 않는다. */
function variantForPlatform(content, _platform) {
  return content;
}

module.exports = {
  humanizeHtml,
  humanizeTitle,
  humanizeSentences: (s) => s,
  humanizePostTime,
  variantForPlatform,
};
