/**
 * NYAGI Service Worker (ES5 互換)
 *
 * 戦略:
 * - nyagi-app/ の HTML/CSS/JS → Cache First（オフラインでもアプリ起動可）
 * - /api/ops/* → Network First → 失敗時はエラーレスポンス（アプリ側で IndexedDB 保存）
 */

var CACHE_NAME = 'nyagi-v83';

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      var deletes = [];
      for (var i = 0; i < names.length; i++) {
        deletes.push(caches.delete(names[i]));
      }
      return Promise.all(deletes);
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);

  if (url.pathname.indexOf('/api/') === 0) {
    return;
  }

  if (url.pathname.indexOf('/nyagi-app/') === 0) {
    event.respondWith(
      fetch(event.request, { cache: 'no-store' }).catch(function () {
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      })
    );
    return;
  }
});
