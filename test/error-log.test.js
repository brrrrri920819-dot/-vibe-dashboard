/**
 * test/error-log.test.js
 * 서버가 겪은 오류를 대시보드에서 바로 볼 수 있어야 한다.
 * (로그를 열어봐야만 원인을 아는 구조를 없애기 위한 것)
 *
 * 확인하는 것:
 *  - 발행 실패가 오류 목록에 실제로 남는가
 *  - 비밀값(시크릿·토큰·API 키)이 절대 섞여 나가지 않는가
 *  - 재시작 판별에 쓸 가동시간이 함께 오는가
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4127;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

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
  console.log('\n🧾 서버 오류 기록 테스트\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-errlog-'));
  const SECRET = 'GOCSPX-supersecretvalue123';
  const TOKEN  = '1//0aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    NAVER_ID: 'x', NAVER_PW: 'x', NAVER_BLOG_ID: 'x',
    BLOGGER_CLIENT_ID: 'x', BLOGGER_CLIENT_SECRET: SECRET, BLOGGER_REFRESH_TOKEN: TOKEN,
  };

  const srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-publishers.js'),
                             path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();

    const empty = await req('GET', '/api/errors');
    ok('오류 목록을 열 수 있다', empty.status === 200 && Array.isArray(empty.json.entries));
    ok('가동시간이 함께 온다 (재시작 판별용)', typeof empty.json.uptimeSec === 'number');
    ok('서버 시작 시각이 온다', !!empty.json.startedAt);

    // 네이버가 터지는 발행을 한 번 돌린다
    const start = await req('POST', '/api/publish-test', { platforms: ['naver', 'blogger'] });
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 500));
      const s = await req('GET', `/api/publish-test-status/${start.json.jobId}`);
      if (s.json && s.json.status !== 'running') break;
    }

    const after = await req('GET', '/api/errors?limit=60');
    const all = after.json.entries.map(e => e.msg).join('\n');
    ok('발행 실패가 기록에 남는다', /naver 실패/.test(all));
    ok('실패 원인까지 남는다', /Executable doesn't exist|브라우저/.test(all));
    ok('최신 오류가 맨 위에 온다', after.json.entries.length > 0
      && Date.parse(after.json.entries[0].ts) >= Date.parse(after.json.entries[after.json.entries.length - 1].ts));

    // ── 비밀값이 새지 않는가 ────────────────────────────────
    const raw = after.body;
    ok('클라이언트 시크릿이 노출되지 않는다', !raw.includes(SECRET));
    ok('리프레시 토큰이 노출되지 않는다', !raw.includes(TOKEN));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
