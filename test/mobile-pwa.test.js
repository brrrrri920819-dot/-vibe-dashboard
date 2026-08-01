/**
 * test/mobile-pwa.test.js
 * 아이폰에서 앱처럼 쓰는 조건 + "한 번 배포하면 끝" 구조 검증.
 *
 * 확인하는 것:
 *  1) 홈화면 앱 조건 (manifest·아이콘·서비스워커·안전영역·확대방지)
 *  2) 서비스워커가 API 응답을 캐시하지 않는가 (오래된 상태를 보여주면 안 됨)
 *  3) CREDENTIALS_BLOB 하나로 재배포 후에도 연결이 살아있는가
 */

'use strict';

const assert = require('assert');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 4128;
const BASE = `http://127.0.0.1:${PORT}`;
let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

function req(method, p, body, port) {
  const base = port ? `http://127.0.0.1:${port}` : BASE;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(`${base}${p}`, {
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let d = '';
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let json = null; try { json = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: d, json, headers: res.headers });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function waitForServer(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = (n) => req('GET', '/api/health', null, port).then(resolve).catch(() => {
      if (n <= 0) return reject(new Error('서버가 뜨지 않음'));
      setTimeout(() => tick(n - 1), 250);
    });
    tick(tries);
  });
}

(async () => {
  console.log('\n📱 아이폰·무유지보수 구조 테스트\n');

  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'blog.html'), 'utf8');

  // ── 1) 홈화면 앱 조건 ────────────────────────────────────
  ok('안전영역이 실제로 적용되는 viewport 설정', /viewport-fit=cover/.test(html));
  ok('확대를 막지 않는다 (접근성)', !/maximum-scale\s*=\s*1/.test(html));
  ok('manifest 를 연결한다', /rel="manifest"/.test(html));
  ok('아이폰 홈화면 아이콘이 있다', /rel="apple-touch-icon"/.test(html));
  ok('앱 이름을 지정한다', /apple-mobile-web-app-title/.test(html));
  ok('서비스워커를 등록한다', /serviceWorker.*register\('\/sw\.js'\)/s.test(html));

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  ok('manifest 가 앱 모드로 뜬다', manifest.display === 'standalone');
  ok('manifest 아이콘 3종이 있다', manifest.icons.length >= 3);
  ok('maskable 아이콘이 있다 (안드로이드 대비)', manifest.icons.some(i => i.purpose === 'maskable'));

  for (const size of [180, 192, 512]) {
    const p = path.join(root, 'icons', `icon-${size}.png`);
    const buf = fs.readFileSync(p);
    ok(`아이콘 ${size}px 이 진짜 PNG 다`, buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  }

  ok('입력창 확대 방지 (16px 이상)', /input,select,textarea[^}]*font-size:16px/.test(html));
  ok('노치 여백을 직접 처리한다', /env\(safe-area-inset-top\)/.test(html));

  // ── 2) 서비스워커가 API 를 캐시하지 않는가 ────────────────
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  ok('API 응답은 캐시하지 않는다', /pathname\.startsWith\('\/api\/'\)/.test(sw));
  ok('OAuth 경로도 캐시하지 않는다', /pathname\.startsWith\('\/oauth\/'\)/.test(sw));
  ok('화면은 네트워크 우선 (배포하면 바로 최신)', sw.indexOf('fetch(e.request)') < sw.indexOf('caches.match(e.request)'));
  ok('GET 이 아닌 요청은 건드리지 않는다', /method !== 'GET'/.test(sw));

  // ── 3) 정적 파일이 실제로 서빙되는가 ─────────────────────
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pwa-'));
  const env = { ...process.env, PORT: String(PORT), TOKENS_FILE: path.join(tmp, 'tokens.json'), PERSIST_DIR: path.join(tmp, 'vol') };
  delete env.CREDENTIALS_BLOB;
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN']) delete env[k];

  let srv = spawn('node', [path.join(root, 'server.js')], { env, stdio: 'ignore' });
  let blobValue = null;
  try {
    await waitForServer(PORT);
    const mf = await req('GET', '/manifest.webmanifest');
    ok('manifest 를 서버가 내려준다', mf.status === 200);
    const icon = await req('GET', '/icons/icon-180.png');
    ok('아이콘을 서버가 내려준다', icon.status === 200);
    const swRes = await req('GET', '/sw.js');
    ok('서비스워커를 서버가 내려준다', swRes.status === 200);

    // ── 4) 복구값 만들기 ──────────────────────────────────
    const none = await req('GET', '/api/credentials/blob');
    ok('저장된 게 없으면 그렇다고 알려준다', none.json.ok === false);

    await req('POST', '/api/credentials/restore', {
      BLOGGER_CLIENT_ID: '111-abc.apps.googleusercontent.com',
      BLOGGER_CLIENT_SECRET: 'GOCSPX-testsecret',
      BLOGGER_REFRESH_TOKEN: '1//blob-test-token',
      NAVER_ID: 'naver_user',
    });
    const blob = await req('GET', '/api/credentials/blob');
    ok('복구값을 만들어준다', blob.json.ok === true && typeof blob.json.value === 'string');
    ok('환경변수 이름을 알려준다', blob.json.name === 'CREDENTIALS_BLOB');
    ok('포함된 항목을 알려준다', blob.json.keys.includes('BLOGGER_REFRESH_TOKEN'));
    blobValue = blob.json.value;
  } finally {
    srv.kill();
  }

  // ── 5) 재배포 재현: 저장소를 통째로 버리고 블롭만 준다 ────
  console.log('\n  — 재배포 재현 (저장 파일 전부 삭제, 환경변수만 유지) —');
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pwa-redeploy-'));
  const env2 = {
    ...process.env,
    PORT: String(PORT + 1),
    TOKENS_FILE: path.join(tmp2, 'tokens.json'),
    PERSIST_DIR: path.join(tmp2, 'vol'),
    CREDENTIALS_BLOB: blobValue,
  };
  for (const k of ['BLOGGER_CLIENT_ID', 'BLOGGER_CLIENT_SECRET', 'BLOGGER_REFRESH_TOKEN', 'NAVER_ID']) delete env2[k];

  srv = spawn('node', [path.join(root, 'server.js')], { env: env2, stdio: 'ignore' });
  try {
    await waitForServer(PORT + 1);
    const st = await req('GET', '/api/keys/status', null, PORT + 1);
    ok('재배포 후에도 리프레시 토큰이 살아있다', st.json.BLOGGER_REFRESH_TOKEN.set === true);
    ok('재배포 후에도 클라이언트 시크릿이 살아있다', st.json.BLOGGER_CLIENT_SECRET.set === true);
    ok('재배포 후에도 네이버 정보가 살아있다', st.json.NAVER_ID.set === true);
    ok('출처가 blob 으로 표시된다', st.json.BLOGGER_REFRESH_TOKEN.source === 'blob');

    const diag = await req('GET', '/api/blogger-diagnose', null, PORT + 1);
    ok('진단 1~3단계가 모두 통과한다', diag.json.steps.slice(0, 3).every(s => s.ok));

    // 새로 인증한 값은 블롭을 덮어쓸 수 있어야 한다 (안 그러면 재인증이 무의미해진다)
    const newer = await req('POST', '/api/credentials/restore', {
      BLOGGER_REFRESH_TOKEN: '1//brand-new-token',
    }, PORT + 1);
    ok('더 새로운 값이 블롭 값을 덮어쓴다', newer.json.restored.includes('BLOGGER_REFRESH_TOKEN'));

    console.log(`\n✅ ${pass}개 통과\n`);
  } finally {
    srv.kill();
  }
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
