const https=require('https');const {EventEmitter}=require('events');
https.get=function(url,opts,cb){if(typeof opts==='function')cb=opts;
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
  process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',JSON.stringify({results:[{urls:{regular:'https://images.unsplash.com/a.jpg'},user:{name:'A'}}]}));res.emit('end');});
  return req;};
let CALL=0;const origReq=https.request;
https.request=function(url,opts,cb){
  if(String(url).includes('api.anthropic.com')){
    CALL++;const n=CALL;
    const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.write=()=>{};
    req.end=()=>{process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
      // 1번째: 짧은 글(미달) → 2번째: 충분한 글
      const content = n===1
        ? '<h2>짧음</h2><p>너무 짧은 글입니다.</p>'
        : '<h2>충분</h2><p>'+'충분한 분량의 본문입니다. '.repeat(220)+'</p>';
      res.emit('data',JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({
        title:'테스트 제목',content,tags:['a'],imageKeywords:['office']})}]}));
      res.emit('end');});};
    return req;}
  return origReq.apply(this,arguments);};
const {generatePost}=require('../content/generator.js');
let pass=0,fail=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),pass++):(console.log('  ❌ '+n+' '+e),fail++)};
(async()=>{
  process.env.ANTHROPIC_API_KEY='t';process.env.UNSPLASH_ACCESS_KEY='k';
  console.log('\n[15] 분량 미달 시 자동 재생성');
  const post=await generatePost('테스트',{topic:'생활'});
  const len=post.content.replace(/<[^>]+>/g,'').replace(/\s/g,'').length;
  ck('Claude를 2회 이상 호출(재생성 발생)',CALL>=2,'호출 '+CALL+'회');
  ck('최종 결과가 2000자 이상',len>=2000,len+'자');
  ck('짧은 초안이 채택되지 않음',!/너무 짧은 글/.test(post.content));
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail?1:0);
})();
