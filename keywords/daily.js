/**
 * keywords/daily.js
 * 데일리 자동화 파이프라인
 * 스케줄: 매일 오전 8시 (cron: '0 8 * * *')
 *
 * 흐름: 키워드 수집 → 계정 매칭 → AI 글 생성 → 발행 큐 등록
 */

const cron     = require('node-cron');
const fs       = require('fs');
const path     = require('path');
const { fetchAllTrending }  = require('./fetcher');
const { matchAllAccounts }  = require('./matcher');
const { generatePost }      = require('../content/generator');
const { enqueue }           = require('../scheduler/queue');
const { notifyPublished }   = require('../telegram');

const ACCOUNTS_FILE    = path.join(__dirname, '..', 'data', 'accounts.json');
const KW_HISTORY_FILE  = path.join(__dirname, '..', 'data', 'kw_history.json');
const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);

let memAccounts = [];
let memHistory  = {};

// ── 계정 목록 I/O ────────────────────────────────────────
function readAccounts() {
  if (isCloud) return memAccounts;
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8')); }
  catch { return []; }
}

function writeAccounts(accounts) {
  if (isCloud) { memAccounts = accounts; return; }
  if (!fs.existsSync(path.dirname(ACCOUNTS_FILE))) fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

// ── 키워드 사용 이력 (중복 발행 방지) ───────────────────
function readHistory() {
  if (isCloud) return memHistory;
  try { return JSON.parse(fs.readFileSync(KW_HISTORY_FILE, 'utf8')); }
  catch { return {}; }
}

function markUsed(accountId, keyword) {
  const h = readHistory();
  if (!h[accountId]) h[accountId] = [];
  h[accountId].push({ keyword, usedAt: new Date().toISOString() });
  h[accountId] = h[accountId].slice(-90);
  if (isCloud) { memHistory = h; return; }
  fs.writeFileSync(KW_HISTORY_FILE, JSON.stringify(h, null, 2));
}

function wasUsedRecently(accountId, keyword, days = 14) {
  const h = readHistory();
  if (!h[accountId]) return false;
  const cutoff = Date.now() - days * 86400000;
  return h[accountId].some(e =>
    e.keyword === keyword && new Date(e.usedAt).getTime() > cutoff,
  );
}

// ── 발행 시간 분산 (계정간 겹치지 않게) ─────────────────
function spreadPublishTime(baseHour, index) {
  // 오전 8시부터 계정당 20~40분 간격
  const jitter = Math.floor(Math.random() * 20);
  const minutes = index * 30 + jitter;
  const now = new Date();
  now.setHours(baseHour, minutes, 0, 0);
  if (now < new Date()) now.setDate(now.getDate() + 1);
  return now.toISOString();
}

// ── 메인 파이프라인 ──────────────────────────────────────
async function runDailyPipeline() {
  console.log('\n[Daily] ━━━ 데일리 파이프라인 시작', new Date().toLocaleString('ko-KR'), '━━━');

  const accounts = readAccounts().filter(a => a.enabled);
  if (accounts.length === 0) {
    console.log('[Daily] 활성화된 계정 없음. 종료.');
    return;
  }

  // 1. 키워드 수집
  const allSeeds = [...new Set(accounts.flatMap(a => a.topicSeeds || []))];
  const trending = await fetchAllTrending({
    naverClientId:     process.env.NAVER_CLIENT_ID,
    naverClientSecret: process.env.NAVER_CLIENT_SECRET,
    seedKeywords:      allSeeds,
  });

  if (trending.length === 0) {
    console.log('[Daily] 키워드 수집 결과 없음. 종료.');
    return;
  }
  console.log(`[Daily] 수집된 트렌딩 키워드 Top5: ${trending.slice(0,5).map(k=>k.keyword).join(', ')}`);

  // 2. 계정별 매칭
  const matched = matchAllAccounts(accounts, trending);
  console.log(`[Daily] ${matched.length}개 계정 키워드 매칭 완료`);

  const results = [];

  for (let i = 0; i < matched.length; i++) {
    const { account, keyword, allMatched } = matched[i];

    // 최근 발행한 키워드면 2순위로 대체
    let finalKeyword = keyword;
    if (wasUsedRecently(account.id, keyword)) {
      const alt = allMatched.find(m => !wasUsedRecently(account.id, m.keyword));
      if (!alt) {
        console.log(`[Daily] [${account.id}] 모든 후보 키워드 최근 사용됨. 스킵.`);
        continue;
      }
      finalKeyword = alt.keyword;
    }

    console.log(`[Daily] [${account.id}] 키워드: "${finalKeyword}" → 글 생성 중...`);

    // 3. AI 글 생성
    let post;
    try {
      post = await generatePost(finalKeyword, account);
    } catch (err) {
      console.error(`[Daily] [${account.id}] 글 생성 실패:`, err.message);
      continue;
    }

    // 4. 발행 큐 등록 (시간 분산)
    const scheduledAt = spreadPublishTime(8, i);
    const platforms   = account.platforms || [account.platform].filter(Boolean) || ['naver'];

    enqueue({
      id:          `daily_${account.id}_${Date.now()}`,
      title:       post.title,
      content:     post.content,
      tags:        post.tags,
      imagePaths:  [],
      platforms,
      scheduledAt,
      accountId:   account.id,
      keyword:     finalKeyword,
      source:      'daily_auto',
    });

    markUsed(account.id, finalKeyword);

    results.push({
      accountId: account.id,
      keyword:   finalKeyword,
      title:     post.title,
      scheduledAt,
      platforms,
    });

    console.log(`[Daily] [${account.id}] 예약 등록: "${post.title}" → ${new Date(scheduledAt).toLocaleString('ko-KR')}`);

    // 글 생성 간 딜레이 (API rate limit 방지)
    await new Promise(r => setTimeout(r, 2000));
  }

  // 5. 텔레그램 요약 알림
  if (results.length > 0) {
    await sendDailySummary(results, trending.slice(0, 10));
  }

  console.log(`[Daily] ━━━ 완료: ${results.length}개 글 예약됨 ━━━\n`);
  return results;
}

async function sendDailySummary(results, topKeywords) {
  const { notifyPublished } = require('../telegram');
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const https = require('https');
  const lines = results.map((r, i) =>
    `${i+1}. [${r.accountId}] <b>${r.title}</b>\n   키워드: #${r.keyword} | ${new Date(r.scheduledAt).toLocaleTimeString('ko-KR', {hour:'2-digit',minute:'2-digit'})} 예약`,
  );

  const kwList = topKeywords.slice(0, 5).map(k => `#${k.keyword}`).join(' ');
  const msg = `📅 <b>오늘의 자동 발행 스케줄</b>\n\n${lines.join('\n\n')}\n\n🔥 오늘 트렌딩: ${kwList}`;

  const body = JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'HTML' });
  await new Promise((resolve) => {
    const req = https.request(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

/**
 * 데일리 크론 등록 (매일 오전 6시에 수집 + 큐 등록, 오전 8시부터 순차 발행)
 */
function startDailyCron() {
  // 매일 오전 6시에 파이프라인 실행
  cron.schedule('0 6 * * *', () => {
    runDailyPipeline().catch(err => console.error('[Daily] 파이프라인 오류:', err.message));
  }, { timezone: 'Asia/Seoul' });

  console.log('[Daily] 데일리 크론 등록됨 (매일 06:00 KST)');
}

module.exports = { startDailyCron, runDailyPipeline, readAccounts, writeAccounts };
