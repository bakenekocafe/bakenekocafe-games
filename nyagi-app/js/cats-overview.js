/**
 * NYAGI 猫一覧 2モードビュー (ES5 互換)
 *
 * モード1「猫ごと」: 1カード=1猫、日次サマリー凝縮
 * モード2「項目ごと」: 1カード=1項目、中に全猫リスト
 */

(function () {
  'use strict';

  function getApiUrl() {
    var o = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
    return o + '/api/ops/cats/overview';
  }
  var MODE_KEY = 'nyagi_cats_mode';

  var LOC_KEY = 'nyagi_dash_location';
  var STATUS_KEY = 'nyagi_dash_status';
  var LOC_LABELS = { cafe: 'BAKENEKO CAFE', nekomata: '猫又療養所', endo: '遠藤宅', azukari: '預かり隊' };

  var loginGate = document.getElementById('loginGate');
  var mainContent = document.getElementById('mainContent');
  var btnPerCat = document.getElementById('btnPerCat');
  var btnPerItem = document.getElementById('btnPerItem');
  var cardArea = document.getElementById('cardArea');
  var locBar = document.getElementById('locBar');

  var credentials = null;
  var catsData = [];
  var currentMode = 'perCat';
  var currentLocationId = null;
  var currentStatusId = null;

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
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
      'Content-Type': 'application/json'
    };
  }

  function init() {
    credentials = loadCredentials();
    if (!credentials) {
      if (loginGate) loginGate.style.display = 'block';
      return;
    }
    if (mainContent) mainContent.style.display = 'block';

    var savedMode = localStorage.getItem(MODE_KEY);
    if (savedMode === 'perItem') currentMode = 'perItem';
    updateToggle();

    if (btnPerCat) btnPerCat.addEventListener('click', function () { switchMode('perCat'); });
    if (btnPerItem) btnPerItem.addEventListener('click', function () { switchMode('perItem'); });

    setTimeout(function () { loadLocations(); }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 100); });
  } else {
    setTimeout(init, 100);
  }

  function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    localStorage.setItem(MODE_KEY, mode);
    updateToggle();
    render();
  }

  function updateToggle() {
    btnPerCat.className = currentMode === 'perCat' ? 'active' : '';
    btnPerItem.className = currentMode === 'perItem' ? 'active' : '';
  }

  function loadLocations() {
    try {
      currentLocationId = localStorage.getItem(LOC_KEY) || 'all';
      currentStatusId = localStorage.getItem(STATUS_KEY) || 'active';
    } catch (_) {}
    renderFilterBars();
    fetchData();
  }

  function renderFilterBars() {
    if (!locBar) return;

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

    var locHtml = '<div class="filter-row"><span class="filter-label">拠点</span>';
    for (var i = 0; i < locs.length; i++) {
      var loc = locs[i];
      var active = (loc.id === currentLocationId) ? ' active' : '';
      locHtml += '<button class="loc-btn' + active + '" data-loc="' + esc(loc.id) + '">' + esc(loc.label) + '</button>';
    }
    locHtml += '</div><div class="filter-row"><span class="filter-label">ステータス</span>';
    for (var j = 0; j < statuses.length; j++) {
      var st = statuses[j];
      var active = (st.id === currentStatusId) ? ' active' : '';
      locHtml += '<button class="loc-btn' + active + '" data-status="' + esc(st.id) + '">' + esc(st.label) + '</button>';
    }
    locHtml += '</div>';
    locBar.innerHTML = locHtml;
    locBar.style.display = '';

    var forEach = Array.prototype.forEach;
    forEach.call(locBar.querySelectorAll('[data-loc]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-loc');
        if (id === currentLocationId) return;
        currentLocationId = id;
        try { localStorage.setItem(LOC_KEY, id); } catch (_) {}
        forEach.call(locBar.querySelectorAll('[data-loc]'), function (b) { b.classList.toggle('active', b.getAttribute('data-loc') === id); });
        fetchData();
      });
    });
    forEach.call(locBar.querySelectorAll('[data-status]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-status');
        if (id === currentStatusId) return;
        currentStatusId = id;
        try { localStorage.setItem(STATUS_KEY, id); } catch (_) {}
        forEach.call(locBar.querySelectorAll('[data-status]'), function (b) { b.classList.toggle('active', b.getAttribute('data-status') === id); });
        fetchData();
      });
    });
  }

  function locationQuery() {
    var q = '?location=' + encodeURIComponent(currentLocationId || 'all');
    if (currentStatusId && currentStatusId !== 'all') q += '&status=' + encodeURIComponent(currentStatusId);
    return q;
  }

  function fetchData(retryCount) {
    retryCount = retryCount || 0;
    cardArea.innerHTML = '<div class="loading">読み込み中...</div>';
    var ctrl = new AbortController();
    var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
    fetch(getApiUrl() + locationQuery(), { headers: apiHeaders(), cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timeoutId);
        return r.json().then(function (data) {
          if (data.error) {
            throw new Error(data.message || data.error || 'APIエラー');
          }
          if (!r.ok) {
            throw new Error(data.message || 'HTTP ' + r.status);
          }
          return data;
        });
      })
      .then(function (data) {
        catsData = data.cats || [];
        render();
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        var isNetworkErr = (err && (err.name === 'AbortError' || (err.message && (err.message.indexOf('Failed to fetch') !== -1 || err.message.indexOf('NetworkError') !== -1 || err.message.indexOf('Load failed') !== -1))));
        if (isNetworkErr && retryCount < 2) {
          cardArea.innerHTML = '<div class="loading">読み込み中...（再試行 ' + (retryCount + 1) + '/2）</div>';
          setTimeout(function () { fetchData(retryCount + 1); }, 1200);
          return;
        }
        var msg = err.name === 'AbortError' ? 'タイムアウトしました' : (err && err.message ? err.message : 'データ取得に失敗しました');
        var hint = (location.port !== '8001' && location.hostname === 'localhost') ? '<br><span style="font-size:11px;color:var(--text-dim);">※ http://localhost:8001/nyagi-app/ で開くと安定します</span>' : (isNetworkErr ? ' run-dev.ps1 で起動してください' : '');
        cardArea.innerHTML = '<div class="empty-msg">' + esc(msg) + hint + '</div>' +
          '<button class="btn btn-primary" style="margin-top:12px;display:block;margin-left:auto;margin-right:auto;" onclick="location.reload()">再試行</button>';
        console.error('cats overview fetch error', err);
      });
  }

  function render() {
    if (catsData.length === 0) {
      cardArea.innerHTML = '<div class="empty-msg">猫データがありません</div>';
      return;
    }
    catsData.sort(function (a, b) {
      var sa = a.health_score !== null && a.health_score !== undefined ? a.health_score : 999;
      var sb = b.health_score !== null && b.health_score !== undefined ? b.health_score : 999;
      return sa - sb;
    });
    if (currentMode === 'perCat') {
      renderPerCat();
    } else {
      renderPerItem();
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  モード1: 猫ごと
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function renderPerCat() {
    var html = '<div class="cat-grid">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      html += '<a href="' + catLink(c.id) + '" class="per-cat-card">';

      // ヘッダー: 名前 + ステータス + スコア
      html += '<div class="pcc-header">';
      html += '<div class="pcc-name">' + alertDot(c.alert_level) + speciesIcon(c.species) + ' ' + esc(c.name);
      if (c.status && c.status !== 'in_care' && c.status !== 'cafe' && c.status !== 'active') {
        html += ' <span class="badge badge-gray" style="font-size:9px;vertical-align:middle;">' + esc(statusLabel(c.status)) + '</span>';
      }
      html += '</div>';
      html += '<div class="pcc-score ' + scoreColorClass(c.score_color) + '">' +
        (c.health_score !== null ? c.health_score : '--') + '</div>';
      html += '</div>';

      // メトリクス 3列
      html += '<div class="pcc-metrics">';

      // 体重
      html += '<div>';
      html += '<div class="pcc-metric-label">体重</div>';
      if (c.weight_latest !== null) {
        html += '<div class="pcc-metric-value">' + c.weight_latest.toFixed(1) + 'kg';
        if (c.weight_previous !== null) {
          var wDiff = c.weight_latest - c.weight_previous;
          html += ' <span class="trend-' + c.weight_trend + '">' +
            (Math.abs(wDiff) >= 0.05 ? Math.abs(wDiff).toFixed(1) : '') + '</span>';
        }
        html += '</div>';
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      // 給餌
      html += '<div>';
      html += '<div class="pcc-metric-label">給餌</div>';
      if (c.meals_per_day) {
        var feedColor = c.fed_count >= c.meals_per_day ? 'score-color-green' :
          c.fed_count > 0 ? 'score-color-yellow' : 'score-color-red';
        var feedIcon = c.fed_count >= c.meals_per_day ? '✅' : '🍽';
        html += '<div class="pcc-metric-value ' + feedColor + '">' + feedIcon + ' ' + (c.fed_count || 0) + '/' + c.meals_per_day + '回</div>';
      } else if (c.feeding_today_pct !== null && c.feeding_today_pct !== undefined) {
        var apColor = c.feeding_today_pct >= 80 ? 'score-color-green' :
          c.feeding_today_pct >= 50 ? 'score-color-yellow' : 'score-color-red';
        html += '<div class="pcc-metric-value ' + apColor + '">' + c.feeding_today_pct + '%</div>';
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      // 排便
      html += '<div>';
      html += '<div class="pcc-metric-label">排便</div>';
      var stoolCount = (c.stool_today || []).length;
      if (stoolCount > 0) {
        var stoolSummary = stoolCount + '回';
        var statuses = [];
        for (var j = 0; j < c.stool_today.length; j++) {
          if (statuses.indexOf(c.stool_today[j].status) === -1) statuses.push(c.stool_today[j].status);
        }
        if (statuses.length > 0) stoolSummary += ' (' + statuses.join('/') + ')';
        html += '<div class="pcc-metric-value">' + esc(stoolSummary) + '</div>';
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      // 排尿
      html += '<div>';
      html += '<div class="pcc-metric-label">排尿</div>';
      var urineArr = c.urine_today || [];
      if (urineArr.length > 0) {
        var urineSummary = urineArr.length + '回';
        var uStatuses = [];
        for (var uj = 0; uj < urineArr.length; uj++) {
          if (uStatuses.indexOf(urineArr[uj].status) === -1) uStatuses.push(urineArr[uj].status);
        }
        if (uStatuses.length > 0) urineSummary += ' (' + uStatuses.join('/') + ')';
        html += '<div class="pcc-metric-value">' + esc(urineSummary) + '</div>';
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      // 投薬
      html += '<div>';
      html += '<div class="pcc-metric-label">投薬</div>';
      var meds = c.meds_today || { done: 0, total: 0, items: [] };
      if (meds.total > 0) {
        var medColor = meds.done >= meds.total ? 'score-color-green' : meds.done > 0 ? 'score-color-yellow' : 'score-color-red';
        var medIcon = meds.done >= meds.total ? '✅' : '⏳';
        html += '<div class="pcc-metric-value ' + medColor + '">' + medIcon + ' ' + meds.done + '/' + meds.total + '</div>';
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      html += '</div>'; // pcc-metrics

      // 健康コメント
      var hComments = c.health_comments || [];
      if (hComments.length > 0) {
        html += '<div class="pcc-health-comments">';
        for (var hci = 0; hci < hComments.length; hci++) {
          var hc = hComments[hci];
          html += '<div class="pcc-hc-item">';
          html += '<span class="pcc-hc-area">' + esc(hc.area) + '</span>';
          html += '<span class="pcc-hc-reason">' + esc(hc.reason) + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }

      // ケア実施状況（1行カード）
      var care = c.care_latest || [];
      if (care.length > 0) {
        html += '<div class="pcc-care">';
        html += '<span class="pcc-care-label">ケア ' + (c.care_date || '').slice(5) + '</span>';
        for (var ci = 0; ci < care.length; ci++) {
          var done = care[ci].done;
          var cls = done ? 'care-done' : 'care-skip';
          html += '<span class="care-chip ' + cls + '">' + esc(care[ci].type);
          if (done && care[ci].by) html += '<small>' + esc(care[ci].by) + '</small>';
          html += '</span>';
        }
        html += '</div>';
      }

      // 異常バッジ
      var anomalies = c.anomalies_7d || [];
      if (anomalies.length > 0) {
        html += '<div class="pcc-anomalies">';
        for (var j = 0; j < anomalies.length; j++) {
          var a = anomalies[j];
          var bc = a.count >= 3 ? 'badge-red' : a.count >= 2 ? 'badge-orange' : 'badge-yellow';
          html += '<span class="badge ' + bc + '">' + esc(a.type) + ' x' + a.count + '</span>';
        }
        html += '</div>';
      }

      html += '</a>';
    }
    html += '</div>';
    cardArea.innerHTML = html;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  モード2: 項目ごと
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  var FOLD_KEY = 'nyagi_items_folded';

  function loadFolded() {
    try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveFolded(map) {
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(map)); } catch (e) {}
  }

  function renderPerItem() {
    var html = '';
    html += renderItemCard_Stool();
    html += renderItemCard_Urine();
    html += renderItemCard_Weight();
    html += renderItemCard_Meds();
    html += renderItemCard_Care();
    html += renderItemCard_Tasks();
    html += renderItemCard_Anomaly();
    html += renderItemCard_Feeding();
    html += renderItemCard_Medical();
    cardArea.innerHTML = html;

    var opened = loadFolded();
    var hasSavedState = opened && typeof opened === 'object' && Object.keys(opened).length > 0;
    var titles = cardArea.querySelectorAll('.item-card-title');
    for (var i = 0; i < titles.length; i++) {
      (function (title, idx) {
        var body = title.nextElementSibling;
        if (!body) return;
        var shouldCollapse = hasSavedState && !opened[idx];
        if (shouldCollapse) {
          title.classList.add('collapsed');
          body.classList.add('hidden');
        }
        title.addEventListener('click', function () {
          var isHidden = body.classList.toggle('hidden');
          title.classList.toggle('collapsed', isHidden);
          var map = loadFolded();
          if (isHidden) { delete map[idx]; } else { map[idx] = true; }
          saveFolded(map);
        });
      })(titles[i], i);
    }

  }

  function itemRow(c, content) {
    return '<a href="' + catLink(c.id) + '" class="item-row" style="display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;-webkit-tap-highlight-color:rgba(255,255,255,0.1);">' + content + '</a>';
  }

  function renderItemCard_Stool() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">💩 排便</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var stool = c.stool_today || [];
      var vals = '';
      if (stool.length === 0) vals = '<span class="dim">未記録</span>';
      else { for (var j = 0; j < stool.length; j++) vals += '<span>' + esc(stool[j].time) + ' ' + esc(stool[j].status) + '</span>'; }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + vals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Urine() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🚽 排尿</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var urine = c.urine_today || [];
      var vals = '';
      if (urine.length === 0) vals = '<span class="dim">未記録</span>';
      else { for (var j = 0; j < urine.length; j++) vals += '<span>' + esc(urine[j].time) + ' ' + esc(urine[j].status) + '</span>'; }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + vals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Weight() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">⚖️ 体重 / 🍽 食欲</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var wStr = c.weight_latest !== null ? (c.weight_latest.toFixed(1) + 'kg' + (c.weight_previous !== null ? ' <span class="trend-' + c.weight_trend + '">' + (Math.abs(c.weight_latest - c.weight_previous) >= 0.05 ? Math.abs(c.weight_latest - c.weight_previous).toFixed(1) : '') + '</span>' : '')) : '<span class="dim">体重--</span>';
      var aStr = c.feeding_today_pct !== null && c.feeding_today_pct !== undefined ? '<span class="' + (c.feeding_today_pct >= 80 ? 'score-color-green' : c.feeding_today_pct >= 50 ? 'score-color-yellow' : 'score-color-red') + '">食欲 ' + c.feeding_today_pct + '%</span>' : '<span class="dim">食欲--</span>';
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + wStr + aStr + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Meds() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">💊 今日の投薬状況</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var meds = c.meds_today || { done: 0, total: 0, items: [] };
      var items = meds.items || [];

      var medVals = '';
      if (meds.total === 0) medVals = '<span class="dim">投薬予定なし</span>';
      else {
        var mc = meds.done >= meds.total ? 'score-color-green' : meds.done > 0 ? 'score-color-yellow' : 'score-color-red';
        var allIcon = meds.done >= meds.total ? '✅' : '⏳';
        medVals = '<span class="' + mc + '" style="font-weight:700;">' + allIcon + ' ' + meds.done + '/' + meds.total + ' 完了</span>';
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          var isDone = it.status === 'done';
          var isSkipped = it.status === 'skipped';
          var itemIcon = isDone ? '✅' : isSkipped ? '⏭️' : '⬜';
          var itemCls = isDone ? 'med-item-done' : isSkipped ? 'med-item-skip' : 'med-item-pending';
          medVals += '<span class="' + itemCls + '" style="font-size:12px;">' + itemIcon + ' ' + (it.slot ? '<b>' + esc(it.slot) + '</b> ' : '') + esc(it.name) + (it.dosage ? ' <small>' + esc(it.dosage) + '</small>' : '') + '</span>';
        }
      }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values" style="flex-direction:column;gap:2px;">' + medVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Care() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🩹 ケア実施</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var care = c.care_latest || [];

      var careVals = '';
      if (care.length === 0) careVals = '<span class="dim">なし</span>';
      else { for (var j = 0; j < care.length; j++) { var cls = care[j].done ? 'care-done' : 'care-skip'; careVals += '<span class="care-chip ' + cls + '" style="font-size:11px;">' + esc(care[j].type) + (care[j].done && care[j].by ? '<small>' + esc(care[j].by) + '</small>' : '') + '</span>'; } }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values" style="flex-wrap:wrap;gap:3px 6px;">' + careVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Tasks() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">✅ タスク</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var tasks = c.tasks_today || { done: 0, total: 0 };

      var taskVals = tasks.total === 0 ? '<span class="dim">なし</span>' : '<span class="' + (tasks.done >= tasks.total ? 'score-color-green' : tasks.done > 0 ? 'score-color-yellow' : 'score-color-red') + '">' + (tasks.done >= tasks.total ? '✅' : '⏳') + ' ' + tasks.done + '/' + tasks.total + '</span>';
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + taskVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Anomaly() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">⚠️ 健康異常</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var anomalies = c.anomalies_7d || [];

      var anomVals = '<span class="' + scoreColorClass(c.score_color) + '" style="font-weight:700;">' + (c.health_score !== null ? c.health_score : '--') + '</span>';
      if (anomalies.length === 0) anomVals += '<span class="score-color-green" style="font-size:11px;">異常なし</span>';
      else { for (var j = 0; j < anomalies.length; j++) { var a = anomalies[j]; anomVals += '<span class="badge ' + (a.count >= 3 ? 'badge-red' : a.count >= 2 ? 'badge-orange' : 'badge-yellow') + '">' + esc(a.type) + ' x' + a.count + '</span>'; } }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + anomVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function feedingSlotLabel(slot) {
    var m = { morning: '☀️朝', afternoon: '昼', evening: '🌙夕', night: '🌙夕' };
    return m[slot] || slot || '';
  }

  function renderItemCard_Feeding() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🍚 ごはん献立</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var plan = c.feeding_plan || [];

      var planVals = '';
      if (plan.length === 0) planVals = '<span class="dim">献立未設定</span>';
      else {
        for (var j = 0; j < plan.length; j++) {
          var pj = plan[j];
          planVals += '<div style="font-size:12px;">' + esc(feedingSlotLabel(pj.meal_slot)) + ': ' + esc(pj.food_name) + ' ' + pj.amount_g + 'g';
          if (pj.notes && String(pj.notes).trim()) {
            planVals += '<div style="font-size:10px;color:var(--text-dim);margin-top:2px;padding-left:6px;line-height:1.35;">📝 ' + esc(String(pj.notes).trim()) + '</div>';
          }
          planVals += '</div>';
        }
      }
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values" style="flex-direction:column;gap:4px;">' + planVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Medical() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🏥 医療（中長期）</div>';
    html += '<div class="item-card-body">';
    var today = new Date().toISOString().slice(0, 10);
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];

      var medLongVals = '';
      if (c.vaccine_next_due) medLongVals += '<span class="badge ' + (c.vaccine_next_due <= today ? 'badge-red' : daysUntil(c.vaccine_next_due) <= 30 ? 'badge-orange' : 'badge-gray') + '">ワクチン ' + shortDate(c.vaccine_next_due) + '</span>';
      if (c.checkup_next_due) medLongVals += '<span class="badge ' + (c.checkup_next_due <= today ? 'badge-red' : daysUntil(c.checkup_next_due) <= 30 ? 'badge-orange' : 'badge-gray') + '">健診 ' + shortDate(c.checkup_next_due) + '</span>';
      medLongVals += '<span class="badge ' + (c.microchip === 'registered' ? 'badge-green' : 'badge-gray') + '">' + (c.microchip === 'registered' ? 'MC済' : 'MC未') + '</span>';
      if (!c.vaccine_next_due && !c.checkup_next_due) medLongVals += '<span class="dim" style="font-size:11px;">予定なし</span>';
      html += itemRow(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + medLongVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ユーティリティ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function catLink(catId) {
    return 'cat.html?id=' + encodeURIComponent(catId || '');
  }

  function statusLabel(status) {
    var labels = { active: '在籍', in_care: '在籍', cafe: '在籍', adopted: '卒業', trial: 'トライアル中', transferred: '移動', deceased: '他界' };
    return labels[status] || status;
  }

  function speciesIcon(species) {
    return species === 'dog' ? '🐶' : '🐱';
  }

  function alertDot(level) {
    return '<span class="alert-dot ' + (level || 'normal') + '"></span>';
  }

  function scoreColorClass(color) {
    return 'score-color-' + (color || 'gray');
  }

  function esc(str) {
    if (!str) return '';
    var d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function shortDate(dateStr) {
    if (!dateStr) return '';
    var parts = dateStr.split('-');
    if (parts.length < 3) return dateStr;
    return parseInt(parts[1], 10) + '/' + parseInt(parts[2], 10);
  }

  function daysUntil(dateStr) {
    var target = new Date(dateStr + 'T00:00:00');
    var now = new Date();
    now.setHours(0, 0, 0, 0);
    return Math.ceil((target - now) / (24 * 60 * 60 * 1000));
  }
})();
