/**
 * server.js — 블로그 자동 발행 서버
 * 포트: process.env.PORT (기본 3000)
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

const { publishToNaver }   = require('./publisher/naver');
const { publishToTistory, getTistoryAuthUrl, exchangeTistoryToken, getTistoryCategories } = require('./publisher/tistory');
const { publishToBlogger, getBloggerAuthUrl, exchangeBloggerToken, getBloggerBlogId }     = require('./publisher/blogger');
const { humanizeHtml, humanizeTitle, humanizePostTime, variantForPlatform } = require('./humanizer');
const { notifyPublished } = require('./telegram');
const { enqueue, readQueue, readLog, startScheduler } = require('./scheduler/queue');
const { startDailyCron, runDailyPipeline, readAccounts, writeAccounts } = require('./keywords/daily');
const { generatePost } = require('./content/generator');
const { crawlAffiliates } = require('./affiliates/crawler');
const { generateIncomeReport, SIDE_HUSTLES } = require('./income/analyzer');
const { generateCardNews }                  = require('./content/card-news');
const { generateShortsScript, renderScriptHtml } = require('./content/shorts-script');
const { loginAffiliate, getAffiliateStats, getAllStats } = require('./affiliates/login-manager');
const { executePipeline, getPipelineStatus }             = require('./income/hustle-pipeline');
const cron = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── 미들웨어 ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// 이미지 업로드 설정
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// ── 인증 미들웨어 ────────────────────────────────────────
function auth(req, res, next) {
  const pw = req.headers['x-dashboard-password'] || req.query.pw;
  if (pw !== process.env.DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: '인증 실패' });
  }
  next();
}

// ── 메인 발행 함수 ────────────────────────────────────────
async function publishJob(job) {
  // 한달 예약 자동생성: 발행 시점에 최신 트렌딩 키워드로 글 생성
  if (job.autoGenerate && !job.content) {
    const { fetchAllTrending } = require('./keywords/fetcher');
    const accounts = readAccounts();
    const account  = (job.accountId && accounts.find(a => a.id === job.accountId)) || accounts[0];
    if (!account) throw new Error('계정 없음 — 계정·주제 관리에서 계정을 추가해주세요');

    const trending = await fetchAllTrending({
      naverClientId:     process.env.NAVER_CLIENT_ID,
      naverClientSecret: process.env.NAVER_CLIENT_SECRET,
      seedKeywords:      account.topicSeeds || [],
    });
    const keyword = trending[0]?.keyword || '오늘의 트렌드';
    console.log(`[AutoGen] 키워드 "${keyword}" 로 글 생성 중...`);
    const post = await generatePost(keyword, account);
    job.title   = post.title;
    job.content = post.content;
    job.tags    = post.tags;
    job.keyword = keyword;
  }

  const results = {};
  const { title, content, tags, imagePaths = [], platforms } = job;

  for (const platform of platforms) {
    // 플랫폼마다 약간 다른 버전 사용
    const variantContent = variantForPlatform(humanizeHtml(content), platform);
    const variantTitle   = humanizeTitle(title);

    if (platform === 'naver') {
      results.naver = await publishToNaver({
        id:       process.env.NAVER_ID,
        pw:       process.env.NAVER_PW,
        blogId:   process.env.NAVER_BLOG_ID,
        title:    variantTitle,
        content:  variantContent,
        tags,
        imagePaths,
      });

    } else if (platform === 'tistory') {
      results.tistory = await publishToTistory({
        accessToken: process.env.TISTORY_ACCESS_TOKEN,
        blogName:    process.env.TISTORY_BLOG_NAME,
        title:       variantTitle,
        content:     variantContent,
        tags,
        imagePaths,
      });

    } else if (platform === 'blogger') {
      results.blogger = await publishToBlogger({
        clientId:     process.env.BLOGGER_CLIENT_ID,
        clientSecret: process.env.BLOGGER_CLIENT_SECRET,
        refreshToken: process.env.BLOGGER_REFRESH_TOKEN,
        blogId:       process.env.BLOGGER_BLOG_ID,
        title:        variantTitle,
        content:      variantContent,
        tags,
        imagePaths,
      });
    }

    // 플랫폼 간 자연스러운 딜레이 (3~8초)
    if (platforms.indexOf(platform) < platforms.length - 1) {
      await new Promise(r => setTimeout(r, 3000 + Math.random() * 5000));
    }
  }

  await notifyPublished(title, results);
  return results;
}

// ── API 라우트 ────────────────────────────────────────────

/** 상태 체크 */
app.get('/api/status', auth, (req, res) => {
  res.json({
    ok: true,
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    platforms: {
      naver:   !!(process.env.NAVER_ID && process.env.NAVER_PW),
      tistory: !!process.env.TISTORY_ACCESS_TOKEN,
      blogger: !!(process.env.BLOGGER_CLIENT_ID && process.env.BLOGGER_REFRESH_TOKEN),
    },
  });
});

/** 즉시 발행 */
app.post('/api/publish', auth, upload.array('images', 10), async (req, res) => {
  const { title, content, tags, platforms } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!title || !content) {
    return res.status(400).json({ error: '제목과 본문은 필수입니다' });
  }

  const parsedPlatforms = JSON.parse(platforms || '["naver"]');
  const parsedTags      = JSON.parse(tags       || '[]');

  try {
    const results = await publishJob({ title, content, tags: parsedTags, imagePaths, platforms: parsedPlatforms });
    res.json({ success: true, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 예약 발행 */
app.post('/api/schedule', auth, upload.array('images', 10), (req, res) => {
  const { title, content, tags, platforms, scheduledAt } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!title || !content || !scheduledAt) {
    return res.status(400).json({ error: '제목, 본문, 예약시간은 필수입니다' });
  }

  // 사람처럼 예약 시간 ±15분 랜덤화
  const humanizedTime = humanizePostTime(new Date(scheduledAt));

  const job = {
    id:          `job_${Date.now()}`,
    title,
    content,
    tags:        JSON.parse(tags || '[]'),
    imagePaths,
    platforms:   JSON.parse(platforms || '["naver"]'),
    scheduledAt: humanizedTime.toISOString(),
  };

  enqueue(job);
  res.json({ success: true, jobId: job.id, scheduledAt: job.scheduledAt });
});

/** 큐 조회 */
app.get('/api/queue', auth, (req, res) => {
  res.json(readQueue());
});

/** 발행 로그 조회 */
app.get('/api/log', auth, (req, res) => {
  res.json(readLog());
});

// ── 트렌딩 키워드 API ────────────────────────────────────
const { fetchAllTrending } = require('./keywords/fetcher');
let trendingCache = { data: [], fetchedAt: 0 };

app.get('/api/trending', auth, async (req, res) => {
  const now = Date.now();
  // 30분 캐시
  if (now - trendingCache.fetchedAt < 30 * 60 * 1000 && trendingCache.data.length > 0) {
    return res.json(trendingCache.data);
  }
  const accounts = readAccounts();
  const seeds = [...new Set(accounts.flatMap(a => a.topicSeeds || []))];
  const data = await fetchAllTrending({
    naverClientId:     process.env.NAVER_CLIENT_ID,
    naverClientSecret: process.env.NAVER_CLIENT_SECRET,
    seedKeywords:      seeds,
  });
  trendingCache = { data, fetchedAt: now };
  res.json(data);
});

/** AI 글 즉시 생성 (발행 전 미리보기용) */
app.post('/api/generate', auth, async (req, res) => {
  const { keyword, accountId } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword 필수' });
  const accounts = readAccounts();
  const account = (accountId && accounts.find(a => a.id === accountId)) || accounts[0] || {};
  try {
    const post = await generatePost(keyword, {
      topic:    account.topic    || '라이프스타일',
      tone:     account.tone     || '친근한',
      platform: (account.platforms || ['blogger'])[0],
    });
    res.json({ success: true, keyword, ...post });
  } catch (err) {
    console.error('[Generate] 오류:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 한달치 자동발행 예약 */
app.post('/api/month-schedule', auth, (req, res) => {
  const { startDate, postsPerDay = 1, postHours = [9, 19], accountId } = req.body;
  const accounts = readAccounts();
  const account  = (accountId && accounts.find(a => a.id === accountId)) || accounts[0];
  if (!account) return res.status(400).json({ error: '계정을 먼저 설정해주세요' });

  const start = startDate ? new Date(startDate) : new Date();
  start.setHours(0, 0, 0, 0);
  if (start <= new Date()) start.setDate(start.getDate() + 1);

  const jobs = [];
  const hours = postHours.slice(0, Math.min(postsPerDay, 3));
  for (let day = 0; day < 30; day++) {
    const dayDate = new Date(start);
    dayDate.setDate(dayDate.getDate() + day);
    for (const h of hours) {
      const scheduledAt = new Date(dayDate);
      const jitter = Math.floor(Math.random() * 20);
      scheduledAt.setHours(h, jitter, 0, 0);
      const job = {
        id:           `month_${Date.now()}_d${day}_h${h}`,
        title:        `[자동발행] ${dayDate.toLocaleDateString('ko-KR')} ${h}시`,
        content:      '',
        tags:         [],
        imagePaths:   [],
        platforms:    account.platforms || ['blogger'],
        scheduledAt:  scheduledAt.toISOString(),
        autoGenerate: true,
        accountId:    account.id,
        source:       'month_schedule',
      };
      enqueue(job);
      jobs.push(job);
    }
  }
  res.json({ success: true, count: jobs.length, firstPost: jobs[0]?.scheduledAt, lastPost: jobs[jobs.length - 1]?.scheduledAt });
});

/** 제휴 인텔리전스 */
let affiliateCache = { data: null, fetchedAt: 0 };
app.get('/api/affiliates', auth, async (req, res) => {
  const now = Date.now();
  const forceRefresh = req.query.refresh === '1';
  if (!forceRefresh && affiliateCache.data && now - affiliateCache.fetchedAt < 60 * 60 * 1000) {
    return res.json(affiliateCache.data);
  }
  const data = await crawlAffiliates().catch(() => affiliateCache.data || {});
  affiliateCache = { data, fetchedAt: now };
  res.json(data);
});

/** 부업 분석 리포트 (캐시: 오늘 하루) */
let incomeReportCache = { data: null, date: '' };

app.get('/api/income-report', auth, async (req, res) => {
  const today  = new Date().toISOString().slice(0, 10);
  const force  = req.query.refresh === '1';
  if (!force && incomeReportCache.data && incomeReportCache.date === today) {
    return res.json(incomeReportCache.data);
  }
  try {
    const report = await generateIncomeReport();
    incomeReportCache = { data: { ...report, generatedAt: new Date().toISOString() }, date: today };
    res.json(incomeReportCache.data);
  } catch (err) {
    res.status(500).json({ error: err.message, hustles: SIDE_HUSTLES });
  }
});

/** 부업 기본 데이터 (빠른 로딩용) */
app.get('/api/income-hustles', auth, (req, res) => {
  res.json(SIDE_HUSTLES);
});

/** 인스타그램 카드뉴스 생성 */
app.post('/api/card-news', auth, async (req, res) => {
  const { title, content, tags } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필수' });
  try {
    const result = await generateCardNews(title, content, Array.isArray(tags) ? tags : []);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/** 유튜브 숏츠 대본 생성 */
app.post('/api/shorts-script', auth, async (req, res) => {
  const { title, content, tags } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필수' });
  try {
    const scriptData = await generateShortsScript(title, content, Array.isArray(tags) ? tags : []);
    const html       = renderScriptHtml(scriptData);
    res.json({ success: true, html, scriptData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 제휴 로그인 & 통계 API ────────────────────────────────
app.post('/api/affiliates/login/:siteKey', auth, async (req, res) => {
  const { siteKey } = req.params;
  try {
    const result = await loginAffiliate(siteKey);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/affiliates/stats', auth, async (req, res) => {
  try {
    const stats = await getAllStats();
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 부업 파이프라인 API ───────────────────────────────────
app.post('/api/hustle-pipeline/:hustleId', auth, async (req, res) => {
  const { hustleId } = req.params;
  try {
    const result = await executePipeline(hustleId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/hustle-pipeline/:hustleId', auth, async (req, res) => {
  const { hustleId } = req.params;
  try {
    const result = await getPipelineStatus(hustleId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 계정 관리 API ─────────────────────────────────────────
app.get('/api/accounts', auth, (req, res) => {
  res.json(readAccounts());
});

app.post('/api/accounts', auth, (req, res) => {
  const accounts = req.body;
  if (!Array.isArray(accounts)) return res.status(400).json({ error: 'array required' });
  writeAccounts(accounts);
  res.json({ success: true });
});

app.post('/api/accounts/run-now', auth, async (req, res) => {
  res.json({ success: true, message: '데일리 파이프라인 시작됨' });
  runDailyPipeline().catch(err => console.error('[API] 파이프라인 오류:', err.message));
});

// ── 공개 통계 API (인증 불필요) ──────────────────────────
app.get('/api/public', (req, res) => {
  const log = readLog();
  const today = new Date().toISOString().slice(0, 10);

  const todayPosts = log.filter(j => j.loggedAt && j.loggedAt.startsWith(today));
  const donePosts  = log.filter(j => j.status === 'done');
  const successRate = log.length > 0 ? Math.round(donePosts.length / log.length * 100) : 0;

  const recentPosts = log.slice(0, 20).map(j => ({
    title:     j.title,
    status:    j.status,
    platforms: j.platforms || [],
    loggedAt:  j.loggedAt,
    keyword:   j.keyword,
    urls: j.results
      ? Object.entries(j.results)
          .filter(([, r]) => r && r.url)
          .reduce((acc, [p, r]) => { acc[p] = r.url; return acc; }, {})
      : {},
  }));

  res.json({
    ok: true,
    stats: {
      total:       log.length,
      today:       todayPosts.length,
      successRate,
      done:        donePosts.length,
    },
    recentPosts,
    trending: trendingCache.data.slice(0, 10).map(k => k.keyword),
    fetchedAt: new Date().toISOString(),
  });
});

// ── Tistory OAuth ────────────────────────────────────────
app.get('/oauth/tistory', (req, res) => {
  const url = getTistoryAuthUrl(
    process.env.TISTORY_CLIENT_ID,
    `http://localhost:${PORT}/oauth/tistory/callback`,
  );
  res.redirect(url);
});

app.get('/oauth/tistory/callback', async (req, res) => {
  const { code } = req.query;
  const token = await exchangeTistoryToken(
    process.env.TISTORY_CLIENT_ID,
    process.env.TISTORY_CLIENT_SECRET,
    code,
    `http://localhost:${PORT}/oauth/tistory/callback`,
  );
  res.send(`<h2>티스토리 인증 완료!</h2><p>아래 토큰을 .env 의 TISTORY_ACCESS_TOKEN 에 저장하세요:</p><code>${token}</code>`);
});

// ── Setup 페이지 (어떤 클라이언트 ID가 설정됐는지 확인) ──
app.get('/setup', (req, res) => {
  const cid = process.env.BLOGGER_CLIENT_ID || '';
  const masked = cid ? cid.slice(0, 20) + '...' : '❌ 미설정';
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:600px;width:100%}h2{color:#ec4899;margin-top:0}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #222;font-size:14px}.label{color:#888}.val{color:#86efac;font-family:monospace}.btn{display:block;background:#ec4899;border:none;color:#fff;padding:14px;border-radius:8px;font-size:16px;cursor:pointer;width:100%;margin-top:24px;text-decoration:none;text-align:center}</style></head><body><div class="card"><h2>🔧 Blogger 설정 확인</h2><div class="row"><span class="label">BLOGGER_CLIENT_ID</span><span class="val">${masked}</span></div><div class="row"><span class="label">BLOGGER_CLIENT_SECRET</span><span class="val">${process.env.BLOGGER_CLIENT_SECRET ? '✅ 설정됨' : '❌ 미설정'}</span></div><div class="row"><span class="label">BLOGGER_REFRESH_TOKEN</span><span class="val">${process.env.BLOGGER_REFRESH_TOKEN ? '✅ 설정됨' : '❌ 미설정'}</span></div><div class="row"><span class="label">BLOGGER_BLOG_ID</span><span class="val">${process.env.BLOGGER_BLOG_ID || '❌ 미설정'}</span></div><a class="btn" href="/oauth/blogger">🔑 Blogger OAuth 인증 시작</a></div></body></html>`);
});

// ── Blogger OAuth ────────────────────────────────────────
app.get('/oauth/blogger', (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const clientId = process.env.BLOGGER_CLIENT_ID;
  if (!clientId) {
    return res.send(`<h2>설정 필요</h2><p>Railway에 BLOGGER_CLIENT_ID 가 설정되지 않았습니다.</p>`);
  }
  const url = getBloggerAuthUrl(clientId, `${baseUrl}/oauth/blogger/callback`);
  res.redirect(url);
});

app.get('/oauth/blogger/callback', async (req, res) => {
  const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
  const { code, error } = req.query;
  if (error) {
    return res.send(`<h2>인증 실패</h2><p>오류: ${error}</p><p><a href="/oauth/blogger">다시 시도</a></p>`);
  }
  try {
    const { accessToken, refreshToken } = await exchangeBloggerToken(
      process.env.BLOGGER_CLIENT_ID,
      process.env.BLOGGER_CLIENT_SECRET,
      code,
      `${baseUrl}/oauth/blogger/callback`,
    );
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:600px;width:100%}h2{color:#ec4899;margin-top:0}p{color:#aaa;font-size:14px}.token{background:#0d0d1a;border:1px solid #444;border-radius:8px;padding:16px;word-break:break-all;font-family:monospace;font-size:13px;color:#86efac;margin:16px 0}.btn{background:#ec4899;border:none;color:#fff;padding:12px 24px;border-radius:8px;font-size:15px;cursor:pointer;width:100%;margin-top:8px}p.tip{background:#1e2a1e;border:1px solid #2d4a2d;border-radius:8px;padding:12px;color:#86efac;font-size:13px}</style></head><body><div class="card"><h2>✅ Blogger 인증 완료!</h2><p>아래 토큰을 Railway의 <strong>BLOGGER_REFRESH_TOKEN</strong> 에 저장하세요:</p><div class="token" id="token">${refreshToken}</div><button class="btn" onclick="navigator.clipboard.writeText('${refreshToken}').then(()=>this.textContent='✅ 복사됨!')">📋 토큰 복사</button><p class="tip">💡 Railway → Variables → BLOGGER_REFRESH_TOKEN 값을 위 토큰으로 교체하세요.</p></div></body></html>`);
  } catch (err) {
    res.send(`<h2>토큰 교환 실패</h2><p>${err.message}</p><p><a href="/oauth/blogger">다시 시도</a></p>`);
  }
});

// ── 서버 시작 ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 블로그 자동 발행 서버 시작: http://localhost:${PORT}`);
  console.log(`   대시보드: http://localhost:${PORT}/index.html`);
  console.log(`   티스토리 인증: http://localhost:${PORT}/oauth/tistory`);
  console.log(`   Blogger 인증: http://localhost:${PORT}/oauth/blogger\n`);
  startScheduler(publishJob);
  startDailyCron();

  // 매일 09:00 부업 분석 리포트 자동 생성 + 발행
  cron.schedule('0 9 * * *', async () => {
    console.log('[Income] 09:00 부업 리포트 자동 발행 시작');
    const accounts = readAccounts().filter(a => a.enabled);
    if (accounts.length === 0) return;
    const account = accounts[0];
    try {
      const report = await generateIncomeReport();
      incomeReportCache = { data: { ...report, generatedAt: new Date().toISOString() }, date: new Date().toISOString().slice(0, 10) };
      const platforms = account.platforms || ['blogger'];
      enqueue({
        id:          `income_${Date.now()}`,
        title:       report.title,
        content:     report.content,
        tags:        report.tags,
        imagePaths:  [],
        platforms,
        scheduledAt: new Date().toISOString(),
        accountId:   account.id,
        keyword:     '부업',
        source:      'income_daily',
      });
      console.log(`[Income] 발행 예약: "${report.title}"`);
      await notifyPublished(report.title, { income_report: { success: true, summary: report.summary } });
    } catch (err) {
      console.error('[Income] 리포트 생성 오류:', err.message);
    }
  }, { timezone: 'Asia/Seoul' });
  console.log('[Income] 부업 리포트 크론 등록됨 (매일 09:00 KST)');
});
