/**
 * scheduler/queue.js
 * 예약 발행 큐 관리
 * - 로컬: 파일 기반 (data/queue.json)
 * - Railway/클라우드: 메모리 기반 (재시작 시 초기화, 텔레그램으로 보완)
 */

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const DATA_DIR   = path.join(__dirname, '..', 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json');
const LOG_FILE   = path.join(DATA_DIR, 'publish_log.json');

// 클라우드 환경에서는 메모리 폴백 사용
let memQueue = [];
let memLog   = [];
const isCloud = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);

if (!isCloud) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readQueue() {
  if (isCloud) return memQueue;
  try { return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')); } catch { return []; }
}

function writeQueue(queue) {
  if (isCloud) { memQueue = queue; return; }
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function readLog() {
  if (isCloud) return memLog;
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}

function appendLog(entry) {
  const log = readLog();
  log.unshift({ ...entry, loggedAt: new Date().toISOString() });
  const trimmed = log.slice(0, 500);
  if (isCloud) { memLog = trimmed; return; }
  fs.writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2));
}

function enqueue(job) {
  const queue = readQueue();
  queue.push({
    ...job,
    id: job.id || `job_${Date.now()}`,
    status: 'pending',
    createdAt: new Date().toISOString(),
  });
  writeQueue(queue);
}

function dequeue(id) {
  writeQueue(readQueue().filter(j => j.id !== id));
}

function updateJobStatus(id, status, result = {}) {
  const queue = readQueue();
  const job = queue.find(j => j.id === id);
  if (job) {
    job.status = status;
    job.result = result;
    job.updatedAt = new Date().toISOString();
    writeQueue(queue);
  }
}

function startScheduler(publishFn) {
  console.log(`[Scheduler] 시작됨 (1분 간격, 환경: ${isCloud ? '클라우드' : '로컬'})`);

  // 서버 재시작 시 'running' 상태로 중단된 작업을 'pending'으로 복구
  const queue = readQueue();
  const stuck = queue.filter(j => j.status === 'running');
  if (stuck.length > 0) {
    stuck.forEach(j => { j.status = 'pending'; delete j.updatedAt; });
    writeQueue(queue);
    console.log(`[Scheduler] ${stuck.length}개 중단된 작업 복구됨 (running → pending)`);
  }

  cron.schedule('* * * * *', async () => {
    const queue = readQueue();
    const now   = new Date();

    const due = queue.filter(j =>
      j.status === 'pending' &&
      (!j.scheduledAt || new Date(j.scheduledAt) <= now),
    );

    for (const job of due) {
      console.log(`[Scheduler] 실행 중: ${job.id} (${job.title})`);
      updateJobStatus(job.id, 'running');

      try {
        const results = await publishFn(job);

        /* 재배포 직후엔 토큰이 아직 복구되기 전일 수 있다.
           이때 실패로 처리하면 글이 그냥 사라지므로,
           '연결 없음'이 원인인 경우엔 버리지 않고 대기 상태로 되돌려
           연결이 돌아왔을 때 자동으로 다시 발행한다. */
        const errs = Object.values(results).filter(r => r && !r.success).map(r => r.error || '');
        const authProblem = errs.length > 0 && errs.every(e =>
          /인증|연결 필요|재인증|invalid_grant|설정 필요|미설정|토큰/i.test(e));
        const anyOk = Object.values(results).some(r => r && r.success);

        if (!anyOk && authProblem) {
          const tries = (job.authRetries || 0) + 1;
          const q2 = readQueue();
          const j2 = q2.find(j => j.id === job.id);
          if (j2 && tries <= 60) {          // 1분 간격 → 최대 1시간 대기
            j2.status = 'pending';
            j2.authRetries = tries;
            writeQueue(q2);
            if (tries === 1) console.warn(`[Scheduler] 연결 복구 대기 중, 발행 보류: ${job.id}`);
            continue;
          }
          updateJobStatus(job.id, 'failed', { error: '연결이 복구되지 않아 발행 취소' });
          appendLog({ ...job, status: 'failed', error: '연결이 복구되지 않아 발행 취소' });
          console.error(`[Scheduler] 연결 미복구로 포기: ${job.id}`);
          continue;
        }

        /* 예전엔 모든 플랫폼이 실패해도 'done'으로 기록해서
           실패가 성공으로 집계되고 원인도 남지 않았다. */
        if (!anyOk) {
          const msg = errs.filter(Boolean).join(' | ') || '모든 플랫폼 발행 실패';
          updateJobStatus(job.id, 'failed', { error: msg, results });
          appendLog({ ...job, status: 'failed', error: msg, results });
          console.error(`[Scheduler] 실패: ${job.id} — ${msg}`);
          continue;
        }

        updateJobStatus(job.id, 'done', results);
        appendLog({ ...job, status: 'done', results });
        dequeue(job.id);   // 끝난 작업은 큐에서 제거 (기록은 로그에 남음)
        console.log(`[Scheduler] 완료: ${job.id}`);
      } catch (err) {
        updateJobStatus(job.id, 'failed', { error: err.message });
        appendLog({ ...job, status: 'failed', error: err.message });
        console.error(`[Scheduler] 실패: ${job.id}`, err.message);
      }
    }
  });
}

module.exports = { enqueue, dequeue, updateJobStatus, readQueue, readLog, startScheduler };
