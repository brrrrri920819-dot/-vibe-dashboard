// 부업 탭 실사용 시나리오 — 버튼을 눌렀을 때 끝까지 도는지
const Module=require('module');const orig=Module.prototype.require;
const https=require('https');const {EventEmitter}=require('events');
const origReq=https.request;
https.request=function(url,opts,cb){
  if(String(url).includes('api.anthropic.com')){
    const r=new EventEmitter();r.setTimeout=()=>{};r.destroy=()=>{};r.write=()=>{};
    r.end=()=>{setTimeout(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
      const good={title:'제목',content:'<p>'+'내용 '.repeat(400)+'</p>',tags:['a'],imageKeywords:['x'],
        apps:[{name:'앱',dailyReward:'100포인트'}],opportunities:[{name:'서비스'}],
        products:[{name:'상품',estimatedMargin:'30%'}],chapters:[{title:'1장'}],
        outline:['1강'],lessons:[{no:1}],script:[{time:'0-3초',text:'훅'}],courseTitle:'강의',summary:'요약'};
      res.emit('data',JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(good)}]}));
      res.emit('end');},50);};   // 지연을 줘서 비동기 흐름을 실제처럼
    return r;}
  return origReq.apply(this,arguments);
};
https.get=function(url,opts,cb){if(typeof opts==='function')cb=opts;
  const r=new EventEmitter();r.setTimeout=()=>{};r.destroy=()=>{};
  process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',JSON.stringify({results:[{urls:{regular:'https://images.unsplash.com/a.jpg'},user:{name:'A'}}]}));res.emit('end');});
  return r;};

process.env.RAILWAY_ENVIRONMENT='test';
process.env.ANTHROPIC_API_KEY='t';process.env.UNSPLASH_ACCESS_KEY='t';
process.env.PORT=3974;
const http=require('http');
require('../server.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function req(m,p,b){return new Promise((res,rej)=>{const s=b?JSON.stringify(b):null;
  const r=http.request({port:3974,path:p,method:m,headers:s?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d?JSON.parse(d):null}));});
  r.on('error',rej);if(s)r.write(s);r.end();});}
async function poll(path,ms=25000){
  const t0=Date.now();
  while(Date.now()-t0<ms){
    const r=await req('GET',path);
    if(r.status===200&&r.body&&(r.body.status==='done'||r.body.status==='error')) return r.body;
    if(r.status===410) return {status:'error',error:r.body.error};
    await new Promise(s=>setTimeout(s,300));
  }
  return {status:'timeout'};
}
setTimeout(async()=>{
  console.log('\n[52] 부업 카드 클릭 → 파이프라인 실행 (Railway 30초 제한 대응)');
  const start=Date.now();
  const init=await req('POST','/api/hustle-pipeline/app_tech');
  const elapsed=Date.now()-start;
  ck('요청이 즉시 반환됨(타임아웃 방지)', elapsed<3000, elapsed+'ms');
  ck('jobId 발급', !!init.body.jobId, JSON.stringify(init.body));

  const done=await poll('/api/hustle-pipeline-status/'+init.body.jobId);
  ck('실행 완료', done.status==='done', JSON.stringify(done).slice(0,120));
  ck('오류 없음', !done.error, done.error||'');
  ck('단계 결과 존재', Array.isArray(done.steps)&&done.steps.length>0, JSON.stringify((done.steps||[]).map(s=>s.status)));
  ck('요약에 undefined 없음', !/undefined/.test(done.summary||''), done.summary);

  console.log('\n[53] 서버 재시작으로 사라진 작업은 즉시 오류 반환');
  const stale=await req('GET','/api/hustle-pipeline-status/pipe_app_tech_1000000000000');
  ck('410으로 안내', stale.status===410, String(stale.status));

  console.log('\n[55] 부업 기본 데이터 조회');
  const h=await req('GET','/api/income-hustles');
  ck('부업 목록 반환', Array.isArray(h.body)&&h.body.length>0, 'count='+(h.body||[]).length);
  const first=(h.body||[])[0]||{};
  ck('수익 범위 정보 포함', !!(first.name&&typeof first.monthlyMin==='number'&&typeof first.monthlyMax==='number'),
     JSON.stringify({n:first.name,min:first.monthlyMin,max:first.monthlyMax}));
  ck('시작 비용·난이도 포함', first.startupCost!==undefined&&!!first.difficulty,
     JSON.stringify({c:first.startupCost,d:first.difficulty}));

  console.log('\n[56] 잘못된 파이프라인 ID 처리');
  const bad=await req('POST','/api/hustle-pipeline/unknown_pipeline');
  const badDone=await poll('/api/hustle-pipeline-status/'+bad.body.jobId, 8000);
  ck('알 수 없는 ID는 오류로 종료', badDone.status==='error'||badDone.error, JSON.stringify(badDone).slice(0,100));
  ck('서버는 계속 살아있음', (await req('GET','/api/health')).status===200);

  console.log('\n[54] 전체 실행 버튼 (자동 발행까지)');
  const all=await req('POST','/api/hustle-run-all');
  ck('실행 시작 응답', all.body.success===true);
  ck('대상 목록 반환', Array.isArray(all.body.pipelines)&&all.body.pipelines.length>=3, JSON.stringify(all.body.pipelines));

  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
