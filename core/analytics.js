/**
 * 計測の遅延送信
 * イベントをキューに積み、POST /api/analytics/event に送信。失敗してもゲームは止めない。
 * 同一イベント連打はデバウンス（同一 session + event_name を短時間で抑止）。
 */
(function () {
  'use strict';

  var API_BASE = (function () {
    var val = typeof window.BAKENEKO_API_BASE !== 'undefined' ? window.BAKENEKO_API_BASE : '';
    if (typeof val !== 'string') return '';
    val = val.trim();
    if (!val) return '';
    try {
      var u = new URL(val);
      u.pathname = u.pathname.replace(/\/+$/, '') || '/';
      return u.origin + u.pathname;
    } catch (_) { return val.replace(/\/+$/, ''); }
  })();
  var gameId = typeof window.BAKENEKO_GAME_ID !== 'undefined' ? String(window.BAKENEKO_GAME_ID).trim() : '';
  var sessionId = (function () {
    var k = 'bakeneko_sid';
    try {
      var s = sessionStorage.getItem(k);
      if (s) return s;
      s = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
      sessionStorage.setItem(k, s);
      return s;
    } catch (_) { return ''; }
  })();

  var queue = [];
  var timer = null;
  var SEND_INTERVAL = 5000;
  var DEBOUNCE_MS = 2000;
  var lastEventKey = '';
  var lastEventTs = 0;

  function sendOne(item) {
    if (!API_BASE || !gameId) return;
    var body = JSON.stringify({
      game_id: gameId,
      session_id: sessionId,
      event_name: item.name,
      ts: item.ts,
      props: item.props || {}
    });
    fetch(API_BASE + '/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body
    }).catch(function () {});
  }

  function flushQueue() {
    while (queue.length > 0) {
      var item = queue.shift();
      sendOne(item);
    }
  }

  function flush() {
    try { flushQueue(); } catch (_) {}
  }

  function event(name, props) {
    var ts = Date.now();
    var key = sessionId + ':' + name;
    if (key === lastEventKey && (ts - lastEventTs) < DEBOUNCE_MS) return;
    lastEventKey = key;
    lastEventTs = ts;
    queue.push({ name: name, ts: ts, props: props || {} });
    if (!timer) {
      timer = setTimeout(function () {
        timer = null;
        flushQueue();
      }, SEND_INTERVAL);
    }
  }

  window.BakenekoAnalytics = {
    event: event,
    flush: flush
  };

  if (typeof window.addEventListener === 'function') {
    window.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') try { flush(); } catch (_) {}
    });
    window.addEventListener('pagehide', function () { try { flush(); } catch (_) {} });
  }
})();
