// Railway 환경변수에 틀린 시크릿이 있어도 브라우저 사본 복구가 덮어쓰는지
const http=require('http');const fs=require('fs');
try{fs.unlinkSync('./config/tokens.json')}catch(e){}
process.env.PORT=3991;
process.env.BLOGGER_CLIENT_ID='554163429663-old.apps.googleusercontent.com';
process.env.BLOGGER_CLIENT_SECRET='GOCSPX-WRONG-FROM-RAILWAY';
delete process.env.BLOGGER_REFRESH_TOKEN;delete process.env.BLOGGER_BLOG_ID;
require('../server.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function req(method,p,body){return new Promise((res,rej)=>{const b=body?JSON.stringify(body):null;
  const r=http.request({port:3991,path:p,method,headers:b?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res(JSON.parse(d)));});r.on('error',rej);if(b)r.write(b);r.end();});}
setTimeout(async()=>{
  console.log('\n[25] 틀린 Railway 환경변수를 브라우저 사본이 덮어씀');
  const r=await req('POST','/api/credentials/restore',{
    BLOGGER_CLIENT_ID:'554163429663-correct.apps.googleusercontent.com',
    BLOGGER_CLIENT_SECRET:'GOCSPX-CORRECT-FROM-BROWSER'});
  ck('환경변수 값 2개가 교체됨',r.restored.length===2,JSON.stringify(r.restored));
  const d=await req('GET','/api/blogger-diagnose');
  const s2=d.steps[1];
  ck('시크릿 출처가 [이 화면에서 저장됨]',/이 화면에서 저장됨/.test(s2.detail),s2.detail);
  ck('교체된 값 사용 중',/GOCSPX-…/.test(s2.detail)&&s2.detail.includes('27자'),s2.detail);
  const bk=await req('GET','/api/credentials/backup');
  ck('백업엔 검증 저장값만 포함',bk.BLOGGER_CLIENT_SECRET==='GOCSPX-CORRECT-FROM-BROWSER',JSON.stringify(Object.keys(bk)));
  try{fs.unlinkSync('./config/tokens.json')}catch(e){}
  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
