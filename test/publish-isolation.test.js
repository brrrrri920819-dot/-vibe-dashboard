/**
 * test/publish-isolation.test.js
 * "글이 한 군데도 안 올라간다"의 구조적 원인 재발 방지.
 *
 * 예전 동작: 네이버 크로미움 실행이 예외로 터지면 발행 반복문이 통째로 중단돼
 *            블로그스팟·티스토리는 시도조차 못 했다.
 * 지금 동작: 한 플랫폼이 터져도 나머지는 계속 발행된다.
 *
 * 실제 블로그에 붙지 않고, 각 발행기를 바꿔치기해 동작만 검증한다.
 */

'use strict';

const assert = require('assert');
const Module = require('module');
const path = require('path');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

const http = require('http');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

const PORT = 4126;
const BASE = `http://127.0.0.1:${PORT}`;

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${BASE}${p}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: d, json });
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

(async () => {
  console.log('\n🚀 발행 격리 테스트 (한 곳이 터져도 나머지는 올라가는가)\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-iso-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    // 발행기가 자격증명 검사에서 먼저 막히지 않도록 채워둔다 (전부 스텁이라 실제 접속 없음)
    NAVER_ID: 'x', NAVER_PW: 'x', NAVER_BLOG_ID: 'x',
    TISTORY_ID: 'x', TISTORY_PW: 'x', TISTORY_BLOG_NAME: 'x',
    BLOGGER_CLIENT_ID: 'x', BLOGGER_CLIENT_SECRET: 'x', BLOGGER_REFRESH_TOKEN: 'x',
  };

  const srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-publishers.js'),
                             path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();

    const start = await req('POST', '/api/publish-test', { platforms: ['naver', 'blogger', 'tistory'] });
    ok('발행 테스트가 잡을 만들어 바로 응답한다', start.json && start.json.jobId);

    let job = null;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = await req('GET', `/api/publish-test-status/${start.json.jobId}`);
      job = s.json;
      if (job && job.status !== 'running') break;
    }
    ok('결과가 끝까지 나온다', job && job.status === 'done');

    ok('터진 네이버는 실패로 기록된다', job.results.naver.success === false);
    ok('실패 원인이 그대로 보인다', /Executable doesn't exist|브라우저/.test(job.results.naver.error || ''));

    ok('블로그스팟은 정상 발행된다 (중단되지 않음)', job.results.blogger.success === true);
    ok('티스토리도 정상 발행된다 (중단되지 않음)', job.results.tistory.success === true);
    ok('성공한 글의 주소가 돌아온다', !!job.results.blogger.url && !!job.results.tistory.url);
    ok('하나라도 성공하면 anySuccess 가 참', job.anySuccess === true);

    // 잃어버린 잡은 무한 대기 대신 분명히 알린다
    const gone = await req('GET', '/api/publish-test-status/test_없는잡');
    ok('사라진 잡은 410으로 알린다', gone.status === 410);

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
