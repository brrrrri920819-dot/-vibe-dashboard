/**
 * test/hustle-truth.test.js
 * 부업 화면이 실제 동작보다 부풀려 표시하지 않는가.
 *
 * 예전에 네이버 블로그 파이프라인은 화면에 '100% 자동' 이라고 뜨고
 * 3단계가 "발행 큐 준비 완료" 였는데, 정작 큐에 넣는 코드가 없었다.
 * 글을 만들어놓고 버리면서 곧 올라갈 것처럼 보여줬다.
 *
 * 할 수 있는 것만 할 수 있다고 적혀 있어야 한다.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`); };

const src = fs.readFileSync(path.join(__dirname, '..', 'income', 'hustle-pipeline.js'), 'utf8');
const { PIPELINE_CONFIGS } = (() => {
  // 메타데이터만 떼어내 읽는다 (모듈 전체는 네트워크를 탄다)
  const i = src.indexOf('const PIPELINE_CONFIGS = {');
  const j = src.indexOf('};', i) + 2;
  // eslint-disable-next-line no-new-func
  return new Function(`${src.slice(i, j)} return { PIPELINE_CONFIGS };`)();
})();

(async () => {
  console.log('\n🧾 부업 표시가 사실인가 테스트\n');

  // ── 1) 실제로 발행까지 가는 것만 그렇게 적혀 있는가 ───────
  ok('네이버 블로그는 발행 예약까지 한다고 적는다',
    /발행 예약/.test(PIPELINE_CONFIGS.naver_blog.autoLevel));

  const helpersOnly = ['ai_freelance', 'shorts', 'smart_store', 'ebook', 'class101', 'app_tech'];
  for (const k of helpersOnly) {
    ok(`${PIPELINE_CONFIGS[k].name}: 직접 해야 함을 밝힌다`,
      /직접/.test(PIPELINE_CONFIGS[k].autoLevel));
  }

  ok('"100% 자동" 이라고 주장하지 않는다',
    !Object.values(PIPELINE_CONFIGS).some(c => /100%/.test(c.autoLevel)));

  // ── 2) 네이버 블로그가 정말 큐에 넣는가 ──────────────────
  ok('스케줄러 큐를 실제로 불러온다', /require\('\.\.\/scheduler\/queue'\)/.test(src));
  const step3 = src.slice(src.indexOf('Step 3: 발행 큐'), src.indexOf('Step 3: 발행 큐') + 1400);
  ok('3단계에서 enqueue 를 호출한다', /enqueue\(job\)/.test(step3));
  ok('제목·본문을 담아 넣는다', /title:\s*postData\.title/.test(step3) && /content:\s*postData\.content/.test(step3));
  ok('글이 없으면 큐에 넣지 않고 실패시킨다', /글이 만들어지지 않아/.test(step3));
  ok('큐에 못 넣었으면 완성이라고 하지 않는다', /예약에 실패했습니다/.test(src));

  console.log(`\n✅ ${pass}개 통과\n`);
})().catch((e) => { console.error('\n❌ 실패:', e.message, '\n'); process.exit(1); });
