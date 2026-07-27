const https = require('https');
const { EventEmitter } = require('events');
let ROUTES = {};
https.get = function (url, opts, cb) {
  if (typeof opts === 'function') cb = opts;
  const key = Object.keys(ROUTES).find(k => String(url).includes(k));
  const req = new EventEmitter(); req.setTimeout = () => {}; req.destroy = () => {};
  process.nextTick(() => {
    if (!key) { req.emit('error', new Error('unrouted')); return; }
    const res = new EventEmitter(); res.statusCode = ROUTES[key].status; cb(res);
    res.emit('data', JSON.stringify(ROUTES[key].body)); res.emit('end');
  });
  return req;
};
// Claude 호출도 가로채기 (https.request)
const origReq = https.request;
https.request = function (url, opts, cb) {
  if (String(url).includes('api.anthropic.com')) {
    const req = new EventEmitter();
    req.setTimeout = () => {}; req.destroy = () => {}; req.write = () => {}; req.end = () => {
      process.nextTick(() => {
        const res = new EventEmitter(); res.statusCode = 200; cb(res);
        res.emit('data', JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({
          title: '컨테이너 운임 급등, 지금 사야 할까요?',
          content: '<p>요즘 운임 얘기 많죠?</p>[IMAGE:container ship port]<h3>왜 오를까</h3><p>이유는요.</p>[IMAGE:cargo crane sunset]<h3>정리</h3><p>끝!</p>',
          tags: ['운임','물류','해운','수출','관세','무역','경제','투자'],
          imageKeywords: ['container ship port','cargo crane sunset'],
        })}]}));
        res.emit('end');
      });
    };
    req.on = EventEmitter.prototype.on.bind(req);
    return req;
  }
  return origReq.apply(this, arguments);
};

const { generatePost } = require('../content/generator.js');
let pass = 0, fail = 0;
const check = (n, c, e = '') => { c ? (console.log('  ✅ ' + n), pass++) : (console.log('  ❌ ' + n + ' ' + e), fail++); };

(async () => {
  console.log('\n[6] 호스트 위장 방어 (핫링크 화이트리스트)');
  process.env.UNSPLASH_ACCESS_KEY = 'k';
  const spoof = { status: 200, body: { results: [
    { url: 'https://images.unsplash.com.attacker.net/a.jpg', creator: 'x', license: 'cc0' },
    { url: 'https://notstaticflickr.com/b.jpg', creator: 'y', license: 'cc0' },
    { url: 'https://upload.wikimedia.org/wikipedia/commons/ok.jpg', creator: 'z', license: 'cc0' },
  ]}};
  const { fetchImage } = require('../content/generator.js');
  ROUTES = { 'api.unsplash.com': { status: 200, body: { results: [] } }, 'api.openverse.org': spoof };
  const r = await fetchImage('x', 0);
  check('접미사 위장 도메인 거부', !r.url.includes('attacker.net'), r.url);
  check('유사 도메인(notstaticflickr) 거부', !r.url.includes('notstaticflickr'), r.url);
  check('정상 wikimedia만 통과', r.url.includes('upload.wikimedia.org'), r.url);

  console.log('\n[7] 글 본문 이미지 삽입 (end-to-end)');
  process.env.ANTHROPIC_API_KEY = 'test';
  ROUTES = { 'api.unsplash.com': { status: 200, body: { results: [
    { urls: { regular: 'https://images.unsplash.com/ship.jpg' }, user: { name: 'A' } },
    { urls: { regular: 'https://images.unsplash.com/crane.jpg' }, user: { name: 'B' } },
  ]}}};
  const post = await generatePost('컨테이너 운임', { topic: '경제', tone: '친근한', platform: 'blogger' });
  check('플레이스홀더가 남아있지 않음', !/\[IMAGE:/.test(post.content), post.content.slice(0, 80));
  const imgs = [...post.content.matchAll(/<img src="([^"]+)"/g)].map(m => m[1]);
  check('이미지 2개 삽입됨', imgs.length === 2, JSON.stringify(imgs));
  check('두 이미지가 서로 다름(중복 없음)', imgs[0] !== imgs[1], JSON.stringify(imgs));
  check('모두 핫링크 허용 호스트', imgs.every(u => u.includes('images.unsplash.com')), JSON.stringify(imgs));
  check('캡션에 출처 표기', /Photo by A on Unsplash/.test(post.content));
  check('제목·태그 정상', !!post.title && post.tags.length === 8, post.title);

  console.log(`\n결과: ${pass}개 통과, ${fail}개 실패\n`);
  process.exit(fail ? 1 : 0);
})();
