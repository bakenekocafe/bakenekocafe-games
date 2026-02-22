/**
 * リワード広告 抽象アダプタ
 * - ゲームは showRewarded() のみ呼ぶ。広告ネットワークの差はここで吸収。
 * - 設定は動的 API から取得。初期表示時は SDK をロードしない。
 * - 視聴完了 → サーバー検証(verify) → リワード付与。クライアントの「完了報告」だけで付与しない。
 * - API_BASE は末尾スラッシュなしで正規化して使用。
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
    } catch (_) { return s.replace(/\/+$/, ''); }
  }

  var API_BASE = normalizeApiBase(typeof window.BAKENEKO_API_BASE !== 'undefined' ? window.BAKENEKO_API_BASE : '');
  var gameId = typeof window.BAKENEKO_GAME_ID !== 'undefined' ? String(window.BAKENEKO_GAME_ID).trim() : '';

  var config = { type: 'none', rewarded: 'off' };
  var sdkLoaded = false;

  function loadConfig() {
    if (!API_BASE || !gameId) return Promise.resolve();
    return fetch(API_BASE + '/api/ads-config?game=' + encodeURIComponent(gameId))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (data) {
          config.type = data.rewarded === 'on' ? 'rewarded' : 'none';
          config.rewarded = data.rewarded || 'off';
          config.placements = data.placements || {};
        }
      })
      .catch(function () { config.type = 'none'; config.rewarded = 'off'; });
  }

  function getNonce() {
    if (!API_BASE || !gameId) return Promise.reject(new Error('no api'));
    return fetch(API_BASE + '/api/reward/nonce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId: gameId })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { return data && data.nonce ? data.nonce : null; });
  }

  function verifyReward(nonce, token) {
    if (!API_BASE || !gameId || !nonce) return Promise.resolve({ granted: false });
    return fetch(API_BASE + '/api/reward/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gameId: gameId,
        nonce: nonce,
        adNetwork: 'admob',
        token: token || ''
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (data) { return { granted: !!(data && data.granted) }; })
      .catch(function () { return { granted: false }; });
  }

  function isRewardedAvailable() {
    return config.rewarded === 'on' && !!gameId;
  }

  function showRewarded() {
    return loadConfig()
      .then(function () {
        if (config.rewarded !== 'on') return Promise.resolve({ completed: false, granted: false });
        return getNonce();
      })
      .then(function (nonce) {
        if (!nonce) return { completed: false, granted: false };
        return verifyReward(nonce, null).then(function (r) {
          return { completed: true, granted: r.granted };
        });
      })
      .catch(function () { return { completed: false, granted: false }; });
  }

  window.BakenekoAds = {
    type: config.type,
    loadConfig: loadConfig,
    isRewardedAvailable: isRewardedAvailable,
    showRewarded: showRewarded
  };
})();
