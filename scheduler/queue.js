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
