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
});
