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

// ── 인증 미들웨어 (비활성화 — Railway URL 자체가 개인 보안) ──
function auth(req, res, next) { next(); }

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
      const tistoryId = tokens.get('TISTORY_ID');
      const tistoryPw = tokens.get('TISTORY_PW');
      // TISTORY_BLOG_NAME: 풀 URL 입력해도 앞부분만 추출 (예: abc.tistory.com → abc)
      const rawBlogName = tokens.get('TISTORY_BLOG_NAME') || '';
      const blogName = rawBlogName.replace(/\.tistory\.com.*$/, '').replace(/https?:\/\//, '').trim();
      if (tistoryId && tistoryPw && blogName) {
        results.tistory = await publishToTistoryPlaywright({
          id: tistoryId, pw: tistoryPw, blogName,
          title: variantTitle, content: variantContent, tags,
        });
      } else {
        results.tistory = { success: false, error: 'Railway에 TISTORY_ID / TISTORY_PW / TISTORY_BLOG_NAME 설정 필요', platform: 'tistory' };
      }

    } else if (platform === 'blogger') {
      const blogId       = tokens.get('BLOGGER_BLOG_ID');
      const clientId     = tokens.get('BLOGGER_CLIENT_ID');
      const clientSecret = tokens.get('BLOGGER_CLIENT_SECRET');
      const refreshToken = tokens.get('BLOGGER_REFRESH_TOKEN');

      if (clientId && clientSecret && refreshToken) {
        // OAuth 방식 (가장 안정적 — 자동 갱신)
        results.blogger = await publishToBlogger({
          clientId, clientSecret, refreshToken, blogId,
          title: variantTitle, content: variantContent, tags,
        });
        // 토큰 갱신 후 blogId 자동저장
        if (results.blogger.success && results.blogger.blogId && !blogId) {
          tokens.set('BLOGGER_BLOG_ID', results.blogger.blogId);
        }
      } else {
        // Playwright 폴백 (BLOGGER_EMAIL/PW 있을 때)
        const bloggerEmail = tokens.get('BLOGGER_EMAIL');
        const bloggerPw    = tokens.get('BLOGGER_PW');
        if (bloggerEmail && bloggerPw) {
          results.blogger = await publishToBloggerPlaywright({
            email: bloggerEmail, pw: bloggerPw, blogId,
            title: variantTitle, content: variantContent, tags,
          });
        } else {
          results.blogger = { success: false, error: '설정 탭 > 블로그스팟 인증하기 버튼을 클릭해서 Google 연결 필요', platform: 'blogger' };
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
      tistory: !!(tokens.get('TISTORY_ID') && tokens.get('TISTORY_PW') &&
                  (tokens.get('TISTORY_BLOG_NAME') || '').replace(/\.tistory\.com.*$/, '').trim()),
      blogger: !!(tokens.get('BLOGGER_REFRESH_TOKEN') ||
                  (tokens.get('BLOGGER_EMAIL') && tokens.get('BLOGGER_PW'))),
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

  // Tistory: Playwright 방식 — 환경변수 존재 여부만 확인
  if (tokens.get('TISTORY_ID') && tokens.get('TISTORY_PW') && tokens.get('TISTORY_BLOG_NAME')) {
    results.tistory = { ok: true, message: `Playwright 로그인 방식 (${tokens.get('TISTORY_BLOG_NAME')})` };
  } else {
    results.tistory = { ok: false, error: 'TISTORY_ID / TISTORY_PW / TISTORY_BLOG_NAME 미설정' };
  }

  // Blogger: OAuth 방식 — 실제로 토큰 갱신 + 블로그 목록 조회까지 검증
  const bClientId     = tokens.get('BLOGGER_CLIENT_ID');
  const bClientSecret = tokens.get('BLOGGER_CLIENT_SECRET');
  const bRefreshToken = tokens.get('BLOGGER_REFRESH_TOKEN');
  if (bClientId && bClientSecret && bRefreshToken) {
    try {
      const blogs = await getBloggerBlogId(bClientId, bClientSecret, bRefreshToken);
      if (blogs.length > 0) {
        if (!tokens.get('BLOGGER_BLOG_ID')) tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
        results.blogger = { ok: true, message: `OAuth 연결됨 — ${blogs[0].name} (${blogs.length}개 블로그)` };
      } else {
        results.blogger = { ok: false, error: '인증은 됐으나 소유한 Blogger 블로그가 없습니다' };
      }
    } catch (e) {
      const g = e.response?.data || {};
      let msg = g.error_description || g.error?.message || e.message;
      if (e.response?.status === 403) {
        msg = 'Blogger API가 꺼져 있습니다 — console.cloud.google.com/apis/library/blogger.googleapis.com 에서 「사용」 클릭 후 1분 뒤 재시도';
      }
      results.blogger = { ok: false, error: `OAuth 검증 실패: ${msg}` };
    }
  } else if (tokens.get('BLOGGER_EMAIL') && tokens.get('BLOGGER_PW')) {
    results.blogger = { ok: true, message: `Playwright 로그인 방식 (${tokens.get('BLOGGER_EMAIL')})` };
  } else {
    results.blogger = { ok: false, error: '설정 > 구글 계정 연결 버튼으로 인증 필요' };
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

// ── Blogger 자격증명 즉석 검증 (가짜 code로 토큰 교환 시도 → 에러 종류로 판정) ──
app.get('/api/blogger-cred-test', async (req, res) => {
  const cid = tokens.get('BLOGGER_CLIENT_ID');
  const sec = tokens.get('BLOGGER_CLIENT_SECRET');
  if (!cid || !sec) return res.json({ ok: false, verdict: 'ID 또는 시크릿 미설정' });
  try {
    const axios = require('axios');
    await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: cid.trim(),
      client_secret: sec.trim(),
      code: 'diagnostic_fake_code',
      redirect_uri: 'https://localhost/cb',
      grant_type: 'authorization_code',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    res.json({ ok: true, verdict: '✅ 자격증명 정상' });
  } catch (err) {
    const e = err.response?.data?.error || '';
    if (e === 'invalid_grant') {
      // code가 가짜라서 나는 에러 = ID/시크릿 자체는 통과
      res.json({ ok: true, verdict: '✅ ID/시크릿 정상 — 인증 버튼 다시 눌러보세요' });
    } else if (e === 'invalid_client') {
      res.json({ ok: false, verdict: '❌ ID/시크릿 짝이 틀림 — 구글 콘솔에서 같은 클라이언트의 ID+시크릿인지 확인', raw: err.response?.data });
    } else {
      res.json({ ok: false, verdict: `❓ ${e || err.message}`, raw: err.response?.data });
    }
  }
});

// ── Blogger 자격증명 직접 입력 + 즉석 검증 + 저장 ──
app.post('/api/blogger-cred-set', async (req, res) => {
  // 사파리가 URL처럼 생긴 값에 http:// 를 자동으로 붙이는 경우 제거
  const cid = (req.body.clientId || '').trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const sec = (req.body.clientSecret || '').trim();
  if (!cid || !sec) return res.json({ ok: false, verdict: 'ID와 시크릿 둘 다 입력하세요' });
  try {
    const axios = require('axios');
    await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
      client_id: cid, client_secret: sec,
      code: 'diagnostic_fake_code',
      redirect_uri: 'https://localhost/cb',
      grant_type: 'authorization_code',
    }).toString(), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    tokens.set('BLOGGER_CLIENT_ID', cid);
    tokens.set('BLOGGER_CLIENT_SECRET', sec);
    res.json({ ok: true, verdict: '✅ 정상! 저장 완료 — 아래 인증 버튼을 누르세요' });
  } catch (err) {
    const e = err.response?.data?.error || '';
    if (e === 'invalid_grant') {
      // 가짜 code 때문에 나는 에러 = ID/시크릿은 통과 → 저장
      tokens.set('BLOGGER_CLIENT_ID', cid);
      tokens.set('BLOGGER_CLIENT_SECRET', sec);
      return res.json({ ok: true, verdict: '✅ 정상! 저장 완료 — 아래 인증 버튼을 누르세요' });
    }
    if (e === 'invalid_client') {
      return res.json({ ok: false, verdict: '❌ 구글이 이 ID/시크릿 짝을 거부했습니다 — 같은 OAuth 클라이언트의 값인지 확인하세요' });
    }
    res.json({ ok: false, verdict: `❓ ${e || err.message}` });
  }
});

/* ── 연결 상태 자동 점검 ──────────────────────────────────
 * 구글 리프레시 토큰은 방치하면 만료되고(특히 OAuth 앱이 '테스트' 상태면 7일),
 * 그때야 발행이 실패하면서 끊긴 걸 알게 된다.
 * 6시간마다 실제로 구글과 통신해 살아있는지 확인하고,
 * 끊겼으면 즉시 알림을 보내 발행 실패 전에 손 쓸 수 있게 한다. */
let _bloggerHealth = { checkedAt: null, ok: null, detail: '아직 확인 안 함' };

async function checkBloggerHealth(notify = true) {
  const cid = tokens.get('BLOGGER_CLIENT_ID');
  const sec = tokens.get('BLOGGER_CLIENT_SECRET');
  const ref = tokens.get('BLOGGER_REFRESH_TOKEN');
  if (!cid || !sec || !ref) {
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: false, detail: '자격증명 없음 — 구글 계정 연결 필요' };
    return _bloggerHealth;
  }
  try {
    const blogs = await getBloggerBlogId(cid, sec, ref);
    if (!tokens.get('BLOGGER_BLOG_ID') && blogs[0]) tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: true, detail: blogs[0] ? blogs[0].name : '연결됨' };
    console.log(`[Health] Blogger 정상 — ${_bloggerHealth.detail}`);
  } catch (e) {
    const g = e.response?.data || {};
    let detail = g.error_description || g.error?.message || e.message;
    if (e.response?.status === 403) {
      detail = 'Blogger API 비활성 — 구글 콘솔 API 라이브러리에서 Blogger API를 「사용」으로 켜세요';
    }
    if (g.error === 'invalid_grant') {
      detail = '토큰 만료 — 재연결 필요. OAuth 앱이 "테스트" 상태면 7일마다 만료되니 "프로덕션"으로 전환하세요';
    }
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: false, detail };
    console.error(`[Health] Blogger 끊김 — ${detail}`);
    if (notify) {
      try {
        await notifyPublished('⚠️ 블로그스팟 연결 끊김', {
          blogger: { success: false, error: detail + ' → /setup 에서 재연결하세요' },
        });
      } catch (_) {}
    }
  }
  return _bloggerHealth;
}

app.get('/api/health/blogger', auth, async (req, res) => {
  if (req.query.refresh === '1' || !_bloggerHealth.checkedAt) await checkBloggerHealth(false);
  res.json({ ..._bloggerHealth, storage: tokens.storageInfo() });
});

/** Blogger 연결 진단 — 어느 단계에서 막혔는지 한 번에 알려준다 */
app.get('/api/blogger-diagnose', auth, async (req, res) => {
  const steps = [];
  const cid = tokens.get('BLOGGER_CLIENT_ID');
  const sec = tokens.get('BLOGGER_CLIENT_SECRET');
  const ref = tokens.get('BLOGGER_REFRESH_TOKEN');

  const where = (k) => tokens.sourceOf(k) === 'env' ? ' [Railway 환경변수]'
                     : tokens.sourceOf(k) === 'saved' ? ' [이 화면에서 저장됨]' : '';

  steps.push({ step: '1. 클라이언트 ID', ok: !!cid, detail: (cid ? cid.slice(0, 22) + '…' : '없음') + where('BLOGGER_CLIENT_ID') });
  steps.push({ step: '2. 클라이언트 시크릿', ok: !!sec, detail: (sec ? `${sec.slice(0, 7)}… (${sec.length}자)` : '없음') + where('BLOGGER_CLIENT_SECRET') });
  steps.push({ step: '3. 리프레시 토큰', ok: !!ref, detail: (ref ? `저장됨 (${ref.length}자)` : '없음 — 구글 계정 연결 필요') + where('BLOGGER_REFRESH_TOKEN') });

  if (cid && sec && ref) {
    try {
      const blogs = await getBloggerBlogId(cid, sec, ref);
      if (blogs.length) {
        if (!tokens.get('BLOGGER_BLOG_ID')) tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
        steps.push({ step: '4. 구글 통신', ok: true, detail: `연결됨 — ${blogs[0].name}` });
      } else {
        steps.push({ step: '4. 구글 통신', ok: false, detail: '인증은 됐으나 소유한 블로그가 없음' });
      }
    } catch (e) {
      const g = e.response?.data || {};
      let hint = g.error_description || e.message;
      if (g.error === 'invalid_grant') hint = '토큰 만료/취소됨 — 구글 계정 연결을 다시 하세요. (OAuth 앱이 "테스트" 상태면 7일마다 만료되니 "프로덕션"으로 전환하세요)';
      if (g.error === 'invalid_client') {
        hint = tokens.sourceOf('BLOGGER_CLIENT_SECRET') === 'env'
          ? 'Railway 환경변수의 BLOGGER_CLIENT_SECRET 이 틀렸습니다 — Railway에서 그 변수를 삭제하거나 올바른 값으로 고치세요'
          : 'ID/시크릿 짝이 맞지 않음 — 아래 폼에 같은 클라이언트의 값을 다시 입력하세요';
      }
      steps.push({ step: '4. 구글 통신', ok: false, detail: hint });
    }
  } else {
    steps.push({ step: '4. 구글 통신', ok: false, detail: '앞 단계 완료 후 확인 가능' });
  }

  const firstFail = steps.find(s => !s.ok);
  res.json({ ok: !firstFail, steps, blocked: firstFail ? firstFail.step : null, storage: tokens.keys() });
});

/* ── 자격증명 자동 복구 ────────────────────────────────────
 * Railway는 배포할 때마다 컨테이너를 새로 만들기 때문에 config/tokens.json 이
 * 사라진다. 그래서 코드를 고칠 때마다 Blogger 연결이 끊겼다.
 * 대시보드(같은 도메인)의 localStorage에 사본을 두고, 페이지가 열릴 때
 * 서버에 없는 값만 되돌려 넣어 스스로 복구되게 한다. */
const RESTORABLE = ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'BLOGGER_BLOG_ID'];

app.post('/api/credentials/restore', auth, (req, res) => {
  const incoming = req.body || {};
  const restored = [];
  for (const key of RESTORABLE) {
    const val = typeof incoming[key] === 'string' ? incoming[key].trim() : '';
    if (!val) continue;
    /* 이 프로세스에서 직접 저장된 값('saved')만 보호한다.
       환경변수('env')는 틀린 값이 들어있을 수 있으므로 브라우저 사본으로 덮어쓴다.
       — 예전엔 "값이 있으면 건너뛰기"여서 Railway의 잘못된 시크릿이
         올바른 값의 복구를 계속 막았다. 이게 invalid_client 반복의 원인. */
    if (tokens.sourceOf(key) === 'saved' && tokens.get(key) === val) continue;
    if (tokens.sourceOf(key) === 'saved' && key === 'BLOGGER_REFRESH_TOKEN') continue; // 방금 발급된 토큰이 최신
    tokens.set(key, val);
    restored.push(key);
  }
  if (restored.length) console.log(`[Restore] 자격증명 복구됨: ${restored.join(', ')}`);
  res.json({ ok: true, restored });
});

/** 대시보드가 보관할 자격증명 사본 (복구용)
 *  검증을 거쳐 저장된 값('saved')만 내려준다 —
 *  환경변수 값까지 내려주면 틀린 값이 브라우저 사본을 오염시킨다 */
app.get('/api/credentials/backup', auth, (req, res) => {
  const out = {};
  for (const key of RESTORABLE) {
    if (tokens.sourceOf(key) !== 'saved') continue;
    out[key] = tokens.get(key);
  }
  res.json(out);
});

// ── 애드센스 필수 페이지 3종 발행 ──
// 소개/개인정보처리방침/문의가 없으면 심사에서 신뢰도 부족으로 거절된다.
const _adsenseJobs = new Map();
app.post('/api/adsense-pages', auth, async (req, res) => {
  const { buildAdsensePages } = require('./content/adsense-pages');
  const { blogName, topic, ownerName, contactEmail, siteUrl, platforms } = req.body;
  let pages;
  try {
    pages = buildAdsensePages({ blogName, topic, ownerName, contactEmail, siteUrl });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const targets = Array.isArray(platforms) && platforms.length ? platforms : ['blogger'];

  const jobId = `ads_${Date.now()}`;
  _adsenseJobs.set(jobId, { status: 'running', total: pages.length, done: 0, results: [] });
  res.json({ success: true, jobId, pages: pages.map(p => p.title) });

  (async () => {
    const results = [];
    for (const page of pages) {
      try {
        const r = await publishJob({
          title: page.title, content: page.content, tags: page.tags,
          imagePaths: [], platforms: targets,
        });
        const ok = Object.values(r).some(x => x && x.success);
        results.push({ title: page.title, success: ok, detail: r });
        console.log(`[AdSense] ${ok ? '✅' : '❌'} "${page.title}"`);
      } catch (e) {
        results.push({ title: page.title, success: false, error: e.message });
        console.error(`[AdSense] ❌ "${page.title}": ${e.message}`);
      }
      _adsenseJobs.set(jobId, { status: 'running', total: pages.length, done: results.length, results });
      await new Promise(r2 => setTimeout(r2, 4000));
    }
    _adsenseJobs.set(jobId, {
      status: 'done', total: pages.length, done: results.length, results,
      success: results.every(r => r.success),
    });
  })().catch(e => _adsenseJobs.set(jobId, { status: 'error', error: e.message }));

  setTimeout(() => _adsenseJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/adsense-pages-status/:jobId', auth, (req, res) => {
  const job = _adsenseJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

// ── 이미지 검증 페이지 — 키워드로 실제 사진을 눈으로 확인 ──
app.get('/images', async (req, res) => {
  const q = (req.query.q || '').trim();
  const { fetchImage } = require('./content/generator');
  let cards = '';
  if (q) {
    const kws = q.split(',').map(s => s.trim()).filter(Boolean).slice(0, 6);
    const imgs = await Promise.all(kws.map((k, i) => fetchImage(k, i).catch(e => ({ url: '', credit: e.message, source: 'error' }))));
    cards = imgs.map((im, i) => `<figure class="shot">
      <div class="thumb">${im.url ? `<img src="${im.url}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">` : ''}</div>
      <figcaption><span class="kw">${kws[i].replace(/[<>&]/g, '')}</span><span class="src src-${im.source}">${im.source}</span>
      ${im.credit ? `<span class="cr">${String(im.credit).replace(/[<>&]/g, '').slice(0, 60)}</span>` : ''}</figcaption></figure>`).join('');
  }
  res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>이미지 검증</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Pretendard','Apple SD Gothic Neo',-apple-system,sans-serif;color:#eef0ff;min-height:100vh;padding:28px 16px 64px;line-height:1.5;
 background:radial-gradient(1000px 560px at 80% -10%,rgba(236,72,153,.1),transparent 60%),#080b14;background-attachment:fixed}
.wrap{max-width:900px;margin:0 auto}
h1{font-size:19px;font-weight:700;letter-spacing:-.3px;margin-bottom:4px}
.sub{color:#7c85b0;font-size:12.5px;margin-bottom:20px}
form{display:flex;gap:9px;margin-bottom:22px;flex-wrap:wrap}
input{flex:1;min-width:240px;background:#141728;border:1px solid #252840;border-radius:10px;color:#eef0ff;padding:12px 13px;font-size:13.5px;font-family:inherit;outline:none}
input:focus{border-color:#ec4899;box-shadow:0 0 0 3px rgba(236,72,153,.14)}
button{background:linear-gradient(135deg,#ec4899,#f43f5e);border:none;color:#fff;border-radius:10px;padding:12px 22px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px}
.shot{background:#0e1120;border:1px solid #1e2238;border-radius:14px;overflow:hidden}
.thumb{aspect-ratio:1200/630;background:#141728;display:flex;align-items:center;justify-content:center;position:relative}
.thumb img{width:100%;height:100%;object-fit:cover;display:block}
.thumb.broken::after{content:'❌ 로드 실패 (핫링크 차단)';position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(239,68,68,.12);color:#f87171;font-size:12px;font-weight:600}
figcaption{padding:11px 13px;display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.kw{font-size:12px;font-weight:600;color:#eef0ff;width:100%}
.src{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:rgba(255,255,255,.06);color:#7c85b0}
.src-Unsplash{background:rgba(34,197,94,.14);color:#4ade80}
.src-Openverse{background:rgba(96,165,250,.14);color:#60a5fa}
.src-Wikimedia{background:rgba(167,139,250,.14);color:#a78bfa}
.src-picsum{background:rgba(239,68,68,.14);color:#f87171}
.cr{font-size:10.5px;color:#3d4568}
.note{background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.22);color:#fcd34d;border-radius:12px;padding:13px 15px;font-size:12px;line-height:1.7;margin-top:20px}
.note b{color:#fde68a}
::selection{background:rgba(236,72,153,.32)}
</style></head><body><div class="wrap">
<h1>🖼 이미지 검증</h1><div class="sub">발행 전에 어떤 사진이 들어갈지 직접 확인하세요. 쉼표로 여러 키워드를 넣을 수 있습니다.</div>
${process.env.UNSPLASH_ACCESS_KEY ? '' : '<div class="note" style="margin:0 0 18px"><b>⚠️ UNSPLASH_ACCESS_KEY 미설정</b><br>지금은 Openverse·Wikimedia만 쓰고 있어 사진 품질이 떨어집니다. unsplash.com/developers 에서 무료 키를 발급받아 Railway에 <b>UNSPLASH_ACCESS_KEY</b> 로 추가하세요. (PIXABAY_API_KEY 는 핫링크가 차단돼 더 이상 쓰지 않습니다)</div>'}
<form method="get"><input name="q" value="${q.replace(/"/g, '&quot;')}" placeholder="예: stock market decline, korean street food, container ship port" autocapitalize="off"><button>검색</button></form>
<div class="grid">${cards}</div>
${q ? `<div class="note"><b>판정 기준</b><br>· 배지가 <b>Unsplash / Openverse / Wikimedia</b> → 주제에 맞는 실사진, 핫링크 정상<br>· 배지가 <b>picsum</b> → 검색 실패로 나온 랜덤 사진 (키워드를 더 구체적으로)<br>· <b>❌ 로드 실패</b> → 핫링크 차단된 URL (발행하면 글에서도 깨짐)</div>` : ''}
</div></body></html>`);
});

// ── Setup 페이지 (어떤 클라이언트 ID가 설정됐는지 확인) ──
app.get('/setup', (req, res) => {
  const cid = tokens.get('BLOGGER_CLIENT_ID') || '';
  const masked = cid ? cid.slice(0, 20) + '...' : '❌ 미설정';
  const sec = tokens.get('BLOGGER_CLIENT_SECRET') || '';
  // 시크릿 진단: 앞 7자 + 길이 + 공백/개행 포함 여부 (값 자체는 노출 안 함)
  let secInfo = '❌ 미설정';
  if (sec) {
    const trimmed = sec.trim();
    const hasWs = sec !== trimmed;
    const prefixOk = trimmed.startsWith('GOCSPX-');
    secInfo = `${trimmed.slice(0, 7)}... (길이 ${sec.length}${hasWs ? ' ⚠️공백포함' : ''}${prefixOk ? '' : ' ⚠️GOCSPX- 아님'})`;
  }
  const baseUrl = getBaseUrl(req);
  const store = tokens.storageInfo();
  const refreshOk = !!tokens.get('BLOGGER_REFRESH_TOKEN');
  const blogIdVal = tokens.get('BLOGGER_BLOG_ID') || '';
  const dot = (ok) => `<span class="dot ${ok ? 'on' : 'off'}"></span>`;
  res.send(`<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Blogger 연결 설정</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Pretendard','Apple SD Gothic Neo',-apple-system,sans-serif;color:#eef0ff;min-height:100vh;padding:28px 16px 64px;line-height:1.5;-webkit-font-smoothing:antialiased;
  background:radial-gradient(1000px 560px at 80% -10%,rgba(236,72,153,.1),transparent 60%),radial-gradient(760px 460px at -10% 6%,rgba(99,102,241,.07),transparent 58%),#080b14;background-attachment:fixed}
.wrap{max-width:560px;margin:0 auto}
.head{display:flex;align-items:center;gap:13px;margin-bottom:22px}
.logo{width:46px;height:46px;border-radius:14px;background:linear-gradient(135deg,#ec4899,#f43f5e);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 8px 24px rgba(236,72,153,.36);flex-shrink:0}
h1{font-size:19px;font-weight:700;letter-spacing:-.3px}
.sub{color:#7c85b0;font-size:12.5px;margin-top:2px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.03),transparent 42%),#0e1120;border:1px solid #1e2238;border-radius:16px;padding:20px;margin-bottom:14px;box-shadow:0 1px 2px rgba(0,0,0,.3),0 10px 30px -20px rgba(0,0,0,.8)}
.card-t{font-size:12.5px;font-weight:700;letter-spacing:.3px;margin-bottom:14px;display:flex;align-items:center;gap:8px;color:#eef0ff}
.row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-bottom:1px solid #171a2c}
.row:last-child{border-bottom:none}
.k{color:#7c85b0;font-size:11.5px;font-weight:600;letter-spacing:.3px;flex-shrink:0}
.v{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#86efac;text-align:right;word-break:break-all;min-width:0}
.v.off{color:#64708f}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}
.dot.on{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.15)}
.dot.off{background:#3d4568}
.note{border-radius:12px;padding:13px 15px;font-size:12px;line-height:1.65;margin-top:16px;background:rgba(245,158,11,.07);border:1px solid rgba(245,158,11,.22);color:#fcd34d}
.note b{display:block;margin-bottom:7px}
.mono-box{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#86efac;word-break:break-all;user-select:all;background:rgba(0,0,0,.45);border:1px solid #23273d;padding:11px 12px;border-radius:9px;margin-top:8px;line-height:1.6}
label{display:block;color:#7c85b0;font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin:0 0 6px}
input{width:100%;background:#141728;border:1px solid #252840;border-radius:10px;color:#eef0ff;padding:12px 13px;font-size:13.5px;font-family:inherit;outline:none;transition:all .2s cubic-bezier(.4,0,.2,1);margin-bottom:13px}
input:focus{border-color:#ec4899;box-shadow:0 0 0 3px rgba(236,72,153,.14)}
input::placeholder{color:#3d4568}
button,.btn{display:block;width:100%;border:none;border-radius:11px;padding:13px;font-size:14.5px;font-weight:600;font-family:inherit;cursor:pointer;text-align:center;text-decoration:none;transition:all .2s cubic-bezier(.4,0,.2,1)}
.btn-green{background:linear-gradient(135deg,#22c55e,#16a34a);color:#fff;box-shadow:0 4px 16px rgba(34,197,94,.26)}
.btn-pink{background:linear-gradient(135deg,#ec4899,#f43f5e);color:#fff;box-shadow:0 4px 16px rgba(236,72,153,.32)}
button:hover,.btn:hover{transform:translateY(-1px);filter:brightness(1.07)}
button:active,.btn:active{transform:translateY(1px) scale(.99)}
.result{margin-top:11px;font-size:13px;text-align:center;line-height:1.6;min-height:19px}
.steps{counter-reset:s;list-style:none}
.steps li{counter-increment:s;position:relative;padding-left:30px;margin-bottom:9px;color:#7c85b0;font-size:12.5px;line-height:1.6}
.steps li::before{content:counter(s);position:absolute;left:0;top:0;width:20px;height:20px;border-radius:50%;background:rgba(236,72,153,.14);color:#f9a8d4;font-size:10.5px;font-weight:700;display:flex;align-items:center;justify-content:center}
.steps li b{color:#eef0ff;font-weight:600}
::selection{background:rgba(236,72,153,.32);color:#fff}
:focus-visible{outline:2px solid #ec4899;outline-offset:2px}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
</style></head><body><div class="wrap">
<div class="head"><div class="logo">🔧</div><div><h1>Blogger 연결 설정</h1><div class="sub">구글 계정을 한 번만 연결하면 이후 자동 발행됩니다</div></div></div>

<div class="card"><div class="card-t">📊 현재 상태</div>
<div class="row"><span class="k">CLIENT ID</span><span class="v ${cid ? '' : 'off'}">${cid ? masked : '미설정'}</span></div>
<div class="row"><span class="k">CLIENT SECRET</span><span class="v ${sec ? '' : 'off'}">${sec ? secInfo : '미설정'}</span></div>
<div class="row"><span class="k">REFRESH TOKEN</span><span class="v ${refreshOk ? '' : 'off'}">${dot(refreshOk)}${refreshOk ? '저장됨' : '미설정'}</span></div>
<div class="row"><span class="k">BLOG ID</span><span class="v ${blogIdVal ? '' : 'off'}">${dot(!!blogIdVal)}${blogIdVal || '인증 시 자동설정'}</span></div>
<div class="row"><span class="k">자격증명 검증</span><span class="v" id="cred-test">확인 중…</span></div>
<div id="diag" style="margin-top:14px"></div>
<div class="row"><span class="k">영구 저장</span><span class="v ${store.persistent ? '' : 'off'}">${dot(store.persistent)}${store.persistent ? '켜짐 — 재배포해도 유지' : '꺼짐 — 재배포 시 재연결 필요'}</span></div>
${store.persistent ? '' : `<div class="note"><b>🔌 연결이 계속 끊기지 않게 하려면 (1회, 30초)</b>
Railway 프로젝트 → 서비스 우클릭 → <b>Add Volume</b> → Mount path 에 <b>/data</b> 입력 → 저장.<br>
이걸 붙이면 재배포해도 토큰이 남아 다시는 끊기지 않습니다.</div>`}
<div class="note"><b>⚠️ 구글 콘솔 → 승인된 리디렉션 URI 에 등록 필요</b>아래 주소를 그대로 복사해서 추가하세요.<div class="mono-box">${baseUrl}/oauth/blogger/callback</div></div>
</div>

<div class="card"><div class="card-t">📋 자격증명 직접 입력</div>
<ol class="steps"><li>구글 클라우드 콘솔 → <b>사용자 인증 정보</b></li><li>OAuth 클라이언트 클릭 → <b>ID·시크릿 복사</b></li><li>아래 붙여넣고 <b>검증하고 저장</b></li></ol>
<div style="height:16px"></div>
<label for="in-cid">클라이언트 ID</label><input id="in-cid" placeholder="000000000000-xxxxx.apps.googleusercontent.com" autocapitalize="off" autocorrect="off" spellcheck="false">
<label for="in-sec">클라이언트 시크릿</label><input id="in-sec" placeholder="GOCSPX-••••••••••••••••" autocapitalize="off" autocorrect="off" spellcheck="false">
<button class="btn-green" onclick="credSet()">✔ 검증하고 저장</button>
<div class="result" id="cred-set-result"></div>
</div>

<a class="btn btn-pink" href="/oauth/blogger">🔑 구글 계정 연결 시작</a>
</div><script>
// 이 브라우저에 보관된 올바른 값으로 서버를 먼저 복구한 뒤 검증한다
// (Railway 환경변수에 틀린 값이 있어도 여기서 덮어써져 자가치유됨)
var _boot=Promise.resolve();
try{
  var _saved=localStorage.getItem('riri_bp_creds');
  if(_saved){_boot=fetch('/api/credentials/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:_saved}).then(function(r){return r.json();}).then(function(d){if(d.restored&&d.restored.length){console.log('복구:',d.restored.join(','));}}).catch(function(){});}
}catch(e){}
_boot.then(function(){
fetch('/api/blogger-cred-test').then(function(r){return r.json();}).then(function(d){var el=document.getElementById('cred-test');el.textContent=d.verdict;el.style.color=d.ok?'#86efac':'#f87171';}).catch(function(){var el=document.getElementById('cred-test');el.textContent='테스트 실패';el.style.color='#f87171';});
});
fetch('/api/blogger-diagnose').then(function(r){return r.json();}).then(function(d){
  var h='<div style="font-size:11.5px;font-weight:700;color:#7c85b0;letter-spacing:.4px;margin-bottom:8px">단계별 진단</div>';
  d.steps.forEach(function(s){
    h+='<div style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-bottom:1px solid #171a2c">'
      +'<span style="flex-shrink:0">'+(s.ok?'✅':'❌')+'</span>'
      +'<span style="flex-shrink:0;font-size:12px;color:#eef0ff;min-width:120px">'+s.step+'</span>'
      +'<span style="font-size:11.5px;color:'+(s.ok?'#86efac':'#f87171')+';word-break:break-all">'+s.detail+'</span></div>';
  });
  if(!d.ok) h+='<div style="margin-top:10px;font-size:12px;color:#fcd34d">👉 막힌 곳: <b>'+d.blocked+'</b></div>';
  else h+='<div style="margin-top:10px;font-size:12px;color:#86efac">✅ 모든 단계 정상 — 바로 발행 가능합니다</div>';
  document.getElementById('diag').innerHTML=h;
}).catch(function(e){document.getElementById('diag').textContent='진단 실패: '+e.message;});
function credSet(){var r=document.getElementById('cred-set-result');r.textContent='구글에 확인 중…';r.style.color='#7c85b0';
var cid=(document.getElementById('in-cid').value||'').trim().replace(/^https?:\\/\\//,'');
var sec=(document.getElementById('in-sec').value||'').trim();
fetch('/api/blogger-cred-set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:cid,clientSecret:sec})}).then(function(x){return x.json();}).then(function(d){r.textContent=d.verdict;r.style.color=d.ok?'#86efac':'#f87171';
if(d.ok){
  // 검증 통과한 짝을 브라우저에 보관 → 재배포돼도 이 페이지가 열릴 때마다 자동 복구
  try{var c={};try{c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}');}catch(e){}
  c.BLOGGER_CLIENT_ID=cid;c.BLOGGER_CLIENT_SECRET=sec;
  localStorage.setItem('riri_bp_creds',JSON.stringify(c));}catch(e){}
  setTimeout(function(){location.reload();},1400);
}}).catch(function(e){r.textContent='오류: '+e.message;r.style.color='#f87171';});}
</script></body></html>`);
});

// ── Blogger OAuth ────────────────────────────────────────
app.get('/oauth/blogger', (req, res) => {
  const baseUrl = getBaseUrl(req);
  const clientId = tokens.get('BLOGGER_CLIENT_ID');
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
      tokens.get('BLOGGER_CLIENT_ID'),
      tokens.get('BLOGGER_CLIENT_SECRET'),
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
        tokens.get('BLOGGER_CLIENT_ID'),
        tokens.get('BLOGGER_CLIENT_SECRET'),
        refreshToken,
      );
      if (blogs && blogs[0]) {
        tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
        console.log(`[Blogger] 블로그 ID 자동저장: ${blogs[0].id} (${blogs[0].name})`);
      }
    } catch (_) {}

    res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:sans-serif;background:#0f0f0f;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}.card{background:#1a1a2e;border:1px solid #333;border-radius:16px;padding:32px;max-width:480px;width:100%;text-align:center}h2{color:#22c55e;margin-top:0}p{color:#aaa;font-size:14px;line-height:1.6}.ok{font-size:64px;margin:16px 0}.btn{display:block;background:#333;border:none;color:#fff;padding:14px;border-radius:8px;font-size:15px;cursor:pointer;width:100%;margin-top:16px;text-decoration:none;font-family:inherit}</style></head><body><div class="card"><div class="ok">✅</div><h2>블로그스팟 인증 완료!</h2><p>토큰이 서버에 저장되었습니다. 바로 발행 가능합니다.</p><div id="saved" style="color:#86efac;font-size:13px;margin-top:16px">이 브라우저에 보관 중…</div><div style="text-align:left;background:#0f0f0f;border:1px solid #444;border-radius:10px;padding:14px;margin-top:16px"><div style="color:#fbbf24;font-size:12px;font-weight:bold;margin-bottom:8px">🔒 다시는 안 끊기게 하려면 (1회면 끝)</div><div style="color:#aaa;font-size:12px;line-height:1.6;margin-bottom:10px">아래 버튼으로 복사한 뒤 Railway → Variables 에 <b style="color:#eee">BLOGGER_REFRESH_TOKEN</b> 이름으로 붙여넣으세요. 환경변수는 재배포해도 지워지지 않습니다.</div><button id="copyBtn" style="background:#22c55e;border:none;color:#fff;padding:12px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;width:100%;font-family:inherit">📋 토큰 복사하기</button><div id="copied" style="color:#86efac;font-size:12px;margin-top:8px;text-align:center;min-height:16px"></div></div><a class="btn" href="javascript:window.close()">창 닫기</a></div><script>
try{
  var c={BLOGGER_CLIENT_ID:${JSON.stringify(tokens.get('BLOGGER_CLIENT_ID') || '')},
         BLOGGER_CLIENT_SECRET:${JSON.stringify(tokens.get('BLOGGER_CLIENT_SECRET') || '')},
         BLOGGER_REFRESH_TOKEN:${JSON.stringify(refreshToken || '')},
         BLOGGER_BLOG_ID:${JSON.stringify(tokens.get('BLOGGER_BLOG_ID') || '')}};
  localStorage.setItem('riri_bp_creds', JSON.stringify(c));
  document.getElementById('saved').textContent='✅ 보관 완료 — 대시보드를 열면 자동으로 다시 연결됩니다';
  document.getElementById('copyBtn').onclick=function(){
    var t=c.BLOGGER_REFRESH_TOKEN||'';
    function done(){document.getElementById('copied').textContent='✅ 복사됨 — Railway Variables 에 BLOGGER_REFRESH_TOKEN 으로 붙여넣으세요';}
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done).catch(fallback);}else{fallback();}
    function fallback(){var ta=document.createElement('textarea');ta.value=t;document.body.appendChild(ta);ta.select();
      try{document.execCommand('copy');done();}catch(e){document.getElementById('copied').textContent='복사 실패 — 길게 눌러 직접 복사하세요: '+t;}
      document.body.removeChild(ta);}
  };
}catch(e){ document.getElementById('saved').textContent='⚠️ 브라우저 보관 실패: '+e.message; }
</script></body></html>`);
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

  // 시작 직후 + 6시간마다 연결 점검 (만료를 발행 실패 전에 잡아냄)
  setTimeout(() => checkBloggerHealth(false).catch(() => {}), 8000);
  cron.schedule('0 */6 * * *', () => { checkBloggerHealth(true).catch(() => {}); }, { timezone: 'Asia/Seoul' });
  console.log('[Health] 연결 점검 크론 등록됨 (6시간 간격)');

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
