/**
 * scripts/run-daily.js
 * GitHub Actions에서 직접 실행되는 데일리 파이프라인
 * 서버 없이 단독 실행 가능
 */

require('dotenv').config();
const { fetchAllTrending }  = require('../keywords/fetcher');
const { matchAllAccounts }  = require('../keywords/matcher');
const { generatePost }      = require('../content/generator');
const { publishToNaver }    = require('../publisher/naver');
const { publishToTistory }  = require('../publisher/tistory');
const { publishToBlogger }  = require('../publisher/blogger');
const { humanizeHtml, humanizeTitle, humanizePostTime, variantForPlatform } = require('../humanizer');
const https = require('https');

// ── 계정 설정 로드 ───────────────────────────────────────
// GitHub Secret ACCOUNTS_JSON 또는 data/accounts.json 파일 사용
function loadAccounts() {
  if (process.env.ACCOUNTS_JSON) {
    try { return JSON.parse(process.env.ACCOUNTS_JSON); } catch {}
  }
  try {
    const fs = require('fs'), path = require('path');
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'accounts.json'), 'utf8'));
  } catch {}
  return [];
}

// ── 키워드 중복 체크 (메모리, Actions는 매번 새로 시작) ─
const usedToday = new Set();

// ── 발행 함수 ────────────────────────────────────────────
async function publishPost(account, keyword, post) {
  const platforms = account.platforms || [account.platform].filter(Boolean);
  const results = {};

  for (const platform of platforms) {
    const content = variantForPlatform(humanizeHtml(post.content), platform);
    const title   = humanizeTitle(post.title);

    let r;
    if (platform === 'naver' && process.env.NAVER_ID) {
      r = await publishToNaver({ id: process.env.NAVER_ID, pw: process.env.NAVER_PW, blogId: process.env.NAVER_BLOG_ID, title, content, tags: post.tags });
    } else if (platform === 'tistory' && process.env.TISTORY_ACCESS_TOKEN) {
      r = await publishToTistory({ accessToken: process.env.TISTORY_ACCESS_TOKEN, blogName: process.env.TISTORY_BLOG_NAME, title, content, tags: post.tags });
    } else if (platform === 'blogger' && process.env.BLOGGER_CLIENT_ID) {
      r = await publishToBlogger({ clientId: process.env.BLOGGER_CLIENT_ID, clientSecret: process.env.BLOGGER_CLIENT_SECRET, refreshToken: process.env.BLOGGER_REFRESH_TOKEN, blogId: process.env.BLOGGER_BLOG_ID, title, content, tags: post.tags });
    } else {
      r = { success: false, error: '환경변수 미설정', platform };
    }

    if (r) results[platform] = r;

    // 플랫폼 간 딜레이
    if (platforms.indexOf(platform) < platforms.length - 1) {
      await sleep(3000 + Math.random() * 5000);
    }
  }

  return results;
}

// ── 텔레그램 전송 ────────────────────────────────────────
function sendTelegram(msg) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Promise.resolve();

  const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
  return new Promise(resolve => {
    const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── 메인 ─────────────────────────────────────────────────
async function main() {
  console.log('\n[Daily] ━━━ GitHub Actions 데일리 파이프라인 시작 ━━━');
  console.log('[Daily] 시각:', new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }));

  const accounts = loadAccounts().filter(a => a.enabled);
  console.log(`[Daily] 활성 계정: ${accounts.length}개`);

  if (accounts.length === 0) {
    console.log('[Daily] 계정 없음. ACCOUNTS_JSON 시크릿을 확인해주세요.');
    await sendTelegram('⚠️ 블로그 자동 발행: 계정 설정이 없습니다.\nGitHub Secrets > ACCOUNTS_JSON 을 설정해주세요.');
    process.exit(0);
  }

  // 키워드 수집
  const allSeeds = [...new Set(accounts.flatMap(a => a.topicSeeds || []))];
  const trending = await fetchAllTrending({
    naverClientId:     process.env.NAVER_CLIENT_ID,
    naverClientSecret: process.env.NAVER_CLIENT_SECRET,
    seedKeywords:      allSeeds,
  });

  if (trending.length === 0) {
    console.log('[Daily] 트렌딩 키워드 수집 실패');
    await sendTelegram('⚠️ 블로그 자동 발행: 오늘 키워드 수집에 실패했습니다.');
    process.exit(0);
  }

  const topKw = trending.slice(0, 5).map(k => `#${k.keyword}`).join(' ');
  console.log(`[Daily] 트렌딩 Top5: ${topKw}`);

  // 계정별 매칭
  const matched = matchAllAccounts(accounts, trending)
    .filter(m => !usedToday.has(m.keyword));

  const summaryLines = [];
  let successCount = 0;

  for (let i = 0; i < matched.length; i++) {
    const { account, keyword } = matched[i];
    usedToday.add(keyword);

    console.log(`\n[Daily] [${account.name}] 키워드: "${keyword}" 글 생성 중...`);

    let post;
    try {
      post = await generatePost(keyword, account);
    } catch (err) {
      console.error(`[Daily] 글 생성 실패:`, err.message);
      summaryLines.push(`❌ [${account.name}] 글 생성 실패`);
      continue;
    }

    // 계정 간 발행 시간 분산 (30초~2분 딜레이)
    if (i > 0) await sleep(30000 + Math.random() * 90000);

    let results;
    try {
      results = await publishPost(account, keyword, post);
    } catch (err) {
      console.error(`[Daily] 발행 오류:`, err.message);
      summaryLines.push(`❌ [${account.name}] 발행 오류: ${err.message}`);
      continue;
    }

    // 결과 정리
    const ICONS = { naver: '🟢', tistory: '🟠', blogger: '🔵' };
    const resultLines = Object.entries(results).map(([p, r]) => {
      const icon = ICONS[p] || p;
      return r.success
        ? `  ${icon} ${p} ✅ <a href="${r.url}">${r.url}</a>`
        : `  ${icon} ${p} ❌ ${r.error || '실패'}`;
    });

    summaryLines.push(`📝 <b>${post.title}</b>\n  계정: ${account.name} | 키워드: #${keyword}\n${resultLines.join('\n')}`);
    successCount++;

    console.log(`[Daily] [${account.name}] 완료:`, Object.entries(results).map(([p,r]) => `${p}:${r.success?'✅':'❌'}`).join(' '));
  }

  // 텔레그램 최종 알림
  const header = successCount > 0
    ? `🚀 <b>오늘 블로그 자동 발행 완료</b> (${successCount}/${matched.length}건)`
    : '⚠️ <b>오늘 블로그 자동 발행 결과</b>';

  const msg = `${header}\n\n${summaryLines.join('\n\n')}\n\n🔥 오늘 트렌딩: ${topKw}`;
  await sendTelegram(msg);

  console.log(`\n[Daily] ━━━ 완료: ${successCount}건 발행됨 ━━━\n`);
}

main().catch(async err => {
  console.error('[Daily] 치명적 오류:', err);
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (token && chatId) {
    const body = JSON.stringify({ chat_id: chatId, text: `🔴 블로그 자동 발행 오류: ${err.message}`, parse_mode: 'HTML' });
    await new Promise(resolve => {
      const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => { res.resume(); res.on('end', resolve); });
      req.on('error', () => resolve());
      req.write(body); req.end();
    });
  }
  process.exit(1);
});
