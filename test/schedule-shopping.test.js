// 예약 발행 블로그 선택 · 쇼핑커넥트 상품 추천
const {execFileSync}=require('child_process');
const fs=require('fs');const path=require('path');
let ok=0,ng=0;const ck=(n,c,e='')=>{c?(console.log('  ✅ '+n),ok++):(console.log('  ❌ '+n+' '+e),ng++)};
const html=fs.readFileSync(path.join(__dirname,'..','blog.html'),'utf8');

console.log('\n[45] 예약 발행에서 블로그 선택');
ck('미리보기에 블로그 체크박스 3개', /id="gen-p-blogger"/.test(html)&&/id="gen-p-tistory"/.test(html)&&/id="gen-p-naver"/.test(html));
ck('예약 날짜·시간 입력 존재', /id="gen-schedule-date"/.test(html)&&/id="gen-schedule-time"/.test(html));
ck('선택한 블로그를 예약에 사용', /genSelectedPlatforms\(\)/.test(html));
ck('단일 select 제거됨', !/gen-platform-select/.test(html));
ck('예약 시각이 과거면 거부', /예약 시각은 현재보다 뒤여야/.test(html));
ck('연결 안 된 블로그는 비활성', /cb\.disabled = !on/.test(html));

console.log('\n[46] 미리보기 가독성');
ck('제목 크기 상향(21px)', /\.gen-preview-title\{[^}]*font-size:21px/.test(html));
ck('본문 흰 배경·본문색', /\.gen-preview-content\{[^}]*background:#fff/.test(html));
ck('사진 비율 유지·높이 제한', /\.gen-preview-content img\{[^}]*object-fit:cover[^}]*\}/.test(html)&&/max-height:220px/.test(html));
ck('표·소제목 미리보기 서식', /\.gen-preview-content h2\{/.test(html)&&/\.gen-preview-content table\{/.test(html));
ck('한글 줄바꿈 처리', /\.gen-preview-title\{[^}]*word-break:keep-all/.test(html));

console.log('\n[47] 쇼핑커넥트 추천 모듈');
const {recommendProducts,productBlock,pickQuery,CATEGORY_RATE}=require('../affiliates/shopping-connect');
const q1=pickQuery('겨울 캠핑 준비물 정리');
ck('주제에서 검색어 도출', q1.category==='스포츠/레저', JSON.stringify(q1));
const q2=pickQuery('신생아 기저귀 고르는 법');
ck('육아 주제 인식', q2.category==='출산/육아', JSON.stringify(q2));
ck('카테고리별 수수료표 존재', CATEGORY_RATE['패션의류'].min===10);

(async()=>{
  const rec=await recommendProducts('다이어트 식단', 3);
  ck('키 없으면 이유를 알려줌', rec.ok===false&&/NAVER_CLIENT_ID/.test(rec.reason||''), JSON.stringify(rec).slice(0,120));

  // 상품이 있을 때 HTML 생성
  const fake={ok:true,query:'다이어트 보조제',category:'생활/건강',products:[
    {title:'테스트 상품',link:'https://shopping.naver.com/x',image:'https://img/x.jpg',price:39000,commissionRate:'5~10%',expectedFee:2925}]};
  const blockHtml=productBlock(fake);
  ck('상품 블록 생성', /이 글과 어울리는 상품/.test(blockHtml));
  ck('제휴 링크 rel 속성', /rel="sponsored nofollow noopener"/.test(blockHtml));
  ck('가격 표기', /39,000원/.test(blockHtml));
  ck('상품 없으면 빈 문자열', productBlock({ok:false,products:[]})==='');

  console.log('\n[48] 대시보드 상품 추천 화면');
  ck('상품 찾기 입력·버튼', /id="sc-query"/.test(html)&&/loadShoppingRecommend\(\)/.test(html));
  ck('링크 복사 기능', /function scCopyLink/.test(html));
  ck('기대 수익 표시', /건당 약/.test(html));

  console.log('\n결과: '+ok+'개 통과, '+ng+'개 실패\n');
  process.exit(ng?1:0);
})();
