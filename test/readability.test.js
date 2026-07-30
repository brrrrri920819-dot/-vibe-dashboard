const https=require('https');const {EventEmitter}=require('events');
https.get=function(url,opts,cb){if(typeof opts==='function')cb=opts;
  const r=new EventEmitter();r.setTimeout=()=>{};r.destroy=()=>{};
  process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
    res.emit('data',JSON.stringify({results:[{urls:{regular:'https://images.unsplash.com/a.jpg'},user:{name:'A'}}]}));res.emit('end');});
  return r;};
const orig=https.request;
const BODY='<p>출산휴가 급여 얼마나 나오는지 헷갈리시죠?</p><p>기준이 자주 바뀌어서 그래요.</p>'
+'<h2>지급 조건부터 볼게요</h2><p>고용보험 가입 <strong>180일</strong> 이상이면 됩니다.</p><p>여기서 많이들 놓쳐요.</p><p>추가 설명입니다.</p>'
+'[IMAGE:korean office]'
+'<h2>금액은 이렇게 나뉘어요</h2><table><thead><tr><th>구분</th><th>금액</th></tr></thead><tbody><tr><td>최초 60일</td><td>통상임금 100%</td></tr></tbody></table><p>표로 보면 쉬워요.</p>'
+'<h2>신청 방법</h2><ul><li>고용보험 홈페이지 접속</li><li>서류 제출</li></ul><p>순서대로 하시면 돼요.</p>'
+'<h2>자주 묻는 질문</h2><p>Q. 언제까지요?</p><p>A. 12개월 이내요.</p>'
+'<h2>정리하면</h2><p>'+'핵심 내용 요약입니다. '.repeat(150)+'</p>';
https.request=function(url,opts,cb){
  if(String(url).includes('api.anthropic.com')){
    const r=new EventEmitter();r.setTimeout=()=>{};r.destroy=()=>{};r.write=()=>{};
    r.end=()=>{process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;cb(res);
      res.emit('data',JSON.stringify({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({
        title:'2026 출산휴가 급여 얼마? 조건부터 금액까지',content:BODY,
        tags:['출산휴가','급여'],imageKeywords:['korean office']})}]}));res.emit('end');});};
    return r;}
  return orig.apply(this,arguments);};
const {generatePost}=require('../content/generator.js');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
(async()=>{
  process.env.ANTHROPIC_API_KEY='t';process.env.UNSPLASH_ACCESS_KEY='k';
  const post=await generatePost('출산휴가 급여',{topic:'생활정보'});
  const c=post.content;
  console.log('\n[26] 발행 HTML 가독성 서식');
  ck('문단에 줄간격 1.9 적용',/line-height:1\.9/.test(c));
  ck('문단 글자크기 17px',/font-size:17px/.test(c));
  ck('h2에 컬러바',/border-left:5px solid/.test(c));
  ck('표가 가로스크롤 래퍼로 감싸짐',/overflow-x:auto[\s\S]{0,120}<table/.test(c));
  ck('표 헤더 배경색',/background:#f1f5f9/.test(c));
  ck('td 테두리',/border:1px solid #dde3ea/.test(c));
  ck('목록 여백 적용',/<ul style="margin:0 0 22px/.test(c));
  ck('강조어 색상',/<strong style="color:#2563eb/.test(c));
  ck('목차 생성됨(h2 5개)',/이 글에서 다루는 내용/.test(c));
  ck('목차가 첫 문단 뒤에 위치',c.indexOf('헷갈리시죠')<c.indexOf('이 글에서 다루는 내용'));
  ck('한글 줄바꿈 keep-all',/word-break:keep-all/.test(c));
  ck('전체 래퍼 폰트 지정',/Apple SD Gothic Neo/.test(c));
  ck('이미지 그대로 유지',/<img src="https:\/\/images\.unsplash\.com/.test(c));
  ck('스타일 중복 안 됨',!/style="[^"]*style=/.test(c));
  require('fs').writeFileSync('/tmp/claude-0/-home-user--vibe-dashboard/362b0628-a871-5bbc-9594-f951968e506c/scratchpad/preview.html',
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;padding:20px;background:#fff">'+c+'</body>');
  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
})();
