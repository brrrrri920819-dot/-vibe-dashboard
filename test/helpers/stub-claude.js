/**
 * test/helpers/stub-claude.js
 * 실제 클로드에 붙지 않고 글 생성 진단을 검증하기 위한 바꿔치기.
 *
 * STUB_CLAUDE 값으로 상황을 고른다.
 *   ok     — 정상
 *   auth   — 키가 거부됨 (401)
 *   credit — 잔액 없음
 *   fail   — 키는 통하는데 글 만들기가 실패
 */

'use strict';

const Module = require('module');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');

const MODE = process.env.STUB_CLAUDE || 'ok';

/* 1) 키 확인 호출 가로채기 — server.js 의 probeClaudeKey 가 https.request 를 직접 쓴다 */
const origRequest = https.request;
https.request = function (url, opts, cb) {
  const target = typeof url === 'string' ? url : (url && url.href) || '';
  if (!/api\.anthropic\.com/.test(target)) return origRequest.apply(this, arguments);

  if (typeof opts === 'function') { cb = opts; opts = {}; }

  const payload =
      MODE === 'auth'   ? { status: 401, body: { error: { type: 'authentication_error', message: 'invalid x-api-key' } } }
    : MODE === 'credit' ? { status: 400, body: { error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } } }
    :                     { status: 200, body: { content: [{ type: 'text', text: '안녕하세요' }], stop_reason: 'end_turn' } };

  const req = new EventEmitter();
  req.write = () => true;
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = () => {
    setImmediate(() => {
      const res = Readable.from([JSON.stringify(payload.body)]);
      res.statusCode = payload.status;
      res.headers = {};
      if (cb) cb(res);
    });
  };
  return req;
};

/* 2) 글 만들기 바꿔치기 — 실제 생성은 클로드 호출이 여러 번 필요하다 */
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (/content[\\/]generator$/.test(id)) {
    const real = origRequire.apply(this, arguments);
    return {
      ...real,
      generatePost: async (keyword) => {
        if (MODE === 'fail') throw new Error('글 만들기 실패 — 응답이 너무 길어 잘렸습니다');
        const body = `<h2>${keyword} 시작하기</h2><p>${'내용 '.repeat(400)}</p><img src="https://images.unsplash.com/x">`;
        return { title: `${keyword}, 이렇게 해봤어요`, content: body, tags: ['루틴', '습관'] };
      },
    };
  }
  return origRequire.apply(this, arguments);
};
