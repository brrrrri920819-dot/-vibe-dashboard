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
const SERVER_STARTED_AT = Date.now();   // 재시작 판별·헬스체크용

/* 백그라운드 작업(글 생성·발행·이미지 조회) 하나가 실패해도
 * 서버 전체가 내려가지 않게 한다.
 * 예전엔 처리되지 않은 오류 하나로 프로세스가 종료돼
 * "Application failed to respond"가 뜨고, 진행 중이던 글 생성은
 * 응답을 못 받아 무한 로딩으로 남았다. */
/* ── 오류 기록기 ───────────────────────────────────────────
 * Railway 로그를 열어봐야만 원인을 알 수 있으면, 뭐가 잘못됐는지
 * 매번 물어보고 답을 기다리는 왕복이 생긴다.
 * 서버가 자기 오류를 기억해 대시보드에서 바로 보이게 한다.
 * 값(토큰·비밀번호)은 절대 남기지 않는다. */
const ERROR_LOG = [];
const ERROR_LOG_MAX = 200;

/** 로그에 섞여 들어갈 수 있는 비밀값을 지운다 */
function redact(text) {
  return String(text)
    .replace(/GOCSPX-[\w-]+/g, 'GOCSPX-***')
    .replace(/sk-ant-[\w-]{10,}/g, 'sk-ant-***')
    .replace(/1\/\/[\w-]{20,}/g, '1//***')
    .replace(/ya29\.[\w.-]{20,}/g, 'ya29.***')
    .replace(/[\w-]{24,}\.apps\.googleusercontent\.com/g, '***.apps.googleusercontent.com')
    .replace(/("?(?:password|pw|secret|token|key)"?\s*[:=]\s*")([^"]{4,})(")/gi, '$1***$3');
}

function recordError(level, parts) {
  const msg = redact(parts.map(p => {
    if (p instanceof Error) return p.stack || p.message;
    if (typeof p === 'object') { try { return JSON.stringify(p); } catch { return String(p); } }
    return String(p);
  }).join(' ')).slice(0, 1200);
  ERROR_LOG.push({ ts: new Date().toISOString(), level, msg });
  if (ERROR_LOG.length > ERROR_LOG_MAX) ERROR_LOG.shift();
}

const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);
console.error = (...a) => { try { recordError('error', a); } catch (_) {} _origError(...a); };
console.warn  = (...a) => { try { recordError('warn',  a); } catch (_) {} _origWarn(...a); };

process.on('unhandledRejection', (reason) => {
  console.error('[치명] 처리되지 않은 Promise 오류:', reason && reason.stack ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[치명] 처리되지 않은 예외:', err && err.stack ? err.stack : err);
  // 프로세스를 죽이지 않는다 — 서버는 계속 응답해야 한다
});

// ── 미들웨어 ────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
/** 헬스체크 — Railway가 컨테이너 생존을 판단하는 데 사용.
 *  어떤 의존성에도 기대지 않아야 하므로 다른 미들웨어보다 먼저 둔다. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptimeSec: Math.round(process.uptime()), startedAt: new Date(SERVER_STARTED_AT).toISOString() });
});

/** 서버가 겪은 오류 목록 — 로그를 열지 않고 대시보드에서 바로 보게 한다.
 *  값(토큰·비밀번호)은 지운 채로만 내려간다. */
app.get('/api/errors', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, ERROR_LOG_MAX);
  res.json({
    startedAt: new Date(SERVER_STARTED_AT).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    total: ERROR_LOG.length,
    entries: ERROR_LOG.slice(-limit).reverse(),
  });
});

// 루트로 들어오면 블로그 자동화 대시보드를 띄운다
// (예전엔 index.html(프로젝트 트래커)이 떠서 대시보드를 못 찾는 문제가 있었다)
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'blog.html')));

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
/* 일시적인 실패는 조용히 한 번 더 해본다.
 * 크로미움이 메모리 부족으로 못 뜨거나, 네트워크가 잠깐 끊기거나,
 * 상대 서버가 502를 뱉는 경우는 다시 하면 되는 일이다.
 * 이런 걸 한 번에 실패로 끝내면 "또 안 되네"가 반복된다.
 * 반대로 비밀번호가 틀렸거나 토큰이 만료된 건 다시 해도 똑같으므로 재시도하지 않는다. */
const TRANSIENT = /브라우저 실행 실패|Executable doesn't exist|Target (page|browser)?\s*closed|Navigation timeout|timeout|시간 초과|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|EAI_AGAIN|ENOTFOUND|out of memory|Protocol error|crashed|\b50[234]\b/i;
const PERMANENT = /invalid_grant|invalid_client|만료|비밀번호|미설정|설정 필요|권한|403/i;

function isTransient(msg) {
  const m = String(msg || '');
  if (PERMANENT.test(m)) return false;
  return TRANSIENT.test(m);
}

/** 실패하면 잠깐 쉬었다가 한 번 더 — 결과는 항상 값으로 돌려준다 */
async function withRetry(platform, run, { tries = 2, waitMs = Number(process.env.RETRY_WAIT_MS) || 8000 } = {}) {
  let last = null;
  for (let i = 1; i <= tries; i++) {
    let r;
    try {
      r = await run();
    } catch (err) {
      r = { success: false, error: err && err.message ? err.message : String(err), platform };
    }
    if (r && r.success) {
      if (i > 1) console.log(`[Publish] ${platform} 재시도 ${i}번째에 성공`);
      return r;
    }
    last = r;
    if (i < tries && isTransient(r && r.error)) {
      console.warn(`[Publish] ${platform} 일시적 실패 — ${Math.round(waitMs / 1000)}초 뒤 다시 시도: ${r && r.error}`);
      await new Promise(res => setTimeout(res, waitMs));
      continue;
    }
    break;
  }
  return last;
}

/* 자동 발행에서 '설정되지 않은 블로그'는 아예 뺀다.
 * 예전엔 연결도 안 된 곳에 매일 시도해서 실패 로그가 쌓이고 알림이 갔다.
 * 시도조차 못 할 곳을 매일 두드리는 건 아무에게도 도움이 되지 않는다.
 * 자격증명이 갖춰진 곳만 남기고, 하나도 없으면 블로그스팟만 남겨
 * "왜 아무 데도 안 올라갔지"가 아니라 분명한 실패 이유가 남게 한다. */
function readyPlatforms(wanted) {
  const list = Array.isArray(wanted) && wanted.length ? wanted : ['blogger'];
  const ready = {
    blogger: !!(tokens.get('BLOGGER_CLIENT_ID') && tokens.get('BLOGGER_CLIENT_SECRET') && tokens.get('BLOGGER_REFRESH_TOKEN'))
             || !!(tokens.get('BLOGGER_EMAIL') && tokens.get('BLOGGER_PW')),
    naver:   !!(tokens.get('NAVER_BLOG_ID') && (tokens.get('NAVER_COOKIES') || (tokens.get('NAVER_ID') && tokens.get('NAVER_PW')))),
    tistory: !!(tokens.get('TISTORY_BLOG_NAME') && (tokens.get('TISTORY_COOKIES') || (tokens.get('TISTORY_ID') && tokens.get('TISTORY_PW')))),
  };
  const kept = list.filter(p => ready[p]);
  const dropped = list.filter(p => !ready[p]);
  if (dropped.length) {
    console.log(`[Publish] 설정되지 않아 건너뜀: ${dropped.join(', ')} (설정하면 자동으로 다시 포함됩니다)`);
  }
  return kept.length ? kept : ['blogger'];
}

async function publishJob(job) {
  // 한달 예약 자동생성: 발행 시점에 최신 트렌딩 키워드로 글 생성
  if (job.autoGenerate && !job.content) {
    const { fetchAllTrending } = require('./keywords/fetcher');
    const accounts = readAccounts();
    const account  = (job.accountId && accounts.find(a => a.id === job.accountId)) || accounts[0];
    if (!account) throw new Error('계정 없음 — 계정·주제 관리에서 계정을 추가해주세요');

    const trending = await fetchAllTrending({
      naverClientId:     tokens.get('NAVER_CLIENT_ID'),
      naverClientSecret: tokens.get('NAVER_CLIENT_SECRET'),
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
   /* 한 블로그가 터져도 나머지는 반드시 올라가야 한다.
      예전엔 크로미움 실행 실패 같은 예외가 이 반복문을 통째로 중단시켜,
      네이버 하나 때문에 블로그스팟·티스토리까지 한 글도 안 올라갔다. */
   try {
    // 플랫폼마다 약간 다른 버전 사용
    let variantContent = variantForPlatform(humanizeHtml(content), platform);
    const variantTitle = humanizeTitle(title);

    /* 네이버 글은 항상 제휴 구조를 포함한다 (요청 사항).
       이미 제휴 블록이 붙어 있으면(일괄 발행 경로) 중복으로 넣지 않는다. */
    /* 제휴 블록은 발행되는 모든 블로그에 넣는다.
       예전엔 네이버에만 넣었는데, 정작 지금 글이 올라가는 곳은 구글 블로그다.
       수익이 날 수 있는 곳에 링크가 없으면 아무 의미가 없다. */
    if (!job.skipAffiliate && job.affiliate !== false && !/함께 보면 좋은 제휴 서비스/.test(variantContent)) {
      try {
        const { applyAffiliates } = require('./affiliates/recommender');
        const r = await applyAffiliates(variantContent, `${job.keyword || ''} ${title}`, { platform, limit: 2, tokens });
        variantContent = r.content;
      } catch (e) {
        console.warn('[Affiliate] 네이버 제휴 삽입 실패(본문은 그대로 발행):', e.message);
      }
    }

    if (platform === 'naver') {
      results.naver = await withRetry('naver', () => publishToNaver({
        id:       tokens.get('NAVER_ID'),
        pw:       tokens.get('NAVER_PW'),
        cookies:  tokens.get('NAVER_COOKIES'),   // 있으면 로그인 단계를 건너뛴다
        blogId:   tokens.get('NAVER_BLOG_ID'),
        title:    variantTitle,
        content:  variantContent,
        tags,
        imagePaths,
      }));

    } else if (platform === 'tistory') {
      const tistoryId = tokens.get('TISTORY_ID');
      const tistoryPw = tokens.get('TISTORY_PW');
      // TISTORY_BLOG_NAME: 풀 URL 입력해도 앞부분만 추출 (예: abc.tistory.com → abc)
      const tistoryCookies = tokens.get('TISTORY_COOKIES');
      const rawBlogName = tokens.get('TISTORY_BLOG_NAME') || '';
      const blogName = rawBlogName.replace(/\.tistory\.com.*$/, '').replace(/https?:\/\//, '').trim();
      // 쿠키가 있으면 아이디·비밀번호 없이도 발행할 수 있다
      if (blogName && (tistoryCookies || (tistoryId && tistoryPw))) {
        results.tistory = await withRetry('tistory', () => publishToTistoryPlaywright({
          id: tistoryId, pw: tistoryPw, cookies: tistoryCookies, blogName,
          title: variantTitle, content: variantContent, tags,
        }));
      } else {
        results.tistory = {
          success: false,
          error: !blogName ? 'TISTORY_BLOG_NAME 미설정'
               : '티스토리 로그인 정보가 없습니다 — 설정에서 쿠키(권장) 또는 아이디/비밀번호를 넣으세요',
          platform: 'tistory',
        };
      }

    } else if (platform === 'blogger') {
      const blogId       = tokens.get('BLOGGER_BLOG_ID');
      const clientId     = tokens.get('BLOGGER_CLIENT_ID');
      const clientSecret = tokens.get('BLOGGER_CLIENT_SECRET');
      const refreshToken = tokens.get('BLOGGER_REFRESH_TOKEN');

      if (clientId && clientSecret && refreshToken) {
        // OAuth 방식 (가장 안정적 — 자동 갱신)
        results.blogger = await withRetry('blogger', () => publishToBlogger({
          clientId, clientSecret, refreshToken, blogId,
          title: variantTitle, content: variantContent, tags,
        }));
        // 토큰 갱신 후 blogId 자동저장
        if (results.blogger.success && results.blogger.blogId && !blogId) {
          tokens.set('BLOGGER_BLOG_ID', results.blogger.blogId);
        }
        /* 발행이 토큰 만료로 실패했으면 그 자리에서 '재연결 필요'로 표시한다.
           30분 뒤 헬스체크를 기다리지 않고 대시보드 상단 배너가 바로 뜬다. */
        if (!results.blogger.success && /만료|invalid_grant|재인증|재연결/.test(results.blogger.error || '')) {
          _deadRefreshTokens.add(refreshToken);
          _bloggerHealth = {
            checkedAt: new Date().toISOString(), ok: false, needsReauth: true,
            detail: results.blogger.error,
          };
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

     // 결과로 돌아온 실패도 기록에 남긴다 — 나중에 원인을 되짚을 수 있게
     if (results[platform] && !results[platform].success) {
       console.error(`[Publish] ${platform} 실패: ${results[platform].error}`);
     }
   } catch (err) {
     // 예외도 '이 플랫폼만 실패'로 기록하고 다음 플랫폼으로 넘어간다
     const msg = err && err.message ? err.message : String(err);
     console.error(`[Publish] ${platform} 실패(다음 플랫폼 계속): ${msg}`);
     results[platform] = { success: false, error: msg, platform };
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
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;
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
/* 글 생성 키가 실제로 통하는지 아주 짧게 확인한다 (토큰 몇 개, 사실상 무료).
 * 벽시계 타임아웃을 건다 — 연결은 됐는데 응답이 안 오는 경우
 * req.setTimeout 은 작동하지 않아 호출이 영원히 멈춘다. */
function probeClaudeKey(key, ms = 20000) {
  const https = require('https');
  const body = JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 8,
    messages: [{ role: 'user', content: '안녕' }],
  });
  const call = new Promise((resolve, reject) => {
    const r = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(d); } catch (_) {}
        if (!j) return reject(new Error(`응답을 이해할 수 없습니다 (HTTP ${res.statusCode})`));
        if (j.error) {
          // 원인별로 할 일이 다르므로 구분해서 알려준다
          const t = j.error.type || '';
          const m = j.error.message || '';
          if (res.statusCode === 401 || /authentication/i.test(t)) {
            return reject(new Error('키가 거부됐습니다 — 키를 다시 발급받아 넣으세요'));
          }
          if (/credit|billing|quota/i.test(m) || res.statusCode === 402) {
            return reject(new Error('잔액이 없습니다 — console.anthropic.com 에서 충전하세요'));
          }
          if (res.statusCode === 429) {
            return reject(new Error('요청이 몰렸습니다 (429) — 잠시 뒤 다시 시도하면 됩니다'));
          }
          return reject(new Error(`${t || 'error'} — ${m}`));
        }
        resolve(true);
      });
    });
    r.on('error', e => reject(new Error(`네트워크 오류: ${e.message}`)));
    r.write(body);
    r.end();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${ms / 1000}초 안에 응답이 없습니다`)), ms);
    call.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

app.get('/api/test-claude', auth, async (req, res) => {
  const key = tokens.get('ANTHROPIC_API_KEY');
  if (!key) return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY 미설정' });
  try {
    await probeClaudeKey(key);
    res.json({ ok: true, message: 'Claude API 연결 성공 ✅' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ── 글 생성 비용·잔액 ──────────────────────────────────────
 * 앤트로픽은 '남은 잔액'을 알려주는 API가 없다. 그래서 두 갈래로 답한다.
 *   1) 쓸 수 있는 상태인가 — 실제로 아주 짧은 호출을 해보고 판단한다.
 *      잔액이 바닥나면 여기서 바로 걸린다 (이게 가장 확실한 신호다)
 *   2) 얼마나 썼나 — 관리자 키가 있으면 이번 달 지출을 가져온다.
 *      관리자 키는 조직 계정에만 발급되므로 없을 수 있다. 없으면 없다고 말한다. */
app.get('/api/anthropic-usage', auth, async (req, res) => {
  const { fetchSpend, formatUsd } = require('./income/anthropic-usage');

  const out = { checkedAt: new Date().toISOString() };

  // 1) 지금 글을 쓸 수 있는 상태인가
  const key = tokens.get('ANTHROPIC_API_KEY');
  if (!key) {
    out.usable = { ok: false, reason: 'no_key', message: 'ANTHROPIC_API_KEY 미설정 — 설정에서 넣어주세요' };
  } else {
    try {
      await probeClaudeKey(key);
      out.usable = { ok: true, message: '정상 — 지금 글을 만들 수 있습니다' };
    } catch (e) {
      out.usable = {
        ok: false,
        reason: /잔액/.test(e.message) ? 'no_credit' : 'error',
        message: e.message,
      };
    }
  }

  // 2) 얼마나 썼나 (관리자 키가 있을 때만)
  const spend = await fetchSpend(tokens.get('ANTHROPIC_ADMIN_KEY')).catch(e => ({
    ok: false, reason: 'failed', message: e.message,
  }));
  out.spend = spend.ok
    ? {
        ok: true,
        month: formatUsd(spend.monthCents),
        today: formatUsd(spend.todayCents),
        days: spend.days.slice(0, 14).map(d => ({ date: d.date, amount: formatUsd(d.cents) })),
        note: spend.note,
      }
    : spend;

  res.json(out);
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

  /* Naver: 브라우저를 실제로 띄워본다.
     경로만 확인하면 "설정 정상"으로 보이는데 정작 발행 때 크로미움이
     메모리 부족으로 죽어 글이 안 올라가는 일이 생긴다. 여기서 미리 잡는다. */
  const nId = tokens.get('NAVER_ID'), nPw = tokens.get('NAVER_PW'), nBlog = tokens.get('NAVER_BLOG_ID');
  if (nId && nPw && nBlog) {
    let browser = null;
    try {
      const { chromium } = require('playwright');
      const execPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
      browser = await chromium.launch({
        headless: true, executablePath: execPath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
               '--disable-gpu', '--single-process', '--no-zygote', '--disable-extensions'],
      });
      const v = browser.version();
      results.naver = { ok: true, message: `브라우저 정상 실행됨 (Chromium ${v}) — 발행 준비 완료` };
    } catch (e) {
      results.naver = /Executable doesn't exist|ENOENT/.test(e.message)
        ? { ok: false, error: '브라우저(Chromium)가 서버에 없습니다 — 배포 이미지 확인 필요' }
        : { ok: false, error: `브라우저 실행 실패: ${e.message}` };
    } finally {
      if (browser) await browser.close().catch(() => {});
    }
  } else {
    const missing = [!nId && 'NAVER_ID', !nPw && 'NAVER_PW', !nBlog && 'NAVER_BLOG_ID'].filter(Boolean);
    results.naver = { ok: false, error: `${missing.join(' / ')} 미설정` };
  }

  res.json(results);
});

/* ── 수익 우선 자동 발행 ───────────────────────────────────
 * 트렌드 글은 조회수는 나와도 돈이 안 된다.
 * 물건을 살까 고민하는 사람이 검색하는 말("○○ 추천/비교/후기")로 글을 쓰고,
 * 추적 ID가 붙은 상품 링크를 넣어야 수익이 난다.
 * 매일 정해진 개수만큼 알아서 만들어 발행 큐에 넣는다. */
const { pickRevenueKeywords, articleShape, weeklyPlan } = require('./income/revenue-keywords');

async function runRevenuePublish(perDay = 2) {
  const { trackingStatus } = require('./affiliates/tracking');
  const track = trackingStatus(tokens);
  const picks = pickRevenueKeywords(perDay);
  const made = [];

  for (const kw of picks) {
    try {
      const shape = articleShape(kw);
      const post = await generatePost(kw.keyword, { topic: shape.topic, tone: shape.tone, platform: 'blogger' });
      const job = {
        id:        `rev_${Date.now()}_${made.length}`,
        title:     post.title,
        content:   post.content,
        tags:      post.tags,
        keyword:   kw.keyword,
        platforms: readyPlatforms(['blogger', 'naver', 'tistory']),
        source:    'revenue',
      };
      enqueue(job);
      made.push({ keyword: kw.keyword, title: post.title, jobId: job.id, why: kw.why });
      console.log(`[Revenue] 큐 등록: "${kw.keyword}" → ${post.title}`);
    } catch (e) {
      console.error(`[Revenue] "${kw.keyword}" 실패: ${e.message}`);
    }
  }

  if (!track.ok) console.warn(`[Revenue] ⚠️ ${track.reason}`);
  return { made, tracked: track.ok, trackingReason: track.reason, planned: picks.length };
}

/** 일주일 계획 미리보기 — 무슨 글이 언제 올라갈지 */
app.get('/api/revenue-plan', auth, (req, res) => {
  const { trackingStatus } = require('./affiliates/tracking');
  const perDay = Math.min(Math.max(Number(req.query.perDay) || 2, 1), 5);
  res.json({ ...weeklyPlan(perDay), tracking: trackingStatus(tokens) });
});

/** 지금 당장 수익 글 만들어 큐에 넣기 */
const _revJobs = new Map();
app.post('/api/revenue-run', auth, (req, res) => {
  const perDay = Math.min(Math.max(Number(req.body?.count) || 2, 1), 5);
  const jobId = `revrun_${Date.now()}`;
  _revJobs.set(jobId, { status: 'running', startedAt: new Date().toISOString() });
  res.json({ success: true, jobId, count: perDay });

  runRevenuePublish(perDay)
    .then(r => _revJobs.set(jobId, { status: 'done', ...r }))
    .catch(e => _revJobs.set(jobId, { status: 'error', error: e.message }));
  setTimeout(() => _revJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/revenue-run-status/:jobId', auth, (req, res) => {
  const job = _revJobs.get(req.params.jobId);
  if (!job) return res.status(410).json({ error: '서버가 재시작되어 결과를 잃었습니다 — 다시 눌러주세요' });
  res.json(job);
});

/* ── 전체 점검 (한 방) ─────────────────────────────────────
 * "지금 글이 올라가냐"에 처음부터 끝까지 실제로 해보고 답한다.
 * 잔액 확인 → 글 생성 → 진짜 발행까지 한 번에 돌려서,
 * 되면 글 주소를, 안 되면 '어디서 왜' 막혔는지 하나만 남긴다.
 * 버튼 세 개를 순서대로 누르며 원인을 좁히지 않아도 되게 하려는 것. */
const _fullCheckJobs = new Map();

app.post('/api/full-check', auth, (req, res) => {
  const asked = Array.isArray(req.body?.platforms) ? req.body.platforms : [];
  const keyword = (req.body?.keyword || '').trim() || '아침 루틴 만들기';
  const jobId = `full_${Date.now()}`;

  const set = (patch) => _fullCheckJobs.set(jobId, { ...(_fullCheckJobs.get(jobId) || {}), ...patch });
  set({ status: 'running', steps: [], startedAt: new Date().toISOString(), keyword });
  res.json({ success: true, jobId });

  (async () => {
    const steps = [];
    const push = (s) => { steps.push(s); set({ steps: [...steps] }); };
    const fail = (verdict) => set({ status: 'done', ok: false, steps: [...steps], verdict });

    // ── 1. 연결된 블로그가 있는가 ────────────────────────────
    const ready = {
      blogger: !!(tokens.get('BLOGGER_CLIENT_ID') && tokens.get('BLOGGER_CLIENT_SECRET') && tokens.get('BLOGGER_REFRESH_TOKEN')),
      naver:   !!(tokens.get('NAVER_ID') && tokens.get('NAVER_PW') && tokens.get('NAVER_BLOG_ID')),
      tistory: !!(tokens.get('TISTORY_ID') && tokens.get('TISTORY_PW') && tokens.get('TISTORY_BLOG_NAME')),
    };
    const connected = Object.keys(ready).filter(k => ready[k]);
    push({ step: '1. 블로그 연결', ok: connected.length > 0,
           detail: connected.length ? `${connected.length}곳 설정됨 — ${connected.join(', ')}` : '연결된 블로그가 없습니다' });
    if (!connected.length) return fail('연결된 블로그가 없어서 글이 올라갈 수 없습니다. /setup 에서 먼저 연결하세요.');

    // ── 2. 구글이 실제로 받아주는가 (설정만 있고 죽어 있는 경우가 많다) ──
    if (ready.blogger) {
      try {
        const blogs = await getBloggerBlogId(
          tokens.get('BLOGGER_CLIENT_ID'), tokens.get('BLOGGER_CLIENT_SECRET'), tokens.get('BLOGGER_REFRESH_TOKEN'));
        if (blogs && blogs[0]) {
          if (!tokens.get('BLOGGER_BLOG_ID')) tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
          push({ step: '2. 구글 블로그', ok: true, detail: `연결 확인됨 — ${blogs[0].name}` });
        } else {
          ready.blogger = false;
          push({ step: '2. 구글 블로그', ok: false, detail: '인증은 됐으나 소유한 블로그가 없습니다' });
        }
      } catch (e) {
        ready.blogger = false;
        const g = e.response?.data || {};
        let why = g.error_description || e.message;
        if (g.error === 'invalid_grant') why = '토큰 만료 — /setup 에서 구글 재연결이 필요합니다';
        if (e.response?.status === 403) why = 'Blogger API 가 꺼져 있습니다 — 구글 콘솔에서 켜세요';
        push({ step: '2. 구글 블로그', ok: false, detail: why });
      }
    } else {
      push({ step: '2. 구글 블로그', ok: false, detail: '설정되지 않음 (다른 블로그로 진행합니다)' });
    }

    // ── 3. 글을 만들 수 있는가 (잔액 포함) ───────────────────
    const key = tokens.get('ANTHROPIC_API_KEY');
    if (!key) {
      push({ step: '3. 글 생성 준비', ok: false, detail: 'ANTHROPIC_API_KEY 미설정 — 글을 만들 수 없습니다' });
      return fail('글 생성 키가 없어서 글이 만들어지지 않습니다. 설정에서 키를 넣으세요.');
    }
    try {
      await probeClaudeKey(key);
      push({ step: '3. 글 생성 준비', ok: true, detail: '키·잔액 정상' });
    } catch (e) {
      push({ step: '3. 글 생성 준비', ok: false, detail: e.message });
      return fail(/잔액/.test(e.message)
        ? '잔액이 없어서 글이 만들어지지 않습니다. console.anthropic.com 에서 충전하면 해결됩니다.'
        : `글 생성 키 문제로 막혔습니다 — ${e.message}`);
    }

    // ── 4. 진짜 글 만들기 ────────────────────────────────────
    let post;
    try {
      const account = readAccounts()[0] || {};
      post = await generatePost(keyword, {
        topic:    account.topic    || '라이프스타일',
        tone:     account.tone     || '친근한',
        platform: (account.platforms || ['blogger'])[0],
      });
      const chars = String(post.content || '').replace(/<[^>]+>/g, '').length;
      push({ step: '4. 글 만들기', ok: true, detail: `완성 — "${post.title}" (${chars.toLocaleString('ko-KR')}자)` });
    } catch (e) {
      push({ step: '4. 글 만들기', ok: false, detail: e.message });
      return fail(`글은 만들어지지 않았습니다 — ${e.message}`);
    }

    // ── 5. 진짜 올리기 ───────────────────────────────────────
    const targets = (asked.length ? asked : Object.keys(ready)).filter(p => ready[p]);
    if (!targets.length) {
      push({ step: '5. 발행', ok: false, detail: '올릴 수 있는 블로그가 없습니다' });
      return fail('글은 만들어졌지만 올릴 수 있는 블로그가 없습니다. 연결부터 고치세요.');
    }

    let results;
    try {
      results = await publishJob({
        title: post.title, content: post.content, tags: post.tags,
        platforms: targets, keyword,
      });
    } catch (e) {
      push({ step: '5. 발행', ok: false, detail: e.message });
      return fail(`발행 중 오류로 막혔습니다 — ${e.message}`);
    }

    const summary = {};
    const okList = [], failList = [];
    for (const p of targets) {
      const r = results[p] || { success: false, error: '결과 없음' };
      summary[p] = { success: !!r.success, url: r.url || null, error: r.error || null, screenshot: r.screenshot || null };
      (r.success ? okList : failList).push(p);
    }
    push({ step: '5. 발행', ok: okList.length > 0,
           detail: okList.length ? `${okList.join(', ')} 에 올라감` : '모두 실패' });

    const NAMES = { blogger: '구글 블로그', naver: '네이버', tistory: '티스토리' };
    set({
      status: 'done',
      ok: okList.length > 0,
      steps: [...steps],
      title: post.title,
      published: summary,
      verdict: okList.length
        ? `글이 실제로 올라갔습니다 — ${okList.map(p => NAMES[p] || p).join(', ')}`
        : `글은 만들어졌는데 올라가지 않았습니다 — ${failList.map(p => `${NAMES[p] || p}: ${summary[p].error}`).join(' / ')}`,
      finishedAt: new Date().toISOString(),
    });
  })().catch(err => {
    set({ status: 'error', ok: false, verdict: `점검 중 오류 — ${err.message}` });
  });

  setTimeout(() => _fullCheckJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/full-check-status/:jobId', auth, (req, res) => {
  const job = _fullCheckJobs.get(req.params.jobId);
  if (!job) return res.status(410).json({ error: '서버가 재시작되어 결과를 잃었습니다 — 다시 눌러주세요' });
  res.json(job);
});

/* ── 글 생성 테스트 ────────────────────────────────────────
 * "글이 안 써진다"의 원인을 한 번에 가른다.
 * 실제로 글 하나를 만들어보고, 성공하면 무엇이 나왔는지,
 * 실패하면 어느 단계에서 무슨 이유로 막혔는지 그대로 보여준다.
 * 발행은 하지 않는다 — 생성만 확인하는 게 목적이다. */
const _genTestJobs = new Map();

app.post('/api/generate-test', auth, (req, res) => {
  const keyword = (req.body?.keyword || '').trim() || '아침 루틴 만들기';
  const jobId = `gentest_${Date.now()}`;
  _genTestJobs.set(jobId, { status: 'running', keyword, startedAt: new Date().toISOString() });
  res.json({ success: true, jobId, keyword });

  (async () => {
    const steps = [];
    // 1단계: 키가 있는가
    const key = tokens.get('ANTHROPIC_API_KEY');
    steps.push(key
      ? { step: '1. 글 생성 키', ok: true, detail: `있음 (${key.slice(0, 7)}…, 출처: ${tokens.sourceOf('ANTHROPIC_API_KEY') === 'env' ? 'Railway 환경변수' : '화면에서 저장'})` }
      : { step: '1. 글 생성 키', ok: false, detail: '없음 — 설정에서 ANTHROPIC_API_KEY 를 넣어야 글이 만들어집니다' });
    if (!key) {
      _genTestJobs.set(jobId, { status: 'done', ok: false, keyword, steps, error: 'ANTHROPIC_API_KEY 미설정' });
      return;
    }

    // 2단계: 그 키가 실제로 통하는가 (아주 짧은 호출)
    try {
      await probeClaudeKey(key);
      steps.push({ step: '2. 키 유효성', ok: true, detail: '클로드가 정상 응답했습니다' });
    } catch (e) {
      steps.push({ step: '2. 키 유효성', ok: false, detail: e.message });
      _genTestJobs.set(jobId, { status: 'done', ok: false, keyword, steps, error: e.message });
      return;
    }

    // 3단계: 진짜로 글을 만들어본다
    try {
      const accounts = readAccounts();
      const account = accounts[0] || {};
      const post = await generatePost(keyword, {
        topic:    account.topic    || '라이프스타일',
        tone:     account.tone     || '친근한',
        platform: (account.platforms || ['blogger'])[0],
      });
      const chars  = String(post.content || '').replace(/<[^>]+>/g, '').length;
      const images = (String(post.content || '').match(/<img/g) || []).length;
      steps.push({ step: '3. 글 만들기', ok: true, detail: `완성 — ${chars.toLocaleString('ko-KR')}자, 사진 ${images}장` });
      _genTestJobs.set(jobId, {
        status: 'done', ok: true, keyword, steps,
        title: post.title, chars, images, tags: post.tags || [],
        preview: String(post.content || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180),
      });
    } catch (e) {
      steps.push({ step: '3. 글 만들기', ok: false, detail: e.message });
      _genTestJobs.set(jobId, { status: 'done', ok: false, keyword, steps, error: e.message });
    }
  })().catch(err => {
    _genTestJobs.set(jobId, { status: 'error', ok: false, keyword, error: err.message });
  });

  setTimeout(() => _genTestJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/generate-test-status/:jobId', auth, (req, res) => {
  const job = _genTestJobs.get(req.params.jobId);
  if (!job) return res.status(410).json({ error: '서버가 재시작되어 결과를 잃었습니다 — 다시 눌러주세요' });
  res.json(job);
});

/* ── 진짜 발행 테스트 ──────────────────────────────────────
 * "설정은 다 됐다는데 글이 하나도 안 올라간다"를 끝내기 위한 것.
 * 글 생성(Claude)을 건너뛰고 짧은 글 하나를 실제로 올려본 뒤,
 * 블로그별로 성공했는지·무슨 오류가 났는지 그대로 보여준다.
 * 어디서 막혔는지 추측하지 않고 눈으로 확인할 수 있다. */
const _testPubJobs = new Map();

app.post('/api/publish-test', auth, (req, res) => {
  const asked = Array.isArray(req.body?.platforms) ? req.body.platforms : [];
  const platforms = asked.length ? asked : ['blogger', 'naver', 'tistory'];
  const jobId = `test_${Date.now()}`;
  _testPubJobs.set(jobId, { status: 'running', platforms, startedAt: new Date().toISOString() });
  res.json({ success: true, jobId, platforms });

  (async () => {
    const stamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
    const results = await publishJob({
      title: `연결 테스트 (${stamp})`,
      content: '<p style="font-size:17px;line-height:1.9">발행 연결이 정상인지 확인하려고 올린 테스트 글입니다. '
             + '확인하셨으면 삭제하셔도 됩니다.</p>',
      tags: ['연결테스트'],
      platforms,
      skipAffiliate: true,
    });
    const summary = {};
    for (const p of platforms) {
      const r = results[p] || { success: false, error: '결과 없음 — 해당 플랫폼 처리기가 실행되지 않았습니다' };
      summary[p] = { success: !!r.success, url: r.url || null, error: r.error || null };
    }
    _testPubJobs.set(jobId, {
      status: 'done',
      platforms,
      results: summary,
      anySuccess: Object.values(summary).some(r => r.success),
      startedAt: _testPubJobs.get(jobId)?.startedAt,
      finishedAt: new Date().toISOString(),
    });
  })().catch(err => {
    _testPubJobs.set(jobId, {
      status: 'error', platforms, error: err.message,
      startedAt: _testPubJobs.get(jobId)?.startedAt,
    });
  });

  setTimeout(() => _testPubJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/publish-test-status/:jobId', auth, (req, res) => {
  const job = _testPubJobs.get(req.params.jobId);
  if (!job) {
    // 재배포로 서버가 새로 떴으면 잡이 사라진다 — 무한 대기 대신 분명히 알린다
    return res.status(410).json({ error: '서버가 재시작되어 결과를 잃었습니다 — 다시 눌러주세요' });
  }
  res.json(job);
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
    naverClientId:     tokens.get('NAVER_CLIENT_ID'),
    naverClientSecret: tokens.get('NAVER_CLIENT_SECRET'),
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
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;

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

/** 생성 상태 폴링
 *  서버가 재시작되면 진행 중이던 작업 정보가 사라진다.
 *  이때 404만 돌려주면 대시보드가 계속 기다려 무한 로딩이 되므로,
 *  서버가 그 사이 재시작됐음을 알려 즉시 오류로 끝내게 한다. */
app.get('/api/generate-status/:jobId', auth, (req, res) => {
  const job = _genJobs.get(req.params.jobId);
  if (job) return res.json(job);

  const startedAt = Number((req.params.jobId.match(/gen_(\d+)/) || [])[1]);
  if (startedAt && startedAt < SERVER_STARTED_AT) {
    return res.status(410).json({
      status: 'error',
      error: '생성 도중 서버가 재시작되어 중단되었습니다. 다시 시도해주세요',
    });
  }
  res.status(404).json({ error: 'job not found' });
});

/* ── 키워드 일괄 발행 ─────────────────────────────────────
 * 키워드 여러 개를 한 번에 → 각각 글 생성 → 선택한 블로그에 발행.
 * 제휴 포함을 선택하면 주제에 맞는 프로그램을 골라 고지문과 함께 본문에 넣는다.
 * 네이버는 외부 제휴 정책이 달라 허용되는 프로그램만 고른다. */
const _bulkJobs = new Map();

app.post('/api/bulk-publish', auth, async (req, res) => {
  const {
    keywords = [], platforms = ['blogger'],
    includeAffiliate = false, scheduleMode = 'now', intervalMinutes = 30, accountId,
  } = req.body;

  const list = (Array.isArray(keywords) ? keywords : String(keywords).split(','))
    .map(k => String(k).trim()).filter(Boolean).slice(0, 30);
  if (!list.length) return res.status(400).json({ error: '키워드를 하나 이상 입력하세요' });
  if (!Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({ error: '발행할 블로그를 하나 이상 선택하세요' });
  }

  const jobId = `bulk_${Date.now()}`;
  _bulkJobs.set(jobId, { status: 'running', total: list.length, done: 0, items: [] });
  res.json({ success: true, jobId, total: list.length, platforms, includeAffiliate });

  (async () => {
    const { applyAffiliates } = require('./affiliates/recommender');
    const accounts = readAccounts();
    const account  = (accountId && accounts.find(a => a.id === accountId)) || accounts[0] || {};
    const items = [];

    for (let i = 0; i < list.length; i++) {
      const keyword = list[i];
      const item = { keyword, status: 'running', platforms: {}, affiliates: [] };
      items.push(item);
      _bulkJobs.set(jobId, { status: 'running', total: list.length, done: i, items });

      try {
        const post = await generatePost(keyword, {
          topic:    account.topic || '생활정보',
          tone:     account.tone  || '친근한',
          platform: platforms[0],
        });

        // 플랫폼마다 제휴 구성이 다르므로 개별로 만든다
        for (const platform of platforms) {
          let content = post.content;
          if (includeAffiliate) {
            const r = await applyAffiliates(content, `${keyword} ${post.title}`, { platform, limit: 2 });
            content = r.content;
            if (r.used.length) item.affiliates = r.used;
          }

          const job = {
            id:          `bulk_${Date.now()}_${i}_${platform}`,
            title:       post.title,
            content,
            tags:        post.tags,
            imagePaths:  [],
            platforms:   [platform],
            accountId:   account.id,
            keyword,
            source:      'bulk_publish',
            scheduledAt: scheduleMode === 'now'
              ? new Date().toISOString()
              : humanizePostTime(new Date(Date.now() + (i + 1) * intervalMinutes * 60 * 1000)).toISOString(),
          };
          enqueue(job);
          item.platforms[platform] = '예약됨';
        }

        item.title  = post.title;
        item.status = 'done';
        console.log(`[Bulk] ${i + 1}/${list.length} "${keyword}" → ${platforms.join(',')} 예약`);
      } catch (e) {
        item.status = 'error';
        item.error  = e.message;
        console.error(`[Bulk] "${keyword}" 실패: ${e.message}`);
      }

      _bulkJobs.set(jobId, { status: 'running', total: list.length, done: i + 1, items });
    }

    const okCount = items.filter(x => x.status === 'done').length;
    _bulkJobs.set(jobId, {
      status: 'done', total: list.length, done: list.length, items,
      success: okCount > 0, okCount,
    });
    console.log(`[Bulk] 완료 — ${okCount}/${list.length}개 성공`);
    try {
      await notifyPublished(`📦 일괄 발행 ${okCount}/${list.length}건`, {
        bulk: { success: okCount > 0, summary: items.map(x => `${x.status === 'done' ? '✅' : '❌'} ${x.keyword}`).join(', ') },
      });
    } catch (_) {}
  })().catch(e => _bulkJobs.set(jobId, { status: 'error', error: e.message }));

  setTimeout(() => _bulkJobs.delete(jobId), 2 * 60 * 60 * 1000);
});

app.get('/api/bulk-publish-status/:jobId', auth, (req, res) => {
  const job = _bulkJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(job);
});

/** 네이버 쇼핑커넥트 — 주제에 맞는 수익 좋은 상품 추천 (미리 보고 링크 걸기) */
app.get('/api/shopping-recommend', auth, async (req, res) => {
  const { recommendProducts } = require('./affiliates/shopping-connect');
  const q = (req.query.q || '').trim();
  try {
    const rec = await recommendProducts(q, parseInt(req.query.limit, 10) || 6);
    res.json(rec);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 주제에 맞는 제휴 추천 미리보기 */
app.get('/api/affiliate-recommend', auth, async (req, res) => {
  const { recommendAffiliates } = require('./affiliates/recommender');
  const q = (req.query.q || '').trim();
  const platform = req.query.platform || 'blogger';
  try {
    const list = await recommendAffiliates(q, { platform, limit: 3 });
    res.json({ ok: true, platform, programs: list.map(p => ({
      id: p.id, name: p.name, category: p.category, rate: p.commissionRate,
      hotScore: p.hotScore, bestFor: p.bestFor, url: p.url,
    })) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
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
        platforms:    readyPlatforms(account.platforms),
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
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;

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
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;
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
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;
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

/* 부업 파이프라인 일괄 실행.
 * 글이 나오는 파이프라인(네이버 블로그)은 결과를 실제 발행 큐에 넣는다.
 * 나머지는 분석·기획 산출물이라 캐시만 갱신하고 대시보드에서 보게 한다. */
const HUSTLE_AUTO_ORDER = ['naver_blog', 'shorts', 'app_tech', 'ai_freelance', 'smart_store'];

async function runHustlePipelines() {
  const accounts = readAccounts().filter(a => a.enabled);
  const account  = accounts[0];
  const done = [];

  for (const id of HUSTLE_AUTO_ORDER) {
    try {
      const r = await executePipeline(id);

      // 발행 가능한 글이 나왔으면 큐에 실제로 넣는다
      if (r.data && r.data.readyToPublish && r.data.title && r.data.content) {
        const platforms = (account && account.platforms) || ['blogger'];
        enqueue({
          id:          `hustle_${id}_${Date.now()}`,
          title:       r.data.title,
          content:     r.data.content,
          tags:        r.data.tags || [],
          imagePaths:  [],
          platforms,
          scheduledAt: humanizePostTime(new Date(Date.now() + 5 * 60 * 1000)).toISOString(),
          accountId:   account && account.id,
          keyword:     r.data.keyword,
          source:      `hustle_${id}`,
        });
        console.log(`[Hustle] ${id} → 발행 예약: "${r.data.title}"`);
      }

      done.push({ id, ok: !r.error, summary: r.summary });
    } catch (e) {
      console.error(`[Hustle] ${id} 실패:`, e.message);
      done.push({ id, ok: false, summary: e.message });
    }
    await new Promise(r => setTimeout(r, 3000));   // 연속 호출 간격
  }

  const okCount = done.filter(d => d.ok).length;
  console.log(`[Hustle] 자동 실행 완료 — ${okCount}/${done.length}개 성공`);
  try {
    await notifyPublished('🤖 부업 자동 실행 완료', {
      hustle: { success: okCount > 0, summary: done.map(d => `${d.ok ? '✅' : '❌'} ${d.id}`).join(', ') },
    });
  } catch (_) {}
  return done;
}

/** 부업 전체 자동 실행 — 지금 즉시 */
app.post('/api/hustle-run-all', auth, (req, res) => {
  res.json({ success: true, message: '부업 파이프라인 실행 시작 (2~5분 소요)', pipelines: HUSTLE_AUTO_ORDER });
  runHustlePipelines().catch(e => console.error('[Hustle] 오류:', e.message));
});

// ── 부업 파이프라인 API ───────────────────────────────────
/* 파이프라인은 2~5분이 걸린다.
 * 예전엔 응답을 그대로 기다렸는데, Railway가 30초쯤에서 요청을 끊기 때문에
 * 버튼을 눌러도 항상 실패했다. jobId를 즉시 돌려주고 뒤에서 실행한다. */
const _pipelineJobs = new Map();

app.post('/api/hustle-pipeline/:hustleId', auth, (req, res) => {
  const { hustleId } = req.params;
  const clientKey = req.headers['x-anthropic-key'];
  // Railway에 키가 있으면 클라이언트 키로 덮어쓰지 않는다
  // (예전에 대시보드의 죽은 하드코딩 키가 정상 키를 덮어써 생성이 계속 실패했다)
  if (clientKey && !process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = clientKey;

  const jobId = `pipe_${hustleId}_${Date.now()}`;
  _pipelineJobs.set(jobId, { status: 'running', hustleId, startedAt: new Date().toISOString() });
  res.json({ success: true, jobId, hustleId });

  executePipeline(hustleId)
    .then(result => {
      _pipelineJobs.set(jobId, { status: 'done', success: !result.error, ...result });
    })
    .catch(err => {
      _pipelineJobs.set(jobId, { status: 'error', success: false, error: err.message, hustleId });
    });

  setTimeout(() => _pipelineJobs.delete(jobId), 60 * 60 * 1000);
});

app.get('/api/hustle-pipeline-status/:jobId', auth, (req, res) => {
  const job = _pipelineJobs.get(req.params.jobId);
  if (job) return res.json(job);
  // 서버 재시작으로 사라진 작업이면 무한 대기하지 않도록 알려준다
  const startedAt = Number((req.params.jobId.match(/_(\d+)$/) || [])[1]);
  if (startedAt && startedAt < SERVER_STARTED_AT) {
    return res.status(410).json({ status: 'error', error: '실행 도중 서버가 재시작되어 중단되었습니다. 다시 시도해주세요' });
  }
  res.status(404).json({ error: 'job not found' });
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

/* 구글이 거부한(만료·취소된) 리프레시 토큰 목록.
   브라우저 사본이 죽은 토큰을 계속 되돌려 넣으면
   "복구됨"이라고 뜨는데 실제로는 발행이 안 되는 상태가 영원히 반복된다.
   한 번 거부당한 토큰은 다시 받지 않고, 브라우저 사본에서도 지우게 알린다. */
const _deadRefreshTokens = new Set();

/** 토큰 발급 후 며칠 지났는지 — 테스트 모드(7일 만료) 판별용 */
function bloggerTokenAgeDays() {
  const iso = tokens.get('BLOGGER_TOKEN_ISSUED_AT');
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

async function checkBloggerHealth(notify = true) {
  const cid = tokens.get('BLOGGER_CLIENT_ID');
  const sec = tokens.get('BLOGGER_CLIENT_SECRET');
  const ref = tokens.get('BLOGGER_REFRESH_TOKEN');
  if (!cid || !sec || !ref) {
    _bloggerHealth = {
      checkedAt: new Date().toISOString(), ok: false,
      detail: '자격증명 없음 — 구글 계정 연결 필요',
      needsReauth: !!(cid && sec),   // ID/시크릿은 있는데 토큰만 없으면 재인증 한 번이면 끝
    };
    return _bloggerHealth;
  }
  try {
    const blogs = await getBloggerBlogId(cid, sec, ref);
    if (!tokens.get('BLOGGER_BLOG_ID') && blogs[0]) tokens.set('BLOGGER_BLOG_ID', blogs[0].id);
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: true, detail: blogs[0] ? blogs[0].name : '연결됨', needsReauth: false };
    console.log(`[Health] Blogger 정상 — ${_bloggerHealth.detail}`);
  } catch (e) {
    const g = e.response?.data || {};
    let detail = g.error_description || g.error?.message || e.message;
    if (e.response?.status === 403) {
      detail = 'Blogger API 비활성 — 구글 콘솔 API 라이브러리에서 Blogger API를 「사용」으로 켜세요';
    }
    let needsReauth = false;
    if (g.error === 'invalid_grant') {
      const age = bloggerTokenAgeDays();
      needsReauth = true;
      if (ref) _deadRefreshTokens.add(ref);
      detail = '토큰 만료 — 재연결 필요. OAuth 앱이 "테스트" 상태면 7일마다 만료되니 "프로덕션"으로 전환하세요'
             + (age !== null ? ` (발급 후 ${age}일 경과)` : '');
    }
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: false, detail, needsReauth };
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

/* ── 자가 점검 ─────────────────────────────────────────────
 * 스스로 확인하고, 고칠 수 있으면 조용히 고치고,
 * 사람이 손대야 하는 것만 하루 한 번까지만 알린다.
 * "잘 돌고 있나?"를 매번 확인하지 않아도 되게 하기 위한 것. */
const selfCheck = require('./health/self-check');
const { sendTelegram } = require('./telegram');

function currentState() {
  return selfCheck.assess({
    tokens,
    readLog,
    readQueue,
    bloggerHealth: _bloggerHealth,
    serverStartedAt: SERVER_STARTED_AT,
  });
}

async function notifyText(text) {
  const token  = tokens.get('TELEGRAM_BOT_TOKEN');
  const chatId = tokens.get('TELEGRAM_CHAT_ID');
  if (!token || !chatId) return false;
  await sendTelegram(token, chatId, text);
  return true;
}

/* 키가 '있는지'와 '통하는지'는 다르다.
   만료됐거나 잔액이 없는 키는 있어도 글이 안 만들어진다.
   새벽 자동 발행이 조용히 실패하기 전에 미리 잡는다. */
let _claudeKeyState = { ok: null, detail: null, checkedAt: null };

async function runSelfCheck({ notify = true } = {}) {
  // 고칠 수 있는 건 먼저 고친다 — 알리기 전에
  try { await checkBloggerHealth(false); } catch (_) {}

  const key = tokens.get('ANTHROPIC_API_KEY');
  if (key) {
    try {
      await probeClaudeKey(key);
      _claudeKeyState = { ok: true, detail: null, checkedAt: new Date().toISOString() };
    } catch (e) {
      _claudeKeyState = { ok: false, detail: e.message, checkedAt: new Date().toISOString() };
    }
  } else {
    _claudeKeyState = { ok: null, detail: null, checkedAt: new Date().toISOString() };
  }

  const state = currentState();
  if (_claudeKeyState.ok === false) {
    state.problems.unshift({
      key: 'claude_key_bad',
      severity: 'high',
      title: '글 생성 키가 통하지 않습니다',
      detail: _claudeKeyState.detail,
      action: /잔액/.test(_claudeKeyState.detail || '')
        ? 'console.anthropic.com 에서 충전'
        : '설정 탭에서 ANTHROPIC_API_KEY 다시 입력',
    });
    state.ok = false;
  }
  if (notify && state.problems.length) {
    const fresh = selfCheck.pickNewProblems(state.problems);
    if (fresh.length) {
      const sent = await notifyText(selfCheck.formatProblems(fresh)).catch(() => false);
      console.warn(`[SelfCheck] 손봐야 할 것 ${fresh.length}건${sent ? ' — 알림 전송함' : ' (알림 미설정)'}`);
      for (const p of fresh) console.warn(`[SelfCheck]  · ${p.title} → ${p.action}`);
    }
  }
  return state;
}

/** 지금 괜찮은지 한 줄로 — 대시보드 상단 카드가 이걸 쓴다 */
app.get('/api/self-check', auth, async (req, res) => {
  if (req.query.refresh === '1') return res.json(await runSelfCheck({ notify: false }));
  res.json(currentState());
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
  const age = bloggerTokenAgeDays();
  const ageNote = age === null ? ''
    : age >= 7 ? ` · 발급 ${age}일 전 ⚠️ 테스트 모드면 이미 만료`
    : age >= 5 ? ` · 발급 ${age}일 전 ⚠️ 테스트 모드면 곧 만료`
    : ` · 발급 ${age}일 전`;
  steps.push({ step: '3. 리프레시 토큰', ok: !!ref, detail: (ref ? `저장됨 (${ref.length}자)${ageNote}` : '없음 — 구글 계정 연결 필요') + where('BLOGGER_REFRESH_TOKEN') });

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
const RESTORABLE = [
  'BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'BLOGGER_BLOG_ID',
  'BLOGGER_TOKEN_ISSUED_AT',
  'ANTHROPIC_API_KEY', 'UNSPLASH_ACCESS_KEY',
  // 사용 금액 조회용 관리자 키 (조직 계정에만 발급됨 — 없어도 동작한다)
  'ANTHROPIC_ADMIN_KEY',
  'NAVER_CLIENT_ID', 'NAVER_CLIENT_SECRET',
  // 네이버·티스토리 로그인 정보도 재배포하면 함께 사라진다 —
  // 블로그스팟만 복구하고 나머지를 빼두면 결국 또 "연결이 끊겼다"가 된다
  'NAVER_ID', 'NAVER_PW', 'NAVER_BLOG_ID',
  'TISTORY_ID', 'TISTORY_PW', 'TISTORY_BLOG_NAME',
  // 로그인 대신 쓰는 쿠키 — 자동 로그인이 막히는 곳을 우회한다
  'NAVER_COOKIES', 'TISTORY_COOKIES',
  // 알림 채널 — 이것도 재배포 때 사라지면 조용히 알림이 끊긴다
  'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID',
  // 제휴 수익 추적 ID — 이게 없으면 링크를 걸어도 수익이 0원이다
  'COUPANG_PARTNERS_TAG', 'NAVER_CONNECT_ID',
  'LINKPRICE_ID', 'LINKPRICE_PW',
  'COUPANG_PARTNERS_ID', 'COUPANG_PARTNERS_PW',
  'NAVER_SHOPPING_ID', 'NAVER_SHOPPING_PW',
];

/* 대시보드에서 키를 직접 저장 — Railway를 거치지 않아도 되게.
 * 저장된 값은 브라우저에도 사본이 남아 재배포 후 자동 복구된다. */
const SETTABLE_KEYS = new Set([...RESTORABLE,
  'KAKAO_MOMENT_ID', 'KAKAO_MOMENT_PW',
]);

app.post('/api/keys', auth, (req, res) => {
  const saved = [], rejected = [];
  for (const [k, v] of Object.entries(req.body || {})) {
    if (!SETTABLE_KEYS.has(k)) { rejected.push(k); continue; }
    if (typeof v !== 'string' || !v.trim()) continue;
    tokens.set(k, v.trim());
    saved.push(k);
  }
  if (saved.length) console.log(`[Keys] 저장됨: ${saved.join(', ')}`);
  res.json({ ok: true, saved, rejected });
});

/** 어떤 키가 설정돼 있는지 (값은 절대 내려주지 않음) */
app.get('/api/keys/status', auth, (req, res) => {
  const out = {};
  for (const k of SETTABLE_KEYS) {
    const v = tokens.get(k);
    out[k] = v ? { set: true, hint: v.length > 8 ? v.slice(0, 4) + '…' + v.slice(-3) : '설정됨', source: tokens.sourceOf(k) }
                : { set: false };
  }
  res.json(out);
});

app.post('/api/credentials/restore', auth, (req, res) => {
  const incoming = req.body || {};
  const restored = [];
  const dead = [];
  const kept = [];   // 화면에서 저장한 값이라 건드리지 않은 것들
  for (const key of RESTORABLE) {
    const val = typeof incoming[key] === 'string' ? incoming[key].trim() : '';
    if (!val) continue;
    /* 구글이 이미 거부한 토큰이면 되돌려 넣지 않는다.
       넣어봐야 발행 때 또 invalid_grant 가 나는데,
       화면에는 "복구됨"으로 보여서 원인을 못 찾게 된다. */
    if (key === 'BLOGGER_REFRESH_TOKEN' && _deadRefreshTokens.has(val)) { dead.push(key); continue; }
    /* 화면에서 직접 저장한 값('saved')은 절대 덮어쓰지 않는다.
       복구는 '비어 있는 것을 채우는 일'이지 '최신 값을 되돌리는 일'이 아니다.

       예전엔 값이 다르면 브라우저 사본으로 덮어썼는데, 그래서
       /setup 에서 새 클라이언트 ID를 입력해도 다음 순간 브라우저에 남아 있던
       옛날(삭제된) ID가 다시 덮어써서 "OAuth client was not found"가 반복됐다.
       가장 최근에 사람이 입력한 값이 언제나 이긴다.

       환경변수('env')와 블롭('blob')은 오래된 값이 남아 있을 수 있으므로
       브라우저 사본으로 덮어쓴다 — 이게 원래 복구가 필요했던 이유다. */
    const src = tokens.sourceOf(key);
    if (src === 'saved') { kept.push(key); continue; }
    if (src === 'blob' && tokens.get(key) === val) continue;   // 블롭 값과 같으면 그대로 둔다
    tokens.set(key, val);
    restored.push(key);
  }
  if (restored.length) console.log(`[Restore] 자격증명 복구됨: ${restored.join(', ')}`);
  if (dead.length) console.warn(`[Restore] 만료된 값 무시: ${dead.join(', ')} — 구글 재연결 필요`);
  if (kept.length) console.log(`[Restore] 화면에서 저장한 값 유지(덮어쓰지 않음): ${kept.join(', ')}`);
  res.json({ ok: true, restored, kept, dead, needsReauth: dead.includes('BLOGGER_REFRESH_TOKEN') });
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

/* 구글 자격증명만 완전히 지운다.
   삭제된 OAuth 클라이언트의 옛날 ID가 서버·브라우저·환경변수에 남아 있으면
   새로 만든 클라이언트를 넣어도 계속 옛것으로 되돌아간다.
   그 고리를 끊고 처음부터 다시 입력할 수 있게 하는 비상구. */
app.post('/api/credentials/clear-blogger', auth, (req, res) => {
  const keys = ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN',
                'BLOGGER_BLOG_ID', 'BLOGGER_TOKEN_ISSUED_AT'];
  const cleared = [];
  for (const k of keys) {
    if (tokens.get(k)) cleared.push(k);
    tokens.remove(k);
  }
  _bloggerHealth = { checkedAt: new Date().toISOString(), ok: false, needsReauth: true, detail: '자격증명을 지웠습니다 — 새로 입력하세요' };
  console.log(`[Clear] 구글 자격증명 삭제: ${cleared.join(', ') || '(없음)'}`);
  res.json({
    ok: true, cleared, keys,
    note: 'CREDENTIALS_BLOB 환경변수에도 옛 값이 들어 있으면 Railway 에서 그 변수도 지우거나 새로 만들어야 합니다',
  });
});

/* 지금 연결된 값 전부를 환경변수 한 줄로 묶어준다.
   Railway Variables 에 CREDENTIALS_BLOB 으로 한 번만 붙여넣으면
   재배포하든 서버가 죽었다 살아나든 연결이 그대로 유지된다.
   볼륨을 붙일 필요도, 매번 다시 인증할 필요도 없어진다. */
app.get('/api/credentials/blob', auth, (req, res) => {
  const included = RESTORABLE.filter(k => {
    const s = tokens.sourceOf(k);
    return (s === 'saved' || s === 'blob') && !!tokens.get(k);
  });
  if (!included.length) {
    return res.json({ ok: false, error: '아직 저장된 자격증명이 없습니다 — 먼저 연결부터 하세요', keys: [] });
  }
  res.json({
    ok: true,
    name: 'CREDENTIALS_BLOB',
    value: tokens.makeBlob(included),
    keys: included,
    storage: tokens.storageInfo(),
  });
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
<div class="row"><span class="k">CLIENT ID</span><span class="v ${cid ? '' : 'off'}">${cid ? '설정됨' : '미설정'}</span></div>
${cid ? `<div style="margin:4px 0 10px">
<div style="color:#7c85b0;font-size:11px;margin-bottom:5px">지금 서버가 쓰는 클라이언트 ID — 구글 콘솔에 이 ID가 실제로 있는지 확인하세요</div>
<div class="mono-box">${cid}</div></div>` : ''}
<div class="row"><span class="k">CLIENT SECRET</span><span class="v ${sec ? '' : 'off'}">${sec ? secInfo : '미설정'}</span></div>
<div class="row"><span class="k">REFRESH TOKEN</span><span class="v ${refreshOk ? '' : 'off'}">${dot(refreshOk)}${refreshOk ? '저장됨' : '미설정'}</span></div>
<div class="row"><span class="k">BLOG ID</span><span class="v ${blogIdVal ? '' : 'off'}">${dot(!!blogIdVal)}${blogIdVal || '인증 시 자동설정'}</span></div>
<div class="row"><span class="k">자격증명 검증</span><span class="v" id="cred-test">확인 중…</span></div>
<div id="diag" style="margin-top:14px"></div>
<div class="row"><span class="k">영구 저장</span><span class="v ${store.persistent ? '' : 'off'}">${dot(store.persistent)}${
  store.mode === 'volume' ? '켜짐 (볼륨) — 재배포해도 유지'
: store.mode === 'blob'   ? (store.blobStale ? '켜짐 — 다만 복구값이 오래됨' : '켜짐 (환경변수) — 재배포해도 유지')
: '꺼짐 — 재배포 시 재연결 필요'}</span></div>
${store.persistent && store.blobStale ? `<div class="note"><b>♻️ 복구값을 다시 만들어 주세요</b>
복구값을 넣은 뒤에 연결 정보가 바뀌었습니다. 이대로 재배포하면 옛 값으로 되돌아갑니다.<br>
아래 <b>복구값 만들기</b>로 새로 만들어 Railway 의 <b>CREDENTIALS_BLOB</b> 값만 교체하세요.</div>` : ''}
${store.persistent ? '' : `<div class="note"><b>🔌 연결이 계속 끊기지 않게 하려면 (1회, 30초)</b>
아래 <b>복구값</b>을 복사해서 Railway → Variables 에 <b>CREDENTIALS_BLOB</b> 이름으로 붙여넣으세요.<br>
환경변수는 재배포해도 지워지지 않아, 한 번만 하면 다시는 안 끊깁니다.
<div style="margin-top:8px">(볼륨을 붙이는 방법도 있습니다: 서비스 우클릭 → Add Volume → Mount path <b>/data</b>)</div></div>`}
<div class="note"><b>⚠️ 구글 콘솔 → 승인된 리디렉션 URI 에 등록 필요</b>아래 주소를 그대로 복사해서 추가하세요.<div class="mono-box">${baseUrl}/oauth/blogger/callback</div></div>
<div class="note"><b>🔁 7일마다 연결이 끊긴다면 (원인 1위)</b>
OAuth 앱이 <b>테스트</b> 상태면 구글이 7일마다 토큰을 강제로 만료시킵니다. 여기서 한 번만 바꾸면 다시는 안 끊깁니다.<div class="mono-box">console.cloud.google.com/auth/audience</div>
→ 대상(Audience) 화면에서 <b>앱 게시 → 프로덕션으로 전환</b> 누르기.</div>
</div>

<div class="card"><div class="card-t">🗑 구글 연결 초기화</div>
<div style="color:#7c85b0;font-size:12px;line-height:1.7;margin-bottom:12px">
<b style="color:#fcd34d">"OAuth client was not found" (401 invalid_client)</b> 가 뜬다면,
구글 콘솔에서 그 클라이언트가 <b>삭제됐거나 다른 프로젝트</b>에 있는 것입니다.
새로 만든 값을 넣어도 옛 값이 남아 되돌아갈 수 있으니, 먼저 여기서 지우고 아래에 새로 입력하세요.
</div>
<button style="background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff" onclick="clearBlogger()">🗑 구글 자격증명 모두 지우기</button>
<div class="result" id="clear-result"></div>
</div>

<div class="card"><div class="card-t">📋 자격증명 직접 입력</div>
<ol class="steps"><li>구글 클라우드 콘솔 → <b>사용자 인증 정보</b></li><li>OAuth 클라이언트 클릭 → <b>ID·시크릿 복사</b></li><li>아래 붙여넣고 <b>검증하고 저장</b></li></ol>
<div style="height:16px"></div>
<label for="in-cid">클라이언트 ID</label><input id="in-cid" placeholder="000000000000-xxxxx.apps.googleusercontent.com" autocapitalize="off" autocorrect="off" spellcheck="false">
<label for="in-sec">클라이언트 시크릿</label><input id="in-sec" placeholder="GOCSPX-••••••••••••••••" autocapitalize="off" autocorrect="off" spellcheck="false">
<button class="btn-green" onclick="credSet()">✔ 검증하고 저장</button>
<div class="result" id="cred-set-result"></div>
</div>

<div class="card"><div class="card-t">🔑 API 키</div>
<div style="color:#7c85b0;font-size:12px;line-height:1.7;margin-bottom:14px">여기에 넣으면 Railway를 건드리지 않아도 됩니다. 저장하면 이 브라우저에도 보관돼 재배포 후 자동 복구됩니다.</div>
<label for="k-anthropic">글 생성 (console.anthropic.com)</label><input id="k-anthropic" placeholder="ANTHROPIC_API_KEY" autocapitalize="off" spellcheck="false">
<label for="k-unsplash">사진 (unsplash.com/developers)</label><input id="k-unsplash" placeholder="UNSPLASH_ACCESS_KEY" autocapitalize="off" spellcheck="false">
<label for="k-admin">사용 금액 조회 — 선택 (조직 계정만 발급 가능)</label>
<div style="color:#7c85b0;font-size:11.5px;line-height:1.6;margin:-3px 0 6px">
sk-ant-admin 으로 시작하는 관리자 키. 넣으면 이번 달 쓴 금액이 대시보드에 표시됩니다.
개인 계정은 발급이 안 되며, 없어도 나머지는 정상 동작합니다.</div>
<input id="k-admin" placeholder="ANTHROPIC_ADMIN_KEY" autocapitalize="off" spellcheck="false">
<label for="k-nid">네이버 검색 API — 키워드·상품추천 (developers.naver.com)</label>
<input id="k-nid" placeholder="NAVER_CLIENT_ID" autocapitalize="off" spellcheck="false">
<input id="k-nsecret" placeholder="NAVER_CLIENT_SECRET" autocapitalize="off" spellcheck="false">
<label for="k-tgtoken">폰 알림 — 문제 생길 때만 알려줍니다 (선택)</label>
<div style="color:#7c85b0;font-size:11.5px;line-height:1.6;margin:-3px 0 6px">
텔레그램 @BotFather 에서 봇 만들고 토큰, @userinfobot 에서 내 ID 확인해 넣으세요.
넣으면 대시보드를 안 열어봐도 됩니다.</div>
<input id="k-tgtoken" placeholder="TELEGRAM_BOT_TOKEN" autocapitalize="off" spellcheck="false">
<input id="k-tgchat" placeholder="TELEGRAM_CHAT_ID" autocapitalize="off" spellcheck="false">
<button class="btn-green" onclick="saveKeys()">💾 키 저장</button>
<div class="result" id="keys-result"></div>
</div>

<div class="card"><div class="card-t">🔒 다시는 안 끊기게 (1회만)</div>
<div style="color:#7c85b0;font-size:12px;line-height:1.7;margin-bottom:14px">
지금 연결된 정보를 값 하나로 묶어드립니다. Railway → Variables → New Variable →
이름 <b style="color:#eef0ff">CREDENTIALS_BLOB</b> 에 붙여넣고 저장하면 끝입니다.
</div>
<button class="btn-green" onclick="makeBlob()">🔑 복구값 만들기</button>
<div class="result" id="blob-result"></div>
<div id="blob-box" style="display:none"><div class="mono-box" id="blob-value"></div>
<button class="btn-green" style="margin-top:10px" onclick="copyBlob()">📋 복사하기</button>
<div class="result" id="blob-copied"></div></div>
</div>

<a class="btn btn-pink" href="/oauth/blogger">🔑 구글 계정 연결 시작</a>
</div><script>
function clearBlogger(){
  var r=document.getElementById('clear-result');
  r.textContent='지우는 중…';r.style.color='#7c85b0';
  fetch('/api/credentials/clear-blogger',{method:'POST'}).then(function(x){return x.json();}).then(function(d){
    // 브라우저 사본에서도 지운다 — 안 지우면 다음에 열 때 다시 올려보내 되살아난다
    try{var c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}');
      (d.keys||[]).forEach(function(k){delete c[k];});
      localStorage.setItem('riri_bp_creds',JSON.stringify(c));}catch(e){}
    r.innerHTML='✅ 지웠습니다 ('+(d.cleared.length)+'개). 아래에 새 ID·시크릿을 입력하세요.'
      +'<div style="color:#fcd34d;font-size:11.5px;margin-top:6px;line-height:1.6">'+d.note+'</div>';
    r.style.color='#86efac';
    setTimeout(function(){location.reload();},2500);
  }).catch(function(e){r.textContent='오류: '+e.message;r.style.color='#f87171';});
}
var _blobValue='';
function makeBlob(){
  var r=document.getElementById('blob-result');
  r.textContent='만드는 중…';r.style.color='#7c85b0';
  fetch('/api/credentials/blob').then(function(x){return x.json();}).then(function(d){
    if(!d.ok){r.textContent='❌ '+d.error;r.style.color='#f87171';return;}
    _blobValue=d.value;
    r.textContent='✅ '+d.keys.length+'개 항목 포함됨';r.style.color='#86efac';
    document.getElementById('blob-value').textContent=d.value;
    document.getElementById('blob-box').style.display='block';
  }).catch(function(e){r.textContent='오류: '+e.message;r.style.color='#f87171';});
}
function copyBlob(){
  var n=document.getElementById('blob-copied');
  function done(){n.textContent='✅ 복사됨 — Railway Variables 에 CREDENTIALS_BLOB 으로 붙여넣으세요';n.style.color='#86efac';}
  if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(_blobValue).then(done).catch(fb);}else{fb();}
  function fb(){var ta=document.createElement('textarea');ta.value=_blobValue;document.body.appendChild(ta);ta.select();
    try{document.execCommand('copy');done();}catch(e){n.textContent='복사 실패 — 위 상자를 길게 눌러 직접 복사하세요';n.style.color='#f87171';}
    document.body.removeChild(ta);}
}
// 이 브라우저에 보관된 올바른 값으로 서버를 먼저 복구한 뒤 검증한다
// (Railway 환경변수에 틀린 값이 있어도 여기서 덮어써져 자가치유됨)
var _boot=Promise.resolve();
try{
  var _saved=localStorage.getItem('riri_bp_creds');
  if(_saved){_boot=fetch('/api/credentials/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:_saved}).then(function(r){return r.json();}).then(function(d){
    if(d.restored&&d.restored.length){console.log('복구:',d.restored.join(','));}
    // 구글이 거부한 토큰이면 사본에서 지운다 — 안 지우면 매번 "복구됨"만 뜨고 발행은 계속 실패한다
    if(d.needsReauth){try{var _c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}');delete _c.BLOGGER_REFRESH_TOKEN;delete _c.BLOGGER_TOKEN_ISSUED_AT;localStorage.setItem('riri_bp_creds',JSON.stringify(_c));}catch(e){}}
  }).catch(function(){});}
}catch(e){}
// 서버의 최신 값을 사본으로 되받아 둔다 (다음 재배포 때 이 사본으로 복구된다)
_boot.then(function(){
  return fetch('/api/credentials/backup').then(function(r){return r.json();}).then(function(b){
    if(!b||!Object.keys(b).length) return;
    var c={}; try{c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}')||{};}catch(e){}
    Object.keys(b).forEach(function(k){ if(b[k]) c[k]=b[k]; });
    localStorage.setItem('riri_bp_creds',JSON.stringify(c));
  }).catch(function(){});
});
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
function saveKeys(){
  var r=document.getElementById('keys-result');
  var map={ANTHROPIC_API_KEY:'k-anthropic',UNSPLASH_ACCESS_KEY:'k-unsplash',
           NAVER_CLIENT_ID:'k-nid',NAVER_CLIENT_SECRET:'k-nsecret',
           TELEGRAM_BOT_TOKEN:'k-tgtoken',TELEGRAM_CHAT_ID:'k-tgchat',
           ANTHROPIC_ADMIN_KEY:'k-admin'};
  var payload={};
  Object.keys(map).forEach(function(k){var el=document.getElementById(map[k]);if(el&&el.value.trim())payload[k]=el.value.trim();});
  if(!Object.keys(payload).length){r.textContent='입력한 값이 없습니다';r.style.color='#f87171';return;}
  r.textContent='저장 중…';r.style.color='#7c85b0';
  fetch('/api/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(function(x){return x.json();}).then(function(d){
      r.textContent='✅ '+d.saved.length+'개 저장됨 — '+d.saved.join(', ');r.style.color='#86efac';
      try{var c={};try{c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}');}catch(e){}
      Object.keys(payload).forEach(function(k){c[k]=payload[k];});
      localStorage.setItem('riri_bp_creds',JSON.stringify(c));}catch(e){}
      Object.keys(map).forEach(function(k){var el=document.getElementById(map[k]);if(el)el.value='';});
    }).catch(function(e){r.textContent='오류: '+e.message;r.style.color='#f87171';});
}
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
    tokens.set('BLOGGER_TOKEN_ISSUED_AT', new Date().toISOString());
    _deadRefreshTokens.delete(refreshToken);   // 새로 받은 토큰은 다시 유효
    _bloggerHealth = { checkedAt: new Date().toISOString(), ok: true, detail: '방금 재연결됨', needsReauth: false };
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
  /* 기존 사본에 덮어쓰지 말고 합친다 —
     예전엔 통째로 바꿔서 인증할 때마다 API 키(글 생성·사진·네이버)가 같이 날아갔고,
     다음 재배포 때 그 키들이 복구되지 못했다. */
  var c={}; try{ c=JSON.parse(localStorage.getItem('riri_bp_creds')||'{}')||{}; }catch(e){ c={}; }
  var _new={BLOGGER_CLIENT_ID:${JSON.stringify(tokens.get('BLOGGER_CLIENT_ID') || '')},
         BLOGGER_CLIENT_SECRET:${JSON.stringify(tokens.get('BLOGGER_CLIENT_SECRET') || '')},
         BLOGGER_REFRESH_TOKEN:${JSON.stringify(refreshToken || '')},
         BLOGGER_BLOG_ID:${JSON.stringify(tokens.get('BLOGGER_BLOG_ID') || '')},
         BLOGGER_TOKEN_ISSUED_AT:${JSON.stringify(tokens.get('BLOGGER_TOKEN_ISSUED_AT') || '')}};
  Object.keys(_new).forEach(function(k){ if(_new[k]) c[k]=_new[k]; });
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

  /* 연결 유지 장치.
   * 재배포·재시작마다 연결이 끊겨 매번 처음부터 다시 연결해야 했던 문제를 막는다.
   *  - 시작 직후 점검하고, 끊겼으면 즉시 알린다
   *  - 30분마다 점검해 만료를 발행 실패 전에 잡는다
   *  - 살아있는 동안 주기적으로 토큰을 갱신해 '미사용 만료'를 막는다 */
  setTimeout(() => checkBloggerHealth(false).catch(() => {}), 8000);
  cron.schedule('*/30 * * * *', () => { checkBloggerHealth(true).catch(() => {}); }, { timezone: 'Asia/Seoul' });
  console.log('[Health] 연결 점검 크론 등록됨 (30분 간격)');

  /* 자가 점검 — 스스로 확인하고 사람이 손댈 것만 알린다.
   *  · 매시간 점검하되, 같은 문제로는 하루 한 번까지만 알린다 (알림이 잦으면 안 보게 된다)
   *  · 매일 21시 요약 한 통 — 문제 없으면 "신경 쓸 것 없습니다"로 끝난다
   * 기동 직후 점검은 조용히 한다. 배포 직후엔 아직 복구가 안 끝났을 수 있어서
   * 그 상태로 알리면 멀쩡한데 문제라고 알리는 꼴이 된다. */
  setTimeout(() => { runSelfCheck({ notify: false }).catch(() => {}); }, 20000);
  cron.schedule('7 * * * *', () => { runSelfCheck({ notify: true }).catch(() => {}); }, { timezone: 'Asia/Seoul' });
  cron.schedule('0 21 * * *', async () => {
    try {
      const state = await runSelfCheck({ notify: false });
      await notifyText(selfCheck.formatDaily(state));
      console.log('[SelfCheck] 하루 요약 전송');
    } catch (e) { console.warn('[SelfCheck] 하루 요약 실패:', e.message); }
  }, { timezone: 'Asia/Seoul' });
  console.log('[SelfCheck] 자가 점검 등록됨 (매시간 + 매일 21:00 요약)');

  /* 매일 06:30 수익 글 자동 생성·예약.
     트렌드 글이 아니라 '살까 고민하는 사람'이 검색하는 말로 쓴다. */
  cron.schedule('30 6 * * *', () => {
    runRevenuePublish(2).catch(e => console.error('[Revenue] 오류:', e.message));
  }, { timezone: 'Asia/Seoul' });
  console.log('[Revenue] 수익 글 크론 등록됨 (매일 06:30, 하루 2편)');

  const store = tokens.storageInfo();
  console.log(store.persistent
    ? `[Health] 자격증명 영구 저장 활성 (${store.volumePath}) — 재배포해도 연결 유지`
    : '[Health] 영구 저장 비활성 — 대시보드 사본으로 복구합니다');

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
      const platforms = readyPlatforms(account.platforms);
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

  /* 부업 파이프라인 자동 실행 (매일 07:00 KST)
   * 지금까지는 크론이 없어서 버튼을 눌러야만 돌았고,
   * 글을 만들어도 '발행 큐 준비 완료'라고만 하고 실제로는 큐에 넣지 않아
   * 자동으로는 아무것도 발행되지 않았다. */
  cron.schedule('0 7 * * *', () => { runHustlePipelines().catch(e => console.error('[Hustle] 오류:', e.message)); },
    { timezone: 'Asia/Seoul' });
  console.log('[Hustle] 부업 파이프라인 크론 등록됨 (매일 07:00 KST)');
});
