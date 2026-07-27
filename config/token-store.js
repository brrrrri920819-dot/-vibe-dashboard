/**
 * config/token-store.js
 * 자격증명 저장소
 *
 * Railway 같은 환경은 파일 쓰기가 막히거나 재배포 시 컨테이너가 새로 만들어져
 * 파일이 사라진다. 파일 쓰기에만 의존하면 저장이 조용히 실패해서
 * "분명 인증했는데 연결 안 됨" 상태가 된다.
 * 그래서 메모리를 1차 저장소로 쓰고, 파일은 재시작 대비 보조 수단으로만 쓴다.
 * (컨테이너를 넘어서는 영속성은 대시보드의 자동 복구가 담당한다)
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'tokens.json');

// 1차 저장소 — 프로세스가 살아있는 동안 항상 유효
const mem = new Map();
let fileWritable = true;

function readFile() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

// 시작 시 파일 내용을 메모리로 올림
for (const [k, v] of Object.entries(readFile())) {
  if (typeof v === 'string' && v) mem.set(k, v);
}

function get(key) {
  // 1순위: 메모리 (이번 프로세스에서 저장·복구된 값)
  if (mem.has(key)) return mem.get(key);
  // 2순위: 환경변수 (Railway Variables)
  return process.env[key] || null;
}

function set(key, value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const val = value.trim();

  mem.set(key, val);
  process.env[key] = val;   // 같은 프로세스의 다른 코드가 env를 봐도 되게

  // 파일은 best-effort — 실패해도 메모리 저장은 이미 끝났으므로 동작에 지장 없음
  if (fileWritable) {
    try {
      const data = readFile();
      data[key] = val;
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
    } catch (e) {
      fileWritable = false;
      console.warn(`[TokenStore] 파일 저장 불가 (메모리로만 유지): ${e.message}`);
    }
  }
  return true;
}

/** 저장된 키 목록 (값은 노출하지 않음) */
function keys() {
  return [...new Set([...mem.keys()])];
}

module.exports = { get, set, keys, read: readFile };
