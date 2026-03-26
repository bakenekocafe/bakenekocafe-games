/**
 * NYAGI 共通ヘッダー（.app-sticky-top）を viewport 上端に固定し、
 * body の padding-top で本文が隠れないようにする（sticky が効かない環境向け）
 */
(function () {
  'use strict';

  var VAR_NAME = '--app-header-offset';

  function measureAndApply() {
    var bar = document.querySelector('.app-sticky-top');
    if (!bar) return;
    var h = bar.getBoundingClientRect().height;
    var px = Math.max(56, Math.ceil(h));
    document.documentElement.style.setProperty(VAR_NAME, px + 'px');
  }

  function syncMaxWidthFromBody() {
    var bar = document.querySelector('.app-sticky-top');
    if (!bar) return;
    try {
      var cs = window.getComputedStyle(document.body);
      var mx = cs.maxWidth;
      if (mx && mx !== 'none' && mx !== '0px') {
        bar.style.maxWidth = mx;
      }
    } catch (_) {}
  }

  function init() {
    var bar = document.querySelector('.app-sticky-top');
    if (!bar) return;
    syncMaxWidthFromBody();
    measureAndApply();
    if (typeof ResizeObserver !== 'undefined') {
      var ro = new ResizeObserver(function () {
        measureAndApply();
      });
      ro.observe(bar);
    } else {
      window.addEventListener('resize', measureAndApply);
    }
    window.addEventListener('orientationchange', function () {
      setTimeout(measureAndApply, 200);
    });
  }

  window.NyagiFixedHeader = {
    update: function () {
      syncMaxWidthFromBody();
      measureAndApply();
    },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
