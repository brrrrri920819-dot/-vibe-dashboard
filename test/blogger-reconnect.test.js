/**
 * test/blogger-reconnect.test.js
 * "구글 블로그만 또 연결 안 됨" 재발 방지 테스트.
 *
 * 확인하는 것:
 *  1) 재배포 후 브라우저 사본으로 자격증명이 실제로 되살아나는가
 *  2) 구글이 거부한(만료된) 토큰을 계속 되돌려 넣지 않는가
 *  3) 만료된 상태를 서버가 needsReauth 로 알려주는가
 *  4) 인증 성공 페이지가 기존 사본을 덮어써서 다른 키를 날리지 않는가
 *  5) 네이버·티스토리 로그인 정보도 복구 대상에 들어있는가
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4123;
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
        let json = null;
        try { json = JSON.parse(d); } catch (_) {}
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
    const tick = (n) => {
      req('GET', '/api/health').then(resolve).catch(() => {
        if (n <= 0) return reject(new Error('서버가 뜨지 않음'));
        setTimeout(() => tick(n - 1), 250);
      });
    };
    tick(tries);
  });
}

(async () => {
  console.log('\n🔌 블로그 재연결 방어 테스트\n');

  // 실제 저장소를 건드리지 않도록 매 실행마다 새 임시 경로를 쓴다
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reconnect-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    TOKENS_FILE: path.join(tmp, 'tokens.json'),
    PERSIST_DIR: path.join(tmp, 'vol'),
  };
  // 환경변수에 남은 진짜 값이 테스트 판정을 흐리지 않도록 비운다
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'BLOGGER_BLOG_ID',
                   'NAVER_ID', 'NAVER_PW', 'TISTORY_ID', 'ANTHROPIC_API_KEY']) delete env[k];

  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env, stdio: 'ignore' });
  try {
    await waitForServer();

    // ── 1) 브라우저 사본으로 복구 ──────────────────────────
    const copy = {
      BLOGGER_CLIENT_ID: '111-abc.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-testsecret',
      BLOGGER_REFRESH_TOKEN: '1//test-refresh-token',
      NAVER_ID: 'naver_user',
      NAVER_PW: 'naver_pw',
      TISTORY_ID: 'tistory_user',
    };
    const r1 = await req('POST', '/api/credentials/restore', copy);
    ok('복구 요청이 성공한다', r1.json && r1.json.ok);
    ok('블로그스팟 3종이 복구된다',
      ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN']
        .every(k => r1.json.restored.includes(k)));
    ok('네이버 로그인 정보도 복구된다', r1.json.restored.includes('NAVER_ID') && r1.json.restored.includes('NAVER_PW'));
    ok('티스토리 로그인 정보도 복구된다', r1.json.restored.includes('TISTORY_ID'));

    // ── 2) 복구된 값이 실제로 서버에 들어갔는가 ────────────
    const st = await req('GET', '/api/keys/status');
    ok('리프레시 토큰이 서버에 설정된다', st.json.BLOGGER_REFRESH_TOKEN.set === true);
    ok('네이버 비밀번호가 서버에 설정된다', st.json.NAVER_PW.set === true);

    // ── 3) 사본을 다시 받아올 수 있는가 (다음 재배포 대비) ─
    const bk = await req('GET', '/api/credentials/backup');
    ok('백업에 리프레시 토큰이 담긴다', bk.json.BLOGGER_REFRESH_TOKEN === copy.BLOGGER_REFRESH_TOKEN);
    ok('백업에 네이버 정보도 담긴다', bk.json.NAVER_ID === 'naver_user');

    // ── 4) 연결 실패를 헬스체크가 잡아내는가 ───────────────
    const h = await req('GET', '/api/health/blogger?refresh=1');
    ok('헬스체크가 연결 실패를 잡아낸다', h.json.ok === false);

    // ── 5) 진단에 토큰 나이가 나오는가 ─────────────────────
    await req('POST', '/api/keys', { BLOGGER_TOKEN_ISSUED_AT: new Date(Date.now() - 9 * 86400000).toISOString() });
    const dg = await req('GET', '/api/blogger-diagnose');
    const tokenStep = dg.json.steps.find(s => s.step.includes('리프레시'));
    ok('진단에 발급 경과일이 표시된다', /발급 9일 전/.test(tokenStep.detail));
    ok('7일 넘으면 테스트 모드 만료를 경고한다', /테스트 모드면 이미 만료/.test(tokenStep.detail));

    // ── 6) 인증 성공 페이지가 사본을 덮어쓰지 않는가 ───────
    const setup = await req('GET', '/setup');
    ok('/setup 이 열린다', setup.status === 200);
    ok('/setup 이 서버 사본을 되받아 보관한다', /credentials\/backup/.test(setup.body));
    ok('/setup 에 프로덕션 전환 안내가 있다', /프로덕션으로 전환/.test(setup.body));

    const src = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cb = src.slice(src.indexOf('블로그스팟 인증 완료'), src.indexOf('블로그스팟 인증 완료') + 2500);
    ok('인증 성공 페이지가 기존 사본에 합친다(덮어쓰지 않음)', /JSON.parse\(localStorage.getItem\('riri_bp_creds'\)/.test(cb));

  } finally {
    srv.kill();
  }

  // ── 7) 토큰 만료(invalid_grant) 시나리오 ──────────────────
  // 구글이 만료를 돌려주는 상황을 그대로 재현해, 죽은 토큰이
  // 브라우저 사본에서 계속 되살아나지 않는지 확인한다.
  console.log('\n  — 토큰 만료 상황 재현 —');
  // 만료 시나리오는 앞 단계에서 저장된 값에 영향받지 않도록 저장소를 새로 판다
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-reconnect-exp-'));
  const env2 = { ...env, TOKENS_FILE: path.join(tmp2, 'tokens.json'), PERSIST_DIR: path.join(tmp2, 'vol') };
  const srv2 = spawn('node', ['--require', path.join(__dirname, 'helpers', 'stub-blogger-expired.js'),
                              path.join(__dirname, '..', 'server.js')], { env: env2, stdio: 'ignore' });
  try {
    await waitForServer();
    const copy = {
      BLOGGER_CLIENT_ID: '111-abc.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-testsecret',
      BLOGGER_REFRESH_TOKEN: '1//expired-token',
      BLOGGER_TOKEN_ISSUED_AT: new Date(Date.now() - 8 * 86400000).toISOString(),
      ANTHROPIC_API_KEY: 'sk-ant-keep-me',
    };
    await req('POST', '/api/credentials/restore', copy);

    const hh = await req('GET', '/api/health/blogger?refresh=1');
    ok('만료를 연결 끊김으로 판정한다', hh.json.ok === false);
    ok('재인증 필요를 알린다 (needsReauth)', hh.json.needsReauth === true);
    ok('만료 안내에 발급 경과일이 들어간다', /발급 후 8일 경과/.test(hh.json.detail));
    ok('테스트 모드 전환 안내를 함께 준다', /프로덕션/.test(hh.json.detail));

    const again = await req('POST', '/api/credentials/restore', copy);
    ok('죽은 토큰은 다시 주입되지 않는다', again.json.dead.includes('BLOGGER_REFRESH_TOKEN'));
    ok('죽은 토큰 복구 목록에 포함되지 않는다', !again.json.restored.includes('BLOGGER_REFRESH_TOKEN'));
    ok('클라이언트에 재인증 신호를 준다', again.json.needsReauth === true);
    ok('다른 키는 그대로 복구된다 (연쇄 피해 없음)',
      again.json.dead.length === 1 && !again.json.dead.includes('ANTHROPIC_API_KEY'));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv2.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
