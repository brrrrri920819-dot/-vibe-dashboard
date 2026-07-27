const https=require('https');const {EventEmitter}=require('events');
let ROUTES={};
https.get=function(url,opts,cb){if(typeof opts==='function')cb=opts;
  const k=Object.keys(ROUTES).find(x=>String(url).includes(x));
  const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};
  process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',JSON.stringify(k?ROUTES[k]:{results:[]}));res.emit('end');});
  return req;};
let ARTICLE=null;
const origReq=https.request;
https.request=function(url,opts,cb){
  if(String(url).includes('api.anthropic.com')){
    const req=new EventEmitter();req.setTimeout=()=>{};req.destroy=()=>{};req.write=()=>{};
    req.end=()=>{process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
      res.emit('data',JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(ARTICLE)}]}));
      res.emit('end');});};
    return req;}
  return origReq.apply(this,arguments);};

const {generatePost}=require('../content/generator.js');
const {humanizeHtml,humanizeTitle,variantForPlatform}=require('../humanizer.js');
const {buildAdsensePages}=require('../content/adsense-pages.js');
let pass=0,fail=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),pass++):(console.log('  ❌ '+n+' '+e),fail++)};

const body='<p>도입 문단입니다. 상황을 짚습니다.</p><p>두번째 문단.</p>'
 +'<h2>첫 소제목</h2><p>구체 정보 2025년 기준 30만원입니다.</p>[IMAGE:korean office]'
 +'<h2>비교</h2><table><thead><tr><th>구분</th><th>금액</th></tr></thead><tbody><tr><td>A</td><td>10만원</td></tr></tbody></table>'
 +'<h2>자주 묻는 질문</h2><p>Q. 언제까지인가요?</p><p>A. 12월까지입니다.</p>'
 +'<p>'+'상세한 설명을 채웁니다. '.repeat(200)+'</p>';

(async()=>{
  process.env.ANTHROPIC_API_KEY='t';process.env.UNSPLASH_ACCESS_KEY='k';
  ROUTES={'api.unsplash.com':{results:[{urls:{regular:'https://images.unsplash.com/a.jpg'},user:{name:'A'}}]}};

  console.log('\n[11] 애드센스 기준 충족 여부');
  ARTICLE={title:'출산휴가 급여 신청 조건과 금액 정리',content:body,
    tags:['출산휴가','급여','신청','조건','금액','2026','정부지원','육아'],
    imageKeywords:['korean office','documents desk']};
  const post=await generatePost('출산휴가 급여',{topic:'생활정보'});
  const plain=post.content.replace(/<[^>]+>/g,'').replace(/\s/g,'');
  ck('본문 2000자 이상',plain.length>=2000,plain.length+'자');
  ck('h2 소제목 있음',/<h2/.test(post.content));
  ck('비교표 있음',/<table/.test(post.content));
  ck('FAQ 섹션 있음',/자주 묻는 질문/.test(post.content));
  ck('이미지 삽입됨',/<img src="https:\/\/images\.unsplash\.com/.test(post.content));

  console.log('\n[12] 가짜 후기 주입이 사라졌는지');
  const h=humanizeHtml('<p>안내드립니다.</p><p>'+'내용 '.repeat(80)+'</p>');
  ck('본문에 가짜 경험담 안 붙음',!/직접 써봤|친구한테 물어보니/.test(h));
  const titles=Array.from({length:30},()=>humanizeTitle('출산휴가 급여 신청 조건'));
  ck('제목에 찐후기/직접해봤 안 붙음',titles.every(t=>!/찐후기|직접 해봤|솔직 후기/.test(t)));
  ck('제목 내용 보존',titles.every(t=>t==='출산휴가 급여 신청 조건'),titles[0]);

  console.log('\n[13] 플랫폼 변형이 문장을 깨뜨리지 않는지');
  const src='<p>이 블로그를 운영하며 느낀 점입니다.</p>';
  ck('네이버 변형 시 문장 보존',variantForPlatform(src,'naver')===src,variantForPlatform(src,'naver'));

  console.log('\n[14] 애드센스 필수 페이지 3종');
  const pages=buildAdsensePages({blogName:'테스트블로그',topic:'생활정보',ownerName:'운영자',contactEmail:'a@b.com',siteUrl:'https://x.com'});
  ck('3개 생성',pages.length===3,String(pages.length));
  ck('소개/개인정보/문의 모두 포함',['블로그 소개','개인정보처리방침','문의하기'].every(t=>pages.some(p=>p.title===t)),pages.map(p=>p.title).join(','));
  const pp=pages.find(p=>p.title==='개인정보처리방침').content;
  ck('개인정보처리방침에 쿠키·구글광고 고지',/쿠키/.test(pp)&&/policies\.google\.com/.test(pp));
  ck('연락처 반영',pp.includes('a@b.com'));
  let threw=false;try{buildAdsensePages({})}catch(e){threw=true}
  ck('이메일 없으면 거부',threw);

  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail?1:0);
})();
