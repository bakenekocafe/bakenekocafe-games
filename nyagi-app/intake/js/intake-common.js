/**
 * 引き受け申請 共通（ES5）— Bearer セッション / プレビュー ?pt=
 */
(function () {
  'use strict';

  var TOKEN_KEY = 'bakeneko_intake_session';

  function apiOrigin() {
    return window.NYAGI_API_ORIGIN != null && window.NYAGI_API_ORIGIN ? window.NYAGI_API_ORIGIN : '';
  }

  window.intakePublicBase = function () {
    return apiOrigin() + '/api/ops/intake-public';
  };

  window.intakeGetToken = function () {
    try {
      var u = new URL(location.href);
      var pt = u.searchParams.get('pt');
      if (pt) {
        window.__INTAKE_IS_PREVIEW = true;
        return pt;
      }
    } catch (_) {}
    window.__INTAKE_IS_PREVIEW = false;
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (_) {
      return '';
    }
  };

  window.intakeIsPreview = function () {
    return !!window.__INTAKE_IS_PREVIEW;
  };

  window.intakeSetSession = function (token) {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch (_) {}
  };

  window.intakeClearSession = function () {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch (_) {}
  };

  window.intakeFetch = function (method, path, bodyObj) {
    var url = window.intakePublicBase() + path;
    var token = window.intakeGetToken();
    var h = { Accept: 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    var opts = { method: method, headers: h, cache: 'no-store' };
    if (bodyObj != null && method !== 'GET' && method !== 'HEAD') {
      h['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(bodyObj);
    }
    return fetch(url, opts).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try {
          j = t ? JSON.parse(t) : {};
        } catch (_) {}
        if (!r.ok) {
          var err = new Error(j.message || j.error || String(r.status));
          err.body = j;
          err.status = r.status;
          throw err;
        }
        return j;
      });
    });
  };

  /** 認証不要の JSON API（例: GET /locations） */
  window.intakeFetchUnauthenticated = function (method, path) {
    var url = window.intakePublicBase() + path;
    return fetch(url, { method: method, headers: { Accept: 'application/json' }, cache: 'no-store' }).then(
      function (r) {
        return r.text().then(function (t) {
          var j = {};
          try {
            j = t ? JSON.parse(t) : {};
          } catch (_) {}
          if (!r.ok) {
            var err = new Error(j.message || j.error || String(r.status));
            err.body = j;
            throw err;
          }
          return j;
        });
      }
    );
  };

  window.intakeMultipart = function (path, formData) {
    var token = window.intakeGetToken();
    var h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(window.intakePublicBase() + path, {
      method: 'POST',
      headers: h,
      body: formData,
      cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var e = new Error(j.message || 'upload');
          e.body = j;
          throw e;
        }
        return j;
      });
    });
  };

  window.intakeEsc = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  };

  window.intakeRequireAuth = function () {
    if (window.intakeGetToken()) return true;
    location.href = 'login.html';
    return false;
  };

  window.intakeLogout = function () {
    return window
      .intakeFetch('POST', '/logout', {})
      .then(function () {
        window.intakeClearSession();
        location.href = 'login.html';
      })
      .catch(function () {
        window.intakeClearSession();
        location.href = 'login.html';
      });
  };

  /** 写真・書類の GET（JSON ではなく Blob） */
  window.intakeFetchBlob = function (path) {
    var url = window.intakePublicBase() + path;
    var token = window.intakeGetToken();
    var h = {};
    if (token) h.Authorization = 'Bearer ' + token;
    return fetch(url, { method: 'GET', headers: h, cache: 'no-store' }).then(function (r) {
      if (!r.ok) {
        var err = new Error('file');
        err.status = r.status;
        throw err;
      }
      return r.blob();
    });
  };
})();
