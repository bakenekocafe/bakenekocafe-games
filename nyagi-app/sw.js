/**
 * NYAGI Service Worker (ES5 互換)
 *
 * 戦略:
 * - NYAGI の HTML/CSS/JS → Network First（オフライン時は503）
 * - /api/ops/* → Network First → 失敗時はエラーレスポンス（アプリ側で IndexedDB 保存）
 */

/** HTML/CSS/JS のキャッシュバストと合わせて更新すること */
var CACHE_NAME = 'nyagi-v283';

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

  event.respondWith(
    fetch(event.request, { cache: 'reload' }).catch(function () {
      return fetch(event.request, { cache: 'no-store' }).catch(function () {
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});
