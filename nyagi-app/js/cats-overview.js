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

  function apiOpsBase() {
    var o = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
    return o + '/api/ops';
  }

  /** JST の YYYY-MM-DD */
  function todayJstYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** JST の HH:mm */
  function nowJstHm() {
    return new Date().toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  }

  /** feeding_logs.served_time を表示用 HH:mm に */
  function ovFmtFedServedTime(raw) {
    if (raw == null || raw === '') return '';
    var s = String(raw).trim();
    if (s.length >= 16 && s.indexOf('T') !== -1) return s.slice(11, 16);
    var p = s.split(':');
    if (p.length >= 2) {
      var h = parseInt(p[0], 10);
      var mi = parseInt(p[1], 10);
      if (!isNaN(h) && !isNaN(mi) && h >= 0 && h <= 23 && mi >= 0 && mi <= 59) {
        return (h < 10 ? '0' : '') + h + ':' + (mi < 10 ? '0' : '') + mi;
      }
    }
    return '';
  }

  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }

  /** YYYY-MM-DD → 表示用 M/D */
  function fmtExcretionMdYmd(ymd) {
    if (!ymd || ymd.length < 10) return '';
    var m = parseInt(ymd.slice(5, 7), 10);
    var d = parseInt(ymd.slice(8, 10), 10);
    if (isNaN(m) || isNaN(d)) return ymd.slice(5);
    return m + '/' + d;
  }

  /** 項目ごと 排便・排尿 1行分の表示（日付＋帯/時刻＋状態） */
  function ovExcretionLineText(e) {
    var parts = [];
    var md = fmtExcretionMdYmd(e.record_date);
    if (md) parts.push(md);
    var t = e.time != null ? String(e.time).trim() : '';
    if (t) parts.push(t);
    if (e.status) parts.push(e.status);
    return parts.join(' ');
  }

  /** cat.html モーダルと同じ value（排便・排尿） */
  var OPT_STOOL_STATUS = '<option value="">状態</option><option value="健康">健康</option><option value="硬い">硬い</option><option value="軟便">軟便</option><option value="下痢">下痢</option><option value="血便小">血便小</option><option value="血便大（異常）">血便大（異常）</option>';
  var OPT_URINE_STATUS = '<option value="">状態</option><option value="なし（異常）">なし（異常）</option><option value="なし">なし</option><option value="少量">少量</option><option value="普通">普通</option><option value="多い">多い</option><option value="血尿小">血尿小</option><option value="血尿大（異常）">血尿大（異常）</option>';
  var OPT_SLOT = '<option value="">帯</option><option value="朝">朝</option><option value="昼">昼</option><option value="夜">夜</option><option value="途中">途中</option>';
  var OPT_CARE_TYPE = '<option value="">項目</option><option value="care:ブラシ">ブラシ</option><option value="care:アゴ">アゴ</option><option value="care:耳">耳</option><option value="care:爪切り">爪切り</option><option value="care:肉球">肉球</option><option value="care:お尻">お尻</option><option value="eye_discharge:目ヤニ拭き">目ヤニ拭き</option>';
  var OPT_CARE_DONE = '<option value="1">実施</option><option value="0">スキップ</option>';

  /** DB英語キー → フォーム選択肢（日本語） */
  var STOOL_EN_TO_JA = { normal: '健康', hard: '硬い', soft: '軟便', liquid: '下痢', recorded: '記録あり' };
  var URINE_EN_TO_JA = { normal: '普通', hard: '多い', soft: '少量', liquid: 'なし（異常）', recorded: '記録あり' };

  function excretionFormValue(kind, raw) {
    var s = raw == null ? '' : String(raw);
    if (kind === 'urine') return URINE_EN_TO_JA[s] || s;
    return STOOL_EN_TO_JA[s] || s;
  }

  var _ovInlineHandlersBound = false;

  var NYAGI_PRESET_LOC_KEY = 'nyagi_feeding_preset_location';
  var _ovFeedCtx = null;
  var _ovFoodsCache = null;
  var _ovFoodsSpecies = null;
  var _ovEditingPlanId = null;
  var _ovPresetItemsCache = null;
  var _ovPendingPresetItem = null;

  function feedingApiBase() {
    return apiOpsBase() + '/feeding';
  }

  function ovGetStoredPresetLocation() {
    try {
      var v = localStorage.getItem(NYAGI_PRESET_LOC_KEY);
      if (v === 'cafe' || v === 'nekomata') return v;
    } catch (_) {}
    return 'cafe';
  }

  function ovSetStoredPresetLocation(loc) {
    if (loc !== 'cafe' && loc !== 'nekomata') return;
    try { localStorage.setItem(NYAGI_PRESET_LOC_KEY, loc); } catch (_) {}
  }

  function ovEffectivePresetLoc(c) {
    if (c && (c.location_id === 'cafe' || c.location_id === 'nekomata')) return c.location_id;
    return ovGetStoredPresetLocation();
  }

  function ovFeedingPresetsListUrl(sp, loc) {
    var u = feedingApiBase() + '/presets?species=' + encodeURIComponent(sp || 'cat');
    if (loc === 'cafe' || loc === 'nekomata') u += '&location_id=' + encodeURIComponent(loc);
    return u;
  }

  function ovPresetLocShortLabel(loc) {
    return loc === 'nekomata' ? '猫又療養所' : 'BAKENEKO CAFE';
  }

  function ovPresetLocationBadgeHtml(loc) {
    var L = loc === 'nekomata' ? 'nekomata' : 'cafe';
    var bg = L === 'nekomata' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.12)';
    var c = L === 'nekomata' ? '#f87171' : '#fbbf24';
    return '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:' + bg + ';color:' + c + ';font-weight:600;">' + esc(ovPresetLocShortLabel(L)) + '</span>';
  }

  function ovFeedingPresetAlphaSectionHtml(tabLoc, ps, lastLabelRef) {
    if (tabLoc !== 'cafe' || !ps || !ps.alpha_bucket_label) return '';
    var lab = ps.alpha_bucket_label;
    if (lastLabelRef.v === lab) return '';
    lastLabelRef.v = lab;
    return '<div style="font-size:11px;font-weight:700;color:var(--text-dim);margin:12px 0 6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);">' + esc(lab) + '</div>';
  }

  function ovRenderPresetLocationSwitcher(activeLoc, context) {
    var aCafe = activeLoc === 'cafe' ? 'background:rgba(251,191,36,0.25);border-color:rgba(251,191,36,0.55);color:#fbbf24;font-weight:700;' : 'background:var(--surface);border-color:rgba(255,255,255,0.12);color:var(--text-dim);';
    var aNeko = activeLoc === 'nekomata' ? 'background:rgba(248,113,113,0.18);border-color:rgba(248,113,113,0.45);color:#f87171;font-weight:700;' : 'background:var(--surface);border-color:rgba(255,255,255,0.12);color:var(--text-dim);';
    var h = '<div style="font-size:11px;color:var(--text-dim);margin:0 0 8px;font-weight:600;">🏷 表示拠点</div>';
    h += '<div style="display:flex;gap:8px;margin-bottom:14px;">';
    h += '<button type="button" class="btn" style="flex:1;padding:10px 6px;font-size:11px;border:2px solid;border-radius:8px;' + aCafe + '" data-ov-preset-loc="cafe" data-ov-preset-ctx="' + escAttr(context) + '">🐱 CAFE</button>';
    h += '<button type="button" class="btn" style="flex:1;padding:10px 6px;font-size:11px;border:2px solid;border-radius:8px;' + aNeko + '" data-ov-preset-loc="nekomata" data-ov-preset-ctx="' + escAttr(context) + '">🏥 猫又</button>';
    h += '</div>';
    return h;
  }

  function ovRenderPresetItemsSummary(items, totalKcal) {
    var morn = [];
    var eve = [];
    var other = [];
    for (var i = 0; i < (items || []).length; i++) {
      if (items[i].meal_slot === 'evening') eve.push(items[i]);
      else if (items[i].meal_slot === 'morning' || items[i].meal_slot === 'afternoon') morn.push(items[i]);
      else other.push(items[i]);
    }
    var h = '<div style="margin-top:4px;">';
    function block(title, arr) {
      if (arr.length === 0) return '';
      var x = '<div style="font-size:10px;color:var(--accent,#fb923c);font-weight:600;margin-top:2px;">' + esc(title) + '</div>';
      for (var m = 0; m < arr.length; m++) {
        x += '<div style="font-size:11px;color:var(--text-dim);padding:1px 0 1px 10px;">' + esc(arr[m].food_name || '') + ' ' + arr[m].amount_g + 'g</div>';
      }
      return x;
    }
    h += block('☀ 朝/昼', morn);
    h += block('🌙 夕', eve);
    h += block('その他', other);
    if (!items || items.length === 0) h += '<div style="font-size:11px;color:var(--text-dim);">未登録</div>';
    if (totalKcal) h += '<div style="font-size:11px;color:var(--accent,#fb923c);margin-top:2px;">計 ' + totalKcal + ' kcal</div>';
    h += '</div>';
    return h;
  }

  function ovFindCat(catId) {
    for (var i = 0; i < catsData.length; i++) {
      if (String(catsData[i].id) === String(catId)) return catsData[i];
    }
    return null;
  }

  function ovClosePresetModal() {
    var m = document.getElementById('ovPresetApplyModal');
    if (m) m.classList.remove('open');
  }

  function ovCloseAddPlanModal() {
    _ovEditingPlanId = null;
    _ovPendingPresetItem = null;
    var m = document.getElementById('ovAddPlanModal');
    if (m) m.classList.remove('open');
  }

  function ovCloseFlModal() {
    var m = document.getElementById('ovFeedingLogModal');
    if (m) m.classList.remove('open');
  }

  function ovFillPresetApplyModal(loc) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    var sp = _ovFeedCtx.species || 'cat';
    ovSetStoredPresetLocation(loc);
    fetch(ovFeedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var innerHtml = '<div class="modal-box" style="max-height:80vh;overflow-y:auto;">';
        innerHtml += '<div class="modal-title">📋 プリセット適用 <small class="dim">' + esc(_ovFeedCtx.name) + '</small></div>';
        innerHtml += '<div style="margin:0 0 10px;text-align:center;"><button type="button" class="btn btn-outline" style="font-size:12px;width:100%;" data-ov-open-preset-manage="1">⚙️ プリセット管理</button></div>';
        innerHtml += ovRenderPresetLocationSwitcher(loc, 'apply');
        if (presets.length === 0) {
          innerHtml += '<div class="empty-msg">この拠点のプリセットがありません。</div>';
        } else {
          var lastAlphaOvApply = { v: null };
          for (var i = 0; i < presets.length; i++) {
            var ps = presets[i];
            innerHtml += ovFeedingPresetAlphaSectionHtml(loc, ps, lastAlphaOvApply);
            innerHtml += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
            innerHtml += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">';
            innerHtml += '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' + ovPresetLocationBadgeHtml(ps.location_id) + '<b style="font-size:13px;">' + esc(ps.name) + '</b></div>';
            if (ps.description) innerHtml += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">' + esc(ps.description) + '</div>';
            innerHtml += ovRenderPresetItemsSummary(ps.items || [], ps.total_kcal);
            innerHtml += '</div>';
            innerHtml += '<button type="button" class="btn btn-primary" style="font-size:11px;padding:4px 10px;flex-shrink:0;" data-ov-apply-preset="' + escAttr(String(ps.id)) + '">適用</button>';
            innerHtml += '</div></div>';
          }
        }
        innerHtml += '<div class="modal-actions"><button type="button" class="btn btn-outline" data-ov-close-preset="1">閉じる</button></div></div>';
        modal.innerHTML = innerHtml;
      }).catch(function () { alert('プリセットの読み込みに失敗しました'); ovClosePresetModal(); });
  }

  function ovFillPresetAssignModal(loc) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    var sp = _ovFeedCtx.species || 'cat';
    ovSetStoredPresetLocation(loc);
    fetch(ovFeedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var currentId = _ovFeedCtx.assignedPresetId;
        var curNum = currentId != null ? Number(currentId) : null;
        var innerHtml = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;">';
        innerHtml += '<div class="modal-title">🔗 プリセット紐づけ <small class="dim">' + esc(_ovFeedCtx.name) + '</small></div>';
        innerHtml += '<p style="font-size:12px;color:var(--text-dim);margin:0 0 10px;">業務終了時の自動再適用に使われます。</p>';
        innerHtml += ovRenderPresetLocationSwitcher(loc, 'assign');
        innerHtml += '<div style="margin-bottom:8px;">';
        innerHtml += '<div style="cursor:pointer;padding:10px 12px;border-radius:8px;margin-bottom:4px;background:' + (!curNum ? 'rgba(168,139,250,0.15)' : 'var(--surface)') + ';border:1px solid rgba(255,255,255,0.12);" data-ov-assign-preset="none">';
        innerHtml += '<div style="font-size:13px;font-weight:600;">紐づけ解除（なし）</div></div>';
        var lastAlphaOvAssign = { v: null };
        for (var i = 0; i < presets.length; i++) {
          var ps = presets[i];
          innerHtml += ovFeedingPresetAlphaSectionHtml(loc, ps, lastAlphaOvAssign);
          var isActive = curNum != null && !isNaN(curNum) && curNum === Number(ps.id);
          innerHtml += '<div style="cursor:pointer;padding:10px 12px;border-radius:8px;margin-bottom:4px;background:' + (isActive ? 'rgba(168,139,250,0.15)' : 'var(--surface)') + ';border:1px solid rgba(255,255,255,0.12);" data-ov-assign-preset="' + escAttr(String(ps.id)) + '">';
          innerHtml += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">';
          innerHtml += '<div style="display:flex;align-items:center;gap:6px;">' + ovPresetLocationBadgeHtml(ps.location_id) + '<b style="font-size:13px;">' + esc(ps.name) + '</b></div>';
          if (isActive) innerHtml += '<span style="font-size:11px;color:var(--primary,#a78bfa);font-weight:600;">✔ 現在</span>';
          innerHtml += '</div>';
          innerHtml += ovRenderPresetItemsSummary(ps.items || [], ps.total_kcal);
          innerHtml += '</div>';
        }
        innerHtml += '</div><div class="modal-actions"><button type="button" class="btn btn-outline" data-ov-close-preset="1">閉じる</button></div></div>';
        modal.innerHTML = innerHtml;
      }).catch(function () { alert('プリセットの読み込みに失敗しました'); ovClosePresetModal(); });
  }

  function ovFillPresetManageModal(loc) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    var sp = _ovFeedCtx.species || 'cat';
    ovSetStoredPresetLocation(loc);
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">⚙️ プリセット管理</div><div id="ovPresetManageContent" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button type="button" class="btn btn-outline" data-ov-close-preset="1">閉じる</button></div></div>';
    var area = document.getElementById('ovPresetManageContent');
    fetch(ovFeedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var h = ovRenderPresetLocationSwitcher(loc, 'manage');
        h += '<p style="font-size:11px;color:var(--text-dim);margin:0 0 10px;">拠点タブで切替後、<b>+ 新規</b>でその拠点用に作成します。</p>';
        h += '<button type="button" class="btn btn-primary" style="font-size:12px;margin-bottom:12px;width:100%;" data-ov-create-preset="1">+ 新規プリセット（' + esc(ovPresetLocShortLabel(loc)) + '）</button>';
        if (presets.length === 0) {
          h += '<div class="empty-msg">プリセットがありません</div>';
        }
        var lastAlphaOvManage = { v: null };
        for (var i = 0; i < presets.length; i++) {
          var ps = presets[i];
          h += ovFeedingPresetAlphaSectionHtml(loc, ps, lastAlphaOvManage);
          var ploc = ps.location_id === 'nekomata' ? 'nekomata' : 'cafe';
          h += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
          h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">';
          h += '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;">' + ovPresetLocationBadgeHtml(ps.location_id) + '<b>' + esc(ps.name) + '</b></div>';
          h += '<div style="font-size:11px;color:var(--text-dim);">' + (ps.items || []).length + '品</div></div>';
          h += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">';
          h += '<button type="button" class="btn-edit-small" style="font-size:10px;" data-ov-cycle-preset-loc="' + escAttr(String(ps.id)) + '" data-ov-cycle-cur="' + escAttr(ploc) + '">🏷 拠点切替</button>';
          h += '<div><button type="button" class="btn-edit-small" data-ov-rename-preset="' + escAttr(String(ps.id)) + '" data-ov-rename-name="' + escAttr(ps.name) + '">📝</button> ';
          h += '<button type="button" class="btn-edit-small" data-ov-edit-preset-items="' + escAttr(String(ps.id)) + '">✏️</button> ';
          h += '<button type="button" class="btn-edit-small" style="color:#f87171;" data-ov-delete-preset="' + escAttr(String(ps.id)) + '">🗑</button></div></div></div></div>';
        }
        if (area) { area.className = ''; area.innerHTML = h; }
      }).catch(function () {
        if (area) { area.className = ''; area.innerHTML = '<div class="empty-msg">読み込み失敗</div>'; }
      });
  }

  function ovOpenPresetApply(catId) {
    var c = ovFindCat(catId);
    if (!c) return;
    _ovFeedCtx = {
      catId: c.id,
      name: c.name,
      species: c.species || 'cat',
      locationId: c.location_id,
      assignedPresetId: null,
    };
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box"><div class="loading" style="padding:16px;">読み込み中...</div></div>';
    modal.classList.add('open');
    ovFillPresetApplyModal(ovEffectivePresetLoc(c));
  }

  function ovOpenPresetAssign(catId) {
    var c = ovFindCat(catId);
    if (!c) return;
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box"><div class="loading" style="padding:16px;">読み込み中...</div></div>';
    modal.classList.add('open');
    fetch(apiOpsBase() + '/cats/' + encodeURIComponent(catId), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var apid = null;
        if (d.cat && d.cat.assigned_preset_id != null && d.cat.assigned_preset_id !== '') {
          apid = d.cat.assigned_preset_id;
        }
        _ovFeedCtx = {
          catId: c.id,
          name: c.name,
          species: (d.cat && d.cat.species) || c.species || 'cat',
          locationId: c.location_id,
          assignedPresetId: apid,
        };
        ovFillPresetAssignModal(ovEffectivePresetLoc(c));
      })
      .catch(function () {
        _ovFeedCtx = {
          catId: c.id,
          name: c.name,
          species: c.species || 'cat',
          locationId: c.location_id,
          assignedPresetId: null,
        };
        ovFillPresetAssignModal(ovEffectivePresetLoc(c));
      });
  }

  function ovOpenPresetManage(catId) {
    var c = ovFindCat(catId);
    if (!c) return;
    _ovFeedCtx = {
      catId: c.id,
      name: c.name,
      species: c.species || 'cat',
      locationId: c.location_id,
      assignedPresetId: null,
    };
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal) return;
    modal.classList.add('open');
    ovFillPresetManageModal(ovGetStoredPresetLocation());
  }

  function ovEnsureFoods(cb) {
    var sp = (_ovFeedCtx && _ovFeedCtx.species) || 'cat';
    if (_ovFoodsCache && _ovFoodsCache.length && _ovFoodsSpecies === sp) {
      cb(_ovFoodsCache);
      return;
    }
    fetch(feedingApiBase() + '/foods?species=' + encodeURIComponent(sp), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        _ovFoodsCache = d.foods || [];
        _ovFoodsSpecies = sp;
        cb(_ovFoodsCache);
      }).catch(function () { alert('フード一覧の取得に失敗しました'); cb([]); });
  }

  function ovFillFoodSelect(selId, after) {
    ovEnsureFoods(function (foods) {
      var sel = document.getElementById(selId);
      if (!sel) return;
      var cur = sel.value;
      sel.innerHTML = '<option value="">-- 選択 --</option>';
      for (var i = 0; i < foods.length; i++) {
        var f = foods[i];
        var o = document.createElement('option');
        o.value = f.id;
        o.textContent = (f.brand ? f.brand + ' ' : '') + (f.name || f.id);
        sel.appendChild(o);
      }
      if (cur) sel.value = cur;
      if (typeof after === 'function') after(sel);
    });
  }

  function ovOpenAddPlanModal(catId, defaultSlot, editPlanId, opts) {
    opts = opts || {};
    var c = ovFindCat(catId);
    if (!c) return;
    _ovFeedCtx = {
      catId: c.id,
      name: c.name,
      species: c.species || 'cat',
      locationId: c.location_id,
      assignedPresetId: c.assigned_preset_id,
    };
    _ovEditingPlanId = editPlanId || null;
    if (!opts.preservePendingPreset) _ovPendingPresetItem = null;
    var title = document.querySelector('#ovAddPlanModal .modal-title');
    if (title) title.innerHTML = (_ovEditingPlanId ? '🍽 プランを編集' : '🍽 プランを追加') + ' <span class="dim" style="font-size:12px;">' + esc(c.name) + '</span>';
    var slotSel = document.getElementById('ovApSlot');
    if (slotSel) slotSel.value = defaultSlot || 'morning';
    if (document.getElementById('ovApAmount')) document.getElementById('ovApAmount').value = '';
    if (document.getElementById('ovApNotes')) document.getElementById('ovApNotes').value = '';
    var editP = null;
    if (_ovEditingPlanId) {
      for (var ii = 0; ii < (c.feeding_plan || []).length; ii++) {
        if (String((c.feeding_plan[ii] || {}).plan_id) === String(_ovEditingPlanId)) {
          editP = c.feeding_plan[ii];
          break;
        }
      }
    }
    if (editP) {
      if (slotSel) slotSel.value = editP.meal_slot || 'morning';
      if (document.getElementById('ovApAmount')) document.getElementById('ovApAmount').value = editP.amount_g != null ? String(editP.amount_g) : '';
      if (document.getElementById('ovApNotes')) document.getElementById('ovApNotes').value = editP.notes || '';
    }
    ovFillFoodSelect('ovApFoodId', function (sel) {
      if (editP && editP.food_id && sel) sel.value = String(editP.food_id);
    });
    var m = document.getElementById('ovAddPlanModal');
    if (m) m.classList.add('open');
  }

  function ovOpenFeedingLogModal(catId, presetSlot) {
    var c = ovFindCat(catId);
    if (!c) return;
    _ovFeedCtx = {
      catId: c.id,
      name: c.name,
      species: c.species || 'cat',
      locationId: c.location_id,
      assignedPresetId: c.assigned_preset_id,
    };
    var dt = document.getElementById('ovFlDate');
    if (dt) dt.value = todayJstYmd();
    var sl = document.getElementById('ovFlSlot');
    if (sl) sl.value = presetSlot || 'morning';
    if (document.getElementById('ovFlOfferedG')) document.getElementById('ovFlOfferedG').value = '';
    if (document.getElementById('ovFlEatenPct')) document.getElementById('ovFlEatenPct').value = '100';
    var flst = document.getElementById('ovFlServedTime');
    if (flst) flst.value = nowJstHm();
    ovFillFoodSelect('ovFlFoodId');
    var t = document.querySelector('#ovFeedingLogModal .modal-title');
    if (t) t.innerHTML = '🍽 給餌ログ <span class="dim" style="font-size:12px;">' + esc(c.name) + '</span>';
    var m = document.getElementById('ovFeedingLogModal');
    if (m) m.classList.add('open');
  }

  function ovSubmitAddPlan() {
    if (!_ovFeedCtx) return;
    var foodId = document.getElementById('ovApFoodId') && document.getElementById('ovApFoodId').value;
    var slot = document.getElementById('ovApSlot') && document.getElementById('ovApSlot').value;
    var amountG = document.getElementById('ovApAmount') && parseFloat(document.getElementById('ovApAmount').value);
    var notes = document.getElementById('ovApNotes') && document.getElementById('ovApNotes').value;
    if (_ovPendingPresetItem) {
      if (!foodId || !amountG) { alert('フードと量は必須です'); return; }
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(_ovPendingPresetItem) + '/items', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ food_id: foodId, meal_slot: slot || 'morning', amount_g: amountG, notes: notes || null }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          var backPid = _ovPendingPresetItem;
          ovCloseAddPlanModal();
          if (backPid) ovShowPresetItemsEditor(backPid);
          else ovFillPresetManageModal(ovGetStoredPresetLocation());
        }).catch(function () { alert('追加に失敗しました'); });
      return;
    }
    if (!foodId || !amountG) { alert('フードと量は必須です'); return; }
    var payload = { cat_id: _ovFeedCtx.catId, food_id: foodId, meal_slot: slot, amount_g: amountG, notes: notes || null, scheduled_time: null };
    var url = feedingApiBase() + '/plans';
    var method = 'POST';
    if (_ovEditingPlanId) {
      url = feedingApiBase() + '/plans/' + encodeURIComponent(_ovEditingPlanId);
      method = 'PUT';
      payload = { food_id: foodId, meal_slot: slot, amount_g: amountG, notes: notes || null, scheduled_time: null };
    }
    fetch(url, { method: method, headers: apiHeaders(), cache: 'no-store', body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        ovCloseAddPlanModal();
        fetchData(0);
      }).catch(function () { alert('保存に失敗しました'); });
  }

  function ovSubmitFeedingLog() {
    if (!_ovFeedCtx) return;
    var logDate = document.getElementById('ovFlDate') && document.getElementById('ovFlDate').value;
    var mealSlot = document.getElementById('ovFlSlot') && document.getElementById('ovFlSlot').value;
    var foodId = document.getElementById('ovFlFoodId') && document.getElementById('ovFlFoodId').value;
    var offeredG = document.getElementById('ovFlOfferedG') && document.getElementById('ovFlOfferedG').value;
    var eatenPct = document.getElementById('ovFlEatenPct') && document.getElementById('ovFlEatenPct').value;
    if (!logDate || !mealSlot) { alert('日付と食事区分は必須です'); return; }
    if (!foodId || !offeredG) { alert('フードとあげた量は必須です'); return; }
    var flst2 = document.getElementById('ovFlServedTime');
    var stFl = flst2 && flst2.value ? flst2.value : nowJstHm();
    fetch(feedingApiBase() + '/logs', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({
        cat_id: _ovFeedCtx.catId,
        log_date: logDate,
        meal_slot: mealSlot,
        food_id: foodId,
        offered_g: parseFloat(offeredG),
        eaten_pct: eatenPct !== '' && eatenPct != null ? parseFloat(eatenPct) : null,
        served_time: stFl,
      }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        ovCloseFlModal();
        fetchData(0);
      }).catch(function () { alert('保存に失敗しました'); });
  }

  var _ovQfPlanId = null;

  function ovOpenQuickFedModal(planId, foodName, amountG) {
    _ovQfPlanId = planId;
    var t = document.getElementById('ovQfTitle');
    if (t) t.textContent = '🍚 あげた記録';
    var fn = document.getElementById('ovQfFoodName');
    if (fn) fn.textContent = foodName || '—';
    var og = document.getElementById('ovQfOfferedG');
    if (og) og.value = amountG || '';
    var qfst = document.getElementById('ovQfServedTime');
    if (qfst) qfst.value = nowJstHm();
    var m = document.getElementById('ovQuickFedModal');
    if (m) m.classList.add('open');
  }

  function ovCloseQuickFedModal() {
    _ovQfPlanId = null;
    var m = document.getElementById('ovQuickFedModal');
    if (m) m.classList.remove('open');
  }

  function ovSubmitQuickFed() {
    if (!_ovQfPlanId) return;
    var og = document.getElementById('ovQfOfferedG');
    var offeredG = og && og.value ? parseFloat(og.value) : null;
    var qfst2 = document.getElementById('ovQfServedTime');
    var stQf = qfst2 && qfst2.value ? qfst2.value : nowJstHm();
    var payload = { log_date: todayJstYmd(), served_time: stQf };
    if (offeredG != null && offeredG > 0) payload.offered_g = offeredG;
    fetch(feedingApiBase() + '/plans/' + encodeURIComponent(_ovQfPlanId) + '/fed', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        ovCloseQuickFedModal();
        fetchData(0);
      }).catch(function () { alert('記録に失敗しました'); });
  }

  var _ovElLogId = null;

  function ovOpenEditLogModal(logId, foodName, offeredG, eatenPct, servedTimeRaw) {
    _ovElLogId = logId;
    var t = document.getElementById('ovElTitle');
    if (t) t.textContent = '✏️ 給餌ログ編集';
    var fn = document.getElementById('ovElFoodName');
    if (fn) fn.textContent = foodName || '—';
    var og = document.getElementById('ovElOfferedG');
    if (og) og.value = offeredG || '';
    var ep = document.getElementById('ovElEatenPct');
    if (ep) ep.value = eatenPct || '100';
    var elst = document.getElementById('ovElServedTime');
    if (elst) elst.value = ovFmtFedServedTime(servedTimeRaw) || nowJstHm();
    var m = document.getElementById('ovEditLogModal');
    if (m) m.classList.add('open');
  }

  function ovCloseEditLogModal() {
    _ovElLogId = null;
    var m = document.getElementById('ovEditLogModal');
    if (m) m.classList.remove('open');
  }

  function ovSubmitEditLog() {
    if (!_ovElLogId) return;
    var og = document.getElementById('ovElOfferedG');
    var ep = document.getElementById('ovElEatenPct');
    var offeredG = og && og.value ? parseFloat(og.value) : null;
    var eatenPct = ep && ep.value !== '' ? parseFloat(ep.value) : null;
    var elst2 = document.getElementById('ovElServedTime');
    var stEl = elst2 && elst2.value ? elst2.value : nowJstHm();
    var payload = { served_time: stEl };
    if (offeredG != null) payload.offered_g = offeredG;
    if (eatenPct != null) payload.eaten_pct = eatenPct;
    fetch(feedingApiBase() + '/logs/' + encodeURIComponent(_ovElLogId), {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        ovCloseEditLogModal();
        fetchData(0);
      }).catch(function () { alert('保存に失敗しました'); });
  }

  function ovUndoFedLog(logId) {
    if (!logId) return;
    if (!confirm('この給餌記録を取り消しますか？')) return;
    fetch(feedingApiBase() + '/logs/' + encodeURIComponent(logId), { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () { alert('取り消しに失敗しました'); });
  }

  function ovDeletePlan(planId, catName) {
    if (!planId) return;
    if (!confirm((catName ? '「' + catName + '」の' : '') + 'この献立行を削除しますか？')) return;
    fetch(feedingApiBase() + '/plans/' + encodeURIComponent(planId), { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () { alert('削除に失敗しました'); });
  }

  // ── 残しモーダル（猫詳細 cat-detail.js の renderLeftoverInput / saveLeftover と同じデータ・API） ──

  var _ovLoCatId = null;

  /** JST の「昨日」— 猫詳細の yesterdayJstYmd と同じ計算 */
  function yesterdayJstYmd() {
    var t = todayJstYmd();
    var d = new Date(t + 'T12:00:00+09:00');
    d.setTime(d.getTime() - 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  /** dashboard.js normMealSlotForOverview と同じ（プリセットが日本語 meal_slot のときも一致） */
  function ovNormMealSlot(slot) {
    if (slot == null || slot === '') return '';
    var x = String(slot).toLowerCase().trim();
    if (x === '朝' || x === 'morning' || x === 'am') return 'morning';
    if (x === '昼' || x === 'afternoon' || x === 'noon' || x === 'lunch') return 'afternoon';
    if (x === '夜' || x === 'evening' || x === 'night' || x === 'dinner' || x === '夕' || x === '晩') return 'evening';
    return x;
  }
  function ovIsEveningMealSlot(slot) {
    return ovNormMealSlot(slot) === 'evening';
  }
  /** 当日の「朝・昼」枠（残し記録セクション2） */
  function ovIsDaytimeMealSlot(slot) {
    var n = ovNormMealSlot(slot);
    return n === 'morning' || n === 'afternoon';
  }

  function ovFilterPlansBySlot(plans, pred) {
    var out = [];
    for (var i = 0; i < plans.length; i++) {
      if (pred(plans[i].meal_slot)) out.push(plans[i]);
    }
    return out;
  }
  function ovFilterLogsBySlot(logs, pred) {
    var out = [];
    for (var i = 0; i < logs.length; i++) {
      if (pred(logs[i].meal_slot)) out.push(logs[i]);
    }
    return out;
  }

  /** cat-detail buildLeftoverItems と同じ（plan_id でログと献立を対応） */
  function ovBuildLeftoverItems(plans, logs) {
    var logByPlanId = {};
    for (var li = 0; li < logs.length; li++) {
      if (logs[li].plan_id != null && logs[li].plan_id !== '') {
        logByPlanId[String(logs[li].plan_id)] = logs[li];
      }
    }
    var items = [];
    for (var pi = 0; pi < plans.length; pi++) {
      var plan = plans[pi];
      var pid = plan.plan_id;
      if (pid == null) continue;
      items.push({ plan: plan, log: logByPlanId[String(pid)] || null });
    }
    for (var lli = 0; lli < logs.length; lli++) {
      if (!logs[lli].plan_id) {
        items.push({ plan: null, log: logs[lli] });
      }
    }
    return items;
  }

  function ovRenderLeftoverItemRow(item, logDateStr, secKey, rowIdx) {
    var log = item.log;
    var plan = item.plan;
    var foodName = (log && log.food_name) || (plan && plan.food_name) || '不明';
    var offG = (log && log.offered_g != null && log.offered_g !== '') ? Number(log.offered_g) : (plan && plan.amount_g != null ? Number(plan.amount_g) : 0);
    var planId = plan && plan.plan_id != null ? String(plan.plan_id) : '';
    var logId = log && log.id != null ? String(log.id) : '';
    var inputId = 'ov-lo-inp-' + secKey + '-' + rowIdx;

    var prefillLeft = '';
    if (log && log.offered_g && log.eaten_pct != null && log.eaten_pct !== undefined) {
      prefillLeft = String(Math.round(log.offered_g * (100 - log.eaten_pct) / 100 * 10) / 10);
    }

    var html = '<div style="background:rgba(0,0,0,.04);border-radius:8px;padding:8px 10px;margin-bottom:6px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">';
    html += '<span style="font-weight:600;font-size:13px;">' + esc(foodName) + '</span>';
    if (offG) html += '<span class="dim" style="font-size:11px;">提供 ' + esc(String(offG)) + 'g</span>';
    html += '</div>';

    if (log && log.eaten_pct !== null && log.eaten_pct !== undefined && log.eaten_pct < 100) {
      var leftG = Math.round(offG * (100 - log.eaten_pct) / 100 * 10) / 10;
      var ateG = Math.round(offG * log.eaten_pct / 100 * 10) / 10;
      html += '<div style="font-size:11px;color:#4ade80;margin-bottom:4px;">✅ ' + log.eaten_pct + '% 食べた（' + ateG + 'g） / 残り ' + leftG + 'g</div>';
    } else if (log && log.eaten_pct === 100) {
      html += '<div style="font-size:11px;color:#4ade80;margin-bottom:4px;">✅ 完食</div>';
    }

    html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;">';
    html += '<label class="dim" style="font-size:11px;">残り</label>';
    html += '<input type="number" id="' + escAttr(inputId) + '" class="form-input" style="width:64px;font-size:12px;padding:2px 4px;" min="0" step="0.1" placeholder="g"';
    if (offG) html += ' max="' + escAttr(String(offG)) + '"';
    html += ' value="' + escAttr(prefillLeft) + '">';

    if (logId) {
      html += '<button type="button" class="btn btn-outline ov-lo-save-log" style="font-size:10px;padding:2px 8px;" data-log-id="' + escAttr(logId) + '" data-offered-g="' + escAttr(String(offG)) + '" data-input-id="' + escAttr(inputId) + '">保存</button>';
      html += '<button type="button" class="btn btn-outline ov-lo-complete-log" style="font-size:10px;padding:2px 8px;" data-log-id="' + escAttr(logId) + '">完食</button>';
    } else if (planId) {
      html += '<button type="button" class="btn btn-outline ov-lo-save-plan" style="font-size:10px;padding:2px 8px;" data-plan-id="' + escAttr(planId) + '" data-offered-g="' + escAttr(String(offG)) + '" data-log-date="' + escAttr(logDateStr) + '" data-input-id="' + escAttr(inputId) + '">保存</button>';
      html += '<button type="button" class="btn btn-outline ov-lo-complete-plan" style="font-size:10px;padding:2px 8px;" data-plan-id="' + escAttr(planId) + '" data-log-date="' + escAttr(logDateStr) + '">完食</button>';
    }
    html += '</div></div>';
    return html;
  }

  function ovRenderLeftoverSection(label, items, logDateStr, secKey) {
    var html = '<div style="margin-bottom:14px;">';
    html += '<div style="font-weight:700;font-size:13px;margin-bottom:6px;border-bottom:1px solid rgba(0,0,0,.08);padding-bottom:4px;">' + esc(label) + '</div>';
    if (items.length === 0) {
      html += '<div class="dim" style="font-size:12px;padding:4px 0;">献立・ログともにありません</div>';
    } else {
      for (var ri = 0; ri < items.length; ri++) {
        html += ovRenderLeftoverItemRow(items[ri], logDateStr, secKey, ri);
      }
    }
    html += '</div>';
    return html;
  }

  function ovFillLeftoverModalBody(catId) {
    var c = ovFindCat(catId);
    var body = document.getElementById('ovLoBody');
    if (!body) return;
    if (!c) {
      body.innerHTML = '<p style="text-align:center;color:#c44;padding:16px;">猫データがありません</p>';
      return;
    }

    var todayStr = todayJstYmd();
    var yesterdayStr = yesterdayJstYmd();
    var base = feedingApiBase() + '/logs?cat_id=' + encodeURIComponent(catId);
    var allPlans = c.feeding_plan || [];

    Promise.all([
      fetch(base + '&date=' + yesterdayStr, { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(base + '&date=' + todayStr, { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var yLogsAll = results[0].logs || [];
      var tLogsAll = results[1].logs || [];

      var prevNightPlans = ovFilterPlansBySlot(allPlans, ovIsEveningMealSlot);
      var prevNightLogs = ovFilterLogsBySlot(yLogsAll, ovIsEveningMealSlot);
      var itemsPrev = ovBuildLeftoverItems(prevNightPlans, prevNightLogs);

      var dayPlans = ovFilterPlansBySlot(allPlans, ovIsDaytimeMealSlot);
      var dayLogs = ovFilterLogsBySlot(tLogsAll, ovIsDaytimeMealSlot);
      var itemsDay = ovBuildLeftoverItems(dayPlans, dayLogs);

      var evePlans = ovFilterPlansBySlot(allPlans, ovIsEveningMealSlot);
      var eveLogs = ovFilterLogsBySlot(tLogsAll, ovIsEveningMealSlot);
      var itemsEve = ovBuildLeftoverItems(evePlans, eveLogs);

      var html = '';
      html += ovRenderLeftoverSection('🌙 前日夜（昨夜の夜ごはんと同じ）', itemsPrev, yesterdayStr, 'prev');
      html += ovRenderLeftoverSection('☀️ 当日朝・昼', itemsDay, todayStr, 'day');
      html += ovRenderLeftoverSection('🌙 当日夜', itemsEve, todayStr, 'eve');
      body.innerHTML = html;
    }).catch(function () {
      body.innerHTML = '<p style="text-align:center;color:#c44;padding:16px;">読込失敗</p>';
    });
  }

  function ovOpenLeftoverModal(catId) {
    _ovLoCatId = catId;
    var c = ovFindCat(catId);
    var catName = c ? c.name : '';
    var t = document.getElementById('ovLoTitle');
    if (t) t.textContent = '🥄 残し記録 — ' + catName;
    var body = document.getElementById('ovLoBody');
    if (body) body.innerHTML = '<p style="text-align:center;color:#aaa;padding:16px;">読込中…</p>';
    var m = document.getElementById('ovLeftoverModal');
    if (m) m.classList.add('open');
    ovFillLeftoverModalBody(catId);
  }

  function ovCloseLeftoverModal() {
    _ovLoCatId = null;
    var m = document.getElementById('ovLeftoverModal');
    if (m) m.classList.remove('open');
  }

  function fetchCatsDataSilent() {
    fetch(getApiUrl() + locationQuery(), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json().then(function (data) { return { ok: r.ok, data: data }; }); })
      .then(function (res) {
        if (res.data && res.data.cats) {
          catsData = res.data.cats;
          render();
        }
      }).catch(function () { /* ignore */ });
  }

  function ovLeftoverModalClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var savePlan = t.closest('.ov-lo-save-plan');
    if (savePlan) {
      ev.preventDefault();
      var pid = savePlan.getAttribute('data-plan-id');
      var offG = parseFloat(savePlan.getAttribute('data-offered-g'));
      var logDate = savePlan.getAttribute('data-log-date') || todayJstYmd();
      var inpId = savePlan.getAttribute('data-input-id');
      var inp = inpId ? document.getElementById(inpId) : null;
      if (!inp || !pid) return;
      var leftG = parseFloat(inp.value);
      if (isNaN(leftG) || leftG < 0) { alert('残り量を入力してください'); return; }
      if (offG > 0 && leftG > offG) { alert('提供量(' + offG + 'g)を超えています'); return; }
      var eatenPct = offG > 0 ? Math.round((offG - leftG) / offG * 100) : 0;
      fetch(feedingApiBase() + '/plans/' + encodeURIComponent(pid) + '/fed', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ eaten_pct: eatenPct, log_date: logDate }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          if (_ovLoCatId) ovFillLeftoverModalBody(_ovLoCatId);
          fetchCatsDataSilent();
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var completePlan = t.closest('.ov-lo-complete-plan');
    if (completePlan) {
      ev.preventDefault();
      var pid2 = completePlan.getAttribute('data-plan-id');
      var logDate2 = completePlan.getAttribute('data-log-date') || todayJstYmd();
      if (!pid2) return;
      fetch(feedingApiBase() + '/plans/' + encodeURIComponent(pid2) + '/fed', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ eaten_pct: 100, log_date: logDate2 }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          if (_ovLoCatId) ovFillLeftoverModalBody(_ovLoCatId);
          fetchCatsDataSilent();
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var saveLog = t.closest('.ov-lo-save-log');
    if (saveLog) {
      ev.preventDefault();
      var lid = saveLog.getAttribute('data-log-id');
      var offG2 = parseFloat(saveLog.getAttribute('data-offered-g'));
      var inpId2 = saveLog.getAttribute('data-input-id');
      var inp2 = inpId2 ? document.getElementById(inpId2) : null;
      if (!inp2 || !lid) return;
      var leftG2 = parseFloat(inp2.value);
      if (isNaN(leftG2) || leftG2 < 0) { alert('残り量を入力してください'); return; }
      if (offG2 > 0 && leftG2 > offG2) { alert('提供量(' + offG2 + 'g)を超えています'); return; }
      var eatenPct2 = offG2 > 0 ? Math.round((offG2 - leftG2) / offG2 * 100) : 0;
      if (eatenPct2 < 0) eatenPct2 = 0;
      if (eatenPct2 > 100) eatenPct2 = 100;
      fetch(feedingApiBase() + '/logs/' + encodeURIComponent(lid), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ eaten_pct: eatenPct2 }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          if (_ovLoCatId) ovFillLeftoverModalBody(_ovLoCatId);
          fetchCatsDataSilent();
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var completeLog = t.closest('.ov-lo-complete-log');
    if (completeLog) {
      ev.preventDefault();
      var lid3 = completeLog.getAttribute('data-log-id');
      if (!lid3) return;
      fetch(feedingApiBase() + '/logs/' + encodeURIComponent(lid3), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ eaten_pct: 100 }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          if (_ovLoCatId) ovFillLeftoverModalBody(_ovLoCatId);
          fetchCatsDataSilent();
        }).catch(function () { alert('保存に失敗しました'); });
    }
  }

  function ovBindFeedingModalDom() {
    var c1 = document.getElementById('ovCloseAddPlanBtn');
    if (c1 && !c1._ovBound) { c1._ovBound = true; c1.addEventListener('click', ovCloseAddPlanModal); }
    var s1 = document.getElementById('ovSubmitAddPlanBtn');
    if (s1 && !s1._ovBound) { s1._ovBound = true; s1.addEventListener('click', ovSubmitAddPlan); }
    var c2 = document.getElementById('ovCloseFlBtn');
    if (c2 && !c2._ovBound) { c2._ovBound = true; c2.addEventListener('click', ovCloseFlModal); }
    var s2 = document.getElementById('ovSubmitFlBtn');
    if (s2 && !s2._ovBound) { s2._ovBound = true; s2.addEventListener('click', ovSubmitFeedingLog); }
    var cqf = document.getElementById('ovCloseQfBtn');
    if (cqf && !cqf._ovBound) { cqf._ovBound = true; cqf.addEventListener('click', ovCloseQuickFedModal); }
    var sqf = document.getElementById('ovSubmitQfBtn');
    if (sqf && !sqf._ovBound) { sqf._ovBound = true; sqf.addEventListener('click', ovSubmitQuickFed); }
    var cel = document.getElementById('ovCloseElBtn');
    if (cel && !cel._ovBound) { cel._ovBound = true; cel.addEventListener('click', ovCloseEditLogModal); }
    var sel = document.getElementById('ovSubmitElBtn');
    if (sel && !sel._ovBound) { sel._ovBound = true; sel.addEventListener('click', ovSubmitEditLog); }
    var clo = document.getElementById('ovCloseLoBtn');
    if (clo && !clo._ovBound) { clo._ovBound = true; clo.addEventListener('click', ovCloseLeftoverModal); }
    var loM = document.getElementById('ovLeftoverModal');
    if (loM && !loM._ovBound) { loM._ovBound = true; loM.addEventListener('click', ovLeftoverModalClick); }
  }

  function ovHandlePresetModalClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var closeB = t.closest('[data-ov-close-preset]');
    if (closeB) {
      ev.preventDefault();
      ovClosePresetModal();
      return;
    }
    var locB = t.closest('[data-ov-preset-loc]');
    if (locB && _ovFeedCtx) {
      ev.preventDefault();
      var loc = locB.getAttribute('data-ov-preset-loc');
      var ctx = locB.getAttribute('data-ov-preset-ctx') || 'apply';
      ovSetStoredPresetLocation(loc);
      if (ctx === 'apply') ovFillPresetApplyModal(loc);
      else if (ctx === 'assign') ovFillPresetAssignModal(loc);
      else if (ctx === 'manage') ovFillPresetManageModal(loc);
      return;
    }
    var openM = t.closest('[data-ov-open-preset-manage]');
    if (openM && _ovFeedCtx) {
      ev.preventDefault();
      ovFillPresetManageModal(ovGetStoredPresetLocation());
      return;
    }
    var ap = t.closest('[data-ov-apply-preset]');
    if (ap && _ovFeedCtx) {
      ev.preventDefault();
      var pid = ap.getAttribute('data-ov-apply-preset');
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(pid) + '/apply', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ cat_id: _ovFeedCtx.catId }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          alert('プリセット「' + (data.preset_name || '') + '」を適用しました（' + (data.applied || []).length + '品）');
          ovClosePresetModal();
          fetchData(0);
        }).catch(function () { alert('適用に失敗しました'); });
      return;
    }
    var as = t.closest('[data-ov-assign-preset]');
    if (as && _ovFeedCtx) {
      ev.preventDefault();
      var raw = as.getAttribute('data-ov-assign-preset');
      var presetId = raw === 'none' ? null : parseInt(raw, 10);
      fetch(apiOpsBase() + '/cats/' + encodeURIComponent(_ovFeedCtx.catId), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ assigned_preset_id: presetId }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          _ovFeedCtx.assignedPresetId = presetId;
          for (var i = 0; i < catsData.length; i++) {
            if (String(catsData[i].id) === String(_ovFeedCtx.catId)) {
              catsData[i].assigned_preset_id = presetId;
              break;
            }
          }
          ovClosePresetModal();
          fetchData(0);
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var cr = t.closest('[data-ov-create-preset]');
    if (cr && _ovFeedCtx) {
      ev.preventDefault();
      var loc = ovGetStoredPresetLocation();
      if (!confirm('拠点「' + ovPresetLocShortLabel(loc) + '」用のプリセットを新規作成しますか？')) return;
      var name = prompt('プリセット名', '');
      if (!name) return;
      var desc = prompt('説明（任意）', '');
      fetch(feedingApiBase() + '/presets', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ name: name, description: desc || null, location_id: loc, species: _ovFeedCtx.species || 'cat' }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          if (data.preset && data.preset.id) {
            _ovPendingPresetItem = String(data.preset.id);
            ovOpenAddPlanModal(_ovFeedCtx.catId, 'morning', null, { preservePendingPreset: true });
            var t0 = document.querySelector('#ovAddPlanModal .modal-title');
            if (t0) t0.innerHTML = '📋 プリセットにフード追加 <span class="dim">' + esc(name) + '</span>';
          } else {
            ovFillPresetManageModal(loc);
          }
        }).catch(function () { alert('作成に失敗しました'); });
      return;
    }
    var cy = t.closest('[data-ov-cycle-preset-loc]');
    if (cy && _ovFeedCtx) {
      ev.preventDefault();
      var pid = cy.getAttribute('data-ov-cycle-preset-loc');
      var cur = cy.getAttribute('data-ov-cycle-cur');
      var next = cur === 'nekomata' ? 'cafe' : 'nekomata';
      if (!confirm('拠点を「' + ovPresetLocShortLabel(next) + '」に変更しますか？')) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(pid), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ location_id: next }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovFillPresetManageModal(ovGetStoredPresetLocation());
        }).catch(function () { alert('更新に失敗しました'); });
      return;
    }
    var rn = t.closest('[data-ov-rename-preset]');
    if (rn && _ovFeedCtx) {
      ev.preventDefault();
      var rid = rn.getAttribute('data-ov-rename-preset');
      var curN = rn.getAttribute('data-ov-rename-name') || '';
      var nn = prompt('新しいプリセット名', curN);
      if (!nn || nn === curN) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(rid), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ name: nn }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovFillPresetManageModal(ovGetStoredPresetLocation());
        }).catch(function () { alert('名前変更に失敗しました'); });
      return;
    }
    var ed = t.closest('[data-ov-edit-preset-items]');
    if (ed && _ovFeedCtx) {
      ev.preventDefault();
      var eid = ed.getAttribute('data-ov-edit-preset-items');
      ovShowPresetItemsEditor(eid);
      return;
    }
    var del = t.closest('[data-ov-delete-preset]');
    if (del && _ovFeedCtx) {
      ev.preventDefault();
      var did = del.getAttribute('data-ov-delete-preset');
      if (!confirm('このプリセットを削除しますか？')) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(did), { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovFillPresetManageModal(ovGetStoredPresetLocation());
        }).catch(function () { alert('削除に失敗しました'); });
      return;
    }
    var delIt = t.closest('[data-ov-del-preset-item]');
    if (delIt && _ovFeedCtx) {
      ev.preventDefault();
      var parts = (delIt.getAttribute('data-ov-del-preset-item') || '').split(':');
      var presetId = parts[0];
      var itemId = parts[1];
      if (!presetId || !itemId) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(presetId) + '/items/' + encodeURIComponent(itemId), {
        method: 'DELETE', headers: apiHeaders(), cache: 'no-store',
      }).then(function (r) { return r.json(); })
        .then(function () { ovShowPresetItemsEditor(presetId); })
        .catch(function () { alert('削除に失敗しました'); });
      return;
    }
    var addIt = t.closest('[data-ov-add-preset-item]');
    if (addIt && _ovFeedCtx) {
      ev.preventDefault();
      var apid = addIt.getAttribute('data-ov-add-preset-item');
      var slot = addIt.getAttribute('data-ov-preset-slot') || 'morning';
      _ovPendingPresetItem = apid;
      ovOpenAddPlanModal(_ovFeedCtx.catId, slot, null, { preservePendingPreset: true });
      var title = document.querySelector('#ovAddPlanModal .modal-title');
      if (title) title.innerHTML = '📋 プリセットに追加 <span class="dim">' + esc(slot) + '</span>';
      return;
    }
    var backM = t.closest('[data-ov-preset-items-back]');
    if (backM && _ovFeedCtx) {
      ev.preventDefault();
      ovFillPresetManageModal(ovGetStoredPresetLocation());
      return;
    }
  }

  function ovShowPresetItemsEditor(presetId) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📋 プリセットのフード</div><div id="ovPresetItemsBody" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button type="button" class="btn btn-outline" data-ov-preset-items-back="1">戻る</button></div></div>';
    var body = document.getElementById('ovPresetItemsBody');
    fetch(feedingApiBase() + '/presets/' + encodeURIComponent(presetId) + '/items', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = data.items || [];
        _ovPresetItemsCache = { presetId: presetId, items: items };
        var h = '';
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          h += '<div style="padding:8px;background:var(--surface);border-radius:6px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;">';
          h += '<div style="font-size:12px;flex:1;">' + esc(it.food_name || '') + ' <b>' + it.amount_g + 'g</b> <span class="dim">' + esc(it.meal_slot || '') + '</span></div>';
          h += '<button type="button" class="btn-edit-small" style="color:#f87171;" data-ov-del-preset-item="' + escAttr(String(presetId)) + ':' + escAttr(String(it.id)) + '">🗑</button>';
          h += '</div>';
        }
        if (items.length === 0) h += '<div class="empty-msg">未登録</div>';
        h += '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">';
        h += '<button type="button" class="btn btn-outline" style="font-size:11px;" data-ov-add-preset-item="' + escAttr(String(presetId)) + '" data-ov-preset-slot="morning">+ 朝枠</button>';
        h += '<button type="button" class="btn btn-outline" style="font-size:11px;" data-ov-add-preset-item="' + escAttr(String(presetId)) + '" data-ov-preset-slot="evening">+ 夕枠</button>';
        h += '</div>';
        if (body) { body.className = ''; body.innerHTML = h; }
      }).catch(function () {
        if (body) { body.className = ''; body.innerHTML = '<div class="empty-msg">読み込み失敗</div>'; }
      });
  }

  function postHealthRecord(body, btn) {
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(apiOpsBase() + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = {};
        if (text) {
          try { data = JSON.parse(text); } catch (e) {
            data = { error: 'invalid_response', message: text.slice(0, 240) };
          }
        }
        return { ok: r.ok, status: r.status, data: data };
      });
    })
      .then(function (res) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        var data = res.data;
        if (!res.ok || data.error) {
          alert('エラー: ' + (data.message || data.error || ('HTTP ' + res.status)));
          return;
        }
        fetchData(0);
      }).catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        alert('保存に失敗しました' + (err && err.message ? '\n' + err.message : ''));
      });
  }

  function putHealthRecord(recordId, body, btn) {
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(apiOpsBase() + '/health/records/' + encodeURIComponent(recordId), {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        alert('保存に失敗しました');
      });
  }

  function putVoiceExcretion(voiceInputId, body, btn) {
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(apiOpsBase() + '/voice/inputs/' + encodeURIComponent(voiceInputId) + '/excretion', {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        alert('保存に失敗しました');
      });
  }

  function deleteVoiceExcretion(voiceInputId, btn) {
    if (!voiceInputId) return;
    if (!confirm('この音声記録を削除しますか？\n（紐づく健康記録があれば一緒に削除します）')) return;
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(apiOpsBase() + '/voice/inputs/' + encodeURIComponent(voiceInputId) + '/excretion', {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        alert('削除に失敗しました');
      });
  }

  function deleteHealthRecord(recordId, btn) {
    if (!recordId) return;
    if (!confirm('この記録を削除しますか？')) return;
    var prevText = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    fetch(apiOpsBase() + '/health/records/' + encodeURIComponent(recordId), {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = prevText; }
        alert('削除に失敗しました');
      });
  }

  function saveTaskAction(btn, action) {
    var id = btn.getAttribute('data-task-id');
    if (!id) return;
    var path = action === 'skip' ? 'skip' : 'done';
    var prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    fetch(apiOpsBase() + '/tasks/' + encodeURIComponent(id) + '/' + path, {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({}),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        btn.disabled = false;
        btn.textContent = prevText;
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = prevText;
        alert('更新に失敗しました');
      });
  }

  function saveInlineStool(catId, form, btn) {
    var st = form.querySelector('.ov-sel-st');
    var slot = form.querySelector('.ov-sel-slot');
    var dt = form.querySelector('.ov-inp-date');
    var value = st && st.value;
    if (!value) { alert('状態を選択してください'); return; }
    var recordDate = dt && dt.value;
    if (!recordDate) { alert('日付を入力してください'); return; }
    var details = (slot && slot.value) ? slot.value : null;
    postHealthRecord({
      cat_id: catId,
      record_type: 'stool',
      record_date: recordDate,
      recorded_time: nowJstHm(),
      value: value,
      details: details,
    }, btn);
  }

  function saveInlineUrine(catId, form, btn) {
    var st = form.querySelector('.ov-sel-ur');
    var slot = form.querySelector('.ov-sel-slot');
    var dt = form.querySelector('.ov-inp-date');
    var value = st && st.value;
    if (!value) { alert('状態を選択してください'); return; }
    var recordDate = dt && dt.value;
    if (!recordDate) { alert('日付を入力してください'); return; }
    var details = (slot && slot.value) ? slot.value : null;
    postHealthRecord({
      cat_id: catId,
      record_type: 'urine',
      record_date: recordDate,
      recorded_time: nowJstHm(),
      value: value,
      details: details,
    }, btn);
  }

  function saveInlineWeight(catId, form, btn) {
    var inp = form.querySelector('.ov-inp-weight');
    var dt = form.querySelector('.ov-inp-date');
    var value = inp && String(inp.value || '').trim();
    if (!value) { alert('体重を入力してください'); return; }
    var recordDate = dt && dt.value;
    if (!recordDate) { alert('日付を入力してください'); return; }
    postHealthRecord({
      cat_id: catId,
      record_type: 'weight',
      record_date: recordDate,
      recorded_time: nowJstHm(),
      value: value,
      details: null,
      next_due: null,
    }, btn);
  }

  function saveInlineCare(catId, form, btn) {
    var sel = form.querySelector('.ov-sel-care-type');
    var doneSel = form.querySelector('.ov-sel-care-done');
    var dt = form.querySelector('.ov-inp-date');
    var careVal = sel && sel.value;
    if (!careVal) { alert('ケア項目を選択してください'); return; }
    var recordDate = dt && dt.value;
    if (!recordDate) { alert('日付を入力してください'); return; }
    var careDone = doneSel && doneSel.value === '1';
    var parts = careVal.split(':');
    var recordType = parts[0] || 'care';
    var details = parts.slice(1).join(':') || '';
    var body = {
      cat_id: catId,
      record_type: recordType,
      record_date: recordDate,
      value: careDone ? '記録' : '×',
      details: details,
    };
    if (careDone && (recordType === 'care' || recordType === 'eye_discharge')) {
      body.recorded_time = nowJstHm();
    }
    postHealthRecord(body, btn);
  }

  function bindOverviewInlineHandlers() {
    if (_ovInlineHandlersBound) return;
    _ovInlineHandlersBound = true;
    document.addEventListener('click', function (ev) {
      var pm = document.getElementById('ovPresetApplyModal');
      if (pm && pm.classList.contains('open') && ev.target && ev.target.closest && pm.contains(ev.target)) {
        ovHandlePresetModalClick(ev);
      }
    });
    cardArea.addEventListener('click', function (ev) {
      var fp = ev.target.closest && ev.target.closest('.btn-ov-feed-preset');
      if (fp) {
        ev.preventDefault();
        ev.stopPropagation();
        var cid = fp.getAttribute('data-cat-id');
        if (cid) ovOpenPresetApply(cid);
        return;
      }
      var fa = ev.target.closest && ev.target.closest('.btn-ov-feed-assign');
      if (fa) {
        ev.preventDefault();
        ev.stopPropagation();
        var cida = fa.getAttribute('data-cat-id');
        if (cida) ovOpenPresetAssign(cida);
        return;
      }
      var fm = ev.target.closest && ev.target.closest('.btn-ov-feed-manage');
      if (fm) {
        ev.preventDefault();
        ev.stopPropagation();
        var cidm = fm.getAttribute('data-cat-id');
        if (cidm) ovOpenPresetManage(cidm);
        return;
      }
      var fadd = ev.target.closest && ev.target.closest('.btn-ov-feed-addplan');
      if (fadd) {
        ev.preventDefault();
        ev.stopPropagation();
        var cidad = fadd.getAttribute('data-cat-id');
        if (cidad) ovOpenAddPlanModal(cidad, 'morning', null);
        return;
      }
      var flog = ev.target.closest && ev.target.closest('.btn-ov-feed-log');
      if (flog) {
        ev.preventDefault();
        ev.stopPropagation();
        var cidf = flog.getAttribute('data-cat-id');
        if (cidf) ovOpenFeedingLogModal(cidf, null);
        return;
      }
      var fmf = ev.target.closest && ev.target.closest('.btn-ov-feed-markfed');
      if (fmf) {
        ev.preventDefault();
        ev.stopPropagation();
        var pid = fmf.getAttribute('data-plan-id');
        var fnm = fmf.getAttribute('data-food-name') || '';
        var amg = fmf.getAttribute('data-amount-g') || '';
        if (pid) ovOpenQuickFedModal(pid, fnm, amg);
        return;
      }
      var felg = ev.target.closest && ev.target.closest('.btn-ov-feed-editlog');
      if (felg) {
        ev.preventDefault();
        ev.stopPropagation();
        var elid = felg.getAttribute('data-log-id');
        var elfn = felg.getAttribute('data-food-name') || '';
        var elog = felg.getAttribute('data-offered-g') || '';
        var elep = felg.getAttribute('data-eaten-pct') || '100';
        var elst = felg.getAttribute('data-served-time') || '';
        if (elid) ovOpenEditLogModal(elid, elfn, elog, elep, elst);
        return;
      }
      var fund = ev.target.closest && ev.target.closest('.btn-ov-feed-undofed');
      if (fund) {
        ev.preventDefault();
        ev.stopPropagation();
        var lid = fund.getAttribute('data-log-id');
        if (lid) ovUndoFedLog(lid);
        return;
      }
      var fdel = ev.target.closest && ev.target.closest('.btn-ov-feed-delplan');
      if (fdel) {
        ev.preventDefault();
        ev.stopPropagation();
        var pd = fdel.getAttribute('data-plan-id');
        var cn = fdel.getAttribute('data-cat-name') || '';
        if (pd) ovDeletePlan(pd, cn);
        return;
      }
      var fed = ev.target.closest && ev.target.closest('.btn-ov-feed-editplan');
      if (fed) {
        ev.preventDefault();
        ev.stopPropagation();
        var cide = fed.getAttribute('data-cat-id');
        var pide = fed.getAttribute('data-plan-id');
        if (cide && pide) ovOpenAddPlanModal(cide, null, pide);
        return;
      }
      var flft = ev.target.closest && ev.target.closest('.btn-ov-feed-leftover');
      if (flft) {
        ev.preventDefault();
        ev.stopPropagation();
        var clo = flft.getAttribute('data-cat-id');
        if (clo) ovOpenLeftoverModal(clo);
        return;
      }
      var fdelmemo = ev.target.closest && ev.target.closest('.btn-ov-feed-delmemo');
      if (fdelmemo) {
        ev.preventDefault();
        ev.stopPropagation();
        var memoNid = fdelmemo.getAttribute('data-note-id');
        if (!memoNid) return;
        if (!confirm('この食事メモを削除しますか？')) return;
        fetch(apiOpsBase() + '/cat-notes/' + encodeURIComponent(memoNid), {
          method: 'DELETE',
          headers: apiHeaders(),
          cache: 'no-store',
        }).then(function (r) {
          return r.text().then(function (text) {
            var data = {};
            try { data = text ? JSON.parse(text) : {}; } catch (_) {}
            return { ok: r.ok, data: data };
          });
        }).then(function (res) {
          if (!res.ok || (res.data && res.data.error)) {
            alert('エラー: ' + ((res.data && (res.data.message || res.data.error)) || '削除に失敗'));
            return;
          }
          fetchCatsDataSilent();
        }).catch(function () { alert('削除に失敗しました'); });
        return;
      }
      var hrEdit = ev.target.closest && ev.target.closest('.btn-ov-hr-edit');
      if (hrEdit) {
        ev.preventDefault();
        ev.stopPropagation();
        var rowE = hrEdit.closest('.ov-ex-row');
        if (!rowE) return;
        rowE.classList.add('is-editing');
        var kindE = rowE.getAttribute('data-hr-kind') || 'stool';
        var rawE = rowE.getAttribute('data-hr-value') || '';
        var mappedE = excretionFormValue(kindE, rawE);
        var selE = rowE.querySelector(kindE === 'urine' ? '.ov-ex-sel-ur' : '.ov-ex-sel-st');
        if (selE) {
          selE.value = mappedE;
          if (selE.value !== mappedE && rawE) selE.value = rawE;
        }
        var slotE = rowE.querySelector('.ov-ex-sel-slot');
        if (slotE) slotE.value = rowE.getAttribute('data-hr-details') || '';
        var dtE = rowE.querySelector('.ov-ex-inp-date');
        if (dtE) dtE.value = rowE.getAttribute('data-hr-date') || todayJstYmd();
        return;
      }
      var hrCancel = ev.target.closest && ev.target.closest('.btn-ov-hr-cancel');
      if (hrCancel) {
        ev.preventDefault();
        ev.stopPropagation();
        var rowC = hrCancel.closest('.ov-ex-row');
        if (rowC) rowC.classList.remove('is-editing');
        return;
      }
      var hrSave = ev.target.closest && ev.target.closest('.btn-ov-hr-save');
      if (hrSave) {
        ev.preventDefault();
        ev.stopPropagation();
        var rowS = hrSave.closest('.ov-ex-row');
        if (!rowS) return;
        var idS = rowS.getAttribute('data-record-id');
        var voiceOnlyS = rowS.getAttribute('data-voice-input-id');
        var kindS = rowS.getAttribute('data-hr-kind') || 'stool';
        var stS = rowS.querySelector(kindS === 'urine' ? '.ov-ex-sel-ur' : '.ov-ex-sel-st');
        var slotS = rowS.querySelector('.ov-ex-sel-slot');
        var dtS = rowS.querySelector('.ov-ex-inp-date');
        var valS = stS && stS.value;
        if (!valS) { alert('状態を選択してください'); return; }
        var rdS = dtS && dtS.value;
        if (!rdS) { alert('日付を入力してください'); return; }
        var detS = (slotS && slotS.value) ? slotS.value : null;
        if (idS) {
          putHealthRecord(idS, { value: valS, details: detS, record_date: rdS }, hrSave);
        } else if (voiceOnlyS) {
          putVoiceExcretion(voiceOnlyS, { value: valS, details: detS, record_date: rdS }, hrSave);
        }
        return;
      }
      var hrDel = ev.target.closest && ev.target.closest('.btn-ov-hr-del');
      if (hrDel) {
        ev.preventDefault();
        ev.stopPropagation();
        var rowD = hrDel.closest('.ov-ex-row');
        if (!rowD) return;
        var recD = rowD.getAttribute('data-record-id');
        var voiceOnlyD = rowD.getAttribute('data-voice-input-id');
        if (recD) deleteHealthRecord(recD, hrDel);
        else if (voiceOnlyD) deleteVoiceExcretion(voiceOnlyD, hrDel);
        return;
      }
      var taskDoneBtn = ev.target.closest && ev.target.closest('.btn-ov-task-done');
      if (taskDoneBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        saveTaskAction(taskDoneBtn, 'done');
        return;
      }
      var taskSkipBtn = ev.target.closest && ev.target.closest('.btn-ov-task-skip');
      if (taskSkipBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        saveTaskAction(taskSkipBtn, 'skip');
        return;
      }
      var btn = ev.target.closest && ev.target.closest('.btn-ov-save');
      if (!btn) return;
      ev.preventDefault();
      ev.stopPropagation();
      var kind = btn.getAttribute('data-kind');
      var form = btn.closest('.inline-form');
      if (!form || !kind) return;
      var catId = form.getAttribute('data-cat-id');
      if (!catId) return;
      if (kind === 'stool') saveInlineStool(catId, form, btn);
      else if (kind === 'urine') saveInlineUrine(catId, form, btn);
      else if (kind === 'weight') saveInlineWeight(catId, form, btn);
      else if (kind === 'care') saveInlineCare(catId, form, btn);
    });
  }

  function buildStoolInlineEdit(c) {
    return '<div class="inline-form" data-cat-id="' + escAttr(c.id) + '">' +
      '<select class="ov-inline-select ov-sel-st">' + OPT_STOOL_STATUS + '</select>' +
      '<select class="ov-inline-select ov-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="stool">保存</button>' +
      '</div>';
  }

  function buildUrineInlineEdit(c) {
    return '<div class="inline-form" data-cat-id="' + escAttr(c.id) + '">' +
      '<select class="ov-inline-select ov-sel-ur">' + OPT_URINE_STATUS + '</select>' +
      '<select class="ov-inline-select ov-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="urine">保存</button>' +
      '</div>';
  }

  function buildWeightInlineEdit(c) {
    var ph = c.weight_latest !== null && c.weight_latest !== undefined ? String(c.weight_latest) : 'kg';
    return '<div class="inline-form" data-cat-id="' + escAttr(c.id) + '">' +
      '<input type="number" class="ov-inline-num ov-inp-weight" step="0.1" min="0" placeholder="' + escAttr(ph) + '" title="体重(kg)" style="width:4.5rem;">' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="weight">保存</button>' +
      '</div>';
  }

  function buildCareInlineEdit(c) {
    return '<div class="inline-form" data-cat-id="' + escAttr(c.id) + '">' +
      '<select class="ov-inline-select ov-sel-care-type">' + OPT_CARE_TYPE + '</select>' +
      '<select class="ov-inline-select ov-sel-care-done">' + OPT_CARE_DONE + '</select>' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="care">保存</button>' +
      '</div>';
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

    ovBindFeedingModalDom();

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
    if (window.NyagiBootOverlay && retryCount === 0) window.NyagiBootOverlay.show('猫一覧ユニット同期中…');
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
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        var isNetworkErr = (err && (err.name === 'AbortError' || (err.message && (err.message.indexOf('Failed to fetch') !== -1 || err.message.indexOf('NetworkError') !== -1 || err.message.indexOf('Load failed') !== -1))));
        if (isNetworkErr && retryCount < 2) {
          cardArea.innerHTML = '<div class="loading">読み込み中...（再試行 ' + (retryCount + 1) + '/2）</div>';
          setTimeout(function () { fetchData(retryCount + 1); }, 1200);
          return;
        }
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
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
      html += '<div class="pcc-metric-label">排便 <small class="dim">直近3日</small></div>';
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
      html += '<div class="pcc-metric-label">排尿 <small class="dim">直近3日</small></div>';
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

  /** 開いているカード index のみ true。未設定＝すべて折りたたみがデフォルト（カード構成変更時はキーを変えてインデックスずれを防ぐ） */
  var EXPANDED_KEY = 'nyagi_items_expanded_v9';
  var LEGACY_FOLD_KEY = 'nyagi_items_folded';

  function loadExpandedMap() {
    try {
      var raw = localStorage.getItem(EXPANDED_KEY);
      if (raw) {
        var o = JSON.parse(raw);
        if (o && typeof o === 'object') return o;
      }
    } catch (e) {}
    try {
      var oldRaw = localStorage.getItem(LEGACY_FOLD_KEY);
      if (oldRaw) {
        var old = JSON.parse(oldRaw);
        try { localStorage.removeItem(LEGACY_FOLD_KEY); } catch (_) {}
        if (old && typeof old === 'object' && Object.keys(old).length > 0) {
          try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(old)); } catch (_) {}
          return old;
        }
      }
    } catch (e2) {}
    return null;
  }

  function saveExpandedMap(map) {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify(map || {})); } catch (e) {}
  }

  function renderPerItem() {
    var html = '';
    html += renderItemCard_Stool();
    html += renderItemCard_Urine();
    html += renderItemCard_Weight();
    html += renderItemCard_Meds();
    html += renderItemCard_FeedingCheck();
    html += renderItemCard_Care();
    html += renderItemCard_Tasks();
    html += renderItemCard_Anomaly();
    html += renderItemCard_Medical();
    cardArea.innerHTML = html;
    bindOverviewInlineHandlers();

    var expanded = loadExpandedMap();
    var titles = cardArea.querySelectorAll('.item-card-title');
    for (var i = 0; i < titles.length; i++) {
      (function (title, idx) {
        var body = title.nextElementSibling;
        if (!body) return;
        var isOpen = expanded && expanded[idx];
        if (!isOpen) {
          title.classList.add('collapsed');
          body.classList.add('hidden');
        }
        title.addEventListener('click', function () {
          var isHidden = body.classList.toggle('hidden');
          title.classList.toggle('collapsed', isHidden);
          var map = loadExpandedMap();
          if (!map || typeof map !== 'object') map = {};
          if (isHidden) {
            delete map[idx];
          } else {
            map[idx] = true;
          }
          saveExpandedMap(map);
        });
      })(titles[i], i);
    }

  }

  function itemRowReadonly(c, content) {
    return '<a href="' + catLink(c.id) + '" class="item-row" style="display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;-webkit-tap-highlight-color:rgba(255,255,255,0.1);">' + content + '</a>';
  }

  function itemRowEditable(c, valuesHtml, editHtml, linkHash) {
    var editBlock = editHtml ? '<div class="item-inline-edit">' + editHtml + '</div>' : '';
    var href = catLink(c.id, linkHash || '');
    return '<div class="item-row item-row-editable">' +
      '<a href="' + href + '" class="item-cat-name item-cat-link">' + alertDot(c.alert_level) + esc(c.name) + '</a>' +
      '<div class="item-values">' + valuesHtml + '</div>' +
      editBlock +
      '</div>';
  }

  function excretionEditBlockStool() {
    return '<div class="ov-ex-edit">' +
      '<select class="ov-inline-select ov-ex-sel-st">' + OPT_STOOL_STATUS + '</select>' +
      '<select class="ov-inline-select ov-ex-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-ex-inp-date">' +
      '<button type="button" class="btn btn-primary btn-ov-hr-save">保存</button>' +
      '<button type="button" class="btn btn-ov-hr-cancel">取消</button>' +
      '</div>';
  }

  function excretionEditBlockUrine() {
    return '<div class="ov-ex-edit">' +
      '<select class="ov-inline-select ov-ex-sel-ur">' + OPT_URINE_STATUS + '</select>' +
      '<select class="ov-inline-select ov-ex-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-ex-inp-date">' +
      '<button type="button" class="btn btn-primary btn-ov-hr-save">保存</button>' +
      '<button type="button" class="btn btn-ov-hr-cancel">取消</button>' +
      '</div>';
  }

  function buildStoolEntriesHtml(stoolArr) {
    var arr = stoolArr || [];
    if (arr.length === 0) return '<span class="dim">未記録</span>';
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (e.record_id) {
        var badgeSt = e.voice_input_id ? ' <small class="dim source-badge">音声</small>' : '';
        html += '<div class="ov-ex-row" data-record-id="' + escAttr(String(e.record_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="stool">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span>' + badgeSt;
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div>';
        html += excretionEditBlockStool();
        html += '</div>';
      } else if (e.voice_input_id) {
        html += '<div class="ov-ex-row ov-ex-voice-only" data-voice-input-id="' + escAttr(String(e.voice_input_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="stool">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span> <small class="dim source-badge">音声</small>';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div>';
        html += excretionEditBlockStool();
        html += '</div>';
      }
    }
    return html;
  }

  function buildUrineEntriesHtml(urineArr) {
    var arr = urineArr || [];
    if (arr.length === 0) return '<span class="dim">未記録</span>';
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      if (e.record_id) {
        var badgeUr = e.voice_input_id ? ' <small class="dim source-badge">音声</small>' : '';
        html += '<div class="ov-ex-row" data-record-id="' + escAttr(String(e.record_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="urine">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span>' + badgeUr;
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div>';
        html += excretionEditBlockUrine();
        html += '</div>';
      } else if (e.voice_input_id) {
        html += '<div class="ov-ex-row ov-ex-voice-only" data-voice-input-id="' + escAttr(String(e.voice_input_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="urine">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span> <small class="dim source-badge">音声</small>';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div>';
        html += excretionEditBlockUrine();
        html += '</div>';
      }
    }
    return html;
  }

  function renderItemCard_Stool() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">💩 排便 <small class="dim">直近3日</small></div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var stool = c.stool_today || [];
      html += itemRowEditable(c, '<div class="item-values-excretion">' + buildStoolEntriesHtml(stool) + '</div>', buildStoolInlineEdit(c));
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Urine() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🚽 排尿 <small class="dim">直近3日</small></div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var urine = c.urine_today || [];
      html += itemRowEditable(c, '<div class="item-values-excretion">' + buildUrineEntriesHtml(urine) + '</div>', buildUrineInlineEdit(c));
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
      html += itemRowEditable(c, wStr + aStr, buildWeightInlineEdit(c));
    }
    html += '</div></div>';
    return html;
  }

  /** 献立の meal_slot（DB英語キー）→ 短いラベル */
  function feedingMealSlotLabelJp(slot) {
    var s = slot == null ? '' : String(slot);
    var m = { morning: '☀朝', afternoon: '昼', evening: '夜', night: '夜', noon: '昼' };
    return m[s] || esc(s);
  }

  /** 猫詳細の給餌ブロックと同じデータ源（overview API）: プリセット名＋説明（献立の preset_id からも解決）＋食事カテゴリ注意メモ */
  function ovHtmlFeedingSyncedMemos(c) {
    var h = '';
    var pn = c.assigned_preset_name;
    var pd = c.assigned_preset_description;
    var hasName = pn != null && String(pn).trim();
    var hasDesc = pd != null && String(pd).trim();
    if (hasName || hasDesc) {
      h += '<div style="font-size:11px;color:var(--text-dim);line-height:1.35;margin:0 0 8px;padding:8px 10px;background:rgba(168,139,250,0.08);border-radius:8px;border-left:3px solid rgba(168,139,250,0.45);">';
      h += '<span style="font-weight:600;color:var(--primary,#a78bfa);">📝 プリセットメモ</span>';
      if (hasName) {
        h += '<br><span style="color:var(--text-main);font-weight:700;">' + esc(String(pn).trim()) + '</span>';
      }
      if (hasDesc) {
        h += '<br><span style="color:var(--text-main);white-space:pre-wrap;">' + esc(String(pd).trim()) + '</span>';
      } else if (hasName) {
        h += '<br><span class="dim" style="font-size:10px;">プリセット全体の説明・各フードのメモは未登録です</span>';
      }
      h += '</div>';
    }
    var fc = c.feeding_cat_notes || [];
    for (var fi = 0; fi < fc.length; fi++) {
      var rawEnt = fc[fi];
      var noteId = null;
      var fn = '';
      if (rawEnt && typeof rawEnt === 'object' && rawEnt.note != null) {
        fn = String(rawEnt.note || '').trim();
        if (rawEnt.id != null && rawEnt.id !== '') noteId = String(rawEnt.id);
      } else {
        fn = String(rawEnt || '').trim();
      }
      if (!fn) continue;
      h += '<div style="font-size:10px;color:var(--text-dim);line-height:1.35;margin:0 0 6px;padding:6px 8px;background:rgba(251,146,60,0.08);border-radius:6px;border-left:3px solid rgba(251,146,60,0.35);position:relative;">';
      h += '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;margin-bottom:2px;">';
      h += '<span style="font-weight:600;color:#fb923c;">🍽 食事メモ</span>';
      if (noteId) {
        h += '<button type="button" class="btn btn-outline btn-ov-feed-delmemo" style="font-size:9px;padding:1px 6px;line-height:1.2;flex-shrink:0;color:#f87171;border-color:rgba(248,113,113,0.5);" data-note-id="' + escAttr(noteId) + '" title="このメモを削除">削除</button>';
      }
      h += '</div><span style="color:var(--text-main);white-space:pre-wrap;">' + esc(fn) + '</span></div>';
    }
    return h;
  }

  function renderItemCard_FeedingCheck() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🍚 ごはん <small class="dim">あげた・残し</small></div>';
    html += '<div class="item-card-body">';
    html += '<div class="ov-feed-hint" style="font-size:11px;color:var(--text-dim);margin-bottom:8px;">献立の追加・編集・手動記録は「詳細」から行ってください。</div>';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var plan = c.feeding_plan || [];
      var inner = '';
      var toolbar = '<div class="ov-feed-toolbar" style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;width:100%;">' +
        '<button type="button" class="btn btn-outline btn-ov-feed-leftover" style="font-size:10px;padding:2px 6px;" data-cat-id="' + escAttr(String(c.id)) + '">🥄残し</button>' +
        '<a href="' + catLink(c.id, 'feedingArea') + '" class="btn btn-outline" style="font-size:10px;padding:2px 6px;text-decoration:none;">詳細</a>' +
        '</div>';
      var memoBlock = ovHtmlFeedingSyncedMemos(c);
      if (plan.length === 0) {
        inner = memoBlock + '<span class="dim">献立なし（詳細で設定）</span>';
      } else {
        inner = memoBlock;
        for (var j = 0; j < plan.length; j++) {
          var p = plan[j];
          var menu = esc(p.food_name || '—');
          if (p.amount_g != null && p.amount_g !== '') menu += ' <strong>' + esc(String(p.amount_g)) + 'g</strong>';
          var st = '';
          var pidStr = p.plan_id != null ? String(p.plan_id) : '';
          var logIdStr = p.log_id != null ? String(p.log_id) : '';
          var offeredGLogStr = p.offered_g_log != null ? String(p.offered_g_log) : '';
          var fedTm = p.fed_served_time ? ovFmtFedServedTime(p.fed_served_time) : '';
          if (p.fed_today) {
            st = '<span class="feed-done">✅</span>';
            if (fedTm) st += '<span class="dim" style="margin-left:3px;">🕐' + esc(fedTm) + '</span> ';
            if (p.eaten_pct_today != null && p.eaten_pct_today !== '') st += '<span class="dim">' + esc(String(p.eaten_pct_today)) + '%</span> ';
            if (logIdStr) {
              st += '<button type="button" class="btn btn-outline btn-ov-feed-editlog" style="font-size:10px;padding:1px 6px;" data-log-id="' + escAttr(logIdStr) + '" data-food-name="' + escAttr(p.food_name || '') + '" data-offered-g="' + escAttr(offeredGLogStr || String(p.amount_g || '')) + '" data-eaten-pct="' + escAttr(String(p.eaten_pct_today != null ? p.eaten_pct_today : 100)) + '" data-served-time="' + escAttr(fedTm || '') + '">✏️</button> ';
              st += '<button type="button" class="btn btn-outline btn-ov-feed-undofed" style="font-size:10px;padding:1px 6px;" data-log-id="' + escAttr(logIdStr) + '">取消</button> ';
            }
          } else if (pidStr) {
            st = '<button type="button" class="btn btn-primary btn-ov-feed-markfed" style="font-size:10px;padding:1px 8px;" data-plan-id="' + escAttr(pidStr) + '" data-food-name="' + escAttr(p.food_name || '') + '" data-amount-g="' + escAttr(String(p.amount_g || '')) + '">あげた</button> ';
          } else {
            st = '<span class="feed-pending">⬜</span> ';
          }
          inner += '<div class="ov-feed-line"><span class="ov-feed-slot">' + feedingMealSlotLabelJp(p.meal_slot) + '</span><span class="ov-feed-menu">' + menu + '</span><span class="ov-feed-status" style="text-align:right;">' + st + '</span></div>';
          if (p.notes && String(p.notes).trim()) {
            inner += '<div style="font-size:10px;color:var(--text-dim);margin:-2px 0 6px 0;padding:4px 8px 4px 28px;background:rgba(255,255,255,0.04);border-radius:4px;line-height:1.35;">📝 ' + esc(String(p.notes).trim()) + '</div>';
          }
        }
      }
      html += itemRowEditable(c, '<div class="item-values-medcol ov-feed-block" style="width:100%;">' + toolbar + inner + '</div>', '', '');
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
      html += itemRowEditable(c, careVals, buildCareInlineEdit(c));
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
      var tasks = c.tasks_today || { done: 0, total: 0, items: [] };
      var titems = tasks.items || [];

      var taskVals = '';
      if (tasks.total === 0) {
        taskVals = '<span class="dim">なし</span>';
      } else {
        taskVals = '<span class="' + (tasks.done >= tasks.total ? 'score-color-green' : tasks.done > 0 ? 'score-color-yellow' : 'score-color-red') + '" style="font-weight:700;">' + (tasks.done >= tasks.total ? '✅' : '⏳') + ' ' + tasks.done + '/' + tasks.total + '</span>';
        for (var j = 0; j < titems.length; j++) {
          var it = titems[j];
          var timeStr = '';
          if (it.due_time) {
            var ds = String(it.due_time);
            timeStr = '<span class="dim" style="margin-right:4px;">' + esc(ds.length >= 5 ? ds.slice(0, 5) : ds) + '</span>';
          }
          taskVals += '<div class="ov-task-line">' + timeStr + '<span class="ov-task-title">' + esc(it.title) + '</span>' +
            '<button type="button" class="btn btn-ov-task-done" data-task-id="' + escAttr(String(it.id)) + '">完了</button>' +
            '<button type="button" class="btn btn-ov-task-skip" data-task-id="' + escAttr(String(it.id)) + '">スキップ</button></div>';
        }
      }
      html += itemRowEditable(c, '<div class="item-values-medcol">' + taskVals + '</div>', '');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Meds() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">💊 本日の投薬状況</div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var meds = c.meds_today || { done: 0, total: 0, items: [] };
      var items = meds.items || [];
      var medVals = '';
      if (meds.total === 0) {
        medVals = '<span class="dim">投薬予定なし</span>';
      } else {
        var mc = meds.done >= meds.total ? 'score-color-green' : meds.done > 0 ? 'score-color-yellow' : 'score-color-red';
        var allIcon = meds.done >= meds.total ? '✅' : '⏳';
        medVals = '<span class="' + mc + '" style="font-weight:700;">' + allIcon + ' ' + meds.done + '/' + meds.total + ' 完了</span>';
        for (var j = 0; j < items.length; j++) {
          var it = items[j];
          var isDone = it.status === 'done';
          var isSkipped = it.status === 'skipped';
          var itemIcon = isDone ? '✅' : isSkipped ? '⏭️' : '🔴';
          var itemCls = isDone ? 'med-item-done' : isSkipped ? 'med-item-skip' : 'med-item-pending';
          medVals += '<span class="' + itemCls + '" style="font-size:12px;">' + itemIcon + ' ' + (it.slot ? '<b>' + esc(it.slot) + '</b> ' : '') + esc(it.name) + (it.dosage ? ' <small>' + esc(it.dosage) + '</small>' : '') + '</span>';
        }
      }
      html += itemRowEditable(c, '<div class="item-values-medcol">' + medVals + '</div>', '');
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
      if (anomalies.length === 0) {
        anomVals += '<span class="score-color-green" style="font-size:11px;">異常なし</span>';
      } else {
        for (var j = 0; j < anomalies.length; j++) {
          var a = anomalies[j];
          anomVals += '<span class="badge ' + (a.count >= 3 ? 'badge-red' : a.count >= 2 ? 'badge-orange' : 'badge-yellow') + '">' + esc(a.type) + ' x' + a.count + '</span>';
        }
      }
      html += itemRowReadonly(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + anomVals + '</div>');
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
      html += itemRowReadonly(c, '<div class="item-cat-name">' + alertDot(c.alert_level) + esc(c.name) + '</div><div class="item-values">' + medLongVals + '</div>');
    }
    html += '</div></div>';
    return html;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  ユーティリティ
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  function catLink(catId, hash) {
    var url = 'cat.html?id=' + encodeURIComponent(catId || '');
    if (hash) url += '#' + hash;
    return url;
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
