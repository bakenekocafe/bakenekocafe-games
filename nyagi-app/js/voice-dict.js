/**
 * NYAGI 猫名辞書・誤認識ログ（音声用）
 */
(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_VOICE = _origin + '/api/ops/voice';
  var API_CATS = _origin + '/api/ops/cats';
  var credentials = null;

  function loadCredentials() {
    try {
      var raw = localStorage.getItem('nyagi_creds');
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    try {
      var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
      if (m) {
        var p = JSON.parse(decodeURIComponent(m[1]));
        if (p && p.staffId) {
          localStorage.setItem('nyagi_creds', JSON.stringify(p));
          return p;
        }
      }
    } catch (_) {}
    return null;
  }

  function apiHeaders() {
    return {
      'Content-Type': 'application/json',
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function variantBadgeLabel(t) {
    var m = {
      auto_learned: '自動学習',
      manual_ui: '手動',
      manual_promoted: 'ログから',
      canonical: '正式',
      kana_variant: 'かな',
      nickname: '愛称',
      official: '公式',
    };
    return m[t] || String(t || '—');
  }

  function showMsg(el, text, kind) {
    if (!el) return;
    el.className = 'vd-msg' + (kind ? ' vd-msg--' + kind : '');
    el.textContent = text || '';
    el.style.display = text ? 'block' : 'none';
  }

  function currentLocationParam() {
    var sel = document.getElementById('vdLocation');
    if (!sel) return '';
    var v = sel.value;
    if (v === 'all') return '';
    return v;
  }

  function loadCatsForSelect() {
    var sel = document.getElementById('vdCatSelect');
    var sel2 = document.getElementById('vdPromoCat');
    if (!sel) return;
    var q = currentLocationParam();
    var url = API_CATS + (q ? '?location=' + encodeURIComponent(q) : '');
    fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var cats = data.cats || [];
        sel.innerHTML = '<option value="">— 猫を選択 —</option>';
        if (sel2) sel2.innerHTML = '<option value="">— 猫を選択 —</option>';
        for (var i = 0; i < cats.length; i++) {
          var c = cats[i];
          var o = document.createElement('option');
          o.value = c.id;
          o.textContent = c.name || c.id;
          sel.appendChild(o);
          if (sel2) {
            var o2 = document.createElement('option');
            o2.value = c.id;
            o2.textContent = c.name || c.id;
            sel2.appendChild(o2);
          }
        }
      }).catch(function () {
        sel.innerHTML = '<option value="">取得失敗</option>';
      });
  }

  function loadDictionary() {
    var box = document.getElementById('vdDictBody');
    if (!box) return;
    box.innerHTML = '<div class="vd-loading">読み込み中…</div>';
    var q = currentLocationParam();
    var url = API_VOICE + '/cat-name-dictionary' + (q ? '?location=' + encodeURIComponent(q) : '');
    fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = data.entries || [];
        if (!rows.length) {
          box.innerHTML = '<div class="vd-empty">辞書エントリがありません</div>';
          return;
        }
        var h = '';
        var curCat = null;
        for (var i = 0; i < rows.length; i++) {
          var e = rows[i];
          if (e.cat_name !== curCat) {
            curCat = e.cat_name;
            h += '<div class="vd-cat-head">' + esc(e.cat_name) + ' <small class="dim">' + esc(e.location_id || '') + '</small></div>';
          }
          h += '<div class="vd-row" data-id="' + esc(String(e.id)) + '">';
          h += '<span class="vd-variant">' + esc(e.variant) + '</span>';
          h += '<span class="vd-badge">' + esc(variantBadgeLabel(e.variant_type)) + '</span>';
          h += '<span class="vd-pri">p' + esc(String(e.priority)) + '</span>';
          h += '<button type="button" class="vd-btn vd-btn--danger vd-del" data-id="' + esc(String(e.id)) + '">削除</button>';
          h += '</div>';
        }
        box.innerHTML = h;
        var dels = box.querySelectorAll('.vd-del');
        for (var j = 0; j < dels.length; j++) {
          dels[j].addEventListener('click', onDeleteEntry);
        }
      }).catch(function () {
        box.innerHTML = '<div class="vd-err">読み込みに失敗しました</div>';
      });
  }

  function onDeleteEntry(ev) {
    var id = ev.target.getAttribute('data-id');
    if (!id || !confirm('この辞書行を削除しますか？')) return;
    fetch(API_VOICE + '/cat-name-dictionary/' + id, {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert(data.message || data.error); return; }
        loadDictionary();
      }).catch(function () { alert('削除に失敗しました'); });
  }

  function loadMisrecognition() {
    var box = document.getElementById('vdLogBody');
    if (!box) return;
    box.innerHTML = '<div class="vd-loading">読み込み中…</div>';
    fetch(API_VOICE + '/misrecognition-log?limit=80', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var rows = data.aggregates || [];
        if (!rows.length) {
          box.innerHTML = '<div class="vd-empty">ログ集計がありません</div>';
          return;
        }
        var h = '<p class="vd-hint">出現回数の多い「先頭トークン」です。行を選んで下のフォームから猫に紐づけて辞書追加できます。</p>';
        for (var i = 0; i < rows.length; i++) {
          var r0 = rows[i];
          h += '<div class="vd-log-row">';
          h += '<span class="vd-token">' + esc(r0.token) + '</span>';
          h += '<span class="vd-cnt">' + esc(String(r0.cnt)) + ' 回</span>';
          h += '<button type="button" class="vd-btn vd-use-token" data-token="' + escAttr(r0.token) + '">フォームに入れる</button>';
          h += '</div>';
        }
        box.innerHTML = h;
        var btns = box.querySelectorAll('.vd-use-token');
        for (var j = 0; j < btns.length; j++) {
          btns[j].addEventListener('click', function () {
            var t = this.getAttribute('data-token');
            var inp = document.getElementById('vdPromoToken');
            if (inp) inp.value = t || '';
          });
        }
      }).catch(function () {
        box.innerHTML = '<div class="vd-err">読み込みに失敗しました</div>';
      });
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function submitAdd() {
    var cat = document.getElementById('vdCatSelect') && document.getElementById('vdCatSelect').value;
    var variant = document.getElementById('vdNewVariant') && document.getElementById('vdNewVariant').value.trim();
    var msg = document.getElementById('vdAddMsg');
    if (!cat || !variant) {
      showMsg(msg, '猫と表記を入力してください', 'warn');
      return;
    }
    showMsg(msg, '', '');
    fetch(API_VOICE + '/cat-name-dictionary', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ cat_id: cat, variant: variant, variant_type: 'manual_ui', priority: 88 }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showMsg(msg, data.message || data.error, 'err');
          return;
        }
        showMsg(msg, '追加しました', 'ok');
        document.getElementById('vdNewVariant').value = '';
        loadDictionary();
      }).catch(function () { showMsg(msg, '送信に失敗しました', 'err'); });
  }

  function submitPromote() {
    var cat = document.getElementById('vdPromoCat') && document.getElementById('vdPromoCat').value;
    var token = document.getElementById('vdPromoToken') && document.getElementById('vdPromoToken').value.trim();
    var msg = document.getElementById('vdPromoMsg');
    if (!cat || !token) {
      showMsg(msg, '猫と誤認識トークンを入力してください', 'warn');
      return;
    }
    showMsg(msg, '', '');
    fetch(API_VOICE + '/misrecognition-log/promote', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ cat_id: cat, attempted_name: token, variant_type: 'manual_promoted', priority: 88 }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showMsg(msg, data.message || data.error, 'err');
          return;
        }
        showMsg(msg, '辞書に追加し、該当ログを処理済みにしました', 'ok');
        loadDictionary();
        loadMisrecognition();
      }).catch(function () { showMsg(msg, '送信に失敗しました', 'err'); });
  }

  function runAutoRepair() {
    if (!confirm('誤認識ログから自動で辞書行を追加します（条件を満たすもののみ）。よろしいですか？')) return;
    var msg = document.getElementById('vdRepairMsg');
    showMsg(msg, '実行中…', '');
    fetch(API_VOICE + '/cat-name-dictionary/auto-repair', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: '{}',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          showMsg(msg, data.message || data.error, 'err');
          return;
        }
        showMsg(msg, '追加件数: ' + (data.repaired != null ? data.repaired : 0), 'ok');
        loadDictionary();
        loadMisrecognition();
      }).catch(function () { showMsg(msg, '失敗しました', 'err'); });
  }

  function switchTab(name) {
    var t1 = document.getElementById('tabDict');
    var t2 = document.getElementById('tabLog');
    var p1 = document.getElementById('panelDict');
    var p2 = document.getElementById('panelLog');
    var on = name === 'log';
    if (t1) t1.classList.toggle('active', !on);
    if (t2) t2.classList.toggle('active', on);
    if (p1) p1.style.display = on ? 'none' : 'block';
    if (p2) p2.style.display = on ? 'block' : 'none';
    if (on) loadMisrecognition();
    else loadDictionary();
  }

  function boot() {
    var loc = document.getElementById('vdLocation');
    if (loc) {
      loc.addEventListener('change', function () {
        loadCatsForSelect();
        loadDictionary();
      });
    }
    document.getElementById('vdBtnAdd') && document.getElementById('vdBtnAdd').addEventListener('click', submitAdd);
    document.getElementById('vdBtnPromo') && document.getElementById('vdBtnPromo').addEventListener('click', submitPromote);
    document.getElementById('vdBtnRepair') && document.getElementById('vdBtnRepair').addEventListener('click', runAutoRepair);
    document.getElementById('tabDict') && document.getElementById('tabDict').addEventListener('click', function () { switchTab('dict'); });
    document.getElementById('tabLog') && document.getElementById('tabLog').addEventListener('click', function () { switchTab('log'); });
    var main = document.getElementById('vdMain');
    if (main) main.style.display = 'block';
    loadCatsForSelect();
    loadDictionary();
  }

  credentials = loadCredentials();
  if (!credentials) {
    document.addEventListener('DOMContentLoaded', function () {
      var g = document.getElementById('loginGate');
      if (g) g.style.display = 'block';
    });
  } else {
    document.addEventListener('DOMContentLoaded', boot);
  }
})();

