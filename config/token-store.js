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
  // 테스트가 실제 볼륨을 타지 않게 하는 스위치 (운영에서는 쓰지 않는다)
  if (process.env.DISABLE_VOLUME === '1') return null;
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
// TOKENS_FILE 은 테스트가 실제 저장 파일을 건드리지 않도록 경로를 바꿔 끼우기 위한 것
const LOCAL_FILE  = process.env.TOKENS_FILE || path.join(__dirname, 'tokens.json');
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

/* CREDENTIALS_BLOB — 자격증명 전부를 담은 환경변수 하나.
 * 볼륨도 없고 파일도 사라지는 환경(Railway 재배포)에서 연결이 끊기지 않게,
 * 값들을 한 덩어리로 묶어 환경변수에 넣어둘 수 있게 한다.
 * 환경변수는 재배포해도 지워지지 않으므로 한 번 붙여넣으면 끝난다.
 * 출처를 'blob'으로 따로 표시해, 나중에 새로 인증한 값이 이걸 덮어쓸 수 있게 한다. */
const blobKeys = new Set();     // 아직 블롭 값 그대로인 키 (덮어쓰면 빠진다)
const blobValues = new Map();   // 블롭에 들어 있던 원본 값 — 최신인지 비교하는 데 쓴다
let blobPresent = false;        // 환경변수 자체가 있는가 (덮어써도 이건 그대로다)

function readBlob() {
  const raw = process.env.CREDENTIALS_BLOB;
  if (!raw || !raw.trim()) return {};
  try {
    const json = JSON.parse(Buffer.from(raw.trim(), 'base64').toString('utf8'));
    if (!json || typeof json !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(json)) {
      if (typeof v === 'string' && v) { out[k] = v; blobKeys.add(k); blobValues.set(k, v); }
    }
    blobPresent = blobValues.size > 0;
    return out;
  } catch (e) {
    console.warn('[TokenStore] CREDENTIALS_BLOB 해석 실패 — 값을 다시 복사해 넣어주세요:', e.message);
    return {};
  }
}

/** 지금 저장된 값들을 환경변수 한 줄로 묶어 준다 (Railway에 붙여넣기용) */
function makeBlob(keys) {
  const obj = {};
  for (const k of keys) {
    const v = mem.get(k);
    if (typeof v === 'string' && v) obj[k] = v;
  }
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

// 시작 시: 블롭 → 영구 저장소 → 로컬 파일 순으로 메모리에 올림 (나중 것이 우선)
(function bootstrap() {
  const sources = [];
  if (VOLUME_FILE) sources.push(readJson(VOLUME_FILE));
  sources.push(readJson(LOCAL_FILE));
  sources.push(readBlob());   // 가장 낮은 우선순위 — 파일에 더 새 값이 있으면 그게 이긴다
  // 뒤쪽(블롭)을 먼저 깔고 앞쪽(볼륨)으로 덮어써서 최신 값이 이기게 한다
  for (const src of sources.reverse()) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'string' && v) {
        // 파일에 더 새로운 값이 있으면 블롭 표시를 뗀다 (덮어쓰기 보호 대상에서 제외)
        if (blobKeys.has(k) && mem.get(k) !== undefined && mem.get(k) !== v) blobKeys.delete(k);
        mem.set(k, v);
      }
    }
  }
  if (blobPresent) {
    console.log(`[TokenStore] CREDENTIALS_BLOB 에서 ${blobValues.size}개 불러옴 — 재배포해도 유지됩니다`);
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
  blobKeys.delete(key);   // 새로 저장된 값이므로 더 이상 '블롭에서 온 값'이 아니다

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

/* 값을 완전히 지운다.
   메모리·환경변수·저장 파일 어디에도 남기지 않는다.
   한 군데라도 남으면 다음 부팅 때 옛 값이 되살아난다. */
function remove(key) {
  const had = mem.has(key) || !!process.env[key];
  mem.delete(key);
  delete process.env[key];
  blobKeys.delete(key);

  const snapshot = Object.fromEntries(mem);
  if (VOLUME_FILE && writable.volume) {
    try { writeJson(VOLUME_FILE, snapshot); } catch (_) { /* 메모리에서는 이미 지워졌다 */ }
  }
  if (writable.local) {
    try { writeJson(LOCAL_FILE, snapshot); } catch (_) {}
  }
  return had;
}

function keys() { return [...mem.keys()]; }

/** 값의 출처 — 'saved'(저장소) | 'env'(Railway 환경변수) | null
 *  둘이 다를 때 어느 쪽이 쓰이는지 헷갈려 생기는 문제를 잡기 위한 것 */
function sourceOf(key) {
  if (blobKeys.has(key)) return 'blob';   // 환경변수 블롭에서 온 값 — 새 값으로 덮어쓸 수 있다
  if (mem.has(key)) return 'saved';
  if (process.env[key]) return 'env';
  return null;
}

/* 복구값이 지금 상태보다 오래됐는가.
   블롭을 넣은 뒤에 자격증명을 바꿨다면, 재배포 때 옛 값이 되살아난다.
   그 경우엔 복구값을 다시 만들어 넣어야 하므로 따로 알려준다. */
function isBlobStale() {
  if (!blobPresent) return false;
  for (const [k, v] of blobValues) {
    const now = mem.get(k);
    if (now && now !== v) return true;          // 넣은 뒤에 바뀐 값이 있다
  }
  for (const k of mem.keys()) {
    if (!blobValues.has(k) && RESTORABLE_HINT.test(k)) return true;   // 블롭에 없는 새 값이 생겼다
  }
  return false;
}

/* 복구 대상 키인지 대략 판별 (token-store 는 서버의 목록을 모른다) */
const RESTORABLE_HINT = /^(BLOGGER_|NAVER_|TISTORY_|ANTHROPIC_|UNSPLASH_|LINKPRICE_|COUPANG_|TELEGRAM_)/;

/** 저장 상태 (진단용 — 값은 노출하지 않음) */
function storageInfo() {
  return {
    /* 영구 저장 여부는 '환경변수가 있는가'로 판단한다.
       예전엔 '아직 블롭 값 그대로인 키가 몇 개인가'로 봤는데,
       대시보드를 열어 값이 한 번 갱신되면 그 수가 0이 되면서
       복구값을 넣어뒀는데도 "재배포하면 끊깁니다"가 계속 떴다. */
    persistent: (!!VOLUME && volumeIsMount) || blobPresent,
    mode: (!!VOLUME && volumeIsMount) ? 'volume' : (blobPresent ? 'blob' : 'none'),
    blobPresent,
    blobStale: isBlobStale(),
    blobKeyCount: blobValues.size,
    volumePath: VOLUME || null,
    volumeWritable: writable.volume,
    localWritable: writable.local,
    keyCount: mem.size,
  };
}

module.exports = { get, set, remove, keys, sourceOf, storageInfo, makeBlob, read: () => Object.fromEntries(mem) };
