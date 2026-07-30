// 일괄 발행: 플랫폼 선택 · 제휴 포함 · 큐 등록이 실제로 되는지
const Module=require('module');const orig=Module.prototype.require;
Module.prototype.require=function(p){
  if(p==='./content/generator'||p==='../content/generator'){
    return { generatePost: async(kw)=>({ title:kw+' 완전정리', content:'<p>본문</p>', tags:[kw] }),
             fetchImage: async()=>({url:'x',credit:'',source:'Unsplash'}) };
  }
  return orig.apply(this,arguments);
};
process.env.RAILWAY_ENVIRONMENT='test';process.env.PORT=3982;
const http=require('http');
require('../server.js');
const q=require('../scheduler/queue.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function req(m,p,b){return new Promise((res,rej)=>{const s=b?JSON.stringify(b):null;
  const r=http.request({port:3982,path:p,method:m,headers:s?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d?JSON.parse(d):null}));});r.on('error',rej);if(s)r.write(s);r.end();});}
setTimeout(async()=>{
  console.log('\n[37] 입력 검증');
  let r=await req('POST','/api/bulk-publish',{keywords:[],platforms:['blogger']});
  ck('키워드 없으면 거부',r.status===400,String(r.status));
  r=await req('POST','/api/bulk-publish',{keywords:['a'],platforms:[]});
  ck('블로그 미선택 시 거부',r.status===400,String(r.status));

  console.log('\n[38] 여러 키워드 × 여러 블로그 발행');
  r=await req('POST','/api/bulk-publish',{keywords:['출산휴가 급여','청년도약계좌'],
    platforms:['blogger','naver'],includeAffiliate:true,scheduleMode:'spread',intervalMinutes:60});
  ck('jobId 발급',!!r.body.jobId,JSON.stringify(r.body));
  ck('총 건수 반환',r.body.total===2,String(r.body.total));

  let st,tries=0;
  do{ await new Promise(s=>setTimeout(s,1000)); st=(await req('GET','/api/bulk-publish-status/'+r.body.jobId)).body; tries++; }
  while(st.status!=='done'&&tries<40);
  ck('작업 완료',st.status==='done',st.status);
  ck('2개 모두 성공',st.okCount===2,JSON.stringify(st.items&&st.items.map(i=>i.status)));

  const queue=q.readQueue().filter(j=>j.source==='bulk_publish');
  ck('키워드×블로그 = 4건 큐 등록',queue.length===4,'큐 '+queue.length+'건');
  ck('블로그스팟·네이버 각각 등록',
     queue.filter(j=>j.platforms[0]==='blogger').length===2 && queue.filter(j=>j.platforms[0]==='naver').length===2,
     JSON.stringify(queue.map(j=>j.platforms[0])));

  console.log('\n[39] 제휴 구조');
  const naverJob=queue.find(j=>j.platforms[0]==='naver');
  ck('네이버 글에 대가성 고지 포함',/제휴 링크가 포함/.test(naverJob.content));
  ck('네이버 글에 제휴 블록 포함',/함께 보면 좋은 제휴 서비스/.test(naverJob.content));
  ck('제휴 링크에 sponsored nofollow',/rel="sponsored nofollow noopener"/.test(naverJob.content));
  ck('네이버 허용 프로그램만 사용',!/쿠팡파트너스 바로가기/.test(naverJob.content)||/네이버/.test(naverJob.content));
  ck('사용된 제휴가 결과에 기록',(st.items[0].affiliates||[]).length>0,JSON.stringify(st.items[0].affiliates));

  console.log('\n[40] 시간 간격 예약');
  const times=queue.filter(j=>j.platforms[0]==='blogger').map(j=>new Date(j.scheduledAt).getTime()).sort((a,b)=>a-b);
  ck('글마다 시간 간격을 둠',times[1]-times[0]>30*60*1000,'간격 '+Math.round((times[1]-times[0])/60000)+'분');

  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
