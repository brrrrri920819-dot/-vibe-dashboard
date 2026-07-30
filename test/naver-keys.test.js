// 네이버 검색 API 키를 대시보드에서 저장하고 실제 기능이 쓰는지
const http=require('http');const fs=require('fs');
try{fs.unlinkSync('./config/tokens.json')}catch(e){}
try{fs.rmSync('/data',{recursive:true,force:true})}catch(e){}
['NAVER_CLIENT_ID','NAVER_CLIENT_SECRET'].forEach(k=>delete process.env[k]);
process.env.PORT=3977;require('../server.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function req(m,p,b){return new Promise((res,rej)=>{const s=b?JSON.stringify(b):null;
  const r=http.request({port:3977,path:p,method:m,headers:s?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res({status:x.statusCode,body:d?JSON.parse(d):null}));});
  r.on('error',rej);if(s)r.write(s);r.end();});}
setTimeout(async()=>{
  console.log('\n[49] 네이버 검색 API 키 저장');
  let st=(await req('GET','/api/keys/status')).body;
  ck('저장 전 미설정',st.NAVER_CLIENT_ID.set===false);

  const r=await req('POST','/api/keys',{NAVER_CLIENT_ID:'testid',NAVER_CLIENT_SECRET:'testsecret'});
  ck('두 키 모두 저장',r.body.saved.length===2,JSON.stringify(r.body.saved));

  st=(await req('GET','/api/keys/status')).body;
  ck('저장 후 설정됨',st.NAVER_CLIENT_ID.set===true&&st.NAVER_CLIENT_SECRET.set===true);
  ck('값은 노출 안 함',!JSON.stringify(st).includes('testsecret'));

  console.log('\n[50] 저장한 키를 기능이 실제로 사용');
  ck('process.env 반영',process.env.NAVER_CLIENT_ID==='testid');
  const rec=await req('GET','/api/shopping-recommend?q=' + encodeURIComponent('캠핑'));
  // 가짜 키라 인증 실패하지만, '키 없음' 사유가 아니어야 한다 = 키를 읽었다는 뜻
  ck('키 미설정 사유가 아님',!/NAVER_CLIENT_ID .* 미설정|미설정 —/.test(rec.body.reason||''),JSON.stringify(rec.body).slice(0,140));

  console.log('\n[51] 재배포 후 복구 대상 포함');
  const bk=await req('GET','/api/credentials/backup');
  ck('백업에 네이버 키 포함',bk.body.NAVER_CLIENT_ID==='testid'&&bk.body.NAVER_CLIENT_SECRET==='testsecret',JSON.stringify(Object.keys(bk.body)));

  try{fs.unlinkSync('./config/tokens.json')}catch(e){}
  try{fs.rmSync('/data',{recursive:true,force:true})}catch(e){}
  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
