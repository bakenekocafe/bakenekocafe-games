/**
 * NYAGI ダッシュボード JS (ES5 互換)
 *
 * 朝 morning + 夕 evening の両APIを統合し、1画面で全情報を表示。
 */

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops/dashboard';

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
    if (window.NyagiBootOverlay && retryCount === 0) window.NyagiBootOverlay.show('MAGI ダッシュボード同期中…');
    dashView.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';

    var q = locationQuery();
    var ctrl = new AbortController();
    var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
    var morningReq = fetch(API_BASE + '/morning' + q, { headers: apiHeaders(), cache: 'no-store', signal: ctrl.signal }).then(function (r) { return r.json(); });
    var eveningReq = fetch(API_BASE + '/evening' + q, { headers: apiHeaders(), cache: 'no-store', signal: ctrl.signal }).then(function (r) { return r.json(); });

    Promise.all([morningReq, eveningReq])
      .then(function (results) {
        clearTimeout(timeoutId);
        var mData = results[0] || {};
        var eData = results[1] || {};
        if (mData.error && eData.error) {
          if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
          dashView.innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(mData.message || mData.error) + '</div>';
          return;
        }
        renderUnified(mData, eData);
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        var isNetworkErr = (err && (err.name === 'AbortError' || (err.message && (err.message.indexOf('Failed to fetch') !== -1 || err.message.indexOf('NetworkError') !== -1))));
        if (isNetworkErr && retryCount < 2) {
          dashView.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...（再試行 ' + (retryCount + 1) + '/2）</div>';
          setTimeout(function () { loadDashboard(retryCount + 1); }, 1200);
          return;
        }
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
        var msg = err && err.name === 'AbortError' ? 'タイムアウトしました' : '読み込みに失敗しました';
        var hint = (location.port !== '8001' && location.hostname === 'localhost') ? '<br><span style="font-size:11px;color:var(--text-dim);">※ http://localhost:8001/nyagi-app/ で開くと安定します</span>' : '';
        dashView.innerHTML = '<div class="empty-msg">' + msg + hint + '</div><button class="btn btn-primary" style="margin-top:12px;" onclick="location.reload()">再試行</button>';
      });
  }

  // ── 統合レンダリング ──

  /** 給餌あげたサマリー: 朝／夜の1列分（献立0件は —）。title 省略時はデータ行用（見出しなし） */
  function renderFedSummarySlotColumn(title, block) {
    var pl = block && block.plans_total != null ? block.plans_total : 0;
    var fd = block && block.fed_count != null ? block.fed_count : 0;
    var pctRaw = block && block.fed_pct != null ? block.fed_pct : null;
    var label = title
      ? '<div style="font-size:9px;color:var(--text-dim);line-height:1.25;">' + title + '</div>'
      : '';
    if (pl === 0) {
      return (
        '<div style="width:82px;text-align:center;flex-shrink:0;">' +
        label +
        '<div style="color:var(--text-dim);font-size:12px;margin-top:' +
        (title ? '4' : '0') +
        'px;">—</div>' +
        '</div>'
      );
    }
    var pct = pctRaw != null ? pctRaw : Math.round((fd / pl) * 100);
    var col = pct >= 80 ? '#4ade80' : pct >= 50 ? '#facc15' : '#f87171';
    return (
      '<div style="width:82px;text-align:center;flex-shrink:0;">' +
      label +
      '<div style="color:' +
      col +
      ';font-weight:600;font-size:12px;margin-top:' +
      (title ? '2' : '0') +
      'px;white-space:nowrap;">' +
      fd +
      '/' +
      pl +
      '</div>' +
      '<div style="color:' + col + ';font-weight:700;font-size:13px;">' +
      pct +
      '%</div>' +
      '</div>'
    );
  }

  function renderUnified(m, e) {
    var html = '';

    // 1. 🚨 今すぐ対応
    var crits = m.critical_cats || [];
    var watches = m.watch_cats || [];
    if (crits.length > 0 || watches.length > 0) {
      html += '<div class="section-title dash-fold-title" id="dash-jump-dashCritical" data-fold="dashCritical">🚨 今すぐ対応</div>';
      html += '<div class="dash-fold-body" data-fold-target="dashCritical">';
      for (var i = 0; i < crits.length; i++) html += renderAlertCard(crits[i], 'critical');
      for (var i = 0; i < watches.length; i++) html += renderAlertCard(watches[i], 'watch');
      html += '</div>';
    }

    // 2. 🏥 健康スコア（フィルタ内の全猫・注意順）
    html += renderHealthScoreSection(m.cats_summary || []);

    // 2.5 🤮 はき戻し（直近7日で記録がある猫のみ）
    html += renderVomitSummary(m.cats_summary || []);

    // 3. ✅ タスク（タスクAPIから進捗バーを取得して表示）
    html += '<div class="section-title dash-fold-title" id="dash-jump-dashTasks" data-fold="dashTasks">✅ タスク</div>';
    html += '<div class="dash-fold-body" data-fold-target="dashTasks">';
    html += '<div id="dashTaskProgress"><div class="loading" style="padding:12px;font-size:12px;"><span class="spinner"></span> 読み込み中...</div></div>';
    html += '<a href="tasks.html" style="display:block;text-align:center;font-size:12px;color:var(--primary);margin-top:8px;text-decoration:none;">タスク一覧を見る →</a>';
    html += '</div>';

    html += renderMedicationSummarySection(m.medication_summary);
    html += renderCareDailySummarySection(m.care_daily_summary);
    html += renderUrineTodaySummarySection(m.urine_today_summary);

    // 5. 📋 未完了アクション
    var overdueActions = m.overdue_actions || [];
    var todayActions = m.today_actions || [];
    if (overdueActions.length > 0 || todayActions.length > 0) {
      html += '<div class="section-title dash-fold-title" id="dash-jump-dashActions" data-fold="dashActions">📋 未完了アクション</div>';
      html += '<div class="dash-fold-body" data-fold-target="dashActions">';
      for (var i = 0; i < overdueActions.length; i++) html += renderActionItem(overdueActions[i], 'overdue');
      for (var i = 0; i < todayActions.length; i++) html += renderActionItem(todayActions[i], 'today');
      html += '</div>';
    }

    // 5. ⚠️ 昨夜からの異常
    var anomalies = m.yesterday_anomalies || [];
    if (anomalies.length > 0) {
      html += '<div class="section-title dash-fold-title" id="dash-jump-dashAnomaly" data-fold="dashAnomaly">⚠️ 昨夜からの異常</div>';
      html += '<div class="dash-fold-body" data-fold-target="dashAnomaly">';
      for (var i = 0; i < anomalies.length; i++) html += renderAnomalyItem(anomalies[i]);
      html += '</div>';
    }

    // 7. 📊 今日の記録
    var summary = e.today_summary || {};
    var totalInputs = summary.total_inputs || 0;
    var anomalyItems = summary.today_anomaly_items || [];
    if (totalInputs > 0) {
      html += '<div class="section-title dash-fold-title" id="dash-jump-dashToday" data-fold="dashToday">📊 今日の記録</div>';
      html += '<div class="dash-fold-body" data-fold-target="dashToday">';
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
      html += '</div>';
    }

    // 8. 🍽 給餌サマリー（献立に対する「あげた」記録・朝／夜の2列）
    var feedingSummary = e.feeding_summary || [];
    if (feedingSummary.length > 0) {
      html +=
        '<div class="section-title dash-fold-title" id="dash-jump-dashFeeding" data-fold="dashFeeding">🍽 給餌サマリー <small class="dim" style="font-weight:500;font-size:11px;">（あげた記録・朝／夜）</small></div>';
      html += '<div class="dash-fold-body" data-fold-target="dashFeeding">';
      html += '<div class="card">';
      html +=
        '<div style="display:flex;align-items:flex-end;padding:4px 0 8px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:10px;color:var(--text-dim);">' +
        '<span style="flex:1;min-width:0;"></span>' +
        '<span style="width:82px;text-align:center;flex-shrink:0;line-height:1.25;">☀ 朝</span>' +
        '<span style="width:82px;text-align:center;flex-shrink:0;line-height:1.25;">☾ 夜分<br><small style="font-weight:500;opacity:0.85;">（晩・昼等）</small></span>' +
        '<span style="width:36px;flex-shrink:0;"></span>' +
        '</div>';
      for (var i = 0; i < feedingSummary.length; i++) {
        var fs = feedingSummary[i];
        var fid = fs.cat_id || '';
        var mo = fs.morning;
        var ev = fs.evening;
        if (!mo && !ev && (fs.plans_total || 0) > 0) {
          mo = { plans_total: 0, fed_count: 0, fed_pct: null };
          ev = {
            plans_total: fs.plans_total,
            fed_count: fs.fed_count,
            fed_pct: fs.fed_pct != null ? fs.fed_pct : null,
          };
        } else {
          mo = mo || { plans_total: 0, fed_count: 0, fed_pct: null };
          ev = ev || { plans_total: 0, fed_count: 0, fed_pct: null };
        }
        html +=
          '<div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;padding:6px 0;' +
          (i < feedingSummary.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '') +
          '">';
        if (fid) {
          html +=
            '<a href="cat.html?id=' +
            encodeURIComponent(fid) +
            '" style="color:inherit;text-decoration:none;flex:1;min-width:0;padding-right:6px;">' +
            escapeHtml(fs.cat_name || '') +
            '</a>';
          html += renderFedSummarySlotColumn('', mo);
          html += renderFedSummarySlotColumn('', ev);
          html +=
            '<a href="cat.html?id=' +
            encodeURIComponent(fid) +
            '#feedingArea" class="btn-edit-small" style="margin-left:4px;font-size:11px;padding:2px 6px;flex-shrink:0;" title="猫詳細で編集">✏️</a>';
        } else {
          html += '<span style="flex:1;min-width:0;padding-right:6px;">' + escapeHtml(fs.cat_name || '') + '</span>';
          html += renderFedSummarySlotColumn('', mo);
          html += renderFedSummarySlotColumn('', ev);
          html += '<span style="width:36px;flex-shrink:0;"></span>';
        }
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    // 9. 📅 明日の予定
    var tmrEvents = e.tomorrow_events || [];
    if (tmrEvents.length > 0) {
      html += '<div class="section-title dash-fold-title" id="dash-jump-dashTomorrow" data-fold="dashTomorrow">📅 明日の予定</div>';
      html += '<div class="dash-fold-body" data-fold-target="dashTomorrow">';
      for (var i = 0; i < tmrEvents.length; i++) {
        var evt = tmrEvents[i];
        html += '<div class="action-item today">';
        html += '<div class="action-title">' + escapeHtml(evt.cat_name || '') + ': ' + escapeHtml(evt.event || '') + '</div>';
        if (evt.action_needed) {
          html += '<div class="action-meta">' + escapeHtml(evt.action_needed) + '</div>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    // 10. 🏥 病院スケジュール（折りたたみ可）
    var vetScheds = e.vet_schedules || [];
    var vetTypeLabels = { vaccine: 'ワクチン', checkup: '健診', surgery: '手術', dental: '歯科', test: '検査', observation: '経過観察' };
    html += '<div class="section-title dash-fold-title" id="dash-jump-vetSchedule" data-fold="vetSchedule">🏥 病院スケジュール';
    if (vetScheds.length > 0) {
      html += ' <small class="dim" style="font-weight:500;">' + vetScheds.length + '件</small>';
    }
    html += '</div>';
    html += '<div class="dash-fold-body" data-fold-target="vetSchedule">';
    var vetSheet = e.vet_schedule_sheet || null;
    var locLabelForSheet = currentLocationId === 'all' ? '全部' : (LOC_LABELS[currentLocationId] || currentLocationId || '—');
    html += '<div class="dash-vet-sheet-bar" style="margin-bottom:12px;padding:10px 12px;background:rgba(99,102,241,0.08);border-radius:8px;border:1px solid rgba(99,102,241,0.22);">';
    html += '<div style="font-size:12px;font-weight:600;margin-bottom:6px;color:var(--text-main);">📎 一覧表・写真（ホワイトボード・印刷スケジュールなど）</div>';
    html += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">';
    html += '<input type="file" id="dashVetSheetInput" accept="application/pdf,.pdf,image/jpeg,image/png,image/gif,image/webp" style="display:none;">';
    html += '<button type="button" class="btn btn-outline btn-sm" id="dashVetSheetPickBtn" style="font-size:12px;">ファイルを選択</button>';
    if (vetSheet && vetSheet.name) {
      html += '<span id="dashVetSheetName" class="dim" style="font-size:12px;flex:1;min-width:100px;word-break:break-word;">' + escapeHtml(vetSheet.name) + '</span>';
      html += '<button type="button" class="btn btn-outline btn-sm" id="dashVetSheetOpenBtn" style="font-size:12px;">開く</button>';
      html += '<button type="button" class="btn btn-outline btn-sm" id="dashVetSheetDelBtn" style="font-size:12px;color:#f87171;border-color:rgba(248,113,113,0.35);">削除</button>';
    } else {
      html += '<span class="dim" style="font-size:12px;flex:1;">未アップロード <small style="opacity:0.85;">（拠点: ' + escapeHtml(locLabelForSheet) + '）</small></span>';
    }
    html += '</div>';
    html += '<p class="dim" style="font-size:10px;margin:6px 0 0;line-height:1.4;">表示中の拠点タブごとに1ファイル。PDF・画像 10MB以下。アップロードで差し替え。</p>';
    html += '</div>';
    if (vetScheds.length === 0) {
      html += '<div style="padding:12px;background:var(--surface);border-radius:8px;text-align:center;color:var(--text-dim);font-size:13px;">登録されているスケジュールはありません</div>';
    } else {
      var within30 = [];
      var later = [];
      for (var vi = 0; vi < vetScheds.length; vi++) {
        if (vetScheds[vi].days_left <= 30) { within30.push(vetScheds[vi]); }
        else { later.push(vetScheds[vi]); }
      }
      function formatVetDate(isoDate) {
        if (!isoDate) return '';
        if (window.NyagiJst && typeof NyagiJst.formatYmdWithWday === 'function') {
          return NyagiJst.formatYmdWithWday(isoDate) || '';
        }
        var d = new Date(String(isoDate).slice(0, 10) + 'T12:00:00+09:00');
        var wk = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'long' }).format(d);
        var w = { Sunday: '日', Monday: '月', Tuesday: '火', Wednesday: '水', Thursday: '木', Friday: '金', Saturday: '土' }[wk] || '';
        var map = {};
        var fp = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(d);
        for (var fi = 0; fi < fp.length; fi++) {
          if (fp[fi].type !== 'literal') map[fp[fi].type] = fp[fi].value;
        }
        return Number(map.month) + '/' + Number(map.day) + (w ? '（' + w + '）' : '');
      }
      function formatVetDateTime(val) {
        if (!val) return '';
        if (window.NyagiJst && typeof NyagiJst.formatBookedDateTime === 'function') {
          return NyagiJst.formatBookedDateTime(val) || '';
        }
        var parts = val.split(' ');
        var datePart = parts[0];
        var timePart = parts[1] || '';
        var d = new Date(datePart + 'T12:00:00+09:00');
        var wk2 = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'long' }).format(d);
        var w2 = { Sunday: '日', Monday: '月', Tuesday: '火', Wednesday: '水', Thursday: '木', Friday: '金', Saturday: '土' }[wk2] || '';
        var map2 = {};
        var fp2 = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }).formatToParts(d);
        for (var fj = 0; fj < fp2.length; fj++) {
          if (fp2[fj].type !== 'literal') map2[fp2[fj].type] = fp2[fj].value;
        }
        var result = Number(map2.month) + '/' + Number(map2.day) + (w2 ? '（' + w2 + '）' : '');
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
    html += '</div>';

    dashView.innerHTML = html;
    bindDashFolds();
    bindTodayRecordAnomaly();
    bindVetBookButtons();
    bindVetScheduleSheet();
    loadTaskProgressBars();
    ensureDashSectionNav();
  }

  function bindVetScheduleSheet() {
    if (!credentials) return;
    var input = document.getElementById('dashVetSheetInput');
    var pick = document.getElementById('dashVetSheetPickBtn');
    var openBtn = document.getElementById('dashVetSheetOpenBtn');
    var delBtn = document.getElementById('dashVetSheetDelBtn');
    if (!input || !pick) return;
    pick.addEventListener('click', function () { input.click(); });
    input.addEventListener('change', function () {
      if (!input.files || !input.files[0]) return;
      var f = input.files[0];
      if (f.size > 10 * 1024 * 1024) {
        alert('ファイルサイズが大きすぎます（10MB以下）');
        input.value = '';
        return;
      }
      var fd = new FormData();
      fd.append('file', f);
      var loc = currentLocationId || 'all';
      pick.disabled = true;
      var prevLabel = pick.textContent;
      pick.textContent = 'アップロード中…';
      fetch(_origin + '/api/ops/dashboard/vet-schedule-sheet?location=' + encodeURIComponent(loc), {
        method: 'POST',
        headers: { 'X-Admin-Key': credentials.adminKey, 'X-Staff-Id': credentials.staffId },
        body: fd,
        cache: 'no-store',
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        pick.disabled = false;
        pick.textContent = prevLabel;
        input.value = '';
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        loadDashboard();
      }).catch(function () {
        pick.disabled = false;
        pick.textContent = prevLabel;
        alert('アップロードに失敗しました');
      });
    });
    if (openBtn) {
      openBtn.addEventListener('click', function () {
        var loc = currentLocationId || 'all';
        fetch(_origin + '/api/ops/dashboard/vet-schedule-sheet?location=' + encodeURIComponent(loc), {
          method: 'GET',
          headers: apiHeaders(),
          cache: 'no-store',
        }).then(function (r) {
          if (!r.ok) throw new Error('http');
          return r.blob();
        }).then(function (blob) {
          var u = URL.createObjectURL(blob);
          window.open(u, '_blank', 'noopener');
          setTimeout(function () { URL.revokeObjectURL(u); }, 120000);
        }).catch(function () { alert('ファイルの取得に失敗しました'); });
      });
    }
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('一覧表の添付を削除しますか？')) return;
        var loc = currentLocationId || 'all';
        fetch(_origin + '/api/ops/dashboard/vet-schedule-sheet?location=' + encodeURIComponent(loc), {
          method: 'DELETE',
          headers: apiHeaders(),
          cache: 'no-store',
        }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          loadDashboard();
        }).catch(function () { alert('削除に失敗しました'); });
      });
    }
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
      dateInput.value = (window.NyagiJst && NyagiJst.todayYmd) ? NyagiJst.todayYmd() : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
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
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({ booked_date: bookedValue }),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        loadDashboard();
      }).catch(function () { alert('保存に失敗しました'); saveBtn.disabled = false; saveBtn.textContent = '保存'; });
    });
  }

  var DASH_FOLD_KEY = 'nyagi_dash_folds_v2';
  var DASH_FOLD_LEGACY_KEY = 'nyagi_dash_folds';

  /** 未保存時は常に折りたたみ（localStorage で開閉を記録） */
  function dashFoldDefaultExpanded(key) {
    return false;
  }

  function loadDashFolds() {
    try {
      var raw = localStorage.getItem(DASH_FOLD_KEY);
      if (raw != null && raw !== '') return JSON.parse(raw) || {};
    } catch (_) {}
    try {
      var leg = localStorage.getItem(DASH_FOLD_LEGACY_KEY);
      if (leg != null && leg !== '') {
        var o = JSON.parse(leg) || {};
        try { localStorage.removeItem(DASH_FOLD_LEGACY_KEY); } catch (_) {}
        try { localStorage.setItem(DASH_FOLD_KEY, JSON.stringify(o)); } catch (_) {}
        return o;
      }
    } catch (_) {}
    return {};
  }

  function saveDashFolds(map) {
    try { localStorage.setItem(DASH_FOLD_KEY, JSON.stringify(map)); } catch (_) {}
  }

  function expandDashFoldByKey(key) {
    if (!key || !dashView) return;
    var title = dashView.querySelector('.dash-fold-title[data-fold="' + key + '"]');
    var body = dashView.querySelector('[data-fold-target="' + key + '"]');
    if (!title || !body) return;
    body.style.display = '';
    title.classList.remove('folded');
    var map = loadDashFolds();
    if (dashFoldDefaultExpanded(key)) {
      delete map[key];
    } else {
      map[key] = false;
    }
    saveDashFolds(map);
  }

  /** お薬あげたサマリー（朝API medication_summary・給餌サマリーと同型・朝／夜） */
  function renderMedicationSummarySection(medSummary) {
    if (!medSummary || medSummary.length === 0) return '';
    var html =
      '<div class="section-title dash-fold-title" id="dash-jump-dashMed" data-fold="dashMed">💊 お薬サマリー <small class="dim" style="font-weight:500;font-size:11px;">（あげた記録・朝／夜）</small></div>';
    html += '<div class="dash-fold-body" data-fold-target="dashMed">';
    html +=
      '<p class="dim" style="font-size:11px;line-height:1.45;margin:0 0 10px;padding:0 2px;">当日スケジュールの各帯について、<strong>実施（ログが done／administered）</strong> の件数を数えます。<strong>スキップは未実施</strong>です。必要時投薬は対象外。夜分＝昼・晩・その他の帯。</p>';
    html += '<div class="card">';
    html +=
      '<div style="display:flex;align-items:flex-end;padding:4px 0 8px;border-bottom:1px solid rgba(255,255,255,0.08);font-size:10px;color:var(--text-dim);">' +
      '<span style="flex:1;min-width:0;"></span>' +
      '<span style="width:82px;text-align:center;flex-shrink:0;line-height:1.25;">☀ 朝</span>' +
      '<span style="width:82px;text-align:center;flex-shrink:0;line-height:1.25;">☾ 夜分<br><small style="font-weight:500;opacity:0.85;">（晩・昼等）</small></span>' +
      '<span style="width:36px;flex-shrink:0;"></span>' +
      '</div>';
    for (var i = 0; i < medSummary.length; i++) {
      var fs = medSummary[i];
      var fid = fs.cat_id || '';
      var mo = fs.morning || { plans_total: 0, fed_count: 0, fed_pct: null };
      var ev = fs.evening || { plans_total: 0, fed_count: 0, fed_pct: null };
      html +=
        '<div style="display:flex;align-items:center;justify-content:space-between;font-size:13px;padding:6px 0;' +
        (i < medSummary.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '') +
        '">';
      if (fid) {
        html +=
          '<a href="cat.html?id=' +
          encodeURIComponent(fid) +
          '" style="color:inherit;text-decoration:none;flex:1;min-width:0;padding-right:6px;">' +
          escapeHtml(fs.cat_name || '') +
          '</a>';
        html += renderFedSummarySlotColumn('', mo);
        html += renderFedSummarySlotColumn('', ev);
        html +=
          '<a href="cat.html?id=' +
          encodeURIComponent(fid) +
          '#medicationArea" class="btn-edit-small" style="margin-left:4px;font-size:11px;padding:2px 6px;flex-shrink:0;" title="猫詳細の投薬">✏️</a>';
      } else {
        html += '<span style="flex:1;min-width:0;padding-right:6px;">' + escapeHtml(fs.cat_name || '') + '</span>';
        html += renderFedSummarySlotColumn('', mo);
        html += renderFedSummarySlotColumn('', ev);
        html += '<span style="width:36px;flex-shrink:0;"></span>';
      }
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  /** 当日の排尿記録サマリー（朝API urine_today_summary・全猫＋has_today_record） */
  function renderUrineTodaySummarySection(rows) {
    rows = rows || [];
    var html =
      '<div class="section-title dash-fold-title" id="dash-jump-dashUrineToday" data-fold="dashUrineToday">💧 排尿 <small class="dim" style="font-weight:600;font-size:11px;">（当日・全頭）</small></div>';
    html += '<div class="dash-fold-body" data-fold-target="dashUrineToday">';
    if (rows.length === 0) {
      html +=
        '<div class="dim" style="padding:8px;font-size:12px;text-align:center;">対象の猫がいません</div>';
    } else {
      var nOk = 0;
      var nMiss = 0;
      for (var si = 0; si < rows.length; si++) {
        var sRow = rows[si];
        var sDone = sRow.has_today_record === true || (sRow.record_count || 0) > 0;
        if (sDone) nOk++;
        else nMiss++;
      }
      html +=
        '<div style="display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;margin:0 0 6px;padding:5px 8px;border-radius:6px;background:rgba(255,255,255,0.04);font-size:11px;font-weight:700;">' +
        '<span style="color:#4ade80;">✓' +
        nOk +
        '</span>' +
        '<span style="color:#fb923c;">未' +
        nMiss +
        '</span>' +
        '<span class="dim" style="font-weight:500;">計' +
        rows.length +
        '</span>' +
        '</div>';
      html += '<div class="card" style="padding:4px 6px;">';
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var cid = r.cat_id || '';
        var hasRec = r.has_today_record === true || (r.record_count || 0) > 0;
        var rowBg = hasRec
          ? 'background:rgba(74,222,128,0.06);border-left:3px solid #4ade80;'
          : 'background:rgba(251,146,60,0.08);border-left:3px solid #fb923c;';
        var mark = hasRec
          ? '<span style="flex-shrink:0;width:14px;text-align:center;font-size:10px;color:#4ade80;line-height:1.2;">✓</span>'
          : '<span style="flex-shrink:0;width:14px;text-align:center;font-size:10px;color:#fb923c;line-height:1.2;font-weight:800;">!</span>';
        html +=
          '<div style="' +
          rowBg +
          'border-radius:6px;margin-bottom:3px;padding:5px 6px 5px 4px;font-size:12px;">';
        html += '<div style="display:flex;align-items:center;gap:4px;min-width:0;">';
        html += mark;
        if (cid) {
          html +=
            '<a href="cat.html?id=' +
            encodeURIComponent(cid) +
            '#urineArea" style="color:inherit;text-decoration:none;font-weight:600;flex-shrink:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            escapeHtml(r.cat_name || '') +
            '</a>';
        } else {
          html +=
            '<span style="font-weight:600;flex-shrink:0;max-width:42%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
            escapeHtml(r.cat_name || '') +
            '</span>';
        }
        if (hasRec) {
          html +=
            '<span style="color:var(--text-dim);font-size:10px;flex-shrink:0;">' +
            (r.record_count || 0) +
            '件</span>';
          if (r.summary_line) {
            html +=
              '<span style="font-size:10px;color:var(--text-dim);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' +
              escapeHtml(r.summary_line) +
              '">' +
              escapeHtml(r.summary_line) +
              '</span>';
          }
        } else {
          html += '<span style="font-size:10px;color:var(--text-dim);flex:1;">—</span>';
        }
        html += '</div></div>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  /** 今日のケア進捗カード（朝API care_daily_summary） */
  function renderCareDailySummarySection(careRows) {
    if (!careRows || careRows.length === 0) return '';
    var html =
      '<div class="section-title dash-fold-title" id="dash-jump-careDaily" data-fold="careDaily">🪮 今日のケア進捗' +
      ' <small class="dim" style="font-weight:500;font-size:11px;">（5項目・未完了が多い順）</small></div>';
    html += '<div class="dash-fold-body" data-fold-target="careDaily">';
    html += '<div class="card">';
    html +=
      '<p class="dim" style="font-size:11px;line-height:1.45;margin:0 0 10px;">ブラシ・アゴ・耳・お尻・目ヤニ拭き（一覧の「5項目まとめて記録」と同じ。爪切り・肉球は含みません）。当日に「実施」の記録がある項目を数えます。</p>';
    html +=
      '<a href="cats.html" style="display:inline-block;font-size:12px;color:var(--primary);margin-bottom:10px;text-decoration:none;">猫一覧（ケア入力）→</a>';
    for (var i = 0; i < careRows.length; i++) {
      var cr = careRows[i];
      var cid = cr.cat_id || '';
      var done = cr.items_done != null ? cr.items_done : 0;
      var tot = cr.items_total != null ? cr.items_total : 5;
      var pct = cr.items_pct != null ? cr.items_pct : 0;
      var miss = cr.missing_labels || [];
      var missStr = miss.length ? miss.join('・') : '';
      var col = pct >= 80 ? '#4ade80' : pct >= 50 ? '#facc15' : '#f87171';
      var border = i < careRows.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '';
      html += '<div style="padding:8px 0;' + border + 'font-size:13px;">';
      html += '<div style="display:flex;align-items:flex-start;gap:8px;flex-wrap:wrap;">';
      if (cid) {
        html +=
          '<a href="cat.html?id=' +
          encodeURIComponent(cid) +
          '" style="color:inherit;text-decoration:none;font-weight:600;flex:1;min-width:120px;">' +
          escapeHtml(cr.cat_name || '') +
          '</a>';
      } else {
        html += '<span style="font-weight:600;flex:1;min-width:120px;">' + escapeHtml(cr.cat_name || '') + '</span>';
      }
      html +=
        '<span style="color:' +
        col +
        ';font-weight:700;white-space:nowrap;">' +
        done +
        '/' +
        tot +
        ' <span style="font-size:12px;opacity:0.95;">(' +
        pct +
        '%)</span></span>';
      html += '</div>';
      if (missStr) {
        html +=
          '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;padding-left:2px;">未実施: ' +
          escapeHtml(missStr) +
          '</div>';
      } else {
        html += '<div style="font-size:11px;color:#4ade80;margin-top:4px;">✓ すべて実施済</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  /** true: 折りたたみ表示。キー未設定時は dashFoldDefaultExpanded / data-default-* に従う */
  function isDashFoldCollapsed(key, folds, titleEl) {
    if (Object.prototype.hasOwnProperty.call(folds, key)) {
      return !!folds[key];
    }
    if (titleEl && titleEl.getAttribute('data-default-collapsed') === '1') {
      return true;
    }
    if (titleEl && titleEl.getAttribute('data-default-expanded') === '1') {
      return false;
    }
    return !dashFoldDefaultExpanded(key);
  }

  function bindDashFolds() {
    var folds = loadDashFolds();
    var titles = dashView.querySelectorAll('.dash-fold-title');
    for (var i = 0; i < titles.length; i++) {
      (function (title) {
        var key = title.getAttribute('data-fold');
        var body = dashView.querySelector('[data-fold-target="' + key + '"]');
        if (!body) return;
        if (isDashFoldCollapsed(key, folds, title)) {
          body.style.display = 'none';
          title.classList.add('folded');
        } else {
          body.style.display = '';
          title.classList.remove('folded');
        }
        title.addEventListener('click', function () {
          var isHidden = body.style.display === 'none';
          body.style.display = isHidden ? '' : 'none';
          title.classList.toggle('folded', !isHidden);
          var map = loadDashFolds();
          if (!isHidden) {
            map[key] = true;
          } else if (dashFoldDefaultExpanded(key)) {
            delete map[key];
          } else {
            map[key] = false;
          }
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

    var html = '<div class="section-title dash-fold-title" id="dash-jump-vomitSummary" data-fold="vomitSummary">🤮 はき戻し（直近7日）</div>';
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

  // ── 健康スコア（拠点・ステータスフィルタに一致する全猫、スコア昇順＝注意順。未算出は末尾） ──

  function renderHealthScoreSection(cats) {
    if (!cats || cats.length === 0) return '';

    var withScore = [];
    var withoutScore = [];
    for (var i = 0; i < cats.length; i++) {
      var ci = cats[i];
      if (ci.health_score !== null && ci.health_score !== undefined) {
        withScore.push(ci);
      } else {
        withoutScore.push(ci);
      }
    }
    withScore.sort(function (a, b) { return a.health_score - b.health_score; });
    withoutScore.sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || ''), 'ja'); });
    var ordered = withScore.concat(withoutScore);

    var html = '<div class="section-title dash-fold-title" id="dash-jump-healthScore" data-fold="healthScore">🏥 健康スコア（注意順）';
    html += ' <small class="dim" style="font-weight:500;">' + ordered.length + '匹</small></div>';
    html += '<div class="dash-fold-body" data-fold-target="healthScore">';
    html += '<div class="card dash-health-score-list">';
    for (var j = 0; j < ordered.length; j++) {
      var c = ordered[j];
      var hasScore = c.health_score !== null && c.health_score !== undefined;
      var s = hasScore ? c.health_score : null;
      var colorHex = !hasScore ? 'var(--text-dim)' : (s >= 80 ? '#4ade80' : s >= 60 ? '#facc15' : s >= 40 ? '#fb923c' : '#f87171');
      var icon = c.species === 'dog' ? '🐶' : '🐱';
      var border = j < ordered.length - 1 ? 'border-bottom:1px solid rgba(255,255,255,0.06);' : '';

      var topComment = hasScore ? extractTopComment(c.score_detail) : null;

      html += '<a href="cat.html?id=' + encodeURIComponent(c.id || '') + '" style="display:block;padding:8px 0;text-decoration:none;color:inherit;' + border + '">';
      html += '<div style="display:flex;align-items:center;gap:10px;">';
      html += '<span style="font-size:22px;font-weight:900;min-width:38px;text-align:center;color:' + colorHex + ';">' + (hasScore ? s : '—') + '</span>';
      html += '<div style="flex:1;min-width:0;">';
      html += '<div style="font-size:13px;font-weight:600;display:flex;align-items:center;gap:6px;">' + icon + ' ' + escapeHtml(c.name);
      if (!hasScore) {
        html += ' <span class="dim" style="font-size:10px;font-weight:500;">スコア未算出</span>';
      }
      if (c.vomit_7d > 0) {
        html += ' <span style="font-size:10px;background:rgba(248,113,113,0.2);color:#f87171;padding:1px 5px;border-radius:10px;font-weight:600;">🤮' + c.vomit_7d + '</span>';
      }
      html += '</div>';
      html += '<div style="background:var(--surface-alt);border-radius:3px;height:4px;margin-top:4px;">';
      if (hasScore) {
        html += '<div style="background:' + colorHex + ';width:' + s + '%;height:100%;border-radius:3px;"></div>';
      }
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
    var dateStr = (window.NyagiJst && NyagiJst.todayYmd) ? NyagiJst.todayYmd() : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    var url = _origin + '/api/ops/tasks?date=' + encodeURIComponent(dateStr) + '&group_by=attribute';
    fetch(url, { headers: apiHeaders(), cache: 'no-store' })
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
    if (window.NyagiJst && typeof NyagiJst.formatMdHm === 'function') return NyagiJst.formatMdHm(iso);
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      return d.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
    } catch (_) {
      return String(iso);
    }
  }

  // ── 左下🐾セクションナビ（1画面で表示中セクションを縦に羅列） ──
  var DASH_NAV_SECTIONS = [
    { jumpId: 'dash-jump-dashCritical', fold: 'dashCritical', label: '🚨 今すぐ対応' },
    { jumpId: 'dash-jump-healthScore', fold: 'healthScore', label: '🏥 健康スコア' },
    { jumpId: 'dash-jump-vomitSummary', fold: 'vomitSummary', label: '🤮 はき戻し' },
    { jumpId: 'dash-jump-dashTasks', fold: 'dashTasks', label: '✅ タスク' },
    { jumpId: 'dash-jump-dashMed', fold: 'dashMed', label: '💊 お薬サマリー' },
    { jumpId: 'dash-jump-careDaily', fold: 'careDaily', label: '🪮 ケア進捗' },
    { jumpId: 'dash-jump-dashUrineToday', fold: 'dashUrineToday', label: '💧 排尿' },
    { jumpId: 'dash-jump-dashActions', fold: 'dashActions', label: '📋 未完了アクション' },
    { jumpId: 'dash-jump-dashAnomaly', fold: 'dashAnomaly', label: '⚠️ 昨夜からの異常' },
    { jumpId: 'dash-jump-dashToday', fold: 'dashToday', label: '📊 今日の記録' },
    { jumpId: 'dash-jump-dashFeeding', fold: 'dashFeeding', label: '🍽 給餌サマリー' },
    { jumpId: 'dash-jump-dashTomorrow', fold: 'dashTomorrow', label: '📅 明日の予定' },
    { jumpId: 'dash-jump-vetSchedule', fold: 'vetSchedule', label: '🏥 病院スケジュール' },
  ];
  var _dashNavFab = null;
  var _dashNavBackdrop = null;
  var _dashNavPalette = null;

  function dashNavInjectStyles() {
    var old = document.getElementById('nyagi-dashboard-nav-css');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var css = [
      '.cat-nav-fab{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom,0px));left:calc(20px + env(safe-area-inset-left,0px));width:52px;height:52px;border-radius:50%;border:none;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;font-size:22px;box-shadow:0 4px 14px rgba(124,58,237,.45);z-index:900;cursor:pointer;transition:transform .15s,opacity .15s,background .2s;display:flex;align-items:center;justify-content:center}',
      '.cat-nav-fab:active{transform:scale(.92)}',
      '.cat-nav-fab.open{background:linear-gradient(135deg,#7c3aed,#5b21b6)}',
      '.cat-nav-backdrop{position:fixed;inset:0;z-index:899;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s}',
      '.cat-nav-backdrop.open{opacity:1;pointer-events:auto}',
      '.cat-nav-palette{position:fixed;bottom:calc(86px + env(safe-area-inset-bottom,0px));left:calc(16px + env(safe-area-inset-left,0px));right:auto;top:auto;width:min(360px,calc(100vw - 28px));max-height:min(72vh,620px);background:var(--surface,#1e1e2e);border:1px solid rgba(255,255,255,.15);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:901;display:flex;flex-direction:column;opacity:0;transform:translateY(16px) scale(.95);pointer-events:none;transition:opacity .2s,transform .2s}',
      '.cat-nav-palette.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}',
      '.cat-nav-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;font-weight:700;font-size:14px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0;gap:8px}',
      '.cat-nav-header-actions{display:flex;align-items:center;gap:6px;flex-shrink:0}',
      '.cd-cat-nav-back{font-size:11px;font-weight:600;padding:6px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:var(--text-main,#e8e8e8);cursor:pointer;white-space:nowrap}',
      '.cd-cat-nav-back:active{opacity:.85}',
      '.cat-nav-close{background:none;border:none;color:var(--text-dim,#888);font-size:22px;cursor:pointer;padding:0 4px;line-height:1}',
      '#dashNavList.dash-nav-list{display:flex!important;flex-direction:column!important;gap:6px!important;flex:1!important;min-height:0!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;padding:10px 12px 12px!important}',
      '#dashNavList.dash-nav-list>.dim{width:100%!important;text-align:center;padding:12px 8px;font-size:12px}',
      '#dashNavList .cat-nav-item{-webkit-appearance:none!important;appearance:none!important;margin:0!important;display:flex!important;align-items:center!important;justify-content:flex-start!important;text-align:left!important;width:100%!important;max-width:100%!important;flex:0 0 auto!important;min-width:0!important;min-height:44px;padding:10px 12px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.06);color:var(--text-main,#e0e0e0);font-size:13px;font-weight:600;line-height:1.3;cursor:pointer;border-radius:10px;word-break:break-word;box-sizing:border-box!important}',
      '#dashNavList .cat-nav-item:active{background:rgba(167,139,250,.22)!important;border-color:rgba(167,139,250,.35)!important}',
      '@keyframes dashNavHL{0%{box-shadow:0 0 0 3px rgba(167,139,250,.6)}100%{box-shadow:0 0 0 0 rgba(167,139,250,0)}}',
      '.dash-nav-highlight{animation:dashNavHL 1.5s ease-out forwards;border-radius:8px}',
    ].join('');
    var s = document.createElement('style');
    s.id = 'nyagi-dashboard-nav-css';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function dashNavHighlight(el) {
    if (!el) return;
    el.classList.remove('dash-nav-highlight');
    try { void el.offsetWidth; } catch (_) {}
    el.classList.add('dash-nav-highlight');
    setTimeout(function () {
      try { el.classList.remove('dash-nav-highlight'); } catch (_) {}
    }, 1800);
  }

  function dashNavScrollToJump(jumpId, foldKey) {
    if (foldKey) expandDashFoldByKey(foldKey);
    setTimeout(function () {
      var el = document.getElementById(jumpId);
      if (!el) return;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      dashNavHighlight(el);
    }, foldKey ? 140 : 70);
  }

  function dashNavClose() {
    if (_dashNavPalette) _dashNavPalette.classList.remove('open');
    if (_dashNavFab) _dashNavFab.classList.remove('open');
    if (_dashNavBackdrop) _dashNavBackdrop.classList.remove('open');
  }

  function dashNavPopulateList() {
    var listEl = document.getElementById('dashNavList');
    if (!listEl) return;
    var h = '';
    for (var i = 0; i < DASH_NAV_SECTIONS.length; i++) {
      var s = DASH_NAV_SECTIONS[i];
      if (!document.getElementById(s.jumpId)) continue;
      h +=
        '<button type="button" class="cat-nav-item" data-dash-jump="' +
        s.jumpId +
        '" data-dash-fold="' +
        s.fold +
        '">' +
        s.label +
        '</button>';
    }
    listEl.innerHTML = h || '<div class="dim" style="color:var(--text-dim);">表示できるセクションがありません</div>';
    listEl.className = 'dash-nav-list';
  }

  function dashNavOpen() {
    dashNavInjectStyles();
    dashNavPopulateList();
    if (_dashNavPalette) _dashNavPalette.classList.add('open');
    if (_dashNavFab) _dashNavFab.classList.add('open');
    if (_dashNavBackdrop) _dashNavBackdrop.classList.add('open');
  }

  function dashNavToggle() {
    if (_dashNavPalette && _dashNavPalette.classList.contains('open')) dashNavClose();
    else dashNavOpen();
  }

  function ensureDashSectionNav() {
    if (!credentials || !dashView) return;
    dashNavInjectStyles();
    if (!_dashNavFab) {
      _dashNavFab = document.createElement('button');
      _dashNavFab.type = 'button';
      _dashNavFab.className = 'cat-nav-fab';
      _dashNavFab.setAttribute('aria-label', 'セクションナビ');
      _dashNavFab.title = 'セクションへジャンプ（🐾）';
      _dashNavFab.textContent = '\uD83D\uDC3E';
      _dashNavFab.addEventListener('click', dashNavToggle);

      _dashNavBackdrop = document.createElement('div');
      _dashNavBackdrop.className = 'cat-nav-backdrop';
      _dashNavBackdrop.addEventListener('click', dashNavClose);

      _dashNavPalette = document.createElement('div');
      _dashNavPalette.className = 'cat-nav-palette';
      _dashNavPalette.innerHTML =
        '<div class="cat-nav-header">' +
        '<span>\uD83D\uDC3E \u30BB\u30AF\u30B7\u30E7\u30F3</span>' +
        '<div class="cat-nav-header-actions">' +
        '<button type="button" class="cd-cat-nav-back dash-nav-cats">\u732B\u4E00\u89A7\u3078</button>' +
        '<button type="button" class="cat-nav-close" aria-label="\u9589\u3058\u308B">&times;</button>' +
        '</div></div>' +
        '<div id="dashNavList"></div>';

      _dashNavPalette.querySelector('.cat-nav-close').addEventListener('click', dashNavClose);
      _dashNavPalette.querySelector('.dash-nav-cats').addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        dashNavClose();
        window.location.href = 'cats.html';
      });
      _dashNavPalette.addEventListener('click', function (ev) {
        var item = ev.target.closest && ev.target.closest('.cat-nav-item');
        if (item) {
          var jid = item.getAttribute('data-dash-jump');
          var fk = item.getAttribute('data-dash-fold');
          if (jid) {
            dashNavClose();
            dashNavScrollToJump(jid, fk);
          }
        }
      });

      document.body.appendChild(_dashNavFab);
      document.body.appendChild(_dashNavBackdrop);
      document.body.appendChild(_dashNavPalette);
    }
    dashNavPopulateList();
  }

})();
