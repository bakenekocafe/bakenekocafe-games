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
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
          body: JSON.stringify({ password: password })
        }).then(function (r) { return r.json(); }).then(function (data) {
          if (!data || !data.staffId) { if (gateAlert) { gateAlert.textContent = 'パスワードが違います'; gateAlert.style.display = 'block'; } gateBtn.disabled = false; return; }
          localStorage.setItem('nyagi_creds', JSON.stringify({ adminKey: adminKey, staffId: data.staffId }));
          credentials = { adminKey: adminKey, staffId: data.staffId };
          loginGate.style.display = 'none';
          taskContent.style.display = 'block';
          var today = new Date().toISOString().slice(0, 10);
          document.getElementById('filterDate').value = today;
          document.getElementById('ntDueDate').value = today;
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
    fetch(API_BASE + '/cats', { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catList = data.cats || [];
        populateCatSelects();
      })
      .catch(function () {});
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
    fetch(API_BASE + '/staff', { headers: apiHeaders() })
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

    if (tab === 'templates') loadTemplates();
    if (tab === 'monitoring') loadMonitoringTasks();
    if (tab === 'projects') { currentProjectId = null; loadProjects(); }
  };

  // ── タスク種類セレクト連動 ──────────────────────────────────────────────────

  var ntTaskType = document.getElementById('ntTaskType');
  if (ntTaskType) {
    ntTaskType.addEventListener('change', function () {
      var isMonitoring = this.value === 'monitoring';
      document.getElementById('ntExpiresGroup').style.display = isMonitoring ? 'block' : 'none';
      document.getElementById('ntDateGroup').style.display = isMonitoring ? 'none' : 'block';
      document.getElementById('ntTimeGroup').style.display = isMonitoring ? 'none' : 'block';
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
    if (currentTab === 'today') loadTasks();
    else if (currentTab === 'templates') loadTemplates();
    else if (currentTab === 'projects') loadProjects();
    else if (currentTab === 'monitoring') loadMonitoringTasks();
  };

  var taskListFolded = true;

  window.toggleTaskList = function () {
    var area = document.getElementById('taskListArea');
    var btn = document.getElementById('taskFoldToggle');
    if (!area || !btn) return;
    taskListFolded = !taskListFolded;
    area.style.display = taskListFolded ? 'none' : '';
    btn.textContent = taskListFolded ? '▼ タスク一覧を表示' : '▲ タスク一覧を閉じる';
  };

  window.loadTasks = function () {
    var date = document.getElementById('filterDate').value || new Date().toISOString().slice(0, 10);
    var status = document.getElementById('filterStatus').value;

    var qs = '?date=' + encodeURIComponent(date) + '&group_by=attribute';
    if (status) qs += '&status=' + encodeURIComponent(status);
    var loc = getSelectedLocation();
    if (loc && loc !== 'both') qs += '&location=' + encodeURIComponent(loc);

    document.getElementById('taskListArea').innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';
    document.getElementById('progressArea').innerHTML = '';

    fetch(API_BASE + '/tasks' + qs, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(data.message || data.error) + '</div>';
          return;
        }
        renderAttrProgress(data.progress || {}, data.attribute_groups || []);
        if (data.attribute_groups && data.attribute_groups.length > 0) {
          renderAttrGroupedTasks(data.attribute_groups);
        } else {
          renderFlatTasks(data.tasks || []);
        }
      })
      .catch(function () {
        document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
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
    var el = document.getElementById('attr-group-' + attr);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function renderAttrGroupedTasks(groups) {
    if (groups.length === 0) {
      document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">タスクなし</div>';
      return;
    }

    var html = '';
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      var tasks = grp.tasks || [];

      html += '<div id="attr-group-' + escapeHtml(grp.attribute) + '">';
      html += '<div class="attr-group-header">';
      html += '<div class="attr-avatar">' + escapeHtml(grp.icon) + '</div>';
      html += '<div class="attr-group-name">' + escapeHtml(grp.label) + '</div>';
      html += '<div class="attr-group-count">' + grp.progress.done + '/' + grp.progress.total;
      if (grp.progress.pct === 100) html += ' ✨';
      html += '</div>';
      html += '</div>';

      for (var j = 0; j < tasks.length; j++) {
        html += renderTaskItem(tasks[j]);
      }
      html += '</div>';
    }

    document.getElementById('taskListArea').innerHTML = html;
  }

  function renderFlatTasks(tasks) {
    if (tasks.length === 0) {
      document.getElementById('taskListArea').innerHTML = '<div class="empty-msg">タスクなし</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < tasks.length; i++) html += renderTaskItem(tasks[i]);
    document.getElementById('taskListArea').innerHTML = html;
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

    if (task.priority && task.priority !== 'normal') {
      var prioLabel = { urgent: '緊急', high: '高', low: '低' }[task.priority] || task.priority;
      html += '<span class="task-priority-badge ' + task.priority + '">' + prioLabel + '</span>';
    }
    if (task.due_time) html += '<span>' + escapeHtml(slotLabel(task.due_time)) + '</span>';
    if (task.assigned_name) html += '<span style="opacity:0.7;">担当: ' + escapeHtml(task.assigned_name) + '</span>';
    html += '</div>';

    if (task.status === 'done' && task.completed_at) {
      var timeStr = (task.completed_at || '').slice(11, 16);
      html += '<div class="task-done-info">完了 ' + escapeHtml(task.completed_by || '') + ' ' + timeStr + '</div>';
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

  // ── 監視タスク一覧 ──────────────────────────────────────────────────────────

  function loadMonitoringTasks() {
    document.getElementById('monitoringListArea').innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    fetch(API_BASE + '/tasks?task_type=monitoring', { headers: apiHeaders() })
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
          html += '<div class="monitoring-section">';
          html += '<div style="display:flex;justify-content:space-between;align-items:center;">';
          html += '<div style="font-size:14px;font-weight:600;">';
          if (t.cat_name) html += '<span style="color:#a78bfa;">' + escapeHtml(t.cat_name) + '</span> ';
          html += escapeHtml(t.title);
          html += '</div>';
          if (t.status === 'pending') {
            html += '<button class="task-action-btn" onclick="resolveMonitoring(' + t.id + ')" style="background:#14532d;color:#86efac;">解決</button>';
          } else {
            html += '<span style="font-size:11px;color:#4ade80;">解決済</span>';
          }
          html += '</div>';
          if (t.expires_at) {
            html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">期限: ' + escapeHtml(t.expires_at) + '</div>';
          }
          if (t.note) {
            html += '<div class="task-note-preview" style="margin-top:6px;">' + escapeHtml(t.note) + '</div>';
          }
          if (t.status === 'pending') {
            html += '<div class="task-actions-row" style="margin-top:6px;">';
            html += '<button class="task-action-btn" onclick="openNoteModal(' + t.id + ',' + (t.cat_id ? 'true' : 'false') + ')">メモ追記</button>';
            html += '</div>';
          }
          html += '</div>';
        }
        document.getElementById('monitoringListArea').innerHTML = html;
      })
      .catch(function () {
        document.getElementById('monitoringListArea').innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
      });
  }

  window.resolveMonitoring = function (taskId) {
    fetch(API_BASE + '/tasks/' + taskId + '/done', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ note: '解決' }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error === 'already_completed') {
        showToast(escapeHtml(data.completed_by) + ' が完了済みです');
        loadMonitoringTasks();
        return;
      }
      loadMonitoringTasks();
    })
    .catch(function () { alert('更新に失敗しました'); });
  };

  // ── タスク完了 / スキップ ────────────────────────────────────────────────────

  window.toggleTask = function (taskId, currentStatus) {
    if (currentStatus === 'done' || currentStatus === 'skipped') {
      if (!confirm('この操作を取り消して「未完了」に戻しますか？')) return;
      fetch(API_BASE + '/tasks/' + taskId + '/undo', {
        method: 'POST',
        headers: apiHeaders(),
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
      headers: apiHeaders(),
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
      headers: apiHeaders(),
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
      headers: apiHeaders(),
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
    document.getElementById('ntDueDate').value = document.getElementById('filterDate').value || new Date().toISOString().slice(0, 10);
    document.getElementById('ntDueTime').value = '';
    document.getElementById('ntExpiresAt').value = '';
    populateStaffSelect('ntAssignedTo');

    if (presetType === 'monitoring') {
      document.getElementById('ntTaskType').value = 'monitoring';
      document.getElementById('ntModalTitle').textContent = '+ 監視タスクを追加';
      document.getElementById('ntExpiresGroup').style.display = 'block';
      document.getElementById('ntDateGroup').style.display = 'none';
      document.getElementById('ntTimeGroup').style.display = 'none';
    } else {
      document.getElementById('ntTaskType').value = 'routine';
      document.getElementById('ntModalTitle').textContent = '+ タスクを追加';
      document.getElementById('ntExpiresGroup').style.display = 'none';
      document.getElementById('ntDateGroup').style.display = 'block';
      document.getElementById('ntTimeGroup').style.display = 'block';
    }

    document.getElementById('newTaskModal').classList.add('open');
  };

  window.closeNewTaskModal = function () {
    document.getElementById('newTaskModal').classList.remove('open');
  };

  window.submitNewTask = function () {
    var title = document.getElementById('ntTitle').value.trim();
    if (!title) { alert('タイトルを入力してください'); return; }

    var taskType = document.getElementById('ntTaskType').value;
    var dueDate = document.getElementById('ntDueDate').value || new Date().toISOString().slice(0, 10);
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
      due_date: dueDate,
      due_time: dueTime,
    };

    if (taskType === 'monitoring') {
      payload.expires_at = expiresAt;
      payload.due_date = dueDate;
    }

    fetch(API_BASE + '/tasks', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }

      if (noteText && data.task) {
        return fetch(API_BASE + '/tasks/' + data.task.id + '/note', {
          method: 'PUT',
          headers: apiHeaders(),
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
    var url = API_BASE + '/tasks/templates' + ((loc && loc !== 'both') ? '?location=' + encodeURIComponent(loc) : '');
    fetch(url, { headers: apiHeaders() })
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
    document.getElementById('tmplRecurrence').value = 'daily';
    document.getElementById('tmplTimeSlot').value = '';
    document.getElementById('tmplPriority').value = 'normal';
    document.getElementById('tmplSortOrder').value = '0';
    document.getElementById('tmplDeleteArea').style.display = 'none';
    document.getElementById('tmplSubmitBtn').textContent = '保存';
    populateStaffSelect('tmplAssignedTo');
    document.getElementById('newTemplateModal').classList.add('open');
  };

  window.openEditTemplateModal = function (templateId) {
    fetch(API_BASE + '/tasks/templates/' + encodeURIComponent(templateId), { headers: apiHeaders() })
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
        document.getElementById('tmplRecurrence').value = t.recurrence || 'daily';
        document.getElementById('tmplTimeSlot').value = t.time_slot || '';
        document.getElementById('tmplPriority').value = t.priority || 'normal';
        document.getElementById('tmplSortOrder').value = t.sort_order || 0;
        document.getElementById('tmplDeleteArea').style.display = 'block';
        document.getElementById('tmplSubmitBtn').textContent = '更新';
        populateStaffSelect('tmplAssignedTo');
        if (t.assigned_to) {
          document.getElementById('tmplAssignedTo').value = t.assigned_to;
        }
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

    var payload = {
      title: title,
      task_type: document.getElementById('tmplTaskType').value,
      attribute: document.getElementById('tmplAttribute').value,
      cat_id: document.getElementById('tmplCatId').value || null,
      assigned_to: document.getElementById('tmplAssignedTo').value || null,
      recurrence: document.getElementById('tmplRecurrence').value,
      time_slot: document.getElementById('tmplTimeSlot').value || null,
      priority: document.getElementById('tmplPriority').value,
      sort_order: parseInt(document.getElementById('tmplSortOrder').value, 10) || 0,
      description: document.getElementById('tmplDescription').value.trim() || null,
    };

    if (editId) {
      fetch(API_BASE + '/tasks/templates/' + encodeURIComponent(editId), {
        method: 'PUT',
        headers: apiHeaders(),
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
        headers: apiHeaders(),
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
      headers: apiHeaders(),
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
    var date = document.getElementById('filterDate').value || new Date().toISOString().slice(0, 10);
    if (!confirm(date + ' のタスクをテンプレートから一括生成しますか？')) return;

    fetch(API_BASE + '/tasks/templates/generate', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({ date: date }),
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

    fetch(API_BASE + '/tasks/projects', { headers: apiHeaders() })
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
      headers: apiHeaders(),
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

    fetch(API_BASE + '/tasks/projects/' + projectId, { headers: apiHeaders() })
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
      headers: apiHeaders(),
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
      headers: apiHeaders(),
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
      headers: apiHeaders(),
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
      opening: '🌅 開店準備', closing: '🌙 閉店作業', cat_care: '🐱 猫ケア',
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

    var date = document.getElementById('filterDate').value || new Date().toISOString().slice(0, 10);
    var url = API_BASE + '/tasks/close-day/preview?location=' + encodeURIComponent(loc) + '&date=' + encodeURIComponent(date);

    fetch(url, { headers: apiHeaders() })
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

  function renderCloseDayModal(data) {
    document.getElementById('closeDayLocationLabel').textContent = data.location_label + '  ' + data.date;

    var s = data.stats;
    var pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;
    document.getElementById('closeDayStats').innerHTML =
      '✅ 完了: <strong>' + s.done + '/' + s.total + '</strong>（' + pct + '%）　⏳ 未完了: <strong>' + s.pending + '</strong>件';

    var listArea = document.getElementById('closeDayPendingList');
    if (data.pending_tasks.length === 0) {
      listArea.innerHTML = '<div style="text-align:center;color:#4ade80;font-size:14px;padding:20px;">🎉 全タスク完了！</div>';
    } else {
      var html = '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">各タスクのスキップ理由を選択してください:</div>';
      for (var i = 0; i < data.pending_tasks.length; i++) {
        var t = data.pending_tasks[i];
        var streakHtml = (t.skip_streak > 0) ? '<span class="streak-warn">⚠ ' + t.skip_streak + '日連続</span>' : '';
        html += '<div class="close-day-task" data-task-id="' + t.id + '">';
        html += '<div class="close-day-task-title">' + escapeHtml(t.title) + streakHtml + '</div>';
        html += '<select class="close-day-reason-select" onchange="toggleCloseDayFreeText(this)">';
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
    var locationLabel = closeDayData.location_label;
    var s = closeDayData.stats;
    var pct = s.total > 0 ? Math.round(s.done / s.total * 100) : 0;

    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('📋 ' + locationLabel + ' 日次業務レポート');
    lines.push(closeDayData.date + '  報告者: ' + (credentials.staffName || credentials.staffId));
    lines.push('━━━━━━━━━━━━━━━━━━━━');
    lines.push('');
    lines.push('✅ 完了: ' + s.done + '/' + s.total + '（' + pct + '%）');
    lines.push('⏳ スキップ: ' + s.pending + '件');
    lines.push('');

    if (closeDayData.pending_tasks.length > 0) {
      lines.push('⚠ スキップされるタスク:');
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
      headers: apiHeaders(),
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
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('filterDate').value = today;
    document.getElementById('ntDueDate').value = today;
    loadCatList();
    loadStaffList();
    window.loadTasks();
  }

})();
