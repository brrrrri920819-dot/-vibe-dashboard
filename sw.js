/**
 * sw.js — 홈화면 앱용 서비스워커
 *
 * 원칙: 화면은 항상 최신이어야 한다.
 *  - 화면(HTML)·아이콘: 네트워크 우선, 실패하면 캐시 (지하철·엘리베이터에서도 열린다)
 *  - API 응답: 절대 캐시하지 않는다. 오래된 발행 상태를 보여주면 안 된다.
 * 배포할 때마다 CACHE 이름을 바꾸지 않아도, 네트워크 우선이라 새 화면이 바로 반영된다.
 */

const CACHE = 'riri-shell-v1';
const SHELL = ['/', '/icons/icon-180.png', '/icons/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 다른 도메인·API·비 GET 요청은 그대로 통과 (캐시 금지)
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/')) return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        // 정상 응답만 사본으로 보관
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('/')))
  );
});
