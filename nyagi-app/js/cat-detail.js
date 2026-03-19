/**
 * NYAGI 猫詳細画面 JS (ES5 互換)
 *
 * cat.html?id=cat_kohada で猫の詳細を表示
 * P4 拡張: 体重グラフ / 健康記録 CRUD / 投薬スケジュール + 投薬ログ UI
 * P5 拡張: 健康スコアカード / 給餌プラン + 給餌ログセクション
 * P5.7 拡張: 猫注意事項セクション（cat_notes CRUD）
 */

function toggleFold(id, btn) {
  var el = document.getElementById(id);
  if (!el) return;
  if (el.style.display === 'none') {
    el.style.display = '';
    btn.textContent = '▲ 閉じる';
  } else {
    el.style.display = 'none';
    btn.textContent = '▼ 過去分を表示';
  }
}

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops';

  var loginGate            = document.getElementById('loginGate');
  var catContent           = document.getElementById('catContent');
  var catHeaderArea        = document.getElementById('catHeaderArea');
  var alertBannerArea      = document.getElementById('alertBannerArea');
  var basicInfoArea        = document.getElementById('basicInfoArea');
  var weightChartArea      = document.getElementById('weightChartArea');
  var calorieArea          = document.getElementById('calorieArea');
  var healthRecordsArea    = document.getElementById('healthRecordsArea');
  var medicationScheduleArea = document.getElementById('medicationScheduleArea');
  var feedingArea          = document.getElementById('feedingArea');
  var careArea             = document.getElementById('careArea');
  var stoolArea            = document.getElementById('stoolArea');
  var urineArea            = document.getElementById('urineArea');
  var medRecordArea        = document.getElementById('medRecordArea');
  var feedingMemoArea      = document.getElementById('feedingMemoArea');
  var catNotesArea         = document.getElementById('catNotesArea');
  var scoreCardArea        = document.getElementById('scoreCardArea');
  var actionsArea          = document.getElementById('actionsArea');
  var reportLink           = document.getElementById('reportLink');

  var credentials = null;
  var catId = null;
  var currentCatData = null;

  var LOCATION_LABELS = {
    cafe: 'BAKENEKO CAFE',
    nekomata: '猫又療養所',
    endo: '遠藤宅',
    azukari: '預かり隊'
  };
  var STATUS_LABELS = {
    active: '在籍',
    adopted: '卒業',
    trial: 'トライアル中',
    in_care: '在籍',
    cafe: '在籍',
    deceased: '他界'
  };

  // ── 認証 ──────────────────────────────────────────────────────────────────────

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

  function getQueryParam(name) {
    var params = window.location.search.slice(1).split('&');
    for (var i = 0; i < params.length; i++) {
      var pair = params[i].split('=');
      if (decodeURIComponent(pair[0]) === name) {
        return decodeURIComponent(pair[1] || '');
      }
    }
    return null;
  }

  // ── 初期化 ────────────────────────────────────────────────────────────────────

  function init() {
    credentials = loadCredentials();
    catId = getQueryParam('id');

    if (!credentials) {
      if (loginGate) loginGate.style.display = 'block';
      return;
    }
    if (!catId) {
      window.location.href = 'cats.html';
      return;
    }
    if (catContent) catContent.style.display = 'block';
    setTimeout(function () { loadCatDetail(); }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function loadCatDetail() {
    if (!catHeaderArea) return;
    catHeaderArea.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';
    if (basicInfoArea) basicInfoArea.innerHTML = '';
    if (weightChartArea) weightChartArea.innerHTML = '';
    if (scoreCardArea) scoreCardArea.innerHTML = '';
    if (actionsArea) actionsArea.innerHTML = '';

    function doFetch(retryCount) {
      retryCount = retryCount || 0;
      var url = API_BASE + '/cats/' + encodeURIComponent(catId) + '/timeline?limit=50';
      var ctrl = new AbortController();
      var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
      fetch(url, { headers: apiHeaders(), signal: ctrl.signal })
        .then(function (res) {
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (data.error) {
            catHeaderArea.innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(data.message || data.error) + '</div>';
            return;
          }
          renderCatDetail(data);
          loadScoreCard();
          loadWeightChart();
          loadCareSection();
          loadStoolSection();
          loadUrineSection();
          loadMedRecordSection();
          loadHealthRecords();
          loadClinicRecords();
          loadMedicationSchedule();
          loadFeedingSection();
          loadFeedingMemo();
          loadCatNotes();
          loadCatTasks();
        })
        .catch(function (err) {
          clearTimeout(timeoutId);
          if (retryCount < 2) {
            setTimeout(function () { doFetch(retryCount + 1); }, 1200);
            return;
          }
          var msg = err.name === 'AbortError' ? 'タイムアウトしました' : '読み込みに失敗しました';
          var hint = (location.port !== '8001' && location.hostname === 'localhost') ? '<br><span style="font-size:11px;color:var(--text-dim);">※ http://localhost:8001/nyagi-app/ で開くと安定します</span>' : '';
          catHeaderArea.innerHTML = '<div class="empty-msg" style="padding:16px;">' + msg + hint + '<br><button class="btn btn-outline" style="margin-top:12px;" onclick="loadCatDetail()">再読み込み</button></div>';
        });
    }
    doFetch(0);
  }
  window.loadCatDetail = loadCatDetail;

  // ── メインレンダリング ─────────────────────────────────────────────────────────

  function renderCatDetail(data) {
    var cat = data.cat || {};
    currentCatData = cat;

    // ヘッダー
    var level = cat.alert_level || 'normal';
    var html = '<div class="cat-header">';
    if (cat.photo_url) {
      html += '<img src="' + escapeHtml(cat.photo_url) + '" alt="' + escapeHtml(cat.name) + '" style="width:80px;height:80px;border-radius:50%;object-fit:cover;">';
    } else {
      html += '<div class="cat-header-emoji">🐱</div>';
    }
    html += '<div class="cat-header-name">' + escapeHtml(cat.name || catId) +
      ' <button type="button" class="btn-edit-loc" onclick="openRenameModal()" style="font-size:13px;">✏️</button></div>';
    html += '<span class="cat-header-status ' + level + '">' + escapeHtml(level.toUpperCase()) + '</span>';
    var locLabel = LOCATION_LABELS[cat.location_id] || cat.location_id || '—';
    var statusLabel = STATUS_LABELS[cat.status] || cat.status || '—';
    html += '<div class="cat-header-location">';
    html += '<span>' + escapeHtml(locLabel) + ' / ' + escapeHtml(statusLabel) + '</span>';
    html += '<button type="button" class="btn-edit-loc" onclick="openLocationStatusModal()">編集</button>';
    html += '</div>';
    html += '</div>';
    catHeaderArea.innerHTML = html;

    // 警戒レベルバナー
    if (level === 'watch' || level === 'critical') {
      var bannerClass = level === 'watch' ? 'alert-banner watch' : 'alert-banner';
      var bannerHtml = '<div class="' + bannerClass + '">';
      bannerHtml += '<div class="alert-banner-title">⚠️ ' + escapeHtml(level.toUpperCase()) + '</div>';
      bannerHtml += '<div class="alert-banner-reason">' + escapeHtml(cat.alert_reason || '') + '</div>';
      if (cat.alert_until) {
        bannerHtml += '<div class="alert-banner-until">期限: ' + escapeHtml(cat.alert_until) + '</div>';
      }
      bannerHtml += '</div>';
      alertBannerArea.innerHTML = bannerHtml;
    } else {
      alertBannerArea.innerHTML = '';
    }

    // 基本情報
    var infoHtml = '<div class="detail-section">';
    infoHtml += '<div class="detail-title">📋 基本情報</div>';
    infoHtml += '<div class="info-grid">';
    infoHtml += renderInfoCell('性別', cat.sex || '—');
    infoHtml += renderInfoCell('誕生日', cat.birth_date || '—');
    infoHtml += renderInfoCell('マイクロチップ', cat.microchip_id || '—');
    infoHtml += renderInfoCell('避妊/去勢', cat.neutered ? '済' : '—');
    var bcsVal = cat.body_condition_score;
    var bcsLabel = bcsVal != null ? (bcsVal === 5 ? '5（理想）' : bcsVal < 5 ? bcsVal + '（痩せ）' : bcsVal + '（肥満）') : '未設定';
    infoHtml += '<div class="info-cell" id="bcsInfoCell"><div class="info-label">体型（BCS 1-9）</div><div class="info-value">' + escapeHtml(bcsLabel) + ' <a href="#calorieArea" style="font-size:11px;color:var(--accent);">編集</a></div></div>';
    if (cat.description) {
      infoHtml += '<div class="info-cell full"><div class="info-label">説明</div><div class="info-value" style="font-size:13px;">' + escapeHtml(cat.description) + '</div></div>';
    }
    infoHtml += '</div></div>';
    basicInfoArea.innerHTML = infoHtml;

    // 未完了アクション
    var actions = data.open_actions || [];
    var actHtml = '<div class="detail-section">';
    actHtml += '<div class="detail-title">📋 未完了アクション</div>';
    if (actions.length === 0) {
      actHtml += '<div class="empty-msg">なし</div>';
    } else {
      for (var i = 0; i < actions.length; i++) {
        var a = actions[i];
        actHtml += '<div class="action-card">';
        actHtml += '<div class="action-card-title">' + escapeHtml(a.title || '') + '</div>';
        actHtml += '<div class="action-card-meta">';
        if (a.due_date) actHtml += '期限: ' + escapeHtml(formatDate(a.due_date)) + ' ';
        if (a.priority) actHtml += '優先度: ' + escapeHtml(a.priority);
        actHtml += '</div>';
        actHtml += '</div>';
      }
    }
    actHtml += '</div>';
    actionsArea.innerHTML = actHtml;

    reportLink.href = 'index.html';
  }

  // ── 健康スコアカード（P5）────────────────────────────────────────────────────

  function loadScoreCard() {
    if (!scoreCardArea) return;
    scoreCardArea.innerHTML = '';

    fetch(API_BASE + '/health-scores?cat_id=' + encodeURIComponent(catId) + '&live=true', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderScoreCard(data.scores || []);
    }).catch(function () {
      scoreCardArea.innerHTML = '';
    });
  }

  function renderScoreCard(scores) {
    if (!scores || scores.length === 0) {
      scoreCardArea.innerHTML = '';
      return;
    }

    var s = scores[0];
    var prev = scores[1] || null;
    var total = s.total_score;
    var color = scoreColor(total);
    var colorHex = scoreColorHex(total);
    var prevTotal = s.prev_total !== undefined && s.prev_total !== null ? s.prev_total : (prev ? prev.total_score : null);
    var diff = prevTotal !== null ? (total - prevTotal) : null;
    var diffStr = diff !== null ? (diff >= 0 ? '▲' + diff : '▼' + Math.abs(diff)) : '—';
    var diffColor = diff === null ? 'var(--text-dim)' : diff >= 0 ? '#4ade80' : '#f87171';

    var html = '<div style="background:var(--surface);border-radius:12px;padding:14px 16px;margin-bottom:16px;border-left:4px solid ' + colorHex + ';">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">';
    html += '<div style="font-size:13px;font-weight:700;">🏥 健康スコア</div>';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<span style="font-size:24px;font-weight:900;color:' + colorHex + ';">' + total + '</span>';
    html += '<span style="font-size:12px;color:' + diffColor + ';">前日比 ' + diffStr + '</span>';
    html += '</div></div>';

    var barPct = total;
    html += '<div style="background:var(--surface-alt);border-radius:4px;height:6px;margin-bottom:10px;">';
    html += '<div style="background:' + colorHex + ';width:' + barPct + '%;height:100%;border-radius:4px;"></div>';
    html += '</div>';

    html += '<div style="display:flex;gap:12px;font-size:11px;color:var(--text-dim);flex-wrap:wrap;">';
    if (s.weight_score !== null) html += '<span>体重: <b style="color:' + scoreColorHex(s.weight_score) + ';">' + s.weight_score + '</b></span>';
    if (s.appetite_score !== null) html += '<span>食欲: <b style="color:' + scoreColorHex(s.appetite_score) + ';">' + s.appetite_score + '</b></span>';
    if (s.medication_score !== null) html += '<span>投薬: <b style="color:' + scoreColorHex(s.medication_score) + ';">' + s.medication_score + '</b></span>';
    if (s.vet_score !== null) html += '<span>検査: <b style="color:' + scoreColorHex(s.vet_score) + ';">' + s.vet_score + '</b></span>';
    if (s.behavior_score !== null) html += '<span>行動: <b style="color:' + scoreColorHex(s.behavior_score) + ';">' + s.behavior_score + '</b></span>';
    html += '</div>';

    var detail = null;
    try { detail = JSON.parse(s.detail || '{}'); } catch (_) {}
    var comments = (detail && detail.comments) ? detail.comments : [];
    var actionComments = [];
    for (var ci = 0; ci < comments.length; ci++) {
      if (comments[ci] && comments[ci].advice) actionComments.push(comments[ci]);
    }
    if (actionComments.length > 0) {
      html += '<div style="margin-top:10px;border-top:1px solid var(--border);padding-top:8px;">';
      for (var ci = 0; ci < actionComments.length; ci++) {
        var c = actionComments[ci];
        var cColor = scoreColorHex(getSubScore(s, c.area));
        html += '<div style="font-size:11px;margin-bottom:4px;">';
        html += '<span style="color:' + cColor + ';font-weight:700;">' + escapeHtml(c.area) + '</span> ';
        html += '<span style="color:var(--text-dim);">' + escapeHtml(c.reason) + '</span>';
        if (c.advice) html += '<br><span style="color:var(--text-main);font-size:11px;">→ ' + escapeHtml(c.advice) + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';

    scoreCardArea.innerHTML = html;
  }

  function getSubScore(s, area) {
    if (area === '体重') return s.weight_score;
    if (area === '食欲') return s.appetite_score;
    if (area === '投薬') return s.medication_score;
    if (area === '検査') return s.vet_score;
    if (area === '行動') return s.behavior_score;
    return null;
  }

  function scoreColor(score) {
    if (score === null || score === undefined) return 'gray';
    if (score >= 80) return 'green';
    if (score >= 60) return 'yellow';
    if (score >= 40) return 'orange';
    return 'red';
  }

  function scoreColorHex(score) {
    if (score === null || score === undefined) return '#888';
    if (score >= 80) return '#4ade80';
    if (score >= 60) return '#facc15';
    if (score >= 40) return '#fb923c';
    return '#f87171';
  }

  // ── 体重グラフ ────────────────────────────────────────────────────────────────

  function loadWeightChart() {
    weightChartArea.innerHTML = '<div class="detail-section"><div class="detail-title">⚖️ 体重推移</div><div class="loading" style="padding:20px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/weight-history?cat_id=' + encodeURIComponent(catId) + '&months=6', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderWeightChart(data.weights || []);
    }).catch(function () {
      weightChartArea.innerHTML = '';
    });
  }

  function renderWeightChart(weights) {
    var html = '<div class="detail-section">';
    html += '<div class="detail-title">⚖️ 体重推移（直近6ヶ月）</div>';

    if (weights.length === 0) {
      html += '<div class="empty-msg">体重記録なし</div></div>';
      weightChartArea.innerHTML = html;
      return;
    }

    html += '<div class="weight-canvas-wrap"><canvas id="weightCanvas" height="160"></canvas></div>';
    html += '</div>';
    weightChartArea.innerHTML = html;

    var canvas = document.getElementById('weightCanvas');
    if (!canvas) return;

    // canvas の表示サイズに合わせてピクセルを設定
    var dpr = window.devicePixelRatio || 1;
    var displayW = canvas.offsetWidth || 300;
    var displayH = 160;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var W = displayW;
    var H = displayH;
    var pad = { top: 16, right: 16, bottom: 32, left: 40 };
    var cW = W - pad.left - pad.right;
    var cH = H - pad.top - pad.bottom;

    var vals = weights.map(function (w) { return w.value; });
    var minV = Math.min.apply(null, vals);
    var maxV = Math.max.apply(null, vals);
    var rangeV = maxV - minV || 0.5;

    // 背景
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, W, H);

    // グリッド（水平）
    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1;
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.top + (cH / 4) * gi;
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + cW, gy);
      ctx.stroke();

      // Y軸ラベル
      var yVal = maxV - (rangeV / 4) * gi;
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(yVal.toFixed(1), pad.left - 4, gy + 4);
    }

    // 折れ線（塗りつぶしエリア）
    ctx.beginPath();
    for (var i = 0; i < weights.length; i++) {
      var x = pad.left + (cW / Math.max(weights.length - 1, 1)) * i;
      var y = pad.top + cH - (cH * (weights[i].value - minV) / rangeV);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    // エリア塗り
    var lastX = pad.left + cW;
    ctx.lineTo(lastX, pad.top + cH);
    ctx.lineTo(pad.left, pad.top + cH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(99,102,241,.15)';
    ctx.fill();

    // 折れ線
    ctx.beginPath();
    for (var i = 0; i < weights.length; i++) {
      var x = pad.left + (cW / Math.max(weights.length - 1, 1)) * i;
      var y = pad.top + cH - (cH * (weights[i].value - minV) / rangeV);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#818cf8';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // ドット + X軸ラベル
    for (var i = 0; i < weights.length; i++) {
      var x = pad.left + (cW / Math.max(weights.length - 1, 1)) * i;
      var y = pad.top + cH - (cH * (weights[i].value - minV) / rangeV);

      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#818cf8';
      ctx.fill();

      // X軸日付（3個おきに表示）
      if (i % Math.max(1, Math.floor(weights.length / 5)) === 0 || i === weights.length - 1) {
        ctx.fillStyle = '#888';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        var dateLabel = (weights[i].date || '').slice(5);
        ctx.fillText(dateLabel, x, pad.top + cH + 14);
      }
    }
  }

  // ── ケア実施セクション ─────────────────────────────────────────────────────────

  function parseCareDetails(d) {
    if (!d) return '';
    if (typeof d === 'string' && d.charAt(0) === '"') {
      try { return JSON.parse(d); } catch (e) { return d; }
    }
    return d;
  }

  function loadCareSection() {
    if (!careArea) return;
    careArea.innerHTML = '<div class="detail-section"><div class="detail-title">🪮 ケア実施状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var catParam = encodeURIComponent(catId);
    Promise.all([
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=care&limit=60', { headers: apiHeaders() }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=eye_discharge&limit=60', { headers: apiHeaders() }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var careRecs = results[0].records || [];
      var eyeRecs = results[1].records || [];
      for (var i = 0; i < eyeRecs.length; i++) {
        eyeRecs[i].details = '目ヤニ拭き';
        careRecs.push(eyeRecs[i]);
      }
      careRecs.sort(function (a, b) {
        return (b.record_date || '').localeCompare(a.record_date || '');
      });
      renderCareSection(careRecs);
    }).catch(function () {
      careArea.innerHTML = '';
    });
  }

  function renderCareSection(records) {
    var addBtn = '<button class="btn btn-outline btn-sm" style="margin-left:8px;font-size:12px;" onclick="openCareModal()">＋ ケア記録</button>';
    if (records.length === 0) {
      careArea.innerHTML = '<div class="detail-section"><div class="detail-title">🪮 ケア実施状況' + addBtn + '</div><div class="empty-msg">記録なし</div></div>';
      return;
    }
    var byDate = {};
    var dateOrder = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var d = r.record_date || '';
      if (!byDate[d]) { byDate[d] = []; dateOrder.push(d); }
      byDate[d].push(r);
    }

    var today = new Date().toISOString().slice(0, 10);
    var visibleCount = 0;
    for (var k = 0; k < dateOrder.length; k++) {
      if (dateOrder[k] === today) { visibleCount = 1; break; }
    }

    var foldId = 'careFold';
    var html = '<div class="detail-section">';
    html += '<div class="detail-title">🪮 ケア実施状況' + addBtn + '</div>';

    for (var di = 0; di < dateOrder.length && di < 7; di++) {
      var date = dateOrder[di];
      var items = byDate[date];
      var hidden = (visibleCount > 0 && di >= visibleCount) || (visibleCount === 0 && di >= 1);
      if (hidden && di === Math.max(visibleCount, 1)) {
        html += '<div id="' + foldId + '" class="fold-area" style="display:none;">';
      }
      html += '<div class="care-date-group">';
      html += '<div class="care-date-label">' + escapeHtml(date.slice(5)) + '</div>';
      html += '<div class="care-row">';
      for (var ci = 0; ci < items.length; ci++) {
        var done = items[ci].value !== '×' && items[ci].value !== 'ー';
        var cls = done ? 'care-done' : 'care-skip';
        var detailLabel = parseCareDetails(items[ci].details);
        html += '<span class="care-chip ' + cls + '">' + escapeHtml(detailLabel);
        if (done && items[ci].value) html += '<small>' + escapeHtml(items[ci].value) + '</small>';
        html += '</span>';
      }
      html += '</div></div>';
    }
    if (dateOrder.length > Math.max(visibleCount, 1)) {
      html += '</div>';
      html += '<button class="fold-toggle" onclick="toggleFold(\'' + foldId + '\',this)">▼ 過去分を表示</button>';
    }
    html += '</div>';
    careArea.innerHTML = html;
  }

  // ── 排便状況セクション ─────────────────────────────────────────────────────────

  function loadStoolSection() {
    if (!stoolArea) return;
    stoolArea.innerHTML = '<div class="detail-section"><div class="detail-title">🚽 排便状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=stool&limit=30', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderStoolSection(data.records || []);
    }).catch(function () {
      stoolArea.innerHTML = '';
    });
  }

  function renderStoolSection(records) {
    var days = buildRecentDays(14);
    var byDate = groupByDate(records);
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">🚽 排便状況</div>';
    html += '<button class="btn-add" onclick="openStoolModal()">＋ 記録</button>';
    html += '</div>';
    html += '<div class="stool-list">';
    html += renderDailyRows(days, byDate, function (r) {
      var status = STOOL_EN_TO_JA[r.value] || r.value || '—';
      var isNormal = status === '健康' || status === '普通';
      var isBaseline = status === '血便小';
      return '<span class="stool-chip ' + (isNormal ? 'stool-normal' : isBaseline ? 'stool-baseline' : 'stool-warn') + '">'
        + escapeHtml(status) + '</span>';
    }, 3, 'stoolFold');
    html += '</div></div>';
    stoolArea.innerHTML = html;
  }

  // ── 排尿状況セクション ─────────────────────────────────────────────────────────

  function loadUrineSection() {
    if (!urineArea) return;
    urineArea.innerHTML = '<div class="detail-section"><div class="detail-title">💧 排尿状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=urine&limit=30', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderUrineSection(data.records || []);
    }).catch(function () {
      urineArea.innerHTML = '';
    });
  }

  var URINE_EN_TO_JA = { normal: '普通', hard: '多い', soft: '少量', liquid: 'なし（異常）', recorded: '記録あり' };
  var STOOL_EN_TO_JA = { normal: '健康', hard: '硬い', soft: '軟便', liquid: '下痢', recorded: '記録あり' };

  function renderUrineSection(records) {
    var days = buildRecentDays(14);
    var byDate = groupByDate(records);
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">💧 排尿状況</div>';
    html += '<button class="btn-add" onclick="openUrineModal()">＋ 記録</button>';
    html += '</div>';
    html += '<div class="stool-list">';
    html += renderDailyRows(days, byDate, function (r) {
      var status = URINE_EN_TO_JA[r.value] || r.value || '—';
      var isNormal = status === 'なし' || status === '少量' || status === '普通' || status === '多い' || status === '正常' || status === 'あり' || status === '健康';
      var isBaseline = status === '血尿小';
      return '<span class="stool-chip ' + (isNormal ? 'stool-normal' : isBaseline ? 'stool-baseline' : 'stool-warn') + '">'
        + escapeHtml(status) + '</span>';
    }, 3, 'urineFold');
    html += '</div></div>';
    urineArea.innerHTML = html;
  }

  // ── お薬状況セクション ─────────────────────────────────────────────────────────

  function loadMedRecordSection() {
    if (!medRecordArea) return;
    medRecordArea.innerHTML = '<div class="detail-section"><div class="detail-title">💊 お薬状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=medication&limit=60', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderMedRecordSection(data.records || []);
    }).catch(function () {
      medRecordArea.innerHTML = '';
    });
  }

  function renderMedRecordSection(records) {
    var days = buildRecentDays(14);
    var byDate = groupByDate(records);
    var html = '<div class="detail-section">';
    html += '<div class="detail-title">💊 お薬状況</div>';
    html += '<div class="stool-list">';
    html += renderDailyRows(days, byDate, function (r) {
      var name = r.value || '—';
      return '<span class="stool-chip med-chip">' + escapeHtml(name) + '</span>';
    }, 4, 'medFold');
    html += '</div></div>';
    medRecordArea.innerHTML = html;
  }

  // ── 共通ヘルパー: 2週間日付リスト / 日別グルーピング / 行レンダリング ──

  function buildRecentDays(n) {
    var result = [];
    var d = new Date();
    for (var i = 0; i < n; i++) {
      var y = d.getFullYear();
      var m = ('0' + (d.getMonth() + 1)).slice(-2);
      var dd = ('0' + d.getDate()).slice(-2);
      result.push(y + '-' + m + '-' + dd);
      d.setDate(d.getDate() - 1);
    }
    return result;
  }

  function groupByDate(records) {
    var map = {};
    for (var i = 0; i < records.length; i++) {
      var d = records[i].record_date || '';
      if (!map[d]) map[d] = [];
      map[d].push(records[i]);
    }
    return map;
  }

  function renderDailyRows(days, byDate, chipFn, visibleDays, foldId) {
    var html = '';
    var folded = false;
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var dayLabel = day.slice(5);
      var entries = byDate[day];

      if (visibleDays && foldId && di === visibleDays && !folded) {
        html += '<div id="' + foldId + '" class="fold-area" style="display:none;">';
        folded = true;
      }

      if (!entries) {
        html += '<div class="stool-row stool-none">';
        html += '<span class="stool-date">' + escapeHtml(dayLabel) + '</span>';
        html += '<span class="stool-chip stool-empty">なし</span>';
        html += '</div>';
        continue;
      }

      for (var ei = 0; ei < entries.length; ei++) {
        var r = entries[ei];
        var timeSlot = r.details || '';
        var recBy = r.recorded_by || '';
        if (recBy === 'staff_import') recBy = 'インポート';
        var recTime = r.recorded_time && r.recorded_time !== 'null' ? r.recorded_time : '';
        var createdTime = (r.created_at || '').slice(11, 16);

        html += '<div class="stool-row">';
        html += '<span class="stool-date">' + escapeHtml(ei === 0 ? dayLabel : '') + '</span>';
        html += chipFn(r);
        if (timeSlot) html += '<span class="stool-time-slot">' + escapeHtml(timeSlot) + '</span>';
        html += '<span class="stool-meta">';
        if (recBy) html += escapeHtml(recBy);
        if (recTime) html += ' ' + escapeHtml(recTime);
        else if (createdTime) html += ' ' + escapeHtml(createdTime);
        html += '</span>';
        html += '</div>';
      }
    }
    if (folded) {
      html += '</div>';
      html += '<button class="fold-toggle" onclick="toggleFold(\'' + foldId + '\',this)">▼ 過去分を表示</button>';
    }
    return html;
  }

  // ── 体重記録セクション ─────────────────────────────────────────────────────────

  function loadHealthRecords() {
    healthRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">⚖️ 体重記録</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&limit=30', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      var recs = data.records || [];
      var weightRecs = [];
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].record_type === 'weight') weightRecs.push(recs[i]);
      }
      renderWeightRecords(weightRecs);
    }).catch(function () {
      healthRecordsArea.innerHTML = '';
    });
  }

  function renderWeightRecords(records) {
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">⚖️ 体重記録</div>';
    html += '<button class="btn-add" onclick="openHealthRecordModal()">+ 記録</button>';
    html += '</div>';

    if (records.length === 0) {
      html += '<div class="empty-msg">記録なし</div>';
    } else {
      for (var i = 0; i < Math.min(records.length, 10); i++) {
        var r = records[i];
        var timeStr = r.recorded_time ? ' ' + r.recorded_time.slice(0, 5) : '';
        html += '<div class="health-record-item" style="display:flex;justify-content:space-between;align-items:center;">';
        html += '<span style="font-size:12px;color:var(--text-dim);">' + escapeHtml(formatDateShort(r.record_date)) + timeStr + '</span>';
        html += '<span style="font-size:16px;font-weight:700;">' + escapeHtml(r.value || '') + ' kg</span>';
        html += '</div>';
      }
    }
    html += '</div>';
    healthRecordsArea.innerHTML = html;
  }

  // ── 病院記録セクション ─────────────────────────────────────────────────────────

  var clinicRecordsArea = document.getElementById('clinicRecordsArea');

  function loadClinicRecords() {
    if (!clinicRecordsArea) return;
    clinicRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">🏥 病院記録</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&limit=50', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      var recs = data.records || [];
      var clinicTypes = { vaccine: 1, checkup: 1, surgery: 1, dental: 1, emergency: 1, test: 1, observation: 1 };
      var filtered = [];
      for (var i = 0; i < recs.length; i++) {
        if (clinicTypes[recs[i].record_type]) filtered.push(recs[i]);
      }
      renderClinicRecords(filtered);
    }).catch(function () {
      clinicRecordsArea.innerHTML = '';
    });
  }

  function renderClinicRecords(records) {
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">🏥 病院記録</div>';
    html += '<div style="display:flex;gap:6px;">';
    html += '<button class="btn-add" onclick="openVetScheduleModal()" style="background:rgba(99,102,241,0.15);color:#a78bfa;">📅 予定</button>';
    html += '<button class="btn-add" onclick="openClinicRecordModal()">+ 記録</button>';
    html += '</div>';
    html += '</div>';

    var typeLabels = { vaccine: 'ワクチン', checkup: '健診', surgery: '手術', dental: '歯科', emergency: '緊急', test: '検査', observation: '経過観察' };
    var todayStr = new Date().toISOString().slice(0, 10);

    var scheduled = [];
    for (var u = 0; u < records.length; u++) {
      if (records[u].next_due) scheduled.push(records[u]);
    }
    if (scheduled.length > 0) {
      scheduled.sort(function (a, b) { return a.next_due < b.next_due ? -1 : 1; });
      html += '<div style="margin-bottom:10px;">';
      for (var ui = 0; ui < scheduled.length; ui++) {
        var up = scheduled[ui];
        var upLabel = typeLabels[up.record_type] || up.record_type;
        var diffDays = Math.ceil((new Date(up.next_due) - new Date(todayStr)) / 86400000);
        var isOverdue = diffDays < 0;
        var urgColor = isOverdue ? '#f87171' : diffDays <= 7 ? '#fb923c' : diffDays <= 30 ? '#facc15' : '#4ade80';
        var daysText = diffDays === 0 ? '今日' : isOverdue ? Math.abs(diffDays) + '日超過' : diffDays + '日後';
        var bgColor = isOverdue ? 'rgba(248,113,113,0.1)' : 'rgba(99,102,241,0.08)';
        html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:' + bgColor + ';border-radius:8px;margin-bottom:4px;border-left:3px solid ' + urgColor + ';">';
        html += '<span style="font-size:16px;">' + (isOverdue ? '⚠️' : '📅') + '</span>';
        html += '<div style="flex:1;">';
        html += '<div style="font-size:13px;font-weight:600;color:var(--text-main);">' + escapeHtml(up.next_due) + ' ' + escapeHtml(upLabel) + '</div>';
        if (up.value) html += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + escapeHtml(up.value) + '</div>';
        html += '</div>';
        html += '<button class="btn-add" onclick="markVetVisited(' + up.id + ',\'' + escapeHtml(up.record_type) + '\',\'' + escapeHtml(up.next_due) + '\')" style="background:rgba(74,222,128,0.15);color:#4ade80;font-size:11px;padding:4px 8px;white-space:nowrap;">✅ 受診済み</button>';
        html += '<span style="font-size:12px;font-weight:700;color:' + urgColor + ';white-space:nowrap;">' + daysText + '</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    var pastRecords = [];
    for (var p = 0; p < records.length; p++) pastRecords.push(records[p]);

    if (pastRecords.length === 0 && upcoming.length === 0) {
      html += '<div class="empty-msg">記録・予定なし</div>';
    } else if (pastRecords.length > 0) {
      for (var i = 0; i < pastRecords.length; i++) {
        var r = pastRecords[i];
        var typeLabel = typeLabels[r.record_type] || r.record_type;
        var badgeClass = 'hr-type-badge' + (r.record_type === 'emergency' ? ' emergency' : r.record_type === 'vaccine' ? ' vaccine' : '');
        html += '<div class="health-record-item">';
        html += '<div class="hr-head">';
        html += '<span><span class="' + badgeClass + '">' + escapeHtml(typeLabel) + '</span>' + escapeHtml(formatDateShort(r.record_date)) + '</span>';
        html += '<div style="display:flex;align-items:center;gap:6px;">';
        html += '<span style="font-size:11px;color:var(--text-dim);">' + escapeHtml(r.recorded_by || '') + '</span>';
        html += '<button class="btn-edit-small" onclick="deleteClinicRecord(' + r.id + ')" title="削除" style="font-size:11px;color:#f87171;padding:2px 4px;">🗑</button>';
        html += '</div>';
        html += '</div>';
        if (r.value) {
          html += '<div class="hr-value">' + escapeHtml(r.value) + '</div>';
        }
        if (r.details) {
          var detStr = '';
          try { var d = JSON.parse(r.details); detStr = typeof d === 'string' ? d : (d.note || d.finding || ''); } catch (_) { detStr = r.details; }
          if (detStr) html += '<div class="hr-details">' + escapeHtml(detStr) + '</div>';
        }
        if (r.next_due) {
          html += '<div class="hr-next-due">📅 次回: ' + escapeHtml(r.next_due) + '</div>';
        }
        html += '</div>';
      }
    }
    html += '</div>';
    clinicRecordsArea.innerHTML = html;
  }

  // ── 投薬スケジュールセクション ─────────────────────────────────────────────────

  var _medLogDate = null;

  function loadMedicationSchedule(selectedDate) {
    medicationScheduleArea.innerHTML = '<div class="detail-section"><div class="detail-title">💊 投薬スケジュール</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var date = selectedDate || _medLogDate || new Date().toISOString().slice(0, 10);
    _medLogDate = date;

    Promise.all([
      fetch(API_BASE + '/health/medications?cat_id=' + encodeURIComponent(catId), { headers: apiHeaders() }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/medication-logs?cat_id=' + encodeURIComponent(catId) + '&date=' + date, { headers: apiHeaders() }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      renderMedicationSchedule(results[0].medications || [], results[1].logs || [], date);
    }).catch(function () {
      medicationScheduleArea.innerHTML = '';
    });
  }

  window.onMedLogDateChange = function () {
    var inp = document.getElementById('medLogDate');
    if (inp && inp.value) loadMedicationSchedule(inp.value);
  };

  var _medicationsList = [];

  function renderMedicationSchedule(medications, logs, date) {
    _medicationsList = medications;
    var html = '<div class="detail-section">';
    html += '<div class="section-header" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">';
    html += '<div class="detail-title">💊 投薬スケジュール</div>';
    html += '<div style="display:flex;align-items:center;gap:8px;">';
    html += '<label style="font-size:12px;color:var(--text-dim);">記録日:</label>';
    html += '<input type="date" id="medLogDate" class="form-input" value="' + escapeHtml(date) + '" style="width:140px;padding:6px 8px;font-size:13px;" onchange="onMedLogDateChange()">';
    html += '<button class="btn-med-add" onclick="openMedScheduleModal()">＋ 追加</button>';
    html += '</div></div>';

    if (medications.length === 0) {
      html += '<div class="empty-msg">投薬スケジュールなし</div>';
    } else {
      for (var i = 0; i < medications.length; i++) {
        var med = medications[i];
        html += '<div class="med-schedule-card">';
        html += '<div class="med-schedule-head">';
        html += '<div>';
        html += '<div class="med-schedule-name">' + escapeHtml(med.medicine_name || '') + '</div>';
        html += '<div class="med-schedule-meta">';
        if (med.dosage_amount) html += med.dosage_amount + (med.dosage_unit ? escapeHtml(med.dosage_unit) : '') + '&nbsp;';
        if (med.frequency) html += escapeHtml(med.frequency) + '&nbsp;';
        var slots = [];
        try { slots = JSON.parse(med.time_slots || '[]'); } catch (_) {}
        if (slots.length) html += '[' + slots.map(escapeHtml).join('/') + '] ';
        if (med.route) html += '(' + escapeHtml(med.route) + ')&nbsp;';
        html += '開始: ' + escapeHtml(med.start_date || '');
        if (med.end_date) { html += ' 〜 ' + escapeHtml(med.end_date); } else { html += ' 〜 <span style="color:var(--text-dim)">未定</span>'; }
        html += '</div>';
        if (med.purpose) html += '<div class="med-schedule-meta">目的: ' + escapeHtml(med.purpose) + '</div>';
        if (med.notes) html += '<div class="med-schedule-tip">💡 ' + escapeHtml(med.notes) + '</div>';
        html += '</div>';
        html += '</div>';

        var medLogs = logs.filter(function (l) { return l.medication_id === med.id; });
        if (medLogs.length > 0) {
          html += '<div class="med-log-list">';
          var todayStr = new Date().toISOString().slice(0, 10);
          var dateLabel = date === todayStr ? '本日の記録' : (date.slice(5).replace('-', '/') + ' の記録');
          html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:6px;">' + escapeHtml(dateLabel) + '</div>';
          for (var j = 0; j < medLogs.length; j++) {
            html += renderMedicationLogItem(medLogs[j]);
          }
          html += '</div>';
        }

        html += '<div class="med-card-actions">';
        html += '<button class="btn-med-edit" onclick="openMedScheduleModal(' + med.id + ')">編集</button>';
        html += '<button class="btn-med-stop" onclick="stopMedSchedule(' + med.id + ')">終了</button>';
        html += '<button class="btn-med-stop" style="color:#f87171;" onclick="deleteMedSchedule(' + med.id + ')">削除</button>';
        html += '</div>';

        html += '</div>';
      }
    }
    html += '</div>';
    medicationScheduleArea.innerHTML = html;
  }

  function renderMedicationLogItem(log) {
    var statusIcon = log.status === 'done' ? '✅' : log.status === 'skipped' ? '⏭' : '⬜';
    var rawSlot = (log.scheduled_at || '').slice(11);
    var slotLabel = rawSlot;
    if (rawSlot === '朝' || rawSlot === '昼' || rawSlot === '晩') { slotLabel = rawSlot; }
    else { slotLabel = rawSlot.slice(0, 5); }

    var html = '<div class="med-log-item" id="medlog-' + log.id + '">';
    html += '<span class="med-log-status">' + statusIcon + '</span>';
    html += '<span class="med-log-time">' + escapeHtml(slotLabel) + '</span>';

    if (log.status === 'done') {
      var adminTime = (log.administered_at || '').slice(11, 16);
      html += '<span class="med-log-label">投与済 (' + escapeHtml(log.administered_by || '') + ' ' + escapeHtml(adminTime) + ')</span>';
    } else if (log.status === 'skipped') {
      html += '<span class="med-log-label">スキップ</span>';
    } else {
      html += '<span class="med-log-label">未実施</span>';
      html += '<span class="med-log-actions">';
      html += '<button class="btn-log-action done" onclick="doMedicationLog(' + log.id + ',\'done\')">完了</button>';
      html += '<button class="btn-log-action skip" onclick="doMedicationLog(' + log.id + ',\'skip\')">スキップ</button>';
      html += '</span>';
    }
    html += '</div>';
    return html;
  }

  // ── 投薬ログ操作 ──────────────────────────────────────────────────────────────

  window.doMedicationLog = function (logId, action) {
    var endpoint = API_BASE + '/health/medication-logs/' + logId + '/' + action;
    fetch(endpoint, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({}),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      // ログ行だけ更新
      var el = document.getElementById('medlog-' + logId);
      if (el && data.log) {
        el.outerHTML = renderMedicationLogItem(data.log);
      }
    }).catch(function () {
      alert('投薬ログの更新に失敗しました');
    });
  };

  // ── 投薬スケジュール モーダル ──────────────────────────────────────────────────

  var _medicinesList = null;
  var medScheduleModal = document.getElementById('medScheduleModal');

  function loadMedicines() {
    if (_medicinesList) return Promise.resolve(_medicinesList);
    var sp = (currentCatData && currentCatData.species) || 'cat';
    return fetch(API_BASE + '/health/medicines?species=' + sp, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _medicinesList = data.medicines || [];
        return _medicinesList;
      });
  }

  function populateMedicineSelect(medicines, selectedId) {
    var sel = document.getElementById('msMedicineId');
    sel.innerHTML = '<option value="">選択してください</option>';
    for (var i = 0; i < medicines.length; i++) {
      var m = medicines[i];
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + (m.category ? ' (' + m.category + ')' : '');
      if (selectedId && m.id === selectedId) opt.selected = true;
      sel.appendChild(opt);
    }
    var newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '＋ 新しい薬を登録';
    sel.appendChild(newOpt);

    sel.onchange = function () {
      document.getElementById('msNewMedicineGroup').style.display = sel.value === '__new__' ? '' : 'none';
    };
  }

  window.openMedScheduleModal = function (editId) {
    var modal = medScheduleModal;
    var isEdit = !!editId;

    document.getElementById('msEditId').value = editId || '';
    document.getElementById('medModalTitle').textContent = isEdit ? '💊 投薬スケジュールを編集' : '💊 投薬スケジュールを追加';

    loadMedicines().then(function (medicines) {
      if (isEdit) {
        var med = null;
        for (var i = 0; i < _medicationsList.length; i++) {
          if (_medicationsList[i].id === editId) { med = _medicationsList[i]; break; }
        }
        if (!med) { alert('スケジュールが見つかりません'); return; }

        populateMedicineSelect(medicines, med.medicine_id);
        document.getElementById('msMedicineId').disabled = true;
        document.getElementById('msDosageAmount').value = med.dosage_amount || '';
        document.getElementById('msDosageUnit').value = med.dosage_unit || '';
        document.getElementById('msFrequency').value = med.frequency || '毎日';
        onFrequencyChange();
        document.getElementById('msRoute').value = med.route || '経口';
        document.getElementById('msStartDate').value = med.start_date || '';
        document.getElementById('msEndDate').value = med.end_date || '';
        var endUndecided = document.getElementById('msEndDateUndecided');
        endUndecided.checked = !med.end_date;
        document.getElementById('msEndDate').disabled = !med.end_date;
        document.getElementById('msPurpose').value = med.purpose || '';
        document.getElementById('msNotes').value = med.notes || '';

        var slots = [];
        try { slots = JSON.parse(med.time_slots || '[]'); } catch (_) {}
        var checks = document.querySelectorAll('.ms-slot-checks input');
        for (var j = 0; j < checks.length; j++) {
          checks[j].checked = slots.indexOf(checks[j].value) !== -1;
        }
      } else {
        populateMedicineSelect(medicines, null);
        document.getElementById('msMedicineId').disabled = false;
        document.getElementById('msDosageAmount').value = '';
        document.getElementById('msDosageUnit').value = '';
        document.getElementById('msFrequency').value = '毎日';
        onFrequencyChange();
        document.getElementById('msRoute').value = '経口';
        document.getElementById('msStartDate').value = new Date().toISOString().slice(0, 10);
        document.getElementById('msEndDate').value = '';
        var endUndecided = document.getElementById('msEndDateUndecided');
        endUndecided.checked = true;
        document.getElementById('msEndDate').disabled = true;
        document.getElementById('msPurpose').value = '';
        document.getElementById('msNotes').value = '';
        document.getElementById('msNewMedicineGroup').style.display = 'none';
        document.getElementById('msNewMedicineName').value = '';

        var checks = document.querySelectorAll('.ms-slot-checks input');
        for (var j = 0; j < checks.length; j++) {
          checks[j].checked = checks[j].value === '朝';
        }
      }

      modal.classList.add('open');
    });
  };

  window.closeMedScheduleModal = function () {
    medScheduleModal.classList.remove('open');
  };

  window.onFrequencyChange = function () {
    var freq = document.getElementById('msFrequency').value;
    var hint = document.getElementById('msAlternateHint');
    if (hint) hint.style.display = (freq === '隔日(A)' || freq === '隔日(B)') ? '' : 'none';
  };

  window.toggleEndDate = function (cb) {
    var endInput = document.getElementById('msEndDate');
    if (cb.checked) {
      endInput.value = '';
      endInput.disabled = true;
    } else {
      endInput.disabled = false;
    }
  };

  window.submitMedSchedule = function () {
    var editId = document.getElementById('msEditId').value;
    var isEdit = !!editId;

    var medicineId = document.getElementById('msMedicineId').value;
    var newName = document.getElementById('msNewMedicineName').value.trim();

    var slots = [];
    var checks = document.querySelectorAll('.ms-slot-checks input');
    for (var j = 0; j < checks.length; j++) {
      if (checks[j].checked) slots.push(checks[j].value);
    }
    if (slots.length === 0) slots = ['朝'];

    var payload = {
      dosage_amount: parseFloat(document.getElementById('msDosageAmount').value) || null,
      dosage_unit: document.getElementById('msDosageUnit').value || null,
      frequency: document.getElementById('msFrequency').value,
      time_slots: slots,
      route: document.getElementById('msRoute').value,
      start_date: document.getElementById('msStartDate').value,
      end_date: document.getElementById('msEndDate').value || null,
      purpose: document.getElementById('msPurpose').value || null,
      notes: document.getElementById('msNotes').value || null,
    };

    if (isEdit) {
      fetch(API_BASE + '/health/medications/' + editId, {
        method: 'PUT',
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeMedScheduleModal();
        loadMedicationSchedule();
      }).catch(function () { alert('更新に失敗しました'); });
      return;
    }

    if (!payload.start_date) { alert('開始日は必須です'); return; }

    function doCreate(resolvedMedicineId) {
      payload.cat_id = catId;
      payload.medicine_id = resolvedMedicineId;
      fetch(API_BASE + '/health/medications', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeMedScheduleModal();
        _medicinesList = null;
        loadMedicationSchedule();
      }).catch(function () { alert('登録に失敗しました'); });
    }

    if (medicineId === '__new__') {
      if (!newName) { alert('新しい薬の名前を入力してください'); return; }
      var medBody = { id: 'med_' + newName.replace(/\s+/g, '_').toLowerCase() + '_' + Date.now(), name: newName };
      fetch(API_BASE + '/health/medicines', {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify(medBody),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('薬の登録に失敗: ' + (data.message || data.error)); return; }
        doCreate(data.medicine ? data.medicine.id : medBody.id);
      }).catch(function () { alert('薬の登録に失敗しました'); });
    } else if (medicineId) {
      doCreate(medicineId);
    } else {
      alert('薬を選択してください');
    }
  };

  window.stopMedSchedule = function (medId) {
    if (!confirm('この投薬スケジュールを終了しますか？')) return;
    var today = new Date().toISOString().slice(0, 10);
    fetch(API_BASE + '/health/medications/' + medId, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ active: false, end_date: today }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadMedicationSchedule();
    }).catch(function () { alert('終了に失敗しました'); });
  };

  window.deleteMedSchedule = function (medId) {
    if (!confirm('この投薬スケジュールと関連する投薬ログをすべて削除しますか？\nこの操作は取り消せません。')) return;
    fetch(API_BASE + '/health/medications/' + medId, {
      method: 'DELETE',
      headers: apiHeaders(),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('削除エラー: ' + (data.message || data.error)); return; }
      loadMedicationSchedule();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  // ── 給餌セクション（P5）──────────────────────────────────────────────────────

  function loadFeedingSection() {
    if (!feedingArea) return;
    feedingArea.innerHTML = '<div class="detail-section"><div class="detail-title">🍽 給餌プラン</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';
    if (calorieArea) calorieArea.innerHTML = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var today = new Date().toISOString().slice(0, 10);

    function doFetch(retryCount) {
      retryCount = retryCount || 0;
      Promise.all([
        fetch(API_BASE + '/feeding/calc?cat_id=' + encodeURIComponent(catId), { headers: apiHeaders() }).then(function (r) { return r.json(); }),
        fetch(API_BASE + '/feeding/logs?cat_id=' + encodeURIComponent(catId) + '&date=' + today, { headers: apiHeaders() }).then(function (r) { return r.json(); }),
        fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&limit=40', { headers: apiHeaders() }).then(function (r) { return r.json(); }),
        fetch(API_BASE + '/feeding/foods', { headers: apiHeaders() }).then(function (r) { return r.json(); }),
      ]).then(function (results) {
        var calcData = results[0];
        _lastCalcData = calcData;
        renderCalorieCard(calcData);
        var healthRecs = (results[2] && results[2].records) || [];
        var foodsDb = (results[3] && results[3].foods) || [];
        renderFeedingSection(calcData, results[1].logs || [], today, healthRecs, foodsDb);
      }).catch(function (err) {
        if (retryCount < 2) {
          setTimeout(function () { doFetch(retryCount + 1); }, 1200);
          return;
        }
        var errHtml = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div style="padding:16px;background:rgba(248,113,113,0.15);border-radius:8px;font-size:13px;color:#f87171;">データ取得に失敗しました。<button class="btn btn-outline" style="margin-top:8px;font-size:12px;" onclick="loadFeedingSection()">再読み込み</button></div></div>';
        if (calorieArea) calorieArea.innerHTML = errHtml;
        feedingArea.innerHTML = '<div class="detail-section"><div class="detail-title">🍽 給餌プラン</div><div style="padding:16px;color:var(--text-dim);">データ取得に失敗しました。<button class="btn btn-outline" style="margin-top:8px;" onclick="loadFeedingSection()">再読み込み</button></div></div>';
      });
    }
    doFetch(0);
  }

  function renderCalorieCard(calc) {
    if (!calorieArea) return;
    if (!calc || calc.error) {
      calorieArea.innerHTML = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div style="padding:12px;color:var(--text-dim);font-size:13px;">データを取得できませんでした。</div></div>';
      return;
    }
    var hasKcal = calc.required_kcal && calc.required_kcal > 0;
    var html = '<div class="detail-section">';
    html += '<div class="detail-title">🔥 カロリー評価・体型（BCS）</div>';
    html += '<div style="background:var(--surface);border-radius:8px;padding:12px;">';
    if (hasKcal) {
      var eatenKcal = calc.today ? (calc.today.eaten_kcal || 0) : 0;
      var remainKcal = calc.remaining_kcal != null ? calc.remaining_kcal : Math.max(0, calc.required_kcal - eatenKcal);
      var eatPct = Math.round(eatenKcal / calc.required_kcal * 100);
      var eatColor = eatPct >= 90 ? '#4ade80' : eatPct >= 50 ? '#facc15' : '#94a3b8';
      var eatBarPct = Math.min(eatPct, 100);
      var dataSource = calc.today && calc.today.data_source === 'health_records';

      html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">';
      html += '<span style="color:var(--text-dim);">1日の必要カロリー</span>';
      html += '<b style="color:var(--text-main);">' + calc.required_kcal + ' kcal</b>';
      html += '</div>';

      html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">';
      html += '<span style="color:var(--text-dim);">📊 本日の摂取</span>';
      html += '<b style="color:' + eatColor + ';">' + eatenKcal + ' / ' + calc.required_kcal + ' kcal (' + eatPct + '%)</b>';
      html += '</div>';
      html += '<div style="background:var(--surface-alt);border-radius:4px;height:6px;margin-bottom:6px;">';
      html += '<div style="background:' + eatColor + ';width:' + eatBarPct + '%;height:100%;border-radius:4px;"></div>';
      html += '</div>';

      var remMeals = calc.remaining_meals;
      var perMealKcal = calc.kcal_per_meal;
      if (remainKcal <= 0) {
        html += '<div style="font-size:12px;color:#4ade80;font-weight:700;margin-bottom:4px;">✅ 本日の目標カロリー達成</div>';
      } else if (remMeals && remMeals > 0 && perMealKcal) {
        html += '<div style="background:rgba(99,102,241,0.1);border-radius:6px;padding:8px;margin-bottom:6px;">';
        html += '<div style="font-size:12px;font-weight:700;color:var(--accent);margin-bottom:2px;">🍽 残り ' + remainKcal + ' kcal</div>';
        html += '<div style="font-size:11px;color:var(--text-dim);">あと ' + remMeals + ' 食 × 約 ' + perMealKcal + ' kcal/食</div>';
        html += '</div>';
      } else {
        html += '<div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;">残り ' + remainKcal + ' kcal</div>';
      }

      var sourceLabel = dataSource ? '記録ベースの推定値' : '';
      var stageLabel = escapeHtml(lifeStageLabel(calc.life_stage));
      var planRef = '登録プラン: ' + (calc.plan_total_kcal || 0) + ' kcal';
      var metaItems = [stageLabel, planRef];
      if (sourceLabel) metaItems.push(sourceLabel);
      html += '<div style="font-size:10px;color:var(--text-dim);">' + metaItems.join('　|　') + '</div>';
    } else {
      html += '<div style="padding:8px 0;font-size:13px;color:var(--accent);">📏 体重を記録すると必要カロリーが計算されます</div>';
      html += '<a href="#healthRecordsArea" style="font-size:11px;color:var(--accent);margin-top:4px;display:inline-block;">⚖️ 体重記録へ</a>';
    }

    var bcs = calc.body_condition_score;
    var trend = calc.weight_trend;
    var trendPct = calc.weight_trend_pct;
    html += '<div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">';
    html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">体型（BCS 1-9）</div>';
    html += '<select id="bcsSelect" class="form-select" style="width:100%;padding:6px 8px;font-size:13px;" onchange="saveBCS(this.value)">';
    html += '<option value="">未設定</option>';
    for (var i = 1; i <= 9; i++) {
      var label = i === 5 ? '5（理想）' : i < 5 ? i + '（痩せ）' : i + '（肥満）';
      html += '<option value="' + i + '"' + (bcs == i ? ' selected' : '') + '>' + label + '</option>';
    }
    html += '</select>';
    if (trend && trend !== 'stable') {
      html += '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;">体重推移: ' + escapeHtml(trend) + (trendPct != null ? ' (' + trendPct + '%)' : '') + '</div>';
    }
    html += '</div>';

    var ctx = calc.context;
    if (ctx && ctx.prefer_wet && ctx.reason) {
      html += '<div style="margin-top:8px;padding:6px 8px;background:rgba(248,113,113,0.1);border-radius:6px;font-size:11px;color:#f87171;">';
      html += '⚠️ ' + escapeHtml(ctx.reason.trim()) + ' → ウェット優先推奨';
      html += '</div>';
    }

    var sug = calc.suggestion;
    if (hasKcal && sug && sug.items && sug.items.length > 0) {
      html += '<div style="margin-top:10px;border-top:1px solid rgba(255,255,255,0.06);padding-top:8px;">';
      html += '<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:4px;">💡 フード提案（残り ' + remainKcal + ' kcal）</div>';
      for (var si = 0; si < sug.items.length; si++) {
        var item = sug.items[si];
        var formIcon = item.form === 'wet' || item.form === 'liquid' ? '🥫' : '🥣';
        html += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;">';
        html += '<span>' + formIcon + ' ' + escapeHtml(item.food_name) + '</span>';
        html += '<span style="color:var(--text-dim);">' + item.amount_g + 'g (' + item.kcal + 'kcal)</span>';
        html += '</div>';
      }
      html += '</div>';
    }

    html += '</div></div>';
    calorieArea.innerHTML = html;
  }

  window.loadFeedingSection = loadFeedingSection;
  window.saveBCS = function (value) {
    if (!value || !catId) return;
    var bcsNum = parseInt(value, 10);
    var bcsLabel = bcsNum === 5 ? '5（理想）' : bcsNum < 5 ? bcsNum + '（痩せ）' : bcsNum + '（肥満）';
    fetch(API_BASE + '/feeding/nutrition-profile?cat_id=' + encodeURIComponent(catId), {
      method: 'PATCH',
      headers: apiHeaders(),
      body: JSON.stringify({ body_condition_score: bcsNum }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      var cell = document.getElementById('bcsInfoCell');
      if (cell) {
        var valEl = cell.querySelector('.info-value');
        if (valEl) valEl.innerHTML = escapeHtml(bcsLabel) + ' <a href="#calorieArea" style="font-size:11px;color:var(--accent);">編集</a>';
      }
      loadFeedingSection();
    }).catch(function () {
      alert('体型の保存に失敗しました');
    });
  };

  function parseFeedingText(text, foodsDb) {
    var items = [];
    var cleaned = text.replace(/【評価:[^】]*】/g, '').replace(/■ご飯指示[\s\S]*/g, '').trim();
    var parts = cleaned.split(/[①②③④⑤⑥⑦⑧]/).filter(function (p) { return p.trim(); });
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (!p) continue;
      var timeMatch = p.match(/^(\d{1,2}:\d{2})\s*/);
      var time = timeMatch ? timeMatch[1] : '';
      var rest = timeMatch ? p.slice(timeMatch[0].length) : p;

      var gramsMatch = rest.match(/(\d+(?:\.\d+)?)\s*[gｇ]/);
      var offeredG = gramsMatch ? parseFloat(gramsMatch[1]) : 0;

      var leftoverMatch = rest.match(/[→⇒]\s*(\d+(?:\.\d+)?)\s*[gｇ]\s*残/);
      var leftoverG = leftoverMatch ? parseFloat(leftoverMatch[1]) : 0;
      var isComplete = rest.indexOf('完食') !== -1;
      if (isComplete) leftoverG = 0;

      var foodName = rest.replace(/\d{1,2}:\d{2}\s*/, '')
        .replace(/\d+(?:\.\d+)?\s*[gｇ]/, '').replace(/[→⇒].*/, '')
        .replace(/^\s*[\(（].*?[\)）]\s*/, '').trim();
      if (!foodName && !offeredG) continue;

      var eatenG = offeredG - leftoverG;
      var kcalPer100 = 0;
      var matchedFood = '';
      for (var fi = 0; fi < foodsDb.length; fi++) {
        var fn = foodsDb[fi].name || '';
        if (foodName && (foodName.indexOf(fn) !== -1 || fn.indexOf(foodName) !== -1)) {
          kcalPer100 = foodsDb[fi].kcal_per_100g || 0;
          matchedFood = fn;
          break;
        }
      }
      if (!matchedFood) {
        var keywords = [
          { k: 'ピュリナ尿路', id: 'food_purina_urinary' },
          { k: 'メディファス尿路', id: 'food_medifas_urinary' },
          { k: '低分子プロテイン', id: 'food_rc_low_protein' },
          { k: 'カルカン', id: 'food_kalkan_wet' },
          { k: '腎サポ スペシャル', id: 'food_renal_special' },
          { k: '腎サポスペシャル', id: 'food_renal_special' },
          { k: '腎サポウェット', id: 'food_renal_wet' },
          { k: '腎サポ ウェット', id: 'food_renal_wet' },
          { k: 'kd缶', id: 'food_kd_can' },
          { k: 'kd缶', id: 'food_kd_can' },
          { k: 'KD缶', id: 'food_kd_can' },
          { k: '健康缶', id: 'food_eye_care' },
          { k: 'エルモ', id: 'food_elmo' },
          { k: 'キドニーキープリッチ', id: 'food_kidney_keep_rich' },
          { k: 'キドニーキープ', id: 'food_kidney_keep' },
          { k: 'プロフェッショナルバランス', id: 'food_pro_balance' },
          { k: 'ちゅる水', id: 'food_churu_water' },
          { k: '腸内バイオーム', id: 'food_gi_biome' },
          { k: 'メディコートアドバンス', id: 'food_medifas_advance' },
          { k: 'センシブル', id: 'food_sensible' },
          { k: 'センシ', id: 'food_sensible' },
          { k: 'aim', id: 'food_aim30' },
          { k: 'AIM', id: 'food_aim30' },
          { k: 'ドクターズケア', id: 'food_doctors_care' },
          { k: 'ニュートロ子猫', id: 'food_nutro_kitten' },
        ];
        for (var ki = 0; ki < keywords.length; ki++) {
          if (foodName.indexOf(keywords[ki].k) !== -1 || rest.indexOf(keywords[ki].k) !== -1) {
            for (var fj = 0; fj < foodsDb.length; fj++) {
              if (foodsDb[fj].id === keywords[ki].id) {
                kcalPer100 = foodsDb[fj].kcal_per_100g || 0;
                matchedFood = foodsDb[fj].name;
                break;
              }
            }
            if (matchedFood) break;
          }
        }
      }

      var eatenKcal = kcalPer100 ? Math.round(eatenG * kcalPer100 / 100) : 0;
      items.push({
        time: time,
        name: foodName,
        matchedName: matchedFood,
        offeredG: offeredG,
        leftoverG: leftoverG,
        eatenG: eatenG,
        isComplete: isComplete,
        kcalPer100: kcalPer100,
        eatenKcal: eatenKcal,
      });
    }
    return items;
  }

  function extractFeedingEval(text) {
    var m = text.match(/【評価:\s*([^】]*)】/);
    return m ? m[1] : '';
  }

  function countVomitRecords(healthRecs, todayStr) {
    var now = new Date();
    var d7 = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
    var d30 = new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    var result = { today: 0, week: 0, total: 0, lastDate: '' };
    for (var i = 0; i < healthRecs.length; i++) {
      var r = healthRecs[i];
      var isVomit = false;
      var count = 1;
      if (r.record_type === 'vomiting') {
        isVomit = true;
      } else if (r.record_type === 'observation') {
        var val = (r.value || '') + ' ' + (r.details || '');
        if (val.indexOf('はき戻し') !== -1 || val.indexOf('嘔吐') !== -1 || val.indexOf('吐いた') !== -1) {
          isVomit = true;
          var m = val.match(/(\d+)\s*回/);
          if (m) count = parseInt(m[1], 10) || 1;
        }
      }
      if (!isVomit) continue;
      var rd = r.record_date || '';
      if (rd < d30) continue;
      result.total += count;
      if (rd >= d7) result.week += count;
      if (rd === todayStr) result.today += count;
      if (!result.lastDate || rd > result.lastDate) result.lastDate = rd;
    }
    return result;
  }

  function renderMealHistoryBlock(title, obsRec, foodsDb) {
    if (!obsRec) return '';
    var val = obsRec.value || '';
    var evalText = extractFeedingEval(val);
    var items = parseFeedingText(val, foodsDb);
    if (items.length === 0 && !evalText) return '';

    var totalOffered = 0, totalEaten = 0, totalKcal = 0;
    for (var i = 0; i < items.length; i++) {
      totalOffered += items[i].offeredG;
      totalEaten += items[i].eatenG;
      totalKcal += items[i].eatenKcal;
    }

    var evalColor = evalText.indexOf('完食') !== -1 ? '#4ade80' :
      evalText.indexOf('少し残') !== -1 ? '#facc15' :
      evalText.indexOf('半分') !== -1 ? '#fb923c' :
      evalText.indexOf('7割') !== -1 || evalText.indexOf('全残') !== -1 ? '#f87171' : 'var(--text-dim)';

    var html = '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    html += '<b style="font-size:13px;">' + title + '</b>';
    if (evalText) html += '<span style="font-size:11px;font-weight:700;color:' + evalColor + ';">' + escapeHtml(evalText) + '</span>';
    html += '</div>';

    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:12px;">';
      html += '<div style="flex:1;min-width:0;">';
      if (it.time) html += '<span style="color:var(--primary);margin-right:4px;">' + escapeHtml(it.time) + '</span>';
      html += '<span>' + escapeHtml(it.name || it.matchedName || '?') + '</span>';
      html += '</div>';
      html += '<div style="text-align:right;white-space:nowrap;">';
      if (it.offeredG) {
        html += '<span style="color:var(--text-dim);">' + it.offeredG + 'g</span>';
        if (it.leftoverG > 0) {
          html += '<span style="color:#f87171;margin-left:4px;">-' + it.leftoverG + 'g残</span>';
        } else if (it.isComplete) {
          html += '<span style="color:#4ade80;margin-left:4px;">完食</span>';
        }
        if (it.eatenKcal > 0) {
          html += '<span style="color:#a78bfa;margin-left:4px;">' + it.eatenKcal + 'kcal</span>';
        }
      }
      html += '</div></div>';
    }

    if (items.length > 0 && totalOffered > 0) {
      html += '<div style="display:flex;justify-content:space-between;margin-top:6px;padding-top:6px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;font-weight:700;">';
      html += '<span>合計</span>';
      html += '<span>提供 ' + Math.round(totalOffered) + 'g → 摂取 ' + Math.round(totalEaten) + 'g';
      if (totalKcal > 0) html += ' (' + totalKcal + 'kcal)';
      html += '</span></div>';
    }
    html += '</div>';
    return html;
  }

  function renderFeedingSection(calc, logs, today, healthRecs, foodsDb) {
    healthRecs = healthRecs || [];
    foodsDb = foodsDb || [];

    var html = '<div class="detail-section">';

    var yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    var prevEvening = null, morningMeal = null, eveningMeal = null;
    for (var hi = 0; hi < healthRecs.length; hi++) {
      var hr = healthRecs[hi];
      if (hr.record_type !== 'observation') continue;
      var det = hr.details || '';
      if (!prevEvening && det === '前日夜ごはん' && hr.record_date === today) prevEvening = hr;
      if (!morningMeal && det === '朝飯内容' && hr.record_date === today) morningMeal = hr;
      if (!eveningMeal && det === '夜飯内容' && hr.record_date === today) eveningMeal = hr;
      if (!eveningMeal && det === '夜飯内容' && hr.record_date === yesterday) eveningMeal = hr;
      if (!prevEvening && det === '前日夜ごはん' && hr.record_date === yesterday) prevEvening = hr;
      if (!morningMeal && det === '朝飯内容' && hr.record_date === yesterday) morningMeal = hr;
    }

    var histBlock = renderMealHistoryBlock('🌙 昨夜の夜ごはん', prevEvening || eveningMeal, foodsDb);
    var mornBlock = renderMealHistoryBlock('☀️ 今朝のごはん', morningMeal, foodsDb);

    if (histBlock || mornBlock) {
      html += '<div style="margin-bottom:12px;">';
      html += '<div style="font-size:14px;font-weight:700;margin-bottom:8px;">📊 直近の給餌実績</div>';
      html += histBlock;
      html += mornBlock;
      html += '</div>';
    }

    var vomitCounts = countVomitRecords(healthRecs, today);
    if (vomitCounts.total > 0) {
      var vBg = vomitCounts.today > 0 ? 'rgba(248,113,113,0.12)' : 'rgba(251,146,60,0.10)';
      var vBorder = vomitCounts.today > 0 ? '#f87171' : '#fb923c';
      html += '<div style="background:' + vBg + ';border-left:3px solid ' + vBorder + ';border-radius:8px;padding:10px 12px;margin-bottom:10px;">';
      html += '<div style="font-size:13px;font-weight:700;color:' + vBorder + ';margin-bottom:4px;">🤮 はき戻し記録</div>';
      html += '<div style="display:flex;gap:16px;font-size:12px;color:var(--text-main);">';
      if (vomitCounts.today > 0) {
        html += '<span>今日: <b style="color:#f87171;">' + vomitCounts.today + '回</b></span>';
      }
      html += '<span>直近7日: <b>' + vomitCounts.week + '回</b></span>';
      html += '<span>直近30日: <b>' + vomitCounts.total + '回</b></span>';
      html += '</div>';
      if (vomitCounts.lastDate) {
        html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">最終: ' + escapeHtml(vomitCounts.lastDate) + '</div>';
      }
      html += '</div>';
    }

    html += '<div class="section-header">';
    html += '<div class="detail-title">🍽 給餌プラン</div>';
    html += '<div style="display:flex;gap:4px;">';
    html += '<button class="btn-add" onclick="openAddPlanModal()" title="プラン追加">+ 追加</button>';
    html += '<button class="btn-add" style="background:rgba(168,139,250,0.15);color:#c4b5fd;" onclick="openPresetApplyModal()" title="プリセット適用">📋 プリセット</button>';
    html += '<button class="btn-add" style="background:rgba(59,130,246,0.15);color:#93c5fd;" onclick="openFeedingLogModal()" title="手動記録">📝 記録</button>';
    html += '</div></div>';

    if (calc && !calc.error) {
      var mpd = calc.meals_per_day;
      var fedCnt = calc.fed_count || 0;
      var remain = mpd ? Math.max(0, mpd - fedCnt) : null;

      html += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
      html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
      html += '<span style="font-size:12px;color:var(--text-dim);">1日の給餌回数</span>';
      html += '<div style="display:flex;align-items:center;gap:6px;">';
      html += '<select id="mealsPerDaySelect" style="background:var(--surface-alt);color:var(--text-main);border:1px solid var(--surface-alt);border-radius:6px;padding:4px 8px;font-size:13px;">';
      var mpdOptions = [{ v: '', l: '未設定' }];
      for (var mpdI = 1; mpdI <= 16; mpdI++) { mpdOptions.push({ v: String(mpdI), l: mpdI + '回' }); }
      for (var mi = 0; mi < mpdOptions.length; mi++) {
        var sel = (mpd !== null && String(mpd) === mpdOptions[mi].v) || (!mpd && mpdOptions[mi].v === '') ? ' selected' : '';
        html += '<option value="' + mpdOptions[mi].v + '"' + sel + '>' + mpdOptions[mi].l + '</option>';
      }
      html += '</select>';
      html += '<button class="btn-outline" style="font-size:11px;padding:4px 8px;" onclick="saveMealsPerDay()">保存</button>';
      html += '</div></div>';

      if (mpd) {
        var progressColor = fedCnt >= mpd ? '#4ade80' : fedCnt > 0 ? '#facc15' : '#f87171';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;">';
        html += '<span>今日の進捗</span>';
        html += '<span style="color:' + progressColor + ';font-weight:700;">' + fedCnt + ' / ' + mpd + ' 回';
        if (remain > 0) html += ' <span style="font-size:11px;color:var(--text-dim);">（残り ' + remain + ' 回）</span>';
        else html += ' ✅';
        html += '</span></div>';

        if (calc.remaining_meals && calc.remaining_meals > 0 && calc.remaining_kcal > 0 && calc.kcal_per_meal) {
          html += '<div style="margin-top:6px;padding:8px;background:rgba(168,139,250,0.1);border-radius:6px;font-size:12px;color:#c4b5fd;">';
          html += '💡 残り <b>' + calc.remaining_meals + '回</b> で <b>' + calc.remaining_kcal + 'kcal</b> → ';
          html += '1回あたり <b style="color:#a78bfa;">' + calc.kcal_per_meal + 'kcal</b> が目安です';
          html += '</div>';
        }
      }
      html += '</div>';

      var plans = calc.plans || [];
      var todayLogPlanIds = {};
      for (var li = 0; li < logs.length; li++) {
        if (logs[li].plan_id) todayLogPlanIds[logs[li].plan_id] = logs[li];
      }

      if (plans.length === 0) {
        html += '<div class="empty-msg">給餌プランなし — 「+ 追加」か「📋 プリセット」で登録してください</div>';
      } else {
        var slots = {};
        var slotOrder = [];
        for (var i = 0; i < plans.length; i++) {
          var sl = plans[i].meal_slot || 'other';
          if (!slots[sl]) { slots[sl] = { items: [], totalG: 0, totalKcal: 0 }; slotOrder.push(sl); }
          slots[sl].items.push(plans[i]);
          slots[sl].totalG += plans[i].amount_g || 0;
          slots[sl].totalKcal += plans[i].kcal_calc || 0;
        }
        var grandG = 0;
        var grandKcal = 0;
        for (var si = 0; si < slotOrder.length; si++) {
          var sKey = slotOrder[si];
          var slot = slots[sKey];
          grandG += slot.totalG;
          grandKcal += slot.totalKcal;
          html += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:6px;">';
          html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">';
          html += '<b style="font-size:13px;color:var(--accent);">' + escapeHtml(slotLabel(sKey)) + '</b>';
          html += '<span style="font-size:11px;color:var(--text-dim);">計 ' + Math.round(slot.totalG) + 'g / ' + Math.round(slot.totalKcal) + 'kcal</span>';
          html += '</div>';
          for (var ii = 0; ii < slot.items.length; ii++) {
            var p = slot.items[ii];
            var fedLog = todayLogPlanIds[p.id];
            var isFed = !!fedLog;
            var typeTag = p.plan_type === 'preset' ? '<span style="font-size:9px;background:rgba(168,139,250,0.2);color:#c4b5fd;padding:1px 4px;border-radius:3px;margin-right:4px;">プリセット</span>' :
              p.plan_type === 'nyagi' ? '<span style="font-size:9px;background:rgba(74,222,128,0.2);color:#4ade80;padding:1px 4px;border-radius:3px;margin-right:4px;">NYAGI</span>' : '';

            html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">';

            if (isFed) {
              html += '<span style="font-size:18px;cursor:default;" title="あげた済み (' + escapeHtml(fedLog.served_time || '') + ')">✅</span>';
            } else {
              html += '<button type="button" onclick="quickFed(' + p.id + ')" style="font-size:18px;background:none;border:none;cursor:pointer;padding:0;" title="あげた！">⬜</button>';
            }

            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-size:12px;display:flex;align-items:center;">' + typeTag + escapeHtml(p.food_name || '') + '</div>';
            html += '<div style="font-size:11px;color:var(--text-dim);">' + p.amount_g + 'g (' + Math.round(p.kcal_calc || 0) + 'kcal)';
            if (p.scheduled_time) html += ' ⏰' + escapeHtml(p.scheduled_time);
            html += '</div>';
            if (isFed && fedLog.eaten_pct !== null && fedLog.eaten_pct !== undefined && fedLog.eaten_pct < 100) {
              html += '<div style="font-size:10px;color:#facc15;">食べた量: ' + fedLog.eaten_pct + '%</div>';
            }
            html += '</div>';

            html += '<div style="display:flex;gap:2px;">';
            if (isFed) {
              html += '<button type="button" class="btn-edit-small" onclick="openFeedingLogModalForEdit(' + fedLog.id + ')" title="食べ残し修正" style="font-size:11px;">🍽</button>';
            }
            html += '<button type="button" class="btn-edit-small" onclick="editPlan(' + p.id + ')" title="編集" style="font-size:11px;">✏️</button>';
            html += '<button type="button" class="btn-edit-small" onclick="deletePlan(' + p.id + ')" title="削除" style="font-size:11px;color:#f87171;">🗑</button>';
            html += '</div>';
            html += '</div>';
          }
          html += '</div>';
        }
        html += '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:4px 12px;color:var(--text-main);">';
        html += '<span>合計</span>';
        html += '<span>' + Math.round(grandG) + 'g / ' + Math.round(grandKcal) + 'kcal</span>';
        html += '</div>';
      }
    }

    // 今日の給餌ログ（プラン外の手動記録も含む）
    var manualLogs = [];
    for (var mli = 0; mli < logs.length; mli++) {
      if (!logs[mli].plan_id) manualLogs.push(logs[mli]);
    }
    if (manualLogs.length > 0) {
      html += '<div style="margin-top:12px;font-size:13px;font-weight:700;padding:4px 0;border-top:1px solid var(--surface-alt);">📝 手動記録</div>';
      for (var i = 0; i < manualLogs.length; i++) {
        var l = manualLogs[i];
        html += '<div class="feeding-log-row" style="background:var(--surface);border-radius:8px;padding:8px 12px;margin-top:6px;display:flex;justify-content:space-between;align-items:center;">';
        html += '<span style="font-size:13px;">' + escapeHtml(slotLabel(l.meal_slot)) + ': ';
        if (l.food_name) html += escapeHtml(l.food_name) + ' ';
        if (l.offered_g) html += l.offered_g + 'g';
        if (l.served_time) html += ' ' + escapeHtml(l.served_time);
        html += '</span>';
        html += '<span style="display:flex;align-items:center;gap:8px;">';
        if (l.eaten_pct !== null && l.eaten_pct !== undefined) {
          var eatColor = l.eaten_pct >= 80 ? '#4ade80' : l.eaten_pct >= 50 ? '#facc15' : '#f87171';
          html += '<span style="font-size:12px;color:' + eatColor + ';">' + l.eaten_pct + '%</span>';
        }
        html += '<button type="button" class="btn-edit-small" onclick="openFeedingLogModalForEdit(' + l.id + ')" title="編集">✏️</button>';
        html += '</span></div>';
      }
    }

    // 音声入力ボタン
    html += '<div style="margin-top:12px;text-align:center;">';
    html += '<button class="btn btn-outline" style="font-size:13px;" onclick="startFeedingVoice()">🎤 音声で記録</button>';
    html += '</div>';

    html += '</div>';
    feedingArea.innerHTML = html;
    _feedingLogsCache = logs;
  }

  window.quickFed = function (planId) {
    fetch(API_BASE + '/feeding/plans/' + planId + '/fed', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({})
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('記録に失敗しました'); });
  };

  window.deletePlan = function (planId) {
    if (!confirm('この給餌プランを削除しますか？')) return;
    fetch(API_BASE + '/feeding/plans/' + planId, {
      method: 'DELETE', headers: apiHeaders()
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.editPlan = function (planId) {
    var plans = (_lastCalcData && _lastCalcData.plans) || [];
    var plan = null;
    for (var i = 0; i < plans.length; i++) { if (plans[i].id === planId) { plan = plans[i]; break; } }
    if (!plan) { alert('プランが見つかりません'); return; }
    _editingPlanId = planId;
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 プランを編集';
    if (document.getElementById('apSlot')) document.getElementById('apSlot').value = plan.meal_slot || 'morning';
    if (document.getElementById('apAmount')) document.getElementById('apAmount').value = plan.amount_g || '';
    if (document.getElementById('apTime')) document.getElementById('apTime').value = plan.scheduled_time || '';
    if (document.getElementById('apNotes')) document.getElementById('apNotes').value = plan.notes || '';
    ensureFoodList(function () {
      var sel = document.getElementById('apFoodId');
      if (sel && plan.food_id) sel.value = plan.food_id;
      calcPlanKcal();
    });
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  var _editingPlanId = null;
  var _lastCalcData = null;

  window.openAddPlanModal = function () {
    _editingPlanId = null;
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 プランを追加';
    if (document.getElementById('apSlot')) document.getElementById('apSlot').value = 'morning';
    if (document.getElementById('apAmount')) document.getElementById('apAmount').value = '';
    if (document.getElementById('apTime')) document.getElementById('apTime').value = '';
    if (document.getElementById('apNotes')) document.getElementById('apNotes').value = '';
    if (document.getElementById('apKcalPreview')) document.getElementById('apKcalPreview').style.display = 'none';
    ensureFoodList(function () {});
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  window.closeAddPlanModal = function () {
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.remove('open');
  };

  window.calcPlanKcal = function () {
    var sel = document.getElementById('apFoodId');
    var gInput = document.getElementById('apAmount');
    var preview = document.getElementById('apKcalPreview');
    if (!sel || !gInput || !preview) return;
    var food = null;
    for (var i = 0; i < _feedFoodsList.length; i++) {
      if (_feedFoodsList[i].id === sel.value) { food = _feedFoodsList[i]; break; }
    }
    if (food && gInput.value) {
      var kcal = Math.round(parseFloat(gInput.value) * food.kcal_per_100g / 100);
      preview.textContent = '= ' + kcal + ' kcal (' + food.kcal_per_100g + 'kcal/100g)';
      preview.style.display = '';
    } else {
      preview.style.display = 'none';
    }
  };

  window.submitPlan = function () {
    var foodId = document.getElementById('apFoodId') ? document.getElementById('apFoodId').value : '';
    var slot = document.getElementById('apSlot') ? document.getElementById('apSlot').value : 'morning';
    var amountG = document.getElementById('apAmount') ? parseFloat(document.getElementById('apAmount').value) : 0;
    var time = document.getElementById('apTime') ? document.getElementById('apTime').value : '';
    var notes = document.getElementById('apNotes') ? document.getElementById('apNotes').value : '';

    if (!foodId || !amountG) { alert('フードと量は必須です'); return; }

    var payload = { food_id: foodId, meal_slot: slot, amount_g: amountG, scheduled_time: time || null, notes: notes || null };

    if (_editingPlanId) {
      fetch(API_BASE + '/feeding/plans/' + _editingPlanId, {
        method: 'PUT', headers: apiHeaders(), body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeAddPlanModal();
        loadFeedingSection();
      }).catch(function () { alert('更新に失敗しました'); });
    } else {
      payload.cat_id = catId;
      fetch(API_BASE + '/feeding/plans', {
        method: 'POST', headers: apiHeaders(), body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeAddPlanModal();
        loadFeedingSection();
      }).catch(function () { alert('追加に失敗しました'); });
    }
  };

  // プリセット適用
  window.openPresetApplyModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box"><div class="modal-title">📋 プリセットを適用</div><div class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div></div>';
    modal.classList.add('open');

    var sp = (currentCatData && currentCatData.species) || 'cat';
    fetch(API_BASE + '/feeding/presets?species=' + sp, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var innerHtml = '<div class="modal-box" style="max-height:80vh;overflow-y:auto;">';
        innerHtml += '<div class="modal-title">📋 プリセットを適用</div>';
        if (presets.length === 0) {
          innerHtml += '<div class="empty-msg">プリセットがありません。「プリセット管理」で作成してください。</div>';
        } else {
          for (var i = 0; i < presets.length; i++) {
            var ps = presets[i];
            innerHtml += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
            innerHtml += '<div style="display:flex;justify-content:space-between;align-items:center;">';
            innerHtml += '<b style="font-size:13px;">' + escapeHtml(ps.name) + '</b>';
            innerHtml += '<button class="btn btn-primary" style="font-size:11px;padding:4px 10px;" onclick="applyPreset(' + ps.id + ')">適用</button>';
            innerHtml += '</div>';
            if (ps.description) innerHtml += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + escapeHtml(ps.description) + '</div>';
            innerHtml += '<div style="font-size:11px;color:var(--accent);margin-top:4px;">' + (ps.items || []).length + '品 / 計 ' + (ps.total_kcal || 0) + 'kcal</div>';
            for (var j = 0; j < (ps.items || []).length; j++) {
              var it = ps.items[j];
              innerHtml += '<div style="font-size:11px;color:var(--text-dim);padding:1px 0;">' + escapeHtml(slotLabel(it.meal_slot)) + ': ' + escapeHtml(it.food_name || '') + ' ' + it.amount_g + 'g</div>';
            }
            innerHtml += '</div>';
          }
        }
        innerHtml += '<div style="margin-top:12px;text-align:center;"><button class="btn btn-outline" style="font-size:12px;" onclick="openPresetManageModal()">プリセット管理</button></div>';
        innerHtml += '<div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div>';
        innerHtml += '</div>';
        modal.innerHTML = innerHtml;
      }).catch(function () { alert('プリセットの読み込みに失敗しました'); closePresetApplyModal(); });
  };

  window.closePresetApplyModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (modal) modal.classList.remove('open');
  };

  window.applyPreset = function (presetId) {
    fetch(API_BASE + '/feeding/presets/' + presetId + '/apply', {
      method: 'POST', headers: apiHeaders(), body: JSON.stringify({ cat_id: catId })
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      alert('プリセット「' + (data.preset_name || '') + '」を適用しました（' + (data.applied || []).length + '品追加）');
      closePresetApplyModal();
      loadFeedingSection();
    }).catch(function () { alert('適用に失敗しました'); });
  };

  // プリセット管理モーダル
  window.openPresetManageModal = function () {
    closePresetApplyModal();
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">⚙️ プリセット管理</div><div id="presetManageContent" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div></div>';
    modal.classList.add('open');

    fetch(API_BASE + '/feeding/presets', { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var area = document.getElementById('presetManageContent');
        if (!area) return;
        var h = '';
        h += '<button class="btn btn-primary" style="font-size:12px;margin-bottom:12px;" onclick="openCreatePresetModal()">+ 新規プリセット</button>';
        if (presets.length === 0) {
          h += '<div class="empty-msg">プリセットなし</div>';
        }
        for (var i = 0; i < presets.length; i++) {
          var ps = presets[i];
          h += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
          h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
          h += '<b>' + escapeHtml(ps.name) + '</b>';
          h += '<div><button class="btn-edit-small" onclick="editPresetItems(' + ps.id + ')" title="中身編集">✏️</button> <button class="btn-edit-small" style="color:#f87171;" onclick="deletePreset(' + ps.id + ')" title="削除">🗑</button></div>';
          h += '</div>';
          h += '<div style="font-size:11px;color:var(--text-dim);">' + (ps.items || []).length + '品</div>';
          h += '</div>';
        }
        area.className = '';
        area.innerHTML = h;
      });
  };

  window.deletePreset = function (id) {
    if (!confirm('このプリセットを削除しますか？')) return;
    fetch(API_BASE + '/feeding/presets/' + id, { method: 'DELETE', headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        openPresetManageModal();
      });
  };

  window.openCreatePresetModal = function () {
    var name = prompt('プリセット名を入力してください（例: 腎臓ケアセット）');
    if (!name) return;
    var desc = prompt('説明（任意）', '');
    fetch(API_BASE + '/feeding/presets', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ name: name, description: desc || null })
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      editPresetItems(data.preset.id);
    }).catch(function () { alert('作成に失敗しました'); });
  };

  window.editPresetItems = function (presetId) {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📋 プリセット フード編集</div><div id="presetItemsContent" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="openPresetManageModal()">戻る</button></div></div>';
    modal.classList.add('open');

    fetch(API_BASE + '/feeding/presets/' + presetId + '/items', { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = data.items || [];
        var area = document.getElementById('presetItemsContent');
        if (!area) return;
        var h = '';
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          h += '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(255,255,255,0.05);">';
          h += '<span style="font-size:12px;">' + escapeHtml(slotLabel(it.meal_slot)) + ': ' + escapeHtml(it.food_name || '') + ' ' + it.amount_g + 'g</span>';
          h += '<button class="btn-edit-small" style="color:#f87171;" onclick="deletePresetItem(' + presetId + ',' + it.id + ')">🗑</button>';
          h += '</div>';
        }
        h += '<div style="margin-top:12px;">';
        h += '<button class="btn btn-primary" style="font-size:12px;" onclick="addPresetItemPrompt(' + presetId + ')">+ フード追加</button>';
        h += '</div>';
        area.className = '';
        area.innerHTML = h;
      });
  };

  window.deletePresetItem = function (presetId, itemId) {
    fetch(API_BASE + '/feeding/presets/' + presetId + '/items/' + itemId, { method: 'DELETE', headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function () { editPresetItems(presetId); });
  };

  window.addPresetItemPrompt = function (presetId) {
    _pendingPresetId = presetId;
    openAddPlanModal();
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '📋 プリセットにフード追加';
    var submitBtn = document.querySelector('#addPlanModal .btn-primary');
    if (submitBtn) submitBtn.setAttribute('onclick', 'submitPresetItem()');
  };

  var _pendingPresetId = null;

  window.submitPresetItem = function () {
    var foodId = document.getElementById('apFoodId') ? document.getElementById('apFoodId').value : '';
    var slot = document.getElementById('apSlot') ? document.getElementById('apSlot').value : 'morning';
    var amountG = document.getElementById('apAmount') ? parseFloat(document.getElementById('apAmount').value) : 0;
    var time = document.getElementById('apTime') ? document.getElementById('apTime').value : '';
    if (!foodId || !amountG) { alert('フードと量は必須です'); return; }
    fetch(API_BASE + '/feeding/presets/' + _pendingPresetId + '/items', {
      method: 'POST', headers: apiHeaders(),
      body: JSON.stringify({ food_id: foodId, meal_slot: slot, amount_g: amountG, scheduled_time: time || null })
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeAddPlanModal();
      var submitBtn = document.querySelector('#addPlanModal .btn-primary');
      if (submitBtn) submitBtn.setAttribute('onclick', 'submitPlan()');
      editPresetItems(_pendingPresetId);
    }).catch(function () { alert('追加に失敗しました'); });
  };

  // 音声で給餌記録
  window.startFeedingVoice = function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('この端末は音声認識に対応していません'); return; }
    var sr = new SR();
    sr.lang = 'ja-JP';
    sr.interimResults = false;
    sr.onresult = function (e) {
      var text = e.results[0][0].transcript;
      if (confirm('音声入力: 「' + text + '」\nこの内容で記録しますか？')) {
        fetch(API_BASE.replace('/ops', '/ops') + '/voice/submit', {
          method: 'POST', headers: apiHeaders(),
          body: JSON.stringify({ text: text, context: 'feeding', cat_id: catId })
        }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          alert(data.confirm || '記録しました');
          loadFeedingSection();
        }).catch(function () { alert('記録に失敗しました'); });
      }
    };
    sr.onerror = function (e) {
      if (e.error !== 'no-speech') alert('音声認識エラー: ' + e.error);
    };
    sr.start();
  };

  function ensureFoodList(cb) {
    var sel = document.getElementById('apFoodId');
    if (!sel) { cb(); return; }
    if (_feedFoodsList.length > 0) { populateFoodSelect(sel, _feedFoodsList); cb(); return; }
    var sp = (currentCatData && currentCatData.species) || 'cat';
    fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _feedFoodsList = data.foods || [];
        populateFoodSelect(sel, _feedFoodsList);
        cb();
      }).catch(function () { cb(); });
  }

  window.saveMealsPerDay = function () {
    var sel = document.getElementById('mealsPerDaySelect');
    if (!sel) return;
    var val = sel.value ? parseInt(sel.value, 10) : null;
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ meals_per_day: val }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('保存に失敗しました'); });
  };

  window.openFeedingLogModalForEdit = function (logId) {
    var log = null;
    for (var i = 0; i < _feedingLogsCache.length; i++) {
      if (_feedingLogsCache[i].id === logId) { log = _feedingLogsCache[i]; break; }
    }
    if (!log) { alert('ログが見つかりません'); return; }
    _editingLogId = logId;
    var titleEl = document.querySelector('#feedingLogModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 給餌ログを編集';
    if (document.getElementById('flDate')) document.getElementById('flDate').value = log.log_date || new Date().toISOString().slice(0, 10);
    if (document.getElementById('flSlot')) document.getElementById('flSlot').value = log.meal_slot || 'morning';
    if (document.getElementById('flOfferedG')) document.getElementById('flOfferedG').value = log.offered_g != null ? log.offered_g : '';
    if (document.getElementById('flEatenPct')) document.getElementById('flEatenPct').value = log.eaten_pct != null ? log.eaten_pct : '';
    if (document.getElementById('flNote')) document.getElementById('flNote').value = log.note || '';
    document.getElementById('flKcalPreview').style.display = 'none';
    document.getElementById('flFoodInfo').textContent = log.food_name ? log.food_name : '';
    var sel = document.getElementById('flFoodId');
    if (sel && _feedFoodsList.length === 0) {
      var sp = (currentCatData && currentCatData.species) || 'cat';
      fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          _feedFoodsList = data.foods || [];
          populateFoodSelect(sel, _feedFoodsList);
          if (log.food_id) sel.value = log.food_id;
          if (document.getElementById('feedingLogModal')) document.getElementById('feedingLogModal').classList.add('open');
        });
    } else {
      if (sel && _feedFoodsList.length > 0) {
        populateFoodSelect(sel, _feedFoodsList);
        if (log.food_id) sel.value = log.food_id;
      }
      if (document.getElementById('feedingLogModal')) document.getElementById('feedingLogModal').classList.add('open');
    }
  };

  function lifeStageLabel(stage) {
    var labels = { adult: '成猫', kitten: '子猫', senior: 'シニア', diet: 'ダイエット' };
    return labels[stage] || (stage || '成猫');
  }

  function slotLabel(slot) {
    var labels = { morning: '朝', afternoon: '昼', evening: '夕' };
    return labels[slot] || slot;
  }

  // ── 食事メモカード ────────────────────────────────────────────────────────────

  function loadFeedingMemo() {
    if (!feedingMemoArea) return;
    feedingMemoArea.innerHTML = '';
    fetch(API_BASE + '/cat-notes?cat_id=' + encodeURIComponent(catId) + '&category=feeding,nutrition&limit=200', { headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderFeedingMemo(data.notes || []);
      }).catch(function () {
        feedingMemoArea.innerHTML = '';
      });
  }

  function classifyFeedingNote(note) {
    var t = note || '';
    if (t.indexOf('前日残り') === 0) return { tag: '残り', cls: 'fm-leftover' };
    if (t.indexOf('■ご飯指示') === 0) return { tag: '指示', cls: 'fm-instruction' };
    if (t.indexOf('基本量') === 0) return { tag: '基本量', cls: 'fm-amount' };
    if (t.indexOf('カロリー評価') !== -1) return { tag: 'kcal', cls: 'fm-calorie' };
    return { tag: 'メモ', cls: 'fm-other' };
  }

  function renderFeedingMemo(notes) {
    if (!feedingMemoArea) return;
    if (!notes.length) { feedingMemoArea.innerHTML = ''; return; }

    var byDate = {};
    var dates = [];
    for (var i = 0; i < notes.length; i++) {
      var d = (notes[i].created_at || '').slice(0, 10) || '不明';
      if (!byDate[d]) { byDate[d] = []; dates.push(d); }
      byDate[d].push(notes[i]);
    }

    var visibleDays = 3;
    var foldId = 'fmFold';

    var html = '<div class="detail-section">';
    html += '<div class="detail-title">🍽 食事メモ</div>';
    html += '<div style="background:var(--surface);border-radius:8px;padding:8px 10px;">';

    for (var di = 0; di < dates.length; di++) {
      var dt = dates[di];
      var hidden = di >= visibleDays;
      if (hidden && di === visibleDays) {
        html += '<div id="' + foldId + '" style="display:none;">';
      }
      var label = formatShortDate(dt);
      html += '<div style="font-size:11px;color:var(--accent);font-weight:700;margin-top:' + (di === 0 ? '0' : '8px') + ';margin-bottom:2px;">📅 ' + escapeHtml(label) + '</div>';

      var items = byDate[dt];
      for (var ni = 0; ni < items.length; ni++) {
        var n = items[ni];
        var time = (n.created_at || '').slice(11, 16) || '';
        var cls = classifyFeedingNote(n.note);
        html += '<div class="fm-row">';
        if (time) html += '<span class="fm-time">' + time + '</span>';
        html += '<span class="fm-tag ' + cls.cls + '">' + cls.tag + '</span>';
        html += '<span class="fm-body">' + escapeHtml(n.note) + '</span>';
        html += '</div>';
      }
    }

    if (dates.length > visibleDays) {
      html += '</div>';
      html += '<button class="fold-toggle" onclick="toggleFold(\'' + foldId + '\', this)">▼ 過去分を表示（' + (dates.length - visibleDays) + '日分）</button>';
    }

    html += '</div></div>';
    feedingMemoArea.innerHTML = html;
  }

  function formatShortDate(dateStr) {
    if (!dateStr || dateStr.length < 10) return dateStr || '';
    var parts = dateStr.split('-');
    var m = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    var days = ['日', '月', '火', '水', '木', '金', '土'];
    var dt = new Date(dateStr + 'T00:00:00+09:00');
    var dow = days[dt.getDay()] || '';
    return m + '/' + d + '(' + dow + ')';
  }

  // 給餌ログ記録モーダル
  var _feedFoodsList = [];
  var _feedingLogsCache = [];
  var _editingLogId = null;

  window.openFeedingLogModal = function () {
    _editingLogId = null;
    var titleEl = document.querySelector('#feedingLogModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 給餌ログを記録';
    var today = new Date().toISOString().slice(0, 10);
    if (document.getElementById('flDate')) document.getElementById('flDate').value = today;
    document.getElementById('flKcalPreview').style.display = 'none';
    document.getElementById('flFoodInfo').textContent = '';
    document.getElementById('flOfferedG').value = '';
    document.getElementById('flEatenPct').value = '';
    document.getElementById('flNote').value = '';

    var sel = document.getElementById('flFoodId');
    if (sel && _feedFoodsList.length === 0) {
      var sp = (currentCatData && currentCatData.species) || 'cat';
      fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders() })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          _feedFoodsList = data.foods || [];
          populateFoodSelect(sel, _feedFoodsList);
        });
    } else if (sel) {
      sel.value = '';
    }

    if (document.getElementById('feedingLogModal')) {
      document.getElementById('feedingLogModal').classList.add('open');
    }
  };

  function populateFoodSelect(sel, foods) {
    sel.innerHTML = '<option value="">-- 選択 --</option>';
    var typeLabels = { therapeutic: '🏥 療法食', complete: '🍚 総合栄養食', supplement: '🥫 一般食', treat: '🍬 おやつ' };
    var groups = {};
    for (var i = 0; i < foods.length; i++) {
      var ft = foods[i].food_type || 'complete';
      if (!groups[ft]) groups[ft] = [];
      groups[ft].push(foods[i]);
    }
    var order = ['therapeutic', 'complete', 'supplement', 'treat'];
    for (var oi = 0; oi < order.length; oi++) {
      var key = order[oi];
      if (!groups[key] || groups[key].length === 0) continue;
      var grp = document.createElement('optgroup');
      grp.label = typeLabels[key] || key;
      for (var gi = 0; gi < groups[key].length; gi++) {
        var f = groups[key][gi];
        var opt = document.createElement('option');
        opt.value = f.id;
        var formTag = f.form === 'dry' ? '(ﾄﾞﾗｲ)' : f.form === 'wet' ? '(ｳｪｯﾄ)' : f.form === 'liquid' ? '(液状)' : '';
        opt.textContent = f.name + ' ' + formTag;
        grp.appendChild(opt);
      }
      sel.appendChild(grp);
    }
  }

  window.onFoodSelect = function () {
    var foodId = document.getElementById('flFoodId').value;
    var infoEl = document.getElementById('flFoodInfo');
    if (!foodId) { infoEl.textContent = ''; calcFeedingKcal(); return; }
    var food = null;
    for (var i = 0; i < _feedFoodsList.length; i++) {
      if (_feedFoodsList[i].id === foodId) { food = _feedFoodsList[i]; break; }
    }
    if (food) {
      infoEl.textContent = (food.kcal_per_100g ? food.kcal_per_100g + ' kcal/100g' : '') +
        (food.purpose ? '  用途: ' + food.purpose : '');
    }
    calcFeedingKcal();
  };

  window.calcFeedingKcal = function () {
    var foodId = document.getElementById('flFoodId').value;
    var grams = parseFloat(document.getElementById('flOfferedG').value);
    var pct = parseInt(document.getElementById('flEatenPct').value, 10);
    var previewEl = document.getElementById('flKcalPreview');
    if (!foodId || isNaN(grams) || grams <= 0) { previewEl.style.display = 'none'; return; }
    var food = null;
    for (var i = 0; i < _feedFoodsList.length; i++) {
      if (_feedFoodsList[i].id === foodId) { food = _feedFoodsList[i]; break; }
    }
    if (!food || !food.kcal_per_100g) { previewEl.style.display = 'none'; return; }
    var kcal = food.kcal_per_100g * grams / 100;
    var eatenKcal = isNaN(pct) ? kcal : kcal * pct / 100;
    previewEl.textContent = '📊 提供: ' + Math.round(kcal) + ' kcal' +
      (isNaN(pct) ? '' : ' → 摂取: ' + Math.round(eatenKcal) + ' kcal');
    previewEl.style.display = 'block';
  };

  window.closeFeedingLogModal = function () {
    if (document.getElementById('feedingLogModal')) {
      document.getElementById('feedingLogModal').classList.remove('open');
    }
  };

  window.submitFeedingLog = function () {
    var mealSlot = document.getElementById('flSlot').value;
    var offeredG = document.getElementById('flOfferedG').value;
    var eatenPct = document.getElementById('flEatenPct').value;
    var note = document.getElementById('flNote').value.trim();
    var logDate = document.getElementById('flDate').value;
    var foodId = document.getElementById('flFoodId').value;

    if (!mealSlot) { alert('食事区分を選択してください'); return; }

    var kcalCalc = null;
    if (foodId && offeredG) {
      for (var fi = 0; fi < _feedFoodsList.length; fi++) {
        if (_feedFoodsList[fi].id === foodId && _feedFoodsList[fi].kcal_per_100g) {
          kcalCalc = _feedFoodsList[fi].kcal_per_100g * parseFloat(offeredG) / 100;
          if (eatenPct !== '') kcalCalc = kcalCalc * parseInt(eatenPct, 10) / 100;
          kcalCalc = Math.round(kcalCalc);
          break;
        }
      }
    }

    var body = {
      meal_slot: mealSlot,
      food_id: foodId || null,
      offered_g: offeredG ? parseFloat(offeredG) : null,
      eaten_pct: eatenPct !== '' ? parseInt(eatenPct, 10) : null,
      kcal: kcalCalc,
      note: note || null,
    };

    var url = API_BASE + '/feeding/logs';
    var method = 'POST';
    if (_editingLogId) {
      url = API_BASE + '/feeding/logs/' + _editingLogId;
      method = 'PUT';
    } else {
      body.cat_id = catId;
      body.log_date = logDate;
    }

    fetch(url, {
      method: method,
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      _editingLogId = null;
      closeFeedingLogModal();
      loadFeedingSection();
    }).catch(function () {
      alert('給餌ログの保存に失敗しました');
    });
  };

  // ── 体重記録モーダル ─────────────────────────────────────────────────────────

  window.openHealthRecordModal = function () {
    var now = new Date();
    document.getElementById('hrDate').value = now.toISOString().slice(0, 10);
    document.getElementById('hrValue').value = '';
    document.getElementById('healthRecordModal').classList.add('open');
    setTimeout(function () { document.getElementById('hrValue').focus(); }, 100);
  };

  window.closeHealthRecordModal = function () {
    document.getElementById('healthRecordModal').classList.remove('open');
  };

  window.submitHealthRecord = function () {
    var value = document.getElementById('hrValue').value.trim();
    if (!value) { alert('体重を入力してください'); return; }

    var now = new Date();
    var recordDate = now.toISOString().slice(0, 10);
    var recordTime = now.toTimeString().slice(0, 5);

    var body = {
      cat_id: catId,
      record_type: 'weight',
      record_date: recordDate,
      recorded_time: recordTime,
      value: value,
      details: null,
      next_due: null,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeHealthRecordModal();
      loadHealthRecords();
      loadWeightChart();
      loadScoreCard();
      loadFeedingSection();
    }).catch(function () {
      alert('体重の保存に失敗しました');
    });
  };

  // ── 病院記録モーダル ───────────────────────────────────────────────────────────

  var _clearScheduleId = null;

  window.openClinicRecordModal = function (prefillType, prefillDate) {
    _clearScheduleId = null;
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('crDate').value = prefillDate || today;
    document.getElementById('crType').value = prefillType || 'checkup';
    document.getElementById('crContent').value = '';
    document.getElementById('crNextDue').value = '';
    document.getElementById('clinicRecordModal').classList.add('open');
  };

  window.closeClinicRecordModal = function () {
    _clearScheduleId = null;
    document.getElementById('clinicRecordModal').classList.remove('open');
  };

  window.markVetVisited = function (recordId, recordType, scheduledDate) {
    if (!confirm('この予定を受診済みにしますか？')) return;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ next_due: null, value: (scheduledDate || '') + ' 受診済み' }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (data.auto_created && data.auto_created.next_due) {
        var typeLabels = { vaccine: 'ワクチン', checkup: '健康診断' };
        var label = typeLabels[data.auto_created.record_type] || data.auto_created.record_type;
        alert('受診済みにしました\n\n次回の' + label + '予定を自動登録しました:\n📅 ' + data.auto_created.next_due);
      }
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('更新に失敗しました');
    });
  };

  window.deleteClinicRecord = function (recordId) {
    if (!confirm('この病院記録を削除しますか？\nこの操作は取り消せません。')) return;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'DELETE',
      headers: apiHeaders(),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('削除エラー: ' + (data.message || data.error)); return; }
      loadClinicRecords();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.submitClinicRecord = function () {
    var recordType = document.getElementById('crType').value;
    var recordDate = document.getElementById('crDate').value;
    var content = document.getElementById('crContent').value.trim();
    var nextDue = document.getElementById('crNextDue').value || null;

    if (!recordDate) { alert('日付を入力してください'); return; }
    if (!content) { alert('内容を入力してください'); return; }

    var body = {
      cat_id: catId,
      record_type: recordType,
      record_date: recordDate,
      value: content.slice(0, 100),
      details: { note: content },
      next_due: nextDue,
    };

    var scheduleIdToClear = _clearScheduleId;

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (scheduleIdToClear) {
        return fetch(API_BASE + '/health/records/' + scheduleIdToClear, {
          method: 'PUT',
          headers: apiHeaders(),
          body: JSON.stringify({ next_due: null }),
        });
      }
    }).then(function () {
      _clearScheduleId = null;
      closeClinicRecordModal();
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('病院記録の保存に失敗しました');
    });
  };

  // ── 病院予定モーダル ─────────────────────────────────────────────────────────────

  window.openVetScheduleModal = function () {
    document.getElementById('vsType').value = 'checkup';
    document.getElementById('vsDate').value = '';
    document.getElementById('vsMemo').value = '';
    document.getElementById('vetScheduleModal').classList.add('open');
  };

  window.closeVetScheduleModal = function () {
    document.getElementById('vetScheduleModal').classList.remove('open');
  };

  window.submitVetSchedule = function () {
    var schedType = document.getElementById('vsType').value;
    var schedDate = document.getElementById('vsDate').value;
    var memo = document.getElementById('vsMemo').value.trim();

    if (!schedDate) { alert('予定日を入力してください'); return; }

    var typeLabels = { vaccine: 'ワクチン', checkup: '健康診断', surgery: '手術', dental: '歯科', test: '検査', observation: '経過観察' };
    var label = typeLabels[schedType] || schedType;
    var valueSummary = schedDate + ' ' + label + (memo ? '（' + memo.slice(0, 50) + '）' : '');

    var body = {
      cat_id: catId,
      record_type: schedType,
      record_date: new Date().toISOString().slice(0, 10),
      value: valueSummary,
      details: memo ? JSON.stringify({ note: memo }) : null,
      next_due: schedDate,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeVetScheduleModal();
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('予定の登録に失敗しました');
    });
  };

  // ── ロケーション・ステータス編集モーダル ─────────────────────────────────────────

  window.openLocationStatusModal = function () {
    if (!currentCatData) return;
    var locVal = currentCatData.location_id || 'cafe';
    var statusVal = currentCatData.status || 'active';
    if (statusVal === 'in_care' || statusVal === 'cafe') statusVal = 'active';
    document.getElementById('lsLocationId').value = locVal;
    document.getElementById('lsStatus').value = statusVal;
    document.getElementById('locationStatusModal').classList.add('open');
  };

  window.closeLocationStatusModal = function () {
    document.getElementById('locationStatusModal').classList.remove('open');
  };

  window.submitLocationStatus = function () {
    var locationId = document.getElementById('lsLocationId').value;
    var status = document.getElementById('lsStatus').value;
    if (!locationId || !status) { alert('拠点とステータスを選択してください'); return; }

    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ location_id: locationId, status: status }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) {
        alert(data.message || '更新に失敗しました');
        return;
      }
      closeLocationStatusModal();
      currentCatData.location_id = locationId;
      currentCatData.status = status;
      var locLabel = LOCATION_LABELS[locationId] || locationId;
      var statusLabel = STATUS_LABELS[status] || status;
      var locEl = catHeaderArea.querySelector('.cat-header-location');
      if (locEl) {
        locEl.innerHTML = '<span>' + escapeHtml(locLabel) + ' / ' + escapeHtml(statusLabel) + '</span>' +
          '<button type="button" class="btn-edit-loc" onclick="openLocationStatusModal()">編集</button>';
      }
    })
    .catch(function () {
      alert('通信エラーです');
    });
  };

  // ── 名前変更モーダル ─────────────────────────────────────────────────────────

  window.openRenameModal = function () {
    if (!currentCatData) return;
    document.getElementById('renameOldName').textContent = '現在の名前: ' + (currentCatData.name || '');
    document.getElementById('renameNewName').value = currentCatData.name || '';
    document.getElementById('renameModal').classList.add('open');
    setTimeout(function () {
      var inp = document.getElementById('renameNewName');
      inp.focus();
      inp.select();
    }, 100);
  };

  window.closeRenameModal = function () {
    document.getElementById('renameModal').classList.remove('open');
  };

  window.submitRename = function () {
    var newName = document.getElementById('renameNewName').value.trim();
    if (!newName) { alert('名前を入力してください'); return; }
    if (newName === currentCatData.name) { closeRenameModal(); return; }

    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ name: newName }),
    })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) {
        alert(data.message || '名前の変更に失敗しました');
        return;
      }
      closeRenameModal();
      currentCatData.name = newName;
      var nameEl = catHeaderArea.querySelector('.cat-header-name');
      if (nameEl) {
        nameEl.innerHTML = escapeHtml(newName) +
          ' <button type="button" class="btn-edit-loc" onclick="openRenameModal()" style="font-size:13px;">✏️</button>';
      }
      document.title = 'NYAGI ' + newName;
    })
    .catch(function () {
      alert('通信エラーです');
    });
  };

  // ── ケア記録モーダル ───────────────────────────────────────────────────────────

  var careTypesCache = [];

  window.openCareModal = function () {
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('careDate').value = today;
    document.getElementById('careDone').value = '1';
    document.getElementById('careTypeVoice').value = '';
    document.getElementById('careType').value = '';
    if (careTypesCache.length === 0) {
      fetch(API_BASE + '/health/care-types', { headers: apiHeaders() }).then(function (r) { return r.json(); })
        .then(function (data) {
          careTypesCache = data.care_types || [];
          populateCareTypeSelect();
          document.getElementById('careRecordModal').classList.add('open');
        }).catch(function () {
          careTypesCache = [
            { id: 'brush', label: 'ブラシ', record_type: 'care' },
            { id: 'chin', label: 'アゴ', record_type: 'care' },
            { id: 'ear', label: '耳', record_type: 'care' },
            { id: 'nail', label: '爪切り', record_type: 'care' },
            { id: 'paw', label: '肉球', record_type: 'care' },
            { id: 'butt', label: 'お尻', record_type: 'care' },
            { id: 'eye', label: '目ヤニ拭き', record_type: 'eye_discharge' },
          ];
          populateCareTypeSelect();
          document.getElementById('careRecordModal').classList.add('open');
        });
    } else {
      populateCareTypeSelect();
      document.getElementById('careRecordModal').classList.add('open');
    }
  };

  function populateCareTypeSelect() {
    var sel = document.getElementById('careType');
    sel.innerHTML = '<option value="">-- 選択 --</option>';
    for (var i = 0; i < careTypesCache.length; i++) {
      var ct = careTypesCache[i];
      sel.appendChild(new Option(ct.label, ct.record_type + ':' + ct.label));
    }
  }

  window.matchCareTypeFromVoice = function (voiceText) {
    if (!voiceText || !careTypesCache.length) return;
    var t = voiceText.trim().replace(/\s+/g, '');
    for (var i = 0; i < careTypesCache.length; i++) {
      var ct = careTypesCache[i];
      if (ct.label.indexOf(t) !== -1 || t.indexOf(ct.label) !== -1) {
        document.getElementById('careType').value = ct.record_type + ':' + ct.label;
        return;
      }
    }
  };

  window.closeCareModal = function () {
    document.getElementById('careRecordModal').classList.remove('open');
  };

  // ── 排便記録モーダル ───────────────────────────────────────────────────────────

  window.openStoolModal = function () {
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('stoolDate').value = today;
    document.getElementById('stoolStatus').value = '';
    document.getElementById('stoolDetails').value = '';
    document.getElementById('stoolRecordModal').classList.add('open');
  };

  window.closeStoolModal = function () {
    document.getElementById('stoolRecordModal').classList.remove('open');
  };

  window.submitStoolRecord = function () {
    var value = document.getElementById('stoolStatus').value;
    var details = document.getElementById('stoolDetails').value || null;
    var recordDate = document.getElementById('stoolDate').value;

    if (!value) { alert('状態を選択してください'); return; }
    if (!recordDate) { alert('日付を入力してください'); return; }

    var body = {
      cat_id: catId,
      record_type: 'stool',
      record_date: recordDate,
      value: value,
      details: details,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeStoolModal();
      loadStoolSection();
    }).catch(function () {
      alert('排便記録の保存に失敗しました');
    });
  };

  // ── 排尿記録モーダル ───────────────────────────────────────────────────────────

  window.openUrineModal = function () {
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('urineDate').value = today;
    document.getElementById('urineStatus').value = '';
    document.getElementById('urineDetails').value = '';
    document.getElementById('urineRecordModal').classList.add('open');
  };

  window.closeUrineModal = function () {
    document.getElementById('urineRecordModal').classList.remove('open');
  };

  window.submitUrineRecord = function () {
    var value = document.getElementById('urineStatus').value;
    var details = document.getElementById('urineDetails').value || null;
    var recordDate = document.getElementById('urineDate').value;

    if (!value) { alert('状態を選択してください'); return; }
    if (!recordDate) { alert('日付を入力してください'); return; }

    var body = {
      cat_id: catId,
      record_type: 'urine',
      record_date: recordDate,
      value: value,
      details: details,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeUrineModal();
      loadUrineSection();
    }).catch(function () {
      alert('排尿記録の保存に失敗しました');
    });
  };

  window.submitCareRecord = function () {
    var careVal = document.getElementById('careType').value;
    var careDone = document.getElementById('careDone').value === '1';
    var careDate = document.getElementById('careDate').value;

    if (!careVal) { alert('ケア項目を選択してください'); return; }
    if (!careDate) { alert('日付を入力してください'); return; }

    var parts = careVal.split(':');
    var recordType = parts[0] || 'care';
    var details = parts.slice(1).join(':') || '';

    var value = careDone ? '記録' : '×';

    var body = {
      cat_id: catId,
      record_type: recordType,
      record_date: careDate,
      value: value,
      details: details,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeCareModal();
      loadCareSection();
    }).catch(function () {
      alert('ケア記録の保存に失敗しました');
    });
  };

  // ── レンダリングヘルパー ──────────────────────────────────────────────────────

  function renderInfoCell(label, value) {
    return '<div class="info-cell"><div class="info-label">' + escapeHtml(label) + '</div><div class="info-value">' + escapeHtml(value) + '</div></div>';
  }

  // ── ユーティリティ ────────────────────────────────────────────────────────────

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

  function formatDateShort(str) {
    if (!str) return '';
    var parts = String(str).split('-');
    if (parts.length >= 3) return Number(parts[1]) + '/' + Number(parts[2]);
    return str;
  }

  // ── この猫のタスク ──────────────────────────────────────────────────────

  function loadCatTasks() {
    var area = document.getElementById('catTasksArea');
    if (!area) return;
    area.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク</div></div><div class="loading" style="padding:8px;font-size:12px;"><span class="spinner"></span> 読み込み中...</div></div>';

    var today = new Date();
    var y = today.getFullYear();
    var mo = ('0' + (today.getMonth() + 1)).slice(-2);
    var d = ('0' + today.getDate()).slice(-2);
    var dateStr = y + '-' + mo + '-' + d;
    var url = API_BASE + '/tasks?date=' + dateStr + '&cat_id=' + encodeURIComponent(catId);

    fetch(url, { headers: apiHeaders() })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        var tasks = data.tasks || [];
        if (tasks.length === 0) {
          area.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク</div></div><div class="empty-msg" style="font-size:12px;padding:8px;">今日の指定タスクなし</div></div>';
          return;
        }
        var html = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク（' + tasks.length + '件）</div></div>';
        html += '<div style="padding:0 8px 8px;">';
        for (var i = 0; i < tasks.length; i++) {
          var t = tasks[i];
          var isDone = t.status === 'done' || t.status === 'skipped';
          var icon = t.status === 'done' ? '✅' : t.status === 'skipped' ? '⏭️' : '⬜';
          html += '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);' + (isDone ? 'opacity:0.5;' : '') + '">';
          html += '<span style="font-size:14px;">' + icon + '</span>';
          html += '<div style="flex:1;min-width:0;">';
          html += '<div style="font-size:13px;' + (isDone ? 'text-decoration:line-through;' : '') + '">' + escapeHtml(t.title) + '</div>';
          if (t.assigned_name) {
            html += '<div style="font-size:11px;color:var(--text-dim);">担当: ' + escapeHtml(t.assigned_name) + '</div>';
          }
          html += '</div>';
          if (!isDone) {
            html += '<button class="btn btn-sm" style="font-size:11px;padding:2px 8px;" onclick="catTaskDone(' + t.id + ')">完了</button>';
          }
          html += '</div>';
        }
        html += '</div></div>';
        area.innerHTML = html;
      })
      .catch(function () {
        area.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク</div></div><div class="empty-msg" style="font-size:12px;padding:8px;">読み込み失敗</div></div>';
      });
  }

  window.catTaskDone = function (taskId) {
    fetch(API_BASE + '/tasks/' + taskId + '/done', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({}),
    }).then(function (res) {
      if (res.ok) loadCatTasks();
    });
  };

  // ── 猫注意事項（P5.7）──────────────────────────────────────────────────────

  function loadCatNotes() {
    if (!catNotesArea) return;
    catNotesArea.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">📝 注意事項</div><button class="btn-add" onclick="openCatNoteModal()">+ 追加</button></div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    fetch(API_BASE + '/cat-notes?cat_id=' + encodeURIComponent(catId) + '&exclude_categories=feeding,nutrition,medication&limit=30', {
      headers: apiHeaders(),
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderCatNotes(data.notes || []);
    }).catch(function () {
      catNotesArea.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">📝 注意事項</div><button class="btn-add" onclick="openCatNoteModal()">+ 追加</button></div><div class="empty-msg">読み込みに失敗しました</div></div>';
    });
  }

  function renderCatNotes(notes) {
    var internalNote = currentCatData ? (currentCatData.internal_note || '') : '';
    var noteTexts = {};
    for (var i = 0; i < notes.length; i++) {
      noteTexts[(notes[i].note || '').trim()] = true;
    }

    var html = '<div class="detail-section">';
    html += '<div class="section-header"><div class="detail-title">📝 注意事項・メモ</div><button class="btn-add" onclick="openCatNoteModal()">+ 追加</button></div>';

    var hasContent = false;

    if (internalNote && !noteTexts[internalNote.trim()]) {
      hasContent = true;
      html += '<div class="cat-note-item pinned">';
      html += '<span class="cat-note-pin">📋</span>';
      html += '<div class="cat-note-head">';
      html += '<span><span class="cat-note-category general">内部メモ</span></span>';
      html += '</div>';
      html += '<div class="cat-note-body">' + escapeHtml(internalNote) + '</div>';
      html += '</div>';
    }

    for (var i = 0; i < notes.length; i++) {
      hasContent = true;
      var n = notes[i];
      var pinnedClass = n.pinned ? ' pinned' : '';
      html += '<div class="cat-note-item' + pinnedClass + '">';
      if (n.pinned) html += '<span class="cat-note-pin" onclick="togglePin(' + n.id + ', false)" title="ピン解除">📌</span>';
      else html += '<span class="cat-note-pin" onclick="togglePin(' + n.id + ', true)" title="ピン留め">📌</span>';
      html += '<div class="cat-note-head">';
      html += '<span><span class="cat-note-category ' + escapeHtml(n.category || 'general') + '">' + noteCategoryLabel(n.category) + '</span>';
      if (n.staff_name) html += ' ' + escapeHtml(n.staff_name);
      html += '</span>';
      html += '<span>' + formatDate(n.created_at) + '</span>';
      html += '</div>';
      html += '<div class="cat-note-body">' + escapeHtml(n.note) + '</div>';
      html += '</div>';
    }

    if (!hasContent) {
      html += '<div class="empty-msg">まだ注意事項はありません</div>';
    }
    html += '</div>';
    catNotesArea.innerHTML = html;
  }

  function noteCategoryLabel(cat) {
    var labels = {
      general: '一般', health: '健康', behavior: '行動',
      feeding: '食事', medication: '投薬', task: 'タスク', warning: '警告',
    };
    return labels[cat] || cat || '一般';
  }

  window.openCatNoteModal = function () {
    document.getElementById('cnNote').value = '';
    document.getElementById('cnCategory').value = 'general';
    document.getElementById('cnPinned').checked = false;
    document.getElementById('catNoteModal').classList.add('open');
  };

  window.closeCatNoteModal = function () {
    document.getElementById('catNoteModal').classList.remove('open');
  };

  window.submitCatNote = function () {
    var note = document.getElementById('cnNote').value.trim();
    if (!note) { alert('内容を入力してください'); return; }

    fetch(API_BASE + '/cat-notes', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        cat_id: catId,
        note: note,
        category: document.getElementById('cnCategory').value,
        pinned: document.getElementById('cnPinned').checked,
      }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeCatNoteModal();
      loadCatNotes();
    }).catch(function () {
      alert('保存に失敗しました');
    });
  };

  window.togglePin = function (noteId, pinned) {
    fetch(API_BASE + '/cat-notes/' + noteId, {
      method: 'PUT',
      headers: apiHeaders(),
      body: JSON.stringify({ pinned: pinned }),
    }).then(function (r) { return r.json(); })
    .then(function () { loadCatNotes(); })
    .catch(function () { alert('更新に失敗しました'); });
  };

  // ── 音声入力後の自動リロード ─────────────────────────────────────────────────

  window.nyagiOnVoiceSuccess = function (data) {
    if (!data || !data.parsed) return;
    var mod = data.parsed.module;
    try {
      if (mod === 'weight') { loadWeightChart(); loadCalorieSection(); }
      if (mod === 'stool') { loadStoolSection(); }
      if (mod === 'health' || mod === 'vomiting' || mod === 'behavior') { loadCareSection(); loadHealthRecords(); loadClinicRecords(); }
      if (mod === 'feeding') { loadFeedingSection(); loadFeedingMemo(); }
      if (mod === 'medication') { loadMedicationSchedule(); }
    } catch (_) {}
  };

  // ── インライン音声入力ヘルパー ───────────────────────────────────────────────

  var _inlineSR = null;
  var _inlineTarget = null;

  window.startInlineVoice = function (targetInputId) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert('この端末は音声認識に対応していません'); return; }

    if (_inlineSR) { try { _inlineSR.abort(); } catch (_) {} }

    var target = document.getElementById(targetInputId);
    if (!target) return;
    _inlineTarget = target;

    var btn = document.querySelector('[data-voice-for="' + targetInputId + '"]');
    if (btn) { btn.classList.add('recording'); btn.textContent = '⏹'; }

    _inlineSR = new SR();
    _inlineSR.lang = 'ja-JP';
    _inlineSR.continuous = false;
    _inlineSR.interimResults = false;

    _inlineSR.onresult = function (event) {
      var text = '';
      for (var i = 0; i < event.results.length; i++) {
        if (event.results[i].isFinal) text += event.results[i][0].transcript;
      }
      if (text && _inlineTarget) {
        if (_inlineTarget.tagName === 'TEXTAREA') {
          _inlineTarget.value = _inlineTarget.value ? _inlineTarget.value + ' ' + text : text;
        } else {
          _inlineTarget.value = text;
        }
        _inlineTarget.dispatchEvent(new Event('input'));
      }
    };

    _inlineSR.onend = function () {
      if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; }
      _inlineSR = null;
    };

    _inlineSR.onerror = function () {
      if (btn) { btn.classList.remove('recording'); btn.textContent = '🎤'; }
      _inlineSR = null;
    };

    _inlineSR.start();
  };

  window.stopInlineVoice = function () {
    if (_inlineSR) { try { _inlineSR.abort(); } catch (_) {} _inlineSR = null; }
  };

})();
