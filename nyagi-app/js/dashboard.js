/**
 * NYAGI ダッシュボード JS (ES5 互換)
 *
 * 朝 morning + 夕 evening の両APIを統合し、1画面で全情報を表示。
 */

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops/dashboard';
  var HEALTH_API_BASE = _origin + '/api/ops/health';

  var loginGate = document.getElementById('loginGate');
  var dashContent = document.getElementById('dashContent');
  var dashView = document.getElementById('dashView');
  var locBar = document.getElementById('locBar');

  var credentials = null;
  var currentLocationId = null;
  var currentStatusId = null;
  var statusBar = document.getElementById('statusBar');

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

  function savedLocation() {
    try { return localStorage.getItem('nyagi_dash_location') || null; } catch (_) { return null; }
  }
  function saveLocation(id) {
    try { localStorage.setItem('nyagi_dash_location', id); } catch (_) {}
  }
  function savedStatus() {
    try { return localStorage.getItem('nyagi_dash_status') || null; } catch (_) { return null; }
  }
  function saveStatus(id) {
    try { localStorage.setItem('nyagi_dash_status', id); } catch (_) {}
  }

  function init() {
    credentials = loadCredentials();
    if (!credentials) {
      if (loginGate) loginGate.style.display = 'block';
      return;
    }
    if (dashContent) dashContent.style.display = 'block';
    setTimeout(function () { loadLocations(); }, 150);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  var LOC_LABELS = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊' };
  var STATUS_LABELS = { all: '全部', active: '在籍', adopted: '卒業', trial: 'トライアル中' };

  function loadLocations() {
    currentLocationId = savedLocation() || 'all';
    currentStatusId = savedStatus() || 'active';
    renderFilterBars();
    initDashboard();
  }

  function renderFilterBars() {
    if (!locBar || !statusBar) return;
    var locs = [
      { id: 'all', label: '全部' },
      { id: 'cafe', label: LOC_LABELS.cafe },
      { id: 'nekomata', label: LOC_LABELS.nekomata },
      { id: 'endo', label: LOC_LABELS.endo },
      { id: 'azukari', label: LOC_LABELS.azukari }
    ];
    var statuses = [
      { id: 'all', label: '全部' },
      { id: 'active', label: '在籍' },
      { id: 'adopted', label: '卒業' },
      { id: 'trial', label: 'トライアル中' }
    ];

    var locHtml = '';
    for (var i = 0; i < locs.length; i++) {
      var loc = locs[i];
      var active = (loc.id === currentLocationId) ? ' active' : '';
      locHtml += '<button class="loc-btn' + active + '" data-loc="' + escapeHtml(loc.id) + '">' + escapeHtml(loc.label) + '</button>';
    }
    locBar.innerHTML = locHtml;

    var statusHtml = '';
    for (var j = 0; j < statuses.length; j++) {
      var st = statuses[j];
      var active = (st.id === currentStatusId) ? ' active' : '';
      statusHtml += '<button class="loc-btn' + active + '" data-status="' + escapeHtml(st.id) + '">' + escapeHtml(st.label) + '</button>';
    }
    statusBar.innerHTML = statusHtml;

    Array.prototype.forEach.call(locBar.querySelectorAll('.loc-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-loc');
        if (id === currentLocationId) return;
        currentLocationId = id;
        saveLocation(id);
        Array.prototype.forEach.call(locBar.querySelectorAll('.loc-btn'), function (b) { b.classList.toggle('active', b.getAttribute('data-loc') === id); });
        loadDashboard();
      });
    });
    Array.prototype.forEach.call(statusBar.querySelectorAll('.loc-btn'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-status');
        if (id === currentStatusId) return;
        currentStatusId = id;
        saveStatus(id);
        Array.prototype.forEach.call(statusBar.querySelectorAll('.loc-btn'), function (b) { b.classList.toggle('active', b.getAttribute('data-status') === id); });
        loadDashboard();
      });
    });
  }

  function initDashboard() {
    loadDashboard();
  }

  // ── データ読み込み ──

  function locationQuery() {
    var q = '?location=' + encodeURIComponent(currentLocationId || 'all');
    if (currentStatusId && currentStatusId !== 'all') q += '&status=' + encodeURIComponent(currentStatusId);
    return q;
  }

  function loadDashboard(retryCount) {
    retryCount = retryCount || 0;
    dashView.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    var q = locationQuery();
    var ctrl = new AbortController();
    var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
    var morningReq = fetch(API_BASE + '/morning' + q, { headers: apiHeaders(), signal: ctrl.signal }).then(function (r) { return r.json(); });
    var eveningReq = fetch(API_BASE + '/evening' + q, { headers: apiHeaders(), signal: ctrl.signal }).then(function (r) { return r.json(); });

    Promise.all([morningReq, eveningReq])
      .then(function (results) {
        clearTimeout(timeoutId);
        var mData = results[0] || {};
        var eData = results[1] || {};
        if (mData.error && eData.error) {
          dashView.innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(mData.message || mData.error) + '</div>';
          return;
        }
        renderUnified(mData, eData);
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        var isNetworkErr = (err && (err.name === 'AbortError' || (err.message && (err.message.indexOf('Failed to fetch') !== -1 || err.message.indexOf('NetworkError') !== -1))));
        if (isNetworkErr && retryCount < 2) {
          dashView.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...（再試行 ' + (retryCount + 1) + '/2）</div>';
          setTimeout(function () { loadDashboard(retryCount + 1); }, 1200);
          return;
        }
        var msg = err && err.name === 'AbortError' ? 'タイムアウトしました' : '読み込みに失敗しました';
        var hint = (location.port !== '8001' && location.hostname === 'localhost') ? '<br><span style="font-size:11px;color:var(--text-dim);">※ http://localhost:8001/nyagi-app/ で開くと安定します</span>' : '';
        dashView.innerHTML = '<div class="empty-msg">' + msg + hint + '</div><button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">再試行</button>';
      });
  }

  // ── 統合レンダリング ──

  function renderUnified(m, e) {
    var html = '';

    // 1. 🚨 今すぐ対応
    var crits = m.critical_cats || [];
    var watches = m.watch_cats || [];
    if (crits.length > 0 || watches.length > 0) {
      html += '<div class="section-title">🚨 今すぐ対応</div>';
      for (var i = 0; i < crits.length; i++) html += renderAlertCard(crits[i], 'critical');
      for (var i = 0; i < watches.length; i++) html += renderAlertCard(watches[i], 'watch');
    }

    // 2. 🏥 健康スコア（注意順 TOP5）
    html += renderHealthScoreTop5(m.cats_summary || []);

    // 2.5 🤮 はき戻し（直近7日で記録がある猫のみ）
    html += renderVomitSummary(m.cats_summary || []);

    // 3. 💊 今日の投薬（朝・昼・夜カード）
    var meds = m.medications_today || [];
    var pendingMeds = e.pending_medications || [];
    var medBySlot = { morning: [], noon: [], evening: [] };
    for (var i = 0; i < meds.length; i++) {
      var slot = (meds[i].time_slot || '').toString();
      if (slot === '朝' || slot === 'morning') medBySlot.morning.push(meds[i]);
      else if (slot === '昼' || slot === 'afternoon') medBySlot.noon.push(meds[i]);
      else medBySlot.evening.push(meds[i]);
    }
    for (var j = 0; j < pendingMeds.length; j++) {
      medBySlot.evening.push(pendingMeds[j]);
    }
    html += '<div class="section-title">💊 今日の投薬</div>';
    html += renderMedCardsBySlot(medBySlot);

    // 3. ✅ タスク（タスクAPIから進捗バーを取得して表示）
    html += '<div class="section-title">✅ タスク</div>';
    html += '<div id="dashTaskProgress"><div class="loading" style="padding:12px;font-size:12px;"><span class="spinner"></span> 読み込み中...</div></div>';
    html += '<a href="tasks.html" style="display:block;text-align:center;font-size:12px;color:var(--primary);margin-top:8px;text-decoration:none;">タスク一覧を見る →</a>';

    // 5. 📋 未完了アクション
    var overdueActions = m.overdue_actions || [];
    var todayActions = m.today_actions || [];
    if (overdueActions.length > 0 || todayActions.length > 0) {
      html += '<div class="section-title">📋 未完了アクション</div>';
      for (var i = 0; i < overdueActions.length; i++) html += renderActionItem(overdueActions[i], 'overdue');
      for (var i = 0; i < todayActions.length; i++) html += renderActionItem(todayActions[i], 'today');
    }

    // 5. ⚠️ 昨夜からの異常
    var anomalies = m.yesterday_anomalies || [];
    if (anomalies.length > 0) {
      html += '<div class="section-title">⚠️ 昨夜からの異常</div>';
      for (var i = 0; i < anomalies.length; i++) html += renderAnomalyItem(anomalies[i]);
    }

    // 7. 📊 今日の記録
    var summary = e.today_summary || {};
    var totalInputs = summary.total_inputs || 0;
    var anomalyItems = summary.today_anomaly_items || [];
    if (totalInputs > 0) {
      html += '<div class="section-title">📊 今日の記録</div>';
      var byCat = summary.by_category || {};
      html += '<div class="card today-record-card" style="margin-bottom:10px;">';
      html += '<div style="display:flex;justify-content:space-between;font-size:14px;margin-bottom:8px;">';
      html += '<span style="font-weight:700;">入力 ' + totalInputs + ' 件</span>';
      if ((summary.anomalies || 0) > 0) {
        html += '<span class="today-record-anomaly-link" style="color:#f87171;font-weight:600;cursor:pointer;text-decoration:underline;" title="タップで詳細表示">異常 ' + summary.anomalies + ' 件 ▼</span>';
      }
      html += '</div>';
      html += '<div style="display:flex;gap:12px;font-size:13px;color:var(--text-dim);flex-wrap:wrap;">';
      if (byCat.stool) html += '<span>排泄 ' + byCat.stool + '</span>';
      if (byCat.feeding) html += '<span>給餌 ' + byCat.feeding + '</span>';
      if (byCat.medication) html += '<span>投薬 ' + byCat.medication + '</span>';
      if (byCat.weight) html += '<span>体重 ' + byCat.weight + '</span>';
      if (byCat.other) html += '<span>他 ' + byCat.other + '</span>';
      html += '</div>';
      if (anomalyItems.length > 0) {
        html += '<div class="today-record-anomaly-detail" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.08);">';
        html += '<div style="font-size:12px;font-weight:600;color:#f87171;margin-bottom:8px;">異常の詳細</div>';
        for (var ai = 0; ai < anomalyItems.length; ai++) {
          var a = anomalyItems[ai];
          var timeStr = (a.created_at || '').slice(11, 16);
          var layerLabel = (a.routing_layer || '').replace('L1_with_anomaly_flag', 'L1').replace('_completed', '').replace('_pending', '');
          html += '<div class="anomaly-detail-item" style="background:var(--bg);border-radius:6px;padding:8px 10px;margin-bottom:6px;font-size:12px;">';
          html += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">';
          html += '<span style="color:var(--primary);font-weight:600;">' + escapeHtml(a.cat_name || a.target_cat_id || '') + '</span>';
          html += '<span style="color:var(--text-dim);">' + timeStr + ' ' + escapeHtml(layerLabel) + '</span>';
          html += '</div>';
          html += '<div style="color:var(--text);word-break:break-all;">' + escapeHtml(a.raw_transcript || '') + '</div>';
          if (a.target_cat_id) {
            html += '<a href="cat.html?id=' + encodeURIComponent(a.target_cat_id) + '" style="font-size:11px;color:var(--primary);margin-top:4px;display:inline-block;">猫詳細へ →</a>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // 8. 🍽 給餌サマリー
    var feedingSummary = e.feeding_summary || [];
    if (feedingSummary.length > 0) {
      html += '<div class="section-title">🍽 給餌サマリー</div>';
      html += '<div class="card">';
      for (var i = 0; i < feedingSummary.length; i++) {
        var fs = feedingSummary[i];
        var fid = fs.cat_id || '';
        var eatPct = Math.round(fs.avg_eaten || 0);
        var eatColor = eatPct >= 80 ? '#4ade80' : eatPct >= 50 ? '#facc15' : '#f87171';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:4px 0;' +
          (i < feedingSummary.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '') + '">';
        if (fid) {
          html += '<a href="cat.html?id=' + encodeURIComponent(fid) + '" style="color:inherit;text-decoration:none;flex:1;">' + escapeHtml(fs.cat_name || '') + '</a>';
          html += '<span style="color:' + eatColor + ';font-weight:600;">' + eatPct + '%</span>';
          html += '<a href="cat.html?id=' + encodeURIComponent(fid) + '#feedingArea" class="btn-edit-small" style="margin-left:8px;font-size:11px;padding:2px 6px;" title="猫詳細で編集">✏️</a>';
        } else {
          html += '<span style="flex:1;">' + escapeHtml(fs.cat_name || '') + '</span>';
          html += '<span style="color:' + eatColor + ';font-weight:600;">' + eatPct + '%</span>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // 9. 📅 明日の予定
    var tmrEvents = e.tomorrow_events || [];
    if (tmrEvents.length > 0) {
      html += '<div class="section-title">📅 明日の予定</div>';
      for (var i = 0; i < tmrEvents.length; i++) {
        var evt = tmrEvents[i];
        html += '<div class="action-item today">';
        html += '<div class="action-title">' + escapeHtml(evt.cat_name || '') + ': ' + escapeHtml(evt.event || '') + '</div>';
        if (evt.action_needed) {
          html += '<div class="action-meta">' + escapeHtml(evt.action_needed) + '</div>';
        }
        html += '</div>';
      }
    }

    // 10. 🏥 病院スケジュール（常に表示）
    var vetScheds = e.vet_schedules || [];
    var vetTypeLabels = { vaccine: 'ワクチン', checkup: '健診', surgery: '手術', dental: '歯科', test: '検査', observation: '経過観察' };
    html += '<div class="section-title">🏥 病院スケジュール</div>';
    if (vetScheds.length === 0) {
      html += '<div style="padding:12px;background:var(--surface);border-radius:8px;text-align:center;color:var(--text-dim);font-size:13px;">登録されているスケジュールはありません</div>';
    } else {
      var within30 = [];
      var later = [];
      for (var vi = 0; vi < vetScheds.length; vi++) {
        if (vetScheds[vi].days_left <= 30) { within30.push(vetScheds[vi]); }
        else { later.push(vetScheds[vi]); }
      }
      var weekdays = ['日','月','火','水','木','金','土'];
      function formatVetDate(isoDate) {
        if (!isoDate) return '';
        var d = new Date(isoDate + 'T00:00:00');
        var m = d.getMonth() + 1;
        var day = d.getDate();
        var w = weekdays[d.getDay()];
        return m + '/' + day + '（' + w + '）';
      }
      function formatVetDateTime(val) {
        if (!val) return '';
        var parts = val.split(' ');
        var datePart = parts[0];
        var timePart = parts[1] || '';
        var d = new Date(datePart + 'T00:00:00');
        var m = d.getMonth() + 1;
        var day = d.getDate();
        var w = weekdays[d.getDay()];
        var result = m + '/' + day + '（' + w + '）';
        if (timePart) result += ' ' + timePart;
        return result;
      }
      function renderVetCard(vs) {
        var vtLabel = vetTypeLabels[vs.record_type] || vs.record_type;
        var isOverdue = vs.days_left < 0;
        var urgColor = isOverdue ? '#f87171' : vs.days_left <= 3 ? '#fb923c' : vs.days_left <= 7 ? '#facc15' : vs.days_left <= 30 ? '#4ade80' : '#94a3b8';
        var daysText = vs.days_left === 0 ? '今日' : isOverdue ? Math.abs(vs.days_left) + '日超過' : vs.days_left + '日後';
        var bgStyle = isOverdue ? 'background:rgba(248,113,113,0.08)' : 'background:var(--surface)';
        var card = '<div style="padding:10px 12px;' + bgStyle + ';border-radius:8px;margin-bottom:6px;border-left:3px solid ' + urgColor + ';">';
        card += '<div style="display:flex;align-items:center;gap:6px;">';
        card += '<div style="flex:1;font-size:13px;font-weight:600;color:var(--text-main);">' + (isOverdue ? '⚠️ ' : '') + escapeHtml(vs.cat_name) + ' — ' + escapeHtml(vtLabel) + '</div>';
        card += '<span style="font-size:12px;font-weight:700;color:' + urgColor + ';white-space:nowrap;">' + daysText + '</span>';
        card += '</div>';
        card += '<div style="margin-top:4px;font-size:12px;color:var(--text-dim);">次回目安: ' + escapeHtml(formatVetDate(vs.next_due)) + '</div>';
        if (vs.booked_date) {
          var bookedDisplay = formatVetDateTime(vs.booked_date);
          card += '<div style="margin-top:2px;display:flex;align-items:center;gap:6px;">';
          card += '<span style="font-size:12px;color:#4ade80;font-weight:600;">✅ 予約: ' + escapeHtml(bookedDisplay) + '</span>';
          card += '<button class="dash-vet-book-btn" data-record-id="' + vs.id + '" data-current="' + escapeHtml(vs.booked_date) + '" style="font-size:10px;padding:1px 6px;border:1px solid rgba(99,102,241,0.3);border-radius:3px;background:rgba(99,102,241,0.1);color:#a78bfa;cursor:pointer;">変更</button>';
          card += '</div>';
        } else {
          card += '<div style="margin-top:4px;display:flex;align-items:center;gap:6px;">';
          card += '<span style="font-size:11px;color:#fb923c;">📞 未予約</span>';
          card += '<button class="dash-vet-book-btn" data-record-id="' + vs.id + '" style="font-size:11px;padding:2px 8px;border:1px solid rgba(99,102,241,0.3);border-radius:4px;background:rgba(99,102,241,0.1);color:#a78bfa;cursor:pointer;">予約日時を入力</button>';
          card += '</div>';
        }
        card += '</div>';
        return card;
      }
      if (within30.length > 0) {
        for (var w = 0; w < within30.length; w++) { html += renderVetCard(within30[w]); }
      }
      if (later.length > 0) {
        if (within30.length > 0) {
          html += '<div style="font-size:11px;color:var(--text-dim);margin:8px 0 4px;padding-left:4px;">▽ 30日以降</div>';
        }
        for (var l = 0; l < later.length; l++) { html += renderVetCard(later[l]); }
      }
    }

    dashView.innerHTML = html;
    bindDashFolds();
    bindTodayRecordAnomaly();
    bindDashMedActions();
    bindVetBookButtons();
    loadTaskProgressBars();
  }

  function bindTodayRecordAnomaly() {
    var link = dashView.querySelector('.today-record-anomaly-link');
    var detail = dashView.querySelector('.today-record-anomaly-detail');
    if (!link || !detail) return;
    link.addEventListener('click', function () {
      var isHidden = detail.style.display === 'none';
      detail.style.display = isHidden ? 'block' : 'none';
    });
  }

  function bindDashMedActions() {
    dashView.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-log-action');
      if (!btn) return;
      var item = btn.closest('.dash-med-item');
      if (!item) return;
      var catId = item.getAttribute('data-cat-id');
      var medicationId = item.getAttribute('data-medication-id');
      var logId = item.getAttribute('data-log-id');
      var timeSlot = item.getAttribute('data-time-slot') || '';
      var action = btn.getAttribute('data-action') || 'done';
      doMedicationLogFromDashboard(catId, medicationId, logId, timeSlot, action, item);
    });
  }

  function bindVetBookButtons() {
    var btns = dashView.querySelectorAll('.dash-vet-book-btn');
    for (var i = 0; i < btns.length; i++) {
      btns[i].addEventListener('click', function () {
        var recordId = this.getAttribute('data-record-id');
        promptVetBookDate(recordId, this);
      });
    }
  }

  function promptVetBookDate(recordId, btnEl) {
    var currentVal = btnEl.getAttribute('data-current') || '';
    var currentDate = '';
    var currentTime = '';
    if (currentVal) {
      var cv = currentVal.split(' ');
      currentDate = cv[0] || '';
      currentTime = cv[1] || '';
    }

    var dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.style.cssText = 'font-size:12px;padding:2px 4px;border:1px solid rgba(99,102,241,0.4);border-radius:4px;background:var(--surface);color:var(--text-main);width:130px;';
    if (currentDate) {
      dateInput.value = currentDate;
    } else {
      var today = new Date();
      dateInput.value = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    }

    var timeInput = document.createElement('input');
    timeInput.type = 'time';
    timeInput.style.cssText = 'font-size:12px;padding:2px 4px;border:1px solid rgba(99,102,241,0.4);border-radius:4px;background:var(--surface);color:var(--text-main);width:90px;';
    timeInput.value = currentTime || '10:00';

    var saveBtn = document.createElement('button');
    saveBtn.textContent = '保存';
    saveBtn.style.cssText = 'font-size:11px;padding:3px 10px;border:none;border-radius:4px;background:#6366f1;color:#fff;cursor:pointer;';

    var cancelBtn = document.createElement('button');
    cancelBtn.textContent = '×';
    cancelBtn.style.cssText = 'font-size:12px;padding:2px 6px;border:none;border-radius:4px;background:rgba(255,255,255,0.1);color:var(--text-dim);cursor:pointer;';

    var container = btnEl.parentElement;
    container.style.cssText = 'margin-top:4px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;';
    container.innerHTML = '';
    container.appendChild(dateInput);
    container.appendChild(timeInput);
    container.appendChild(saveBtn);
    container.appendChild(cancelBtn);

    cancelBtn.addEventListener('click', function () { loadDashboard(); });

    saveBtn.addEventListener('click', function () {
      var dateVal = dateInput.value;
      if (!dateVal) { alert('日付を選択してください'); return; }
      var timeVal = timeInput.value || '';
      var bookedValue = timeVal ? dateVal + ' ' + timeVal : dateVal;
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      fetch(_origin + '/api/ops/health/records/' + recordId, {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify({ booked_date: bookedValue }),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        loadDashboard();
      }).catch(function () { alert('保存に失敗しました'); saveBtn.disabled = false; saveBtn.textContent = '保存'; });
    });
  }

  function doMedicationLogFromDashboard(catId, medicationId, logId, timeSlot, action, itemEl) {
    if (!logId && !catId) {
      alert('猫IDが指定されていません');
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    function postLog(id) {
      var endpoint = HEALTH_API_BASE + '/medication-logs/' + id + '/' + action;
      fetch(endpoint, { method: 'POST', headers: apiHeaders(), body: JSON.stringify({}) })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          initDashboard();
        })
        .catch(function () { alert('投薬ログの更新に失敗しました'); });
    }
    if (logId) {
      postLog(logId);
      return;
    }
    fetch(HEALTH_API_BASE + '/medication-logs?cat_id=' + encodeURIComponent(catId) + '&date=' + today, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var logs = data.logs || [];
        var norm = function (s) {
          if (!s) return '';
          if (s === 'morning' || s === '朝') return '朝';
          if (s === 'afternoon' || s === '昼') return '昼';
          if (s === 'evening' || s === '晩') return '晩';
          return s;
        };
        for (var i = 0; i < logs.length; i++) {
          var log = logs[i];
          if (log.medication_id != null && String(log.medication_id) === String(medicationId)) {
            var logSlot = (log.scheduled_at || '').split('T')[1] || '';
            if (norm(logSlot) === norm(timeSlot)) {
              postLog(log.id);
              return;
            }
          }
        }
        alert('該当する投薬ログが見つかりませんでした');
      })
      .catch(function () { alert('投薬ログの取得に失敗しました'); });
  }

  var DASH_FOLD_KEY = 'nyagi_dash_folds';
  function loadDashFolds() {
    try { return JSON.parse(localStorage.getItem(DASH_FOLD_KEY)) || {}; } catch (_) { return {}; }
  }
  function saveDashFolds(map) {
    try { localStorage.setItem(DASH_FOLD_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function bindDashFolds() {
    var folds = loadDashFolds();
    var titles = dashView.querySelectorAll('.dash-fold-title');
    for (var i = 0; i < titles.length; i++) {
      (function (title) {
        var key = title.getAttribute('data-fold');
        var body = dashView.querySelector('[data-fold-target="' + key + '"]');
        if (!body) return;
        if (folds[key]) {
          body.style.display = 'none';
          title.classList.add('folded');
        }
        title.addEventListener('click', function () {
          var isHidden = body.style.display === 'none';
          body.style.display = isHidden ? '' : 'none';
          title.classList.toggle('folded', !isHidden);
          var map = loadDashFolds();
          if (!isHidden) { map[key] = true; } else { delete map[key]; }
          saveDashFolds(map);
        });
      })(titles[i]);
    }
  }

  // ── はき戻しサマリー ──

  function renderVomitSummary(cats) {
    var withVomit = [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].vomit_7d > 0) withVomit.push(cats[i]);
    }
    if (withVomit.length === 0) return '';

    withVomit.sort(function (a, b) { return b.vomit_7d - a.vomit_7d; });

    var html = '<div class="section-title dash-fold-title" data-fold="vomitSummary">🤮 はき戻し（直近7日）</div>';
    html += '<div class="dash-fold-body" data-fold-target="vomitSummary">';
    html += '<div class="card">';
    for (var i = 0; i < withVomit.length; i++) {
      var c = withVomit[i];
      var icon = c.species === 'dog' ? '🐶' : '🐱';
      var vColor = c.vomit_7d >= 3 ? '#f87171' : c.vomit_7d >= 2 ? '#fb923c' : '#facc15';
      var border = i < withVomit.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '';
      html += '<a href="cat.html?id=' + encodeURIComponent(c.id || '') + '" style="display:flex;align-items:center;justify-content:space-between;padding:8px 4px;text-decoration:none;color:inherit;' + border + '">';
      html += '<span style="font-size:13px;">' + icon + ' ' + escapeHtml(c.name) + '</span>';
      html += '<span style="font-size:14px;font-weight:700;color:' + vColor + ';">' + c.vomit_7d + '回</span>';
      html += '</a>';
    }
    html += '</div></div>';
    return html;
  }

  // ── 健康スコア TOP5 ──

  function renderHealthScoreTop5(cats) {
    var scored = [];
    for (var i = 0; i < cats.length; i++) {
      if (cats[i].health_score !== null && cats[i].health_score !== undefined) {
        scored.push(cats[i]);
      }
    }
    if (scored.length === 0) return '';

    scored.sort(function (a, b) { return a.health_score - b.health_score; });
    var top = scored.slice(0, 5);

    var html = '<div class="section-title dash-fold-title" data-fold="healthScore">🏥 健康スコア（注意順）</div>';
    html += '<div class="dash-fold-body" data-fold-target="healthScore">';
    html += '<div class="card">';
    for (var i = 0; i < top.length; i++) {
      var c = top[i];
      var s = c.health_score;
      var colorHex = s >= 80 ? '#4ade80' : s >= 60 ? '#facc15' : s >= 40 ? '#fb923c' : '#f87171';
      var icon = c.species === 'dog' ? '🐶' : '🐱';
      var border = i < top.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '';

      var topComment = extractTopComment(c.score_detail);

      html += '<a href="cat.html?id=' + encodeURIComponent(c.id || '') + '" style="display:block;padding:8px 0;text-decoration:none;color:inherit;' + border + '">';
      html += '<div style="display:flex;align-items:center;gap:10px;">';
      html += '<span style="font-size:22px;font-weight:900;min-width:38px;text-align:center;color:' + colorHex + ';">' + s + '</span>';
      html += '<div style="flex:1;min-width:0;">';
      html += '<div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;">' + icon + ' ' + escapeHtml(c.name);
      if (c.vomit_7d > 0) {
        html += ' <span style="font-size:10px;background:rgba(248,113,113,0.2);color:#f87171;padding:1px 5px;border-radius:10px;font-weight:600;">🤮' + c.vomit_7d + '</span>';
      }
      html += '</div>';
      html += '<div style="background:var(--surface-alt);border-radius:3px;height:4px;margin-top:4px;">';
      html += '<div style="background:' + colorHex + ';width:' + s + '%;height:100%;border-radius:3px;"></div>';
      html += '</div></div></div>';

      if (topComment) {
        html += '<div style="margin-top:4px;padding-left:48px;font-size:11px;">';
        html += '<span style="color:' + colorHex + ';">' + escapeHtml(topComment.area) + '</span> ';
        html += '<span style="color:var(--text-dim);">' + escapeHtml(topComment.reason) + '</span>';
        if (topComment.advice) html += ' → <span style="color:var(--text-main);">' + escapeHtml(topComment.advice) + '</span>';
        html += '</div>';
      }

      html += '</a>';
    }
    html += '</div></div>';
    return html;
  }

  function extractTopComment(detailJson) {
    if (!detailJson) return null;
    var detail;
    try { detail = JSON.parse(detailJson); } catch (_) { return null; }
    var comments = detail.comments;
    if (!comments || !comments.length) return null;
    var worst = null;
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      if (!c || !c.advice) continue;
      if (!worst || c.advice.length > worst.advice.length) worst = c;
    }
    return worst;
  }

  // ── レンダリングヘルパー ──

  function renderAlertCard(cat, level) {
    var icon = level === 'critical' ? '🔴' : '🟡';
    var html = '<div class="alert-card ' + level + '">';
    html += '<div class="alert-icon">' + icon + '</div>';
    html += '<div class="alert-body">';
    html += '<div class="alert-name">' + escapeHtml(cat.name) + '</div>';
    html += '<div class="alert-reason">' + escapeHtml(cat.alert_reason || '') + '</div>';
    if (cat.alert_until) {
      html += '<div class="alert-until">〜 ' + escapeHtml(cat.alert_until) + '</div>';
    }
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderMedCardsBySlot(medBySlot) {
    var total = medBySlot.morning.length + medBySlot.noon.length + medBySlot.evening.length;
    if (total === 0) return '<div class="empty-msg">投薬予定なし</div>';

    var html = '';
    var slots = [
      { key: 'morning', label: '朝', emoji: '🌅', meds: medBySlot.morning },
      { key: 'noon', label: '昼', emoji: '☀️', meds: medBySlot.noon },
      { key: 'evening', label: '夜', emoji: '🌙', meds: medBySlot.evening }
    ];
    for (var s = 0; s < slots.length; s++) {
      var slot = slots[s];
      if (slot.meds.length === 0) continue;
      html += '<div class="med-slot-card" style="margin-bottom:12px;">';
      html += '<div class="med-slot-card-title" style="font-size:13px;font-weight:700;color:var(--text-dim);margin-bottom:8px;padding-left:4px;">' + slot.emoji + ' ' + slot.label + '</div>';
      html += '<div class="card" style="margin-bottom:0;padding:8px;">';
      for (var i = 0; i < slot.meds.length; i++) {
        var m = slot.meds[i];
        if (m.status !== undefined) {
          html += renderMedItem(m, true);
        } else {
          html += renderPendingMed(m, true);
        }
      }
      html += '</div></div>';
    }
    return html;
  }

  function renderMedItem(med, inSlotCard) {
    var isDone = med.status === 'done';
    var isSkipped = med.status === 'skipped';
    var isPending = med.status === 'pending';
    var stateClass = isDone ? 'med-item--done' : isSkipped ? 'med-item--skipped' : 'med-item--pending';
    var html = '<div class="med-item dash-med-item ' + stateClass + '" data-cat-id="' + (med.cat_id || '') + '" data-medication-id="' + (med.medication_id || '') + '" data-log-id="' + (med.log_id || '') + '" data-time-slot="' + escapeHtml(med.time_slot || '') + '">';
    if (!inSlotCard) {
      html += '<div class="med-time" style="min-width:0;">' + escapeHtml(med.time_slot || '') + '</div>';
    }
    html += '<div class="med-info">';
    if (isDone) {
      html += '<div class="med-cat">✅ ' + escapeHtml(med.cat_name || '') + ' <span class="med-status-badge med-status-badge--done">完了済み</span></div>';
    } else if (isSkipped) {
      html += '<div class="med-cat">⏭️ ' + escapeHtml(med.cat_name || '') + ' <span class="med-status-badge med-status-badge--skipped">スキップ</span></div>';
    } else {
      html += '<div class="med-cat">⬜ ' + escapeHtml(med.cat_name || '') + ' <span class="med-status-badge med-status-badge--pending">未実施</span></div>';
    }
    html += '<div class="med-name">' + escapeHtml(med.medicine_name || '') + ' ' + escapeHtml(med.dosage || '') + '</div>';
    if (med.notes) {
      html += '<div class="med-notes">' + escapeHtml(med.notes) + '</div>';
    }
    if (isPending) {
      html += '<div class="med-log-actions" style="display:flex;gap:6px;margin-top:6px;">';
      html += '<button class="btn-log-action done" data-action="done">完了にする</button>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderPendingMed(med, inSlotCard) {
    var html = '<div class="med-item" style="border-left:3px solid #f87171;">';
    if (!inSlotCard) {
      html += '<div class="med-time">' + escapeHtml(med.time_slot || '') + '</div>';
    }
    html += '<div class="med-info">';
    html += '<div class="med-cat">' + escapeHtml(med.cat_name || '') + '</div>';
    html += '<div class="med-name">' + escapeHtml(med.medicine_name || '') + '</div>';
    html += '<div class="med-notes" style="color:#f87171;">未実施</div>';
    html += '</div></div>';
    return html;
  }

  function renderActionItem(action, type) {
    var html = '<div class="action-item ' + type + '">';
    html += '<div class="action-title">' + escapeHtml(action.title || '') + '</div>';
    html += '<div class="action-meta">';
    if (action.due_date) html += '期限: ' + escapeHtml(formatDate(action.due_date)) + ' ';
    if (action.priority) html += '優先度: ' + escapeHtml(action.priority);
    html += '</div>';
    html += '</div>';
    return html;
  }

  function renderAnomalyItem(item) {
    var html = '<div class="anomaly-item">';
    html += '<div><span class="anomaly-cat">' + escapeHtml(item.cat_name || item.target_cat_id || '') + '</span> ';
    html += '<span class="anomaly-layer">' + escapeHtml(item.routing_layer || '') + '</span></div>';
    html += '<div class="anomaly-text">' + escapeHtml(item.raw_transcript || '') + '</div>';
    html += '</div>';
    return html;
  }

  function loadTaskProgressBars() {
    var container = document.getElementById('dashTaskProgress');
    if (!container) return;
    var today = new Date();
    var y = today.getFullYear();
    var mo = ('0' + (today.getMonth() + 1)).slice(-2);
    var d = ('0' + today.getDate()).slice(-2);
    var dateStr = y + '-' + mo + '-' + d;
    var url = _origin + '/api/ops/tasks?date=' + dateStr + '&group_by=attribute';
    fetch(url, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var prog = data.progress || {};
        var groups = data.attribute_groups || [];
        var html = '';

        if (prog.total > 0) {
          var pct = prog.pct || 0;
          var barColor = pct >= 80 ? '#4ade80' : pct >= 50 ? '#facc15' : '#f87171';
          html += '<div class="card" style="margin-bottom:10px;padding:10px 12px;">';
          html += '<div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:6px;">';
          html += '<span>全体: ' + (prog.done || 0) + '/' + prog.total + ' 完了</span>';
          html += '<span style="font-weight:600;">' + pct + '%</span></div>';
          html += '<div style="background:var(--surface-alt);border-radius:4px;height:8px;">';
          html += '<div style="background:' + barColor + ';width:' + pct + '%;height:100%;border-radius:4px;transition:width .3s;"></div>';
          html += '</div></div>';
        }

        if (groups.length > 0) {
          html += '<div class="card" style="padding:10px 12px;">';
          for (var i = 0; i < groups.length; i++) {
            var g = groups[i];
            var gp = g.progress || {};
            var gpct = gp.pct || 0;
            var gc = gpct >= 80 ? '#4ade80' : gpct >= 50 ? '#facc15' : '#f87171';
            if (gp.total === 0) continue;
            html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">';
            html += '<span style="font-size:16px;width:22px;text-align:center;">' + (g.icon || '📋') + '</span>';
            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim);margin-bottom:2px;">';
            html += '<span>' + escapeHtml(g.label) + '</span>';
            html += '<span>' + (gp.done || 0) + '/' + gp.total + (gpct === 100 ? ' ✨' : '') + '</span></div>';
            html += '<div style="background:var(--surface-alt);border-radius:3px;height:5px;">';
            html += '<div style="background:' + gc + ';width:' + gpct + '%;height:100%;border-radius:3px;transition:width .3s;"></div>';
            html += '</div></div></div>';
          }
          html += '</div>';
        }

        if (!prog.total) {
          html = '<div class="empty-msg">タスクなし</div>';
        }

        container.innerHTML = html;
      })
      .catch(function () {
        container.innerHTML = '<div class="empty-msg" style="font-size:12px;">タスク読み込み失敗</div>';
      });
  }

  function renderDashTaskItem(task) {
    var prioIcon = task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : '⬜';
    var html = '<div class="action-item today" style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">';
    html += '<span style="font-size:14px;">' + prioIcon + '</span>';
    html += '<div style="flex:1;">';
    html += '<div style="font-size:13px;">';
    if (task.cat_name) html += '<span style="color:#a78bfa;">' + escapeHtml(task.cat_name) + ' </span>';
    html += escapeHtml(task.title) + '</div>';
    if (task.assigned_name) {
      html += '<div style="font-size:11px;color:var(--text-dim);">担当: ' + escapeHtml(task.assigned_name) + '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderUnreportedCat(cat) {
    var icon = cat.species === 'dog' ? '🐶' : '🐱';
    var html = '<div class="unreported-item">';
    html += '<div class="unreported-name">' + icon + ' ' + escapeHtml(cat.name) + '</div>';
    html += '<div class="unreported-missing">未記録: ' + escapeHtml((cat.missing || []).join('、')) + '</div>';
    html += '</div>';
    return html;
  }

  // ── ユーティリティ ──

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var mo = d.getMonth() + 1;
      var da = d.getDate();
      var h = d.getHours();
      var mi = d.getMinutes();
      return mo + '/' + da + ' ' + (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
    } catch (_) { return iso; }
  }

})();
