/**
 * NYAGI 共通ログインゲート (ES5 互換)
 * loginGate 要素があるページで自動的にログインフォームを注入する。
 * ログイン成功後はページをリロードして初期化し直す。
 */
(function () {
  'use strict';
  var gate = document.getElementById('loginGate');
  if (!gate) return;

  var stored = null;
  try { stored = JSON.parse(localStorage.getItem('nyagi_creds')); } catch (_) {}
  if (stored && stored.staffId) return;

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
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ password: v })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (!data || !data.staffId) { msg.textContent = 'パスワードが違います'; msg.style.display = 'block'; btn.disabled = false; return; }
      localStorage.setItem('nyagi_creds', JSON.stringify({ adminKey: adminKey, staffId: data.staffId }));
      location.reload();
    }).catch(function () { msg.textContent = '通信エラー'; msg.style.display = 'block'; btn.disabled = false; });
  }

  btn.addEventListener('click', doLogin);
  pwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  setTimeout(function () { pwd.focus(); }, 100);
})();
