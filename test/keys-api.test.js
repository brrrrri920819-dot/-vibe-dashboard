const http=require('http');const fs=require('fs');
try{fs.unlinkSync('./config/tokens.json')}catch(e){}
['ANTHROPIC_API_KEY','UNSPLASH_ACCESS_KEY','COUPANG_PARTNERS_ID'].forEach(k=>delete process.env[k]);
process.env.PORT=3985;require('../server.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function req(m,p,b){return new Promise((res,rej)=>{const s=b?JSON.stringify(b):null;
  const r=http.request({port:3985,path:p,method:m,headers:s?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(s)}:{}},x=>{
    let d='';x.on('data',c=>d+=c);x.on('end',()=>res(JSON.parse(d)));});r.on('error',rej);if(s)r.write(s);r.end();});}
setTimeout(async()=>{
  console.log('\n[30] 대시보드에서 키 저장');
  let st=await req('GET','/api/keys/status');
  ck('저장 전 미설정',st.ANTHROPIC_API_KEY.set===false&&st.UNSPLASH_ACCESS_KEY.set===false);

  const r=await req('POST','/api/keys',{ANTHROPIC_API_KEY:'sk-ant-test123456789',
    UNSPLASH_ACCESS_KEY:'unsplash-key-abc',COUPANG_PARTNERS_ID:'myid',EVIL_KEY:'hack'});
  ck('허용된 키만 저장',r.saved.length===3&&!r.saved.includes('EVIL_KEY'),JSON.stringify(r.saved));
  ck('허용 안 된 키는 거부',r.rejected.includes('EVIL_KEY'),JSON.stringify(r.rejected));

  st=await req('GET','/api/keys/status');
  ck('저장 후 설정됨으로 표시',st.ANTHROPIC_API_KEY.set===true&&st.UNSPLASH_ACCESS_KEY.set===true);
  ck('키 값은 노출 안 함',!JSON.stringify(st).includes('sk-ant-test123456789'),JSON.stringify(st.ANTHROPIC_API_KEY));
  ck('힌트만 표시',/…/.test(st.ANTHROPIC_API_KEY.hint),st.ANTHROPIC_API_KEY.hint);

  console.log('\n[31] 저장한 키가 실제로 코드에서 읽히는지');
  ck('process.env에 반영',process.env.ANTHROPIC_API_KEY==='sk-ant-test123456789');
  ck('Unsplash 키도 반영',process.env.UNSPLASH_ACCESS_KEY==='unsplash-key-abc');

  console.log('\n[32] 재배포 후 브라우저 사본으로 복구되는 대상에 포함');
  const bk=await req('GET','/api/credentials/backup');
  ck('백업에 API 키 포함',bk.ANTHROPIC_API_KEY==='sk-ant-test123456789'&&bk.UNSPLASH_ACCESS_KEY==='unsplash-key-abc',JSON.stringify(Object.keys(bk)));

  try{fs.unlinkSync('./config/tokens.json')}catch(e){}
  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
},1500);
