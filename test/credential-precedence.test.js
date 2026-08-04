/**
 * test/credential-precedence.test.js
 * "OAuth client was not found" 가 반복되던 진짜 원인의 재발 방지.
 *
 * 예전 동작: 브라우저 사본과 서버 값이 다르면 브라우저 사본으로 덮어썼다.
 *   → /setup 에서 새 클라이언트 ID 를 입력해도, 다음 순간 브라우저에 남아 있던
 *     옛날(삭제된) ID 가 다시 덮어써서 구글이 "클라이언트를 못 찾겠다"고 했다.
 *
 * 지금 동작: 화면에서 직접 저장한 값은 절대 덮어쓰지 않는다.
 *   복구는 '비어 있는 것을 채우는 일'이지 '최신 값을 되돌리는 일'이 아니다.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4134;
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

const OLD_ID = '111-deleted.apps.googleusercontent.com';
const NEW_ID = '999-brandnew.apps.googleusercontent.com';

(async () => {
  console.log('\n🔐 자격증명 우선순위 테스트\n');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prec-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
  };
  delete env.CREDENTIALS_BLOB;
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN']) delete env[k];

  let srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();

    // ── 1) 비어 있으면 브라우저 사본이 채운다 (원래 목적) ────
    const r1 = await req('POST', '/api/credentials/restore', { BLOGGER_CLIENT_ID: OLD_ID });
    ok('비어 있을 땐 사본으로 채운다', r1.json.restored.includes('BLOGGER_CLIENT_ID'));

    // ── 2) 화면에서 새 값을 입력한다 ─────────────────────────
    await req('POST', '/api/keys', { BLOGGER_CLIENT_ID: NEW_ID });
    let st = await req('GET', '/api/keys/status');
    ok('새로 입력한 값이 저장된다', st.json.BLOGGER_CLIENT_ID.source === 'saved');

    // ── 3) 옛 사본이 다시 올라와도 덮어쓰지 않아야 한다 ──────
    // 이게 핵심. 예전엔 여기서 옛 ID 로 되돌아가 구글이 클라이언트를 못 찾았다.
    const r2 = await req('POST', '/api/credentials/restore', { BLOGGER_CLIENT_ID: OLD_ID });
    ok('옛 사본은 복구 목록에 들어가지 않는다', !r2.json.restored.includes('BLOGGER_CLIENT_ID'));
    ok('건드리지 않았다고 알려준다', r2.json.kept.includes('BLOGGER_CLIENT_ID'));

    const blob = await req('GET', '/api/credentials/blob');
    const decoded = JSON.parse(Buffer.from(blob.json.value, 'base64').toString('utf8'));
    ok('새 값이 그대로 살아있다', decoded.BLOGGER_CLIENT_ID === NEW_ID);
    ok('옛 값으로 되돌아가지 않는다', decoded.BLOGGER_CLIENT_ID !== OLD_ID);

    // 여러 번 열어도(=여러 번 복구해도) 그대로여야 한다
    for (let i = 0; i < 3; i++) await req('POST', '/api/credentials/restore', { BLOGGER_CLIENT_ID: OLD_ID });
    const blob2 = await req('GET', '/api/credentials/blob');
    const decoded2 = JSON.parse(Buffer.from(blob2.json.value, 'base64').toString('utf8'));
    ok('여러 번 반복해도 새 값이 유지된다', decoded2.BLOGGER_CLIENT_ID === NEW_ID);

    // ── 4) 초기화하면 어디에도 남지 않아야 한다 ──────────────
    const cleared = await req('POST', '/api/credentials/clear-blogger');
    ok('초기화가 지운 항목을 알려준다', cleared.json.cleared.includes('BLOGGER_CLIENT_ID'));
    st = await req('GET', '/api/keys/status');
    ok('서버에서 완전히 사라진다', st.json.BLOGGER_CLIENT_ID.set === false);
    ok('브라우저에서 지울 키 목록을 준다', cleared.json.keys.includes('BLOGGER_CLIENT_ID'));
    ok('환경변수 블롭도 손보라고 안내한다', /CREDENTIALS_BLOB/.test(cleared.json.note));

    // 초기화 뒤에는 다시 사본으로 채워질 수 있어야 한다 (비어 있으므로)
    const r3 = await req('POST', '/api/credentials/restore', { BLOGGER_CLIENT_ID: NEW_ID });
    ok('초기화 후에는 다시 채울 수 있다', r3.json.restored.includes('BLOGGER_CLIENT_ID'));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 5) 환경변수의 옛 값은 사본으로 덮어써야 한다 ───────────
  // (복구 기능이 원래 필요했던 이유 — 이건 계속 동작해야 한다)
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-prec-env-'));
  srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...env, TOKENS_FILE: path.join(tmp2, 'tokens.json'), PERSIST_DIR: path.join(tmp2, 'vol'),
           BLOGGER_CLIENT_ID: OLD_ID },
    stdio: 'ignore',
  });
  try {
    await waitForServer();
    const r = await req('POST', '/api/credentials/restore', { BLOGGER_CLIENT_ID: NEW_ID });
    ok('환경변수의 옛 값은 사본으로 덮어쓴다', r.json.restored.includes('BLOGGER_CLIENT_ID'));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally { srv.kill(); }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
