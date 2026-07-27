const fs=require('fs');const path=require('path');const {execFileSync}=require('child_process');
const ROOT=path.join(__dirname,'..');
const VOL='/tmp/claude-0/-home-user--vibe-dashboard/362b0628-a871-5bbc-9594-f951968e506c/scratchpad/fakevol';
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};

function run(code, env){
  return execFileSync(process.execPath,['-e',code],{cwd:ROOT,encoding:'utf8',
    env:{...process.env,...env,BLOGGER_REFRESH_TOKEN:'',BLOGGER_CLIENT_ID:''}});
}
fs.rmSync(VOL,{recursive:true,force:true});
try{fs.unlinkSync(path.join(ROOT,'config/tokens.json'))}catch(e){}

console.log('\n[20] 볼륨 없을 때: 재배포(앱 폴더 초기화)로 토큰 소실');
run("const t=require('./config/token-store');t.set('BLOGGER_REFRESH_TOKEN','tok-A');",{});
try{fs.unlinkSync(path.join(ROOT,'config/tokens.json'))}catch(e){}  // 재배포 = 앱 폴더 새로 만들어짐
let out=run("const t=require('./config/token-store');console.log(JSON.stringify(t.get('BLOGGER_REFRESH_TOKEN')));",{});
ck('볼륨 없으면 토큰 사라짐(문제 재현)',out.trim().endsWith('null'),out.trim());

console.log('\n[21] 볼륨 붙였을 때: 재배포해도 토큰 유지');
run("const t=require('./config/token-store');t.set('BLOGGER_REFRESH_TOKEN','tok-B');",{RAILWAY_VOLUME_MOUNT_PATH:VOL});
try{fs.unlinkSync(path.join(ROOT,'config/tokens.json'))}catch(e){}  // 재배포 재현
out=run("const t=require('./config/token-store');console.log(JSON.stringify(t.get('BLOGGER_REFRESH_TOKEN')));",{RAILWAY_VOLUME_MOUNT_PATH:VOL});
ck('볼륨에서 토큰 복원됨',out.includes('tok-B'),out.trim());
ck('볼륨 파일 실제 생성',fs.existsSync(path.join(VOL,'tokens.json')));

console.log('\n[22] 저장소 상태 보고');
out=run("const t=require('./config/token-store');console.log(JSON.stringify(t.storageInfo()));",{RAILWAY_VOLUME_MOUNT_PATH:VOL});
const info=JSON.parse(out.trim().split('\n').pop());
ck('영구 저장 켜짐으로 보고',info.persistent===true,JSON.stringify(info));
out=run("const t=require('./config/token-store');console.log(JSON.stringify(t.storageInfo()));",{});
const info2=JSON.parse(out.trim().split('\n').pop());
ck('볼륨 없으면 꺼짐으로 보고',info2.persistent===false,JSON.stringify(info2));

fs.rmSync(VOL,{recursive:true,force:true});
try{fs.unlinkSync(path.join(ROOT,'config/tokens.json'))}catch(e){}
console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
process.exit(ng?1:0);
