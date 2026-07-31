/**
 * test/helpers/stub-publishers.js
 * --require 로 서버 앞에 끼워, 실제 블로그에 접속하지 않고
 * "네이버는 브라우저 실행부터 터지고, 나머지는 정상 발행되는" 상황을 재현한다.
 */

'use strict';

const Module = require('module');
const orig = Module.prototype.require;

Module.prototype.require = function (id) {
  if (/publisher[\\/]naver$/.test(id)) {
    return {
      publishToNaver: async () => {
        // 예외를 그대로 던진다 — 이게 예전에 다른 블로그 발행까지 중단시켰다
        throw new Error("browserType.launch: Executable doesn't exist");
      },
    };
  }
  if (/publisher[\\/]tistory-playwright$/.test(id)) {
    return {
      publishToTistoryPlaywright: async () => ({ success: true, url: 'https://t.example/1', platform: 'tistory' }),
    };
  }
  if (/publisher[\\/]blogger$/.test(id)) {
    const real = orig.apply(this, arguments);
    return {
      ...real,
      publishToBlogger: async () => ({ success: true, url: 'https://b.example/1', blogId: 'bid', platform: 'blogger' }),
    };
  }
  return orig.apply(this, arguments);
};
