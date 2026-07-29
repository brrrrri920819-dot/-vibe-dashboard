/**
 * config/token-store.js
 * 자격증명 저장소 — 재배포·재시작에도 연결이 끊기지 않게 여러 겹으로 저장한다.
 *
 * 저장 위치를 우선순위대로 자동 감지한다:
 *   1) Railway 볼륨 (RAILWAY_VOLUME_MOUNT_PATH) — 재배포해도 남는 영구 디스크
 *   2) 앱 폴더의 config/tokens.json — 재시작엔 살아남지만 재배포 시 사라짐
 *   3) 메모리 — 프로세스가 사는 동안만
 * 어디에 쓰든 메모리에는 항상 두기 때문에, 디스크 쓰기가 막혀도 동작한다.
 * (컨테이너 자체가 새로 만들어지는 경우는 대시보드의 자동 복구가 메운다)
 */

const fs   = require('fs');
const path = require('path');

// Railway에서 볼륨을 붙이면 이 경로가 자동으로 주입된다
const VOLUME = process.env.RAILWAY_VOLUME_MOUNT_PATH
  || process.env.PERSIST_DIR
  || null;

const LOCAL_FILE  = path.join(__dirname, 'tokens.json');
const VOLUME_FILE = VOLUME ? path.join(VOLUME, 'tokens.json') : null;

const mem = new Map();
let writable = { volume: !!VOLUME, local: true };

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// 시작 시: 영구 저장소 → 로컬 파일 순으로 메모리에 올림 (영구 저장소가 우선)
(function bootstrap() {
  const sources = [];
  if (VOLUME_FILE) sources.push(readJson(VOLUME_FILE));
  sources.push(readJson(LOCAL_FILE));
  // 뒤쪽(로컬)을 먼저 깔고 앞쪽(볼륨)으로 덮어써서 볼륨 값이 이기게 한다
  for (const src of sources.reverse()) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' && v) mem.set(k, v);
    }
  }
  console.log(VOLUME
    ? `[TokenStore] 영구 저장소 사용: ${VOLUME} (재배포해도 유지됩니다)`
    : '[TokenStore] 영구 저장소 없음 — Railway에 볼륨을 붙이면 재배포에도 연결이 유지됩니다');
})();

function get(key) {
  if (mem.has(key)) return mem.get(key);
  return process.env[key] || null;
}

function set(key, value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const val = value.trim();

  mem.set(key, val);
  process.env[key] = val;

  const snapshot = Object.fromEntries(mem);
  if (VOLUME_FILE && writable.volume) {
    try { writeJson(VOLUME_FILE, snapshot); }
    catch (e) { writable.volume = false; console.warn(`[TokenStore] 볼륨 저장 실패: ${e.message}`); }
  }
  if (writable.local) {
    try { writeJson(LOCAL_FILE, snapshot); }
    catch (e) { writable.local = false; console.warn(`[TokenStore] 로컬 저장 실패 (메모리 유지): ${e.message}`); }
  }
  return true;
}

function keys() { return [...mem.keys()]; }

/** 값의 출처 — 'saved'(저장소) | 'env'(Railway 환경변수) | null
 *  둘이 다를 때 어느 쪽이 쓰이는지 헷갈려 생기는 문제를 잡기 위한 것 */
function sourceOf(key) {
  if (mem.has(key)) return 'saved';
  if (process.env[key]) return 'env';
  return null;
}

/** 저장 상태 (진단용 — 값은 노출하지 않음) */
function storageInfo() {
  return {
    persistent: !!VOLUME,
    volumePath: VOLUME || null,
    volumeWritable: writable.volume,
    localWritable: writable.local,
    keyCount: mem.size,
  };
}

module.exports = { get, set, keys, sourceOf, storageInfo, read: () => Object.fromEntries(mem) };
