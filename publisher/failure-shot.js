/**
 * publisher/failure-shot.js
 * 발행이 실패한 순간의 화면을 남긴다.
 *
 * 오류 문구만으로는 "왜" 막혔는지 알 수 없는 경우가 많다.
 * 캡차가 떴는지, 비밀번호가 틀렸다는 안내인지, 화면 구조가 바뀐 건지는
 * 그 화면을 봐야 안다. 매번 추측하고 다시 배포하는 왕복을 없애기 위한 것.
 *
 * 파일은 uploads/ 에 저장되고 대시보드에서 바로 열어볼 수 있다.
 * 오래된 것은 스스로 지운다 — 디스크가 가득 차면 서버가 못 뜬다.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'uploads');
const KEEP = 20;          // 최근 몇 장까지 남길지
const PREFIX = 'fail-';

/**
 * 지금 화면을 저장하고 열어볼 주소를 돌려준다.
 * 실패해도 절대 예외를 던지지 않는다 — 진단용이 발행 결과를 덮으면 안 된다.
 * @returns {Promise<string|null>} 예: '/uploads/fail-naver-1234.png'
 */
async function saveFailureShot(page, platform) {
  if (!page) return null;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const name = `${PREFIX}${platform}-${Date.now()}.png`;
    await page.screenshot({ path: path.join(DIR, name), fullPage: false, timeout: 8000 });
    cleanup();
    console.log(`[${platform}] 실패 화면 저장: /uploads/${name}`);
    return `/uploads/${name}`;
  } catch (e) {
    console.warn(`[${platform}] 실패 화면을 저장하지 못했습니다: ${e.message}`);
    return null;
  }
}

/** 오래된 실패 화면 정리 */
function cleanup() {
  try {
    const files = fs.readdirSync(DIR)
      .filter(f => f.startsWith(PREFIX) && f.endsWith('.png'))
      .map(f => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP)) {
      fs.unlinkSync(path.join(DIR, f));
    }
  } catch (_) { /* 정리 실패는 무시 — 본 작업에 영향 없음 */ }
}

/** 최근 실패 화면 목록 (진단 화면용) */
function listFailureShots(limit = 10) {
  try {
    return fs.readdirSync(DIR)
      .filter(f => f.startsWith(PREFIX) && f.endsWith('.png'))
      .map(f => ({ url: `/uploads/${f}`, at: fs.statSync(path.join(DIR, f)).mtime.toISOString() }))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, limit);
  } catch (_) { return []; }
}

module.exports = { saveFailureShot, listFailureShots };
