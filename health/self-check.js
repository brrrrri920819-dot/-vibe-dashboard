/**
 * health/self-check.js
 * 스스로 점검하고, 고칠 수 있는 건 고치고,
 * 사람이 손대야 하는 것만 딱 한 번 알린다.
 *
 * 만들게 된 이유:
 *   지금까지는 "잘 돌고 있나?"를 사람이 직접 확인해야 했다.
 *   확인하지 않으면 며칠 뒤에야 안 올라간 걸 알게 되고,
 *   확인하려면 매번 대시보드를 뒤져야 했다. 둘 다 스트레스다.
 *
 * 원칙:
 *   1) 고칠 수 있으면 조용히 고친다 (알리지 않는다)
 *   2) 사람이 손대야 하는 것만 알린다
 *   3) 같은 문제로 반복해서 알리지 않는다 — 알림이 잦으면 결국 안 보게 된다
 */

'use strict';

/** 알림을 이미 보낸 문제들 — 해결되면 지워져서 다음에 재발하면 다시 알린다 */
const notified = new Map();   // key -> { at: ISO, count }

/** 같은 문제를 다시 알리기까지의 최소 간격 (24시간) */
const RENOTIFY_MS = 24 * 60 * 60 * 1000;

/**
 * 지금 상태를 한 번에 판정한다.
 * @param {object} deps
 *  - tokens: 자격증명 저장소
 *  - readLog: 발행 기록 읽기
 *  - readQueue: 예약 대기열 읽기
 *  - bloggerHealth: 최근 구글 연결 점검 결과
 *  - serverStartedAt: 서버 기동 시각(ms)
 */
function assess({ tokens, readLog, readQueue, bloggerHealth, serverStartedAt }) {
  const problems = [];   // 사람이 손대야 하는 것
  const notes    = [];   // 참고 사항 (알리지 않음)

  // ── 글 생성 키 ────────────────────────────────────────────
  if (!tokens.get('ANTHROPIC_API_KEY')) {
    problems.push({
      key: 'no_anthropic',
      severity: 'high',
      title: '글 생성 키가 없습니다',
      detail: '이게 없으면 글이 아예 만들어지지 않습니다.',
      action: '설정 탭에서 ANTHROPIC_API_KEY 입력',
    });
  }

  // ── 구글 블로그 연결 ──────────────────────────────────────
  if (bloggerHealth && bloggerHealth.needsReauth) {
    problems.push({
      key: 'blogger_reauth',
      severity: 'high',
      title: '구글 블로그 재연결이 필요합니다',
      detail: bloggerHealth.detail || '토큰이 만료됐습니다.',
      action: '/setup 에서 구글 계정 연결 다시 누르기',
    });
  }

  // ── 발행할 곳이 하나라도 있는가 ───────────────────────────
  const ready = {
    blogger: !!(tokens.get('BLOGGER_CLIENT_ID') && tokens.get('BLOGGER_CLIENT_SECRET') && tokens.get('BLOGGER_REFRESH_TOKEN')),
    naver:   !!(tokens.get('NAVER_ID') && tokens.get('NAVER_PW') && tokens.get('NAVER_BLOG_ID')),
    tistory: !!(tokens.get('TISTORY_ID') && tokens.get('TISTORY_PW') && tokens.get('TISTORY_BLOG_NAME')),
  };
  if (!Object.values(ready).some(Boolean)) {
    problems.push({
      key: 'no_platform',
      severity: 'high',
      title: '연결된 블로그가 하나도 없습니다',
      detail: '어디에도 글을 올릴 수 없는 상태입니다.',
      action: '/setup 에서 블로그 연결',
    });
  }

  // ── 저장이 휘발성인가 ─────────────────────────────────────
  const store = tokens.storageInfo();
  if (!store.persistent) {
    problems.push({
      key: 'not_persistent',
      severity: 'medium',
      title: '재배포하면 연결이 끊깁니다',
      detail: '지금은 값이 서버 메모리에만 있어, 서버가 새로 뜨면 사라집니다.',
      action: '설정 탭 → 복구값 만들기 → Railway 에 CREDENTIALS_BLOB 으로 붙여넣기 (1회)',
    });
  } else if (store.blobStale) {
    /* 복구값은 넣었는데 그 뒤에 자격증명이 바뀐 경우.
       "안 넣었다"고 다시 시키면 넣어둔 사람 입장에선 같은 말만 반복하는 꼴이라,
       무엇이 달라졌는지 구분해서 알려준다. */
    problems.push({
      key: 'blob_stale',
      severity: 'medium',
      title: '복구값이 지금 설정보다 오래됐습니다',
      detail: '복구값을 넣은 뒤에 연결 정보가 바뀌었습니다. 이대로 재배포하면 옛 값으로 되돌아갑니다.',
      action: '설정 탭 → 복구값 만들기 → Railway 의 CREDENTIALS_BLOB 값만 새 걸로 교체',
    });
  }

  /* 제휴 링크에 추적 ID가 없으면 글이 아무리 올라가도 수익은 0원이다.
     조용히 0원인 상태가 제일 나쁘므로 분명히 알린다. */
  if (!tokens.get('COUPANG_PARTNERS_TAG') && !tokens.get('NAVER_CONNECT_ID')) {
    problems.push({
      key: 'no_affiliate_tracking',
      severity: 'high',
      title: '제휴 수익 추적이 안 붙어 있습니다',
      detail: '지금 글에 들어가는 상품 링크로는 구매가 일어나도 수익이 0원입니다.',
      action: '쿠팡파트너스 가입 후 설정 탭에 COUPANG_PARTNERS_TAG 입력 (가입 즉시 발급)',
    });
  }

  /* 제휴 프로그램 목록이 낡으면, 수수료 낮은 곳만 계속 소개하게 된다.
     새로 뜬 곳(수수료가 몇 배인 곳)을 놓치는 건 조용한 손해라 눈에 안 띈다.
     그래서 마지막으로 확인한 시점을 보고 오래됐으면 알린다. */
  try {
    const { programsAgeMonths } = require('../affiliates/crawler');
    const age = programsAgeMonths();
    if (age !== null && age >= 4) {
      problems.push({
        key: 'affiliate_list_stale',
        severity: 'medium',
        title: `제휴 프로그램 목록이 ${age}개월째 그대로입니다`,
        detail: '새로 나온 고수수료 프로그램을 놓치고 있을 수 있습니다. 수수료 차이는 몇 배까지 납니다.',
        action: '제휴 목록을 다시 확인해 갱신 요청하기',
      });
    }
  } catch (_) { /* 목록을 못 읽어도 점검 자체는 계속한다 */ }

  // ── 최근 발행이 계속 실패하고 있는가 ──────────────────────
  const log = (typeof readLog === 'function' ? readLog() : []) || [];
  const recent = log.slice(0, 10);
  const recentFailed = recent.filter(e => e.status === 'failed');
  if (recent.length >= 3 && recentFailed.length === recent.length) {
    problems.push({
      key: 'all_failing',
      severity: 'high',
      title: `최근 발행 ${recent.length}건이 모두 실패했습니다`,
      detail: recentFailed[0]?.error || '원인은 설정 탭의 오류 목록에서 확인하세요.',
      action: '설정 탭 → 진짜 발행 테스트',
    });
  }

  // ── 오늘 성과 (알림이 아니라 안심용) ──────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const todayEntries = log.filter(e => (e.loggedAt || '').slice(0, 10) === today);
  const todayOk = todayEntries.filter(e => e.status === 'done').length;
  const todayFail = todayEntries.filter(e => e.status === 'failed').length;

  const queue = (typeof readQueue === 'function' ? readQueue() : []) || [];
  const pending = queue.filter(j => j.status !== 'done').length;

  const uptimeMin = serverStartedAt ? Math.round((Date.now() - serverStartedAt) / 60000) : null;
  if (uptimeMin !== null && uptimeMin < 5) {
    notes.push('서버가 방금 재시작됐습니다 (배포했거나 다시 떴음)');
  }

  return {
    checkedAt: new Date().toISOString(),
    ok: problems.length === 0,
    problems,
    notes,
    ready,
    today: { published: todayOk, failed: todayFail },
    pending,
    persistent: store.persistent,
    storageMode: store.mode,
    uptimeMin,
  };
}

/**
 * 알려야 할 문제만 골라낸다.
 * 이미 알린 문제는 24시간 안에는 다시 알리지 않는다.
 */
function pickNewProblems(problems) {
  const now = Date.now();
  const fresh = [];
  const activeKeys = new Set(problems.map(p => p.key));

  // 해결된 문제는 기록에서 지운다 — 재발하면 다시 알리기 위해
  for (const key of [...notified.keys()]) {
    if (!activeKeys.has(key)) notified.delete(key);
  }

  for (const p of problems) {
    const prev = notified.get(p.key);
    if (prev && now - prev.at < RENOTIFY_MS) continue;
    notified.set(p.key, { at: now, count: (prev?.count || 0) + 1 });
    fresh.push(p);
  }
  return fresh;
}

/** 알림 문구 만들기 */
function formatProblems(problems) {
  const lines = problems.map(p =>
    `${p.severity === 'high' ? '🔴' : '🟡'} <b>${p.title}</b>\n${p.detail}\n👉 ${p.action}`);
  return `⚠️ 손봐야 할 게 있습니다\n\n${lines.join('\n\n')}`;
}

/** 하루 한 번 요약 문구 */
function formatDaily(state) {
  if (!state.ok) return formatProblems(state.problems);
  const { published, failed } = state.today;
  const head = published > 0
    ? `✅ 오늘 ${published}건 발행 완료`
    : '✅ 문제 없습니다 (오늘 발행 예정 없음)';
  const extra = [];
  if (failed > 0) extra.push(`실패 ${failed}건`);
  if (state.pending > 0) extra.push(`예약 대기 ${state.pending}건`);
  return `${head}${extra.length ? `\n${extra.join(' · ')}` : ''}\n\n신경 쓰실 것 없습니다.`;
}

/** 테스트용 — 알림 기록 비우기 */
function _reset() { notified.clear(); }

module.exports = { assess, pickNewProblems, formatProblems, formatDaily, _reset, RENOTIFY_MS };
