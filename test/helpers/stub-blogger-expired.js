/**
 * test/helpers/stub-blogger-expired.js
 * --require 로 서버 앞에 끼워, 구글이 "토큰 만료(invalid_grant)"를 돌려주는 상황을 재현한다.
 * 실제 구글에 붙지 않고도 만료 처리 경로를 그대로 테스트하기 위한 것.
 */

'use strict';

const Module = require('module');
const orig = Module.prototype.require;

Module.prototype.require = function (id) {
  const real = orig.apply(this, arguments);
  if (/publisher[\\/]blogger$/.test(id) || id === './publisher/blogger') {
    return {
      ...real,
      getBloggerBlogId() {
        const err = new Error('invalid_grant');
        err.response = { status: 400, data: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } };
        return Promise.reject(err);
      },
    };
  }
  return real;
};
