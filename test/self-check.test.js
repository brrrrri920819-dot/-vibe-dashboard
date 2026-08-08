/**
 * test/self-check.test.js
 * "잘 돌고 있나?"를 사람이 확인하지 않아도 되게 만든 장치 검증.
 *
 * 확인하는 것:
 *  1) 손봐야 할 것을 정확히 집어내는가 (없는데 있다고 하면 그게 더 스트레스다)
 *  2) 같은 문제로 반복해서 알리지 않는가
 *  3) 문제가 해결되면 기록이 지워져, 재발했을 때 다시 알리는가
 *  4) 문제가 없을 때는 "신경 쓸 것 없다"로 끝나는가
 *  5) 대시보드가 상태를 한 번에 받아갈 수 있는가
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sc = require('../health/self-check');

const PORT = 4129;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

/** 가짜 자격증명 저장소 */
function fakeTokens(values, persistent = true) {
  return {
    get: (k) => values[k] || null,
    storageInfo: () => ({ persistent, mode: persistent ? 'blob' : 'none' }),
  };
}

const FULL = {
  ANTHROPIC_API_KEY: 'sk-ant-x',
  BLOGGER_CLIENT_ID: 'a', BLOGGER_CLIENT_SECRET: 'b', BLOGGER_REFRESH_TOKEN: 'c',
  COUPANG_PARTNERS_TAG: 'AF1234567',   // 없으면 '수익 0원' 경고가 뜬다
};

function req(method, p, port) {
  return new Promise((resolve, reject) => {
    const r = http.request(`http://127.0.0.1:${port}${p}`, { method }, (res) => {
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

function waitForServer(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = (n) => req('GET', '/api/health', port).then(resolve).catch(() => {
      if (n <= 0) return reject(new Error('서버가 뜨지 않음'));
      setTimeout(() => tick(n - 1), 250);
    });
    tick(tries);
  });
}

(async () => {
  console.log('\n🩺 자가 점검 테스트\n');

  // ── 1) 문제를 정확히 집어내는가 ──────────────────────────
  const healthy = sc.assess({
    tokens: fakeTokens(FULL),
    readLog: () => [{ status: 'done', loggedAt: new Date().toISOString() }],
    readQueue: () => [],
    bloggerHealth: { ok: true, needsReauth: false },
    serverStartedAt: Date.now() - 3600_000,
  });
  ok('정상일 때 문제 없음으로 본다', healthy.ok === true && healthy.problems.length === 0);
  ok('오늘 발행 건수를 센다', healthy.today.published === 1);

  const noKey = sc.assess({
    tokens: fakeTokens({ ...FULL, ANTHROPIC_API_KEY: null }),
    readLog: () => [], readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  ok('글 생성 키가 없으면 잡아낸다', noKey.problems.some(p => p.key === 'no_anthropic'));
  ok('가장 중요한 문제로 표시한다', noKey.problems.find(p => p.key === 'no_anthropic').severity === 'high');

  const reauth = sc.assess({
    tokens: fakeTokens(FULL),
    readLog: () => [], readQueue: () => [],
    bloggerHealth: { ok: false, needsReauth: true, detail: '토큰 만료' },
    serverStartedAt: Date.now() - 3600_000,
  });
  ok('구글 재연결 필요를 잡아낸다', reauth.problems.some(p => p.key === 'blogger_reauth'));
  ok('무엇을 하면 되는지 알려준다', /setup/.test(reauth.problems.find(p => p.key === 'blogger_reauth').action));

  const volatile = sc.assess({
    tokens: fakeTokens(FULL, false),
    readLog: () => [], readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  ok('재배포하면 끊기는 상태를 잡아낸다', volatile.problems.some(p => p.key === 'not_persistent'));

  const noPlatform = sc.assess({
    tokens: fakeTokens({ ANTHROPIC_API_KEY: 'x' }),
    readLog: () => [], readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  ok('연결된 블로그가 없으면 잡아낸다', noPlatform.problems.some(p => p.key === 'no_platform'));

  const failing = sc.assess({
    tokens: fakeTokens(FULL),
    readLog: () => Array.from({ length: 5 }, () => ({ status: 'failed', error: '로그인 실패', loggedAt: new Date().toISOString() })),
    readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  ok('발행이 계속 실패하면 잡아낸다', failing.problems.some(p => p.key === 'all_failing'));

  const mixed = sc.assess({
    tokens: fakeTokens(FULL),
    readLog: () => [{ status: 'done' }, { status: 'failed' }, { status: 'done' }],
    readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  ok('가끔 실패하는 건 문제로 보지 않는다 (헛알림 방지)', !mixed.problems.some(p => p.key === 'all_failing'));

  /* 추적 ID가 없으면 글이 올라가도 수익이 0원이다 — 반드시 알려야 한다 */
  const noTracking = sc.assess({
    tokens: fakeTokens({ ...FULL, COUPANG_PARTNERS_TAG: null }),
    readLog: () => [], readQueue: () => [],
    bloggerHealth: { ok: true }, serverStartedAt: Date.now() - 3600_000,
  });
  const tr = noTracking.problems.find(p => p.key === 'no_affiliate_tracking');
  ok('제휴 추적 ID가 없으면 잡아낸다', !!tr);
  ok('수익이 0원이라고 분명히 말한다', /0원/.test(tr.detail));
  ok('쿠팡파트너스 가입을 안내한다', /쿠팡파트너스/.test(tr.action));

  // ── 2) 같은 문제로 반복 알리지 않는가 ────────────────────
  sc._reset();
  const probs = noKey.problems;
  const first = sc.pickNewProblems(probs);
  ok('처음 발견하면 알린다', first.length === probs.length);
  const second = sc.pickNewProblems(probs);
  ok('같은 문제는 다시 알리지 않는다', second.length === 0);
  const third = sc.pickNewProblems(probs);
  ok('계속 눌러도 조용하다', third.length === 0);

  // ── 3) 해결되면 잊고, 재발하면 다시 알리는가 ─────────────
  sc.pickNewProblems([]);                    // 문제가 사라진 상태로 한 번 점검
  const again = sc.pickNewProblems(probs);   // 다시 발생
  ok('해결됐다가 재발하면 다시 알린다', again.length === probs.length);

  // ── 4) 문구 ──────────────────────────────────────────────
  ok('문제 알림에 할 일이 들어간다', /👉/.test(sc.formatProblems(probs)));
  const daily = sc.formatDaily(healthy);
  ok('정상일 땐 안심시키는 요약을 보낸다', /신경 쓰실 것 없습니다/.test(daily));
  ok('정상 요약에 오늘 실적이 들어간다', /1건 발행/.test(daily));
  ok('문제가 있으면 요약 대신 문제를 보낸다', /손봐야 할 게 있습니다/.test(sc.formatDaily(noKey)));

  // ── 5) 대시보드가 한 번에 받아가는가 ─────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-selfcheck-'));
  const env = { ...process.env, PORT: String(PORT), TOKENS_FILE: path.join(tmp, 'tokens.json'), PERSIST_DIR: path.join(tmp, 'vol') };
  delete env.CREDENTIALS_BLOB;
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer(PORT);
    const s = await req('GET', '/api/self-check', PORT);
    ok('상태를 한 번에 내려준다', s.status === 200 && Array.isArray(s.json.problems));
    ok('오늘 실적이 함께 온다', s.json.today && typeof s.json.today.published === 'number');
    ok('플랫폼별 준비 상태가 함께 온다', s.json.ready && 'blogger' in s.json.ready);
    ok('문제마다 할 일이 붙어 있다', s.json.problems.every(p => p.action && p.title));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
