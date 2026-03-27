/**
 * NYAGI 共通: ヘッダーにキャッシュクリア（SW 解除 + Cache API 削除 → リロード）
 * ダッシュボード下部の forceClearBtn とも共用（window.forceClearCache）
 */
(function () {
  'use strict';

  function forceClearCache(btn) {
    var b = btn || document.getElementById('forceClearBtn') || document.getElementById('nyagiHeaderCacheClear');
    if (!b) return;
    b.textContent = 'クリア中...';
    b.disabled = true;
    var p1 = navigator.serviceWorker
      ? navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister(); }));
        })
      : Promise.resolve();
    var p2 =
      typeof caches !== 'undefined' && caches.keys
        ? caches.keys().then(function (names) {
            return Promise.all(names.map(function (n) { return caches.delete(n); }));
          })
        : Promise.resolve();
    Promise.all([p1, p2])
      .then(function () {
        b.textContent = '✅ クリア完了 — リロードします';
        setTimeout(function () { location.reload(true); }, 800);
      })
      .catch(function () {
        b.textContent = 'エラー — 手動でリロードしてください';
        b.disabled = false;
      });
  }

  window.forceClearCache = forceClearCache;

  function insertHeaderButton() {
    if (document.getElementById('nyagiHeaderCacheClear')) return;
    var nav = document.querySelector('.app-sticky-top .header nav.header-nav');
    if (!nav) return;
    var hdr = nav.parentElement;
    if (!hdr || !hdr.classList || !hdr.classList.contains('header')) return;
    if (hdr.querySelector('.nyagi-header-cache-clear-btn')) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'nyagiHeaderCacheClear';
    btn.className = 'nyagi-header-cache-clear-btn';
    btn.textContent = '🔄 表示がおかしい場合：キャッシュクリア';
    btn.addEventListener('click', function () { forceClearCache(btn); });
    hdr.insertBefore(btn, nav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', insertHeaderButton);
  } else {
    insertHeaderButton();
  }
})();
