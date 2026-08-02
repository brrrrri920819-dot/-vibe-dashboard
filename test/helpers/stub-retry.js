/**
 * test/helpers/stub-retry.js
 * 재시도 동작을 확인하기 위해 발행기를 바꿔치기한다.
 *
 *  - naver   : 첫 시도는 일시적 실패, 두 번째는 성공
 *  - tistory : 비밀번호 오류 (다시 해도 소용없음 — 재시도하면 안 된다)
 *  - blogger : 계속 일시적 실패 (두 번까지만 시도하는지 확인)
 *
 * 몇 번 호출됐는지 파일에 적어 테스트가 읽는다.
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const orig = Module.prototype.require;

const FILE = process.env.TEST_COUNTS_FILE;
const counts = { naver: 0, tistory: 0, blogger: 0 };
const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(counts)); } catch (_) {} };
save();

Module.prototype.require = function (id) {
  if (/publisher[\\/]naver$/.test(id)) {
    return {
      publishToNaver: async () => {
        counts.naver++; save();
        if (counts.naver === 1) {
          return { success: false, error: '브라우저 실행 실패: Target closed', platform: 'naver' };
        }
        return { success: true, url: 'https://n.example/1', platform: 'naver' };
      },
    };
  }
  if (/publisher[\\/]tistory-playwright$/.test(id)) {
    return {
      publishToTistoryPlaywright: async () => {
        counts.tistory++; save();
        return { success: false, error: '로그인 실패 — 비밀번호가 틀렸습니다', platform: 'tistory' };
      },
    };
  }
  if (/publisher[\\/]blogger$/.test(id)) {
    const real = orig.apply(this, arguments);
    return {
      ...real,
      publishToBlogger: async () => {
        counts.blogger++; save();
        return { success: false, error: 'ETIMEDOUT — 연결 시간 초과', platform: 'blogger' };
      },
    };
  }
  return orig.apply(this, arguments);
};
