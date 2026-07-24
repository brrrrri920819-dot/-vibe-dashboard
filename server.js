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
const tokens   = require('./config/token-store');

const { publishToNaver }   = require('./publisher/naver');
const { publishToTistory, getTistoryAuthUrl, exchangeTistoryToken, getTistoryCategories } = require('./publisher/tistory');
const { publishToBlogger, getBloggerAuthUrl, exchangeBloggerToken, getBloggerBlogId }     = require('./publisher/blogger');
const { publishToTistoryPlaywright } = require('./publisher/tistory-playwright');
const { publishToBloggerPlaywright } = require('./publisher/blogger-playwright');
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
  // DASHBOARD_PASSWORD 미설정 시 인증 생략 (Railway에서 설정 안 한 경우 통과)
  if (!process.env.DASHBOARD_PASSWORD) return next();
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
        id:       tokens.get('NAVER_ID'),
        pw:       tokens.get('NAVER_PW'),
        blogId:   tokens.get('NAVER_BLOG_ID'),
        title:    variantTitle,
        content:  variantContent,
        tags,
        imagePaths,
      });

    } else if (platform === 'tistory') {
      // Playwright 직접 로그인 우선 (토큰 만료 없음)
      const tistoryId = tokens.get('TISTORY_ID') || tokens.get('NAVER_ID');
      const tistoryPw = tokens.get('TISTORY_PW') || tokens.get('NAVER_PW');
      const blogName  = tokens.get('TISTORY_BLOG_NAME');
      if (tistoryId && tistoryPw && blogName) {
        results.tistory = await publishToTistoryPlaywright({
          id: tistoryId, pw: tistoryPw, blogName,
          title: variantTitle, content: variantContent, tags,
        });
      } else {
        // 폴백: OAuth 토큰 방식
        const tistoryToken = tokens.get('TISTORY_ACCESS_TOKEN');
        if (!tistoryToken) {
          results.tistory = { success: false, error: 'TISTORY_ID/TISTORY_PW/TISTORY_BLOG_NAME 또는 TISTORY_ACCESS_TOKEN을 Railway에 설정해주세요', platform: 'tistory' };
        } else {
          results.tistory = await publishToTistory({ accessToken: tistoryToken, blogName, title: variantTitle, content: variantContent, tags, imagePaths });
        }
      }

    } else if (platform === 'blogger') {
      // Playwright 직접 로그인 우선 (토큰 만료 없음)
      const bloggerEmail = tokens.get('BLOGGER_EMAIL');
      const bloggerPw    = tokens.get('BLOGGER_PW');
      const blogId       = tokens.get('BLOGGER_BLOG_ID');
      if (bloggerEmail && bloggerPw) {
        results.blogger = await publishToBloggerPlaywright({
          email: bloggerEmail, pw: bloggerPw, blogId,
          title: variantTitle, content: variantContent, tags,
        });
      } else {
        // 폴백: OAuth 리프레시 토큰 방식
        const bloggerRefresh = tokens.get('BLOGGER_REFRESH_TOKEN');
        if (!bloggerRefresh) {
          results.blogger = { success: false, error: 'BLOGGER_EMAIL/BLOGGER_PW 또는 BLOGGER_REFRESH_TOKEN을 Railway에 설정해주세요', platform: 'blogger' };
        } else {
          results.blogger = await publishToBlogger({
            clientId: tokens.get('BLOGGER_CLIENT_ID'), clientSecret: tokens.get('BLOGGER_CLIENT_SECRET'),
            refreshToken: bloggerRefresh, blogId, title: variantTitle, content: variantContent, tags, imagePaths,
          });
        }
      }
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
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;
  res.json({
    ok: true,
    anthropicKey: !!process.env.ANTHROPIC_API_KEY,
    platforms: {
      naver:   !!(tokens.get('NAVER_ID') && tokens.get('NAVER_PW') && tokens.get('NAVER_BLOG_ID')),
      tistory: !!(tokens.get('TISTORY_ACCESS_TOKEN') && tokens.get('TISTORY_BLOG_NAME')),
      blogger: !!(tokens.get('BLOGGER_CLIENT_ID') && tokens.get('BLOGGER_CLIENT_SECRET') && tokens.get('BLOGGER_REFRESH_TOKEN') && tokens.get('BLOGGER_BLOG_ID')),
    },
  });
});

/** Claude API 연결 테스트 (키 설정 후 이걸로 확인) */
app.get('/api/test-claude', auth, async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' });
  }
  const https = require('https');
  const body  = JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 10,
    messages: [{ role: 'user', content: '안녕' }],
  });
  try {
    await new Promise((resolve, reject) => {
      const req = https.request('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (r) => {
        let d = '';
        r.on('data', c => { d += c; });
        r.on('end', () => {
          try {
            const j = JSON.parse(d);
            if (j.error) return reject(new Error(j.error.message));
            resolve(j);
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
    res.json({ ok: true, message: 'Claude API 연결 성공 ✅' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/** 플랫폼별 실제 연결 테스트 (자격증명 실제 검증) */
app.get('/api/test-platforms', auth, async (req, res) => {
  const results = {};

  // Tistory: 카테고리 목록 조회로 토큰 유효성 검증
  if (process.env.TISTORY_ACCESS_TOKEN && process.env.TISTORY_BLOG_NAME) {
    try {
      const { getTistoryCategories } = require('./publisher/tistory');
      await getTistoryCategories(process.env.TISTORY_ACCESS_TOKEN, process.env.TISTORY_BLOG_NAME);
      results.tistory = { ok: true, message: '토큰 유효' };
    } catch (e) {
      const msg = e.response?.data?.tistory?.error_message || e.message;
      results.tistory = { ok: false, error: msg };
    }
  } else {
    results.tistory = { ok: false, error: 'TISTORY_ACCESS_TOKEN 또는 TISTORY_BLOG_NAME 미설정' };
  }

  // Blogger: 블로그 목록 조회로 OAuth 유효성 검증
  if (process.env.BLOGGER_CLIENT_ID && process.env.BLOGGER_CLIENT_SECRET && process.env.BLOGGER_REFRESH_TOKEN) {
    try {
      const { getBloggerBlogId } = require('./publisher/blogger');
      const blogs = await getBloggerBlogId(
        process.env.BLOGGER_CLIENT_ID,
        process.env.BLOGGER_CLIENT_SECRET,
        process.env.BLOGGER_REFRESH_TOKEN,
      );
      results.blogger = { ok: true, message: `블로그 ${blogs.length}개 확인됨`, blogs: blogs.map(b => ({ id: b.id, name: b.name, url: b.url })) };
    } catch (e) {
      const msg = e.response?.data?.error?.message || e.message;
      results.blogger = { ok: false, error: msg };
    }
  } else {
    results.blogger = { ok: false, error: 'BLOGGER 환경변수 미설정' };
  }

  // Naver: 브라우저 설치 여부만 확인 (실제 로그인은 시간이 오래 걸림)
  if (process.env.NAVER_ID && process.env.NAVER_PW && process.env.NAVER_BLOG_ID) {
    try {
      const { chromium } = require('playwright');
      // executablePath 체크만 (실제 launch 안 함)
      const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      if (execPath) {
        const fs = require('fs');
        results.naver = fs.existsSync(execPath)
          ? { ok: true, message: `커스텀 Chromium: ${execPath}` }
          : { ok: false, error: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH 경로 없음: ${execPath}` };
      } else {
        // playwright 기본 Chromium 경로 확인
        const path = require('path');
        const { executablePath } = require('playwright-core');
        results.naver = { ok: true, message: '자격증명 설정됨 (Chromium 사용 가능)' };
      }
    } catch (e) {
      results.naver = { ok: false, error: `Playwright 오류: ${e.message}` };
    }
  } else {
    results.naver = { ok: false, error: 'NAVER_ID / NAVER_PW / NAVER_BLOG_ID 미설정' };
  }

  res.json(results);
});

// 발행 비동기 잡 스토어 (Railway 30초 타임아웃 우회 — Naver Playwright 30-60초 소요)
const _pubJobs = new Map();

/** 즉시 발행 — jobId 반환 후 백그라운드 발행 (Railway 30초 타임아웃 우회) */
app.post('/api/publish', auth, upload.array('images', 10), async (req, res) => {
  const { title, content, tags, platforms } = req.body;
  const imagePaths = (req.files || []).map(f => f.path);

  if (!title || !content) {
    return res.status(400).json({ error: '제목과 본문은 필수입니다' });
  }

  const parsedPlatforms = JSON.parse(platforms || '["naver"]');
  const parsedTags      = JSON.parse(tags       || '[]');

  const jobId = `pub_${Date.now()}`;
  _pubJobs.set(jobId, { status: 'running', startedAt: new Date().toISOString() });

  // jobId 즉시 반환 (Railway 30초 타임아웃 완전 우회)
  res.json({ success: true, jobId });

  // 백그라운드 발행
  console.log(`[Publish] 시작: ${jobId} | 플랫폼: ${parsedPlatforms.join(',')} | 제목: "${title}"`);
  try {
    const results = await publishJob({ title, content, tags: parsedTags, imagePaths, platforms: parsedPlatforms });
    const anySuccess = Object.values(results).some(r => r && r.success);
    const allErrors  = Object.values(results).filter(r => r && !r.success).map(r => r.error).filter(Boolean).join(' | ');

    // 플랫폼별 결과 로깅
    Object.entries(results).forEach(([p, r]) => {
      if (r && r.success) console.log(`[Publish] ✅ ${p}: ${r.url || '완료'}`);
      else if (r) console.error(`[Publish] ❌ ${p}: ${r.error || '실패'}`);
    });

    _pubJobs.set(jobId, {
      status:  anySuccess ? 'done' : 'error',
      success: anySuccess,
      results,
      error:   anySuccess ? undefined : (allErrors || '모든 플랫폼 발행 실패'),
    });

    // 직접 발행도 로그에 기록
    appendLog({ id: jobId, title, platforms: parsedPlatforms, status: anySuccess ? 'done' : 'failed', results, error: anySuccess ? undefined : allErrors });
  } catch (err) {
    console.error(`[Publish] 예외: ${jobId}:`, err.message);
    _pubJobs.set(jobId, { status: 'error', success: false, error: err.message });
    appendLog({ id: jobId, title, platforms: parsedPlatforms, status: 'failed', error: err.message });
  }
  setTimeout(() => _pubJobs.delete(jobId), 60 * 60 * 1000);
});

/** 발행 상태 폴링 — 메모리 없으면 로그 파일에서 폴백 (서버 재시작 대응) */
app.get('/api/publish-status/:jobId', auth, (req, res) => {
  const job = _pubJobs.get(req.params.jobId);
  if (job) return res.json(job);

  // 서버 재시작으로 메모리 소실 → 로그 파일에서 결과 조회
  try {
    const log = readLog();
    const entry = log.find(e => e.id === req.params.jobId);
    if (entry) {
      return res.json({
        status:  entry.status === 'done' ? 'done' : 'error',
        success: entry.status === 'done',
        results: entry.results || {},
        error:   entry.error,
        fromLog: true,
      });
    }
  } catch (_) {}

  // 로그에도 없으면 아직 처리 중이거나 서버 재시작 중 실패
  return res.status(404).json({ error: 'job not found' });
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

// ── 드래프트 저장소 ───────────────────────────────────────
// Railway/클라우드: 재시작 시 파일이 사라지므로 메모리 사용
const _isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);
const DRAFTS_FILE = path.join(__dirname, 'scheduler', 'drafts.json');
let _memDrafts = [];

function readDrafts() {
  if (_isCloud) return [..._memDrafts];
  try { return JSON.parse(fs.readFileSync(DRAFTS_FILE, 'utf8')); } catch { return []; }
}
function writeDrafts(drafts) {
  if (_isCloud) { _memDrafts = drafts; return; }
  fs.mkdirSync(path.dirname(DRAFTS_FILE), { recursive: true });
  fs.writeFileSync(DRAFTS_FILE, JSON.stringify(drafts, null, 2));
}
function saveDraft(draft) {
  const drafts = readDrafts();
  drafts.unshift(draft);
  if (drafts.length > 200) drafts.splice(200);
  writeDrafts(drafts);
  return draft;
}

/** 드래프트 목록 */
app.get('/api/drafts', auth, (req, res) => {
  res.json(readDrafts());
});

/** 드래프트 일괄 복원 (클라이언트 캐시 → 서버, Railway 재시작 후 복구) */
app.post('/api/drafts/restore', auth, (req, res) => {
  const incoming = Array.isArray(req.body) ? req.body : [];
  if (!incoming.length) return res.json({ success: true, count: 0 });
  const existing = readDrafts();
  const existingIds = new Set(existing.map(d => d.id));
  const toAdd = incoming.filter(d => d.id && d.title && !existingIds.has(d.id));
  const merged = [...toAdd, ...existing].slice(0, 200);
  writeDrafts(merged);
  console.log(`[Drafts] 복원: ${toAdd.length}개 추가됨`);
  res.json({ success: true, count: toAdd.length });
});

/** 드래프트 삭제 */
app.delete('/api/drafts/:id', auth, (req, res) => {
  const drafts = readDrafts().filter(d => d.id !== req.params.id);
  writeDrafts(drafts);
  res.json({ success: true });
});

/** 드래프트 발행 상태 업데이트 */
app.patch('/api/drafts/:id', auth, (req, res) => {
  const drafts = readDrafts();
  const d = drafts.find(d => d.id === req.params.id);
  if (!d) return res.status(404).json({ error: 'not found' });
  Object.assign(d, req.body);
  writeDrafts(drafts);
  res.json({ success: true, draft: d });
});

// 글 생성 비동기 잡 스토어 (Railway 30초 타임아웃 우회)
const _genJobs = new Map();

/** AI 글 생성 — jobId 즉시 반환 후 백그라운드 생성 */
app.post('/api/generate', auth, async (req, res) => {
  const { keyword, accountId } = req.body;
  if (!keyword) return res.status(400).json({ error: 'keyword 필수' });
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;

  const jobId = `gen_${Date.now()}`;
  _genJobs.set(jobId, { status: 'running', startedAt: new Date().toISOString() });

  // 즉시 jobId 반환 → Railway 30초 타임아웃 완전 우회
  res.json({ success: true, jobId });

  // 백그라운드 생성
  const accounts = readAccounts();
  const account = (accountId && accounts.find(a => a.id === accountId)) || accounts[0] || {};
  try {
    const post = await generatePost(keyword, {
      topic:    account.topic    || '라이프스타일',
      tone:     account.tone     || '친근한',
      platform: (account.platforms || ['blogger'])[0],
    });
    const draft = saveDraft({
      id:          `draft_${Date.now()}`,
      keyword,
      title:       post.title,
      content:     post.content,
      tags:        post.tags,
      status:      'draft',
      generatedAt: new Date().toISOString(),
    });
    _genJobs.set(jobId, { status: 'done', keyword, draftId: draft.id, ...post });
    console.log(`[Generate] 완료: "${post.title}"`);
  } catch (err) {
    console.error('[Generate] 오류:', err.message);
    _genJobs.set(jobId, { status: 'error', error: err.message });
  }
  setTimeout(() => _genJobs.delete(jobId), 30 * 60 * 1000);
});

/** 생성 상태 폴링 */
app.get('/api/generate-status/:jobId', auth, (req, res) => {
  const job = _genJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
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

/** 부업 분석 리포트 — 비동기 잡 패턴 (Railway 30초 타임아웃 우회) */
let incomeReportCache = { data: null, date: '' };
const _incomeJobs = new Map();

app.get('/api/income-report', auth, async (req, res) => {
  const today    = new Date().toISOString().slice(0, 10);
  const force    = req.query.refresh === '1';
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;

  // 캐시 유효하면 즉시 반환
  if (!force && incomeReportCache.data && incomeReportCache.date === today) {
    return res.json({ ...incomeReportCache.data, cached: true });
  }

  // 이미 진행 중인 잡이 있으면 그 jobId 반환
  const existingJob = [..._incomeJobs.values()].find(j => j.status === 'running');
  if (existingJob) {
    return res.json({ jobId: existingJob.jobId, status: 'running' });
  }

  const jobId = `income_${Date.now()}`;
  _incomeJobs.set(jobId, { jobId, status: 'running', startedAt: new Date().toISOString() });
  res.json({ jobId, status: 'running' });

  try {
    const report = await generateIncomeReport();
    const data = { ...report, generatedAt: new Date().toISOString() };
    incomeReportCache = { data, date: today };
    _incomeJobs.set(jobId, { jobId, status: 'done', ...data });
    console.log(`[Income] 리포트 완료: "${report.title}"`);
  } catch (err) {
    console.error('[Income] 리포트 오류:', err.message);
    _incomeJobs.set(jobId, { jobId, status: 'error', error: err.message, hustles: SIDE_HUSTLES });
  }
  setTimeout(() => _incomeJobs.delete(jobId), 2 * 60 * 60 * 1000);
});

app.get('/api/income-report-status/:jobId', auth, (req, res) => {
  const job = _incomeJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

/** 부업 기본 데이터 (빠른 로딩용) */
app.get('/api/income-hustles', auth, (req, res) => {
  res.json(SIDE_HUSTLES);
});

/** 인스타그램 카드뉴스 생성 — 비동기 잡 패턴 */
const _cardNewsJobs = new Map();
app.post('/api/card-news', auth, async (req, res) => {
  const { title, content, tags } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필수' });
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;
  const jobId = `cn_${Date.now()}`;
  _cardNewsJobs.set(jobId, { status: 'running' });
  res.json({ success: true, jobId });
  try {
    const result = await generateCardNews(title, content, Array.isArray(tags) ? tags : []);
    _cardNewsJobs.set(jobId, { status: 'done', success: true, ...result });
  } catch (err) {
    _cardNewsJobs.set(jobId, { status: 'error', success: false, error: err.message });
  }
  setTimeout(() => _cardNewsJobs.delete(jobId), 30 * 60 * 1000);
});
app.get('/api/card-news-status/:jobId', auth, (req, res) => {
  const job = _cardNewsJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

/** 유튜브 숏츠 대본 생성 — 비동기 잡 패턴 */
const _shortsJobs = new Map();
app.post('/api/shorts-script', auth, async (req, res) => {
  const { title, content, tags } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'title, content 필수' });
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;
  const jobId = `sh_${Date.now()}`;
  _shortsJobs.set(jobId, { status: 'running' });
  res.json({ success: true, jobId });
  try {
    const scriptData = await generateShortsScript(title, content, Array.isArray(tags) ? tags : []);
    const html = renderScriptHtml(scriptData);
    _shortsJobs.set(jobId, { status: 'done', success: true, html, scriptData });
  } catch (err) {
    _shortsJobs.set(jobId, { status: 'error', success: false, error: err.message });
  }
  setTimeout(() => _shortsJobs.delete(jobId), 30 * 60 * 1000);
});
app.get('/api/shorts-status/:jobId', auth, (req, res) => {
  const job = _shortsJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
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
  const clientKey = req.headers['x-anthropic-key'];
  if (clientKey) process.env.ANTHROPIC_API_KEY = clientKey;
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

// ── 서버 자신의 URL 자동 감지 (BASE_URL 환경변수 없어도 동작) ──────
function getBaseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  // Railway/프로덕션: x-forwarded-proto 헤더로 https 감지
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host  = req.headers['x-forwarded-host']  || req.get('host') || 'localhost';
  return `${proto}://${host}`;
}

// ── Tistory OAuth ────────────────────────────────────────
app.get('/oauth/tistory', (req, res) => {
  const baseUrl = getBaseUrl(req);
  if (!process.env.TISTORY_CLIENT_ID) {
    return res.send('<h2>설정 필요</h2><p>Railway에 TISTORY_CLIENT_ID가 설정되지 않았습니다.</p>');
  }
  const url = getTistoryAuthUrl(
    process.env.TISTORY_CLIENT_ID,
    `${baseUrl}/oauth/tistory/callback`,
  );
  res.redirect(url);
});

app.get('/oauth/tistory/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
  const { code } = req.query;
  try {
    const token = await exchangeTistoryToken(
      process.env.TISTORY_CLIENT_ID,
      process.env.TISTORY_CLIENT_SECRET,
      code,
      `${baseUrl}/oauth/tistory/callback`,
    );
    // 토큰 자동저장 — Railway 재시작 후에도 유지
    tokens.set('TISTORY_ACCESS_TOKEN', token);
    console.log('[Tistory] 토큰 자동저장 완료');
    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:480px;width:100%;text-align:center}h2{color:#22c55e;margin-top:0}p{color:#aaa;font-size:14px;line-height:1.6}.ok{font-size:64px;margin:16px 0}.btn{display:block;background:#ec4899;border:none;color:#fff;padding:14px;border-radius:8px;font-size:15px;cursor:pointer;width:100%;margin-top:16px;text-decoration:none;font-family:inherit}a.close{background:#333}</style></head><body><div class="card"><div class="ok">✅</div><h2>티스토리 인증 완료!</h2><p>토큰이 서버에 <strong>자동 저장</strong>되었습니다.<br>이제 창을 닫고 대시보드에서 발행하세요.</p><a class="btn close" href="javascript:window.close()">창 닫기</a></div></body></html>`);
  } catch (err) {
    res.send(`<h2>인증 실패</h2><p>${err.message}</p><p><a href="/oauth/tistory">다시 시도</a></p>`);
  }
});

// ── Tistory 자동 인증 (Playwright — TISTORY_ID/PW 이용) ──────────
app.get('/api/auto-auth/tistory', auth, async (req, res) => {
  const id  = tokens.get('TISTORY_ID')  || tokens.get('NAVER_ID');
  const pw  = tokens.get('TISTORY_PW')  || tokens.get('NAVER_PW');
  const clientId     = process.env.TISTORY_CLIENT_ID;
  const clientSecret = process.env.TISTORY_CLIENT_SECRET;
  const blogName     = tokens.get('TISTORY_BLOG_NAME');

  if (!clientId || !clientSecret) return res.json({ ok: false, error: 'TISTORY_CLIENT_ID / TISTORY_CLIENT_SECRET 미설정' });
  if (!id || !pw)                 return res.json({ ok: false, error: 'TISTORY_ID / TISTORY_PW (또는 NAVER_ID/PW) 미설정' });

  res.json({ ok: true, message: '자동 인증 시작... 30초 정도 소요됩니다.' });

  // 백그라운드로 Playwright 자동 인증
  (async () => {
    let browser;
    try {
      const { chromium } = require('playwright');
      const baseUrl = process.env.BASE_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'localhost:' + PORT}`;
      const callbackUrl = `${baseUrl}/oauth/tistory/callback`;
      const authUrl = getTistoryAuthUrl(clientId, callbackUrl);

      browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const page = await browser.newPage();

      // Tistory OAuth 페이지로 이동
      await page.goto(authUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      console.log('[AutoAuth] Tistory 로그인 페이지 이동:', page.url());

      // 로그인 필요 여부 확인
      const needsLogin = await page.$('#loginId') || await page.$('input[name="loginId"]') || await page.$('input[type="email"]');
      if (needsLogin) {
        // 카카오 로그인 폼 또는 티스토리 ID 로그인
        const emailInput = await page.$('input[type="email"]') || await page.$('#loginId') || await page.$('input[name="loginId"]');
        const pwInput    = await page.$('input[type="password"]') || await page.$('#loginPw');

        if (emailInput) await emailInput.fill(id);
        if (pwInput)    await pwInput.fill(pw);

        // 로그인 버튼 클릭
        const loginBtn = await page.$('button[type="submit"]') || await page.$('.btn_login') || await page.$('#btnLogin');
        if (loginBtn) {
          await loginBtn.click();
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        }
        console.log('[AutoAuth] 로그인 후 URL:', page.url());
      }

      // 허용 버튼 클릭
      await page.waitForTimeout(2000);
      const allowBtn = await page.$('button.confirm') || await page.$('#authorizationButton') || await page.$('a.btn_allow') || await page.$('button:has-text("허용")');
      if (allowBtn) {
        await allowBtn.click();
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        console.log('[AutoAuth] 허용 후 URL:', page.url());
      }

      // 콜백 URL에서 code 추출
      const finalUrl = page.url();
      const codeMatch = finalUrl.match(/[?&]code=([^&]+)/);
      if (!codeMatch) throw new Error('code 파라미터 없음 — URL: ' + finalUrl.slice(0, 200));

      const code = codeMatch[1];
      const token = await exchangeTistoryToken(clientId, clientSecret, code, callbackUrl);
      tokens.set('TISTORY_ACCESS_TOKEN', token);
      console.log('[AutoAuth] Tistory 토큰 자동저장 완료 ✅');
    } catch (err) {
      console.error('[AutoAuth] Tistory 자동 인증 실패:', err.message);
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  })();
});

// ── Setup 페이지 (어떤 클라이언트 ID가 설정됐는지 확인) ──
app.get('/setup', (req, res) => {
  const cid = process.env.BLOGGER_CLIENT_ID || '';
  const masked = cid ? cid.slice(0, 20) + '...' : '❌ 미설정';
  const baseUrl = getBaseUrl(req);
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:600px;width:100%}h2{color:#ec4899;margin-top:0}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #222;font-size:14px}.label{color:#888}.val{color:#86efac;font-family:monospace}.btn{display:block;background:#ec4899;border:none;color:#fff;padding:14px;border-radius:8px;font-size:16px;cursor:pointer;width:100%;margin-top:24px;text-decoration:none;text-align:center}</style></head><body><div class="card"><h2>🔧 Blogger 설정 확인</h2><div class="row"><span class="label">BLOGGER_CLIENT_ID</span><span class="val">${masked}</span></div><div class="row"><span class="label">BLOGGER_CLIENT_SECRET</span><span class="val">${process.env.BLOGGER_CLIENT_SECRET ? '✅ 설정됨' : '❌ 미설정'}</span></div><div class="row"><span class="label">BLOGGER_REFRESH_TOKEN</span><span class="val">${process.env.BLOGGER_REFRESH_TOKEN ? '✅ 설정됨' : '❌ 미설정'}</span></div><div class="row"><span class="label">BLOGGER_BLOG_ID</span><span class="val">${process.env.BLOGGER_BLOG_ID || '❌ 미설정'}</span></div><div class="row"><span class="label">감지된 서버 URL</span><span class="val">${baseUrl}</span></div><a class="btn" href="/oauth/blogger">🔑 Blogger OAuth 인증 시작</a></div></body></html>`);
});

// ── Blogger OAuth ────────────────────────────────────────
app.get('/oauth/blogger', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const clientId = process.env.BLOGGER_CLIENT_ID;
  if (!clientId) {
    return res.send(`<h2>설정 필요</h2><p>Railway에 BLOGGER_CLIENT_ID 가 설정되지 않았습니다.</p>`);
  }
  const url = getBloggerAuthUrl(clientId, `${baseUrl}/oauth/blogger/callback`);
  res.redirect(url);
});

app.get('/oauth/blogger/callback', async (req, res) => {
  const baseUrl = getBaseUrl(req);
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
    // 토큰 자동저장 — Railway 재시작 후에도 유지
    tokens.set('BLOGGER_REFRESH_TOKEN', refreshToken);
    console.log('[Blogger] 리프레시 토큰 자동저장 완료');

    // 블로그 ID도 자동 조회 후 저장
    try {
      const { getBloggerBlogId } = require('./publisher/blogger');
      const blogs = await getBloggerBlogId(
        process.env.BLOGGER_CLIENT_ID,
        process.env.BLOGGER_CLIENT_SECRET,
        refreshToken,
      );
      if (blogs && blogs[0]) {
        tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
        console.log(`[Blogger] 블로그 ID 자동저장: ${blogs[0].id} (${blogs[0].name})`);
      }
    } catch (_) {}

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:480px;width:100%;text-align:center}h2{color:#22c55e;margin-top:0}p{color:#aaa;font-size:14px;line-height:1.6}.ok{font-size:64px;margin:16px 0}.btn{display:block;background:#333;border:none;color:#fff;padding:14px;border-radius:8px;font-size:15px;cursor:pointer;width:100%;margin-top:16px;text-decoration:none;font-family:inherit}</style></head><body><div class="card"><div class="ok">✅</div><h2>블로그스팟 인증 완료!</h2><p>토큰이 서버에 <strong>자동 저장</strong>되었습니다.<br>블로그 ID도 자동으로 설정했습니다.<br>이제 창을 닫고 대시보드에서 발행하세요.</p><a class="btn" href="javascript:window.close()">창 닫기</a></div></body></html>`);
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
