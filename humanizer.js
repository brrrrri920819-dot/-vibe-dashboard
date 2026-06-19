/**
 * humanizer.js
 * AI가 생성한 텍스트를 사람이 쓴 것처럼 가공하는 유틸리티
 * - 문장 끝 다양화, 자연스러운 줄바꿈, 구어체 삽입
 */

const FILLER_PHRASES = [
  '사실 이건 제가 직접 써봤는데요,',
  '솔직히 말하면',
  '개인적으로는',
  '제 경험상으로는',
  '뭐 이건 취향 차이겠지만',
  '아 참고로',
  '그리고 하나 더 얘기하자면',
  '이게 생각보다',
  '의외로',
  '처음엔 저도 몰랐는데',
];

const CASUAL_ENDINGS = ['ㅎㅎ', '^^', '..', '~', '😊', '!', ''];
const TRANSITION_WORDS = [
  '그리고', '그래서', '근데', '또한', '그런데', '아무튼', '결론적으로', '여튼',
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/**
 * 문장 배열을 받아 사람처럼 보이게 가공
 */
function humanizeSentences(sentences) {
  return sentences.map((s, i) => {
    let text = s.trim();

    // 가끔 필러 문구 앞에 삽입 (20% 확률)
    if (Math.random() < 0.2 && i > 0) {
      text = randomItem(FILLER_PHRASES) + ' ' + text.charAt(0).toLowerCase() + text.slice(1);
    }

    // 너무 딱딱한 마침표를 가끔 감성적으로 변경 (15% 확률)
    if (Math.random() < 0.15 && text.endsWith('.')) {
      const ending = randomItem(CASUAL_ENDINGS);
      text = text.slice(0, -1) + (ending ? ' ' + ending : '');
    }

    return text;
  });
}

/**
 * HTML 본문을 받아 사람 냄새 나게 변환
 */
function humanizeHtml(html) {
  // <br> 중복 제거 후 약간의 간격 변화
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');

  // 문단 나누기
  const paras = html.split(/\n{2,}/).filter(Boolean);

  const result = paras.map((p) => {
    // 짧은 문단은 가끔 이모지 추가 (10% 확률)
    if (p.length < 80 && Math.random() < 0.1) {
      const emojis = ['✅', '💡', '📌', '👉', '🔍', '⭐'];
      p = randomItem(emojis) + ' ' + p;
    }
    return p;
  });

  return result.join('\n\n');
}

/**
 * 포스트 제목을 사람스럽게 변환
 * - 질문형, 경험공유형, 숫자강조형 패턴 중 랜덤 선택
 */
function humanizeTitle(title) {
  const patterns = [
    (t) => t, // 그대로
    (t) => `${t} 후기 및 솔직한 리뷰`,
    (t) => `${t}? 직접 해봤습니다`,
    (t) => `제가 ${t}을(를) 써본 결과...`,
    (t) => `${t} - 알아두면 유용한 팁`,
    (t) => `[실사용 후기] ${t}`,
  ];
  return randomItem(patterns)(title);
}

/**
 * 발행 시간을 인간처럼 랜덤화 (지정 시간 ±15분 이내)
 * @param {Date} baseTime
 * @returns {Date}
 */
function humanizePostTime(baseTime) {
  const jitter = randomBetween(-15, 15) * 60 * 1000;
  return new Date(baseTime.getTime() + jitter);
}

/**
 * 플랫폼마다 약간 다른 버전의 텍스트 생성 (중복 콘텐츠 회피)
 */
function variantForPlatform(content, platform) {
  const variants = {
    naver: (c) => c.replace(/블로그/g, '포스트'),
    tistory: (c) => c,
    blogger: (c) => c.replace(/안녕하세요/g, '안녕하세요 여러분'),
  };
  return (variants[platform] || ((c) => c))(content);
}

module.exports = {
  humanizeHtml,
  humanizeTitle,
  humanizeSentences,
  humanizePostTime,
  variantForPlatform,
};
