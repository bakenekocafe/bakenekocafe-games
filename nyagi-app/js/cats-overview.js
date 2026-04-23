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

  /** 排泄 API の record_date を YYYY-MM-DD に正規化 */
  function excretionRecordYmd(raw) {
    if (raw == null || raw === '') return '';
    var s = String(raw).trim();
    if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return '';
  }

  /** 当日以外の排便・排尿行（猫ごとカード内も項目ごとも共通） */
  function excretionPastRowClass(recordDateRaw) {
    var y = excretionRecordYmd(recordDateRaw);
    if (!y) return '';
    return y !== todayJstYmd() ? ' ov-ex-row-past' : '';
  }

  /** 摂取率が 0 以外（数値記録あり）→ 残し・ごはん行の % 表示をグレーに */
  function ovFeedPctNonZero(ep) {
    if (ep == null || ep === '') return false;
    var n = Number(ep);
    return !isNaN(n) && n !== 0;
  }

  function ovLeftoverGFromOfferedPct(offeredG, eatenPct) {
    if (offeredG == null || offeredG === '') return '';
    var og = parseFloat(offeredG);
    if (isNaN(og) || og <= 0) return '';
    if (eatenPct == null || eatenPct === '') return '';
    var ep = Number(eatenPct);
    if (isNaN(ep)) return '';
    return String(Math.round(og * (100 - ep) / 100 * 10) / 10);
  }

  function ovEatenPctFromOfferedLeftover(offeredG, leftoverGStr) {
    if (leftoverGStr == null || String(leftoverGStr).trim() === '') return null;
    var og = parseFloat(offeredG);
    if (isNaN(og) || og <= 0) return null;
    var lg = parseFloat(String(leftoverGStr).trim());
    if (isNaN(lg) || lg < 0) return null;
    if (lg > og) return -1;
    if (lg === 0) return 100;
    var pct = Math.round((og - lg) / og * 100);
    if (pct < 0) pct = 0;
    if (pct > 100) pct = 100;
    return pct;
  }

  /** feeding_logs.id の摂取率を更新（一覧インライン・完食／残し反映用） */
  function ovPutFedLogEatenPct(logId, eatenPct) {
    return fetch(feedingApiBase() + '/logs/' + encodeURIComponent(logId), {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ eaten_pct: eatenPct }),
    }).then(function (r) { return r.json(); });
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

  /** JST の現在時刻から 朝/昼/夜 を自動判定 */
  function currentJstSlot() {
    var h = parseInt(new Date().toLocaleTimeString('en-GB', {
      timeZone: 'Asia/Tokyo',
      hour: '2-digit',
      hour12: false,
    }), 10);
    if (h >= 5 && h < 12) return '朝';
    if (h >= 12 && h < 18) return '昼';
    return '夜';
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
  /** タスクの指定実行日用 M/D（曜） */
  function ovFmtTaskYmdWithWday(ymdRaw) {
    if (window.NyagiJst && typeof NyagiJst.formatYmdWithWday === 'function') {
      var j = NyagiJst.formatYmdWithWday(ymdRaw);
      if (j) return j;
    }
    var ymd = String(ymdRaw || '').slice(0, 10);
    if (ymd.length !== 10 || ymd.charAt(4) !== '-') return '';
    var parts = ymd.split('-');
    var y = parseInt(parts[0], 10);
    var mo = parseInt(parts[1], 10);
    var d = parseInt(parts[2], 10);
    if (isNaN(y) || isNaN(mo) || isNaN(d)) return fmtExcretionMdYmd(ymd);
    var dt = new Date(ymd + 'T12:00:00+09:00');
    var wk = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'long' }).format(dt);
    var wch = { Sunday: '日', Monday: '月', Tuesday: '火', Wednesday: '水', Thursday: '木', Friday: '金', Saturday: '土' }[wk] || '';
    return mo + '/' + d + (wch ? '（' + wch + '）' : '');
  }

  function ovHtmlTaskScheduledIf(item) {
    var sd = item.scheduled_date ? String(item.scheduled_date).slice(0, 10) : '';
    if (sd.length !== 10) return '';
    var lbl = ovFmtTaskYmdWithWday(sd);
    if (!lbl) return '';
    return '<span class="dim ov-task-scheduled" style="font-size:10px;margin-right:6px;white-space:nowrap;">実行 ' + esc(lbl) + '</span>';
  }

  function fmtExcretionMdYmd(ymd) {
    if (!ymd || ymd.length < 10) return '';
    var m = parseInt(ymd.slice(5, 7), 10);
    var d = parseInt(ymd.slice(8, 10), 10);
    if (isNaN(m) || isNaN(d)) return ymd.slice(5);
    return m + '/' + d;
  }

  /** 一覧の体重: いつの記録か（日本時間）。DB の created_at を優先 */
  function fmtWeightJstHtml(recordDateYmd, createdAtIso) {
    if (!recordDateYmd || String(recordDateYmd).length < 10) return '';
    var ymd = String(recordDateYmd).slice(0, 10);
    if (createdAtIso) {
      try {
        var d = new Date(createdAtIso);
        if (!isNaN(d.getTime())) {
          var s = d.toLocaleString('ja-JP', {
            timeZone: 'Asia/Tokyo',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
          });
          return '<div class="dim ov-weight-ts" style="font-size:9px;margin-top:3px;line-height:1.35;">' + esc(s) + ' <span style="opacity:.85;">（日本時間）</span></div>';
        }
      } catch (e) {}
    }
    var md = fmtExcretionMdYmd(ymd);
    return '<div class="dim ov-weight-ts" style="font-size:9px;margin-top:3px;line-height:1.35;">計測日 ' + esc(md || ymd) + ' <span style="opacity:.85;">（時刻情報なし）</span></div>';
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
  /** 排便6種・排尿7種（OPT_STOOL_STATUS / OPT_URINE_STATUS の空以外と同一文言） */
  var STOOL_STATUS_OPTIONS = ['健康', '硬い', '軟便', '下痢', '血便小', '血便大（異常）'];
  var URINE_STATUS_OPTIONS = ['なし（異常）', 'なし', '少量', '普通', '多い', '血尿小', '血尿大（異常）'];

  /** 編集ブロック内の状態グリッド（hidden + ボタン）。タップで hidden に値をセットし見た目を同期 */
  function syncExcretionStatusGridFromHidden(hiddenEl) {
    if (!hiddenEl || hiddenEl.tagName !== 'INPUT' || hiddenEl.type !== 'hidden') return;
    var grid = hiddenEl.nextElementSibling;
    if (!grid || !grid.classList || !grid.classList.contains('ov-ex-status-grid')) return;
    var v = hiddenEl.value || '';
    var btns = grid.querySelectorAll('.ov-ex-st-btn');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.classList.toggle('ov-ex-st-btn--on', (b.getAttribute('data-ex-value') || '') === v);
    }
  }

  function buildStoolStatusGridHtml(hiddenClasses) {
    var h = '<input type="hidden" class="' + hiddenClasses + '" value="">';
    h += '<div class="ov-ex-status-grid" data-ex-kind="stool" role="group" aria-label="排便の状態">';
    for (var si = 0; si < STOOL_STATUS_OPTIONS.length; si++) {
      var labS = STOOL_STATUS_OPTIONS[si];
      h += '<button type="button" class="ov-ex-st-btn" data-ex-value="' + escAttr(labS) + '">' + esc(labS) + '</button>';
    }
    h += '</div>';
    return h;
  }

  function buildUrineStatusGridHtml(hiddenClasses) {
    var h = '<input type="hidden" class="' + hiddenClasses + '" value="">';
    h += '<div class="ov-ex-status-grid" data-ex-kind="urine" role="group" aria-label="排尿の状態">';
    for (var ui = 0; ui < URINE_STATUS_OPTIONS.length; ui++) {
      var labU = URINE_STATUS_OPTIONS[ui];
      h += '<button type="button" class="ov-ex-st-btn" data-ex-value="' + escAttr(labU) + '">' + esc(labU) + '</button>';
    }
    h += '</div>';
    return h;
  }

  /** 猫1頭: 健康+自動スロット で即 POST */
  function ovQuickPostExcretionForCat(catId, kind, btn) {
    if (!catId) return;
    var slot = currentJstSlot();
    postHealthRecord({
      cat_id: catId,
      record_type: kind,
      record_date: todayJstYmd(),
      recorded_time: nowJstHm(),
      value: '健康',
      details: slot,
    }, btn);
  }

  /** 一括: 全猫 or 未記録の猫に 健康+自動スロット で順番に POST */
  function ovBulkPostExcretion(kind, btn, onlyEmpty) {
    var today = todayJstYmd();
    var slot = currentJstSlot();
    var targets = [];
    for (var ci = 0; ci < catsData.length; ci++) {
      var cat = catsData[ci];
      if (onlyEmpty) {
        var arr = kind === 'urine' ? (cat.urine_today || []) : (cat.stool_today || []);
        var hasToday = false;
        for (var hi = 0; hi < arr.length; hi++) {
          if ((arr[hi].record_date || '') === today) { hasToday = true; break; }
        }
        if (hasToday) continue;
      }
      targets.push(cat.id);
    }
    if (targets.length === 0) {
      alert(onlyEmpty ? '全員すでに本日の記録があります' : '対象の猫がありません');
      return;
    }
    var label = kind === 'urine' ? '排尿' : '排便';
    var msg = onlyEmpty
      ? ('本日まだ記録なしの ' + targets.length + ' 頭に ' + label + '「健康」（' + slot + '帯）を記録します。よろしいですか？')
      : ('表示中の全 ' + targets.length + ' 頭に ' + label + '「健康」（' + slot + '帯）を記録します（同日複数件になります）。よろしいですか？');
    if (!confirm(msg)) return;
    var prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    function bodyFor(cid) {
      return { cat_id: cid, record_type: kind, record_date: today, recorded_time: nowJstHm(), value: '健康', details: slot };
    }
    function runSeq(idx) {
      if (idx >= targets.length) {
        btn.disabled = false;
        btn.textContent = prevText;
        fetchCatsDataSilent();
        return;
      }
      postHealthRecordPromise(bodyFor(targets[idx]))
        .then(function (res) {
          if (!res.ok || (res.data && res.data.error)) {
            btn.disabled = false;
            btn.textContent = prevText;
            alert('エラー: ' + ((res.data && (res.data.message || res.data.error)) || 'HTTP'));
            return;
          }
          runSeq(idx + 1);
        })
        .catch(function () {
          btn.disabled = false;
          btn.textContent = prevText;
          alert('保存に失敗しました');
        });
    }
    runSeq(0);
  }

  function renderExcretionBulkBar(kind) {
    var emoji = kind === 'urine' ? '💧' : '💩';
    var label = kind === 'urine' ? '排尿' : '排便';
    var h = '<div class="ov-ex-bulk-bar" data-bulk-kind="' + kind + '">';
    h += '<div class="ov-ex-bulk-row">';
    h += '<button type="button" class="btn btn-primary btn-ov-ex-bulk-only">' + emoji + ' 未記録の猫を一括記録（健康）</button>';
    h += '<button type="button" class="btn btn-outline btn-ov-ex-bulk-all">全員追加</button>';
    h += '</div>';
    h += '<p class="dim ov-ex-bulk-sub">現在のJST時刻から帯（朝/昼/夜）を自動判定します</p>';
    h += '</div>';
    return h;
  }

  /** ワンタップまとめ記録（ブラシ・アゴ・耳・お尻・目ヤニ）。爪切り・肉球は個別フォームから */
  var OV_CARE_BUNDLE_SPECS = [
    { value: 'care:ブラシ', label: 'ブラシ' },
    { value: 'care:アゴ', label: 'アゴ' },
    { value: 'care:耳', label: '耳' },
    { value: 'care:お尻', label: 'お尻' },
    { value: 'eye_discharge:目ヤニ拭き', label: '目ヤニ拭き' },
  ];

  /** DB英語キー → フォーム選択肢（日本語） */
  var STOOL_EN_TO_JA = { normal: '健康', hard: '硬い', soft: '軟便', liquid: '下痢', recorded: '記録あり' };
  var URINE_EN_TO_JA = { normal: '普通', hard: '多い', soft: '少量', liquid: 'なし（異常）', recorded: '記録あり' };

  function excretionFormValue(kind, raw) {
    var s = raw == null ? '' : String(raw);
    if (kind === 'urine') return URINE_EN_TO_JA[s] || s;
    return STOOL_EN_TO_JA[s] || s;
  }

  var _ovInlineHandlersBound = false;

  var _ovFeedCtx = null;
  var _ovFoodsCache = null;
  var _ovFoodsSpecies = null;
  var _ovEditingPlanId = null;
  var _ovApFoodPickerBound = false;
  var _ovApFoodsForPicker = [];

  function feedingApiBase() {
    return apiOpsBase() + '/feeding';
  }

  function ovFindCat(catId) {
    for (var i = 0; i < catsData.length; i++) {
      if (String(catsData[i].id) === String(catId)) return catsData[i];
    }
    return null;
  }

  function ovCloseAddPlanModal() {
    _ovEditingPlanId = null;
    var m = document.getElementById('ovAddPlanModal');
    if (m) m.classList.remove('open');
  }

  function ovCloseFlModal() {
    var m = document.getElementById('ovFeedingLogModal');
    if (m) m.classList.remove('open');
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

  function ovFoodPickerLabel(f) {
    if (!f) return '';
    return (f.brand ? f.brand + ' ' : '') + (f.name || f.id);
  }

  function ovFoodPickerHaystack(f) {
    var parts = [f.name, f.brand, f.id];
    if (f.product_code != null && String(f.product_code) !== '') parts.push(String(f.product_code));
    return parts.join(' ').toLowerCase();
  }

  function ovApplyAddPlanFoodPick(foodId, label) {
    var hid = document.getElementById('ovApFoodId');
    var inp = document.getElementById('ovApFoodSearch');
    if (hid) hid.value = foodId != null ? String(foodId) : '';
    if (inp) {
      inp.value = label != null ? String(label) : '';
      if (label) inp.setAttribute('data-ov-selected-label', String(label));
      else inp.removeAttribute('data-ov-selected-label');
    }
    var list = document.getElementById('ovApFoodList');
    if (list) list.innerHTML = '';
  }

  function ovRenderAddPlanFoodList(query) {
    var list = document.getElementById('ovApFoodList');
    if (!list) return;
    var q = String(query || '').trim().toLowerCase();
    list.innerHTML = '';
    if (!q) {
      var hint = document.createElement('div');
      hint.className = 'dim';
      hint.style.cssText = 'padding:10px 12px;font-size:12px;line-height:1.4;';
      hint.textContent = 'フード名・ブランドなどで入力すると候補が表示されます。';
      list.appendChild(hint);
      return;
    }
    var foods = _ovApFoodsForPicker;
    var matched = [];
    for (var i = 0; i < foods.length; i++) {
      if (ovFoodPickerHaystack(foods[i]).indexOf(q) >= 0) matched.push(foods[i]);
      if (matched.length >= 80) break;
    }
    if (!matched.length) {
      var empty = document.createElement('div');
      empty.className = 'dim';
      empty.style.cssText = 'padding:10px 12px;font-size:12px;';
      empty.textContent = '該当するフードがありません。';
      list.appendChild(empty);
      return;
    }
    for (var j = 0; j < matched.length; j++) {
      var f = matched[j];
      var fid = String(f.id);
      var lbl = ovFoodPickerLabel(f);
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ov-ap-food-row';
      btn.setAttribute('data-food-id', fid);
      btn.textContent = lbl;
      btn.addEventListener('click', function (ev) {
        var el = ev.currentTarget;
        ovApplyAddPlanFoodPick(el.getAttribute('data-food-id'), el.textContent);
      });
      list.appendChild(btn);
    }
  }

  function ovBindAddPlanFoodPicker() {
    if (_ovApFoodPickerBound) return;
    var inp = document.getElementById('ovApFoodSearch');
    if (!inp) return;
    _ovApFoodPickerBound = true;
    inp.addEventListener('input', function () {
      var hid = document.getElementById('ovApFoodId');
      var selL = inp.getAttribute('data-ov-selected-label') || '';
      if (hid && selL && String(inp.value) !== selL) hid.value = '';
      ovRenderAddPlanFoodList(inp.value);
    });
    inp.addEventListener('focus', function () {
      ovRenderAddPlanFoodList(inp.value);
    });
  }

  /** 献立追加・プリセット項目編集モーダル用。presetFoodId があれば選択状態を復元 */
  function ovFillAddPlanFoodPicker(presetFoodId) {
    ovBindAddPlanFoodPicker();
    ovEnsureFoods(function (foods) {
      _ovApFoodsForPicker = foods || [];
      var hid = document.getElementById('ovApFoodId');
      var inp = document.getElementById('ovApFoodSearch');
      var list = document.getElementById('ovApFoodList');
      if (hid) hid.value = '';
      if (inp) {
        inp.value = '';
        inp.removeAttribute('data-ov-selected-label');
      }
      if (list) list.innerHTML = '';
      if (presetFoodId != null && String(presetFoodId) !== '') {
        var fid = String(presetFoodId);
        var found = null;
        for (var i = 0; i < foods.length; i++) {
          if (String(foods[i].id) === fid) {
            found = foods[i];
            break;
          }
        }
        if (found) {
          ovApplyAddPlanFoodPick(found.id, ovFoodPickerLabel(found));
        } else {
          if (hid) hid.value = fid;
          if (inp) {
            var fallback = '（ID: ' + fid + '）';
            inp.value = fallback;
            inp.setAttribute('data-ov-selected-label', fallback);
          }
        }
      }
      ovRenderAddPlanFoodList(inp ? inp.value : '');
    });
  }

  function ovOpenAddPlanModal(catId, defaultSlot, editPlanId) {
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
    ovFillAddPlanFoodPicker(editP && editP.food_id ? editP.food_id : null);
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
    if (document.getElementById('ovFlLeftoverG')) document.getElementById('ovFlLeftoverG').value = '';
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
    if (!foodId || !amountG) { alert('フードと量は必須です'); return; }
    var notesPlan = (notes != null && String(notes).trim() !== '') ? String(notes).trim() : null;
    var payload = { cat_id: _ovFeedCtx.catId, food_id: foodId, meal_slot: slot, amount_g: amountG, notes: notesPlan, scheduled_time: null };
    var url = feedingApiBase() + '/plans';
    var method = 'POST';
    if (_ovEditingPlanId) {
      url = feedingApiBase() + '/plans/' + encodeURIComponent(_ovEditingPlanId);
      method = 'PUT';
      payload = { food_id: foodId, meal_slot: slot, amount_g: amountG, notes: notesPlan, scheduled_time: null };
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
    var leftoverStr = document.getElementById('ovFlLeftoverG') && String(document.getElementById('ovFlLeftoverG').value).trim();
    if (!logDate || !mealSlot) { alert('日付と食事区分は必須です'); return; }
    if (!foodId || !offeredG) { alert('フードとあげた量は必須です'); return; }
    var eatenPct = null;
    if (leftoverStr !== '') {
      var pctO = ovEatenPctFromOfferedLeftover(parseFloat(offeredG), leftoverStr);
      if (pctO === -1) { alert('残した量が提供量を超えています'); return; }
      if (pctO === null) { alert('あげた量を確認してください'); return; }
      eatenPct = pctO;
    }
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
        eaten_pct: eatenPct,
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
  var _ovQfPlanAmountG = null;

  function ovOpenQuickFedModal(planId, foodName, amountG) {
    _ovQfPlanId = planId;
    var amgParse = amountG != null && String(amountG).trim() !== '' ? parseFloat(amountG) : NaN;
    _ovQfPlanAmountG = !isNaN(amgParse) && amgParse > 0 ? amgParse : null;
    var t = document.getElementById('ovQfTitle');
    if (t) t.textContent = '🍚 あげた記録';
    var fn = document.getElementById('ovQfFoodName');
    if (fn) fn.textContent = foodName || '—';
    var og = document.getElementById('ovQfOfferedG');
    if (og) og.value = amountG || '';
    var lfg = document.getElementById('ovQfLeftG');
    if (lfg) lfg.value = '';
    var qfst = document.getElementById('ovQfServedTime');
    if (qfst) qfst.value = nowJstHm();
    var m = document.getElementById('ovQuickFedModal');
    if (m) m.classList.add('open');
  }

  function ovCloseQuickFedModal() {
    _ovQfPlanId = null;
    _ovQfPlanAmountG = null;
    var m = document.getElementById('ovQuickFedModal');
    if (m) m.classList.remove('open');
  }

  function ovSubmitQuickFed(deferIntake) {
    if (!_ovQfPlanId) return;
    deferIntake = !!deferIntake;
    var og = document.getElementById('ovQfOfferedG');
    var offeredG = og && String(og.value).trim() !== '' ? parseFloat(og.value) : null;
    var qfst2 = document.getElementById('ovQfServedTime');
    var stQf = qfst2 && qfst2.value ? qfst2.value : nowJstHm();
    var payload = { log_date: todayJstYmd(), served_time: stQf };
    if (offeredG != null && !isNaN(offeredG) && offeredG > 0) payload.offered_g = offeredG;
    if (!deferIntake) {
      var lfin = document.getElementById('ovQfLeftG');
      var leftStr = lfin && lfin.value != null ? String(lfin.value).trim() : '';
      // 空欄＝サーバで摂取0%。残りgで％算出。0 入力＝完食(100%)。
      if (leftStr !== '') {
        var leftG = parseFloat(leftStr);
        if (isNaN(leftG) || leftG < 0) {
          alert('残り量は0以上の数値にしてください');
          return;
        }
        var effectiveOff = offeredG != null && !isNaN(offeredG) && offeredG > 0 ? offeredG : _ovQfPlanAmountG;
        if (effectiveOff != null && leftG > effectiveOff) {
          alert('残りが提供量(' + effectiveOff + 'g)を超えています');
          return;
        }
        payload.leftover_g = leftG;
      }
    }
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
    var lgEl = document.getElementById('ovElLeftoverG');
    if (lgEl) {
      lgEl.value = ovLeftoverGFromOfferedPct(offeredG, eatenPct);
    }
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
    var lgInp = document.getElementById('ovElLeftoverG');
    var offeredG = og && og.value ? parseFloat(og.value) : null;
    var leftoverStr = lgInp && lgInp.value != null ? String(lgInp.value).trim() : '';
    var eatenPct = null;
    if (leftoverStr !== '') {
      var pctE = ovEatenPctFromOfferedLeftover(offeredG, leftoverStr);
      if (pctE === -1) { alert('残した量が提供量を超えています'); return; }
      if (pctE === null) { alert('あげた量を入力してください'); return; }
      eatenPct = pctE;
    }
    var elst2 = document.getElementById('ovElServedTime');
    var stEl = elst2 && elst2.value ? elst2.value : nowJstHm();
    var payload = { served_time: stEl, eaten_pct: eatenPct };
    if (offeredG != null) payload.offered_g = offeredG;
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

  /** カンマ区切りの feeding_logs.id を順に削除。1件のみは確認なし（チェック外し取り消し用）、複数は確認 */
  function ovUndoFedLogs(idCsv) {
    var ids = String(idCsv || '').split(',').map(function (x) { return parseInt(x.trim(), 10); }).filter(function (n) { return !isNaN(n); });
    if (ids.length === 0) return;
    if (ids.length > 1) {
      if (!confirm('この献立の本日の「あげた」記録が ' + ids.length + ' 件あります。まとめて取り消しますか？')) return;
    }
    function deleteAt(i) {
      if (i >= ids.length) {
        fetchData(0);
        if (_ovLoCatId) ovFillLeftoverModalBody(_ovLoCatId);
        return;
      }
      fetch(feedingApiBase() + '/logs/' + encodeURIComponent(ids[i]), { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) {
            alert('エラー: ' + (data.message || data.error));
            fetchData(0);
            return;
          }
          deleteAt(i + 1);
        }).catch(function () {
          alert('取り消しに失敗しました');
          fetchData(0);
        });
    }
    setTimeout(function () { deleteAt(0); }, 0);
  }

  function ovUndoFedLog(logId) {
    if (!logId) return;
    ovUndoFedLogs(String(logId));
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
    if (x === '夜' || x === 'evening' || x === 'night' || x === 'dinner' || x === '夕' || x === '晩' || x === 'pm') return 'evening';
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

  /** 項目ごと・ごはん: 朝列 / 夜列（昼・おやつ・未分類は other） */
  function ovFeedPlanColumnBucket(slot) {
    var n = ovNormMealSlot(slot);
    if (n === 'morning') return 'am';
    if (n === 'evening') return 'pm';
    return 'other';
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

  /** 残しモーダル用：献立名の重複判定（手動ログの冗長行をまとめる） */
  function ovNormFoodKeyForLeftover(name) {
    return String(name == null ? '' : name).replace(/[\s\u3000]+/g, ' ').trim().toLowerCase();
  }
  function ovLeftoverOrphanDedupeKey(log) {
    var st = log.served_time != null && log.served_time !== '' ? String(log.served_time) : '';
    return ovNormFoodKeyForLeftover(log.food_name) + '\x1f' + String(log.offered_g != null && log.offered_g !== '' ? log.offered_g : '') + '\x1f' + st;
  }

  /** 夜献立の「同一メニュー」判定（プリセット重複で plan 行だけ8件あるケースを1行に潰す） */
  function ovEveningPlanMenuKey(plan) {
    var fid = plan.food_id != null && plan.food_id !== '' ? String(plan.food_id) : '';
    var nm = ovNormFoodKeyForLeftover(plan.food_name);
    var ag = plan.amount_g != null && plan.amount_g !== '' ? String(plan.amount_g) : '';
    var st = plan.scheduled_time != null && plan.scheduled_time !== '' ? String(plan.scheduled_time) : '';
    return fid + '\x1f' + nm + '\x1f' + ag + '\x1f' + st;
  }

  function ovMaxLogIdForPlan(logs, planIdStr) {
    var m = -1;
    for (var i = 0; i < logs.length; i++) {
      if (logs[i].plan_id == null || String(logs[i].plan_id) !== planIdStr) continue;
      var idn = Number(logs[i].id);
      if (!isNaN(idn) && idn > m) m = idn;
    }
    return m;
  }

  /**
   * 同一メニューの夜献立が複数行あるとき代表1行にまとめ、ログの plan_id をその献立に寄せる（表示・紐づけ用のコピーのみ。DBのログは変更しない）。
   * 代表献立は「その plan に昨日の夜ログのうち最大 id がある行」を優先し、無ければ plan_id が小さい行。
   */
  function ovCollapseDuplicateEveningPlans(plans, logs) {
    plans = plans || [];
    logs = logs || [];
    var groups = {};
    var order = [];
    for (var pi = 0; pi < plans.length; pi++) {
      var pl = plans[pi];
      var k = ovEveningPlanMenuKey(pl);
      if (!groups[k]) {
        groups[k] = [];
        order.push(k);
      }
      groups[k].push(pl);
    }
    var remap = {};
    var winners = [];
    for (var oi = 0; oi < order.length; oi++) {
      var key = order[oi];
      var arr = groups[key];
      if (arr.length === 1) {
        winners.push(arr[0]);
        continue;
      }
      var bestIdx = 0;
      var bestScore = ovMaxLogIdForPlan(logs, String(arr[0].plan_id));
      for (var j = 1; j < arr.length; j++) {
        var sc = ovMaxLogIdForPlan(logs, String(arr[j].plan_id));
        if (sc > bestScore) {
          bestScore = sc;
          bestIdx = j;
        } else if (sc === bestScore && bestScore < 0) {
          var idA = Number(arr[bestIdx].plan_id);
          var idB = Number(arr[j].plan_id);
          if (isNaN(idA)) idA = 0;
          if (isNaN(idB)) idB = 0;
          if (idB < idA) bestIdx = j;
        }
      }
      var win = arr[bestIdx];
      winners.push(win);
      for (var t = 0; t < arr.length; t++) {
        if (t === bestIdx) continue;
        remap[String(arr[t].plan_id)] = win.plan_id;
      }
    }
    var logsOut = [];
    for (var li = 0; li < logs.length; li++) {
      var L = logs[li];
      var pid = L.plan_id != null && L.plan_id !== '' ? String(L.plan_id) : '';
      if (pid && Object.prototype.hasOwnProperty.call(remap, pid)) {
        var L2 = {};
        for (var k in L) {
          if (Object.prototype.hasOwnProperty.call(L, k)) L2[k] = L[k];
        }
        L2.plan_id = remap[pid];
        logsOut.push(L2);
      } else {
        logsOut.push(L);
      }
    }
    return { plansOut: winners, logsOut: logsOut };
  }

  /**
   * 昨夜ブロック用：献立＋昨日ログを1行にまとめる。
   * - 同一 plan_id に複数ログがあるときは id が最大の1件のみを献立行に使い、他は孤児行に出さない（二重表示の主因）。
   * - plan_id なしで同一フード名・同一 offered_g のログが複数あるときは最新 id のみ残す（手動の重複記録想定）。猫詳細の1献立＝1ログの見え方に寄せる。
   */
  function ovBuildLeftoverItems(plans, logs) {
    plans = plans || [];
    logs = logs || [];
    var skipLogIds = {};

    var byPid = {};
    for (var li = 0; li < logs.length; li++) {
      var lg0 = logs[li];
      if (lg0.plan_id == null || lg0.plan_id === '') continue;
      var pk = String(lg0.plan_id);
      if (!byPid[pk]) byPid[pk] = [];
      byPid[pk].push(lg0);
    }
    var logByPlanId = {};
    for (var pkk in byPid) {
      var arrP = byPid[pkk];
      if (arrP.length === 1) {
        logByPlanId[pkk] = arrP[0];
      } else {
        arrP.sort(function (a, b) { return (Number(b.id) || 0) - (Number(a.id) || 0); });
        logByPlanId[pkk] = arrP[0];
        for (var tp = 1; tp < arrP.length; tp++) {
          if (arrP[tp].id != null) skipLogIds[String(arrP[tp].id)] = true;
        }
      }
    }

    var byOrphan = {};
    for (var lj = 0; lj < logs.length; lj++) {
      var g0 = logs[lj];
      if (g0.plan_id != null && g0.plan_id !== '') continue;
      if (g0.id == null) continue;
      var ok = ovLeftoverOrphanDedupeKey(g0);
      if (!byOrphan[ok]) byOrphan[ok] = [];
      byOrphan[ok].push(g0);
    }
    for (var okk in byOrphan) {
      var oarr = byOrphan[okk];
      if (oarr.length <= 1) continue;
      oarr.sort(function (a, b) { return (Number(b.id) || 0) - (Number(a.id) || 0); });
      for (var uo = 1; uo < oarr.length; uo++) {
        if (oarr[uo].id != null) skipLogIds[String(oarr[uo].id)] = true;
      }
    }

    var items = [];
    var usedLogIds = {};
    for (var pi = 0; pi < plans.length; pi++) {
      var plan = plans[pi];
      var pid = plan.plan_id;
      if (pid == null) continue;
      var lg = logByPlanId[String(pid)] || null;
      items.push({ plan: plan, log: lg });
      if (lg && lg.id != null) usedLogIds[String(lg.id)] = true;
    }
    for (var lli = 0; lli < logs.length; lli++) {
      var ent = logs[lli];
      var lid = ent.id != null ? String(ent.id) : '';
      if (lid && skipLogIds[lid]) continue;
      if (!ent.plan_id) {
        items.push({ plan: null, log: ent });
        if (lid) usedLogIds[lid] = true;
      } else if (lid && !usedLogIds[lid]) {
        items.push({ plan: null, log: ent });
        usedLogIds[lid] = true;
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

    var isLoMuted = !!(log && ovFeedPctNonZero(log.eaten_pct));
    var loCol = isLoMuted ? '#6b7280' : '#4ade80';
    var html = '<div style="background:rgba(0,0,0,.04);border-radius:6px;padding:5px 7px;margin-bottom:4px;' + (isLoMuted ? 'color:#6b7280;' : '') + '">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:2px;gap:6px;">';
    html += '<span style="font-weight:600;font-size:12px;line-height:1.25;">' + esc(foodName) + '</span>';
    if (offG) html += '<span class="dim" style="font-size:10px;' + (isLoMuted ? 'color:#6b7280;' : '') + '">提供 ' + esc(String(offG)) + 'g</span>';
    html += '</div>';

    if (log && log.eaten_pct !== null && log.eaten_pct !== undefined && log.eaten_pct < 100) {
      var leftG = Math.round(offG * (100 - log.eaten_pct) / 100 * 10) / 10;
      var ateG = Math.round(offG * log.eaten_pct / 100 * 10) / 10;
      html += '<div style="font-size:10px;color:' + loCol + ';margin-bottom:2px;line-height:1.3;">✅ ' + log.eaten_pct + '% 食べた（' + ateG + 'g） / 残り ' + leftG + 'g</div>';
    } else if (log && log.eaten_pct === 100) {
      html += '<div style="font-size:10px;color:' + loCol + ';margin-bottom:2px;line-height:1.3;">✅ 完食</div>';
    } else if (log && (log.eaten_pct === null || log.eaten_pct === undefined)) {
      html += '<div style="font-size:10px;color:#fbbf24;margin-bottom:2px;line-height:1.3;">摂取 0%（未確認）</div>';
    }

    html += '<div class="ov-lo-row">';
    html += '<div class="ov-lo-row-fill">';
    html += '<label class="dim ov-lo-lbl" style="' + (isLoMuted ? 'color:#6b7280;' : '') + '">残り</label>';
    html += '<input type="number" id="' + escAttr(inputId) + '" class="form-input ov-lo-ginp" style="' + (isLoMuted ? 'color:var(--text-main);' : '') + '" min="0" step="0.1" placeholder="g"';
    if (offG) html += ' max="' + escAttr(String(offG)) + '"';
    html += ' value="' + escAttr(prefillLeft) + '">';
    html += '</div>';
    if (logId) {
      html += '<div class="ov-lo-actions">';
      html += '<button type="button" class="btn btn-outline ov-lo-act ov-lo-save-log" data-log-id="' + escAttr(logId) + '" data-offered-g="' + escAttr(String(offG)) + '" data-input-id="' + escAttr(inputId) + '">保存</button>';
      html += '<button type="button" class="btn btn-outline ov-lo-act ov-lo-complete-log" data-log-id="' + escAttr(logId) + '">完食</button>';
      html += '<button type="button" class="btn btn-outline ov-lo-act btn-ov-feed-undofed" data-log-id="' + escAttr(logId) + '">取消</button>';
      html += '</div>';
    } else if (planId) {
      html += '<div class="ov-lo-actions">';
      html += '<button type="button" class="btn btn-outline ov-lo-act ov-lo-save-plan" data-plan-id="' + escAttr(planId) + '" data-offered-g="' + escAttr(String(offG)) + '" data-log-date="' + escAttr(logDateStr) + '" data-input-id="' + escAttr(inputId) + '">保存</button>';
      html += '<button type="button" class="btn btn-outline ov-lo-act ov-lo-complete-plan" data-plan-id="' + escAttr(planId) + '" data-log-date="' + escAttr(logDateStr) + '">完食</button>';
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function ovRenderLeftoverSection(label, items, logDateStr, secKey) {
    var html = '<div style="margin-bottom:8px;">';
    html += '<div style="font-weight:700;font-size:11px;margin-bottom:4px;border-bottom:1px solid rgba(255,255,255,0.08);padding-bottom:3px;">' + esc(label) + '</div>';
    if (items.length === 0) {
      html += '<div class="dim" style="font-size:10px;padding:2px 0;line-height:1.35;">献立・ログともにありません</div>';
    } else {
      for (var ri = 0; ri < items.length; ri++) {
        html += ovRenderLeftoverItemRow(items[ri], logDateStr, secKey, ri);
      }
    }
    html += '</div>';
    return html;
  }

  /** 昨日（JST）の feeding_logs 一覧＋取消（猫一覧には出さず 🥄残し モーダル内のみ）。夜枠は「昨夜の夜ごはん」に一本化し二重表示を避ける */
  function ovRenderYesterdayFedUndoFromLogs(yLogsAll) {
    if (!yLogsAll || yLogsAll.length === 0) return '';
    var h = '<div class="ov-yesterday-fed-in-modal" style="margin-bottom:8px;padding:6px 8px;background:rgba(251,191,36,0.08);border-radius:8px;border-left:3px solid rgba(251,191,36,0.45);">';
    h += '<div style="font-weight:700;font-size:11px;margin-bottom:4px;color:var(--text-main);line-height:1.3;">📅 昨日のあげた <span class="dim" style="font-weight:500;font-size:10px;">（朝・昼・取消）</span></div>';
    var any = false;
    for (var yi = 0; yi < yLogsAll.length; yi++) {
      var lg = yLogsAll[yi];
      if (ovIsEveningMealSlot(lg.meal_slot)) continue;
      var lid = lg.id != null ? String(lg.id) : (lg.log_id != null ? String(lg.log_id) : '');
      if (!lid) continue;
      any = true;
      var fn = lg.food_name ? String(lg.food_name) : '—';
      var pct = lg.eaten_pct != null && lg.eaten_pct !== '' ? String(lg.eaten_pct) + '%' : '';
      var offG = lg.offered_g != null && lg.offered_g !== '' ? String(lg.offered_g) + 'g' : '';
      var st = lg.served_time ? ovFmtFedServedTime(lg.served_time) : '';
      h += '<div class="ov-feed-line" style="margin-bottom:2px;font-size:11px;">';
      h += '<span class="ov-feed-slot">' + feedingMealSlotLabelJp(lg.meal_slot) + '</span>';
      h += '<span class="ov-feed-menu">' + esc(fn) + (offG ? ' <strong>' + esc(offG) + '</strong>' : '') + '</span>';
      h += '<span class="ov-feed-status">';
      if (pct) {
        var epY = lg.eaten_pct != null && lg.eaten_pct !== '' ? Number(lg.eaten_pct) : NaN;
        var pctGray = !isNaN(epY) && epY !== 0;
        h += '<span class="dim" style="' + (pctGray ? 'color:#6b7280 !important;' : '') + '">' + esc(pct) + '</span> ';
      }
      if (st) h += '<span class="dim" style="margin-right:4px;">🕐' + esc(st) + '</span>';
      h += '<button type="button" class="btn btn-outline btn-ov-feed-undofed" data-log-id="' + escAttr(lid) + '">取消</button>';
      h += '</span></div>';
    }
    h += '</div>';
    return any ? h : '';
  }

  function ovFillLeftoverModalBody(catId) {
    var c = ovFindCat(catId);
    var body = document.getElementById('ovLoBody');
    if (!body) return;
    if (!c) {
      body.innerHTML = '<p style="text-align:center;color:#c44;padding:10px;font-size:11px;">猫データがありません</p>';
      return;
    }

    var yesterdayStr = yesterdayJstYmd();
    var base = feedingApiBase() + '/logs?cat_id=' + encodeURIComponent(catId);

    fetch(base + '&date=' + yesterdayStr, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (yRes) {
      var yLogsAll = yRes.logs || [];

      var prevNightLogs = ovFilterLogsBySlot(yLogsAll, ovIsEveningMealSlot);
      var itemsPrev = ovBuildLeftoverItems([], prevNightLogs);

      var html = '';
      html += '<p class="dim" style="font-size:10px;line-height:1.35;margin:0 0 6px;padding:0 2px;">昨日の「あげた」の取消と、<strong>昨夜分</strong>の残りg。当日分は一覧の献立から入力してください。</p>';
      html += ovRenderYesterdayFedUndoFromLogs(yLogsAll);
      html += ovRenderLeftoverSection('🌙 昨夜の夜ごはん', itemsPrev, yesterdayStr, 'prev');
      body.innerHTML = html;
    }).catch(function () {
      body.innerHTML = '<p style="text-align:center;color:#c44;padding:10px;font-size:11px;">読込失敗</p>';
    });
  }

  function ovOpenLeftoverModal(catId) {
    _ovLoCatId = catId;
    var c = ovFindCat(catId);
    var catName = c ? c.name : '';
    var t = document.getElementById('ovLoTitle');
    if (t) t.textContent = '🥄 残し記録 — ' + catName;
    var body = document.getElementById('ovLoBody');
    if (body) body.innerHTML = '<p style="text-align:center;color:#aaa;padding:10px;font-size:11px;">読込中…</p>';
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
    var undofedM = t.closest('.btn-ov-feed-undofed');
    if (undofedM) {
      ev.preventDefault();
      var lidMCsv = undofedM.getAttribute('data-log-ids') || undofedM.getAttribute('data-log-id');
      if (lidMCsv) ovUndoFedLogs(lidMCsv);
      return;
    }
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
    ovBindAddPlanFoodPicker();
    var c2 = document.getElementById('ovCloseFlBtn');
    if (c2 && !c2._ovBound) { c2._ovBound = true; c2.addEventListener('click', ovCloseFlModal); }
    var s2 = document.getElementById('ovSubmitFlBtn');
    if (s2 && !s2._ovBound) { s2._ovBound = true; s2.addEventListener('click', ovSubmitFeedingLog); }
    var cqf = document.getElementById('ovCloseQfBtn');
    if (cqf && !cqf._ovBound) { cqf._ovBound = true; cqf.addEventListener('click', ovCloseQuickFedModal); }
    var sqf = document.getElementById('ovSubmitQfBtn');
    if (sqf && !sqf._ovBound) { sqf._ovBound = true; sqf.addEventListener('click', function () { ovSubmitQuickFed(false); }); }
    var sqfd = document.getElementById('ovSubmitQfDeferBtn');
    if (sqfd && !sqfd._ovBound) { sqfd._ovBound = true; sqfd.addEventListener('click', function () { ovSubmitQuickFed(true); }); }
    var cel = document.getElementById('ovCloseElBtn');
    if (cel && !cel._ovBound) { cel._ovBound = true; cel.addEventListener('click', ovCloseEditLogModal); }
    var sel = document.getElementById('ovSubmitElBtn');
    if (sel && !sel._ovBound) { sel._ovBound = true; sel.addEventListener('click', ovSubmitEditLog); }
    var clo = document.getElementById('ovCloseLoBtn');
    if (clo && !clo._ovBound) { clo._ovBound = true; clo.addEventListener('click', ovCloseLeftoverModal); }
    var loM = document.getElementById('ovLeftoverModal');
    if (loM && !loM._ovBound) { loM._ovBound = true; loM.addEventListener('click', ovLeftoverModalClick); }
  }

  function _removed_ovHandlePresetModalClick_placeholder(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var cnp = t.closest('[data-ov-cancel-new-preset-desc]');
    if (cnp && _ovFeedCtx) {
      ev.preventDefault();
      _ovPendingNewPreset = null;
      ovFillPresetManageModal(ovGetStoredPresetLocation());
      return;
    }
    var snp = t.closest('[data-ov-submit-new-preset-desc]');
    if (snp && _ovFeedCtx && _ovPendingNewPreset) {
      ev.preventDefault();
      var taNp = document.getElementById('ovNewPresetDescTa');
      var rawNp = taNp ? String(taNp.value) : '';
      var descNp = rawNp.trim() === '' ? null : rawNp.trim();
      var locNp = _ovPendingNewPreset.location_id;
      var nameNp = _ovPendingNewPreset.name;
      _ovPendingNewPreset = null;
      fetch(feedingApiBase() + '/presets', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({
          name: nameNp,
          description: descNp,
          location_id: locNp,
          species: _ovFeedCtx.species || 'cat',
        }),
      }).then(function (r) {
        return r.text().then(function (text) {
          var data = {};
          if (text) {
            try {
              data = JSON.parse(text);
            } catch (_) {
              alert('作成に失敗しました（応答の解析エラー） HTTP ' + r.status);
              return null;
            }
          }
          if (!r.ok) {
            alert('エラー: ' + (data.message || data.error || ('HTTP ' + r.status)));
            return null;
          }
          return data;
        });
      }).then(function (data) {
        if (!data) return;
        if (data.error) {
          alert('エラー: ' + (data.message || data.error));
          return;
        }
        if (data.preset && data.preset.id) {
          _ovPendingPresetItem = String(data.preset.id);
          _ovEditingPresetItemId = null;
          ovOpenAddPlanModal(_ovFeedCtx.catId, 'morning', null, { preservePendingPreset: true });
          var t0 = document.querySelector('#ovAddPlanModal .modal-title');
          if (t0) t0.innerHTML = '📋 プリセットにフード追加 <span class="dim">' + esc(nameNp) + '</span>';
        } else {
          alert('エラー: プリセット情報が返りませんでした');
          ovFillPresetManageModal(ovGetStoredPresetLocation());
        }
      }).catch(function (e) {
        alert('作成に失敗しました: ' + (e && e.message ? e.message : 'network'));
      });
      return;
    }
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
    var apOne = t.closest('[data-ov-apply-preset-item]');
    if (apOne && _ovFeedCtx) {
      ev.preventDefault();
      var rawPair = apOne.getAttribute('data-ov-apply-preset-item') || '';
      var parts = rawPair.split(':');
      var itemId = parts.length >= 2 ? parseInt(parts[1], 10) : NaN;
      if (isNaN(itemId)) return;
      if (!confirm('この1品だけ献立に追加しますか？（この猫にこのプリセットが紐づいている必要があります）')) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(parts[0]) + '/apply', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ cat_id: _ovFeedCtx.catId, preset_item_id: itemId }),
      }).then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      })
        .then(function (res) {
          var data = res.data;
          if (!res.ok || data.error) {
            var em = (data && (data.message || data.error)) || '適用に失敗しました';
            if (res.status === 409) em = (data && data.message) || 'プリセットがすでに割り当てられています';
            alert('エラー: ' + em);
            return;
          }
          alert('プリセット「' + (data.preset_name || '') + '」の1品を追加しました');
          ovClosePresetModal();
          fetchData(0);
        }).catch(function () { alert('適用に失敗しました'); });
      return;
    }
    var ap = t.closest('[data-ov-apply-preset]');
    if (ap && _ovFeedCtx) {
      ev.preventDefault();
      var pid = ap.getAttribute('data-ov-apply-preset');
      if (!confirm('有効メニューだけで献立を全面入れ替えしますか？\n手動プランも含め現在の献立はすべて解除されます。')) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(pid) + '/apply', {
        method: 'POST',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ cat_id: _ovFeedCtx.catId }),
      }).then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      })
        .then(function (res) {
          var data = res.data;
          if (!res.ok || data.error) {
            var em = (data && (data.message || data.error)) || '適用に失敗しました';
            if (res.status === 409) em = (data && data.message) || 'プリセットがすでに割り当てられています';
            alert('エラー: ' + em);
            return;
          }
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
      }).then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, status: r.status, data: data };
        });
      })
        .then(function (res) {
          var data = res.data;
          if (!res.ok || data.error) {
            var msg = (data && (data.message || data.error)) || '保存に失敗しました';
            if (res.status === 409) msg = (data && data.message) || 'プリセットがすでに割り当てられています';
            alert('エラー: ' + msg);
            return;
          }
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
      if (!name || !String(name).trim()) return;
      _ovPendingNewPreset = { name: String(name).trim(), location_id: loc };
      ovShowNewPresetDescriptionStep();
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
    var edDesc = t.closest('[data-ov-edit-preset-desc]');
    if (edDesc && _ovFeedCtx) {
      ev.preventDefault();
      ovShowPresetDescEditor(edDesc.getAttribute('data-ov-edit-preset-desc'));
      return;
    }
    var sdDesc = t.closest('[data-ov-save-preset-desc]');
    if (sdDesc && _ovFeedCtx) {
      ev.preventDefault();
      var sdp = sdDesc.getAttribute('data-ov-save-preset-desc');
      var taD = document.getElementById('ovPresetDescTa');
      var rawD = taD ? String(taD.value) : '';
      var trimD = rawD.trim();
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(sdp), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ description: trimD === '' ? null : trimD }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovFillPresetManageModal(ovGetStoredPresetLocation());
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var cdDesc = t.closest('[data-ov-cancel-preset-desc]');
    if (cdDesc && _ovFeedCtx) {
      ev.preventDefault();
      ovFillPresetManageModal(ovGetStoredPresetLocation());
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
    var manTog = t.closest('[data-ov-manage-toggle-menu]');
    if (manTog && _ovFeedCtx) {
      ev.preventDefault();
      var rawMan = manTog.getAttribute('data-ov-manage-toggle-menu') || '';
      var tri = rawMan.split('|');
      if (tri.length < 3) return;
      var prId = tri[0];
      var itId = tri[1];
      var nxt = parseInt(tri[2], 10);
      if (isNaN(nxt)) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(prId) + '/items/' + encodeURIComponent(itId), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ menu_active: nxt }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovFillPresetManageModal(ovGetStoredPresetLocation(), true);
        }).catch(function () { alert('更新に失敗しました'); });
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
    var togMenu = t.closest('[data-ov-toggle-preset-menu]');
    if (togMenu && _ovFeedCtx) {
      ev.preventDefault();
      var rawT = togMenu.getAttribute('data-ov-toggle-preset-menu') || '';
      var pt = rawT.split(':');
      if (pt.length < 3) return;
      var prId = pt[0];
      var itId = pt[1];
      var nxt = parseInt(pt[2], 10);
      if (isNaN(nxt)) return;
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(prId) + '/items/' + encodeURIComponent(itId), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ menu_active: nxt }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovShowPresetItemsEditor(prId);
        }).catch(function () { alert('更新に失敗しました'); });
      return;
    }
    var edFull = t.closest('[data-ov-edit-preset-item-full]');
    if (edFull && _ovFeedCtx) {
      ev.preventDefault();
      var rawFull = edFull.getAttribute('data-ov-edit-preset-item-full') || '';
      var pf = rawFull.split(':');
      if (pf.length < 2) return;
      ovOpenEditPresetItemModal(pf[0], pf[1]);
      return;
    }
    var addIt = t.closest('[data-ov-add-preset-item]');
    if (addIt && _ovFeedCtx) {
      ev.preventDefault();
      var apid = addIt.getAttribute('data-ov-add-preset-item');
      var slot = addIt.getAttribute('data-ov-preset-slot') || 'morning';
      _ovEditingPresetItemId = null;
      _ovPendingPresetItem = apid;
      ovOpenAddPlanModal(_ovFeedCtx.catId, slot, null, { preservePendingPreset: true });
      var presetMH = document.getElementById('ovPresetApplyModal');
      if (presetMH) presetMH.classList.remove('open');
      var title = document.querySelector('#ovAddPlanModal .modal-title');
      if (title) title.innerHTML = '📋 プリセットに追加 <span class="dim">' + esc(slot) + '</span>';
      return;
    }
    var edIn = t.closest('[data-ov-edit-preset-item-note]');
    if (edIn && _ovFeedCtx) {
      ev.preventDefault();
      var ppi = edIn.getAttribute('data-ov-preset-pid');
      var iii = edIn.getAttribute('data-ov-item-id');
      ovShowPresetItemNoteEditor(ppi, iii);
      return;
    }
    var sdIn = t.closest('[data-ov-save-preset-item-note]');
    if (sdIn && _ovFeedCtx) {
      ev.preventDefault();
      var pps = sdIn.getAttribute('data-ov-preset-pid');
      var iis = sdIn.getAttribute('data-ov-item-id');
      var taN = document.getElementById('ovPresetItemNoteTa');
      var rawN = taN ? String(taN.value) : '';
      var trimN = rawN.trim();
      fetch(feedingApiBase() + '/presets/' + encodeURIComponent(pps) + '/items/' + encodeURIComponent(iis), {
        method: 'PUT',
        headers: apiHeaders(),
        cache: 'no-store',
        body: JSON.stringify({ notes: trimN === '' ? null : trimN }),
      }).then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
          ovShowPresetItemsEditor(pps);
        }).catch(function () { alert('保存に失敗しました'); });
      return;
    }
    var cnIn = t.closest('[data-ov-cancel-preset-item-note]');
    if (cnIn && _ovFeedCtx) {
      ev.preventDefault();
      var ppc = cnIn.getAttribute('data-ov-preset-pid');
      ovShowPresetItemsEditor(ppc);
      return;
    }
    var backM = t.closest('[data-ov-preset-items-back]');
    if (backM && _ovFeedCtx) {
      ev.preventDefault();
      ovFillPresetManageModal(ovGetStoredPresetLocation());
      return;
    }
  }

  function ovShowPresetDescEditor(presetId) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📋 プリセット全体メモ</div><div id="ovPresetDescBody" class="loading" style="padding:16px;">読み込み中...</div></div>';
    var area = document.getElementById('ovPresetDescBody');
    fetch(feedingApiBase() + '/presets/' + encodeURIComponent(presetId), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error || !data.preset) {
          if (area) { area.className = ''; area.innerHTML = '<div class="empty-msg">読み込み失敗</div>'; }
          return;
        }
        var cur = data.preset.description != null ? String(data.preset.description) : '';
        var inner = '<p class="dim" style="font-size:11px;margin:0 0 8px;line-height:1.4;">献立表示などに使われるプリセット単位のメモです。<b>改行で段落分け</b>できます。フード毎のメモは「✏️」一覧の 📎 から編集できます。</p>';
        inner += '<textarea id="ovPresetDescTa" rows="6" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.2);color:inherit;font-size:13px;line-height:1.45;resize:vertical;"></textarea>';
        inner += '<div class="modal-actions" style="margin-top:12px;"><button type="button" class="btn btn-primary" data-ov-save-preset-desc="' + escAttr(String(presetId)) + '">保存</button> ';
        inner += '<button type="button" class="btn btn-outline" data-ov-cancel-preset-desc="1">戻る</button></div>';
        if (area) { area.className = ''; area.innerHTML = inner; }
        var ta = document.getElementById('ovPresetDescTa');
        if (ta) ta.value = cur;
      }).catch(function () {
        if (area) { area.className = ''; area.innerHTML = '<div class="empty-msg">読み込み失敗</div>'; }
      });
  }

  function ovOpenEditPresetItemModal(presetId, itemId) {
    if (!_ovFeedCtx) return;
    var it = null;
    if (_ovPresetItemsCache && String(_ovPresetItemsCache.presetId) === String(presetId) && _ovPresetItemsCache.items) {
      for (var ei = 0; ei < _ovPresetItemsCache.items.length; ei++) {
        if (String(_ovPresetItemsCache.items[ei].id) === String(itemId)) {
          it = _ovPresetItemsCache.items[ei];
          break;
        }
      }
    }
    if (!it) {
      alert('データが見つかりません。フード一覧を開き直してください。');
      return;
    }
    _ovPendingPresetItem = String(presetId);
    _ovEditingPresetItemId = String(itemId);
    _ovEditingPlanId = null;
    var c = ovFindCat(_ovFeedCtx.catId);
    if (!c) return;
    var title = document.querySelector('#ovAddPlanModal .modal-title');
    if (title) title.innerHTML = '📋 プリセット項目を編集 <span class="dim">' + esc(c.name) + '</span>';
    var slotSel = document.getElementById('ovApSlot');
    if (slotSel) slotSel.value = it.meal_slot || 'morning';
    if (document.getElementById('ovApAmount')) document.getElementById('ovApAmount').value = it.amount_g != null ? String(it.amount_g) : '';
    if (document.getElementById('ovApNotes')) document.getElementById('ovApNotes').value = it.notes || '';
    ovFillAddPlanFoodPicker(it.food_id || null);
    var presetM = document.getElementById('ovPresetApplyModal');
    if (presetM) presetM.classList.remove('open');
    var m = document.getElementById('ovAddPlanModal');
    if (m) m.classList.add('open');
  }

  function ovShowPresetItemNoteEditor(presetId, itemId) {
    var modal = document.getElementById('ovPresetApplyModal');
    if (!modal || !_ovFeedCtx) return;
    var cur = '';
    if (_ovPresetItemsCache && String(_ovPresetItemsCache.presetId) === String(presetId) && _ovPresetItemsCache.items) {
      for (var ni = 0; ni < _ovPresetItemsCache.items.length; ni++) {
        if (String(_ovPresetItemsCache.items[ni].id) === String(itemId)) {
          cur = _ovPresetItemsCache.items[ni].notes != null ? String(_ovPresetItemsCache.items[ni].notes) : '';
          break;
        }
      }
    }
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📎 フード行メモ</div><div id="ovPresetItemNoteBody" style="padding:12px 16px;"></div></div>';
    var area = document.getElementById('ovPresetItemNoteBody');
    var inner = '<p class="dim" style="font-size:11px;margin:0 0 8px;line-height:1.4;">このフード行のメモは、献立の説明文などにまとめて表示されます。<b>改行可</b>です。</p>';
    inner += '<textarea id="ovPresetItemNoteTa" rows="5" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:rgba(0,0,0,0.2);color:inherit;font-size:13px;line-height:1.45;resize:vertical;"></textarea>';
    inner += '<div class="modal-actions" style="margin-top:12px;"><button type="button" class="btn btn-primary" data-ov-save-preset-item-note="1" data-ov-preset-pid="' + escAttr(String(presetId)) + '" data-ov-item-id="' + escAttr(String(itemId)) + '">保存</button> ';
    inner += '<button type="button" class="btn btn-outline" data-ov-cancel-preset-item-note="1" data-ov-preset-pid="' + escAttr(String(presetId)) + '">戻る</button></div>';
    if (area) area.innerHTML = inner;
    var ta = document.getElementById('ovPresetItemNoteTa');
    if (ta) ta.value = cur;
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
          var menuOffOv = it.menu_active !== undefined && it.menu_active !== null && Number(it.menu_active) === 0;
          h += '<div style="display:block;width:100%;max-width:100%;box-sizing:border-box;padding:8px;background:var(--surface);border-radius:6px;margin-bottom:6px;">';
          h += '<div style="display:flex;align-items:flex-start;gap:6px;width:100%;">';
          h += '<div style="flex:1;min-width:0;font-size:12px;line-height:1.4;word-break:normal;overflow-wrap:break-word;writing-mode:horizontal-tb;white-space:normal;" data-nyagi-preset-food="1">' + esc(nyagiPresetFoodNamePlain(it.food_name)) + ' <b>' + it.amount_g + 'g</b> <span class="dim">' + esc(it.meal_slot || '') + '</span>';
          if (menuOffOv) h += ' <span style="font-size:10px;color:#f87171;">(献立対象外)</span>';
          h += '</div>';
          h += '<div style="flex-shrink:0;display:flex;flex-wrap:wrap;gap:4px;">';
          h += '<button type="button" class="btn-edit-small" style="font-size:10px;" data-ov-toggle-preset-menu="' + escAttr(String(presetId) + ':' + String(it.id) + ':' + (menuOffOv ? '1' : '0')) + '" title="献立に載せるか">' + (menuOffOv ? '▶有効' : '⏸無効') + '</button>';
          h += '<button type="button" class="btn-edit-small" style="font-size:11px;" data-ov-edit-preset-item-full="' + escAttr(String(presetId) + ':' + String(it.id)) + '" title="フード・量・枠">✏️</button>';
          h += '<button type="button" class="btn-edit-small" title="フード行メモ" data-ov-edit-preset-item-note="1" data-ov-preset-pid="' + escAttr(String(presetId)) + '" data-ov-item-id="' + escAttr(String(it.id)) + '">📎</button>';
          h += '<button type="button" class="btn-edit-small" style="color:#f87171;" data-ov-del-preset-item="' + escAttr(String(presetId)) + ':' + escAttr(String(it.id)) + '">🗑</button>';
          h += '</div></div>';
          var nstr = it.notes != null ? String(it.notes).trim() : '';
          if (nstr) h += '<div class="dim" style="font-size:10px;margin-top:4px;line-height:1.35;white-space:pre-wrap;word-break:break-word;">📝 ' + esc(nstr) + '</div>';
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

  function postHealthRecordPromise(body) {
    return fetch(apiOpsBase() + '/health/records', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = {};
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (e) {
            data = { error: 'invalid_response', message: text.slice(0, 240) };
          }
        }
        return { ok: r.ok, data: data };
      });
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

  function deleteCareRecord(recordId, chip) {
    if (!recordId) return;
    var prevText = chip ? chip.textContent : '';
    if (chip) { chip.style.opacity = '0.4'; chip.style.pointerEvents = 'none'; }
    fetch(apiOpsBase() + '/health/records/' + encodeURIComponent(recordId), {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (chip) { chip.style.opacity = ''; chip.style.pointerEvents = ''; }
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        fetchData(0);
      }).catch(function () {
        if (chip) { chip.style.opacity = ''; chip.style.pointerEvents = ''; }
        alert('取り消しに失敗しました');
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
    var st = form.querySelector('select.ov-sel-st') || form.querySelector('input.ov-sel-st');
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
    var st = form.querySelector('select.ov-sel-ur') || form.querySelector('input.ov-sel-ur');
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

  function ovParseCareDetailsRaw(d) {
    if (!d) return '';
    if (typeof d === 'string' && d.charAt(0) === '"') {
      try { return JSON.parse(d); } catch (e) { return d; }
    }
    return d;
  }

  function ovCareDetailLabel(d) {
    var x = ovParseCareDetailsRaw(d);
    if (x && typeof x === 'object' && x.label) return String(x.label);
    return String(x || '');
  }

  function ovCareSlotKey(recordType, details) {
    return (recordType || '') + '|' + ovCareDetailLabel(details);
  }

  /** ブラシ・アゴ・耳・お尻・目ヤニ拭きを1ボタンで記録（指定日・未実施分のみ） */
  function saveGroomingBundleCare(catId, form, btn) {
    var recordDate = todayJstYmd();
    if (form) {
      var dt = form.querySelector('.ov-inp-care-bulk-date');
      if (dt && dt.value) recordDate = dt.value;
    }
    if (!recordDate) {
      alert('日付を入力してください');
      return;
    }
    var prevText = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }

    function buildCareBody(careVal) {
      var parts = careVal.split(':');
      var recordType = parts[0] || 'care';
      var details = parts.slice(1).join(':') || '';
      var b = {
        cat_id: catId,
        record_type: recordType,
        record_date: recordDate,
        value: '記録',
        details: details,
      };
      if (recordType === 'care' || recordType === 'eye_discharge') {
        b.recorded_time = nowJstHm();
      }
      return b;
    }

    var catEnc = encodeURIComponent(catId);
    Promise.all([
      fetch(apiOpsBase() + '/health/records?cat_id=' + catEnc + '&type=care&limit=120', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(apiOpsBase() + '/health/records?cat_id=' + catEnc + '&type=eye_discharge&limit=120', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var careRecs = (results[0] && results[0].records) ? results[0].records : [];
      var eyeRecs = (results[1] && results[1].records) ? results[1].records : [];
      var doneKeys = {};
      for (var ci = 0; ci < careRecs.length; ci++) {
        var r = careRecs[ci];
        if ((r.record_date || '') !== recordDate) continue;
        if (r.value === '×' || r.value === 'ー') continue;
        doneKeys[ovCareSlotKey(r.record_type, r.details)] = true;
      }
      for (var ei = 0; ei < eyeRecs.length; ei++) {
        var re = eyeRecs[ei];
        if ((re.record_date || '') !== recordDate) continue;
        if (re.value === '×' || re.value === 'ー') continue;
        doneKeys[ovCareSlotKey('eye_discharge', '目ヤニ拭き')] = true;
        doneKeys[ovCareSlotKey(re.record_type, re.details)] = true;
      }
      var items = [];
      for (var bi = 0; bi < OV_CARE_BUNDLE_SPECS.length; bi++) {
        var spec = OV_CARE_BUNDLE_SPECS[bi];
        var parts = spec.value.split(':');
        var rt = parts[0] || 'care';
        var det = parts.slice(1).join(':') || '';
        if (!doneKeys[(rt || '') + '|' + det]) items.push(spec.value);
      }
      if (items.length === 0) {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevText;
        }
        alert('ブラシ・アゴ・耳・お尻・目ヤニ拭きは、選択した日付ですでに記録済みです');
        return;
      }
      function runSeq(idx) {
        if (idx >= items.length) {
          if (btn) {
            btn.disabled = false;
            btn.textContent = prevText;
          }
          fetchCatsDataSilent();
          return;
        }
        postHealthRecordPromise(buildCareBody(items[idx]))
          .then(function (res) {
            if (!res.ok || (res.data && res.data.error)) {
              if (btn) {
                btn.disabled = false;
                btn.textContent = prevText;
              }
              alert('エラー: ' + ((res.data && (res.data.message || res.data.error)) || 'HTTPエラー'));
              return;
            }
            runSeq(idx + 1);
          })
          .catch(function () {
            if (btn) {
              btn.disabled = false;
              btn.textContent = prevText;
            }
            alert('保存に失敗しました');
          });
      }
      runSeq(0);
    }).catch(function () {
      if (btn) {
        btn.disabled = false;
        btn.textContent = prevText;
      }
      alert('記録の取得に失敗しました');
    });
  }

  /** 投薬ログ done/undo。本文 POST { action } を優先し、405 のとき従来の /done|/undo にフォールバック */
  function postMedicationLogChange(cb, logId, wantDone) {
    function revert() { cb.checked = !wantDone; }
    var pathAction = wantDone ? 'done' : 'undo';
    cb.disabled = true;
    function finishSuccess() {
      cb.disabled = false;
      fetchCatsDataSilent();
    }
    function finishError(msg) {
      cb.disabled = false;
      revert();
      alert('エラー: ' + msg);
    }
    var base = apiOpsBase() + '/health/medication-logs/' + encodeURIComponent(logId);
    var headers = apiHeaders();
    fetch(base, {
      method: 'POST',
      headers: headers,
      cache: 'no-store',
      body: JSON.stringify({ action: pathAction }),
    })
      .then(function (r) {
        return r.json().then(
          function (data) {
            return { ok: r.ok, status: r.status, data: data };
          },
          function () {
            return { ok: r.ok, status: r.status, data: null };
          }
        );
      })
      .then(function (res) {
        if (res.ok && !(res.data && res.data.error)) {
          finishSuccess();
          return null;
        }
        if (res.status === 405 || (res.data && res.data.error === 'method_not_allowed')) {
          return fetch(base + '/' + pathAction, {
            method: 'POST',
            headers: headers,
            cache: 'no-store',
            body: JSON.stringify({}),
          }).then(function (r2) {
            return r2.json().then(function (d2) {
              return { ok: r2.ok, status: r2.status, data: d2 };
            });
          });
        }
        finishError((res.data && (res.data.message || res.data.error)) || 'HTTPエラー');
        return null;
      })
      .then(function (res2) {
        if (!res2) return;
        if (res2.ok && !(res2.data && res2.data.error)) {
          finishSuccess();
          return;
        }
        finishError((res2.data && (res2.data.message || res2.data.error)) || 'HTTPエラー');
      })
      .catch(function () {
        cb.disabled = false;
        revert();
        alert('投薬の更新に失敗しました');
      });
  }

  function bindOverviewInlineHandlers() {
    if (_ovInlineHandlersBound) return;
    _ovInlineHandlersBound = true;
    cardArea.addEventListener('click', function (ev) {
      var pccCareBundle = ev.target.closest && ev.target.closest('.btn-pcc-care-bundle');
      if (pccCareBundle) {
        ev.preventDefault();
        ev.stopPropagation();
        var cidB = pccCareBundle.getAttribute('data-cat-id');
        if (cidB) saveGroomingBundleCare(cidB, null, pccCareBundle);
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
        var elep = felg.getAttribute('data-eaten-pct');
        var elst = felg.getAttribute('data-served-time') || '';
        if (elid) ovOpenEditLogModal(elid, elfn, elog, elep != null ? elep : '', elst);
        return;
      }
      var finc = ev.target.closest && ev.target.closest('.btn-ov-feed-intake-complete');
      if (finc) {
        ev.preventDefault();
        ev.stopPropagation();
        var lidC = finc.getAttribute('data-log-id');
        if (!lidC) return;
        ovPutFedLogEatenPct(lidC, 100)
          .then(function (data) {
            if (data && data.error) { alert('エラー: ' + (data.message || data.error)); return; }
            fetchCatsDataSilent();
          })
          .catch(function () { alert('保存に失敗しました'); });
        return;
      }
      var filr = ev.target.closest && ev.target.closest('.btn-ov-feed-intake-leftover');
      if (filr) {
        ev.preventDefault();
        ev.stopPropagation();
        var lidL = filr.getAttribute('data-log-id');
        var inpIdL = filr.getAttribute('data-input-id');
        var offGL = parseFloat(filr.getAttribute('data-offered-g'));
        var inpL = inpIdL ? document.getElementById(inpIdL) : null;
        if (!lidL || !inpL) return;
        var pctL = ovEatenPctFromOfferedLeftover(offGL, inpL.value);
        if (pctL === null) { alert('残り量（g）を入力してください'); return; }
        if (pctL === -1) { alert('残した量が提供量を超えています'); return; }
        ovPutFedLogEatenPct(lidL, pctL)
          .then(function (data) {
            if (data && data.error) { alert('エラー: ' + (data.message || data.error)); return; }
            fetchCatsDataSilent();
          })
          .catch(function () { alert('保存に失敗しました'); });
        return;
      }
      var fund = ev.target.closest && ev.target.closest('.btn-ov-feed-undofed');
      if (fund) {
        ev.preventDefault();
        ev.stopPropagation();
        var lidCsv = fund.getAttribute('data-log-ids') || fund.getAttribute('data-log-id');
        if (lidCsv) ovUndoFedLogs(lidCsv);
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
      var bulkOnlyBtn = ev.target.closest && ev.target.closest('.btn-ov-ex-bulk-only');
      if (bulkOnlyBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var barOnly = bulkOnlyBtn.closest('.ov-ex-bulk-bar');
        if (!barOnly) return;
        ovBulkPostExcretion(barOnly.getAttribute('data-bulk-kind') || 'stool', bulkOnlyBtn, true);
        return;
      }
      var bulkAllBtn = ev.target.closest && ev.target.closest('.btn-ov-ex-bulk-all');
      if (bulkAllBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var barAll = bulkAllBtn.closest('.ov-ex-bulk-bar');
        if (!barAll) return;
        ovBulkPostExcretion(barAll.getAttribute('data-bulk-kind') || 'stool', bulkAllBtn, false);
        return;
      }
      var quickBtn = ev.target.closest && ev.target.closest('.btn-ov-ex-quick');
      if (quickBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var qForm = quickBtn.closest('.ov-ex-inline-form');
        if (!qForm) return;
        ovQuickPostExcretionForCat(
          qForm.getAttribute('data-cat-id'),
          qForm.getAttribute('data-ex-inline-kind') || 'stool',
          quickBtn
        );
        return;
      }
      var exStBtn = ev.target.closest && ev.target.closest('.ov-ex-st-btn');
      if (exStBtn && exStBtn.closest('.ov-ex-status-grid')) {
        ev.preventDefault();
        ev.stopPropagation();
        var gridBtn = exStBtn.closest('.ov-ex-status-grid');
        var hidBtn = gridBtn && gridBtn.previousElementSibling;
        if (!hidBtn || hidBtn.tagName !== 'INPUT' || hidBtn.type !== 'hidden') return;
        hidBtn.value = exStBtn.getAttribute('data-ex-value') || '';
        syncExcretionStatusGridFromHidden(hidBtn);
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
          if (selE.tagName === 'INPUT' && selE.type === 'hidden') {
            if (!selE.value && rawE) selE.value = String(rawE);
            syncExcretionStatusGridFromHidden(selE);
          } else if (selE.tagName === 'SELECT' && selE.value !== mappedE && rawE) {
            selE.value = rawE;
          }
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
        var stS = rowS.querySelector(kindS === 'urine' ? 'input.ov-ex-sel-ur, select.ov-ex-sel-ur' : 'input.ov-ex-sel-st, select.ov-ex-sel-st');
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
      var bundleCareBtn = ev.target.closest && ev.target.closest('.btn-ov-care-bundle-save');
      if (bundleCareBtn) {
        ev.preventDefault();
        ev.stopPropagation();
        var formB = bundleCareBtn.closest('.inline-form');
        if (!formB) return;
        var catIdB = formB.getAttribute('data-cat-id');
        if (!catIdB) return;
        saveGroomingBundleCare(catIdB, formB, bundleCareBtn);
        return;
      }
      var vomitSave = ev.target.closest && ev.target.closest('.btn-ov-vomit-save');
      if (vomitSave) {
        ev.preventDefault();
        ev.stopPropagation();
        ovSaveVomitRecord(vomitSave);
        return;
      }
      var vomitFb = ev.target.closest && ev.target.closest('.btn-ov-vomit-fallback-del');
      if (vomitFb) {
        ev.preventDefault();
        ev.stopPropagation();
        var cidFb = vomitFb.getAttribute('data-cat-id');
        if (cidFb) ovFetchAndDeleteTodaysVomitForCat(cidFb, vomitFb);
        return;
      }
      var vomitDel = ev.target.closest && ev.target.closest('.btn-ov-vomit-del');
      if (vomitDel) {
        ev.preventDefault();
        ev.stopPropagation();
        ovDeleteVomitRecord(vomitDel);
        return;
      }
      var pccVomitSave = ev.target.closest && ev.target.closest('.btn-pcc-vomit-save');
      if (pccVomitSave) {
        ev.preventDefault();
        ev.stopPropagation();
        var formV = pccVomitSave.closest('.ov-pcc-vomit-form');
        if (!formV) return;
        var catIdV = formV.getAttribute('data-cat-id');
        if (!catIdV) return;
        var cntEl = formV.querySelector('.ov-pcc-vomit-count');
        var dateEl = formV.querySelector('.ov-pcc-vomit-date');
        var noteEl = formV.querySelector('.ov-pcc-vomit-note');
        var count = cntEl ? cntEl.value : '1';
        var rd = dateEl ? dateEl.value : todayJstYmd();
        if (!rd) { alert('日付を入力してください'); return; }
        var noteText = noteEl ? noteEl.value.trim() : '';
        var detailsV = noteText ? JSON.stringify({ note: noteText }) : null;
        postHealthRecord({
          cat_id: catIdV,
          record_type: 'vomiting',
          record_date: rd,
          recorded_time: nowJstHm(),
          value: count + '回',
          details: detailsV,
        }, pccVomitSave);
        if (noteEl) noteEl.value = '';
        return;
      }
      var careChipItem = ev.target.closest && ev.target.closest('.care-chip-tap');
      if (careChipItem) {
        ev.preventDefault();
        ev.stopPropagation();
        var careRecIdI = careChipItem.getAttribute('data-care-id');
        if (!careRecIdI) { alert('この記録にはIDが含まれていないため取り消しできません'); return; }
        var careLabelI = careChipItem.textContent.trim();
        if (!confirm('ケア「' + careLabelI + '」の記録を取り消しますか？')) return;
        deleteCareRecord(careRecIdI, careChipItem);
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
    cardArea.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb) return;
      if (cb.id === 'ovVomitCat') {
        var catId = cb.value;
        if (_vomitRecentCache) ovRenderVomitRecent(_vomitRecentCache, catId || null);
        return;
      }
      if (!cb.classList) return;
      if (cb.type === 'checkbox' && cb.classList.contains('ov-feed-fed-cb')) {
        if (!cb.checked) {
          var idsCsv = cb.getAttribute('data-log-ids');
          if (!idsCsv) {
            cb.checked = true;
            return;
          }
          var idArr = String(idsCsv).split(',').map(function (x) { return parseInt(String(x).trim(), 10); }).filter(function (n) { return !isNaN(n); });
          if (idArr.length === 0) {
            cb.checked = true;
            return;
          }
          if (idArr.length > 1) {
            if (!confirm('この献立の本日の「あげた」記録が ' + idArr.length + ' 件あります。まとめて取り消しますか？')) {
              cb.checked = true;
              return;
            }
          }
          ovUndoFedLogs(idsCsv);
        }
        return;
      }
      if (cb.type !== 'checkbox' || !cb.classList.contains('ov-med-log-cb')) return;
      if (cb.closest && cb.closest('.pcc-med-block')) return;
      var logId = cb.getAttribute('data-log-id');
      if (!logId) return;
      postMedicationLogChange(cb, logId, cb.checked);
    });
  }

  function buildStoolInlineEdit(c) {
    return '<div class="inline-form ov-ex-inline-form" data-cat-id="' + escAttr(c.id) + '" data-ex-inline-kind="stool">' +
      '<button type="button" class="btn btn-primary btn-ov-ex-quick">💩 記録（健康）</button>' +
      '<span class="dim ov-ex-quick-auto">現在帯を自動判定</span>' +
      '</div>';
  }

  function buildUrineInlineEdit(c) {
    return '<div class="inline-form ov-ex-inline-form" data-cat-id="' + escAttr(c.id) + '" data-ex-inline-kind="urine">' +
      '<button type="button" class="btn btn-primary btn-ov-ex-quick">💧 記録（健康）</button>' +
      '<span class="dim ov-ex-quick-auto">現在帯を自動判定</span>' +
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
    return '<div class="inline-form ov-care-inline-form" data-cat-id="' + escAttr(c.id) + '">' +
      '<div class="ov-care-bulk-block">' +
      '<div class="ov-care-bulk-hint">5項目まとめ（ブラシ・アゴ・耳・お尻・目ヤニ）</div>' +
      '<div class="ov-care-bulk-actions">' +
      '<input type="date" class="ov-inline-date ov-inp-care-bulk-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-care-bundle-save">🪮 5項目まとめて記録</button>' +
      '</div>' +
      '<p class="dim ov-care-bulk-note">未記録分のみ追加（爪切り・肉球は下の個別から）</p>' +
      '</div>' +
      '<div class="ov-care-sep">個別（1件ずつ）</div>' +
      '<select class="ov-inline-select ov-sel-care-type">' + OPT_CARE_TYPE + '</select>' +
      '<select class="ov-inline-select ov-sel-care-done">' + OPT_CARE_DONE + '</select>' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="care">保存</button>' +
      '</div>';
  }

  /** 猫ごとカード用: 項目ごとと同じ個別ケア（項目・実施/スキップ・日付・保存） */
  function buildCareIndividualFormForPcc(c) {
    return '<div class="pcc-care-individual-wrap">' +
      '<div class="dim" style="font-size:10px;margin:0 0 6px;font-weight:600;">個別に1件記録（爪切り・肉球など）</div>' +
      '<div class="inline-form ov-care-inline-form pcc-care-inline" data-cat-id="' + escAttr(c.id) + '">' +
      '<div class="pcc-care-inline-row">' +
      '<select class="ov-inline-select ov-sel-care-type">' + OPT_CARE_TYPE + '</select>' +
      '<select class="ov-inline-select ov-sel-care-done">' + OPT_CARE_DONE + '</select>' +
      '</div>' +
      '<div class="pcc-care-inline-row">' +
      '<input type="date" class="ov-inline-date ov-inp-date" value="' + escAttr(todayJstYmd()) + '">' +
      '<button type="button" class="btn btn-primary btn-ov-save" data-kind="care" style="font-size:11px;padding:6px 12px;white-space:nowrap;">保存</button>' +
      '</div></div></div>';
  }

  /** overview の嘔吐回数（NaN や数字以外の文字列でも表示が破綻しないように） */
  function overviewParseVomitCount(v) {
    if (v == null || v === '') return 0;
    var n = Number(v);
    if (isFinite(n) && !isNaN(n)) return n;
    var s = String(v).trim();
    var m = s.match(/(\d+)/);
    if (m) return parseInt(m[1], 10) || 0;
    return 0;
  }

  /** 猫ごとカード下: はき戻し（overview の vomit_today / vomit_7d / vomit_today_entries） */
  function buildPccVomitStrip(c) {
    var vt = overviewParseVomitCount(c.vomit_today);
    var v7 = overviewParseVomitCount(c.vomit_7d);
    var entries = c.vomit_today_entries || [];
    var h = '';
    h += '<div class="pcc-vomit-strip" onclick="event.stopPropagation();">';
    h += '<div style="font-size:11px;color:var(--text-dim);line-height:1.4;margin-bottom:6px;">今日 <b>' + vt + '</b>回 · 直近7日 計<b>' + v7 + '</b>回</div>';
    for (var ei = 0; ei < entries.length; ei++) {
      var e = entries[ei];
      var tl = e.time ? esc(String(e.time)) + ' ' : '';
      var lab = e.label != null && e.label !== '' ? String(e.label) : (e.value != null ? String(e.value) : '記録');
      var vid = e.voice_input_id != null && e.voice_input_id !== '' ? escAttr(String(e.voice_input_id)) : '';
      var rid = e.record_id != null && e.record_id !== '' ? escAttr(String(e.record_id)) : '';
      h += '<div class="pcc-vomit-entry-line">';
      h += '<span style="flex:1;min-width:0;color:var(--text-main);">' + tl + esc(lab) + '</span>';
      var eYmd = overviewClientRecordDateYmd(e.record_date != null && e.record_date !== '' ? e.record_date : todayJstYmd());
      h += '<button type="button" class="btn-ov-vomit-del" data-vomit-record-ymd="' + escAttr(eYmd) + '" data-voice-id="' + vid + '" data-record-id="' + rid + '" style="font-size:10px;padding:4px 10px;border-radius:6px;border:1px solid rgba(248,113,113,0.4);background:rgba(248,113,113,0.12);color:#f87171;">削除</button>';
      h += '</div>';
    }
    /* 条件付きだとキャッシュ・APIずれでボタンが消えるため、猫ごとに常に「再取得して削除」を出す */
    h += '<div class="pcc-vomit-actions" style="margin:4px 0 10px;display:flex;flex-direction:column;align-items:stretch;gap:4px;">';
    h += '<button type="button" class="btn-ov-vomit-fallback-del" data-cat-id="' + escAttr(String(c.id)) + '" style="font-size:12px;font-weight:700;padding:10px 12px;border-radius:8px;border:1px solid rgba(248,113,113,0.55);background:rgba(248,113,113,0.22);color:#fda4af;width:100%;box-sizing:border-box;">本日分のみ削除（再取得）</button>';
    h += '<span class="dim" style="font-size:9px;line-height:1.35;">本日（JST）のはき戻し・嘔吐だけをAPIから探して削除します。過去日は猫詳細の健康記録から削除してください。</span>';
    h += '</div>';
    h += '<div class="ov-pcc-vomit-form" data-cat-id="' + escAttr(String(c.id)) + '" style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;">';
    h += '<select class="ov-inline-select ov-pcc-vomit-count" style="width:64px;flex-shrink:0;"><option value="1">1回</option><option value="2">2回</option><option value="3">3回</option></select>';
    h += '<input type="date" class="ov-inline-input ov-pcc-vomit-date" style="width:120px;flex-shrink:0;" value="' + escAttr(todayJstYmd()) + '">';
    h += '<input type="text" class="ov-inline-input ov-pcc-vomit-note" placeholder="メモ" style="flex:1;min-width:72px;">';
    h += '<button type="button" class="btn btn-primary btn-pcc-vomit-save" style="white-space:nowrap;">記録</button>';
    h += '</div></div>';
    return h;
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

  /** 新規猫の内部ID（DB 主キー）。衝突しにくいよう時刻＋乱数。 */
  function nyagiNewCatGeneratedId() {
    var r = Math.random().toString(36).replace(/[^a-z0-9]/g, '');
    return 'cat_reg_' + Date.now() + '_' + (r.length >= 6 ? r.slice(0, 6) : r + 'xxxxxx').slice(0, 6);
  }

  function ovOpenNewCatModal() {
    var m = document.getElementById('ovNewCatModal');
    if (!m) return;
    var nm = document.getElementById('ovNewCatName');
    if (nm) nm.value = '';
    var loc = document.getElementById('ovNewCatLocation');
    if (loc) {
      var saved = currentLocationId && currentLocationId !== 'all' ? currentLocationId : null;
      if (saved && ['cafe', 'nekomata', 'endo', 'azukari'].indexOf(saved) !== -1) loc.value = saved;
    }
    var sp = document.getElementById('ovNewCatSpecies');
    if (sp) sp.value = 'cat';
    m.classList.add('open');
    if (nm) setTimeout(function () { try { nm.focus(); } catch (_) {} }, 80);
  }

  function ovCloseNewCatModal() {
    var m = document.getElementById('ovNewCatModal');
    if (m) m.classList.remove('open');
  }

  function ovSubmitNewCat() {
    var nameEl = document.getElementById('ovNewCatName');
    var name = nameEl && String(nameEl.value || '').trim();
    if (!name) {
      alert('名前を入力してください');
      return;
    }
    var locEl = document.getElementById('ovNewCatLocation');
    var locationId = locEl ? locEl.value : 'cafe';
    var spEl = document.getElementById('ovNewCatSpecies');
    var species = (spEl && spEl.value === 'dog') ? 'dog' : 'cat';
    var newId = nyagiNewCatGeneratedId();
    var btn = document.getElementById('ovNewCatSubmit');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '登録中…';
    }
    function finishFail(msg) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '登録する';
      }
      alert(msg || '登録に失敗しました');
    }
    fetch(apiOpsBase() + '/cats', {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({
        id: newId,
        name: name,
        location_id: locationId,
        species: species,
        status: 'in_care',
      }),
    }).then(function (r) {
      return r.json().then(function (data) {
        return { ok: r.ok, data: data };
      }).catch(function () {
        return { ok: false, data: { error: 'parse error' } };
      });
    }).then(function (res) {
      if (res.ok && res.data && !res.data.error) {
        ovCloseNewCatModal();
        if (btn) {
          btn.disabled = false;
          btn.textContent = '登録する';
        }
        fetchData(0);
        window.location.href = 'cat.html?id=' + encodeURIComponent(res.data.id || newId);
        return;
      }
      var msg = (res.data && (res.data.message || res.data.error)) ? (res.data.message || res.data.error) : '登録に失敗しました';
      finishFail(msg);
    }).catch(function () {
      finishFail('ネットワークエラー');
    });
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

    var btnNewCat = document.getElementById('btnOvNewCat');
    if (btnNewCat) btnNewCat.addEventListener('click', ovOpenNewCatModal);
    var ovNcCancel = document.getElementById('ovNewCatCancel');
    if (ovNcCancel) ovNcCancel.addEventListener('click', ovCloseNewCatModal);
    var ovNcSubmit = document.getElementById('ovNewCatSubmit');
    if (ovNcSubmit) ovNcSubmit.addEventListener('click', ovSubmitNewCat);
    var ovNcModal = document.getElementById('ovNewCatModal');
    if (ovNcModal) {
      ovNcModal.addEventListener('click', function (ev) {
        if (ev.target === ovNcModal) ovCloseNewCatModal();
      });
    }

    try { buildCatNav(); } catch (e) { console.error('buildCatNav error', e); }

    window.addEventListener('pageshow', function (ev) {
      if (ev.persisted) cnInjectStyles();
    });

    setTimeout(function () { loadLocations(); }, 250);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(init, 100); });
  } else {
    setTimeout(init, 100);
  }

  // 猫ナビ: init() が何らかの理由で失敗しても FAB を生成するフォールバック
  setTimeout(function () {
    if (!_cnFab) {
      try { buildCatNav(); } catch (e) { console.error('[catNav fallback]', e); }
    }
  }, 4000);

  function switchMode(mode) {
    if (mode === currentMode) return;
    currentMode = mode;
    localStorage.setItem(MODE_KEY, mode);
    updateToggle();
    render();
  }

  function updateToggle() {
    if (btnPerCat) btnPerCat.className = currentMode === 'perCat' ? 'active' : '';
    if (btnPerItem) btnPerItem.className = currentMode === 'perItem' ? 'active' : '';
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

  var _refreshTimer = null;
  var _initialLoadDone = false;
  var _fetchSeq = 0;

  /**
   * fetchData(0)  — 保存後のバックグラウンドリフレッシュ（デバウンス 600ms、スピナーなし）
   * fetchData()   — 初回ロード / 拠点・ステータス切替（即時、スピナー付き）
   */
  function fetchData(retryCount) {
    var isSaveRefresh = arguments.length > 0 && retryCount === 0 && _initialLoadDone;
    retryCount = retryCount || 0;

    if (isSaveRefresh) {
      if (_refreshTimer) clearTimeout(_refreshTimer);
      _refreshTimer = setTimeout(function () { _refreshTimer = null; _doFetch(0, true); }, 600);
      return;
    }
    _doFetch(retryCount, false);
  }

  function _doFetch(retryCount, background) {
    var seq = ++_fetchSeq;

    if (!background) {
      if (window.NyagiBootOverlay && retryCount === 0) window.NyagiBootOverlay.show('猫一覧ユニット同期中…');
      cardArea.innerHTML = '<div class="loading">読み込み中...</div>';
    }

    var ctrl = new AbortController();
    var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
    fetch(getApiUrl() + locationQuery(), { headers: apiHeaders(), cache: 'no-store', signal: ctrl.signal })
      .then(function (r) {
        clearTimeout(timeoutId);
        return r.json().then(function (data) {
          if (data.error) throw new Error(data.message || data.error || 'APIエラー');
          if (!r.ok) throw new Error(data.message || 'HTTP ' + r.status);
          return data;
        });
      })
      .then(function (data) {
        if (seq !== _fetchSeq) return;
        catsData = data.cats || [];
        render();
        _initialLoadDone = true;
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        if (seq !== _fetchSeq) return;
        var isNetworkErr = (err && (err.name === 'AbortError' || (err.message && (err.message.indexOf('Failed to fetch') !== -1 || err.message.indexOf('NetworkError') !== -1 || err.message.indexOf('Load failed') !== -1))));
        if (isNetworkErr && retryCount < 2) {
          if (!background) {
            cardArea.innerHTML = '<div class="loading">読み込み中...（再試行 ' + (retryCount + 1) + '/2）</div>';
          }
          setTimeout(function () { _doFetch(retryCount + 1, background); }, 1200);
          return;
        }
        if (window.NyagiBootOverlay) window.NyagiBootOverlay.hideForce();
        if (!background) {
          var msg = err.name === 'AbortError' ? 'タイムアウトしました' : (err && err.message ? err.message : 'データ取得に失敗しました');
          var hint = (location.port !== '8001' && location.hostname === 'localhost') ? '<br><span style="font-size:11px;color:var(--text-dim);">※ http://localhost:8001/nyagi-app/ で開くと安定します</span>' : (isNetworkErr ? ' run-dev.ps1 で起動してください' : '');
          cardArea.innerHTML = '<div class="empty-msg">' + esc(msg) + hint + '</div>' +
            '<button class="btn btn-primary" style="margin-top:12px;display:block;margin-left:auto;margin-right:auto;" onclick="location.reload()">再試行</button>';
        }
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
      html += '<div class="pcc-card-wrap">';
      html += '<a href="' + catLink(c.id) + '" class="per-cat-card" data-cat-slug="' + escAttr(c.id) + '">';

      // ヘッダー: 名前 + ステータス + スコア
      html += '<div class="pcc-header">';
      html += '<div class="pcc-name">' + alertDot(c.alert_level) + speciesIcon(c.species) + ' ' + esc(c.name);
      if (c.status && c.status !== 'in_care') {
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
        html += fmtWeightJstHtml(c.weight_record_date, c.weight_recorded_at);
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

      // 投薬（チェックボックス付き）
      html += '<div class="pcc-med-block">';
      html += '<div class="pcc-metric-label">💊 投薬</div>';
      var meds = c.meds_today || { done: 0, total: 0, items: [] };
      if (meds.total > 0) {
        var medColor = meds.done >= meds.total ? 'score-color-green' : meds.done > 0 ? 'score-color-yellow' : 'score-color-red';
        var medIcon = meds.done >= meds.total ? '✅' : '⏳';
        html += '<div class="pcc-metric-value ' + medColor + '">' + medIcon + ' ' + meds.done + '/' + meds.total + '</div>';
        var medItems = meds.items || [];
        for (var mi = 0; mi < medItems.length; mi++) {
          var mit = medItems[mi];
          var miDone = mit.status === 'done';
          var miSkip = mit.status === 'skipped';
          var miCls = miDone ? 'med-item-done' : miSkip ? 'med-item-skip' : 'med-item-pending';
          var miLid = mit.log_id != null && mit.log_id !== '' ? String(mit.log_id) : '';
          if (miLid) {
            html += '<label class="ov-med-item-row ' + miCls + '">' +
              '<input type="checkbox" class="ov-med-log-cb" data-log-id="' + escAttr(miLid) + '" ' + (miDone ? 'checked' : '') + '>' +
              '<span class="ov-med-item-text">' + (mit.slot ? '<b>' + esc(mit.slot) + '</b> ' : '') + esc(mit.name) + (mit.dosage ? ' <small>' + esc(mit.dosage) + '</small>' : '') + '</span>' +
              '</label>';
          } else {
            html += '<div class="ov-med-item-row ' + miCls + '" style="font-size:12px;">' +
              (miDone ? '✅' : miSkip ? '⏭️' : '🔴') + ' ' + (mit.slot ? '<b>' + esc(mit.slot) + '</b> ' : '') + esc(mit.name) + (mit.dosage ? ' <small>' + esc(mit.dosage) + '</small>' : '') +
              '</div>';
          }
        }
      } else {
        html += '<div class="pcc-metric-value dim">--</div>';
      }
      html += '</div>';

      html += '</div>'; // pcc-metrics

      // 昨日のあげた記録の取消は「🥄残し」モーダル内のみ（一覧をすっきりさせる）

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

      // ケア実施状況（1行カード）— タップで取消
      var care = c.care_latest || [];
      if (care.length > 0) {
        html += '<div class="pcc-care">';
        html += '<span class="pcc-care-label">ケア ' + (c.care_date || '').slice(5) + '</span>';
        for (var ci = 0; ci < care.length; ci++) {
          var done = care[ci].done;
          var cls = done ? 'care-done' : 'care-skip';
          var careIdAttr = care[ci].id ? ' data-care-id="' + escAttr(String(care[ci].id)) + '"' : '';
          html += '<span class="care-chip care-chip-tap ' + cls + '"' + careIdAttr + ' style="cursor:pointer;">' + esc(care[ci].type);
          if (done && care[ci].by) html += '<small>' + esc(care[ci].by) + '</small>';
          html += '</span>';
        }
        html += '</div>';
      }

      html += '<div class="pcc-care-bundle-wrap" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);">';
      html += '<button type="button" class="btn btn-primary btn-pcc-care-bundle" data-cat-id="' + escAttr(String(c.id)) + '" style="width:100%;font-size:11px;padding:8px 10px;">🪮 ケア5項目まとめて記録</button>';
      html += '<div class="dim" style="font-size:9px;margin-top:4px;line-height:1.35;text-align:center;">ブラシ・アゴ・耳・お尻・目ヤニ（当日・未記録分のみ）</div>';
      html += '</div>';
      html += buildCareIndividualFormForPcc(c);

      html += '</a>';
      html += buildPccVomitStrip(c);
      html += '</div>';
    }
    html += '</div>';
    cardArea.innerHTML = html;
    bindPerCatMedCheckboxes();
    bindOverviewInlineHandlers();
  }

  var _perCatMedBound = false;
  function bindPerCatMedCheckboxes() {
    if (_perCatMedBound) return;
    _perCatMedBound = true;
    cardArea.addEventListener('click', function (ev) {
      if (!ev.target.closest) return;
      var inMedBlock = ev.target.closest('.pcc-med-block');
      var inCareBundle = ev.target.closest('.pcc-care-bundle-wrap');
      var inCareIndividual = ev.target.closest('.pcc-care-individual-wrap');
      var inCareChip = ev.target.closest('.pcc-care');
      if (!inMedBlock && !inCareBundle && !inCareIndividual && !inCareChip) return;
      var anchor = ev.target.closest('a.per-cat-card');
      if (anchor) { ev.preventDefault(); }
    });
    cardArea.addEventListener('change', function (ev) {
      var cb = ev.target;
      if (!cb || cb.type !== 'checkbox' || !cb.classList.contains('ov-med-log-cb')) return;
      if (!cb.closest || !cb.closest('.pcc-med-block')) return;
      var logId = cb.getAttribute('data-log-id');
      if (!logId) return;
      postMedicationLogChange(cb, logId, cb.checked);
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  モード2: 項目ごと
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 開いているカード index のみ true。未設定＝すべて折りたたみがデフォルト（カード構成変更時はキーを変えてインデックスずれを防ぐ） */
  var EXPANDED_KEY = 'nyagi_items_expanded_v11';
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
    html += renderItemCard_Tasks();
    html += renderItemCard_Stool();
    html += renderItemCard_Urine();
    html += renderItemCard_Vomit();
    html += renderItemCard_Weight();
    html += renderItemCard_Meds();
    html += renderItemCard_FeedingCheck();
    html += renderItemCard_Care();
    html += renderItemCard_Medical();
    cardArea.innerHTML = html;
    bindOverviewInlineHandlers();
    ovFetchVomitRecent();

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
    return '<a href="' + catLink(c.id) + '" class="item-row" data-cat-slug="' + escAttr(c.id) + '" style="display:flex;align-items:center;gap:8px;text-decoration:none;color:inherit;-webkit-tap-highlight-color:rgba(255,255,255,0.1);">' + content + '</a>';
  }

  function itemRowEditable(c, valuesHtml, editHtml, linkHash) {
    var editBlock = editHtml ? '<div class="item-inline-edit">' + editHtml + '</div>' : '';
    var href = catLink(c.id, linkHash || '');
    return '<div class="item-row item-row-editable" data-cat-slug="' + escAttr(c.id) + '">' +
      '<a href="' + href + '" class="item-cat-name item-cat-link">' + alertDot(c.alert_level) + esc(c.name) + '</a>' +
      '<div class="item-values">' + valuesHtml + '</div>' +
      editBlock +
      '</div>';
  }

  function excretionEditBlockStool() {
    return '<div class="ov-ex-edit">' +
      '<p class="dim ov-ex-edit-hint">状態を選んで保存（帯・日付も変更可）</p>' +
      buildStoolStatusGridHtml('ov-inline-input ov-ex-sel-st') +
      '<div class="ov-ex-inline-hr-row">' +
      '<select class="ov-inline-select ov-ex-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-ex-inp-date">' +
      '<button type="button" class="btn btn-primary btn-ov-hr-save">保存</button>' +
      '<button type="button" class="btn btn-ov-hr-cancel">取消</button>' +
      '</div></div>';
  }

  function excretionEditBlockUrine() {
    return '<div class="ov-ex-edit">' +
      '<p class="dim ov-ex-edit-hint">状態を選んで保存（帯・日付も変更可）</p>' +
      buildUrineStatusGridHtml('ov-inline-input ov-ex-sel-ur') +
      '<div class="ov-ex-inline-hr-row">' +
      '<select class="ov-inline-select ov-ex-sel-slot">' + OPT_SLOT + '</select>' +
      '<input type="date" class="ov-inline-date ov-ex-inp-date">' +
      '<button type="button" class="btn btn-primary btn-ov-hr-save">保存</button>' +
      '<button type="button" class="btn btn-ov-hr-cancel">取消</button>' +
      '</div></div>';
  }

  function buildStoolEntriesHtml(stoolArr) {
    var arr = stoolArr || [];
    if (arr.length === 0) return '<span class="dim">未記録</span>';
    var html = '';
    for (var i = 0; i < arr.length; i++) {
      var e = arr[i];
      var pastSt = excretionPastRowClass(e.record_date);
      if (e.record_id) {
        var badgeSt = e.voice_input_id ? ' <small class="dim source-badge">音声</small>' : '';
        html += '<div class="ov-ex-row' + pastSt + '" data-record-id="' + escAttr(String(e.record_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="stool">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span>' + badgeSt;
        html += '<div class="ov-ex-actions">';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div></div>';
        html += excretionEditBlockStool();
        html += '</div>';
      } else if (e.voice_input_id) {
        html += '<div class="ov-ex-row ov-ex-voice-only' + pastSt + '" data-voice-input-id="' + escAttr(String(e.voice_input_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="stool">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span> <small class="dim source-badge">音声</small>';
        html += '<div class="ov-ex-actions">';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div></div>';
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
      var pastUr = excretionPastRowClass(e.record_date);
      if (e.record_id) {
        var badgeUr = e.voice_input_id ? ' <small class="dim source-badge">音声</small>' : '';
        html += '<div class="ov-ex-row' + pastUr + '" data-record-id="' + escAttr(String(e.record_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="urine">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span>' + badgeUr;
        html += '<div class="ov-ex-actions">';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div></div>';
        html += excretionEditBlockUrine();
        html += '</div>';
      } else if (e.voice_input_id) {
        html += '<div class="ov-ex-row ov-ex-voice-only' + pastUr + '" data-voice-input-id="' + escAttr(String(e.voice_input_id)) + '" data-hr-value="' + escAttr(e.value_raw == null ? '' : String(e.value_raw)) + '" data-hr-details="' + escAttr(e.details_slot == null ? '' : String(e.details_slot)) + '" data-hr-date="' + escAttr(e.record_date == null ? '' : String(e.record_date)) + '" data-hr-kind="urine">';
        html += '<div class="ov-ex-display"><span class="ov-ex-text">' + esc(ovExcretionLineText(e)) + '</span> <small class="dim source-badge">音声</small>';
        html += '<div class="ov-ex-actions">';
        html += '<button type="button" class="btn btn-ov-hr-edit">編集</button>';
        html += '<button type="button" class="btn btn-ov-hr-del">削除</button></div></div>';
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
    html += renderExcretionBulkBar('stool');
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
    html += renderExcretionBulkBar('urine');
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var urine = c.urine_today || [];
      html += itemRowEditable(c, '<div class="item-values-excretion">' + buildUrineEntriesHtml(urine) + '</div>', buildUrineInlineEdit(c));
    }
    html += '</div></div>';
    return html;
  }

  // ── はき戻し記録カード ──

  var _vomitRecentCache = null;

  /**
   * 猫ナビ cnPopulateList は各 .item-card 内の [data-cat-slug] を数える。
   * はき戻しカードはフォーム＋非同期テーブル主体のため、従来の itemRow が無い → 非表示の行だけ足す。
   */
  function cnHiddenCatSlugsForNavHtml() {
    var h = '<div class="cn-item-card-cat-slugs" aria-hidden="true" style="display:none">';
    for (var a = 0; a < catsData.length; a++) {
      var cx = catsData[a];
      h += '<div class="item-row" data-cat-slug="' + escAttr(cx.id) + '">';
      h += '<span class="item-cat-name">' + alertDot(cx.alert_level) + esc(cx.name) + '</span></div>';
    }
    h += '</div>';
    return h;
  }

  function renderItemCard_Vomit() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🤮 はき戻し記録</div>';
    html += '<div class="item-card-body">';
    html += cnHiddenCatSlugsForNavHtml();

    html += '<div class="ov-vomit-form" id="ovVomitForm">';
    html += '<div class="ov-vomit-row">';
    html += '<select class="ov-inline-select ov-vomit-cat" id="ovVomitCat" style="flex:1;">';
    html += '<option value="">猫を選択…</option>';
    for (var i = 0; i < catsData.length; i++) {
      html += '<option value="' + escAttr(catsData[i].id) + '">' + esc(catsData[i].name) + '</option>';
    }
    html += '</select>';
    html += '<select class="ov-inline-select ov-vomit-count" id="ovVomitCount">';
    html += '<option value="1">1回</option><option value="2">2回</option><option value="3">3回</option>';
    html += '</select>';
    html += '<input type="date" class="ov-inline-input ov-vomit-date" id="ovVomitDate" value="' + todayJstYmd() + '" style="width:120px;">';
    html += '<button type="button" class="btn btn-primary btn-ov-vomit-save" id="btnOvVomitSave" style="white-space:nowrap;">記録</button>';
    html += '</div>';
    html += '<div class="ov-vomit-note-row">';
    html += '<input type="text" class="ov-inline-input ov-vomit-note" id="ovVomitNote" placeholder="メモ（任意：泡状、食後など）" style="flex:1;">';
    html += '</div>';
    html += '</div>';

    html += '<div class="ov-vomit-recent" id="ovVomitRecent">';
    html += '<div class="dim" style="font-size:12px;padding:8px 0;">直近の記録を読み込み中…</div>';
    html += '</div>';

    html += '</div></div>';
    return html;
  }

  function ovFetchVomitRecent() {
    var url = apiOpsBase() + '/health/records?type=vomiting&limit=30';
    fetch(url, { method: 'GET', headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var recs = data.records || [];
        _vomitRecentCache = recs;
        ovRenderVomitRecent(recs, null);
      })
      .catch(function () {
        var el = document.getElementById('ovVomitRecent');
        if (el) el.innerHTML = '<div class="dim" style="font-size:12px;padding:4px 0;">取得失敗</div>';
      });
  }

  function ovRenderVomitRecent(recs, filterCatId) {
    var el = document.getElementById('ovVomitRecent');
    if (!el) return;
    var filtered = [];
    for (var i = 0; i < recs.length; i++) {
      if (!filterCatId || recs[i].cat_id === filterCatId) filtered.push(recs[i]);
      if (filtered.length >= 5) break;
    }
    if (filtered.length === 0) {
      el.innerHTML = '<div class="dim" style="font-size:12px;padding:4px 0;">' + (filterCatId ? 'この猫の記録なし' : '記録なし') + '</div>';
      return;
    }
    var catNameMap = {};
    for (var ci = 0; ci < catsData.length; ci++) catNameMap[catsData[ci].id] = catsData[ci].name;
    var todayV = todayJstYmd();
    var html = '<table class="ov-vomit-table"><thead><tr><th>日付</th><th>猫</th><th>回数</th><th>メモ</th><th></th></tr></thead><tbody>';
    for (var j = 0; j < filtered.length; j++) {
      var r = filtered[j];
      var rd = (r.record_date || '').slice(5);
      var cn = catNameMap[r.cat_id] || r.cat_id;
      var cnt = '1回';
      var vm = (r.value || '').match(/(\d+)\s*回/);
      if (vm) cnt = vm[1] + '回';
      else if (r.value) cnt = r.value;
      var note = '';
      if (r.details) {
        try { var dp = JSON.parse(r.details); note = dp.note || dp.finding || r.details; } catch (_) { note = r.details; }
      }
      var rowYmd = overviewClientRecordDateYmd(r.record_date);
      var isTodayRow = rowYmd === todayV;
      html += '<tr><td>' + esc(rd) + '</td><td>' + esc(cn) + '</td><td>' + esc(cnt) + '</td><td class="ov-vomit-note-cell">' + esc(note || '') + '</td>';
      var vVoice = r.voice_input_id != null && r.voice_input_id !== '' ? escAttr(String(r.voice_input_id)) : '';
      if (isTodayRow) {
        html += '<td><button type="button" class="btn-ov-vomit-del" data-vomit-record-ymd="' + escAttr(rowYmd) + '" data-voice-id="' + vVoice + '" data-record-id="' + escAttr(String(r.id)) + '" title="本日分のみ削除">✕</button></td></tr>';
      } else {
        html += '<td class="dim" style="font-size:10px;text-align:center;">—</td></tr>';
      }
    }
    html += '</tbody></table>';
    html += '<div class="dim" style="font-size:10px;margin-top:6px;line-height:1.35;">✕ は本日（日本時間）の行のみ削除できます。過去日は猫詳細の健康記録から削除してください。</div>';
    el.innerHTML = html;
  }

  function ovSaveVomitRecord(btn) {
    var catSel = document.getElementById('ovVomitCat');
    var countSel = document.getElementById('ovVomitCount');
    var dateInp = document.getElementById('ovVomitDate');
    var noteInp = document.getElementById('ovVomitNote');
    var catId = catSel && catSel.value;
    if (!catId) { alert('猫を選択してください'); return; }
    var count = countSel ? countSel.value : '1';
    var rd = dateInp ? dateInp.value : todayJstYmd();
    if (!rd) { alert('日付を入力してください'); return; }
    var noteText = noteInp ? noteInp.value.trim() : '';
    var details = noteText ? JSON.stringify({ note: noteText }) : null;
    postHealthRecord({
      cat_id: catId,
      record_type: 'vomiting',
      record_date: rd,
      recorded_time: nowJstHm(),
      value: count + '回',
      details: details,
    }, btn);
    if (noteInp) noteInp.value = '';
  }

  function ovDeleteVomitRecord(btn) {
    if (!btn) return;
    var vid = btn.getAttribute('data-voice-id') || '';
    var rid = btn.getAttribute('data-record-id') || '';
    if (!vid && !rid) {
      alert('削除対象のIDがありません');
      return;
    }
    var ymdAttr = btn.getAttribute('data-vomit-record-ymd');
    if (ymdAttr != null && String(ymdAttr).trim() !== '') {
      if (overviewClientRecordDateYmd(ymdAttr) !== todayJstYmd()) {
        alert('はき戻し記録の削除は、本日（日本時間）の分のみ行えます。過去日は猫詳細の健康記録から削除してください。');
        return;
      }
    }
    if (!confirm('このはき戻し（本日分）記録を削除しますか？')) return;
    var prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    var url = vid
      ? apiOpsBase() + '/voice/inputs/' + encodeURIComponent(vid) + '/excretion'
      : apiOpsBase() + '/health/records/' + encodeURIComponent(rid);
    fetch(url, {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        btn.disabled = false;
        btn.textContent = prevText;
        if (data.error) { alert('削除失敗: ' + (data.message || data.error)); return; }
        fetchData(0);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = prevText;
        alert('削除に失敗しました');
      });
  }

  /** record_date を YYYY-MM-DD に（API の表記ブレ対策・フォールバック削除の日付一致用） */
  function overviewClientRecordDateYmd(d) {
    if (d == null || d === '') return '';
    var s = String(d).trim();
    if (s.length >= 10) return s.slice(0, 10);
    return s;
  }

  /** 一覧に vomit_today_entries が無いが件数だけ付いているとき、猫別取得で本日分を削除 */
  function ovFetchAndDeleteTodaysVomitForCat(catId, btn) {
    if (!confirm('この猫の「本日（JST）」のはき戻し／嘔吐に該当する健康記録だけをAPIから取得して削除します。よろしいですか？')) return;
    var prevText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '取得中…';
    var today = todayJstYmd();
    fetch(
      apiOpsBase() + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=vomiting&limit=50',
      { headers: apiHeaders(), cache: 'no-store' }
    )
      .then(function (r) { return r.json(); })
      .then(function (data) {
        btn.disabled = false;
        btn.textContent = prevText;
        if (data.error) {
          alert('取得失敗: ' + (data.message || data.error));
          return;
        }
        var recs = data.records || [];
        var hits = [];
        for (var i = 0; i < recs.length; i++) {
          if (String(recs[i].cat_id || '') !== String(catId)) continue;
          if (overviewClientRecordDateYmd(recs[i].record_date) !== today) continue;
          if (recs[i].id != null && recs[i].id !== '') hits.push(recs[i].id);
        }
        if (hits.length === 0) {
          alert('本日分の該当レコードが見つかりませんでした。日付・拠点フィルタを確認するか、猫詳細の健康記録から削除してください。');
          return;
        }
        if (hits.length > 1 && !confirm('本日該当が ' + hits.length + ' 件あります。まとめて削除しますか？')) return;
        ovDeleteHealthRecordIdsSequential(hits, 0);
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = prevText;
        alert('取得に失敗しました');
      });
  }

  function ovDeleteHealthRecordIdsSequential(ids, idx) {
    if (idx >= ids.length) {
      fetchData(0);
      return;
    }
    fetch(apiOpsBase() + '/health/records/' + encodeURIComponent(ids[idx]), {
      method: 'DELETE',
      headers: apiHeaders(),
      cache: 'no-store',
    })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          alert('削除失敗: ' + (data.message || data.error));
          return;
        }
        ovDeleteHealthRecordIdsSequential(ids, idx + 1);
      })
      .catch(function () {
        alert('削除に失敗しました');
      });
  }

  /** 項目ごと・体重カード: 本日（JST）計測済みを下に（未計測を上から順に操作しやすく） */
  function orderCatsForWeightCard() {
    var list = catsData.slice();
    list.sort(function (a, b) {
      var ta = a.weight_recorded_today ? 1 : 0;
      var tb = b.weight_recorded_today ? 1 : 0;
      if (ta !== tb) return ta - tb;
      var sa = a.health_score !== null && a.health_score !== undefined ? a.health_score : 999;
      var sb = b.health_score !== null && b.health_score !== undefined ? b.health_score : 999;
      if (sa !== sb) return sa - sb;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ja');
    });
    return list;
  }

  function renderItemCard_Weight() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">⚖️ 体重 / 🍽 食欲 <small class="dim" style="font-weight:500;">本日計測済みは下段</small></div>';
    html += '<div class="item-card-body">';
    var weightOrder = orderCatsForWeightCard();
    for (var i = 0; i < weightOrder.length; i++) {
      var c = weightOrder[i];
      var wStr = '';
      if (c.weight_latest !== null) {
        wStr = '<div class="ov-weight-inline" style="display:inline-flex;flex-direction:column;align-items:flex-start;max-width:100%;">' +
          '<span style="white-space:nowrap;">' + c.weight_latest.toFixed(1) + 'kg' +
          (c.weight_previous !== null
            ? ' <span class="trend-' + c.weight_trend + '">' +
              (Math.abs(c.weight_latest - c.weight_previous) >= 0.05 ? Math.abs(c.weight_latest - c.weight_previous).toFixed(1) : '') +
              '</span>'
            : '') +
          '</span>' +
          fmtWeightJstHtml(c.weight_record_date, c.weight_recorded_at) +
          '</div>';
      } else {
        wStr = '<span class="dim">体重--</span>';
      }
      var aStr = c.feeding_today_pct !== null && c.feeding_today_pct !== undefined ? '<span class="' + (c.feeding_today_pct >= 80 ? 'score-color-green' : c.feeding_today_pct >= 50 ? 'score-color-yellow' : 'score-color-red') + '">食欲 ' + c.feeding_today_pct + '%</span>' : '<span class="dim">食欲--</span>';
      html += itemRowEditable(c, wStr + aStr, buildWeightInlineEdit(c));
    }
    html += '</div></div>';
    return html;
  }

  /**
   * 献立の meal_slot → 短いラベル（朝と同じ BMP 記号系で夜も必ず見えるようにする）
   * ※ 🌙(U+1F319) は端末・WebView によって非表示になり「夜」だけ見えることがあるため ☾(U+263E) を使う
   */
  function feedingMealSlotLabelJp(slot) {
    var raw = slot == null ? '' : String(slot).trim();
    try {
      if (raw.normalize) raw = raw.normalize('NFKC');
    } catch (e) {}
    var n = ovNormMealSlot(raw);
    if (n === 'morning') return '☀朝';
    if (n === 'afternoon') return '🌤昼';
    if (n === 'evening') return '☾夜';
    if (n === 'snack') return '🍪おやつ';
    var sl = raw.toLowerCase();
    var m = {
      morning: '☀朝', afternoon: '🌤昼', evening: '☾夜', night: '☾夜', noon: '🌤昼', dinner: '☾夜',
      朝: '☀朝', 昼: '🌤昼', 夜: '☾夜', 夕: '☾夜', 晩: '☾夜',
      snack: '🍪おやつ', treat: '🍪おやつ',
    };
    if (m[raw]) return m[raw];
    if (m[sl]) return m[sl];
    return esc(raw);
  }

  /** 残量確認済みログに基づく食いつき（overview API の food_preference_summary）— 一覧は G/H/D でコンパクト */
  function ovHtmlFoodPreferenceBlock(c) {
    var s = c.food_preference_summary;
    var boxStyle =
      'margin:0 0 6px;padding:6px 8px;background:rgba(34,197,94,0.08);border-radius:8px;border-left:3px solid rgba(34,197,94,0.45);';
    if (!s || !s.has_data) {
      return (
        '<div class="nyagi-fp-wrap" style="' +
        boxStyle +
        '" title="摂取率が記録された給餌ログが1件でもあれば表示（最大90日遡り）">' +
        '<div class="dim" style="font-size:10px;line-height:1.35;">🍽 食いつき：データなし（摂取率記録で表示）</div>' +
        '</div>'
      );
    }
    var metaParts = [];
    if (s.weighted_avg_pct != null) {
      metaParts.push('平均<b>' + s.weighted_avg_pct + '%</b>');
    }
    if (s.spread_pct != null) {
      metaParts.push('差<b>' + s.spread_pct + 'pt</b>');
    }
    if (s.tiers) {
      metaParts.push('高' + s.tiers.high + '/中' + s.tiers.mid + '/低' + s.tiers.low);
    }
    var maxD =
      s.period_days_max != null ? s.period_days_max : s.period_days != null ? s.period_days : 90;
    var span = s.record_span_days;
    var subTit = '最大' + maxD + '日遡り';
    if (span != null && span > 0 && maxD && span < maxD) {
      subTit = '記録' + span + '暦日/最大' + maxD + '日';
    }
    var titleFull = '食いつき傾向（' + subTit + '）';
    var headShort = '🍽 ' + maxD + '日 · 傾向';
    var h = '<div class="nyagi-fp-wrap" style="' + boxStyle + '">';
    h +=
      '<div style="font-size:11px;font-weight:700;color:#4ade80;margin-bottom:2px;line-height:1.3;" title="' +
      escAttr(titleFull) +
      '">' +
      headShort +
      '</div>';
    h +=
      '<div class="dim" style="font-size:10px;margin-bottom:3px;line-height:1.35;">' +
      esc(s.summary_line || '') +
      '</div>';
    if (metaParts.length) {
      h += '<div style="font-size:10px;color:var(--text-main);margin-bottom:4px;line-height:1.35;">' + metaParts.join(' · ') + '</div>';
    }
    var tops = s.top_foods || [];
    for (var i = 0; i < tops.length; i++) {
      var tf = tops[i];
      var d = tf.delta_vs_weighted_avg;
      var dStr = '';
      if (d != null) {
        if (d > 0) {
          dStr = '<span style="color:#4ade80;font-weight:600;">+' + d + 'pt</span>';
        } else if (d < 0) {
          dStr = '<span style="color:#f87171;font-weight:600;">' + d + 'pt</span>';
        } else {
          dStr = '<span class="dim">±0</span>';
        }
      }
      var rel =
        tf.reliability === 'low'
          ? '<span class="dim" style="font-size:9px;">（参考）</span>'
          : tf.reliability === 'mid'
            ? '<span class="dim" style="font-size:9px;">（2回）</span>'
            : '';
      h += '<div style="display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;font-size:10px;line-height:1.35;padding:2px 0;margin:0;">';
      h +=
        '<span style="font-weight:600;flex:1;min-width:6em;word-break:break-word;">' +
        esc(String(tf.name || '—')) +
        rel +
        '</span>';
      h += '<span style="white-space:nowrap;flex-shrink:0;">';
      h += '<strong>' + (tf.avg_eaten_pct != null ? tf.avg_eaten_pct : '—') + '%</strong>';
      if (dStr) h += ' · ' + dStr;
      h += ' <span class="dim">' + (tf.times_served || 0) + '回</span>';
      h += '</span></div>';
    }
    h += '</div>';
    return h;
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
        h += '<button type="button" class="btn btn-outline btn-ov-feed-delmemo" data-note-id="' + escAttr(noteId) + '" title="このメモを削除">削除</button>';
      }
      h += '</div><span style="color:var(--text-main);white-space:pre-wrap;">' + esc(fn) + '</span></div>';
    }
    return h;
  }

  /** ごはんカード用の並び: CAFE 拠点 or 在籍フィルタ時はコハダ・なめこを最上段（ゲームキャラ優先） */
  function orderCatsForFeedingCard() {
    var list = catsData.slice();
    var pinContext = currentLocationId === 'cafe' || currentStatusId === 'active';
    if (!pinContext) return list;
    function feedingPinRank(cat) {
      var id = String((cat && cat.id) || '').trim();
      var n = (cat && cat.name) ? String(cat.name).trim() : '';
      if (id === 'cat_こはだ') return 0;
      if (n === 'コハダ' || n === 'こはだ') return 0;
      if (id === 'cat_なめこ') return 1;
      if (n === 'なめこ' || n === 'ナメコ') return 1;
      return 100;
    }
    list.sort(function (a, b) {
      var ra = feedingPinRank(a);
      var rb = feedingPinRank(b);
      if (ra !== rb) return ra - rb;
      var sa = a.health_score !== null && a.health_score !== undefined ? a.health_score : 999;
      var sb = b.health_score !== null && b.health_score !== undefined ? b.health_score : 999;
      return sa - sb;
    });
    return list;
  }

  function ovHtmlFeedPlanRowBlock(p, c) {
    var cidStr = c && c.id != null ? String(c.id) : '';
    var cnameStr = c && c.name != null ? String(c.name) : '';
    var menu = esc(p.food_name || '—');
    if (p.amount_g != null && p.amount_g !== '') menu += ' <strong>' + esc(String(p.amount_g)) + 'g</strong>';
    var st = '';
    var pidStr = p.plan_id != null ? String(p.plan_id) : '';
    var logIdStr = p.log_id != null ? String(p.log_id) : '';
    var logIdsCsv = (p.log_ids_csv != null && String(p.log_ids_csv).trim() !== '') ? String(p.log_ids_csv).trim() : logIdStr;
    var offeredGLogStr = p.offered_g_log != null ? String(p.offered_g_log) : '';
    var fedTm = p.fed_served_time ? ovFmtFedServedTime(p.fed_served_time) : '';
    if (p.fed_today) {
      if (logIdsCsv) {
        st = '<input type="checkbox" class="ov-feed-fed-cb" data-log-ids="' + escAttr(logIdsCsv) + '" checked title="あげた／チェックを外すと取り消し">';
      } else {
        st = '<span class="feed-done">✅</span>';
      }
      if (fedTm) st += '<span class="dim" style="margin-left:3px;">🕐' + esc(fedTm) + '</span> ';
      if (p.eaten_pct_today != null && p.eaten_pct_today !== '') {
        st += '<span class="dim">' + esc(String(p.eaten_pct_today)) + '%</span> ';
      } else {
        st += '<span class="dim" style="color:#fbbf24;">0%</span> ';
      }
      if (logIdsCsv) {
        st += '<button type="button" class="btn btn-outline btn-ov-feed-editlog" data-log-id="' + escAttr(logIdStr || logIdsCsv.split(',')[0]) + '" data-food-name="' + escAttr(p.food_name || '') + '" data-offered-g="' + escAttr(offeredGLogStr || String(p.amount_g || '')) + '" data-eaten-pct="' + escAttr(p.eaten_pct_today != null && p.eaten_pct_today !== '' ? String(p.eaten_pct_today) : '') + '" data-served-time="' + escAttr(fedTm || '') + '">✏️</button> ';
      }
    } else if (pidStr) {
      st = '<button type="button" class="btn btn-primary btn-ov-feed-markfed" data-plan-id="' + escAttr(pidStr) + '" data-food-name="' + escAttr(p.food_name || '') + '" data-amount-g="' + escAttr(String(p.amount_g || '')) + '">あげた</button> ';
    } else {
      st = '<span class="feed-pending">⬜</span> ';
    }
    if (pidStr && cidStr) {
      st += '<button type="button" class="btn btn-outline btn-ov-feed-delplan" style="font-size:11px;padding:4px 8px;" data-plan-id="' + escAttr(pidStr) + '" data-cat-name="' + escAttr(cnameStr) + '" title="献立から削除">🗑</button> ';
    }
    var linePctClass = '';
    if (p.fed_today) {
      var epRow2 = (p.eaten_pct_today != null && p.eaten_pct_today !== '') ? Number(p.eaten_pct_today) : NaN;
      if (!isNaN(epRow2) && epRow2 !== 0) linePctClass = ' ov-feed-line--has-eaten-pct';
    }
    var out = '<div class="ov-feed-line' + linePctClass + '"><span class="ov-feed-slot">' + feedingMealSlotLabelJp(p.meal_slot) + '</span><span class="ov-feed-menu">' + menu + '</span><span class="ov-feed-status">' + st + '</span></div>';

    var intakeHtml = '';
    if (p.fed_today && logIdsCsv) {
      var idArrLo = String(logIdsCsv).split(',').map(function (x) { return parseInt(String(x).trim(), 10); }).filter(function (n) { return !isNaN(n); });
      if (idArrLo.length === 1) {
        var sidLo = String(idArrLo[0]);
        var offGStrLo = offeredGLogStr || String(p.amount_g || '');
        var ogNumLo = parseFloat(offGStrLo);
        var safePid = String(pidStr || 'x').replace(/[^a-zA-Z0-9_-]/g, '_');
        var loInpId = 'ov-feed-lo-' + sidLo + '-' + safePid;
        var prefillLo = ovLeftoverGFromOfferedPct(offGStrLo, p.eaten_pct_today);
        intakeHtml = '<div class="ov-feed-intake-row">';
        intakeHtml += '<button type="button" class="btn btn-outline btn-ov-feed-intake-complete" style="font-size:10px;padding:3px 8px;" data-log-id="' + escAttr(sidLo) + '" title="あげた後の記録を完食（100%）に更新">完食</button>';
        if (!isNaN(ogNumLo) && ogNumLo > 0) {
          intakeHtml += '<span class="dim" style="font-size:10px;">残り</span>';
          intakeHtml += '<input type="number" id="' + loInpId + '" class="form-input ov-feed-leftover-g-inp" min="0" step="0.1" placeholder="g" style="width:52px;font-size:11px;padding:2px 4px;" max="' + escAttr(String(ogNumLo)) + '" value="' + escAttr(prefillLo) + '">';
          intakeHtml += '<button type="button" class="btn btn-outline btn-ov-feed-intake-leftover" style="font-size:10px;padding:3px 8px;" data-log-id="' + escAttr(sidLo) + '" data-offered-g="' + escAttr(String(ogNumLo)) + '" data-input-id="' + escAttr(loInpId) + '">残し反映</button>';
        } else {
          intakeHtml += '<span class="dim" style="font-size:10px;margin-left:4px;">提供量未設定のため残りgは✏️</span>';
        }
        intakeHtml += '</div>';
      }
    }

    var noteBlock = '';
    if (p.notes && String(p.notes).trim()) {
      noteBlock = '<div class="ov-feed-line-note" style="font-size:10px;color:var(--text-dim);margin:-2px 0 6px 0;padding:4px 8px 4px 28px;background:rgba(255,255,255,0.04);border-radius:4px;line-height:1.35;">📝 ' + esc(String(p.notes).trim()) + '</div>';
    }
    return '<div class="ov-feed-plan-block">' + out + intakeHtml + noteBlock + '</div>';
  }

  function ovHtmlFeedPlanLinesFromArr(arr, c) {
    if (!arr || arr.length === 0) {
      return '<span class="dim" style="font-size:11px;">—</span>';
    }
    var s = '';
    for (var k = 0; k < arr.length; k++) {
      s += ovHtmlFeedPlanRowBlock(arr[k], c);
    }
    return s;
  }

  function renderItemCard_FeedingCheck() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🍚 ごはん <small class="dim">あげた・残し</small></div>';
    html += '<div class="item-card-body">';
    html += '<div class="ov-feed-hint" style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.4;">上の<strong>大きい2ボタン</strong>で<strong>献立の追加</strong>と<strong>昨夜の残し記録</strong>。ここは<strong>本日の献立</strong>のみ。まず<strong>あげた</strong>のあと、<strong>完食</strong>・<strong>残りg＋残し反映</strong>で摂取を記録（✏️はログ編集）。🗑は献立削除。プリセットの編集は猫の<strong>詳細ページ</strong>を別途開いてください。<strong>業務終了の一括処理</strong>では献立が入れ替わることがあります。<strong>「あげた」の取り消しは左のチェック</strong>。複数ログは✏️で調整。</div>';
    var feedCats = orderCatsForFeedingCard();
    for (var i = 0; i < feedCats.length; i++) {
      var c = feedCats[i];
      var plan = c.feeding_plan || [];
      var inner = '';
      var toolbar = '<div class="ov-feed-toolbar">' +
        '<button type="button" class="btn btn-outline btn-ov-feed-addplan ov-feed-toolbar-btn-main" data-cat-id="' + escAttr(String(c.id)) + '" title="この猫に本日の献立の行を追加します">＋ 献立を追加</button>' +
        '<button type="button" class="btn btn-outline btn-ov-feed-leftover ov-feed-toolbar-btn-main" data-cat-id="' + escAttr(String(c.id)) + '" title="昨日・昨夜分の残り量・あげた取消はここから">🥄 残し記録</button>' +
        '</div>';
      var prefBlock = ovHtmlFoodPreferenceBlock(c);
      var memoBlock = ovHtmlFeedingSyncedMemos(c);
      if (plan.length === 0) {
        inner = prefBlock + memoBlock + '<span class="dim">献立なし（上の「献立を追加」から登録）</span>';
      } else {
        inner = prefBlock + memoBlock;
        var amP = [];
        var pmP = [];
        var otP = [];
        for (var j = 0; j < plan.length; j++) {
          var bk = ovFeedPlanColumnBucket(plan[j].meal_slot);
          if (bk === 'am') amP.push(plan[j]);
          else if (bk === 'pm') pmP.push(plan[j]);
          else otP.push(plan[j]);
        }
        inner += '<div class="ov-med-two-cols ov-feed-two-cols">' +
          '<div class="ov-med-slot-card ov-med-slot-am">' +
          '<div class="ov-med-slot-head">🌅 朝</div>' +
          '<div class="ov-med-slot-body ov-feed-slot-body">' + ovHtmlFeedPlanLinesFromArr(amP, c) + '</div></div>' +
          '<div class="ov-med-slot-card ov-med-slot-pm">' +
          '<div class="ov-med-slot-head">🌙 夜</div>' +
          '<div class="ov-med-slot-body ov-feed-slot-body">' + ovHtmlFeedPlanLinesFromArr(pmP, c) + '</div></div>' +
          '</div>';
        if (otP.length > 0) {
          inner += '<div class="ov-med-slot-other ov-feed-other"><div class="ov-med-slot-head-sub">その他</div>' +
            ovHtmlFeedPlanLinesFromArr(otP, c) + '</div>';
        }
      }
      html += itemRowEditable(c, '<div class="item-values-medcol ov-feed-block" style="width:100%;">' + toolbar + inner + '</div>', '', '');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Care() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🩹 ケア実施 <small class="dim item-card-title-sub">展開枠で「5項目まとめて」</small></div>';
    html += '<div class="item-card-body">';
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var care = c.care_latest || [];

      var careVals = '';
      if (care.length === 0) careVals = '<span class="dim">なし</span>';
      else {
        careVals += '<div class="ov-care-row-chips">';
        for (var j = 0; j < care.length; j++) {
          var cls = care[j].done ? 'care-done' : 'care-skip';
          var cIdAttr = care[j].id ? ' data-care-id="' + escAttr(String(care[j].id)) + '"' : '';
          careVals += '<span class="care-chip care-chip-tap ' + cls + '"' + cIdAttr + '>' + esc(care[j].type) + (care[j].done && care[j].by ? '<small>' + esc(care[j].by) + '</small>' : '') + '</span>';
        }
        careVals += '</div>';
      }
      html += itemRowEditable(c, careVals, buildCareInlineEdit(c));
    }
    html += '</div></div>';
    return html;
  }

  function ovJstTodayYmd() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  function ovEventOverdueHtml(it) {
    if (!it || (it.task_type || '') !== 'event') return '';
    if (it.status !== 'pending' && it.status !== 'in_progress') return '';
    var dd = it.due_date ? String(it.due_date).slice(0, 10) : '';
    if (!dd || dd.length < 10 || dd >= ovJstTodayYmd()) return '';
    return '<span class="ov-task-overdue-badge">期限切れ</span>';
  }

  function renderItemCard_Tasks() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">✅ 猫関連付けタスク</div>';
    html += '<div class="item-card-body">';
    var anyCatWithTasks = false;
    for (var i = 0; i < catsData.length; i++) {
      var c = catsData[i];
      var tasks = c.tasks_today || { done: 0, total: 0, items: [] };
      var titems = tasks.items || [];
      if ((tasks.total || 0) === 0 && (!titems || titems.length === 0)) continue;
      anyCatWithTasks = true;
      var taskVals = '<span class="' + (tasks.done >= tasks.total ? 'score-color-green' : tasks.done > 0 ? 'score-color-yellow' : 'score-color-red') + '" style="font-weight:700;">' + (tasks.done >= tasks.total ? '✅' : '⏳') + ' ' + tasks.done + '/' + tasks.total + '</span>';
      for (var j = 0; j < titems.length; j++) {
        var it = titems[j];
        var timeStr = '';
        if (it.due_time) {
          var ds = String(it.due_time);
          timeStr = '<span class="dim" style="margin-right:4px;">' + esc(ds.length >= 5 ? ds.slice(0, 5) : ds) + '</span>';
        }
        taskVals += '<div class="ov-task-line"><div class="ov-task-head">' + timeStr + ovHtmlTaskScheduledIf(it) + '<span class="ov-task-title">' + esc(it.title) + '</span></div>' +
          '<div class="ov-task-actions">' +
          '<button type="button" class="btn btn-ov-task-done" data-task-id="' + escAttr(String(it.id)) + '">完了</button>' +
          '<button type="button" class="btn btn-ov-task-skip" data-task-id="' + escAttr(String(it.id)) + '">スキップ</button></div></div>';
      }
      html += itemRowEditable(c, '<div class="item-values-medcol">' + taskVals + '</div>', '');
    }
    if (!anyCatWithTasks) {
      html += '<div class="dim" style="padding:12px;text-align:center;">本日、表示する猫関連付けタスクがある猫はいません</div>';
    }
    html += '</div></div>';
    return html;
  }

  /** 投薬 slot → 項目ごと「朝分」「夜分」列（API の 朝/晩/時刻表記を吸収） */
  function ovMedSlotBucket(slotRaw) {
    var s = String(slotRaw == null ? '' : slotRaw).trim();
    var low = s.toLowerCase();
    if (!s) return 'other';
    if (s === '朝' || low === 'morning' || low === 'am') return 'am';
    if (s === '昼' || low === 'afternoon' || low === 'noon' || low === 'lunch') return 'am';
    if (s === '晩' || s === '夕' || s === '夜' || low === 'evening' || low === 'night' || low === 'dinner' || low === 'pm') return 'pm';
    var m = /^(\d{1,2}):(\d{2})/.exec(s);
    if (m) {
      var h = parseInt(m[1], 10);
      if (!isNaN(h)) {
        if (h < 14) return 'am';
        return 'pm';
      }
    }
    return 'other';
  }

  function ovHtmlMedItemRow(it, opt) {
    opt = opt || {};
    var hideSlot = !!opt.hideSlotInText;
    var isDone = it.status === 'done';
    var isSkipped = it.status === 'skipped';
    var itemIcon = isDone ? '✅' : isSkipped ? '⏭️' : '🔴';
    var itemCls = isDone ? 'med-item-done' : isSkipped ? 'med-item-skip' : 'med-item-pending';
    var lid = it.log_id != null && it.log_id !== '' ? String(it.log_id) : '';
    var slotPrefix = (!hideSlot && it.slot) ? '<b>' + esc(it.slot) + '</b> ' : '';
    var namePart = esc(it.name) + (it.dosage ? ' <small>' + esc(it.dosage) + '</small>' : '');
    if (lid) {
      return '<label class="ov-med-item-row ' + itemCls + '">' +
        '<input type="checkbox" class="ov-med-log-cb" data-log-id="' + escAttr(lid) + '" ' + (isDone ? 'checked' : '') + ' title="あげた／取消">' +
        '<span class="ov-med-item-text">' + itemIcon + ' ' + slotPrefix + namePart + '</span>' +
        '</label>';
    }
    return '<span class="ov-med-item-row ' + itemCls + '" style="font-size:12px;display:flex;">' + itemIcon + ' ' + slotPrefix + namePart + '</span>';
  }

  function ovHtmlMedSlotBodyFromItems(arr, hideSlotInText) {
    if (!arr || arr.length === 0) {
      return '<span class="dim" style="font-size:11px;">—</span>';
    }
    var out = '';
    for (var i = 0; i < arr.length; i++) {
      out += ovHtmlMedItemRow(arr[i], { hideSlotInText: hideSlotInText });
    }
    return out;
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
        medVals = '<div class="ov-med-item-sum"><span class="' + mc + '" style="font-weight:700;">' + allIcon + ' ' + meds.done + '/' + meds.total + ' 完了</span></div>';
        var am = [];
        var pm = [];
        var ot = [];
        for (var jx = 0; jx < items.length; jx++) {
          var bk = ovMedSlotBucket(items[jx].slot);
          if (bk === 'am') am.push(items[jx]);
          else if (bk === 'pm') pm.push(items[jx]);
          else ot.push(items[jx]);
        }
        medVals += '<div class="ov-med-two-cols">' +
          '<div class="ov-med-slot-card ov-med-slot-am">' +
          '<div class="ov-med-slot-head">🌅 朝分</div>' +
          '<div class="ov-med-slot-body">' + ovHtmlMedSlotBodyFromItems(am, true) + '</div></div>' +
          '<div class="ov-med-slot-card ov-med-slot-pm">' +
          '<div class="ov-med-slot-head">🌙 夜分</div>' +
          '<div class="ov-med-slot-body">' + ovHtmlMedSlotBodyFromItems(pm, true) + '</div></div>' +
          '</div>';
        if (ot.length > 0) {
          medVals += '<div class="ov-med-slot-other">' +
            '<div class="ov-med-slot-head-sub">その他のタイミング</div>' +
            ovHtmlMedSlotBodyFromItems(ot, false) + '</div>';
        }
      }
      html += itemRowEditable(c, '<div class="item-values-medcol ov-med-item-mode">' + medVals + '</div>', '');
    }
    html += '</div></div>';
    return html;
  }

  function renderItemCard_Medical() {
    var html = '<div class="item-card">';
    html += '<div class="item-card-title">🏥 医療（中長期）</div>';
    html += '<div class="item-card-body">';
    var today = todayJstYmd();
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
    var labels = { in_care: '在籍', adopted: '卒業', trial: 'トライアル中', deceased: '他界' };
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

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //  猫ナビ（フローティングパレット B-3）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  var _cnFab = null;
  var _cnPalette = null;
  var _cnBackdrop = null;
  var _cnActiveTab = 0;

  var CN_RUNTIME_CSS_VER = '304';

  /**
   * スタイルシート・CSP・UA の影響を避けるため、リストとボタンにインライン !important を付与（2列・折返しの最終手段）
   */
  function cnForceCatNavListLayout() {
    var listEl = document.getElementById('catNavList');
    if (!listEl) return;
    listEl.style.setProperty('display', 'flex', 'important');
    listEl.style.setProperty('flex-wrap', 'wrap', 'important');
    listEl.style.setProperty('gap', '6px', 'important');
    listEl.style.setProperty('align-content', 'flex-start', 'important');
    listEl.style.setProperty('align-items', 'stretch', 'important');
    listEl.style.setProperty('flex', '1', 'important');
    listEl.style.setProperty('min-height', '0', 'important');
    listEl.style.setProperty('overflow-y', 'auto', 'important');
    listEl.style.setProperty('-webkit-overflow-scrolling', 'touch', 'important');
    listEl.style.setProperty('padding', '8px 10px 12px', 'important');
    listEl.style.setProperty('box-sizing', 'border-box', 'important');
    var w = 'calc((100% - 6px) / 2)';
    var items = listEl.querySelectorAll('.cat-nav-item');
    for (var i = 0; i < items.length; i++) {
      var b = items[i];
      b.style.setProperty('-webkit-appearance', 'none', 'important');
      b.style.setProperty('appearance', 'none', 'important');
      b.style.setProperty('margin', '0', 'important');
      b.style.setProperty('display', 'flex', 'important');
      b.style.setProperty('align-items', 'center', 'important');
      b.style.setProperty('justify-content', 'center', 'important');
      b.style.setProperty('width', w, 'important');
      b.style.setProperty('max-width', w, 'important');
      b.style.setProperty('flex', '0 0 ' + w, 'important');
      b.style.setProperty('min-width', '0', 'important');
      b.style.setProperty('box-sizing', 'border-box', 'important');
    }
    var dims = listEl.querySelectorAll('.dim');
    for (var j = 0; j < dims.length; j++) {
      dims[j].style.setProperty('width', '100%', 'important');
      dims[j].style.setProperty('flex-basis', '100%', 'important');
      dims[j].style.setProperty('box-sizing', 'border-box', 'important');
    }
  }

  function cnForceCatNavTabsLayout() {
    var tabsEl = document.getElementById('catNavTabs');
    if (!tabsEl) return;
    try {
      if (window.getComputedStyle(tabsEl).display === 'none') return;
    } catch (e) { return; }
    tabsEl.style.setProperty('display', 'flex', 'important');
    tabsEl.style.setProperty('flex-wrap', 'wrap', 'important');
    tabsEl.style.setProperty('gap', '6px', 'important');
  }

  /** 猫ナビ CSS を毎回 body 末尾に注入（FAB/パレット枠。リスト2列は cnForceCatNavListLayout も併用） */
  function cnInjectStyles() {
    var removeIds = ['catNavStyleBlock', 'nyagi-cat-nav-v298', 'nyagi-cat-nav-runtime'];
    for (var ri = 0; ri < removeIds.length; ri++) {
      var old = document.getElementById(removeIds[ri]);
      if (old && old.parentNode) old.parentNode.removeChild(old);
    }
    var css = [
      '.cat-nav-fab{position:fixed;bottom:calc(24px + env(safe-area-inset-bottom,0px));left:calc(20px + env(safe-area-inset-left,0px));width:52px;height:52px;border-radius:50%;border:none;background:linear-gradient(135deg,#a78bfa,#7c3aed);color:#fff;font-size:22px;box-shadow:0 4px 14px rgba(124,58,237,.45);z-index:900;cursor:pointer;transition:transform .15s,opacity .15s,background .2s;display:flex;align-items:center;justify-content:center}',
      '.cat-nav-fab:active{transform:scale(.92)}',
      '.cat-nav-fab.open{background:linear-gradient(135deg,#7c3aed,#5b21b6)}',
      '.cat-nav-backdrop{position:fixed;inset:0;z-index:899;background:rgba(0,0,0,.3);opacity:0;pointer-events:none;transition:opacity .2s}',
      '.cat-nav-backdrop.open{opacity:1;pointer-events:auto}',
      '.cat-nav-palette{position:fixed;bottom:calc(86px + env(safe-area-inset-bottom,0px));left:calc(16px + env(safe-area-inset-left,0px));right:auto;top:auto;width:min(360px,calc(100vw - 28px));max-height:min(72vh,620px);background:var(--surface,#1e1e2e);border:1px solid rgba(255,255,255,.15);border-radius:14px;box-shadow:0 8px 32px rgba(0,0,0,.5);z-index:901;display:flex;flex-direction:column;opacity:0;transform:translateY(16px) scale(.95);pointer-events:none;transition:opacity .2s,transform .2s}',
      '.cat-nav-palette.open{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}',
      '.cat-nav-header{display:flex;align-items:center;justify-content:space-between;padding:10px 14px 8px;font-weight:700;font-size:14px;border-bottom:1px solid rgba(255,255,255,.08);flex-shrink:0}',
      '.cat-nav-close{background:none;border:none;color:var(--text-dim,#888);font-size:22px;cursor:pointer;padding:0 4px;line-height:1}',
      '.cat-nav-tabs{display:flex!important;flex-wrap:wrap!important;gap:6px;padding:8px 12px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.06);max-height:30vh;overflow-y:auto;-webkit-overflow-scrolling:touch}',
      '.cat-nav-tab{flex:0 0 auto;padding:6px 11px;border-radius:16px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.04);color:var(--text-dim,#888);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s,border-color .15s}',
      '.cat-nav-tab.active{background:var(--primary,#a78bfa);color:#fff;border-color:var(--primary,#a78bfa)}',
      '#catNavList.cat-nav-list{display:flex!important;flex-wrap:wrap!important;gap:6px!important;align-content:flex-start!important;align-items:stretch!important;flex:1!important;min-height:0!important;overflow-y:auto!important;-webkit-overflow-scrolling:touch!important;padding:8px 10px 12px!important}',
      '#catNavList.cat-nav-list>.dim{width:100%!important;flex:0 0 100%!important;box-sizing:border-box!important;text-align:center;padding:10px 8px;font-size:12px}',
      '#catNavList .cat-nav-item{-webkit-appearance:none!important;appearance:none!important;margin:0!important;display:flex!important;align-items:center!important;justify-content:center!important;text-align:center!important;box-sizing:border-box!important;width:calc((100% - 6px) / 2)!important;max-width:calc((100% - 6px) / 2)!important;flex:0 0 calc((100% - 6px) / 2)!important;min-width:0!important;min-height:44px;padding:8px 6px;border:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.06);color:var(--text-main,#e0e0e0);font-size:12px;font-weight:600;line-height:1.25;cursor:pointer;border-radius:10px;transition:background .12s,border-color .12s;word-break:break-word}',
      '#catNavList .cat-nav-item:active{background:rgba(167,139,250,.22)!important;border-color:rgba(167,139,250,.35)!important}',
      '@keyframes catNavHL{0%{box-shadow:0 0 0 3px rgba(167,139,250,.6)}100%{box-shadow:0 0 0 0 rgba(167,139,250,0)}}',
      '.cat-nav-highlight{animation:catNavHL 1.5s ease-out forwards;border-radius:8px}'
    ].join('');
    var s = document.createElement('style');
    s.id = 'nyagi-cat-nav-runtime';
    s.type = 'text/css';
    s.setAttribute('data-ver', CN_RUNTIME_CSS_VER);
    s.textContent = css;
    document.body.appendChild(s);
  }

  function buildCatNav() {
    _cnFab = document.createElement('button');
    _cnFab.className = 'cat-nav-fab';
    _cnFab.setAttribute('aria-label', '猫ナビ');
    _cnFab.textContent = '\uD83D\uDC3E';
    _cnFab.addEventListener('click', cnToggle);
    document.body.appendChild(_cnFab);

    _cnBackdrop = document.createElement('div');
    _cnBackdrop.className = 'cat-nav-backdrop';
    _cnBackdrop.addEventListener('click', cnClose);
    document.body.appendChild(_cnBackdrop);

    _cnPalette = document.createElement('div');
    _cnPalette.className = 'cat-nav-palette';
    _cnPalette.innerHTML =
      '<div class="cat-nav-header"><span>\uD83D\uDC3E \u732B\u30CA\u30D3</span>' +
      '<button class="cat-nav-close" type="button">&times;</button></div>' +
      '<div class="cat-nav-tabs" id="catNavTabs"></div>' +
      '<div class="cat-nav-list" id="catNavList"></div>';
    document.body.appendChild(_cnPalette);

    _cnPalette.querySelector('.cat-nav-close').addEventListener('click', cnClose);

    _cnPalette.addEventListener('click', function (ev) {
      var tab = ev.target.closest && ev.target.closest('.cat-nav-tab');
      if (tab) {
        var idx = parseInt(tab.getAttribute('data-card-idx'), 10);
        if (!isNaN(idx)) {
          _cnActiveTab = idx;
          var allT = _cnPalette.querySelectorAll('.cat-nav-tab');
          for (var t = 0; t < allT.length; t++) {
            allT[t].classList.toggle('active', parseInt(allT[t].getAttribute('data-card-idx'), 10) === idx);
          }
          cnPopulateList(idx);
        }
        return;
      }
      var item = ev.target.closest && ev.target.closest('.cat-nav-item');
      if (item) {
        var slug = item.getAttribute('data-cat-nav-slug');
        var ci = parseInt(item.getAttribute('data-card-idx'), 10);
        if (slug) cnScrollTo(slug, isNaN(ci) ? -1 : ci);
      }
    });
    cnInjectStyles();
    if (_cnPalette) _cnPalette.setAttribute('data-nyagi-nav-css', CN_RUNTIME_CSS_VER);
  }

  function cnToggle() {
    if (_cnPalette && _cnPalette.classList.contains('open')) cnClose();
    else cnOpen();
  }

  function cnOpen() {
    if (!_cnPalette) return;
    cnInjectStyles();
    cnPopulate();
    _cnPalette.classList.add('open');
    _cnFab.classList.add('open');
    _cnBackdrop.classList.add('open');
  }

  function cnClose() {
    if (!_cnPalette) return;
    _cnPalette.classList.remove('open');
    _cnFab.classList.remove('open');
    _cnBackdrop.classList.remove('open');
  }

  function cnPopulate() {
    var tabsEl = document.getElementById('catNavTabs');
    var listEl = document.getElementById('catNavList');
    if (!tabsEl || !listEl) return;

    if (currentMode === 'perCat') {
      tabsEl.style.display = 'none';
      var h = '';
      for (var i = 0; i < catsData.length; i++) {
        h += '<button type="button" class="cat-nav-item" data-cat-nav-slug="' +
          escAttr(catsData[i].id) + '">' + speciesIcon(catsData[i].species) +
          ' ' + esc(catsData[i].name) + '</button>';
      }
      listEl.innerHTML = h || '<div class="dim" style="padding:12px;font-size:12px;">\u732B\u306A\u3057</div>';
      cnForceCatNavTabsLayout();
      cnForceCatNavListLayout();
      return;
    }

    tabsEl.style.display = '';
    var titles = cardArea.querySelectorAll('.item-card-title');
    var tabH = '';
    for (var i = 0; i < titles.length; i++) {
      var raw = titles[i].textContent || '';
      var lbl = raw.replace(/[\u25B2\u25BC]/g, '').replace(/\u76F4\u8FD1.*/g, '')
        .replace(/\u5404\u884C.*/g, '').replace(/\u672C\u65E5.*/g, '')
        .replace(/\u3042\u3052\u305F.*/g, '').trim();
      if (lbl.length > 8) lbl = lbl.slice(0, 8);
      tabH += '<button type="button" class="cat-nav-tab' +
        (i === _cnActiveTab ? ' active' : '') + '" data-card-idx="' + i + '">' +
        esc(lbl) + '</button>';
    }
    tabsEl.innerHTML = tabH;
    cnForceCatNavTabsLayout();
    if (_cnActiveTab >= titles.length) _cnActiveTab = 0;
    cnPopulateList(_cnActiveTab);
  }

  function cnPopulateList(cardIdx) {
    var listEl = document.getElementById('catNavList');
    if (!listEl) return;
    var cards = cardArea.querySelectorAll('.item-card');
    if (cardIdx >= cards.length) {
      listEl.innerHTML = '';
      cnForceCatNavListLayout();
      return;
    }

    var rows = cards[cardIdx].querySelectorAll('[data-cat-slug]');
    var h = '';
    var seen = {};
    for (var i = 0; i < rows.length; i++) {
      var slug = rows[i].getAttribute('data-cat-slug');
      if (!slug || seen[slug]) continue;
      seen[slug] = true;
      var nameEl = rows[i].querySelector('.item-cat-name');
      var nm = nameEl ? nameEl.textContent.replace(/[\u25CF\u25CB\u25CE]/g, '').trim() : slug;
      var sp = '\uD83D\uDC31';
      for (var ci = 0; ci < catsData.length; ci++) {
        if (catsData[ci].id === slug) { sp = speciesIcon(catsData[ci].species); break; }
      }
      h += '<button type="button" class="cat-nav-item" data-cat-nav-slug="' +
        escAttr(slug) + '" data-card-idx="' + cardIdx + '">' +
        sp + ' ' + esc(nm) + '</button>';
    }
    listEl.innerHTML = h || '<div class="dim" style="padding:12px;font-size:12px;text-align:center;">\u3053\u306E\u30AB\u30FC\u30C9\u306B\u732B\u306E\u884C\u306F\u3042\u308A\u307E\u305B\u3093</div>';
    cnForceCatNavListLayout();
  }

  function cnScrollTo(catSlug, cardIdx) {
    cnClose();

    if (currentMode === 'perCat') {
      var el = cardArea.querySelector('.per-cat-card[data-cat-slug="' + catSlug + '"]');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        cnHighlight(el);
      }
      return;
    }

    var cards = cardArea.querySelectorAll('.item-card');
    if (cardIdx < 0 || cardIdx >= cards.length) return;
    var card = cards[cardIdx];
    var title = card.querySelector('.item-card-title');
    var body = card.querySelector('.item-card-body');

    var wasCollapsed = false;
    if (title && body && body.classList.contains('hidden')) {
      wasCollapsed = true;
      body.classList.remove('hidden');
      title.classList.remove('collapsed');
      var map = loadExpandedMap();
      if (!map || typeof map !== 'object') map = {};
      map[cardIdx] = true;
      saveExpandedMap(map);
    }

    var row = card.querySelector('[data-cat-slug="' + catSlug + '"]');
    if (!row) return;

    if (row.closest && row.closest('.cn-item-card-cat-slugs')) {
      var vomForm = card.querySelector('#ovVomitForm');
      if (vomForm) {
        var vsel = vomForm.querySelector('.ov-vomit-cat');
        if (vsel) vsel.value = catSlug;
        setTimeout(function () {
          vomForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
          cnHighlight(vomForm);
        }, wasCollapsed ? 400 : 50);
      }
      return;
    }

    setTimeout(function () {
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      cnHighlight(row);
    }, wasCollapsed ? 400 : 50);
  }

  function cnHighlight(el) {
    el.classList.remove('cat-nav-highlight');
    void el.offsetWidth;
    el.classList.add('cat-nav-highlight');
    setTimeout(function () { el.classList.remove('cat-nav-highlight'); }, 1800);
  }

})();
