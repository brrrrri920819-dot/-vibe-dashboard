const https=require('https');const {EventEmitter}=require('events');
let CALLS=[];let RESP={};
https.get=function(url,opts,cb){if(typeof opts==='function')cb=opts;
  CALLS.push(String(url));
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
  process.nextTick(()=>{
    const m=decodeURIComponent(String(url)).match(/query=([^&]+)/);
    const term=m?m[1]:'';
    const body=RESP[term]!==undefined?RESP[term]:{results:[]};
    const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',JSON.stringify(body));res.emit('end');
  });return req;};
const {fetchImage}=require('../content/generator.js');
let pass=0,fail=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),pass++):(console.log('  ❌ '+n+' '+e),fail++)};
(async()=>{
  process.env.UNSPLASH_ACCESS_KEY='k';
  console.log('\n[8] 긴 키워드 0건 → 자동 완화해서 Unsplash 유지');
  // 전체 문구는 0건, 앞 2단어는 결과 있음
  RESP={'korean street food market night':{results:[]},
        'korean street':{results:[{urls:{regular:'https://images.unsplash.com/street.jpg'},user:{name:'A'}}]}};
  CALLS=[];
  let r=await fetchImage('korean street food market night',0);
  ck('완화 후 Unsplash에서 찾음',r.source==='Unsplash',r.source);
  ck('품질 낮은 소스로 안 떨어짐',!/picsum|Wikimedia/.test(r.source),r.source);
  ck('여러 번 시도함',CALLS.length>=2,'calls='+CALLS.length);

  console.log('\n[9] 마지막 단어로도 재시도');
  RESP={'container ship port terminal':{results:[]},'container ship':{results:[]},
        'terminal':{results:[{urls:{regular:'https://images.unsplash.com/t.jpg'},user:{name:'B'}}]}};
  r=await fetchImage('container ship port terminal',0);
  ck('핵심 명사로 찾아냄',r.url.includes('t.jpg'),r.url);

  console.log('\n[10] 진짜 없으면 그때만 폴백');
  RESP={};
  r=await fetchImage('zzzz nonsense qqqq',0);
  ck('전부 0건이면 폴백 동작',r.source!=='Unsplash',r.source);
  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail?1:0);
})();
