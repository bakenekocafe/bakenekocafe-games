/**
 * BAKENEKO GAMES 共通ランキングクライアント
 *
 * 前提:
 *   window.BAKENEKO_API_BASE — API エンドポイント
 *   window.BAKENEKO_GAME_ID  — ゲームID
 *
 * 使い方:
 *   BakenekoRanking.submit(score, nickname).then(function(result){ ... });
 *   BakenekoRanking.fetch(50).then(function(items){ ... });
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

  function submit(score, nickname) {
    var base = getBase();
    var gameId = getGameId();
    if (!base || !gameId) return Promise.resolve({ ok: false, error: 'missing config' });

    return fetch(base + '/api/ranking/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      mode: 'cors',
      body: JSON.stringify({
        gameId: gameId,
        nickname: nickname || '名無しさん',
        score: score
      })
    }).then(function (r) {
      if (!r.ok) return { ok: false, error: r.status + ' ' + r.statusText };
      return r.json().then(function (d) {
        d.ok = true;
        return d;
      });
    }).catch(function (err) {
      return { ok: false, error: err.message || 'network error' };
    });
  }

  function fetchLeaderboard(limit) {
    var base = getBase();
    var gameId = getGameId();
    if (!base || !gameId) return Promise.resolve({ items: [], error: 'missing config' });

    return fetch(base + '/api/ranking/leaderboard?gameId=' + encodeURIComponent(gameId) + '&limit=' + (limit || 20), {
      method: 'GET',
      mode: 'cors',
      headers: { 'Accept': 'application/json' }
    }).then(function (r) {
      if (!r.ok) return { items: [], error: r.status + ' ' + r.statusText };
      return r.json().then(function (d) {
        var items = Array.isArray(d) ? d : (d.items || d.rankings || []);
        return { items: items };
      });
    }).catch(function (err) {
      return { items: [], error: err.message || 'network error' };
    });
  }

  window.BakenekoRanking = {
    submit: submit,
    fetch: fetchLeaderboard
  };
})();
