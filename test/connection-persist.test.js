// 재배포를 반복해도 연결이 유지되는지 (요청: 수정할 때마다 끊기지 않게)
const {execFileSync}=require('child_process');
const fs=require('fs');const path=require('path');
const ROOT=path.join(__dirname,'..');
const VOL='/tmp/claude-0/-home-user--vibe-dashboard/362b0628-a871-5bbc-9594-f951968e506c/scratchpad/persistvol';
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
function run(code,env){return execFileSync(process.execPath,['-e',code],{cwd:ROOT,encoding:'utf8',
  env:{...process.env,...env,BLOGGER_REFRESH_TOKEN:'',BLOGGER_CLIENT_ID:'',BLOGGER_CLIENT_SECRET:''}});}
function redeploy(){ try{fs.unlinkSync(path.join(ROOT,'config/tokens.json'))}catch(e){} }  // 앱 폴더 초기화

fs.rmSync(VOL,{recursive:true,force:true});
redeploy();

console.log('\n[41] 볼륨 저장소에 연결 정보 보관');
run("require('./config/token-store').set('BLOGGER_REFRESH_TOKEN','1//real-token');",{RAILWAY_VOLUME_MOUNT_PATH:VOL});
ck('볼륨 파일 생성됨', fs.existsSync(path.join(VOL,'tokens.json')));

console.log('\n[42] 재배포 5번 반복해도 연결 유지');
let survived=0;
for(let i=1;i<=5;i++){
  redeploy();
  const out=run("const t=require('./config/token-store');console.log('TOK:'+t.get('BLOGGER_REFRESH_TOKEN'));",{RAILWAY_VOLUME_MOUNT_PATH:VOL});
  if(out.includes('TOK:1//real-token')) survived++;
}
ck('5회 재배포 후에도 토큰 유지', survived===5, survived+'/5회 유지');

console.log('\n[43] 볼륨 없으면 상태를 정확히 보고');
redeploy();
const t0=Date.now();
const out=run("const t=require('./config/token-store');console.log(JSON.stringify(t.storageInfo()));",{PERSIST_DIR:'/proc/nonexistent-readonly'});
const elapsed=Date.now()-t0;
const info=JSON.parse(out.trim().split('\n').pop());
ck('특수 경로를 영구저장으로 잡지 않음', info.volumePath!=='/proc/nonexistent-readonly', JSON.stringify(info));
ck('특수 경로에서도 즉시 기동(멈추지 않음)', elapsed<5000, elapsed+'ms');

console.log('\n[44] 디스크가 전부 막혀도 저장·조회는 동작');
const r=run(`
const fs=require('fs');const ow=fs.writeFileSync;
fs.writeFileSync=()=>{throw new Error('EROFS')};
const t=require('./config/token-store');
const okSet=t.set('BLOGGER_REFRESH_TOKEN','mem-only');
console.log('RESULT:'+okSet+':'+t.get('BLOGGER_REFRESH_TOKEN'));
`,{});
ck('쓰기 실패해도 메모리로 유지', r.includes('RESULT:true:mem-only'), r.trim().split('\n').pop());

fs.rmSync(VOL,{recursive:true,force:true});
redeploy();
console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
process.exit(ng?1:0);
