/**
 * scheduler/queue.js
 * 예약 발행 큐 관리 (파일 기반 간단한 JSON 큐)
 * - 서버 재시작해도 유지됨
 */

const fs   = require('fs');
const path = require('path');
const cron = require('node-cron');

const QUEUE_FILE = path.join(__dirname, '..', 'data', 'queue.json');
const LOG_FILE   = path.join(__dirname, '..', 'data', 'publish_log.json');

// data 디렉토리 자동 생성
const dataDir = path.dirname(QUEUE_FILE);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeQueue(queue) {
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

function readLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function appendLog(entry) {
  const log = readLog();
  log.unshift({ ...entry, loggedAt: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log.slice(0, 500), null, 2)); // 최대 500개 보관
}

/**
 * 큐에 작업 추가
 * @param {object} job
 * @param {string}   job.id         - 고유 ID
 * @param {string}   job.title      - 포스트 제목
 * @param {string}   job.content    - HTML 본문
 * @param {string[]} job.tags
 * @param {string[]} job.imagePaths
 * @param {string[]} job.platforms  - ['naver','tistory','blogger'] 중 선택
 * @param {string}   job.scheduledAt - ISO 날짜 문자열 (없으면 즉시)
 * @param {string}   job.status     - 'pending'|'running'|'done'|'failed'
 */
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
  const queue = readQueue();
  const updated = queue.filter(j => j.id !== id);
  writeQueue(updated);
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

/**
 * 실행 엔진 — 1분마다 pending 작업 확인 후 실행
 */
function startScheduler(publishFn) {
  console.log('[Scheduler] 시작됨 (1분 간격 체크)');

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
        updateJobStatus(job.id, 'done', results);
        appendLog({ ...job, status: 'done', results });
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
