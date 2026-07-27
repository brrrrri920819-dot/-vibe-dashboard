// https.get을 가로채 각 API의 실제 응답 형태를 주입 → 파싱/필터/폴백 검증
const https = require('https');
const { EventEmitter } = require('events');

let ROUTES = {};
https.get = function (url, opts, cb) {
  if (typeof opts === 'function') { cb = opts; }
  const key = Object.keys(ROUTES).find(k => String(url).includes(k));
  const req = new EventEmitter();
  req.setTimeout = () => {}; req.destroy = () => {};
  process.nextTick(() => {
    if (!key) { req.emit('error', new Error('unrouted: ' + url)); return; }
    const { status, body } = ROUTES[key];
    const res = new EventEmitter();
    res.statusCode = status;
    cb(res);
    res.emit('data', typeof body === 'string' ? body : JSON.stringify(body));
    res.emit('end');
  });
  return req;
};

const { fetchImage } = require('../content/generator.js');

// 실제 API 응답 형태 (문서 기준)
const UNSPLASH_OK = { status: 200, body: { results: [
  { urls: { regular: 'https://images.unsplash.com/photo-123?w=1080' }, user: { name: 'Jane Doe' } },
  { urls: { regular: 'https://images.unsplash.com/photo-456?w=1080' }, user: { name: 'Kim' } },
]}};
const OPENVERSE_MIXED = { status: 200, body: { result_count: 3, results: [
  { url: 'https://cdn.pixabay.com/photo/blocked.jpg', creator: 'X', license: 'cc0' },   // 핫링크 차단 → 걸러져야 함
  { url: 'https://live.staticflickr.com/65535/abc_b.jpg', creator: 'Flickr User', license: 'by' },
  { url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Ship.jpg', creator: 'W', license: 'by-sa' },
]}};
const WIKI_OK = { status: 200, body: { query: { pages: {
  '11': { title: 'File:Port.jpg', imageinfo: [{ thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Port.jpg/1200px-Port.jpg' }] },
}}}};
const EMPTY = { status: 200, body: { results: [] } };
const FAIL = { status: 500, body: 'boom' };

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
}

(async () => {
  console.log('\n[1] Unsplash 응답 파싱 (키 있음)');
  process.env.UNSPLASH_ACCESS_KEY = 'testkey';
  ROUTES = { 'api.unsplash.com': UNSPLASH_OK };
  let r = await fetchImage('container ship port', 0);
  check('URL을 urls.regular에서 뽑음', r.url === 'https://images.unsplash.com/photo-123?w=1080', r.url);
  check('source=Unsplash', r.source === 'Unsplash', r.source);
  check('촬영자 크레딧 표기', /Jane Doe/.test(r.credit), r.credit);
  r = await fetchImage('container ship port', 1);
  check('index로 다른 사진 선택(중복 방지)', r.url.includes('456'), r.url);

  console.log('\n[2] Unsplash 결과 없음 → Openverse로 폴백 + 핫링크 필터');
  ROUTES = { 'api.unsplash.com': EMPTY, 'api.openverse.org': OPENVERSE_MIXED };
  r = await fetchImage('container ship port', 0);
  check('핫링크 차단 호스트(pixabay) 제외됨', !r.url.includes('pixabay'), r.url);
  check('staticflickr 채택', r.url.includes('staticflickr.com'), r.url);
  check('source=Openverse', r.source === 'Openverse', r.source);

  console.log('\n[3] Unsplash·Openverse 실패 → Wikimedia 폴백');
  ROUTES = { 'api.unsplash.com': FAIL, 'api.openverse.org': FAIL, 'commons.wikimedia.org': WIKI_OK };
  r = await fetchImage('container ship port', 0);
  check('imageinfo[0].thumburl 파싱', r.url.includes('upload.wikimedia.org'), r.url);
  check('source=Wikimedia', r.source === 'Wikimedia', r.source);

  console.log('\n[4] 전부 실패 → picsum (사진은 나오되 주제 무관)');
  ROUTES = { 'api.unsplash.com': FAIL, 'api.openverse.org': FAIL, 'commons.wikimedia.org': FAIL };
  r = await fetchImage('container ship port', 0);
  check('picsum 폴백 동작', r.source === 'picsum' && r.url.includes('picsum.photos'), r.url);

  console.log('\n[5] 키 없을 때 Unsplash 건너뛰고 진행');
  delete process.env.UNSPLASH_ACCESS_KEY;
  ROUTES = { 'api.openverse.org': OPENVERSE_MIXED };
  r = await fetchImage('container ship port', 0);
  check('키 없어도 Openverse로 정상 동작', r.source === 'Openverse', r.source);

  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail ? 1 : 0);
})();
