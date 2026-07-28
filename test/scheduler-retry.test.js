const path=require('path');
process.env.RAILWAY_ENVIRONMENT='test';  // 메모리 큐 사용
const q=require('../scheduler/queue.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};

// cron을 즉시 실행 가능한 형태로 가로채기
const cron=require('node-cron');
let tick=null;
cron.schedule=(expr,fn)=>{ if(expr==='* * * * *') tick=fn; return {stop(){}}; };

(async()=>{
  console.log('\n[23] 재배포 직후 토큰 없을 때 예약글이 사라지지 않는지');
  let calls=0;
  const publishFn=async(job)=>{
    calls++;
    // 처음 2회는 인증 없음, 3회째 성공 (연결 복구된 상황)
    if(calls<3) return { blogger:{ success:false, error:'설정 탭 > 블로그스팟 인증하기 버튼을 클릭해서 Google 연결 필요' } };
    return { blogger:{ success:true, url:'https://blog/x' } };
  };
  q.startScheduler(publishFn);
  q.enqueue({ id:'j1', title:'예약글', content:'<p>본문</p>', platforms:['blogger'], scheduledAt:new Date(Date.now()-1000).toISOString() });

  await tick();
  let job=q.readQueue().find(j=>j.id==='j1');
  ck('1회 실패 후에도 큐에 남아있음', !!job, JSON.stringify(q.readQueue().map(j=>j.status)));
  ck('상태가 pending으로 복구됨', job&&job.status==='pending', job&&job.status);
  ck('재시도 횟수 기록', job&&job.authRetries===1, job&&job.authRetries);

  await tick();
  job=q.readQueue().find(j=>j.id==='j1');
  ck('2회째도 유지', !!job&&job.status==='pending', job&&job.status);

  await tick();
  ck('연결 복구되자 발행 완료', q.readQueue().filter(j=>j.id==='j1').length===0, JSON.stringify(q.readQueue().map(j=>j.id+':'+j.status)));
  const log=q.readLog();
  ck('로그에 성공으로 기록', log.some(e=>e.id==='j1'&&e.status==='done'), JSON.stringify(log.map(e=>e.status)));

  console.log('\n[24] 인증과 무관한 실패는 즉시 실패 처리');
  let c2=0;
  cron.schedule=(expr,fn)=>{ if(expr==='* * * * *') tick=fn; return {stop(){}}; };
  q.startScheduler(async()=>{ c2++; return { blogger:{ success:false, error:'본문이 너무 길어 거부됨' } }; });
  q.enqueue({ id:'j2', title:'다른실패', content:'x', platforms:['blogger'], scheduledAt:new Date(Date.now()-1000).toISOString() });
  await tick();
  const j2=q.readQueue().find(j=>j.id==='j2');
  ck('인증 문제 아니면 재시도하지 않음', j2&&j2.status==='failed', j2&&j2.status);

  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
})();
