/**
 * NYAGI Service Worker (ES5 互換)
 *
 * 戦略:
 * - nyagi-app/ の HTML/CSS/JS → Cache First（オフラインでもアプリ起動可）
 * - /api/ops/* → Network First → 失敗時はエラーレスポンス（アプリ側で IndexedDB 保存）
 */

var CACHE_NAME = 'nyagi-v70';
var APP_SHELL = [
  '/nyagi-app/',
  '/nyagi-app/index.html',
  '/nyagi-app/dashboard.html',
  '/nyagi-app/cats.html',
  '/nyagi-app/tasks.html',
  '/nyagi-app/cat.html',
  '/nyagi-app/foods.html',
  '/nyagi-app/style.css',
  '/nyagi-app/voice-console.css',
  '/nyagi-app/config.js',
  '/nyagi-app/js/app.js',
  '/nyagi-app/js/voice-console.js',
  '/nyagi-app/js/dashboard.js',
  '/nyagi-app/js/tasks.js',
  '/nyagi-app/js/cats-overview.js',
  '/nyagi-app/js/cat-detail.js',
  '/nyagi-app/js/foods.js',
  '/nyagi-app/manifest.json',
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(APP_SHELL);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (names) {
      var deletes = [];
      for (var i = 0; i < names.length; i++) {
        if (names[i] !== CACHE_NAME) {
          deletes.push(caches.delete(names[i]));
        }
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
    if (url.origin === self.location.origin) {
      event.respondWith(networkFirst(event.request));
    }
    return;
  }

  if (url.pathname.indexOf('/nyagi-app/') === 0) {
    event.respondWith(networkFirst(event.request));
    return;
  }
});

function cacheFirst(request) {
  return caches.match(request).then(function (cached) {
    if (cached) return cached;

    return fetch(request).then(function (response) {
      if (response.ok) {
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(request, clone);
        });
      }
      return response;
    }).catch(function () {
      return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
    });
  });
}

function networkFirst(request) {
  return fetch(request).then(function (response) {
    return response;
  }).catch(function () {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'Network unavailable' }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  });
}
