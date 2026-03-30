/**
 * NYAGI 共通: style.css で html が縦スクロールルート。
 * 一覧・詳細の innerHTML 再描画後に位置を戻す。
 */
(function (w) {
  'use strict';

  function scrollRoot() {
    return document.scrollingElement || document.documentElement;
  }

  w.NyagiScrollRestore = {
    capture: function () {
      try {
        return scrollRoot().scrollTop;
      } catch (_) {
        return 0;
      }
    },

    /**
     * @param {number} y
     */
    restore: function (y) {
      if (typeof y !== 'number' || isNaN(y) || y < 0) return;
      function apply() {
        try {
          scrollRoot().scrollTop = y;
        } catch (_) {}
      }
      if (typeof w.requestAnimationFrame !== 'function') {
        apply();
        return;
      }
      w.requestAnimationFrame(function () {
        w.requestAnimationFrame(apply);
      });
    },
  };
})(window);
