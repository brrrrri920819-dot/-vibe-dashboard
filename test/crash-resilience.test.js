// 백그라운드 오류가 나도 서버가 죽지 않고 계속 응답하는지
const http=require('http');
process.env.PORT=3988;
require('../server.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function get(p){return new Promise((res,rej)=>{
  http.get({port:3988,path:p},x=>{let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d}));})
    .on('error',rej);});}
setTimeout(async()=>{
  console.log('\n[27] 백그라운드 오류에도 서버 생존');
  let r=await get('/api/status');
  ck('평상시 응답',r.status===200);

  // 처리되지 않은 Promise 오류 발생시키기 (예전엔 여기서 프로세스가 죽었다)
  Promise.reject(new Error('백그라운드 작업 실패 재현'));
  await new Promise(s=>setTimeout(s,400));
  r=await get('/api/status');
  ck('unhandledRejection 후에도 응답', r.status===200, 'status='+r.status);

  // 동기 예외
  setTimeout(()=>{ throw new Error('동기 예외 재현'); },0);
  await new Promise(s=>setTimeout(s,400));
  r=await get('/api/status');
  ck('uncaughtException 후에도 응답', r.status===200, 'status='+r.status);

  console.log('\n[28] 재시작된 서버에 옛 작업을 물으면 즉시 오류 반환');
  r=await get('/api/generate-status/gen_1000000000000');   // 서버 시작 전 시각
  ck('410으로 중단 안내', r.status===410, 'status='+r.status);
  ck('재시작 문구 포함', /재시작/.test(r.body), r.body.slice(0,80));

  r=await get('/api/generate-status/gen_'+(Date.now()+60000)); // 미래 = 알 수 없음
  ck('알 수 없는 작업은 404', r.status===404, 'status='+r.status);

  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
