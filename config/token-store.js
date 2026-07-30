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

const fs      = require('fs');
const fsSync  = require('fs');
const path    = require('path');

/* 저장 위치 자동 선택.
 * Railway 볼륨이 붙어 있으면 그곳을 쓰고, 없으면 컨테이너에서 재배포 후에도
 * 살아남을 가능성이 있는 경로를 순서대로 시도한다.
 * 어디에도 못 쓰면 메모리로만 유지하고, 대시보드 사본이 복구를 맡는다. */
/* 쓸 수 있다고 해서 재배포 후에도 남는 것은 아니다.
 * 볼륨이 없는데 컨테이너 안에 폴더를 만들어 쓰면 쓰기는 되지만
 * 재배포 때 같이 사라진다. 이를 '영구'라고 표시하면 거짓 안내가 된다.
 * Railway는 볼륨을 붙이면 RAILWAY_VOLUME_MOUNT_PATH를 넣어주므로,
 * 환경변수로 선언된 경로만 영구 저장으로 인정한다. */
let volumeIsMount = false;

function pickVolume() {
  const declared = [process.env.RAILWAY_VOLUME_MOUNT_PATH, process.env.PERSIST_DIR].filter(Boolean);
  const candidates = [...declared, '/data'];

  for (const dir of candidates) {
    // 특수 파일시스템은 건드리지 않는다 — 여기에 mkdir을 시도하면
    // 호출이 멈춰 서버가 아예 기동하지 못하는 일이 생긴다
    if (/^\/(proc|sys|dev)(\/|$)/.test(dir)) continue;

    try {
      // 이미 있으면 쓰기 가능한지만 확인 (생성 시도 자체를 피한다)
      if (fsSync.existsSync(dir)) {
        if (!fsSync.statSync(dir).isDirectory()) continue;
        fsSync.accessSync(dir, fsSync.constants.W_OK);
        volumeIsMount = declared.includes(dir);
        return dir;
      }
      // 없으면 부모가 쓰기 가능할 때만 생성
      const parent = path.dirname(dir);
      if (!fsSync.existsSync(parent)) continue;
      fsSync.accessSync(parent, fsSync.constants.W_OK);
      fsSync.mkdirSync(dir, { recursive: true });
      fsSync.accessSync(dir, fsSync.constants.W_OK);
      volumeIsMount = declared.includes(dir);
      return dir;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

const VOLUME      = pickVolume();
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
  if (VOLUME && volumeIsMount) {
    console.log(`[TokenStore] 영구 저장소 사용: ${VOLUME} (재배포해도 유지됩니다)`);
  } else if (VOLUME) {
    console.log(`[TokenStore] 임시 저장 사용: ${VOLUME} — 볼륨이 아니라 재배포 시 사라집니다`);
  } else {
    console.log('[TokenStore] 영구 저장소 없음 — 대시보드 사본으로 복구합니다');
  }
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
    persistent: !!VOLUME && volumeIsMount,
    volumePath: VOLUME || null,
    volumeWritable: writable.volume,
    localWritable: writable.local,
    keyCount: mem.size,
  };
}

module.exports = { get, set, keys, sourceOf, storageInfo, read: () => Object.fromEntries(mem) };
