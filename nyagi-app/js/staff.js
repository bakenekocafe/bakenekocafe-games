/**
 * NYAGI スタッフ登録 (ES5 互換)
 */

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops/staff';

  var loginGate = document.getElementById('loginGate');
  var staffContent = document.getElementById('staffContent');
  var staffList = document.getElementById('staffList');
  var submitBtn = document.getElementById('submitBtn');
  var cancelEditBtn = document.getElementById('cancelEditBtn');
  var staffMessage = document.getElementById('staffMessage');
  var staffFormTitle = document.getElementById('staffFormTitle');
  var staffPasswordReq = document.getElementById('staffPasswordReq');

  var credentials = null;
  var editingStaffId = null;

  function loadCredentials() {
    try {
      var stored = localStorage.getItem('nyagi_creds');
      if (stored) return JSON.parse(stored);
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

  credentials = loadCredentials();
  if (!credentials) {
    loginGate.style.display = 'block';
  } else {
    staffContent.style.display = 'block';
    loadStaffAndLocations();
  }

  function loadStaffAndLocations() {
    fetch(API_BASE, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          staffList.textContent = 'エラー: ' + (data.message || data.error);
          return;
        }
        var locs = data.locations || [];
        var defaultLocs = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊', both: '両方' };
        var locMap = {};
        for (var i = 0; i < locs.length; i++) { locMap[locs[i].id] = locs[i].name || locs[i].id; }
        for (var k in defaultLocs) { if (!locMap[k]) locMap[k] = defaultLocs[k]; }
        var locSel = document.getElementById('staffLocation');
        if (locSel) {
          locSel.innerHTML = '';
          var order = ['cafe', 'nekomata', 'endo', 'azukari', 'both'];
          for (var j = 0; j < order.length; j++) {
            var lid = order[j];
            if (!locMap[lid]) continue;
            var opt = document.createElement('option');
            opt.value = lid;
            opt.textContent = locMap[lid];
            locSel.appendChild(opt);
          }
        }
        var staff = data.staff || [];
        if (staff.length === 0) {
          staffList.textContent = '登録なし';
        } else {
          var locLabels = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊', both: '両方' };
          var html = '';
          for (var k = 0; k < staff.length; k++) {
            var s = staff[k];
            var active = s.active;
            var locLabel = locLabels[s.location_id] || s.location_id || '';
            var admin = false;
            if (s.permissions) {
              try { var p = JSON.parse(s.permissions); admin = Array.isArray(p) && p.indexOf('admin') !== -1; } catch (_) {}
            }
            if (s.role === 'owner') admin = true;
            html += '<div class="staff-row" data-id="' + escapeHtml(s.id || '') + '" data-name="' + escapeHtml(s.name || '') + '" data-location="' + escapeHtml(s.location_id || '') + '" data-admin="' + (admin ? '1' : '0') + '" style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:space-between;align-items:center;">';
            html += '<div><strong>' + escapeHtml(s.id || '') + '</strong> ' + escapeHtml(s.name || '') + ' — ' + escapeHtml(locLabel) + (active ? '' : ' <span style="color:#f87171;">(停止中)</span>') + '</div>';
            html += '<div style="display:flex;gap:6px;">';
            html += '<button type="button" class="btn-edit-small staff-edit" data-id="' + escapeHtml(s.id || '') + '">編集</button>';
            html += '<button type="button" class="btn-edit-small staff-toggle" data-id="' + escapeHtml(s.id || '') + '" data-active="' + (active ? '1' : '0') + '">' + (active ? '停止' : '開始') + '</button>';
            html += '</div>';
            html += '</div>';
          }
          staffList.innerHTML = html;
          bindStaffToggles();
          bindStaffEdits();
        }
      })
      .catch(function () {
        staffList.textContent = '読み込みに失敗しました';
      });
  }

  function escapeHtml(str) {
    if (str == null) return '';
    var s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showMessage(text, isError) {
    staffMessage.textContent = text;
    staffMessage.style.display = 'block';
    staffMessage.style.color = isError ? '#f87171' : '#4ade80';
  }

  function resetFormToNew() {
    editingStaffId = null;
    document.getElementById('staffId').value = '';
    document.getElementById('staffId').readOnly = false;
    document.getElementById('staffName').value = '';
    if (document.getElementById('staffPassword')) document.getElementById('staffPassword').value = '';
    document.getElementById('staffLocation').value = 'cafe';
    if (document.getElementById('staffAdmin')) document.getElementById('staffAdmin').checked = false;
    if (staffFormTitle) staffFormTitle.textContent = '新規スタッフ登録';
    if (submitBtn) submitBtn.textContent = '登録';
    if (staffPasswordReq) staffPasswordReq.textContent = '*';
    if (cancelEditBtn) cancelEditBtn.style.display = 'none';
    staffMessage.style.display = 'none';
  }

  function bindStaffEdits() {
    var btns = staffList.querySelectorAll('.staff-edit');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var row = this.closest('.staff-row');
        if (!row) return;
        var id = row.getAttribute('data-id');
        var name = row.getAttribute('data-name');
        var location = row.getAttribute('data-location') || 'cafe';
        var admin = row.getAttribute('data-admin') === '1';
        editingStaffId = id;
        document.getElementById('staffId').value = id;
        document.getElementById('staffId').readOnly = true;
        document.getElementById('staffName').value = name;
        if (document.getElementById('staffPassword')) document.getElementById('staffPassword').value = '';
        document.getElementById('staffLocation').value = location;
        if (document.getElementById('staffAdmin')) document.getElementById('staffAdmin').checked = admin;
        if (staffFormTitle) staffFormTitle.textContent = 'スタッフ編集';
        if (submitBtn) submitBtn.textContent = '更新';
        if (staffPasswordReq) staffPasswordReq.textContent = '';
        if (cancelEditBtn) cancelEditBtn.style.display = 'block';
        staffMessage.style.display = 'none';
      });
    }
  }

  function bindStaffToggles() {
    var btns = staffList.querySelectorAll('.staff-toggle');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var id = this.getAttribute('data-id');
        var currentActive = this.getAttribute('data-active') === '1';
        fetch(API_BASE + '/' + encodeURIComponent(id), {
          method: 'PUT',
          headers: apiHeaders(),
          body: JSON.stringify({ active: !currentActive }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) { showMessage(data.message || data.error, true); return; }
            loadStaffAndLocations();
          })
          .catch(function () { showMessage('通信エラー', true); });
      });
    }
  }

  if (cancelEditBtn) {
    cancelEditBtn.addEventListener('click', function () {
      resetFormToNew();
    });
  }

  if (submitBtn) {
    submitBtn.addEventListener('click', function () {
      var id = (document.getElementById('staffId').value || '').trim();
      var name = (document.getElementById('staffName').value || '').trim();
      var password = (document.getElementById('staffPassword') && document.getElementById('staffPassword').value) ? document.getElementById('staffPassword').value.trim() : '';
      var locationId = document.getElementById('staffLocation').value || null;
      var admin = document.getElementById('staffAdmin') && document.getElementById('staffAdmin').checked;

      if (!id || !name) {
        showMessage('Staff ID と名前を入力してください', true);
        return;
      }
      if (!editingStaffId) {
        if (!password || password.length !== 4 || !/^\d{4}$/.test(password)) {
          showMessage('4桁の数字パスワードを入力してください', true);
          return;
        }
      } else if (password && (password.length !== 4 || !/^\d{4}$/.test(password))) {
        showMessage('パスワードを変更する場合は4桁の数字を入力してください', true);
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = editingStaffId ? '更新中...' : '登録中...';
      staffMessage.style.display = 'none';

      var url = editingStaffId ? API_BASE + '/' + encodeURIComponent(editingStaffId) : API_BASE;
      var method = editingStaffId ? 'PUT' : 'POST';
      var body = { name: name, location_id: locationId || undefined, permissions: admin ? ['admin'] : [] };
      if (!editingStaffId) body.id = id;
      if (password) body.password = password;
      if (!editingStaffId) body.admin = admin;

      fetch(url, {
        method: method,
        headers: apiHeaders(),
        body: JSON.stringify(body),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            showMessage(data.message || data.error || (editingStaffId ? '更新に失敗しました' : '登録に失敗しました'), true);
            return;
          }
          showMessage(editingStaffId ? '更新しました: ' + name : '登録しました: ' + name, false);
          resetFormToNew();
          loadStaffAndLocations();
        })
        .catch(function () {
          showMessage('通信エラー', true);
        })
        .then(function () {
          submitBtn.disabled = false;
          submitBtn.textContent = editingStaffId ? '更新' : '登録';
        });
    });
  }
})();
