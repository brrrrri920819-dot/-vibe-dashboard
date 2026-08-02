/**
 * test/full-check.test.js
 * "지금 글이 올라가냐"에 한 번에 답하는 점검.
 *
 * 잔액 확인 → 글 만들기 → 진짜 발행까지 실제로 해보고,
 * 되면 글 주소를, 안 되면 '어디서 왜' 막혔는지 하나만 남겨야 한다.
 * 중간에 막히면 뒤 단계를 헛돌리지 않아야 한다 (돈과 시간이 나간다).
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4133;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`http://127.0.0.1:${PORT}${p}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitForServer(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = (n) => req('GET', '/api/health').then(resolve).catch(() => {
      if (n <= 0) return reject(new Error('서버가 뜨지 않음'));
      setTimeout(() => tick(n - 1), 250);
    });
    tick(tries);
  });
}

async function runFull() {
  const start = await req('POST', '/api/full-check', {});
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 400));
    const s = await req('GET', `/api/full-check-status/${start.json.jobId}`);
    if (s.json && s.json.status !== 'running') return s.json;
  }
  throw new Error('결과가 나오지 않음');
}

function baseEnv(tmpName, extra) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpName));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    RETRY_WAIT_MS: '300',
    ...extra,
  };
  delete env.CREDENTIALS_BLOB;
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN',
                   'NAVER_ID', 'NAVER_PW', 'NAVER_BLOG_ID',
                   'TISTORY_ID', 'TISTORY_PW', 'TISTORY_BLOG_NAME', 'ANTHROPIC_API_KEY']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

function spawnServer(env, stubs) {
  const args = [];
  for (const s of stubs) args.push('--require', path.join(__dirname, 'helpers', s));
  args.push(path.join(__dirname, '..', 'server.js'));
  return spawn('node', args, { env, stdio: 'ignore' });
}

(async () => {
  console.log('\n🔎 전체 점검 테스트\n');

  // ── 1) 연결된 블로그가 없을 때 ───────────────────────────
  let srv = spawnServer(baseEnv('vibe-full-noblog-', { STUB_CLAUDE: 'ok' }), ['stub-claude.js']);
  try {
    await waitForServer();
    const r = await runFull();
    ok('블로그가 없으면 1단계에서 끝난다', r.steps.length === 1 && r.steps[0].ok === false);
    ok('돈 드는 단계로 넘어가지 않는다', !r.steps.some(s => /글 만들기/.test(s.step)));
    ok('무엇을 하면 되는지 한 줄로 답한다', /setup/.test(r.verdict));
    ok('올라가지 않았다고 결론 낸다', r.ok === false);
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 2) 블로그는 있는데 잔액이 없을 때 ────────────────────
  srv = spawnServer(baseEnv('vibe-full-credit-', {
    STUB_CLAUDE: 'credit', ANTHROPIC_API_KEY: 'sk-ant-x',
    NAVER_ID: 'x', NAVER_PW: 'x', NAVER_BLOG_ID: 'x',
  }), ['stub-claude.js', 'stub-publishers.js']);
  try {
    await waitForServer();
    const r = await runFull();
    ok('블로그 연결은 통과한다', r.steps[0].ok === true);
    ok('잔액에서 막힌다', r.steps.find(s => /글 생성 준비/.test(s.step)).ok === false);
    ok('충전하면 된다고 알려준다', /충전/.test(r.verdict));
    ok('글 만들기까지 가지 않는다', !r.steps.some(s => /4\. 글 만들기/.test(s.step)));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 3) 다 되는 경우 — 실제로 올라가야 한다 ───────────────
  srv = spawnServer(baseEnv('vibe-full-ok-', {
    STUB_CLAUDE: 'ok', ANTHROPIC_API_KEY: 'sk-ant-x',
    TISTORY_ID: 'x', TISTORY_PW: 'x', TISTORY_BLOG_NAME: 'x',
  }), ['stub-claude.js', 'stub-publishers.js']);
  try {
    await waitForServer();
    const r = await runFull();
    ok('끝까지 통과한다', r.ok === true);
    ok('만든 글 제목이 남는다', !!r.title);
    ok('올라갔다고 분명히 말한다', /올라갔습니다/.test(r.verdict));
    ok('올라간 글 주소를 준다', r.published.tistory.success === true && !!r.published.tistory.url);
    ok('다섯 단계를 모두 밟는다', r.steps.length === 5);
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 4) 글은 만들어졌는데 발행이 실패할 때 ────────────────
  srv = spawnServer(baseEnv('vibe-full-pubfail-', {
    STUB_CLAUDE: 'ok', ANTHROPIC_API_KEY: 'sk-ant-x',
    NAVER_ID: 'x', NAVER_PW: 'x', NAVER_BLOG_ID: 'x',
  }), ['stub-claude.js', 'stub-publishers.js']);
  try {
    await waitForServer();
    const r = await runFull();
    ok('발행 실패를 잡아낸다', r.ok === false);
    ok('글은 만들어졌다고 구분해서 알려준다', /만들어졌는데 올라가지 않았습니다/.test(r.verdict));
    ok('실패 원인이 결론에 들어간다', /브라우저|Executable/.test(r.verdict));

    const gone = await req('GET', '/api/full-check-status/full_없음');
    ok('사라진 잡은 410으로 알린다', gone.status === 410);

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally { srv.kill(); }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
