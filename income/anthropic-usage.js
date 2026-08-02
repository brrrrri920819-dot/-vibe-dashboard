/**
 * income/anthropic-usage.js
 * 글 생성에 돈이 얼마나 나갔는지 가져온다.
 *
 * 알아둘 것 — 앤트로픽은 "남은 잔액"을 알려주는 API가 없다.
 * 있는 건 '쓴 금액(cost report)' 뿐이라, 여기서는 지출만 가져온다.
 * 잔액이 바닥났는지는 실제 호출이 거부되는지로 판단한다(server.js probeClaudeKey).
 *
 * 이 API는 관리자 키(sk-ant-admin...)가 필요하고, 개인 계정에는 발급되지 않는다.
 * 그래서 없을 수도 있다는 전제로 만들고, 없으면 없다고 분명히 알려준다.
 */

'use strict';

const https = require('https');

const HOST = 'api.anthropic.com';
const COST_PATH = '/v1/organizations/cost_report';

/* 연결은 됐는데 응답이 안 오는 경우 req.setTimeout 은 작동하지 않는다.
   벽시계로 끊지 않으면 대시보드가 계속 로딩만 돈다. */
function withDeadline(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 응답 시간 초과 (${ms / 1000}초)`)), ms);
    promise.then(v => { clearTimeout(timer); resolve(v); },
                 e => { clearTimeout(timer); reject(e); });
  });
}

function getJson(path, adminKey) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: HOST, path, method: 'GET',
      headers: {
        'x-api-key': adminKey,
        'anthropic-version': '2023-06-01',
        'User-Agent': 'vibe-dashboard/1.0',
      },
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', c => { d += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch (_) {}
        if (!json) return reject(new Error(`응답을 이해할 수 없습니다 (HTTP ${res.statusCode})`));
        if (json.error || res.statusCode >= 400) {
          const msg = (json.error && json.error.message) || `HTTP ${res.statusCode}`;
          const err = new Error(msg);
          err.status = res.statusCode;
          return reject(err);
        }
        resolve(json);
      });
    });
    req.on('error', e => reject(new Error(`네트워크 오류: ${e.message}`)));
    req.end();
  });
}

/** 날짜를 UTC 자정 기준 RFC3339 문자열로 */
function dayStart(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 이번 달 지출과 최근 며칠치를 가져온다.
 * @returns {{ok:boolean, reason?:string, currency:string, monthCents:number, todayCents:number, days:Array}}
 */
async function fetchSpend(adminKey, { days = 30 } = {}) {
  if (!adminKey) {
    return { ok: false, reason: 'no_key', message: '관리자 키(ANTHROPIC_ADMIN_KEY)가 없습니다' };
  }
  if (!/^sk-ant-admin/.test(adminKey.trim())) {
    return {
      ok: false, reason: 'wrong_key_type',
      message: '이 값은 관리자 키가 아닙니다 — 관리자 키는 sk-ant-admin 으로 시작합니다',
    };
  }

  const now = new Date();
  // 이번 달 1일과 최근 N일 중 더 이른 쪽부터 가져와 둘 다 계산할 수 있게 한다
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nDaysAgo = new Date(now.getTime() - (days - 1) * 86400000);
  const from = monthStart < nDaysAgo ? monthStart : nDaysAgo;

  // 1d 버킷은 최대 31개까지만 받을 수 있다
  const qs = new URLSearchParams({
    starting_at: dayStart(from),
    ending_at: dayStart(new Date(now.getTime() + 86400000)),
    bucket_width: '1d',
    limit: '31',
  });

  let json;
  try {
    json = await withDeadline(getJson(`${COST_PATH}?${qs}`, adminKey), 20000, '사용 금액 조회');
  } catch (e) {
    if (e.status === 401 || /authentication|invalid x-api-key/i.test(e.message)) {
      return { ok: false, reason: 'unauthorized', message: '관리자 키가 거부됐습니다 — 키를 다시 확인해주세요' };
    }
    if (e.status === 403 || /permission|not authorized/i.test(e.message)) {
      return {
        ok: false, reason: 'forbidden',
        message: '이 계정에서는 사용 금액 조회가 안 됩니다 (개인 계정에는 관리자 키가 발급되지 않습니다)',
      };
    }
    return { ok: false, reason: 'failed', message: e.message };
  }

  const buckets = Array.isArray(json.data) ? json.data : [];
  const monthStartMs = monthStart.getTime();
  const todayKey = dayStart(now).slice(0, 10);

  let monthCents = 0;
  let todayCents = 0;
  const daily = [];

  for (const b of buckets) {
    const startMs = Date.parse(b.starting_at);
    const cents = (b.results || []).reduce((sum, r) => sum + (Number(r.amount) || 0), 0);
    const date = String(b.starting_at || '').slice(0, 10);
    daily.push({ date, cents });
    if (Number.isFinite(startMs) && startMs >= monthStartMs) monthCents += cents;
    if (date === todayKey) todayCents += cents;
  }

  daily.sort((a, b) => (a.date < b.date ? 1 : -1));   // 최신 먼저

  return {
    ok: true,
    currency: 'USD',
    monthCents,
    todayCents,
    days: daily.slice(0, days),
    // 참고: 이건 '쓴 돈'이다. 남은 잔액은 앤트로픽이 API로 알려주지 않는다.
    note: '앤트로픽은 남은 잔액을 알려주는 API가 없어, 쓴 금액만 보여줍니다',
  };
}

/** 센트(문자열 합계) → 보기 좋은 달러 표기 */
function formatUsd(cents) {
  const dollars = (Number(cents) || 0) / 100;
  return '$' + dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { fetchSpend, formatUsd };
