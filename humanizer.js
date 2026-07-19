/**
 * humanizer.js
 * AI 텍스트를 한국 블로그 글처럼 자연스럽게 가공
 */

const FILLER_PHRASES = [
  '근데 솔직히 말하면',
  '제가 직접 써봤는데요',
  '이게 생각보다',
  '처음엔 저도 몰랐는데',
  '개인적으로는',
  '친구한테 물어보니까',
  '알고보니',
  '사실 이거',
  '뭐 제 경험상으로는',
  '아 참고로',
];

const CASUAL_ENDINGS = ['ㅎㅎ', ' ㅠㅠ', '~', '!', '', ' 😊', '..'];

const TRANSITION_WORDS = [
  '그리고', '근데', '또한', '아무튼', '여튼', '그래서', '사실',
];

const INTERJECTIONS = [
  '아, ', '오, ', '헉 ', '음.. ', '사실 ', '그니까 ',
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 너무 완벽한 AI 문장 패턴 제거
function removeAiPatterns(text) {
  return text
    .replace(/첫째[,，]?\s*/g, '먼저 ')
    .replace(/둘째[,，]?\s*/g, '그리고 ')
    .replace(/셋째[,，]?\s*/g, '마지막으로 ')
    .replace(/결론적으로\s*/g, '여튼 ')
    .replace(/요약하자면\s*/g, '간단히 말하면 ')
    .replace(/주목할 만한\s*/g, '눈에 띄는 ')
    .replace(/효과적인\s*/g, '쓸만한 ')
    .replace(/최적화된\s*/g, '잘 맞는 ')
    .replace(/중요한 것은\s*/g, '핵심은 ')
    .replace(/다양한\s*/g, '여러 ')
    .replace(/다양하게\s*/g, '여러 방식으로 ')
    .replace(/활용할 수 있습니다/g, '쓸 수 있어요')
    .replace(/가능합니다/g, '돼요')
    .replace(/있습니다\./g, '있어요.')
    .replace(/됩니다\./g, '돼요.')
    .replace(/합니다\./g, '해요.')
    .replace(/입니다\./g, '이에요.')
    .replace(/습니다\./g, '어요.');
}

function humanizeHtml(html) {
  // AI 패턴 제거
  html = removeAiPatterns(html);

  // 연속 br 태그 정리
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');

  // 문단 처리
  const paras = html.split(/(?<=<\/p>)\s*(?=<p)/i);

  const result = paras.map((p, i) => {
    // 짧은 문단에 가끔 감탄사 삽입 (15% 확률)
    if (p.length < 120 && Math.random() < 0.15 && i > 0) {
      const inj = randomItem(INTERJECTIONS);
      p = p.replace(/^<p>/i, `<p>${inj}`);
    }

    // 긴 문단에 필러 문구 (10% 확률)
    if (p.length > 200 && Math.random() < 0.10 && i > 1) {
      const filler = randomItem(FILLER_PHRASES);
      p = p.replace(/^<p>/i, `<p>${filler}, `);
    }

    return p;
  });

  return result.join('\n');
}

function humanizeTitle(title) {
  const patterns = [
    (t) => t,
    (t) => `${t} 솔직 후기`,
    (t) => `${t}? 직접 해봤어요`,
    (t) => `${t} - 써보니까 이렇더라고요`,
    (t) => `${t} 알고 계셨나요?`,
    (t) => `[찐후기] ${t}`,
    (t) => `${t} 이거 진짜예요?`,
  ];
  return randomItem(patterns)(title);
}

function humanizePostTime(baseTime) {
  const jitter = randomBetween(-15, 15) * 60 * 1000;
  return new Date(baseTime.getTime() + jitter);
}

function variantForPlatform(content, platform) {
  const variants = {
    naver:   (c) => c.replace(/블로그/g, '포스팅'),
    tistory: (c) => c,
    blogger: (c) => c.replace(/안녕하세요/g, '안녕하세요 여러분'),
  };
  return (variants[platform] || ((c) => c))(content);
}

module.exports = {
  humanizeHtml,
  humanizeTitle,
  humanizeSentences: (s) => s,
  humanizePostTime,
  variantForPlatform,
};
