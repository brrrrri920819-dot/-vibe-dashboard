/**
 * test/blob-persistence.test.js
 * "복구값 넣었는데 왜 자꾸 넣으라고 뜨지?" 의 재발 방지.
 *
 * 예전 동작: 영구 저장 여부를 '아직 블롭 값 그대로인 키가 몇 개인가'로 판단했다.
 *   대시보드를 열면 자격증명이 갱신되면서 그 수가 줄고, 0이 되는 순간
 *   복구값을 넣어뒀는데도 "재배포하면 끊깁니다"가 다시 떴다.
 *
 * 지금 동작: 환경변수가 있으면 영구 저장으로 본다.
 *   대신 복구값이 지금 설정보다 오래됐으면 그건 따로 알려준다
 *   ("안 넣었다"와 "넣었는데 오래됐다"는 할 일이 다르다).
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4135;
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

function makeBlob(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function envFor(tmpName, extra = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpName));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    DISABLE_VOLUME: '1',   // 영구 저장 판정이 복구값에서만 오도록 볼륨을 끈다
    ...extra,
  };
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'ANTHROPIC_API_KEY']) {
    if (!(k in extra)) delete env[k];
  }
  return env;
}

const BLOB = {
  BLOGGER_CLIENT_ID: '111-old.apps.googleusercontent.com',
  BLOGGER_CLIENT_SECRET: 'GOCSPX-old',
  BLOGGER_REFRESH_TOKEN: '1//old-token',
};

(async () => {
  console.log('\n📦 복구값 인식 테스트\n');

  // ── 1) 복구값이 없을 때 ──────────────────────────────────
  let env = envFor('vibe-blob-none-');
  delete env.CREDENTIALS_BLOB;
  let srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();
    const s = await req('GET', '/api/self-check');
    ok('없으면 넣으라고 알려준다', s.json.problems.some(p => p.key === 'not_persistent'));
    ok('영구 저장이 꺼짐으로 나온다', s.json.persistent === false);
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 2) 복구값을 넣었을 때 ────────────────────────────────
  env = envFor('vibe-blob-set-', { CREDENTIALS_BLOB: makeBlob(BLOB) });
  srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();
    let s = await req('GET', '/api/self-check');
    ok('넣었으면 영구 저장으로 본다', s.json.persistent === true);
    ok('넣으라는 말이 사라진다', !s.json.problems.some(p => p.key === 'not_persistent'));
    ok('저장 방식을 환경변수로 표시한다', s.json.storageMode === 'blob');

    // ── 3) 대시보드를 열어 값이 갱신돼도 유지돼야 한다 ─────
    // 예전엔 여기서 "재배포하면 끊깁니다"가 다시 떴다.
    await req('POST', '/api/credentials/restore', {
      BLOGGER_CLIENT_ID: '999-new.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-new',
      BLOGGER_REFRESH_TOKEN: '1//new-token',
    });
    s = await req('GET', '/api/self-check');
    ok('값이 갱신돼도 영구 저장은 유지된다', s.json.persistent === true);
    ok('넣으라는 말이 다시 뜨지 않는다', !s.json.problems.some(p => p.key === 'not_persistent'));

    // ── 4) 대신 '오래됐다'고 구분해서 알려준다 ─────────────
    const stale = s.json.problems.find(p => p.key === 'blob_stale');
    ok('복구값이 오래됐음을 알려준다', !!stale);
    ok('안 넣었다가 아니라 교체하라고 안내한다', /교체/.test(stale.action));
    ok('이유를 설명한다', /옛 값으로 되돌아갑니다/.test(stale.detail));

    // ── 5) 새로 만들어 넣으면 경고가 사라져야 한다 ─────────
    const blob = await req('GET', '/api/credentials/blob');
    ok('새 복구값을 만들어준다', blob.json.ok === true);
    const fresh = JSON.parse(Buffer.from(blob.json.value, 'base64').toString('utf8'));
    ok('새 복구값에 최신 값이 담긴다', fresh.BLOGGER_CLIENT_ID === '999-new.apps.googleusercontent.com');

    const setupPage = await req('GET', '/setup');
    ok('설정 화면이 복구값 교체를 안내한다', /복구값을 다시 만들어/.test(setupPage.body));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 6) 최신 복구값을 넣고 뜨면 경고가 없어야 한다 ────────
  env = envFor('vibe-blob-fresh-', {
    CREDENTIALS_BLOB: makeBlob({
      BLOGGER_CLIENT_ID: '999-new.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-new',
      BLOGGER_REFRESH_TOKEN: '1//new-token',
    }),
  });
  srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();
    // 브라우저가 같은 값을 밀어넣어도 '바뀐 것'으로 보면 안 된다
    await req('POST', '/api/credentials/restore', {
      BLOGGER_CLIENT_ID: '999-new.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-new',
      BLOGGER_REFRESH_TOKEN: '1//new-token',
    });
    const s = await req('GET', '/api/self-check');
    ok('최신이면 오래됐다고 하지 않는다', !s.json.problems.some(p => p.key === 'blob_stale'));
    ok('넣으라는 말도 없다', !s.json.problems.some(p => p.key === 'not_persistent'));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally { srv.kill(); }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
