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
const { enqueue, readQueue, readLog, startScheduler } = require('./scheduler/queue');

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

// ── Blogger OAuth ────────────────────────────────────────
app.get('/oauth/blogger', (req, res) => {
  const url = getBloggerAuthUrl(
    process.env.BLOGGER_CLIENT_ID,
    `http://localhost:${PORT}/oauth/blogger/callback`,
  );
  res.redirect(url);
});

app.get('/oauth/blogger/callback', async (req, res) => {
  const { code } = req.query;
  const { accessToken, refreshToken } = await exchangeBloggerToken(
    process.env.BLOGGER_CLIENT_ID,
    process.env.BLOGGER_CLIENT_SECRET,
    code,
    `http://localhost:${PORT}/oauth/blogger/callback`,
  );
  res.send(`<h2>Blogger 인증 완료!</h2><p>BLOGGER_REFRESH_TOKEN:</p><code>${refreshToken}</code>`);
});

// ── 서버 시작 ────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 블로그 자동 발행 서버 시작: http://localhost:${PORT}`);
  console.log(`   대시보드: http://localhost:${PORT}/index.html`);
  console.log(`   티스토리 인증: http://localhost:${PORT}/oauth/tistory`);
  console.log(`   Blogger 인증: http://localhost:${PORT}/oauth/blogger\n`);
  startScheduler(publishJob);
});
