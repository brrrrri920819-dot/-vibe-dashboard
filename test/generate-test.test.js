/**
 * test/generate-test.test.js
 * "글이 왜 안 써지냐"에 답하는 진단이 실제로 원인을 가르는가.
 *
 * 글 생성이 막히는 이유는 셋 중 하나다.
 *   1) 키가 없다  2) 키가 통하지 않는다(만료·잔액)  3) 생성 자체가 실패한다
 * 이 셋이 화면에서 구분돼야 엉뚱한 곳을 고치지 않는다.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4131;
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

async function runGen(keyword) {
  const start = await req('POST', '/api/generate-test', { keyword });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 400));
    const s = await req('GET', `/api/generate-test-status/${start.json.jobId}`);
    if (s.json && s.json.status !== 'running') return s.json;
  }
  throw new Error('결과가 나오지 않음');
}

function spawnServer(extraEnv, tmpName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), tmpName));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
    ...extraEnv,
  };
  if (!('ANTHROPIC_API_KEY' in extraEnv)) delete env.ANTHROPIC_API_KEY;
  delete env.CREDENTIALS_BLOB;
  return spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-claude.js'),
                        path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
}

(async () => {
  console.log('\n✍️ 글 생성 진단 테스트\n');

  // ── 1) 키가 아예 없을 때 ─────────────────────────────────
  let srv = spawnServer({ STUB_CLAUDE: 'ok' }, 'vibe-gen-nokey-');
  try {
    await waitForServer();
    const r = await runGen('테스트');
    ok('키가 없으면 1단계에서 멈춘다', r.steps[0].ok === false);
    ok('무엇을 넣어야 하는지 알려준다', /ANTHROPIC_API_KEY/.test(r.steps[0].detail));
    ok('뒤 단계를 헛돌리지 않는다', r.steps.length === 1);
    ok('실패로 결론 낸다', r.ok === false);
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 2) 키는 있는데 거부당할 때 ───────────────────────────
  srv = spawnServer({ ANTHROPIC_API_KEY: 'sk-ant-bad', STUB_CLAUDE: 'auth' }, 'vibe-gen-badkey-');
  try {
    await waitForServer();
    const r = await runGen('테스트');
    ok('키가 있으면 1단계는 통과한다', r.steps[0].ok === true);
    ok('통하지 않는 키를 2단계에서 잡는다', r.steps[1].ok === false);
    ok('키를 다시 넣으라고 알려준다', /키를 다시 발급/.test(r.steps[1].detail));
    ok('글 만들기까지 가지 않는다', r.steps.length === 2);
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 3) 잔액이 없을 때 (원인이 다르면 안내도 달라야 한다) ──
  srv = spawnServer({ ANTHROPIC_API_KEY: 'sk-ant-nocredit', STUB_CLAUDE: 'credit' }, 'vibe-gen-credit-');
  try {
    await waitForServer();
    const r = await runGen('테스트');
    ok('잔액 부족을 따로 구분한다', /잔액/.test(r.steps[1].detail));
    ok('충전하라고 알려준다', /충전/.test(r.steps[1].detail));
  } finally { srv.kill(); await new Promise(r => setTimeout(r, 400)); }

  // ── 4) 다 정상일 때 ──────────────────────────────────────
  srv = spawnServer({ ANTHROPIC_API_KEY: 'sk-ant-good', STUB_CLAUDE: 'ok' }, 'vibe-gen-ok-');
  try {
    await waitForServer();
    const r = await runGen('아침 루틴');
    ok('3단계까지 모두 통과한다', r.ok === true && r.steps.every(s => s.ok));
    ok('만들어진 제목을 보여준다', !!r.title);
    ok('글자 수를 보여준다', typeof r.chars === 'number' && r.chars > 0);
    ok('미리보기를 보여준다', !!r.preview);

    // 잃어버린 잡은 무한 대기 대신 분명히 알린다
    const gone = await req('GET', '/api/generate-test-status/gentest_없음');
    ok('사라진 잡은 410으로 알린다', gone.status === 410);

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally { srv.kill(); }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
