/**
 * NYAGI 共通ログインゲート & 認証永続化 (ES5 互換)
 *
 * 3層バックアップ: localStorage → Cookie → IndexedDB
 * どれか1つでも残っていれば自動復元する。
 * 全ページの <script> で最初に読み込まれる前提。
 */
(function () {
  'use strict';

  // ── Cookie ヘルパー ──────────────────────────────────────────────
  var _COOKIE_KEY = 'nyagi_creds';
  var _COOKIE_DAYS = 400;

  function _getCookie() {
    var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function _setCookie(value) {
    var d = new Date();
    d.setTime(d.getTime() + _COOKIE_DAYS * 86400000);
    document.cookie = _COOKIE_KEY + '=' + encodeURIComponent(value) +
      ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }
  function _clearCookie() {
    document.cookie = _COOKIE_KEY + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax';
  }

  // ── IndexedDB ヘルパー ───────────────────────────────────────────
  var _IDB_NAME = 'nyagi_auth';
  var _IDB_STORE = 'kv';
  var _IDB_KEY = 'creds';

  function _idbOpen(cb) {
    try {
      var req = indexedDB.open(_IDB_NAME, 1);
      req.onupgradeneeded = function (e) { e.target.result.createObjectStore(_IDB_STORE); };
      req.onsuccess = function (e) { cb(e.target.result); };
      req.onerror = function () { cb(null); };
    } catch (_) { cb(null); }
  }

  function _idbSave(value) {
    _idbOpen(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).put(value, _IDB_KEY);
      } catch (_) {}
    });
  }

  function _idbLoad(cb) {
    _idbOpen(function (db) {
      if (!db) { cb(null); return; }
      try {
        var tx = db.transaction(_IDB_STORE, 'readonly');
        var get = tx.objectStore(_IDB_STORE).get(_IDB_KEY);
        get.onsuccess = function () { cb(get.result || null); };
        get.onerror = function () { cb(null); };
      } catch (_) { cb(null); }
    });
  }

  function _idbClear() {
    _idbOpen(function (db) {
      if (!db) return;
      try {
        var tx = db.transaction(_IDB_STORE, 'readwrite');
        tx.objectStore(_IDB_STORE).delete(_IDB_KEY);
      } catch (_) {}
    });
  }

  // ── グローバル API（他スクリプトから呼べる） ─────────────────────
  window._nyagiSaveCreds = function (jsonStr) {
    try { localStorage.setItem('nyagi_creds', jsonStr); } catch (_) {}
    try { _setCookie(jsonStr); } catch (_) {}
    try { _idbSave(jsonStr); } catch (_) {}
  };

  window._nyagiClearCreds = function () {
    try { localStorage.removeItem('nyagi_creds'); } catch (_) {}
    try { _clearCookie(); } catch (_) {}
    try { _idbClear(); } catch (_) {}
  };

  // ── 同期的に復元を試みる（localStorage → Cookie） ──────────────
  function _syncRestore() {
    var json = null;
    try { json = localStorage.getItem('nyagi_creds'); } catch (_) {}
    if (json) {
      try {
        var obj = JSON.parse(json);
        if (obj && obj.staffId) {
          _setCookie(json);
          _idbSave(json);
          return obj;
        }
      } catch (_) {}
    }

    var ck = _getCookie();
    if (ck) {
      try {
        var obj2 = JSON.parse(ck);
        if (obj2 && obj2.staffId) {
          try { localStorage.setItem('nyagi_creds', ck); } catch (_) {}
          _idbSave(ck);
          return obj2;
        }
      } catch (_) {}
    }
    return null;
  }

  // ── ゲート処理 ──────────────────────────────────────────────────
  var gate = document.getElementById('loginGate');
  if (!gate) return;

  var creds = _syncRestore();
  if (creds) return;

  // 同期ストレージになかった → IndexedDB を非同期チェック
  _idbLoad(function (idbJson) {
    if (idbJson) {
      try {
        var obj = JSON.parse(idbJson);
        if (obj && obj.staffId) {
          try { localStorage.setItem('nyagi_creds', idbJson); } catch (_) {}
          _setCookie(idbJson);
          location.reload();
          return;
        }
      } catch (_) {}
    }
    // IndexedDB にもなかった → ログインフォーム表示
    _showLoginForm(gate);
  });

  function _showLoginForm(gate) {
    gate.innerHTML =
      '<div class="card" style="max-width:320px;margin:40px auto;">' +
        '<h2 style="text-align:center;margin-bottom:16px;">NYAGI ログイン</h2>' +
        '<div style="margin-bottom:12px;">' +
          '<label style="font-size:13px;color:var(--text-dim);">4桁パスワード</label>' +
          '<input type="password" id="_gatePwd" placeholder="1234" inputmode="numeric" pattern="[0-9]*" maxlength="4" autocomplete="off" ' +
            'style="width:100%;padding:12px;border-radius:8px;border:1px solid var(--surface-alt);background:var(--surface);color:var(--text);font-size:18px;text-align:center;margin-top:6px;">' +
        '</div>' +
        '<div id="_gateMsg" style="display:none;color:#f87171;font-size:13px;text-align:center;margin-bottom:8px;"></div>' +
        '<button id="_gateBtn" class="btn btn-primary" style="width:100%;">ログイン</button>' +
      '</div>';
    gate.style.display = 'block';

    var pwd = document.getElementById('_gatePwd');
    var btn = document.getElementById('_gateBtn');
    var msg = document.getElementById('_gateMsg');
    var origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
    var adminKey = (window.NYAGI_ADMIN_KEY != null) ? String(window.NYAGI_ADMIN_KEY).trim() : '';

    function doLogin() {
      var v = (pwd.value || '').trim();
      if (!v) { msg.textContent = 'パスワードを入力してください'; msg.style.display = 'block'; return; }
      btn.disabled = true;
      msg.style.display = 'none';
      fetch(origin + '/api/ops/auth/login', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
        body: JSON.stringify({ password: v })
      }).then(function (r) { return r.json(); }).then(function (data) {
        if (!data || !data.staffId) { msg.textContent = 'パスワードが違います'; msg.style.display = 'block'; btn.disabled = false; return; }
        var json = JSON.stringify({ adminKey: adminKey, staffId: data.staffId });
        window._nyagiSaveCreds(json);
        location.reload();
      }).catch(function () { msg.textContent = '通信エラー'; msg.style.display = 'block'; btn.disabled = false; });
    }

    btn.addEventListener('click', doLogin);
    pwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    setTimeout(function () { pwd.focus(); }, 100);
  }
})();
