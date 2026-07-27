const http=require('http');const fs=require('fs');const path=require('path');
const TOKENS=path.join(__dirname,'../config/tokens.json');
process.env.PORT=3995;
['BLOGGER_CLIENT_ID','BLOGGER_CLIENT_SECRET','BLOGGER_REFRESH_TOKEN','BLOGGER_BLOG_ID'].forEach(k=>delete process.env[k]);
try{fs.unlinkSync(TOKENS)}catch(e){}
require('../server.js');
let pass=0,fail=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),pass++):(console.log('  ❌ '+n+' '+e),fail++)};
function req(method,p,body){return new Promise((res,rej)=>{
  const b=body?JSON.stringify(body):null;
  const r=http.request({port:3995,path:p,method,headers:b?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(b)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d?JSON.parse(d):null}));});
  r.on('error',rej);if(b)r.write(b);r.end();});}
setTimeout(async()=>{
  console.log('\n[16] 재배포로 토큰이 날아간 상황 → 브라우저 사본으로 자동 복구');
  let st=await req('GET','/api/status');
  ck('복구 전: blogger 연결 끊김',st.body.platforms.blogger===false,JSON.stringify(st.body.platforms));

  const saved={BLOGGER_CLIENT_ID:'cid.apps.googleusercontent.com',BLOGGER_CLIENT_SECRET:'GOCSPX-secret',
               BLOGGER_REFRESH_TOKEN:'1//refresh-token',BLOGGER_BLOG_ID:'123456789012'};
  const r=await req('POST','/api/credentials/restore',saved);
  ck('복구 API 4개 처리',r.body.restored.length===4,JSON.stringify(r.body.restored));

  st=await req('GET','/api/status');
  ck('복구 후: blogger 연결됨',st.body.platforms.blogger===true,JSON.stringify(st.body.platforms));

  console.log('\n[17] 서버에 이미 값이 있으면 덮어쓰지 않음');
  const r2=await req('POST','/api/credentials/restore',{BLOGGER_REFRESH_TOKEN:'다른값'});
  ck('덮어쓰기 안 함',r2.body.restored.length===0,JSON.stringify(r2.body.restored));
  const bk=await req('GET','/api/credentials/backup');
  ck('원래 토큰 유지',bk.body.BLOGGER_REFRESH_TOKEN==='1//refresh-token',bk.body.BLOGGER_REFRESH_TOKEN);

  console.log('\n[18] 백업 API가 사본을 내려줌');
  ck('4개 항목 반환',Object.keys(bk.body).length===4,Object.keys(bk.body).join(','));

  console.log('\n[19] 빈 값은 무시');
  try{fs.unlinkSync(TOKENS)}catch(e){}
  const r3=await req('POST','/api/credentials/restore',{BLOGGER_REFRESH_TOKEN:'   ',BLOGGER_CLIENT_ID:''});
  ck('공백/빈문자 저장 안 함',r3.body.restored.length===0,JSON.stringify(r3.body.restored));

  try{fs.unlinkSync(TOKENS)}catch(e){}
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail?1:0);
},1500);
