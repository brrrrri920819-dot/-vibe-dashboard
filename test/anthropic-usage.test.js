/**
 * test/anthropic-usage.test.js
 * 글 생성 비용·잔액 확인.
 *
 * 중요한 전제: 앤트로픽은 '남은 잔액'을 알려주는 API가 없다.
 * 그래서 두 갈래로 답해야 한다.
 *   1) 쓸 수 있는 상태인가 — 실제 호출로 판단 (잔액 바닥나면 여기서 걸린다)
 *   2) 얼마나 썼나 — 관리자 키가 있을 때만. 없으면 없다고 분명히 말해야 한다
 *      (개인 계정은 관리자 키가 아예 발급되지 않으므로 흔한 경우다)
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { formatUsd, fetchSpend } = require('../income/anthropic-usage');

const PORT = 4132;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${PORT}${p}`, { method }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, json });
      });
    });
    r.on('error', reject);
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
  console.log('\n💳 비용·잔액 확인 테스트\n');

  // ── 금액 표기 ────────────────────────────────────────────
  // API는 센트를 문자열로 준다. "123.45" 는 $1.23 이다.
  ok('센트를 달러로 바꾼다', formatUsd('123.45') === '$1.23');
  ok('0원도 제대로 표기한다', formatUsd(0) === '$0.00');
  ok('큰 금액에 자릿점을 넣는다', formatUsd(123456789) === '$1,234,567.89');
  ok('값이 없어도 깨지지 않는다', formatUsd(undefined) === '$0.00');

  // ── 관리자 키가 없거나 잘못된 경우 ───────────────────────
  const noKey = await fetchSpend(null);
  ok('관리자 키가 없으면 그렇다고 한다', noKey.ok === false && noKey.reason === 'no_key');

  const wrongKey = await fetchSpend('sk-ant-api03-일반키');
  ok('일반 키를 관리자 키로 착각하지 않는다', wrongKey.reason === 'wrong_key_type');
  ok('관리자 키 형식을 알려준다', /sk-ant-admin/.test(wrongKey.message));

  // ── 서버 응답 ────────────────────────────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-usage-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    ANTHROPIC_API_KEY: 'sk-ant-good',
    STUB_CLAUDE: 'ok',
  };
  delete env.ANTHROPIC_ADMIN_KEY;
  delete env.CREDENTIALS_BLOB;

  let srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-claude.js'),
                           path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();
    const r = await req('GET', '/api/anthropic-usage');
    ok('확인 결과를 내려준다', r.status === 200);
    ok('쓸 수 있는 상태라고 답한다', r.json.usable.ok === true);
    ok('관리자 키가 없으면 사용 금액은 못 준다고 말한다', r.json.spend.ok === false && r.json.spend.reason === 'no_key');
    ok('사용 금액을 못 주는 이유를 알려준다', /관리자 키/.test(r.json.spend.message));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 잔액이 바닥난 경우 — 이게 진짜 알고 싶은 것 ──────────
  srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-claude.js'),
                       path.join(__dirname, '..', 'server.js')],
              { env: { ...env, STUB_CLAUDE: 'credit' }, stdio: 'ignore' });
  try {
    await waitForServer();
    const r = await req('GET', '/api/anthropic-usage');
    ok('잔액 바닥을 잡아낸다', r.json.usable.ok === false);
    ok('잔액 문제로 구분한다', r.json.usable.reason === 'no_credit');
    ok('충전하라고 알려준다', /충전/.test(r.json.usable.message));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 키가 아예 없는 경우 ──────────────────────────────────
  const envNoKey = { ...env };
  delete envNoKey.ANTHROPIC_API_KEY;
  srv = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-claude.js'),
                       path.join(__dirname, '..', 'server.js')], { env: envNoKey, stdio: 'ignore' });
  try {
    await waitForServer();
    const r = await req('GET', '/api/anthropic-usage');
    ok('키가 없으면 키부터 넣으라고 한다', r.json.usable.reason === 'no_key');

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally { srv.kill(); }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
