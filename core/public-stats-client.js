/**
 * BAKENEKO GAMES 共通 public-stats クライアント
 *
 * 前提:
 *   window.BAKENEKO_API_BASE — API エンドポイント
 *   window.BAKENEKO_GAME_ID  — ゲームID
 *
 * 使い方:
 *   BakenekoStats.get().then(function(stats){
 *     console.log(stats.totalPlays, stats.todaySupportCount);
 *   });
 */
(function () {
  'use strict';

  function getBase() {
    var v = typeof window.BAKENEKO_API_BASE === 'string' ? window.BAKENEKO_API_BASE.trim().replace(/\/+$/, '') : '';
    return v;
  }

  function getGameId() {
    return typeof window.BAKENEKO_GAME_ID === 'string' ? window.BAKENEKO_GAME_ID.trim() : '';
  }

  function get() {
    var base = getBase();
    var gameId = getGameId();
    if (!base || !gameId) {
      return Promise.resolve({
        totalPlays: 0, totalPv: 0, todayPv: 0,
        todaySupportCount: 0, totalSupportCount: 0
      });
    }

    return fetch(base + '/api/public-stats?gameId=' + encodeURIComponent(gameId), {
      method: 'GET',
      headers: { 'Accept': 'application/json' }
    }).then(function (r) {
      if (!r.ok) throw new Error('public-stats ' + r.status);
      return r.json();
    }).then(function (d) {
      return {
        totalPlays:        (d && typeof d.totalPlays !== 'undefined') ? Number(d.totalPlays) : 0,
        totalPv:           (d && typeof d.totalPv !== 'undefined') ? Number(d.totalPv) : 0,
        todayPv:           (d && typeof d.todayPv !== 'undefined') ? Number(d.todayPv) : 0,
        todaySupportCount: (d && typeof d.todaySupportCount !== 'undefined') ? Number(d.todaySupportCount) : 0,
        totalSupportCount: (d && typeof d.totalSupportCount !== 'undefined') ? Number(d.totalSupportCount) : 0,
        raw: d
      };
    }).catch(function () {
      return {
        totalPlays: 0, totalPv: 0, todayPv: 0,
        todaySupportCount: 0, totalSupportCount: 0
      };
    });
  }

  window.BakenekoStats = {
    get: get
  };
})();
