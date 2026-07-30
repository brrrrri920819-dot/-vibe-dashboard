// 부업 자동 실행이 글을 실제로 발행 큐에 넣는지
const Module=require('module');const orig=Module.prototype.require;
Module.prototype.require=function(p){
  if(p==='./income/hustle-pipeline'){
    return { PIPELINE_CONFIGS:{}, getPipelineStatus:async()=>({}),
      executePipeline:async(id)=>{
        if(id==='naver_blog') return { hustleId:id, summary:'ok', error:null,
          data:{ readyToPublish:true, title:'부업으로 월 100만원 만드는 법',
                 content:'<p>본문</p>', tags:['부업','재테크'], keyword:'부업' } };
        return { hustleId:id, summary:'ok', error:null, data:{ steps:[] } };
      }};
  }
  return orig.apply(this,arguments);
};
process.env.RAILWAY_ENVIRONMENT='test';
process.env.PORT=3986;
const http=require('http');
require('../server.js');
const q=require('../scheduler/queue.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
setTimeout(()=>{
  console.log('\n[29] 부업 자동 실행 → 발행 큐 등록');
  const before=q.readQueue().length;
  const r=http.request({port:3986,path:'/api/hustle-run-all',method:'POST'},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',async()=>{
      const j=JSON.parse(d);
      ck('실행 API 응답', j.success===true, d);
      ck('실행 대상 목록 반환', Array.isArray(j.pipelines)&&j.pipelines.includes('naver_blog'), JSON.stringify(j.pipelines));
      await new Promise(s=>setTimeout(s,18000));   // 파이프라인 간 3초 간격 대기
      const queue=q.readQueue();
      const added=queue.filter(x=>String(x.id).startsWith('hustle_'));
      ck('글이 발행 큐에 실제로 등록됨', added.length>=1, '큐 '+before+'→'+queue.length);
      if(added[0]){
        ck('제목 전달됨', added[0].title==='부업으로 월 100만원 만드는 법', added[0].title);
        ck('본문 전달됨', !!added[0].content, String(added[0].content).slice(0,20));
        ck('출처 표시', added[0].source==='hustle_naver_blog', added[0].source);
        ck('예약 시각 존재', !!added[0].scheduledAt, added[0].scheduledAt);
      }
      console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
      process.exit(ng?1:0);
    });});
  r.end();
},1500);
