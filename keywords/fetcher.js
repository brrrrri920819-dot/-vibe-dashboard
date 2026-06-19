/**
 * keywords/fetcher.js
 * 실시간 키워드 수집 — 네이버 DataLab + Google Trends KR
 * 외부 의존성 없이 내장 https 모듈만 사용
 */

const https = require('https');
const http  = require('http');

// ── 공통 fetch 헬퍼 ────────────────────────────────────
function fetchUrl(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, {
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/html, */*',
        ...opts.headers,
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ── 1. 네이버 DataLab 검색어 트렌드 ────────────────────
// https://developers.naver.com/docs/serviceapi/datalab/search/guide.md
async function fetchNaverDatalab(clientId, clientSecret, keywords) {
  if (!clientId || !clientSecret) return [];

  const today = new Date();
  const endDate   = today.toISOString().slice(0, 10);
  const startDate = new Date(today - 7 * 86400000).toISOString().slice(0, 10);

  // 키워드 그룹별로 트렌드 조회
  const keywordGroups = keywords.slice(0, 5).map((kw, i) => ({
    groupName: `group${i}`,
    keywords: [kw],
  }));

  const body = JSON.stringify({
    startDate,
    endDate,
    timeUnit: 'date',
    keywordGroups,
  });

  try {
    const res = await fetchUrl('https://openapi.naver.com/v1/datalab/search', {
      method: 'POST',
      headers: {
        'X-Naver-Client-Id':     clientId,
        'X-Naver-Client-Secret': clientSecret,
        'Content-Type':          'application/json',
      },
      body,
    });

    if (res.status !== 200) return [];
    const data = JSON.parse(res.body);

    // 최근 7일 평균 비율 기준으로 정렬
    return (data.results || []).map(r => {
      const avg = r.data.reduce((s, d) => s + d.ratio, 0) / r.data.length;
      return { keyword: r.title.replace('group', keywords[parseInt(r.title.replace('group',''))]), score: avg, source: 'naver_datalab' };
    }).sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

// ── 2. 네이버 쇼핑 인기 검색어 (비공식) ───────────────
async function fetchNaverShoppingTrends() {
  try {
    const res = await fetchUrl('https://www.naver.com/');
    // 실시간 검색어 2021년 폐지 → 쇼핑 트렌드 키워드 파싱
    const matches = res.body.match(/"keyword":"([^"]+)"/g) || [];
    return [...new Set(matches.map(m => m.replace(/"keyword":"|"/g, '')))]
      .slice(0, 30)
      .map(k => ({ keyword: k, score: 50, source: 'naver_main' }));
  } catch {
    return [];
  }
}

// ── 3. Google Trends KR (RSS) ──────────────────────────
async function fetchGoogleTrends() {
  try {
    const res = await fetchUrl('https://trends.google.com/trends/trendingsearches/daily/rss?geo=KR');
    const titles = [];
    const regex = /<title><!\[CDATA\[([^\]]+)\]\]><\/title>|<title>([^<]+)<\/title>/g;
    let m;
    let i = 0;
    while ((m = regex.exec(res.body)) !== null) {
      const kw = (m[1] || m[2] || '').trim();
      if (kw && !kw.includes('Google') && i++ < 30) {
        titles.push({ keyword: kw, score: 90 - i, source: 'google_trends' });
      }
    }
    return titles;
  } catch {
    return [];
  }
}

// ── 4. 다음 실시간 이슈 (비공식) ──────────────────────
async function fetchDaumTrends() {
  try {
    const res = await fetchUrl('https://www.daum.net/');
    const regex = /class="link_issue[^"]*"[^>]*>([^<]+)</g;
    const results = [];
    let m;
    let rank = 1;
    while ((m = regex.exec(res.body)) !== null && rank <= 20) {
      const kw = m[1].trim();
      if (kw) results.push({ keyword: kw, score: 80 - rank * 2, source: 'daum', rank: rank++ });
    }
    return results;
  } catch {
    return [];
  }
}

// ── 5. Zum 실시간 이슈 ─────────────────────────────────
async function fetchZumTrends() {
  try {
    const res = await fetchUrl('https://zum.com/');
    const regex = /"keyword"\s*:\s*"([^"]+)"/g;
    const results = [];
    let m;
    let rank = 1;
    while ((m = regex.exec(res.body)) !== null && rank <= 20) {
      results.push({ keyword: m[1].trim(), score: 75 - rank * 2, source: 'zum', rank: rank++ });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * 전체 소스에서 키워드 수집 후 중복 제거 + 점수 합산 정렬
 * @param {object} options
 * @returns {Promise<Array<{keyword, score, source}>>}
 */
async function fetchAllTrending(options = {}) {
  const { naverClientId, naverClientSecret, seedKeywords = [] } = options;

  console.log('[Keywords] 실시간 키워드 수집 시작...');

  const [google, daum, zum] = await Promise.allSettled([
    fetchGoogleTrends(),
    fetchDaumTrends(),
    fetchZumTrends(),
  ]);

  const raw = [
    ...(google.status === 'fulfilled' ? google.value : []),
    ...(daum.status === 'fulfilled'   ? daum.value   : []),
    ...(zum.status === 'fulfilled'    ? zum.value     : []),
  ];

  // DataLab는 시드 키워드 필요 시 추가 호출
  if (naverClientId && seedKeywords.length > 0) {
    const dl = await fetchNaverDatalab(naverClientId, naverClientSecret, seedKeywords);
    raw.push(...dl);
  }

  // 중복 제거 + 점수 합산
  const map = new Map();
  for (const item of raw) {
    const key = item.keyword.toLowerCase();
    if (map.has(key)) {
      map.get(key).score += item.score * 0.5; // 여러 소스에 등장하면 보너스
      map.get(key).sources.push(item.source);
    } else {
      map.set(key, { ...item, sources: [item.source] });
    }
  }

  const result = [...map.values()]
    .filter(k => k.keyword.length >= 2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  console.log(`[Keywords] ${result.length}개 키워드 수집 완료`);
  return result;
}

module.exports = { fetchAllTrending };
