// 배포 설정이 앱을 죽은 채 방치하지 않는지
const fs=require('fs');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
const toml=fs.readFileSync(__dirname+'/../railway.toml','utf8');
const pkg=JSON.parse(fs.readFileSync(__dirname+'/../package.json','utf8'));
const dock=fs.readFileSync(__dirname+'/../Dockerfile','utf8');
const srv=fs.readFileSync(__dirname+'/../server.js','utf8');

console.log('\n[33] 재시작 정책');
ck('재시도 횟수 제한 없음(3회 제한이면 죽은 채 방치됨)', !/restartPolicyMaxRetries/.test(toml));
ck('항상 재시작', /restartPolicyType\s*=\s*"always"/.test(toml), toml.match(/restartPolicyType.*/)||'');

console.log('\n[34] 헬스체크');
ck('healthcheckPath 지정', /healthcheckPath\s*=\s*"\/api\/health"/.test(toml));
ck('서버에 /api/health 라우트 존재', /app\.get\('\/api\/health'/.test(srv));
ck('헬스체크가 다른 라우트보다 앞', srv.indexOf("app.get('/api/health'") < srv.indexOf("app.get('/api/status'"));

console.log('\n[35] 빌드 안정성');
ck('postinstall 브라우저 다운로드 제거', !pkg.scripts.postinstall);
ck('Dockerfile이 chromium 설치', /apt-get install[\s\S]{0,80}chromium/.test(dock));
ck('브라우저 경로 환경변수 지정', /PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH/.test(dock));
ck('start 스크립트 존재', pkg.scripts.start==='node server.js');

console.log('\n[36] 크래시 내성');
ck('unhandledRejection 처리', /process\.on\('unhandledRejection'/.test(srv));
ck('uncaughtException 처리', /process\.on\('uncaughtException'/.test(srv));
ck('예외 시 프로세스를 죽이지 않음', !/uncaughtException[\s\S]{0,300}process\.exit/.test(srv));

console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
process.exit(ng?1:0);
