/**
 * NYAGI タスク管理画面 JS (ES5 互換) — P6: 属性化 + プロジェクト
 */

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops';

  var loginGate = document.getElementById('loginGate');
  var taskContent = document.getElementById('taskContent');
  var credentials = null;
  var currentTab = 'today';
  var catList = [];
  var staffList = [];
  var currentProjectId = null;

  /** 今日の暦日 YYYY-MM-DD（日本時間）。GET /tasks の due_date・テンプレ生成日と一致させる */
  function todayJstYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** input[type=date] 用 YYYY-MM-DD（無効・空なら JST 今日） */
  function normalizeYmdForDateInput(raw) {
    var s = String(raw || '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return todayJstYmd();
  }

  /** 日付 input の値を YYYY-MM-DD または null（未入力） */
  function optionalYmdFromInput(elementId) {
    var el = document.getElementById(elementId);
    if (!el) return null;
    var s = String(el.value || '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    return null;
  }

  function loadCredentials() {
    try {
      var stored = localStorage.getItem('nyagi_creds');
      if (stored) return JSON.parse(stored);
    } catch (_) {}
    try {
      var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
      if (m) { var p = JSON.parse(decodeURIComponent(m[1])); if (p && p.staffId) { localStorage.setItem('nyagi_creds', JSON.stringify(p)); return p; } }
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

  function nyagiCaptureScrollY() {
    if (window.NyagiScrollRestore && typeof window.NyagiScrollRestore.capture === 'function') {
      return window.NyagiScrollRestore.capture();
    }
    try {
      var el = document.scrollingElement || document.documentElement;
      return el.scrollTop;
    } catch (_) {
      return 0;
    }
  }

  function nyagiRestoreScrollY(y) {
    if (window.NyagiScrollRestore && typeof window.NyagiScrollRestore.restore === 'function') {
      window.NyagiScrollRestore.restore(y);
      return;
    }
    if (typeof y !== 'number' || isNaN(y) || y < 0) return;
    function apply() {
      try {
        var el = document.scrollingElement || document.documentElement;
        el.scrollTop = y;
      } catch (_) {}
    }
    if (typeof window.requestAnimationFrame !== 'function') {
      apply();
      return;
    }
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(apply);
    });
  }

  /** completed_at を日本時刻 HH:mm で表示（従来の UTC 文字列も Date 経由で補正） */
  function formatTaskCompletedAtJst(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) {
        var s = String(isoStr);
        return s.length >= 16 ? s.slice(11, 16) : s;
      }
      return d.toLocaleTimeString('sv-SE', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    } catch (_) {
      return String(isoStr).slice(11, 16);
    }
  }

  credentials = loadCredentials();
  if (!credentials) {
    loginGate.style.display = 'block';
    var gateBtn = document.getElementById('gateLoginBtn');
    var gatePwd = document.getElementById('gatePasswordInput');
    var gateAlert = document.getElementById('gateLoginAlert');
    if (gateBtn) {
      gateBtn.addEventListener('click', function () {
        var password = (gatePwd && gatePwd.value) ? gatePwd.value.trim() : '';
        var adminKey = (window.NYAGI_ADMIN_KEY != null) ? String(window.NYAGI_ADMIN_KEY).trim() : '';
        if (!password) { if (gateAlert) { gateAlert.textContent = 'パスワードを入力してください'; gateAlert.style.display = 'block'; } return; }
        gateBtn.disabled = true;
        fetch(_origin + '/api/ops/auth/login', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
          body: JSON.stringify({ password: password })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (!data || !data.staffId) { if (gateAlert) { gateAlert.textContent = 'パスワードが違います'; gateAlert.style.display = 'block'; } gateBtn.disabled = false; return; }
          var _cj = JSON.stringify({ adminKey: adminKey, staffId: data.staffId });
          if (window._nyagiSaveCreds) { window._nyagiSaveCreds(_cj); }
          else {           localStorage.setItem('nyagi_creds', _cj); }
          credentials = { adminKey: adminKey, staffId: data.staffId };
          loginGate.style.display = 'none';
          taskContent.style.display = 'block';
          var today = todayJstYmd();
          document.getElementById('filterDate').value = today;
          loadCatList();
          loadStaffList();
          window.loadTasks();
        }).catch(function () { if (gateAlert) { gateAlert.textContent = '通信エラー'; gateAlert.style.display = 'block'; } gateBtn.disabled = false; });
      });
      if (gatePwd) {
        gatePwd.addEventListener('keydown', function (e) { if (e.key === 'Enter') gateBtn.click(); });
      }
    }
  } else {
    taskContent.style.display = 'block';
  }

  function loadCatList() {
    var loc = getSelectedLocation();
    var url = API_BASE + '/cats';
    if (loc) url += '?location=' + encodeURIComponent(loc);
    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catList = data.cats || [];
        populateCatSelects();
      })
      .catch(function () { return null; });
  }

  function populateCatSelects() {
    var selectors = ['ntCatId', 'tmplCatId'];
    for (var s = 0; s < selectors.length; s++) {
      var sel = document.getElementById(selectors[s]);
      if (!sel) continue;
      while (sel.options.length > 1) sel.remove(1);
      for (var i = 0; i < catList.length; i++) {
        var opt = document.createElement('option');
        opt.value = catList[i].id;
        opt.textContent = catList[i].name;
        sel.appendChild(opt);
      }
    }
  }

  function loadStaffList() {
    fetch(API_BASE + '/staff', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        staffList = data.staff || [];
      })
      .catch(function () {});
  }

  function populateStaffSelect(selectId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    while (sel.options.length > 1) sel.remove(1);
    for (var i = 0; i < staffList.length; i++) {
      var opt = document.createElement('option');
      opt.value = staffList[i].id;
      opt.textContent = staffList[i].name;
      sel.appendChild(opt);
    }
  }

  // ── タブ切替 ────────────────────────────────────────────────────────────────

  window.switchTab = function (tab) {
    currentTab = tab;
    document.getElementById('todayView').style.display = tab === 'today' ? 'block' : 'none';
    document.getElementById('projectsView').style.display = tab === 'projects' ? 'block' : 'none';
    document.getElementById('monitoringView').style.display = tab === 'monitoring' ? 'block' : 'none';
    document.getElementById('templateView').style.display = tab === 'templates' ? 'block' : 'none';

    document.getElementById('tabToday').classList.toggle('active', tab === 'today');
    document.getElementById('tabProjects').classList.toggle('active', tab === 'projects');
    document.getElementById('tabMonitoring').classList.toggle('active', tab === 'monitoring');
    document.getElementById('tabTemplates').classList.toggle('active', tab === 'templates');

    if (tab === 'templates') {
      var fd = document.getElementById('filterDate');
      var tg = document.getElementById('tmplGenerateDate');
      if (tg && fd) tg.value = fd.value || todayJstYmd();
      loadTemplates();
    }
    if (tab === 'monitoring') loadMonitoringTasks();
    if (tab === 'projects') { currentProjectId = null; loadProjects(); }
  };

  // ── タスク種類セレクト連動 ──────────────────────────────────────────────────

  var ntTaskType = document.getElementById('ntTaskType');
  if (ntTaskType) {
    ntTaskType.addEventListener('change', function () {
      var isMonitoring = this.value === 'monitoring';
      document.getElementById('ntExpiresGroup').style.display = isMonitoring ? 'block' : 'none';
      document.getElementById('ntDateGroup').style.display = 'block';
      var ndg = document.getElementById('ntDeadlineGroup');
      if (ndg) ndg.style.display = 'block';
      document.getElementById('ntTimeGroup').style.display = isMonitoring ? 'none' : 'block';
      var hint = document.getElementById('ntCatHint');
      if (hint) hint.style.display = isMonitoring ? 'block' : 'none';
    });
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  今日のタスク（属性グルーピング）
  // ══════════════════════════════════════════════════════════════════════════════

  function getSelectedLocation() {
    var sel = document.getElementById('locationSelect');
    return sel ? sel.value : '';
  }

  window.onLocationChange = function () {
    loadCatList();
    if (currentTab === 'today') loadTasks();
    else if (currentTab === 'templates') loadTemplates();
    else if (currentTab === 'projects') loadProjects();
    else if (currentTab === 'monitoring') loadMonitoringTasks();
  };

  var foldedGroups = {};

  window.toggleAttrGroup = function (attr) {
    var body = document.getElementById('attr-tasks-' + attr);
    var header = document.getElementById('attr-header-' + attr);
    if (!body || !header) return;
    var isCurrentlyFolded = foldedGroups[attr] !== false;
    foldedGroups[attr] = isCurrentlyFolded ? false : true;
    if (foldedGroups[attr]) {
      body.classList.add('hidden');
      header.classList.add('folded');
    } else {
      body.classList.remove('hidden');
      header.classList.remove('folded');
    }
  };

  /** 完了済みブロックの開閉（既定は閉じて未完了だけ見やすく） */
  window.toggleTaskFinishedSection = function (sectionUid) {
    var body = document.getElementById('task-finished-body-' + sectionUid);
    var hdr = document.getElementById('task-finished-hdr-' + sectionUid);
    if (!body || !hdr) return;
    body.classList.toggle('hidden');
    hdr.classList.toggle('folded');
  };

  window.loadTasks = function () {
    var savedScrollY = nyagiCaptureScrollY();

    var date = document.getElementById('filterDate').value || todayJstYmd();
    var status = document.getElementById('filterStatus').value;

    var qs = '?date=' + encodeURIComponent(date) + '&group_by=attribute';
    if (status) qs += '&status=' + encodeURIComponent(status);
    var loc = getSelectedLocation();
    if (loc === 'both') qs += '&location=both';
    else if (loc) qs += '&location=' + encodeURIComponent(loc);

    document.getElementById('taskListArea').innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';
    document.getElementById('progressArea').innerHTML = '';

    fetch(API_BASE + '/tasks' + qs, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(data.message || data.error) + '</div>';
          nyagiRestoreScrollY(savedScrollY);
          return;
        }
        renderAttrProgress(data.progress || {}, data.attribute_groups || []);
        if (data.attribute_groups && data.attribute_groups.length > 0) {
          renderAttrGroupedTasks(data.attribute_groups);
        } else {
          renderFlatTasks(data.tasks || []);
        }
        nyagiRestoreScrollY(savedScrollY);
      })
      .catch(function () {
        document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
        nyagiRestoreScrollY(savedScrollY);
      });
  };

  function renderAttrProgress(prog, groups) {
    var html = '<div class="attr-progress-wrap">';
    html += '<div class="attr-progress-total">';
    html += '<span>全体: ' + (prog.done || 0) + '/' + (prog.total || 0) + ' 完了</span>';
    html += '<span>' + (prog.pct || 0) + '%</span>';
    html += '</div>';

    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var pct = g.progress.pct || 0;
      var colorClass = pct === 100 ? 'green' : pct >= 50 ? 'yellow' : 'red';
      var complete = pct === 100 ? '<span class="attr-complete-mark">✨</span>' : '';

      html += '<div class="attr-progress-item" onclick="scrollToAttrGroup(\'' + escapeHtml(g.attribute) + '\')">';
      html += '<span class="attr-icon">' + escapeHtml(g.icon) + '</span>';
      html += '<span class="attr-label">' + escapeHtml(g.label) + '</span>';
      html += '<div class="attr-bar-bg"><div class="attr-bar-fill ' + colorClass + '" style="width:' + pct + '%"></div></div>';
      html += '<span class="attr-count">' + g.progress.done + '/' + g.progress.total + complete + '</span>';
      html += '</div>';
    }

    html += '</div>';
    document.getElementById('progressArea').innerHTML = html;
  }

  window.scrollToAttrGroup = function (attr) {
    if (foldedGroups[attr] !== false) {
      foldedGroups[attr] = false;
      var body = document.getElementById('attr-tasks-' + attr);
      var header = document.getElementById('attr-header-' + attr);
      if (body) body.classList.remove('hidden');
      if (header) header.classList.remove('folded');
    }
    var el = document.getElementById('attr-group-' + attr);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function partitionTasksPendingFirst(tasks) {
    var pending = [];
    var finished = [];
    var arr = tasks || [];
    for (var i = 0; i < arr.length; i++) {
      var t = arr[i];
      if (t.status === 'done' || t.status === 'skipped') finished.push(t);
      else pending.push(t);
    }
    return { pending: pending, finished: finished };
  }

  function renderAttrGroupedTasks(groups) {
    if (groups.length === 0) {
      document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">タスクなし</div>';
      return;
    }

    var html = '';
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var tasks = grp.tasks || [];
      var part = partitionTasksPendingFirst(tasks);
      var attr = escapeHtml(grp.attribute);
      var allDone = grp.progress.pct === 100;
      var isFolded = allDone || (foldedGroups[grp.attribute] !== false);
      var sectionUid = 'grp-' + g;

      html += '<div id="attr-group-' + attr + '">';
      html += '<div id="attr-header-' + attr + '" class="attr-group-header' + (isFolded ? ' folded' : '') + '" onclick="toggleAttrGroup(\'' + attr + '\')">';
      html += '<div class="attr-avatar">' + escapeHtml(grp.icon) + '</div>';
      html += '<div class="attr-group-name">' + escapeHtml(grp.label) + '</div>';
      html += '<div class="attr-group-count">' + grp.progress.done + '/' + grp.progress.total;
      if (allDone) html += ' ✨';
      html += '</div>';
      html += '<span class="attr-fold-icon">▲</span>';
      html += '</div>';

      html += '<div id="attr-tasks-' + attr + '" class="attr-group-tasks' + (isFolded ? ' hidden' : '') + '">';
      for (var j = 0; j < part.pending.length; j++) {
        html += renderTaskItem(part.pending[j]);
      }
      html += renderFinishedTasksSection(part.finished, sectionUid);
      html += '</div>';
      html += '</div>';
    }

    document.getElementById('taskListArea').innerHTML = html;
  }

  function renderFlatTasks(tasks) {
    if (tasks.length === 0) {
      document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">タスクなし</div>';
      return;
    }
    var part = partitionTasksPendingFirst(tasks);
    var html = '';
    for (var i = 0; i < part.pending.length; i++) html += renderTaskItem(part.pending[i]);
    html += renderFinishedTasksSection(part.finished, 'flat');
    document.getElementById('taskListArea').innerHTML = html;
  }

  /** イベントタスク: 一覧基準日から見た未解決経過日数（API event_days_open）または期限切れ表示 */
  function eventOverdueBadgeHtml(task) {
    if ((task.task_type || '') !== 'event') return '';
    if (task.status !== 'pending' && task.status !== 'in_progress') return '';
    var n = task.event_days_open;
    if (n != null && Number(n) > 0) {
      return '<span class="task-overdue-badge">未解決 ' + Number(n) + '日</span>';
    }
    var dRaw = task.deadline_date || task.due_date;
    var dd = dRaw ? String(dRaw).slice(0, 10) : '';
    if (!dd || dd.length < 10) return '';
    if (dd >= todayJstYmd()) return '';
    return '<span class="task-overdue-badge">期限切れ</span>';
  }

  function taskListFilterDateYmd() {
    var el = document.getElementById('filterDate');
    if (el && el.value) {
      var v = String(el.value).slice(0, 10);
      if (v.length === 10 && v.charAt(4) === '-') return v;
    }
    return todayJstYmd();
  }

  /** YYYY-MM-DD → M/D（曜） */
  function formatTaskDueDateForList(ymdRaw) {
    var ymd = String(ymdRaw || '').slice(0, 10);
    if (ymd.length !== 10 || ymd.charAt(4) !== '-') return '';
    var parts = ymd.split('-');
    var y = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(mo) || isNaN(d)) return '';
    var dt = new Date(y, mo - 1, d);
    var wdays = ['日', '月', '火', '水', '木', '金', '土'];
    var w = wdays[dt.getDay()];
    return mo + '/' + d + '（' + w + '）';
  }

  /** 指定実行日（scheduled_date）。値があるときだけ一覧に出す */
  function taskScheduledDateMetaHtml(task) {
    var sd = task.scheduled_date ? String(task.scheduled_date).slice(0, 10) : '';
    if (sd.length !== 10 || sd.charAt(4) !== '-') return '';
    var label = formatTaskDueDateForList(sd);
    if (!label) return '';
    return '<span class="task-due-date">実行 ' + escapeHtml(label) + '</span>';
  }

  /**
   * 期限（暦日）の表示。ルーティンで一覧の日付と同じ場合は省略（日付はヘッダで分かるため）。
   * イベント・監視などは期限を必ず表示。
   */
  function taskDueDateMetaHtml(task) {
    var dline = task.deadline_date ? String(task.deadline_date).slice(0, 10) : '';
    var dd = dline.length === 10 ? dline : (task.due_date ? String(task.due_date).slice(0, 10) : '');
    if (dd.length !== 10 || dd.charAt(4) !== '-') return '';
    var tt = task.task_type || 'routine';
    if (tt === 'routine' && dd === taskListFilterDateYmd()) return '';
    var label = formatTaskDueDateForList(dd);
    if (!label) return '';
    var today = todayJstYmd();
    var overdue = dd < today && task.status !== 'done' && task.status !== 'skipped';
    var cls = overdue ? 'task-due-date task-due-date--overdue' : 'task-due-date';
    return '<span class="' + cls + '">期限 ' + escapeHtml(label) + '</span>';
  }

  function renderTaskItem(task) {
    var statusClass = task.status === 'done' ? ' done' : task.status === 'skipped' ? ' skipped' : '';
    var checkIcon = task.status === 'done' ? '✅' : task.status === 'skipped' ? '⏭' : '⬜';

    var html = '<div class="task-item' + statusClass + '" id="task-' + task.id + '">';
    html += '<div class="task-check" onclick="toggleTask(' + task.id + ',\'' + task.status + '\')">' + checkIcon + '</div>';
    html += '<div class="task-body">';
    html += '<div class="task-title">';
    if (task.cat_name) html += '<span style="color:#a78bfa;">' + escapeHtml(task.cat_name) + ' </span>';
    html += escapeHtml(task.title) + '</div>';
    html += '<div class="task-meta">';

    var tt = task.task_type || 'routine';
    if (tt !== 'routine') {
      html += '<span class="task-type-badge ' + tt + '">' + taskTypeLabel(tt) + '</span>';
    }
    html += eventOverdueBadgeHtml(task);

    if (task.priority && task.priority !== 'normal') {
      var prioLabel = { urgent: '緊急', high: '高', low: '低' }[task.priority] || task.priority;
      html += '<span class="task-priority-badge ' + task.priority + '">' + prioLabel + '</span>';
    }
    html += taskScheduledDateMetaHtml(task);
    html += taskDueDateMetaHtml(task);
    if (task.due_time) html += '<span>' + escapeHtml(slotLabel(task.due_time)) + '</span>';
    if (task.assigned_name) html += '<span style="opacity:0.7;">担当: ' + escapeHtml(task.assigned_name) + '</span>';
    html += '</div>';

    if (task.status === 'done' && task.completed_at) {
      var timeStr = formatTaskCompletedAtJst(task.completed_at);
      html += '<div class="task-done-info">完了 ' + escapeHtml(task.completed_by || '') + ' ' + escapeHtml(timeStr) + '</div>';
    }

    if (task.status === 'skipped' && task.skip_reason) {
      html += '<div style="font-size:11px;color:#facc15;margin-top:2px;">理由: ' + escapeHtml(task.skip_reason) + '</div>';
    }

    if (task.note) {
      var notePreview = task.note.length > 80 ? task.note.slice(0, 80) + '...' : task.note;
      html += '<div class="task-note-preview">' + escapeHtml(notePreview) + '</div>';
    }

    if (task.status === 'pending') {
      html += '<div class="task-actions-row">';
      html += '<button class="task-action-btn" onclick="openNoteModal(' + task.id + ',' + (task.cat_id ? 'true' : 'false') + ')">メモ追記</button>';
      html += '<button class="task-action-btn" onclick="openSkipModal(' + task.id + ')">スキップ</button>';
      html += '</div>';
    }

    html += '</div></div>';
    return html;
  }

  function renderFinishedTasksSection(finished, sectionUid) {
    if (!finished || finished.length === 0) return '';
    var uid = String(sectionUid || 'sec').replace(/[^a-zA-Z0-9_-]/g, '_');
    var html = '<div class="task-finished-section">';
    html += '<div id="task-finished-hdr-' + uid + '" class="task-finished-header folded" onclick="toggleTaskFinishedSection(\'' + uid + '\')">';
    html += '<span>完了済み <strong>' + finished.length + '</strong> 件（タップで開閉）</span>';
    html += '<span class="tfi-chevron">▼</span></div>';
    html += '<div id="task-finished-body-' + uid + '" class="task-finished-body hidden">';
    for (var fi = 0; fi < finished.length; fi++) {
      html += renderTaskItem(finished[fi]);
    }
    html += '</div></div>';
    return html;
  }

  // ── 監視タスク一覧 ──────────────────────────────────────────────────────────

  function loadMonitoringTasks() {
    document.getElementById('monitoringListArea').innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    var loc = getSelectedLocation();
    var qs = '?task_type=monitoring';
    if (loc === 'both') qs += '&location=both';
    else if (loc) qs += '&location=' + encodeURIComponent(loc);

    loadCatList().then(function () {
      return fetch(API_BASE + '/tasks' + qs, { headers: apiHeaders(), cache: 'no-store' });
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          document.getElementById('monitoringListArea').innerHTML = '<div class="empty-msg">エラー</div>';
          return;
        }
        var tasks = data.tasks || [];
        if (tasks.length === 0) {
          document.getElementById('monitoringListArea').innerHTML = '<div class="empty-msg">監視タスクなし</div>';
          return;
        }

        var html = '';
        for (var i = 0; i < tasks.length; i++) {
          var t = tasks[i];
          var st = t.status || 'pending';
          var tidStr = String(t.cat_id || '');
          var inList = false;
          var cj;
          html += '<div class="monitoring-section">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">';
          html += '<div style="font-size:14px;font-weight:600;flex:1;min-width:0;">';
          if (t.cat_name) html += '<span style="color:#a78bfa;">' + escapeHtml(t.cat_name) + '</span> ';
          html += escapeHtml(t.title);
          html += '</div>';
          html += '<select class="monitoring-status-select" data-task-id="' + t.id + '" data-current="' + st + '" onchange="changeMonitoringTaskStatus(this)" style="font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);max-width:120px;">';
          html += '<option value="pending"' + (st === 'pending' ? ' selected' : '') + '>監視中</option>';
          html += '<option value="done"' + (st === 'done' ? ' selected' : '') + '>解決済</option>';
          html += '<option value="skipped"' + (st === 'skipped' ? ' selected' : '') + '>スキップ</option>';
          html += '</select>';
          html += '</div>';
          html += '<div style="margin-top:8px;font-size:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;">';
          html += '<span class="dim" style="white-space:nowrap;">対象猫</span>';
          html += '<select class="monitoring-cat-select" data-task-id="' + t.id + '" data-prev-cat="' + escAttr(tidStr) + '" onchange="changeMonitoringTaskCat(this)" style="flex:1;min-width:160px;max-width:100%;font-size:12px;padding:6px 8px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);">';
          html += '<option value="">共通（猫なし）</option>';
          for (cj = 0; cj < catList.length; cj++) {
            var cx = catList[cj];
            var sel = String(cx.id) === tidStr ? ' selected' : '';
            if (sel) { inList = true; }
            html += '<option value="' + cx.id + '"' + sel + '>' + escapeHtml(cx.name) + '</option>';
          }
          if (tidStr && !inList) {
            html += '<option value="' + escAttr(tidStr) + '" selected>' + escapeHtml(t.cat_name || ('ID ' + tidStr)) + '（他拠点）</option>';
          }
          html += '</select></div>';
          if (t.expires_at) {
            html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">期限: ' + escapeHtml(t.expires_at) + '</div>';
          }
          if (t.note) {
            html += '<div class="task-note-preview" style="margin-top:6px;">' + escapeHtml(t.note) + '</div>';
          }
          html += '<div class="task-actions-row" style="margin-top:6px;">';
          html += '<button class="task-action-btn" onclick="openNoteModal(' + t.id + ',' + (t.cat_id ? 'true' : 'false') + ')">メモ追記</button>';
          html += '</div>';
          html += '</div>';
        }
        document.getElementById('monitoringListArea').innerHTML = html;
      })
      .catch(function () {
        document.getElementById('monitoringListArea').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
      });
  }

  /** 監視タスクのステータス変更（PUT /tasks/:id/status） */
  window.changeMonitoringTaskStatus = function (sel) {
    var taskId = parseInt(sel.getAttribute('data-task-id'), 10);
    var prev = sel.getAttribute('data-current') || 'pending';
    var newStatus = sel.value;
    if (newStatus === prev) return;

    function revert() {
      sel.value = prev;
    }

    var body = { status: newStatus };
    if (newStatus === 'skipped' && prev !== 'skipped') {
      var r = window.prompt('スキップ理由（空欄でOK、キャンセルで戻す）', '');
      if (r === null) {
        revert();
        return;
      }
      if (r && String(r).trim()) body.reason = String(r).trim();
    }

    fetch(API_BASE + '/tasks/' + taskId + '/status', {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          alert(data.message || data.error);
          revert();
          return;
        }
        sel.setAttribute('data-current', newStatus);
        showToast('ステータスを更新しました');
        loadMonitoringTasks();
      })
      .catch(function () {
        alert('更新に失敗しました');
        revert();
      });
  };

  /** 監視タスクの猫紐付け（PUT /tasks/:id body: { cat_id }） */
  window.changeMonitoringTaskCat = function (sel) {
    var taskId = parseInt(sel.getAttribute('data-task-id'), 10);
    var prev = sel.getAttribute('data-prev-cat') || '';
    var v = sel.value;
    if (v === prev) return;

    function revert() {
      sel.value = prev;
    }

    var payload = { cat_id: v === '' ? null : parseInt(v, 10) };
    if (payload.cat_id !== null && isNaN(payload.cat_id)) {
      revert();
      return;
    }

    fetch(API_BASE + '/tasks/' + taskId, {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          alert(data.message || data.error);
          revert();
          return;
        }
        sel.setAttribute('data-prev-cat', v);
        showToast('対象猫を更新しました');
        loadMonitoringTasks();
      })
      .catch(function () {
        alert('更新に失敗しました');
        revert();
      });
  };

  // ── タスク完了 / スキップ ────────────────────────────────────────────────────

  window.toggleTask = function (taskId, currentStatus) {
    if (currentStatus === 'done' || currentStatus === 'skipped') {
      if (!confirm('この操作を取り消して「未完了」に戻しますか？')) return;
      fetch(API_BASE + '/tasks/' + taskId + '/undo', {
        method: 'POST',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({}),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        showToast('取り消しました');
        loadTasks();
      }).catch(function () { alert('取り消しに失敗しました'); });
      return;
    }

    fetch(API_BASE + '/tasks/' + taskId + '/done', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({}),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error === 'already_completed') {
        showToast((data.completed_by || '他のスタッフ') + ' が完了済みです');
        loadTasks();
        return;
      }
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadTasks();
    }).catch(function () {
      alert('タスクの更新に失敗しました');
    });
  };

  // ── スキップ理由モーダル ────────────────────────────────────────────────────

  window.openSkipModal = function (taskId) {
    document.getElementById('skipTaskId').value = taskId;
    document.getElementById('skipReasonText').value = '';
    var chips = document.querySelectorAll('.skip-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('selected');
    document.getElementById('skipModal').classList.add('open');
  };

  window.closeSkipModal = function () {
    document.getElementById('skipModal').classList.remove('open');
  };

  window.selectSkipReason = function (el) {
    var chips = document.querySelectorAll('.skip-chip');
    for (var i = 0; i < chips.length; i++) chips[i].classList.remove('selected');
    el.classList.add('selected');
    document.getElementById('skipReasonText').value = el.textContent;
  };

  window.submitSkip = function () {
    var taskId = document.getElementById('skipTaskId').value;
    var reason = document.getElementById('skipReasonText').value.trim();
    var selectedChip = document.querySelector('.skip-chip.selected');
    if (!reason && selectedChip) reason = selectedChip.textContent;

    fetch(API_BASE + '/tasks/' + taskId + '/skip', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ reason: reason || null }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error === 'already_completed') {
        showToast((data.completed_by || '他のスタッフ') + ' が完了済みです');
        closeSkipModal();
        loadTasks();
        return;
      }
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeSkipModal();
      loadTasks();
    }).catch(function () {
      alert('スキップに失敗しました');
    });
  };

  // ── メモ追記 ────────────────────────────────────────────────────────────────

  window.openNoteModal = function (taskId, hasCat) {
    document.getElementById('noteTaskId').value = taskId;
    document.getElementById('noteText').value = '';
    document.getElementById('noteCatNoteGroup').style.display = hasCat ? 'block' : 'none';
    document.getElementById('noteAlsoCat').checked = true;
    document.getElementById('noteModal').classList.add('open');
  };

  window.closeNoteModal = function () {
    document.getElementById('noteModal').classList.remove('open');
  };

  window.submitNote = function () {
    var taskId = document.getElementById('noteTaskId').value;
    var text = document.getElementById('noteText').value.trim();
    if (!text) { alert('内容を入力してください'); return; }

    var alsoCat = document.getElementById('noteAlsoCat').checked;

    fetch(API_BASE + '/tasks/' + taskId + '/note', {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ note: text, also_cat_note: alsoCat }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeNoteModal();
      if (currentTab === 'monitoring') { loadMonitoringTasks(); }
      else { loadTasks(); }
    }).catch(function () {
      alert('メモの保存に失敗しました');
    });
  };

  // ── アドホックタスク追加 ─────────────────────────────────────────────────────

  window.openNewTaskModal = function (presetType) {
    document.getElementById('ntTitle').value = '';
    document.getElementById('ntNote').value = '';
    document.getElementById('ntCatId').value = '';
    document.getElementById('ntPriority').value = 'normal';
    document.getElementById('ntAttribute').value = 'cat_care';
    document.getElementById('ntScheduledDate').value = '';
    document.getElementById('ntDeadlineDate').value = '';
    document.getElementById('ntDueTime').value = '';
    document.getElementById('ntExpiresAt').value = '';
    populateStaffSelect('ntAssignedTo');

    var hint = document.getElementById('ntCatHint');

    loadCatList().then(function () {
      if (presetType === 'monitoring') {
        document.getElementById('ntTaskType').value = 'monitoring';
        document.getElementById('ntModalTitle').textContent = '+ 監視タスクを追加';
        document.getElementById('ntExpiresGroup').style.display = 'block';
        document.getElementById('ntDateGroup').style.display = 'block';
        if (document.getElementById('ntDeadlineGroup')) document.getElementById('ntDeadlineGroup').style.display = 'block';
        document.getElementById('ntTimeGroup').style.display = 'none';
        if (hint) hint.style.display = 'block';
      } else {
        document.getElementById('ntTaskType').value = 'routine';
        document.getElementById('ntModalTitle').textContent = '+ タスクを追加';
        document.getElementById('ntExpiresGroup').style.display = 'none';
        document.getElementById('ntDateGroup').style.display = 'block';
        if (document.getElementById('ntDeadlineGroup')) document.getElementById('ntDeadlineGroup').style.display = 'block';
        document.getElementById('ntTimeGroup').style.display = 'block';
        if (hint) hint.style.display = 'none';
      }
      document.getElementById('newTaskModal').classList.add('open');
    });
  };

  window.closeNewTaskModal = function () {
    document.getElementById('newTaskModal').classList.remove('open');
  };

  window.submitNewTask = function () {
    var title = document.getElementById('ntTitle').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    var taskType = document.getElementById('ntTaskType').value;
    var scheduledYmd = optionalYmdFromInput('ntScheduledDate');
    var deadlineYmd = optionalYmdFromInput('ntDeadlineDate');
    var dueTime = document.getElementById('ntDueTime').value || null;
    var expiresAt = document.getElementById('ntExpiresAt').value || null;
    var catId = document.getElementById('ntCatId').value || null;
    var noteText = document.getElementById('ntNote').value.trim() || null;

    var assignedTo = document.getElementById('ntAssignedTo').value || null;

    var payload = {
      title: title,
      attribute: document.getElementById('ntAttribute').value,
      priority: document.getElementById('ntPriority').value,
      task_type: taskType,
      cat_id: catId,
      assigned_to: assignedTo,
      scheduled_date: scheduledYmd,
      deadline_date: deadlineYmd,
      due_time: dueTime,
    };

    if (taskType === 'monitoring') {
      payload.expires_at = expiresAt;
    }

    fetch(API_BASE + '/tasks', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }

      if (noteText && data.task) {
        return fetch(API_BASE + '/tasks/' + data.task.id + '/note', {
          method: 'PUT',
          headers: apiHeaders(), cache: 'no-store',
          body: JSON.stringify({ note: noteText, also_cat_note: !!catId }),
        }).then(function () { return data; });
      }
      return data;
    }).then(function () {
      closeNewTaskModal();
      if (currentTab === 'monitoring') { loadMonitoringTasks(); }
      else { loadTasks(); }
    }).catch(function () {
      alert('タスクの追加に失敗しました');
    });
  };

  // ══════════════════════════════════════════════════════════════════════════════
  //  テンプレート
  // ══════════════════════════════════════════════════════════════════════════════

  function loadTemplates() {
    var area = document.getElementById('templateListArea');
    area.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    var loc = getSelectedLocation();
    var url = API_BASE + '/tasks/templates';
    if (loc === 'both') url += '?location=both';
    else if (loc) url += '?location=' + encodeURIComponent(loc);
    fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) {
          area.innerHTML = '<div class="empty-msg">API エラー: HTTP ' + r.status + '<br>URL: ' + url + '</div>';
          return null;
        }
        return r.json();
      })
      .then(function (data) {
        if (!data) return;
        if (data.error) {
          area.innerHTML = '<div class="empty-msg">API エラー: ' + escapeHtml(data.error) + ' / ' + escapeHtml(data.message || '') + '</div>';
          return;
        }
        var templates = data.templates || [];
        if (templates.length === 0) {
          area.innerHTML = '<div class="empty-msg">テンプレートなし</div>';
          return;
        }
        renderTemplates(templates);
      })
      .catch(function (err) {
        area.innerHTML = '<div class="empty-msg">読み込みに失敗: ' + escapeHtml(err.message) + '<br>URL: ' + escapeHtml(url) + '<br>Origin: ' + escapeHtml(API_BASE) + '</div>';
      });
  }

  function renderTemplates(templates) {
    if (templates.length === 0) {
      document.getElementById('templateListArea').innerHTML = '<div class="empty-msg">テンプレートなし</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < templates.length; i++) {
      var t = templates[i];
      var tt = t.task_type || 'routine';
      var attr = t.attribute || t.category || '';
      html += '<div class="template-item" style="cursor:pointer;" onclick="openEditTemplateModal(\'' + escapeHtml(t.id) + '\')">';
      html += '<div class="template-name">' + escapeHtml(t.title) + '</div>';
      html += '<div class="template-meta">';
      html += '<span class="task-type-badge ' + tt + '">' + taskTypeLabel(tt) + '</span>';
      html += '<span class="template-recurrence">' + escapeHtml(recurrenceLabel(t.recurrence)) + '</span> ';
      html += escapeHtml(attributeLabel(attr));
      if (t.cat_name) html += ' | ' + escapeHtml(t.cat_name);
      if (t.assigned_name) html += ' | 担当: ' + escapeHtml(t.assigned_name);
      if (t.time_slot) html += ' | ' + escapeHtml(slotLabel(t.time_slot));
      if (t.sort_order) html += ' | 順: ' + t.sort_order;
      html += '</div>';
      if (!t.active) html += '<div style="font-size:11px;color:#f87171;margin-top:4px;">無効</div>';
      html += '</div>';
    }

    document.getElementById('templateListArea').innerHTML = html;
  }

  // ── 曜日ピッカー ─────────────────────────────────────────
  window._toggleDow = function (btn) {
    btn.classList.toggle('active');
    window._syncRecurrenceHidden();
  };

  window._setDowPreset = function (preset) {
    var btns = document.querySelectorAll('#tmplWeekdayPicker .dow-btn');
    for (var i = 0; i < btns.length; i++) {
      var d = parseInt(btns[i].getAttribute('data-dow'), 10);
      if (preset === 'weekday') btns[i].classList.toggle('active', d >= 1 && d <= 5);
      else if (preset === 'weekend') btns[i].classList.toggle('active', d === 0 || d === 6);
      else if (preset === 'all') btns[i].classList.add('active');
      else if (preset === 'clear') btns[i].classList.remove('active');
    }
    window._syncRecurrenceHidden();
  };

  window._onRecurrenceTypeChange = function () {
    var type = document.getElementById('tmplRecurrenceType').value;
    document.getElementById('tmplWeekdayPicker').style.display = type === 'weekly' ? 'block' : 'none';
    document.getElementById('tmplMonthDayPicker').style.display = type === 'monthly' ? 'block' : 'none';
    window._syncRecurrenceHidden();
  };

  window._syncRecurrenceHidden = function () {
    var type = document.getElementById('tmplRecurrenceType').value;
    var hidden = document.getElementById('tmplRecurrence');
    if (type === 'daily' || type === 'once') {
      hidden.value = type;
      return;
    }
    if (type === 'weekly') {
      var btns = document.querySelectorAll('#tmplWeekdayPicker .dow-btn.active');
      var days = [];
      for (var i = 0; i < btns.length; i++) days.push(btns[i].getAttribute('data-dow'));
      hidden.value = days.length > 0 ? 'weekly:' + days.join(',') : 'daily';
      return;
    }
    if (type === 'monthly') {
      var input = document.getElementById('tmplMonthDays');
      var val = (input ? input.value : '').replace(/\s/g, '');
      hidden.value = val ? 'monthly:' + val : 'daily';
      return;
    }
  }

  function syncTemplateFormForTaskType() {
    var ttEl = document.getElementById('tmplTaskType');
    if (!ttEl) return;
    var isMon = ttEl.value === 'monitoring';
    var eg = document.getElementById('tmplExpiresGroup');
    var tg = document.getElementById('tmplTimeSlotGroup');
    if (eg) eg.style.display = isMon ? 'block' : 'none';
    if (tg) tg.style.display = isMon ? 'none' : 'block';
  }

  var tmplTaskTypeEl = document.getElementById('tmplTaskType');
  if (tmplTaskTypeEl) {
    tmplTaskTypeEl.addEventListener('change', syncTemplateFormForTaskType);
  }

  function _setRecurrenceUI(value) {
    var typeSelect = document.getElementById('tmplRecurrenceType');
    var hidden = document.getElementById('tmplRecurrence');
    hidden.value = value || 'daily';

    if (!value || value === 'daily') {
      typeSelect.value = 'daily';
    } else if (value === 'once') {
      typeSelect.value = 'once';
    } else if (value.indexOf('weekly:') === 0) {
      typeSelect.value = 'weekly';
      var days = value.replace('weekly:', '').split(',');
      var btns = document.querySelectorAll('#tmplWeekdayPicker .dow-btn');
      for (var i = 0; i < btns.length; i++) {
        var d = btns[i].getAttribute('data-dow');
        btns[i].classList.toggle('active', days.indexOf(d) !== -1);
      }
    } else if (value.indexOf('monthly:') === 0) {
      typeSelect.value = 'monthly';
      var input = document.getElementById('tmplMonthDays');
      if (input) input.value = value.replace('monthly:', '');
    } else {
      typeSelect.value = 'daily';
    }

    document.getElementById('tmplWeekdayPicker').style.display = typeSelect.value === 'weekly' ? 'block' : 'none';
    document.getElementById('tmplMonthDayPicker').style.display = typeSelect.value === 'monthly' ? 'block' : 'none';
  }

  window.openNewTemplateModal = function () {
    document.getElementById('tmplEditMode').value = '';
    document.getElementById('tmplModalTitle').textContent = '+ テンプレートを追加';
    document.getElementById('tmplIdGroup').style.display = 'block';
    document.getElementById('tmplId').value = '';
    document.getElementById('tmplId').readOnly = false;
    document.getElementById('tmplTitle').value = '';
    document.getElementById('tmplDescription').value = '';
    document.getElementById('tmplTaskType').value = 'routine';
    document.getElementById('tmplAttribute').value = 'opening';
    document.getElementById('tmplCatId').value = '';
    _setRecurrenceUI('daily');
    document.getElementById('tmplTimeSlot').value = '';
    document.getElementById('tmplPriority').value = 'normal';
    document.getElementById('tmplSortOrder').value = '0';
    document.getElementById('tmplExpiresAt').value = '';
    document.getElementById('tmplDeleteArea').style.display = 'none';
    document.getElementById('tmplSubmitBtn').textContent = '保存';
    populateStaffSelect('tmplAssignedTo');
    syncTemplateFormForTaskType();
    document.getElementById('newTemplateModal').classList.add('open');
  };

  window.openEditTemplateModal = function (templateId) {
    fetch(API_BASE + '/tasks/templates/' + encodeURIComponent(templateId), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('テンプレートが見つかりません'); return; }
        var t = data.template;
        document.getElementById('tmplEditMode').value = t.id;
        document.getElementById('tmplModalTitle').textContent = 'テンプレートを編集';
        document.getElementById('tmplIdGroup').style.display = 'block';
        document.getElementById('tmplId').value = t.id;
        document.getElementById('tmplId').readOnly = true;
        document.getElementById('tmplTitle').value = t.title || '';
        document.getElementById('tmplDescription').value = t.description || '';
        document.getElementById('tmplTaskType').value = t.task_type || 'routine';
        document.getElementById('tmplAttribute').value = t.attribute || 'opening';
        document.getElementById('tmplCatId').value = t.cat_id || '';
        _setRecurrenceUI(t.recurrence || 'daily');
        document.getElementById('tmplTimeSlot').value = t.time_slot || '';
        document.getElementById('tmplPriority').value = t.priority || 'normal';
        document.getElementById('tmplSortOrder').value = t.sort_order || 0;
        var expRaw = t.expires_at ? String(t.expires_at) : '';
        document.getElementById('tmplExpiresAt').value = expRaw.length >= 10 ? expRaw.slice(0, 10) : '';
        document.getElementById('tmplDeleteArea').style.display = 'block';
        document.getElementById('tmplSubmitBtn').textContent = '更新';
        populateStaffSelect('tmplAssignedTo');
        if (t.assigned_to) {
          document.getElementById('tmplAssignedTo').value = t.assigned_to;
        }
        syncTemplateFormForTaskType();
        document.getElementById('newTemplateModal').classList.add('open');
      })
      .catch(function () { alert('テンプレートの読み込みに失敗しました'); });
  };

  window.closeNewTemplateModal = function () {
    document.getElementById('newTemplateModal').classList.remove('open');
  };

  window.submitNewTemplate = function () {
    var editId = document.getElementById('tmplEditMode').value;
    var title = document.getElementById('tmplTitle').value.trim();
    if (!title) { alert('タイトルは必須です'); return; }

    var tmplTt = document.getElementById('tmplTaskType').value;
    var payload = {
      title: title,
      task_type: tmplTt,
      attribute: document.getElementById('tmplAttribute').value,
      cat_id: document.getElementById('tmplCatId').value || null,
      assigned_to: document.getElementById('tmplAssignedTo').value || null,
      recurrence: document.getElementById('tmplRecurrence').value,
      time_slot: document.getElementById('tmplTimeSlot').value || null,
      priority: document.getElementById('tmplPriority').value,
      sort_order: parseInt(document.getElementById('tmplSortOrder').value, 10) || 0,
      description: document.getElementById('tmplDescription').value.trim() || null,
    };
    if (tmplTt === 'monitoring') {
      var dex = (document.getElementById('tmplExpiresAt').value || '').trim();
      payload.expires_at = dex ? dex.slice(0, 10) : null;
    } else {
      payload.expires_at = null;
    }

    if (editId) {
      fetch(API_BASE + '/tasks/templates/' + encodeURIComponent(editId), {
        method: 'PUT',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeNewTemplateModal();
        showToast('テンプレートを更新しました');
        loadTemplates();
      }).catch(function () { alert('更新に失敗しました'); });
    } else {
      var id = document.getElementById('tmplId').value.trim();
      if (!id) { alert('ID は必須です'); return; }
      payload.id = id;
      fetch(API_BASE + '/tasks/templates', {
        method: 'POST',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeNewTemplateModal();
        showToast('テンプレートを追加しました');
        loadTemplates();
      }).catch(function () { alert('保存に失敗しました'); });
    }
  };

  window.deleteTemplate = function () {
    var editId = document.getElementById('tmplEditMode').value;
    if (!editId) return;
    if (!confirm('「' + document.getElementById('tmplTitle').value + '」を削除しますか？\nこの操作は元に戻せません。')) return;

    fetch(API_BASE + '/tasks/templates/' + encodeURIComponent(editId), {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeNewTemplateModal();
      showToast('テンプレートを削除しました');
      loadTemplates();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  // ── テンプレートから一括生成 ───────────────────────────────────────────────────

  window.generateFromTemplates = function () {
    var tgEl = document.getElementById('tmplGenerateDate');
    var date = (tgEl && tgEl.value) ? String(tgEl.value).slice(0, 10) : (document.getElementById('filterDate').value || todayJstYmd());
    var forceEvEl = document.getElementById('tmplForceEventDate');
    var forceEvent = forceEvEl && forceEvEl.checked;
    var msg = date + ' のタスクをテンプレートから一括生成しますか？';
    if (forceEvent) msg += '\n（イベントテンプレは繰り返しルールを無視して指定日に生成します）';
    if (!confirm(msg)) return;

    var loc = getSelectedLocation();
    var genBody = { date: date, force_event_on_date: forceEvent };
    if (loc === 'both') genBody.location_id = 'both';
    else if (loc) genBody.location_id = loc;

    fetch(API_BASE + '/tasks/templates/generate', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(genBody),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      showToast(data.generated + ' 件生成（' + data.skipped + ' 件スキップ）');
      switchTab('today');
      loadTasks();
    }).catch(function () {
      alert('生成に失敗しました');
    });
  };

  // ══════════════════════════════════════════════════════════════════════════════
  //  プロジェクト
  // ══════════════════════════════════════════════════════════════════════════════

  function loadProjects() {
    var listArea = document.getElementById('projectListArea');
    var detailArea = document.getElementById('projectDetailArea');
    var actionsArea = document.getElementById('projectListActions');
    listArea.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';
    listArea.style.display = 'block';
    detailArea.style.display = 'none';
    actionsArea.style.display = 'block';

    fetch(API_BASE + '/tasks/projects', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          listArea.innerHTML = '<div class="empty-msg">エラー</div>';
          return;
        }
        var projects = data.projects || [];
        if (projects.length === 0) {
          listArea.innerHTML = '<div class="empty-msg">プロジェクトなし</div>';
          return;
        }
        var html = '';
        for (var i = 0; i < projects.length; i++) {
          var p = projects[i];
          var pct = p.progress ? p.progress.pct : 0;
          html += '<div class="project-card" onclick="openProject(' + p.id + ')">';
          html += '<div class="project-title-row">';
          html += '<span class="icon">📁</span>';
          html += '<span class="name">' + escapeHtml(p.title) + '</span>';
          html += '</div>';
          if (p.due_date) html += '<div class="project-due">期限: ' + escapeHtml(p.due_date) + '</div>';
          html += '<div class="project-progress-row">';
          html += '<div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%"></div></div>';
          html += '<span class="pct">' + (p.progress ? p.progress.done + '/' + p.progress.total : '0/0') + '</span>';
          html += '</div>';
          html += '</div>';
        }
        listArea.innerHTML = html;
      })
      .catch(function () {
        listArea.innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
      });
  }

  window.deleteProject = function (projectId) {
    if (!confirm('このプロジェクトを削除しますか？\nノードと関連タスクもすべて削除されます。')) return;
    fetch(API_BASE + '/tasks/projects/' + projectId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      showToast('プロジェクトを削除しました');
      currentProjectId = null;
      loadProjects();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.openProject = function (projectId) {
    currentProjectId = projectId;
    var listArea = document.getElementById('projectListArea');
    var detailArea = document.getElementById('projectDetailArea');
    var actionsArea = document.getElementById('projectListActions');
    listArea.style.display = 'none';
    detailArea.style.display = 'block';
    actionsArea.style.display = 'none';

    detailArea.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    fetch(API_BASE + '/tasks/projects/' + projectId, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          detailArea.innerHTML = '<div class="empty-msg">エラー</div>';
          return;
        }
        renderProjectDetail(data.project, data.nodes || []);
      })
      .catch(function () {
        detailArea.innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
      });
  };

  function renderProjectDetail(project, nodes) {
    var html = '<button class="tree-back-btn" onclick="loadProjects()">← 一覧に戻る</button>';
    html += '<div class="tree-header">';
    html += '<h2>📁 ' + escapeHtml(project.title) + '</h2>';
    if (project.due_date) html += '<div style="font-size:12px;color:var(--text-dim);">期限: ' + escapeHtml(project.due_date) + '</div>';
    if (project.progress) {
      var pct = project.progress.pct;
      html += '<div style="font-size:12px;color:var(--text-dim);margin-top:4px;">進捗: ' + project.progress.done + '/' + project.progress.total + ' (' + pct + '%)</div>';
    }
    html += '</div>';

    html += renderNodes(nodes, true);

    html += '<div class="tree-actions">';
    html += '<button class="task-action-btn" style="padding:6px 12px;" onclick="openNewNodeModal(' + project.id + ',null)">+ 思考/タスクを追加</button>';
    html += '<button class="task-action-btn" style="padding:6px 12px;color:#f87171;" onclick="deleteProject(' + project.id + ')">🗑 プロジェクト削除</button>';
    html += '</div>';

    document.getElementById('projectDetailArea').innerHTML = html;
  }

  function renderNodes(nodes, isRoot) {
    var html = '';
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var isThought = n.node_type === 'thought';
      var icon = isThought ? '💭' : (n.status === 'done' ? '☑' : '☐');
      var titleClass = n.status === 'done' ? ' done' : '';

      html += '<div class="tree-node' + (isRoot ? ' tree-node-root' : '') + '">';
      html += '<div class="tree-node-item">';
      if (!isThought) {
        html += '<span class="node-icon" onclick="toggleProjectNode(' + n.project_id + ',' + n.id + ',\'' + n.status + '\')" style="cursor:pointer;">' + icon + '</span>';
      } else {
        html += '<span class="node-icon">' + icon + '</span>';
      }
      html += '<div style="flex:1;min-width:0;">';
      html += '<span class="node-title' + titleClass + '">' + escapeHtml(n.title) + '</span>';
      var meta = [];
      if (n.assigned_name) meta.push('@' + n.assigned_name);
      if (n.due_date) meta.push('〜' + n.due_date);
      if (n.status === 'resolved') meta.push('解決済');
      if (meta.length > 0) html += ' <span class="node-meta">' + escapeHtml(meta.join(' ')) + '</span>';
      if (n.body) html += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + escapeHtml(n.body.length > 100 ? n.body.slice(0, 100) + '...' : n.body) + '</div>';
      html += '</div>';
      html += '<span class="tree-node-toggle" onclick="openNewNodeModal(' + n.project_id + ',' + n.id + ')">+</span>';
      html += '</div>';

      if (n.children && n.children.length > 0) {
        html += renderNodes(n.children, false);
      }
      html += '</div>';
    }
    return html;
  }

  window.toggleProjectNode = function (projectId, nodeId, currentStatus) {
    if (currentStatus === 'done' || currentStatus === 'skipped') return;
    var newStatus = 'done';

    fetch(API_BASE + '/tasks/projects/' + projectId + '/nodes/' + nodeId, {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ status: newStatus }),
    }).then(function (r) { return r.json(); })
    .then(function () { openProject(projectId); })
    .catch(function () { alert('更新に失敗しました'); });
  };

  // ── プロジェクト作成 ────────────────────────────────────────────────────────

  window.openNewProjectModal = function () {
    document.getElementById('npTitle').value = '';
    document.getElementById('npDescription').value = '';
    document.getElementById('npDueDate').value = '';
    document.getElementById('newProjectModal').classList.add('open');
  };

  window.closeNewProjectModal = function () {
    document.getElementById('newProjectModal').classList.remove('open');
  };

  window.submitNewProject = function () {
    var title = document.getElementById('npTitle').value.trim();
    if (!title) { alert('プロジェクト名を入力してください'); return; }

    fetch(API_BASE + '/tasks/projects', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({
        title: title,
        description: document.getElementById('npDescription').value.trim() || null,
        due_date: document.getElementById('npDueDate').value || null,
      }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeNewProjectModal();
      loadProjects();
    }).catch(function () {
      alert('プロジェクトの作成に失敗しました');
    });
  };

  // ── ノード追加 ──────────────────────────────────────────────────────────────

  window.openNewNodeModal = function (projectId, parentId) {
    document.getElementById('nnProjectId').value = projectId;
    document.getElementById('nnParentId').value = parentId || '';
    document.getElementById('nnNodeType').value = 'thought';
    document.getElementById('nnTitle').value = '';
    document.getElementById('nnBody').value = '';
    document.getElementById('nnDueDate').value = '';
    document.getElementById('nnPriority').value = 'normal';
    document.getElementById('nnTaskFields').style.display = 'none';
    populateStaffSelect('nnAssignedTo');
    document.getElementById('nnModalTitle').textContent = parentId ? '+ 子ノードを追加' : '+ ノードを追加';
    document.getElementById('newNodeModal').classList.add('open');
  };

  window.closeNewNodeModal = function () {
    document.getElementById('newNodeModal').classList.remove('open');
  };

  window.toggleNodeFields = function () {
    var isTask = document.getElementById('nnNodeType').value === 'task';
    document.getElementById('nnTaskFields').style.display = isTask ? 'block' : 'none';
  };

  window.submitNewNode = function () {
    var projectId = document.getElementById('nnProjectId').value;
    var title = document.getElementById('nnTitle').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    var nodeType = document.getElementById('nnNodeType').value;
    var parentId = document.getElementById('nnParentId').value || null;
    if (parentId) parentId = parseInt(parentId, 10);

    var payload = {
      node_type: nodeType,
      title: title,
      body: document.getElementById('nnBody').value.trim() || null,
      parent_id: parentId,
    };

    if (nodeType === 'task') {
      payload.assigned_to = document.getElementById('nnAssignedTo').value || null;
      payload.due_date = document.getElementById('nnDueDate').value || null;
      payload.priority = document.getElementById('nnPriority').value;
    }

    fetch(API_BASE + '/tasks/projects/' + projectId + '/nodes', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeNewNodeModal();
      openProject(parseInt(projectId, 10));
    }).catch(function () {
      alert('ノードの追加に失敗しました');
    });
  };

  // ══════════════════════════════════════════════════════════════════════════════
  //  ユーティリティ
  // ══════════════════════════════════════════════════════════════════════════════

  function slotLabel(slot) {
    var labels = { morning: '朝', afternoon: '昼', evening: '夕' };
    return labels[slot] || slot || '';
  }

  function attributeLabel(attr) {
    var labels = {
      opening: '🌅 開店準備', event: '📅 イベント', closing: '🌙 閉店作業', cat_care: '🐱 猫ケア',
      cleaning: '🧹 清掃', medical: '💊 医療', project: '📁 プロジェクト', other: '📋 その他',
      daily_open: '開店', daily_close: '閉店',
    };
    return labels[attr] || attr || '';
  }

  function taskTypeLabel(tt) {
    var labels = { routine: 'ルーティン', event: 'イベント', monitoring: '監視' };
    return labels[tt] || tt || '';
  }

  function recurrenceLabel(r) {
    if (!r) return '';
    if (r === 'daily') return '毎日';
    if (r === 'once') return '1回';
    if (r.indexOf('weekly:') === 0) {
      var days = r.replace('weekly:', '').split(',');
      var dayNames = ['日', '月', '火', '水', '木', '金', '土'];
      return '毎週' + days.map(function (d) { return dayNames[parseInt(d, 10)] || d; }).join('・');
    }
    if (r.indexOf('monthly:') === 0) {
      return '毎月 ' + r.replace('monthly:', '') + '日';
    }
    return r;
  }

  /** HTML属性用エスケープ（data-* / value 用。未定義だと監視タブで例外になる） */
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 3000);
  }

  // ══════════════════════════════════════════════════════════════════════════════
  //  業務終了フロー
  // ══════════════════════════════════════════════════════════════════════════════

  var closeDayData = null;

  window.startCloseDay = function () {
    var loc = getSelectedLocation();
    if (!loc || loc === 'both') {
      alert('業務終了する拠点を選択してください（「全拠点」では実行できません）');
      return;
    }

    var date = document.getElementById('filterDate').value || todayJstYmd();
    var url = API_BASE + '/tasks/close-day/preview?location=' + encodeURIComponent(loc) + '&date=' + encodeURIComponent(date);

    fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error === 'already_closed') {
          alert(data.message || '本日はすでに業務終了済みです');
          return;
        }
        if (data.error) {
          alert('エラー: ' + (data.message || data.error));
          return;
        }
        closeDayData = data;
        renderCloseDayModal(data);
      })
      .catch(function (err) {
        alert('プレビュー取得に失敗: ' + err.message);
      });
  };

  function renderCloseDayExcretionBlock(exc) {
    var el = document.getElementById('closeDayExcretionBlock');
    if (!el) return;
    if (!exc) {
      el.innerHTML = '';
      return;
    }
    function fmtMd(ymd) {
      if (!ymd || ymd.length < 10) return '';
      return parseInt(ymd.slice(5, 7), 10) + '/' + parseInt(ymd.slice(8, 10), 10);
    }
    function sectionHtml(title, emoji, gaps) {
      var h = '<div style="margin-bottom:10px;padding:8px;background:var(--surface-alt);border-radius:8px;border-left:3px solid #fb923c;">';
      h += '<div style="font-weight:700;margin-bottom:6px;">' + emoji + ' ' + title + '</div>';
      var arr = gaps || [];
      if (arr.length === 0) {
        h += '<div style="color:#4ade80;font-size:12px;">該当なし</div>';
      } else {
        h += '<ul style="margin:0;padding-left:18px;line-height:1.55;">';
        for (var i = 0; i < arr.length; i++) {
          var g = arr[i];
          h += '<li>';
          h += escapeHtml(g.cat_name || '');
          if (g.no_record) h += ' — <span style="color:#f87171;">記録なし</span>';
          else {
            h += ' — 最終 <span style="color:var(--text-dim);">' + escapeHtml(fmtMd(g.last_record_date)) + '</span> ';
            h += '<strong style="color:#f97316;">経過' + (g.days_since_last != null ? g.days_since_last : '') + '日</strong>';
          }
          h += '</li>';
        }
        h += '</ul>';
      }
      h += '</div>';
      return h;
    }
    el.innerHTML =
      sectionHtml('排便（2日以上未記録）', '💩', exc.stool_gaps) +
      sectionHtml('排尿（2日以上未記録）', '🚽', exc.urine_gaps);
  }

  function renderCloseDayWeightBlock(wloss) {
    var el = document.getElementById('closeDayWeightBlock');
    if (!el) return;
    if (!wloss) {
      el.innerHTML = '';
      return;
    }
    var items = wloss.items || [];
    var h = '<div style="margin-bottom:10px;padding:8px;background:var(--surface-alt);border-radius:8px;border-left:3px solid #38bdf8;">';
    h += '<div style="font-weight:700;margin-bottom:6px;">⚖️ 体重低下（30日比・Slackレポートに含みます）</div>';
    h += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.45;">' + escapeHtml(wloss.basis || '') + '</div>';
    if (items.length === 0) {
      h += '<div style="color:#4ade80;font-size:12px;">該当なし（約5%未満の減少、または栄養プロフィールなし）</div>';
    } else {
      h += '<ul style="margin:0;padding-left:18px;line-height:1.55;">';
      for (var wi = 0; wi < items.length; wi++) {
        var wit = items[wi];
        var tag = wit.severity === 'critical' ? '急減' : wit.severity === 'severe' ? '顕著' : '注意';
        var col = wit.severity === 'critical' ? '#f87171' : wit.severity === 'severe' ? '#f97316' : '#eab308';
        var kgTxt = '';
        var wa = wit.weight_30d_ago_kg;
        var wb = wit.last_weight_kg;
        if (wa != null && wb != null) {
          kgTxt = '（' + wa + '→' + wb + 'kg）';
        } else if (wb != null) {
          kgTxt = '（現在 ' + wb + 'kg）';
        }
        h += '<li><strong>' + escapeHtml(wit.cat_name || '') + '</strong> <span style="color:' + col + ';font-weight:700;">' + wit.weight_trend_pct + '%</span> <span style="font-size:11px;color:var(--text-dim);">' + tag + '</span> ' + escapeHtml(kgTxt) + '</li>';
      }
      h += '</ul>';
    }
    h += '</div>';
    el.innerHTML = h;
  }

  function renderCloseDayAppetiteBlock(appet) {
    var el = document.getElementById('closeDayAppetiteBlock');
    if (!el) return;
    if (!appet) {
      el.innerHTML = '';
      return;
    }
    var aItems = appet.items || [];
    var h = '<div style="margin-bottom:10px;padding:8px;background:var(--surface-alt);border-radius:8px;border-left:3px solid #f472b6;">';
    h += '<div style="font-weight:700;margin-bottom:6px;">🍽️ 食欲スコア低下（健康スコア・Slackレポートに含みます）</div>';
    h += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.45;">' + escapeHtml(appet.basis || '') + '</div>';
    if (appet.reference_date) {
      h += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">業務終了日: ' + escapeHtml(String(appet.reference_date)) + '</div>';
    }
    if (aItems.length === 0) {
      h += '<div style="color:#4ade80;font-size:12px;">該当なし（全頭75点以上、またはスコア未作成）</div>';
    } else {
      h += '<ul style="margin:0;padding-left:18px;line-height:1.55;">';
      for (var ai = 0; ai < aItems.length; ai++) {
        var ait = aItems[ai];
        var atag = ait.severity === 'critical' ? '不振' : ait.severity === 'severe' ? '低下' : 'やや低下';
        var acol = ait.severity === 'critical' ? '#f87171' : ait.severity === 'severe' ? '#f97316' : '#eab308';
        var ad = ait.score_date ? String(ait.score_date).slice(0, 10) : '';
        var adpart = ad ? ' <span style="font-size:11px;color:var(--text-dim);">' + escapeHtml(ad) + '</span>' : '';
        var atot = ait.total_score != null ? ' 総合' + ait.total_score + '点' : '';
        h += '<li><strong>' + escapeHtml(ait.cat_name || '') + '</strong> 食欲<span style="color:' + acol + ';font-weight:700;"> ' + ait.appetite_score + '点</span> <span style="font-size:11px;color:var(--text-dim);">' + atag + '</span>' + atot + adpart + '</li>';
      }
      h += '</ul>';
    }
    h += '</div>';
    el.innerHTML = h;
  }

  function renderCloseDayModal(data) {
    document.getElementById('closeDayLocationLabel').textContent = data.location_label + '  ' + data.date;

    var s = data.stats;
    var pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
    var sbtForCount = data.skipped_before_tasks || [];
    var skippedBeforeN = Math.max(s.skipped_before_close != null ? s.skipped_before_close : 0, sbtForCount.length);
    var pendForStat = (data.pending_tasks || []).length;
    var pendingDisp = Math.max(s.pending != null ? s.pending : 0, pendForStat);
    var evOpen = (data.ongoing_event_tasks && data.ongoing_event_tasks.length) ? data.ongoing_event_tasks.length : 0;
    document.getElementById('closeDayStats').innerHTML =
      '✅ 完了: <strong>' + s.done + '/' + s.total + '</strong>（' + pct + '%）' +
      (skippedBeforeN > 0 ? '　⏭️ 事前スキップ済: <strong>' + skippedBeforeN + '</strong>件' : '') +
      '　⏳ 今回の繰越予定: <strong>' + pendingDisp + '</strong>件' +
      (evOpen ? '　📅 追跡中イベント: <strong>' + evOpen + '</strong>件' : '');

    renderCloseDayExcretionBlock(data.excretion_close_day);
    renderCloseDayWeightBlock(data.weight_loss_close_day);
    renderCloseDayAppetiteBlock(data.appetite_low_close_day);

    var listArea = document.getElementById('closeDayPendingList');
    var parts = [];
    var oev = data.ongoing_event_tasks || [];
    if (oev.length > 0) {
      var evHint = (data.event_tasks_note || 'イベントは業務終了でスキップされません。タスク画面から完了／スキップしてください。');
      parts.push('<div style="font-size:11px;color:#d8b4fe;background:rgba(91,33,182,0.15);border-radius:8px;padding:10px;margin-bottom:10px;line-height:1.45;">' + escapeHtml(evHint) + '</div>');
      parts.push('<div style="font-size:12px;font-weight:700;margin-bottom:6px;color:#c4b5fd;">📅 継続追跡中のイベント（今日までに期限・未解決）</div>');
      parts.push('<ul style="margin:0 0 12px 0;padding-left:18px;line-height:1.5;font-size:12px;max-height:28vh;overflow-y:auto;">');
      for (var ei = 0; ei < oev.length; ei++) {
        var et = oev[ei];
        var due = et.due_date ? String(et.due_date).slice(0, 10) : '';
        var dueL = due.length === 10 ? (parseInt(due.slice(5, 7), 10) + '/' + parseInt(due.slice(8, 10), 10)) : '—';
        var dn = et.event_days_open != null && et.event_days_open > 0 ? ' <strong style="color:#f97316;">未解決' + et.event_days_open + '日</strong>' : '';
        parts.push('<li>' + escapeHtml(et.title || '') + ' <span style="color:var(--text-dim);">（期限 ' + escapeHtml(dueL) + '）</span>' + dn + '</li>');
      }
      parts.push('</ul>');
    }
    var sbt = data.skipped_before_tasks || [];
    if (sbt.length > 0) {
      parts.push('<div style="font-size:12px;font-weight:700;margin-bottom:6px;color:#94a3b8;">⏭️ 本日すでにスキップ済み（業務終了の自動スキップ対象外・Slackレポートに記載）</div>');
      parts.push('<ul style="margin:0 0 12px 0;padding-left:18px;line-height:1.5;font-size:12px;max-height:22vh;overflow-y:auto;">');
      for (var bi = 0; bi < sbt.length; bi++) {
        var bt = sbt[bi];
        var br = bt.skip_reason && String(bt.skip_reason).trim() ? String(bt.skip_reason).trim() : '（理由未記録）';
        var bst = (bt.skip_streak > 0) ? ' <span class="streak-warn">⚠ ' + bt.skip_streak + '日連続</span>' : '';
        parts.push('<li><strong>' + escapeHtml(bt.title || '') + '</strong>' + bst + '<br><span style="color:var(--text-dim);font-size:11px;">理由: ' + escapeHtml(br) + '</span></li>');
      }
      parts.push('</ul>');
    }
    var pendingList = data.pending_tasks || [];
    if (pendingList.length === 0) {
      parts.push('<div style="text-align:center;color:#4ade80;font-size:14px;padding:16px 20px;">🎉 繰越が必要なルーティン未完了はありません</div>');
      listArea.innerHTML = parts.join('');
    } else {
      var html = parts.join('');
      html += '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">以下は業務終了でスキップされ翌日に繰り越されます。スキップ理由を選択してください:</div>';
      for (var i = 0; i < pendingList.length; i++) {
        var t = pendingList[i];
        var streakHtml = (t.skip_streak > 0) ? '<span class="streak-warn">⚠ ' + t.skip_streak + '日連続</span>' : '';
        html += '<div class="close-day-task" data-task-id="' + t.id + '">';
        html += '<div class="close-day-task-title">' + escapeHtml(t.title) + streakHtml + '</div>';
        html += '<select class="close-day-reason-select" onchange="toggleCloseDayFreeText(this)">';
        html += '<option value="店休日">店休日</option>';
        html += '<option value="時間不足">時間不足</option>';
        html += '<option value="材料不足">材料不足</option>';
        html += '<option value="__other">その他（自由入力）</option>';
        html += '</select>';
        html += '<input type="text" class="close-day-reason-text" placeholder="理由を入力...">';
        html += '</div>';
      }
      listArea.innerHTML = html;
    }

    document.getElementById('closeDayNotes').value = '';
    document.getElementById('closeDayPreviewArea').style.display = 'none';
    document.getElementById('closeDayPreviewBtn').style.display = '';
    document.getElementById('closeDayConfirmBtn').style.display = 'none';
    document.getElementById('closeDayModal').classList.add('open');
  }

  window.toggleCloseDayFreeText = function (sel) {
    var textInput = sel.parentElement.querySelector('.close-day-reason-text');
    textInput.style.display = (sel.value === '__other') ? 'block' : 'none';
  };

  window.previewCloseDay = function () {
    var lines = [];
    var CLOSE_PREVIEW_MAX = 20;
    var locationLabel = closeDayData.location_label;
    var s = closeDayData.stats;
    var pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;

    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('📋 ' + locationLabel + ' 日次業務レポート');
    lines.push(closeDayData.date + '  報告者: ' + (credentials.staffName || credentials.staffId));
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('✅ タスク完了状況');
    lines.push('  完了: ' + s.done + '/' + s.total + '（' + pct + '%）※分母は事前スキップ除く当日ルーティン');
    var sbClose = s.skipped_before_close != null ? s.skipped_before_close : 0;
    var sbtPrev = closeDayData.skipped_before_tasks || [];
    var sbHead = Math.max(sbClose, sbtPrev.length);
    if (sbHead > 0) {
      lines.push('  事前スキップ済: ' + sbHead + '件（レポートに項目名・理由付きで含みます）');
      for (var bp = 0; bp < sbtPrev.length && bp < CLOSE_PREVIEW_MAX; bp++) {
        var btp = sbtPrev[bp];
        var brp = btp.skip_reason && String(btp.skip_reason).trim() ? String(btp.skip_reason).trim() : '（理由未記録）';
        lines.push('    • ' + (btp.title || '') + ' — 理由: ' + brp);
      }
      if (sbtPrev.length > CLOSE_PREVIEW_MAX) lines.push('    … 他' + (sbtPrev.length - CLOSE_PREVIEW_MAX) + '件');
    }
    var pendN = (closeDayData.pending_tasks || []).length;
    lines.push('  業務終了でスキップ予定（繰越）: ' + (pendN > 0 ? pendN : (s.pending != null ? s.pending : 0)) + '件');
    var oev2 = closeDayData.ongoing_event_tasks || [];
    if (oev2.length > 0) {
      lines.push('  ※ イベント ' + oev2.length + '件は業務終了では閉じず、タスク一覧で継続表示されます');
    }
    lines.push('');

    var medPrev = closeDayData.medication_close_day;
    if (medPrev) {
      lines.push('💊 本日の投薬（未完了）');
      if (!medPrev.total) {
        lines.push('  当日分の投薬スケジュールはありません');
      } else {
        var medPct = medPrev.total > 0 ? Math.round((medPrev.done / medPrev.total) * 100) : 0;
        lines.push('  予定: ' + medPrev.total + '件 / 完了: ' + medPrev.done + '件（' + medPct + '%）');
        if (medPrev.skipped > 0) lines.push('  スキップ済: ' + medPrev.skipped + '件');
        var pitems = medPrev.pending_items || [];
        for (var pi = 0; pi < pitems.length && pi < CLOSE_PREVIEW_MAX; pi++) {
          var pit = pitems[pi];
          lines.push('  • ' + pit.cat_name + ' — ' + pit.slot_label + ' ' + pit.medicine_name + '（未）');
        }
        if (pitems.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (pitems.length - CLOSE_PREVIEW_MAX) + '件');
        if (pitems.length === 0) lines.push('  未完了の投薬はありません');
      }
      lines.push('');
    }
    var feedPrev = closeDayData.feeding_close_day;
    if (feedPrev) {
      lines.push('🍚 本日のごはん（未完了・要確認）');
      if (!feedPrev.plan_count) {
        lines.push('  有効な献立がありません');
      } else {
        lines.push('  献立 ' + feedPrev.plan_count + '行のうち、未完了: ' + feedPrev.incomplete_count + '件');
        var fi = feedPrev.incomplete_items || [];
        for (var qi = 0; qi < fi.length && qi < CLOSE_PREVIEW_MAX; qi++) {
          var q = fi[qi];
          lines.push('  • ' + q.cat_name + ' — ' + q.slot_label + '（' + q.detail + '）');
        }
        if (fi.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (fi.length - CLOSE_PREVIEW_MAX) + '件');
        if (fi.length === 0) lines.push('  献立に対する未記録・未確認はありません');
      }
      lines.push('');
    }

    function previewFmtMd(ymd) {
      if (!ymd || ymd.length < 10) return '';
      return parseInt(ymd.slice(5, 7), 10) + '/' + parseInt(ymd.slice(8, 10), 10);
    }
    var excPrev = closeDayData.excretion_close_day;
    if (excPrev) {
      lines.push('💩 排便（2日以上記録なし・遅れ）');
      var sg3 = excPrev.stool_gaps || [];
      if (sg3.length === 0) {
        lines.push('  該当なし');
      } else {
        for (var sx = 0; sx < sg3.length && sx < CLOSE_PREVIEW_MAX; sx++) {
          var gx = sg3[sx];
          if (gx.no_record) lines.push('  • ' + gx.cat_name + ' — 記録なし');
          else lines.push('  • ' + gx.cat_name + ' — 最終 ' + previewFmtMd(gx.last_record_date) + '（経過' + gx.days_since_last + '日）');
        }
        if (sg3.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (sg3.length - CLOSE_PREVIEW_MAX) + '頭');
      }
      lines.push('');
      lines.push('🚽 排尿（2日以上記録なし・遅れ）');
      var ug3 = excPrev.urine_gaps || [];
      if (ug3.length === 0) {
        lines.push('  該当なし');
      } else {
        for (var ux = 0; ux < ug3.length && ux < CLOSE_PREVIEW_MAX; ux++) {
          var vx = ug3[ux];
          if (vx.no_record) lines.push('  • ' + vx.cat_name + ' — 記録なし');
          else lines.push('  • ' + vx.cat_name + ' — 最終 ' + previewFmtMd(vx.last_record_date) + '（経過' + vx.days_since_last + '日）');
        }
        if (ug3.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (ug3.length - CLOSE_PREVIEW_MAX) + '頭');
      }
      lines.push('');
    }

    var vomPrev = closeDayData.vomiting_close_day;
    if (vomPrev) {
      lines.push('🤮 はき戻し（嘔吐・関連観察）');
      var vpc = vomPrev.per_cat || [];
      var vr = '';
      if (vomPrev.week_start && vomPrev.week_end && String(vomPrev.week_start).length >= 10 && String(vomPrev.week_end).length >= 10) {
        vr = previewFmtMd(vomPrev.week_start) + '〜' + previewFmtMd(vomPrev.week_end);
      }
      if (vpc.length === 0) {
        lines.push('  直近7日間' + (vr ? '（' + vr + '）' : '') + '：記録なし');
        lines.push('  本日の記録：なし');
      } else {
        lines.push('  直近7日間' + (vr ? '（' + vr + '）' : '') + ' 猫別・記録件数');
        for (var vi = 0; vi < vpc.length && vi < CLOSE_PREVIEW_MAX; vi++) {
          var vc = vpc[vi];
          lines.push('  • ' + vc.cat_name + ': ' + vc.week_count + '件（' + vc.distinct_days + '日に記録）');
        }
        if (vpc.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (vpc.length - CLOSE_PREVIEW_MAX) + '頭');
        var vToday = [];
        for (var vj = 0; vj < vpc.length; vj++) {
          var vcat = vpc[vj];
          if (vcat.today_count > 0) {
            var vt = vcat.cat_name + '（' + vcat.today_count + '件）';
            if (vcat.streak_ending_close >= 2) {
              vt += ' — ' + vcat.streak_ending_close + '日連続（終了日まで）';
              var vsd = vcat.streak_dates_ymd || [];
              if (vsd.length >= 2) {
                vt += ' ' + previewFmtMd(vsd[0]) + '〜' + previewFmtMd(vsd[vsd.length - 1]);
              }
            }
            vToday.push(vt);
          }
        }
        if (vToday.length > 0) {
          lines.push('  本日はき戻し記録あり:');
          for (var vk = 0; vk < vToday.length && vk < CLOSE_PREVIEW_MAX; vk++) {
            lines.push('    • ' + vToday[vk]);
          }
          if (vToday.length > CLOSE_PREVIEW_MAX) lines.push('    … 他' + (vToday.length - CLOSE_PREVIEW_MAX) + '頭');
        } else {
          lines.push('  本日はき戻し記録あり: なし');
        }
      }
      lines.push('');
    }

    var clinPrev = closeDayData.clinic_close_day;
    if (clinPrev) {
      lines.push('🏥 病院・予定（今後14日以内の next_due）');
      if (!clinPrev.active_cat_count) {
        lines.push('  在籍対象の猫がありません');
      } else {
        var cws = clinPrev.window_label_start;
        var cwe = clinPrev.window_label_end;
        var cwr = '';
        if (cws && cwe && String(cws).length >= 10 && String(cwe).length >= 10) {
          cwr = previewFmtMd(cws) + '〜' + previewFmtMd(cwe);
        }
        var cup = clinPrev.upcoming || [];
        if (cup.length === 0) {
          lines.push('  ' + (cwr ? '（' + cwr + '）' : '') + ' 期間内の予定日登録なし');
        } else {
          lines.push('  予定 ' + (cwr || ''));
          for (var ci = 0; ci < cup.length && ci < CLOSE_PREVIEW_MAX; ci++) {
            var cu = cup[ci];
            var cln = '  • ' + cu.cat_name + ' — ' + cu.type_label + ' ' + previewFmtMd(cu.next_due);
            if (cu.days_from_close != null && cu.days_from_close >= 0) cln += '（あと' + cu.days_from_close + '日）';
            if (!cu.booked_date || String(cu.booked_date).trim() === '') cln += ' ⚠予約枠未記入';
            if (cu.value_short) cln += ' — ' + cu.value_short;
            lines.push(cln);
          }
          if (cup.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (cup.length - CLOSE_PREVIEW_MAX) + '件');
          var uwc = clinPrev.upcoming_without_booking_count || 0;
          if (uwc > 0) lines.push('  ※ booked_date 未記入: ' + uwc + '件');
        }
        var cnf = clinPrev.cats_without_future_due || [];
        if (cnf.length > 0) {
          lines.push('  本日以降の next_due 未登録の猫:');
          for (var cj = 0; cj < cnf.length && cj < CLOSE_PREVIEW_MAX; cj++) {
            lines.push('    • ' + cnf[cj].cat_name);
          }
          if (cnf.length > CLOSE_PREVIEW_MAX) lines.push('    … 他' + (cnf.length - CLOSE_PREVIEW_MAX) + '頭');
        } else {
          lines.push('  本日以降の next_due 未登録の猫: なし');
        }
        lines.push('  本日の病院記録:');
        var crt = clinPrev.clinic_records_today || [];
        if (crt.length === 0) {
          lines.push('    なし');
        } else {
          for (var ck = 0; ck < crt.length && ck < CLOSE_PREVIEW_MAX; ck++) {
            var cr = crt[ck];
            var crl = '    • ' + cr.cat_name + ' — ' + cr.type_label + (cr.value_short ? ' — ' + cr.value_short : '');
            if (cr.next_due) crl += ' /次回 ' + previewFmtMd(cr.next_due);
            lines.push(crl);
          }
          if (crt.length > CLOSE_PREVIEW_MAX) lines.push('    … 他' + (crt.length - CLOSE_PREVIEW_MAX) + '件');
        }
        lines.push('  本日付け注意事項:');
        var cnt = clinPrev.cat_notes_today || [];
        if (cnt.length === 0) {
          lines.push('    なし');
        } else {
          for (var cq = 0; cq < cnt.length && cq < CLOSE_PREVIEW_MAX; cq++) {
            var cqn = cnt[cq];
            lines.push('    • ' + cqn.cat_name + ' [' + (cqn.category || '') + '] ' + (cqn.note_short || ''));
          }
          if (cnt.length > CLOSE_PREVIEW_MAX) lines.push('    … 他' + (cnt.length - CLOSE_PREVIEW_MAX) + '件');
        }
      }
      lines.push('');
    }

    var wPrev = closeDayData.weight_loss_close_day;
    if (wPrev) {
      lines.push('⚖️ 体重低下（30日比・栄養プロフィール）');
      lines.push('  ' + (wPrev.basis || ''));
      var wItems = wPrev.items || [];
      if (wItems.length === 0) {
        lines.push('  該当なし');
      } else {
        for (var wx = 0; wx < wItems.length && wx < CLOSE_PREVIEW_MAX; wx++) {
          var wxit = wItems[wx];
          var wtag = wxit.severity === 'critical' ? '【急減】' : wxit.severity === 'severe' ? '【顕著】' : '【注意】';
          var wkg = '';
          if (wxit.weight_30d_ago_kg != null && wxit.last_weight_kg != null) {
            wkg = '（' + wxit.weight_30d_ago_kg + '→' + wxit.last_weight_kg + 'kg）';
          } else if (wxit.last_weight_kg != null) {
            wkg = '（現在 ' + wxit.last_weight_kg + 'kg）';
          }
          lines.push('  • ' + wxit.cat_name + ' — 30日比 ' + wxit.weight_trend_pct + '% ' + wkg + ' ' + wtag);
        }
        if (wItems.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (wItems.length - CLOSE_PREVIEW_MAX) + '頭');
      }
      lines.push('');
    }

    var aPrev = closeDayData.appetite_low_close_day;
    if (aPrev) {
      lines.push('🍽️ 食欲スコア低下（健康スコア・食欲項目）');
      lines.push('  ' + (aPrev.basis || ''));
      var aItemsP = aPrev.items || [];
      if (aItemsP.length === 0) {
        lines.push('  該当なし');
      } else {
        for (var ax = 0; ax < aItemsP.length && ax < CLOSE_PREVIEW_MAX; ax++) {
          var axit = aItemsP[ax];
          var atg2 = axit.severity === 'critical' ? '【不振】' : axit.severity === 'severe' ? '【低下】' : '【やや低下】';
          var adt = axit.score_date ? String(axit.score_date).slice(0, 10) : '';
          var adp2 = adt ? ' スコア日 ' + adt : '';
          var ato2 = axit.total_score != null ? ' 総合' + axit.total_score + '点' : '';
          lines.push('  • ' + axit.cat_name + ' — 食欲 ' + axit.appetite_score + '点' + ato2 + adp2 + ' ' + atg2);
        }
        if (aItemsP.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (aItemsP.length - CLOSE_PREVIEW_MAX) + '頭');
      }
      lines.push('');
    }

    if (oev2.length > 0) {
      lines.push('📅 継続追跡中のイベント（スキップ対象外）:');
      for (var oi = 0; oi < oev2.length && oi < CLOSE_PREVIEW_MAX; oi++) {
        var ot = oev2[oi];
        var od = ot.due_date ? String(ot.due_date).slice(0, 10) : '';
        var odl = od.length === 10 ? previewFmtMd(od) : '—';
        var ond = ot.event_days_open > 0 ? ' 未解決' + ot.event_days_open + '日' : '';
        lines.push('  • ' + (ot.title || '') + ' — 期限 ' + odl + ond);
      }
      if (oev2.length > CLOSE_PREVIEW_MAX) lines.push('  … 他' + (oev2.length - CLOSE_PREVIEW_MAX) + '件');
      lines.push('');
    }

    if ((closeDayData.pending_tasks || []).length > 0) {
      lines.push('⚠ 業務終了ボタンでスキップされるタスク:');
      var taskEls = document.querySelectorAll('.close-day-task');
      for (var i = 0; i < taskEls.length; i++) {
        var taskEl = taskEls[i];
        var sel = taskEl.querySelector('.close-day-reason-select');
        var textInput = taskEl.querySelector('.close-day-reason-text');
        var reason = (sel.value === '__other') ? (textInput.value.trim() || '未入力') : sel.value;
        var title = taskEl.querySelector('.close-day-task-title').textContent.replace(/⚠.*$/, '').trim();
        lines.push('  • ' + title + ' → ' + reason);
      }
      lines.push('');
    }

    if (closeDayData.cat_summary && closeDayData.cat_summary.average_score != null) {
      lines.push('🐱 猫の健康スコア平均: ' + closeDayData.cat_summary.average_score + '点');
      if (closeDayData.cat_summary.warnings && closeDayData.cat_summary.warnings.length > 0) {
        for (var j = 0; j < closeDayData.cat_summary.warnings.length; j++) {
          var w = closeDayData.cat_summary.warnings[j];
          lines.push('  ⚠ ' + w.name + ': スコア ' + w.score);
        }
      }
      lines.push('');
    }

    var notes = document.getElementById('closeDayNotes').value.trim();
    if (notes) {
      lines.push('📝 特記事項: ' + notes);
      lines.push('');
    }

    lines.push('━━━━━━━━━━━━━━━━━━━━');

    document.getElementById('closeDayPreviewArea').textContent = lines.join('\n');
    document.getElementById('closeDayPreviewArea').style.display = 'block';
    document.getElementById('closeDayPreviewBtn').style.display = 'none';
    document.getElementById('closeDayConfirmBtn').style.display = '';
  };

  window.confirmCloseDay = function () {
    if (!confirm('この内容で業務終了し、Slackに送信しますか？')) return;

    var skipReasons = [];
    var taskEls = document.querySelectorAll('.close-day-task');
    for (var i = 0; i < taskEls.length; i++) {
      var taskEl = taskEls[i];
      var taskId = parseInt(taskEl.getAttribute('data-task-id'), 10);
      var sel = taskEl.querySelector('.close-day-reason-select');
      var textInput = taskEl.querySelector('.close-day-reason-text');
      var reason = (sel.value === '__other') ? (textInput.value.trim() || '未入力') : sel.value;
      skipReasons.push({ task_id: taskId, reason: reason });
    }

    var payload = {
      location_id: closeDayData.location_id,
      date: closeDayData.date,
      skip_reasons: skipReasons,
      special_notes: document.getElementById('closeDayNotes').value.trim(),
    };

    document.getElementById('closeDayConfirmBtn').disabled = true;
    document.getElementById('closeDayConfirmBtn').textContent = '送信中...';

    fetch(API_BASE + '/tasks/close-day', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload),
    })
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        alert('エラー: ' + (data.message || data.error));
        document.getElementById('closeDayConfirmBtn').disabled = false;
        document.getElementById('closeDayConfirmBtn').textContent = '送信して業務終了';
        return;
      }
      closeCloseDayModal();
      showToast('業務終了しました（Slack送信済み）');
      loadTasks();
    })
    .catch(function (err) {
      alert('送信に失敗: ' + err.message);
      document.getElementById('closeDayConfirmBtn').disabled = false;
      document.getElementById('closeDayConfirmBtn').textContent = '送信して業務終了';
    });
  };

  window.closeCloseDayModal = function () {
    document.getElementById('closeDayModal').classList.remove('open');
    closeDayData = null;
  };

  // ── 初期化（全関数定義後に実行） ─────────────────────────────────────────────
  if (credentials) {
    var today = todayJstYmd();
    document.getElementById('filterDate').value = today;
    var tg0 = document.getElementById('tmplGenerateDate');
    if (tg0) tg0.value = today;
    loadCatList();
    loadStaffList();
    window.loadTasks();
  }

})();
