/**
 * keywords/matcher.js
 * 계정별 주제에 맞는 트렌딩 키워드 매칭
 * - 주제 시드 키워드와 트렌딩 키워드 간 유사도 계산
 */

/**
 * 계정 주제와 트렌딩 키워드를 매칭
 * @param {object} account - 계정 설정 객체
 * @param {Array}  trending - fetchAllTrending() 결과
 * @returns {Array} - 점수순 정렬된 매칭 키워드 배열
 */
function matchKeywords(account, trending) {
  const topicSeeds = normalizeSeeds(account.topicSeeds || []);
  const topicName  = (account.topic || '').toLowerCase();

  return trending
    .map(item => {
      const kw = item.keyword.toLowerCase();
      let matchScore = 0;

      // 1. 시드 키워드 직접 포함 여부
      for (const seed of topicSeeds) {
        if (kw.includes(seed) || seed.includes(kw)) {
          matchScore += 100;
          break;
        }
      }

      // 2. 주제명과 키워드 간 글자 겹침
      const topicChars = new Set(topicName.split(''));
      const kwChars    = kw.split('');
      const overlap    = kwChars.filter(c => topicChars.has(c)).length;
      matchScore += overlap * 10;

      // 3. 금지어 필터 (계정에 exclude 설정 시)
      const excludes = (account.exclude || []).map(e => e.toLowerCase());
      if (excludes.some(ex => kw.includes(ex))) return null;

      return { ...item, matchScore, totalScore: item.score + matchScore };
    })
    .filter(Boolean)
    .filter(item => item.matchScore > 0)
    .sort((a, b) => b.totalScore - a.totalScore)
    .slice(0, 5); // 계정당 최대 5개 후보
}

function normalizeSeeds(seeds) {
  return seeds.map(s => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * 모든 계정에 대해 키워드 매칭 수행
 * @param {Array} accounts
 * @param {Array} trending
 * @returns {Array} - [{account, keyword, score}, ...]
 */
function matchAllAccounts(accounts, trending) {
  const results = [];
  for (const account of accounts) {
    if (!account.enabled) continue;
    const matched = matchKeywords(account, trending);
    if (matched.length > 0) {
      // 계정당 상위 1개 키워드 선택
      results.push({ account, keyword: matched[0].keyword, score: matched[0].totalScore, allMatched: matched });
    }
  }
  return results;
}

module.exports = { matchKeywords, matchAllAccounts };
