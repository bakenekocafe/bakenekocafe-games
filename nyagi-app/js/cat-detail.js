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
      var status = r.value || '—';
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
      var status = r.value || '—';
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
    html += '<button class="btn-add" onclick="openClinicRecordModal()">+ 追加</button>';
    html += '</div>';

    if (records.length === 0) {
      html += '<div class="empty-msg">記録なし</div>';
    } else {
      var typeLabels = { vaccine: 'ワクチン', checkup: '健診', surgery: '手術', dental: '歯科', emergency: '緊急', test: '検査', observation: '経過観察' };
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        var typeLabel = typeLabels[r.record_type] || r.record_type;
        var badgeClass = 'hr-type-badge' + (r.record_type === 'emergency' ? ' emergency' : r.record_type === 'vaccine' ? ' vaccine' : '');
        html += '<div class="health-record-item">';
        html += '<div class="hr-head">';
        html += '<span><span class="' + badgeClass + '">' + escapeHtml(typeLabel) + '</span>' + escapeHtml(formatDateShort(r.record_date)) + '</span>';
        html += '<span style="font-size:11px;color:var(--text-dim);">' + escapeHtml(r.recorded_by || '') + '</span>';
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
      ]).then(function (results) {
        var calcData = results[0];
        renderCalorieCard(calcData);
        renderFeedingSection(calcData, results[1].logs || [], today);
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
      var covPct = calc.coverage_pct || 0;
      var covColor = covPct >= 90 ? '#4ade80' : covPct >= 70 ? '#facc15' : '#f87171';
      var barPct = Math.min(covPct, 100);
      html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px;">';
      html += '<span style="color:var(--text-dim);">1日の必要カロリー</span>';
      html += '<b style="color:var(--text-main);">' + calc.required_kcal + ' kcal</b>';
      html += '</div>';
      html += '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:8px;">';
      html += '<span style="color:var(--text-dim);">プラン合計</span>';
      html += '<b style="color:' + covColor + ';">' + (calc.plan_total_kcal || 0) + ' kcal (' + covPct + '%)</b>';
      html += '</div>';
      html += '<div style="background:var(--surface-alt);border-radius:4px;height:6px;">';
      html += '<div style="background:' + covColor + ';width:' + barPct + '%;height:100%;border-radius:4px;"></div>';
      html += '</div>';
      html += '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;">' + escapeHtml(lifeStageLabel(calc.life_stage)) + '</div>';
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
      html += '<div style="font-size:11px;font-weight:700;color:var(--accent);margin-bottom:4px;">💡 追加提案（不足 ' + sug.deficit_kcal + ' kcal）</div>';
      for (var si = 0; si < sug.items.length; si++) {
        var item = sug.items[si];
        var formIcon = item.form === 'wet' || item.form === 'liquid' ? '🥫' : '🥣';
        html += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;">';
        html += '<span>' + formIcon + ' ' + escapeHtml(item.food_name) + '</span>';
        html += '<span style="color:var(--text-dim);">' + item.amount_g + 'g (' + item.kcal + 'kcal)</span>';
        html += '</div>';
      }
      var newTotal = (calc.plan_total_kcal || 0) + sug.suggested_total_kcal;
      var newCov = calc.required_kcal ? Math.round(newTotal / calc.required_kcal * 100) : 0;
      html += '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;text-align:right;">提案込み: ' + newTotal + ' kcal (' + newCov + '%)</div>';
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

  function renderFeedingSection(calc, logs, today) {
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">🍽 給餌プラン</div>';
    html += '<button class="btn-add" onclick="openFeedingLogModal()">+ 記録</button>';
    html += '</div>';

    if (calc && !calc.error) {
      var plans = calc.plans || [];
      if (plans.length === 0) {
        html += '<div class="empty-msg">給餌プランなし</div>';
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
          html += '<div style="display:flex;justify-content:space-between;margin-bottom:4px;">';
          html += '<b style="font-size:12px;color:var(--accent);">' + escapeHtml(slotLabel(sKey)) + '</b>';
          html += '<span style="font-size:11px;color:var(--text-dim);">計 ' + Math.round(slot.totalG) + 'g / ' + Math.round(slot.totalKcal) + 'kcal</span>';
          html += '</div>';
          for (var ii = 0; ii < slot.items.length; ii++) {
            var p = slot.items[ii];
            html += '<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;">';
            html += '<span>' + escapeHtml(p.food_name || '') + '</span>';
            html += '<span style="color:var(--text-dim);">' + p.amount_g + 'g (' + Math.round(p.kcal_calc || 0) + 'kcal)</span>';
            html += '</div>';
          }
          if (slot.items[0] && slot.items[0].notes) {
            html += '<div style="font-size:10px;color:var(--text-dim);margin-top:2px;">📝 ' + escapeHtml(slot.items[0].notes) + '</div>';
          }
          html += '</div>';
        }
        html += '<div style="display:flex;justify-content:space-between;font-size:12px;font-weight:700;padding:4px 12px;color:var(--text-main);">';
        html += '<span>朝夕合計</span>';
        html += '<span>' + Math.round(grandG) + 'g / ' + Math.round(grandKcal) + 'kcal</span>';
        html += '</div>';
      }
    }

    // 今日の給餌ログ
    html += '<div style="margin-top:12px;font-size:13px;font-weight:700;padding:4px 0;border-top:1px solid var(--surface-alt);">今日の給餌ログ</div>';
    if (logs.length === 0) {
      html += '<div class="empty-msg">ログなし</div>';
    } else {
      for (var i = 0; i < logs.length; i++) {
        var l = logs[i];
        html += '<div class="feeding-log-row" style="background:var(--surface);border-radius:8px;padding:8px 12px;margin-top:6px;display:flex;justify-content:space-between;align-items:center;">';
        html += '<span style="font-size:13px;">' + escapeHtml(slotLabel(l.meal_slot)) + ': ';
        if (l.food_name) html += escapeHtml(l.food_name) + ' ';
        if (l.offered_g) html += l.offered_g + 'g あげた';
        html += '</span>';
        html += '<span style="display:flex;align-items:center;gap:8px;">';
        if (l.eaten_pct !== null && l.eaten_pct !== undefined) {
          var eatColor = l.eaten_pct >= 80 ? '#4ade80' : l.eaten_pct >= 50 ? '#facc15' : '#f87171';
          html += '<span style="font-size:12px;color:' + eatColor + ';">' + l.eaten_pct + '% 食べた</span>';
        } else {
          html += '<span style="font-size:12px;color:var(--text-dim);">食べた量: 未記録</span>';
        }
        html += '<button type="button" class="btn-edit-small" onclick="openFeedingLogModalForEdit(' + l.id + ')" title="編集">✏️</button>';
        html += '</span></div>';
      }
    }

    html += '</div>';
    feedingArea.innerHTML = html;
    _feedingLogsCache = logs;
  }

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

  window.openClinicRecordModal = function () {
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('crDate').value = today;
    document.getElementById('crType').value = 'checkup';
    document.getElementById('crContent').value = '';
    document.getElementById('crNextDue').value = '';
    document.getElementById('clinicRecordModal').classList.add('open');
  };

  window.closeClinicRecordModal = function () {
    document.getElementById('clinicRecordModal').classList.remove('open');
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

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeClinicRecordModal();
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('病院記録の保存に失敗しました');
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
