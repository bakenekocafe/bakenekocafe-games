/**
 * 広告設定の遅延取得
 * GET /api/ads-config?game=xxx を呼び、BakenekoCore.adsConfig に格納。
 * 初期表示時には呼ばず、リワード表示前などに呼ぶ。
 * API_BASE は末尾スラッシュなしに正規化して使用。
 */
(function () {
  'use strict';

  function normalizeApiBase(val) {
    if (typeof val !== 'string') return '';
    var s = val.trim();
    if (!s) return '';
    try {
      var u = new URL(s);
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
      return u.origin + u.pathname;
    } catch (_) {
      return s.replace(/\/+$/, '');
    }
  }

  var API_BASE = normalizeApiBase(typeof window.BAKENEKO_API_BASE !== 'undefined' ? window.BAKENEKO_API_BASE : '');
  var gameId = typeof window.BAKENEKO_GAME_ID !== 'undefined' ? String(window.BAKENEKO_GAME_ID).trim() : '';

  var adsConfig = { banner: 'off', rewarded: 'off', placements: {} };

  function load() {
    if (!API_BASE || !gameId) return Promise.resolve(adsConfig);
    var url = API_BASE + '/api/ads-config?game=' + encodeURIComponent(gameId);
    return fetch(url)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          adsConfig.banner = data.banner || 'off';
          adsConfig.rewarded = data.rewarded || 'off';
          adsConfig.placements = data.placements || {};
        }
        return adsConfig;
      })
      .catch(function () { return adsConfig; });
  }

  window.BakenekoCore = window.BakenekoCore || {};
  window.BakenekoCore.adsConfig = adsConfig;
  window.BakenekoCore.getAdsConfig = load;
})();
