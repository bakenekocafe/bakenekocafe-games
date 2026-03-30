/**
 * NYAGI 起動・遷移・読み込み用フルスクリーンオーバーレイ（ES5 互換）
 * 背景: img/nyagi-boot-splash.png
 *
 * window.NyagiBootOverlay.show('メッセージ')
 * window.NyagiBootOverlay.hide()
 * window.NyagiBootOverlay.hideForce()  // 参照カウント無視で閉じる
 */
(function () {
  'use strict';

  var OVERLAY_ID = 'nyagiBootOverlay';
  var IMG_PATH = 'img/nyagi-boot-splash.png';
  var SUB_LINES = [
    'LCL DENSITY: NOMINAL',
    'PAW_TRACKING: LIVE',
    'A.T. FIELD: ACTIVE',
    'MAGI: FELINE_SYSTEM 同期中',
    'SYNCH_RATE_NYAGI 測定中',
    'ENTRY-PLUG 接続確認',
  ];

  var _ref = 0;
  var _subTimer = null;
  var _subIdx = 0;

  function imgUrl() {
    try {
      var base = location.pathname.replace(/[^/]+$/, '');
      if (!base || base.slice(-1) !== '/') base += '/';
      return base + IMG_PATH;
    } catch (_) {
      return IMG_PATH;
    }
  }

  function ensureNode() {
    var el = document.getElementById(OVERLAY_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.className = 'nyagi-boot-overlay';
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('role', 'status');
    el.innerHTML =
      '<div class="nyagi-boot-bg"></div>' +
      '<div class="nyagi-boot-veil"></div>' +
      '<div class="nyagi-boot-panel">' +
        '<div class="nyagi-boot-caution">CAUTION: FELINE PILOT IN OPERATION</div>' +
        '<p class="nyagi-boot-title">システム起動中…</p>' +
        '<p class="nyagi-boot-sub"></p>' +
        '<div class="nyagi-boot-bar"><span class="nyagi-boot-bar-fill"></span></div>' +
      '</div>';
    document.body.appendChild(el);
    var bg = el.querySelector('.nyagi-boot-bg');
    if (bg) {
      try {
        bg.style.backgroundImage = 'url("' + imgUrl().replace(/"/g, '%22') + '")';
      } catch (_) {}
    }
    return el;
  }

  function startSubRotate() {
    if (_subTimer) return;
    var el = document.getElementById(OVERLAY_ID);
    var sub = el ? el.querySelector('.nyagi-boot-sub') : null;
    if (!sub) return;
    function tick() {
      sub.textContent = SUB_LINES[_subIdx % SUB_LINES.length];
      _subIdx++;
    }
    tick();
    _subTimer = setInterval(tick, 2200);
  }

  function stopSubRotate() {
    if (_subTimer) {
      clearInterval(_subTimer);
      _subTimer = null;
    }
  }

  function show(msg) {
    var el = ensureNode();
    var title = el.querySelector('.nyagi-boot-title');
    if (title && msg) title.textContent = msg;
    else if (title && !msg) title.textContent = 'システム起動中…';
    _ref++;
    el.classList.add('nyagi-boot-visible');
    el.setAttribute('aria-hidden', 'false');
    startSubRotate();
  }

  function hide() {
    if (_ref > 0) _ref--;
    if (_ref > 0) return;
    var el = document.getElementById(OVERLAY_ID);
    if (el) {
      el.classList.remove('nyagi-boot-visible');
      el.setAttribute('aria-hidden', 'true');
    }
    stopSubRotate();
  }

  function hideForce() {
    _ref = 0;
    stopSubRotate();
    var el = document.getElementById(OVERLAY_ID);
    if (el) {
      el.classList.remove('nyagi-boot-visible');
      el.setAttribute('aria-hidden', 'true');
    }
  }

  /** 同一オリジンの .html への遷移でスプラッシュ表示 */
  function bindNavClicks() {
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest('a[href]');
      if (!a) return;
      // 猫一覧「猫ごと」はカード全体を <a> で囲み、内部の button/checkbox 等は JS で preventDefault する。
      // 本リスナーは capture フェーズのため、その時点では defaultPrevented がまだ false。
      // ここで show すると遷移せず「次層展開中…」だけ残り続ける（ケア5項目ボタン等）。
      if (t.closest && t.closest('button, input, select, textarea, label')) return;
      if (e.defaultPrevented) return;
      if (a.getAttribute('target') === '_blank') return;
      if (a.getAttribute('download')) return;
      var href = a.getAttribute('href');
      if (!href || href.charAt(0) === '#') return;
      if (href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) return;
      var u;
      try {
        u = new URL(href, location.href);
      } catch (_) {
        return;
      }
      if (u.origin !== location.origin) return;
      var path = u.pathname || '';
      if (path.indexOf('.html') === -1) return;
      show('次層展開中…');
    }, true);
  }

  window.NyagiBootOverlay = {
    show: show,
    hide: hide,
    hideForce: hideForce,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindNavClicks);
  } else {
    bindNavClicks();
  }

  window.addEventListener('pageshow', function (ev) {
    hideForce();
  });
})();
