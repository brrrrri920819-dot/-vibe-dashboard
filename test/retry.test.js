/**
 * test/retry.test.js
 * 일시적인 실패는 알아서 다시 해보는가.
 *
 * 크로미움이 메모리 부족으로 못 뜨거나 네트워크가 잠깐 끊기는 건
 * 다시 하면 되는 일이다. 한 번에 실패로 끝내면 "또 안 되네"가 반복된다.
 * 반대로 토큰 만료·비밀번호 오류는 다시 해도 똑같으므로 재시도하면 안 된다
 * (괜히 두 번 로그인 시도해서 계정이 잠기는 게 더 나쁘다).
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4130;
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

async function runPublish(platforms) {
  const start = await req('POST', '/api/publish-test', { platforms });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    const s = await req('GET', `/api/publish-test-status/${start.json.jobId}`);
    if (s.json && s.json.status !== 'running') return s.json;
  }
  throw new Error('결과가 나오지 않음');
}

(async () => {
  console.log('\n🔁 자동 재시도 테스트\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-retry-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    RETRY_WAIT_MS: '300',            // 테스트에서는 기다리지 않는다
    TEST_COUNTS_FILE: path.join(tmp, 'counts.json'),
    NAVER_ID: 'x', NAVER_PW: 'x', NAVER_BLOG_ID: 'x',
    TISTORY_ID: 'x', TISTORY_PW: 'x', TISTORY_BLOG_NAME: 'x',
    BLOGGER_CLIENT_ID: 'x', BLOGGER_CLIENT_SECRET: 'x', BLOGGER_REFRESH_TOKEN: 'x',
  };
  const srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-retry.js'),
                             path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();

    // 네이버: 첫 시도는 크로미움 실행 실패, 두 번째는 성공하도록 심어둠
    const r1 = await runPublish(['naver']);
    ok('일시적 실패는 다시 시도해서 성공한다', r1.results.naver.success === true);

    const readCounts = () => JSON.parse(fs.readFileSync(path.join(tmp, 'counts.json'), 'utf8'));
    const counts = readCounts();
    ok('네이버를 두 번 시도했다', counts.naver === 2);

    // 티스토리: 토큰 만료 — 다시 해도 소용없으므로 한 번만 시도해야 한다
    const r2 = await runPublish(['tistory']);
    ok('만료 오류는 실패로 끝난다', r2.results.tistory.success === false);
    const counts2 = readCounts();
    ok('만료 오류는 재시도하지 않는다 (계정 잠김 방지)', counts2.tistory === 1);

    // 블로거: 계속 일시적 실패 — 두 번까지만 시도하고 포기한다 (무한 반복 금지)
    const r3 = await runPublish(['blogger']);
    ok('계속 실패하면 실패로 끝난다', r3.results.blogger.success === false);
    const counts3 = readCounts();
    ok('두 번까지만 시도한다 (무한 반복 안 함)', counts3.blogger === 2);

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
