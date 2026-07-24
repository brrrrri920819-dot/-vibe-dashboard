/**
 * config/token-store.js
 * OAuth 토큰을 파일로 영구 저장/조회
 * Railway 재시작 후에도 토큰 유지
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'tokens.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function write(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function get(key) {
  // 1순위: 환경변수 (Railway Variables)
  if (process.env[key]) return process.env[key];
  // 2순위: 파일 저장값
  return read()[key] || null;
}

function set(key, value) {
  const data = read();
  data[key] = value;
  write(data);
  // 현재 프로세스 환경변수에도 반영 (재시작 전까지 즉시 사용)
  process.env[key] = value;
}

module.exports = { get, set, read };
