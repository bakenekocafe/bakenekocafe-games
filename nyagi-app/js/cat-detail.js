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

/** 猫詳細の cat-detail-fold 見出しボタン（HTML の onclick から呼ぶ） */
function toggleCatDetailFold(btn) {
  if (!btn || !btn.closest) return;
  var wrap = btn.closest('.cat-detail-fold');
  if (!wrap) return;
  wrap.classList.toggle('cat-detail-fold--collapsed');
  var collapsed = wrap.classList.contains('cat-detail-fold--collapsed');
  btn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

/** パネル下部「閉じる」（HTML の onclick から呼ぶ） */
function closeCatDetailFoldSection(btn) {
  if (!btn || !btn.closest) return;
  var wrap = btn.closest('.cat-detail-fold');
  if (!wrap) return;
  wrap.classList.add('cat-detail-fold--collapsed');
  var t = wrap.querySelector('.cat-detail-fold__toggle');
  if (t) t.setAttribute('aria-expanded', 'false');
}

(function () {
  'use strict';

  var _origin = (window.NYAGI_API_ORIGIN != null) ? window.NYAGI_API_ORIGIN : '';
  var API_BASE = _origin + '/api/ops';

  var loginGate            = document.getElementById('loginGate');
  var catContent           = document.getElementById('catContent');
  var catStickyBack        = document.getElementById('catStickyBack');
  var catHeaderArea        = document.getElementById('catHeaderArea');
  var alertBannerArea      = document.getElementById('alertBannerArea');
  var basicInfoArea        = document.getElementById('basicInfoArea');
  var intakeInfoArea       = document.getElementById('intakeInfoArea');
  var adoptionInfoArea     = document.getElementById('adoptionInfoArea');
  var weightChartArea      = document.getElementById('weightChartArea');
  var calorieArea          = document.getElementById('calorieArea');
  var healthRecordsArea    = document.getElementById('healthRecordsArea');
  var medicationScheduleArea = document.getElementById('medicationScheduleArea');
  var feedingArea          = document.getElementById('feedingArea');
  var careArea             = document.getElementById('careArea');
  var stoolArea            = document.getElementById('stoolArea');
  var urineArea            = document.getElementById('urineArea');
  
  var catNotesArea         = document.getElementById('catNotesArea');
  /** renderCatNotes 直近の一覧（編集モーダル用） */
  var _catNotesListCache   = [];
  var scoreCardArea        = document.getElementById('scoreCardArea');
  var actionsArea          = document.getElementById('actionsArea');
  var reportLink           = document.getElementById('reportLink');

  var credentials = null;
  var catId = null;
  var currentCatData = null;
  /** { kind: 'intake'|'adoption', recordId: number } — label 経由でファイル追加するとき */
  var _iaRecordUploadTarget = null;
  /** 病院記録カードから「ファイルを追加」するときの health_records.id */
  var _clinicExtraRecordId = null;
  /** 給餌UIを描画した暦日（JST）。日付またぎでタブ放置時に再読込する */
  var _feedingSectionRenderedDate = null;
  var _feedingMidnightRefreshBound = false;

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

  var NYAGI_PRESET_LOC_KEY = 'nyagi_feeding_preset_location';

  function getStoredPresetLocation() {
    try {
      var v = localStorage.getItem(NYAGI_PRESET_LOC_KEY);
      if (v === 'cafe' || v === 'nekomata') return v;
    } catch (_) {}
    return 'cafe';
  }

  function setStoredPresetLocation(loc) {
    if (loc !== 'cafe' && loc !== 'nekomata') return;
    try { localStorage.setItem(NYAGI_PRESET_LOC_KEY, loc); } catch (_) {}
  }

  function effectivePresetLocationForApply() {
    if (currentCatData && (currentCatData.location_id === 'cafe' || currentCatData.location_id === 'nekomata')) {
      return currentCatData.location_id;
    }
    return getStoredPresetLocation();
  }

  function presetLocShortLabel(loc) {
    return loc === 'nekomata' ? '猫又療養所' : 'BAKENEKO CAFE';
  }

  function presetLocationBadgeHtml(loc) {
    var L = loc === 'nekomata' ? 'nekomata' : 'cafe';
    var bg = L === 'nekomata' ? 'rgba(248,113,113,0.15)' : 'rgba(251,191,36,0.12)';
    var c = L === 'nekomata' ? '#f87171' : '#fbbf24';
    return '<span style="font-size:10px;padding:2px 6px;border-radius:4px;background:' + bg + ';color:' + c + ';font-weight:600;">' + escapeHtml(presetLocShortLabel(L)) + '</span>';
  }

  /** 化け猫カフェタブ: API の alpha_bucket_label で A–Z／その他の見出し */
  function feedingPresetAlphaSectionHtml(tabLoc, ps, lastLabelRef) {
    if (tabLoc !== 'cafe' || !ps || !ps.alpha_bucket_label) return '';
    var lab = ps.alpha_bucket_label;
    if (lastLabelRef.v === lab) return '';
    lastLabelRef.v = lab;
    return '<div style="font-size:11px;font-weight:700;color:var(--text-dim);margin:12px 0 6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.08);">' + escapeHtml(lab) + '</div>';
  }

  function renderPresetLocationSwitcher(activeLoc, context) {
    var aCafe = activeLoc === 'cafe' ? 'background:rgba(251,191,36,0.25);border-color:rgba(251,191,36,0.55);color:#fbbf24;font-weight:700;' : 'background:var(--surface);border-color:rgba(255,255,255,0.12);color:var(--text-dim);';
    var aNeko = activeLoc === 'nekomata' ? 'background:rgba(248,113,113,0.18);border-color:rgba(248,113,113,0.45);color:#f87171;font-weight:700;' : 'background:var(--surface);border-color:rgba(255,255,255,0.12);color:var(--text-dim);';
    var h = '<div style="font-size:11px;color:var(--text-dim);margin:0 0 8px;font-weight:600;">🏷 表示拠点（タップで切替・一覧を絞り込み）</div>';
    h += '<div style="display:flex;gap:8px;margin-bottom:14px;">';
    h += '<button type="button" class="btn" style="flex:1;padding:10px 6px;font-size:11px;border:2px solid;border-radius:8px;' + aCafe + '" onclick="switchFedPresetLocation(&quot;cafe&quot;,&quot;' + context + '&quot;)">🐱 BAKENEKO CAFE</button>';
    h += '<button type="button" class="btn" style="flex:1;padding:10px 6px;font-size:11px;border:2px solid;border-radius:8px;' + aNeko + '" onclick="switchFedPresetLocation(&quot;nekomata&quot;,&quot;' + context + '&quot;)">🏥 猫又療養所</button>';
    h += '</div>';
    return h;
  }

  function feedingPresetsListUrl(species, loc) {
    var u = API_BASE + '/feeding/presets?species=' + encodeURIComponent(species || 'cat');
    if (loc === 'cafe' || loc === 'nekomata') u += '&location_id=' + encodeURIComponent(loc);
    return u;
  }

  // ── 認証 ──────────────────────────────────────────────────────────────────────

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
    if (!credentials || !credentials.adminKey || !credentials.staffId) {
      return { 'Content-Type': 'application/json', 'X-Admin-Key': '', 'X-Staff-Id': '' };
    }
    return {
      'Content-Type': 'application/json',
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  /** FormData 送信時は Content-Type を付けない（boundary をブラウザに任せる） */
  function apiHeadersMultipart() {
    if (!credentials || !credentials.adminKey || !credentials.staffId) {
      return { 'X-Admin-Key': '', 'X-Staff-Id': '' };
    }
    return {
      'X-Admin-Key': credentials.adminKey,
      'X-Staff-Id': credentials.staffId,
    };
  }

  function _feedFetchJson(url) {
    return fetch(url, { headers: apiHeaders(), cache: 'no-store' }).then(function (r) {
      return r.text().then(function (text) {
        var data = {};
        if (text) {
          try { data = JSON.parse(text); } catch (_) {
            return Promise.reject({ kind: 'parse', status: r.status });
          }
        }
        if (!r.ok) {
          return Promise.reject({ kind: 'http', status: r.status, data: data });
        }
        return data;
      });
    });
  }

  /** 失敗時は null（給餌セクション全体を落とさない） */
  function _feedFetchJsonSoft(url) {
    return fetch(url, { headers: apiHeaders(), cache: 'no-store' }).then(function (r) {
      return r.text().then(function (text) {
        if (!r.ok) return null;
        if (!text) return null;
        try { return JSON.parse(text); } catch (_) { return null; }
      });
    }).catch(function () { return null; });
  }

  /** DELETE 用: confirm 直後の WebView で fetch が固まる場合のタイムアウト付き */
  function _fetchDeleteJsonWithTimeout(url, timeoutMs) {
    var ms = timeoutMs != null ? timeoutMs : 28000;
    var req = fetch(url, { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' }).then(function (r) {
      return r.text().then(function (t) {
        var data = {};
        try { data = t ? JSON.parse(t) : {}; } catch (_) { data = { error: 'parse', message: t ? t.slice(0, 120) : 'HTTP ' + r.status }; }
        data._httpOk = r.ok;
        return data;
      });
    });
    var timeoutP = new Promise(function (_, reject) {
      setTimeout(function () { reject({ _nyagiTimeout: true }); }, ms);
    });
    return Promise.race([req, timeoutP]);
  }

  /** 給餌ブロックに即時メッセージ（OK 後に無反応に見えないようにする） */
  function _setFeedingAreaBusy(message) {
    if (!feedingArea) return;
    var m = message || '処理中です…';
    feedingArea.innerHTML = '<div class="detail-section"><div class="detail-title">🍽 給餌プラン</div><div class="loading" style="padding:20px;text-align:center;font-size:14px;color:var(--text-dim);">' + escapeHtml(m) + '</div></div>';
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

  /** 猫詳細を開いたまま日付が変わったら給餌プランのチェック状態を再取得 */
  function checkFeedingDayRollover() {
    if (!catId || !feedingArea) return;
    var d = todayJstYmd();
    if (_feedingSectionRenderedDate && _feedingSectionRenderedDate !== d) {
      loadFeedingSection();
    }
  }

  // ── 初期化 ────────────────────────────────────────────────────────────────────

  function init() {
    credentials = loadCredentials();
    catId = getQueryParam('id');

    if (!credentials) {
      if (loginGate) loginGate.style.display = 'block';
      if (catStickyBack) catStickyBack.style.display = 'none';
      if (window.NyagiFixedHeader) window.NyagiFixedHeader.update();
      return;
    }
    if (!catId) {
      window.location.href = 'cats.html';
      return;
    }
    if (catContent) catContent.style.display = 'block';
    if (catStickyBack) catStickyBack.style.display = 'flex';
    if (window.NyagiFixedHeader) window.NyagiFixedHeader.update();
    if (!_feedingMidnightRefreshBound) {
      _feedingMidnightRefreshBound = true;
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') checkFeedingDayRollover();
      });
      window.addEventListener('focus', checkFeedingDayRollover);
      window.addEventListener('pageshow', function (ev) {
        if (ev && ev.persisted) checkFeedingDayRollover();
      });
      setInterval(function () {
        if (document.visibilityState === 'visible') checkFeedingDayRollover();
      }, 60000);
    }
    setTimeout(function () { loadCatDetail(); }, 150);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  (function bindCatBackButton() {
    var catBackBtn = document.getElementById('catBackBtn');
    if (!catBackBtn) return;
    catBackBtn.addEventListener('click', function () {
      if (window.history.length > 1) {
        window.history.back();
      } else {
        window.location.href = 'cats.html';
      }
    });
  })();

  /** 折りたたみ: インライン onclick に頼らず #catContent で委譲（CSP 等でも動く） */
  (function bindCatDetailFoldClicks() {
    if (!catContent || !catContent.addEventListener) return;
    catContent.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var closeBtn = t.closest('.cat-detail-fold__close');
      if (closeBtn) {
        ev.preventDefault();
        closeCatDetailFoldSection(closeBtn);
        return;
      }
      var toggleBtn = t.closest('.cat-detail-fold__toggle');
      if (toggleBtn) {
        ev.preventDefault();
        toggleCatDetailFold(toggleBtn);
      }
    });
  })();

  /** 資料レコードへのファイル追加: 直前に input を空にし、対象レコードを覚える */
  (function bindIaFileUploadLabelReset() {
    document.body.addEventListener('mousedown', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var labRec = t.closest('label.nyagi-ia-record-upload');
      if (labRec) {
        _iaRecordUploadTarget = null;
        var ik = labRec.getAttribute('data-ia-kind');
        var ir = labRec.getAttribute('data-ia-rid');
        var recInp = document.getElementById('iaRecordFileInput');
        if (recInp) recInp.value = '';
        if (ik && ir) {
          var n = parseInt(ir, 10);
          if (!isNaN(n)) _iaRecordUploadTarget = { kind: ik, recordId: n };
        }
      }
    }, true);
  })();

  (function bindClinicExtraFileUpload() {
    document.body.addEventListener('mousedown', function (ev) {
      var t = ev.target;
      if (!t || !t.closest) return;
      var lab = t.closest('label.nyagi-clinic-extra-upload');
      if (!lab) return;
      _clinicExtraRecordId = null;
      var cid = lab.getAttribute('data-cr-id');
      var cinp = document.getElementById('clinicExtraFileInput');
      if (cinp) cinp.value = '';
      if (cid) {
        var n = parseInt(cid, 10);
        if (!isNaN(n)) _clinicExtraRecordId = n;
      }
    }, true);
  })();

  function loadCatDetail() {
    if (!catHeaderArea) return;
    var savedScrollY = (window.NyagiScrollRestore && window.NyagiScrollRestore.capture) ? window.NyagiScrollRestore.capture() : 0;
    catHeaderArea.innerHTML = '<div class="loading"><span class="spinner"></span> 読み込み中...</div>';
    if (basicInfoArea) basicInfoArea.innerHTML = '';
    if (intakeInfoArea) intakeInfoArea.innerHTML = '';
    if (adoptionInfoArea) adoptionInfoArea.innerHTML = '';
    if (weightChartArea) weightChartArea.innerHTML = '';
    if (scoreCardArea) scoreCardArea.innerHTML = '';
    if (actionsArea) actionsArea.innerHTML = '';

    function doFetch(retryCount) {
      retryCount = retryCount || 0;
      var url = API_BASE + '/cats/' + encodeURIComponent(catId) + '/timeline?limit=50';
      var ctrl = new AbortController();
      var timeoutId = setTimeout(function () { ctrl.abort(); }, 30000);
      fetch(url, { headers: apiHeaders(), cache: 'no-store', signal: ctrl.signal })
        .then(function (res) {
          clearTimeout(timeoutId);
          if (!res.ok) throw new Error('HTTP ' + res.status);
          return res.json();
        })
        .then(function (data) {
          if (data.error) {
            catHeaderArea.innerHTML = '<div class="empty-msg">エラー: ' + escapeHtml(data.message || data.error) + '</div>';
            if (window.NyagiScrollRestore && window.NyagiScrollRestore.restore) window.NyagiScrollRestore.restore(savedScrollY);
            return;
          }
          renderCatDetail(data);
          function settle(p) {
            return Promise.resolve(p).catch(function () { return null; });
          }
          Promise.all([
            settle(loadScoreCard()),
            settle(loadWeightChart()),
            settle(loadCareSection()),
            settle(loadStoolSection()),
            settle(loadUrineSection()),
            settle(loadHealthRecords()),
            settle(loadClinicRecords()),
            settle(loadMedicationSchedule()),
            settle(loadFeedingSection()),
            settle(loadCatNotes()),
            settle(loadCatTasks({ skipScrollRestore: true })),
          ]).then(function () {
            if (window.NyagiScrollRestore && window.NyagiScrollRestore.restore) window.NyagiScrollRestore.restore(savedScrollY);
          });
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
          if (window.NyagiScrollRestore && window.NyagiScrollRestore.restore) window.NyagiScrollRestore.restore(savedScrollY);
        });
    }
    doFetch(0);
  }
  window.loadCatDetail = loadCatDetail;

  // ── メインレンダリング ─────────────────────────────────────────────────────────

  function renderIaRecordCard(kind, rec) {
    var k = kind === 'adoption' ? 'adoption' : 'intake';
    var rid = rec.id;
    var files = rec.files || [];
    var h = '<div class="ia-record-card" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px;margin-top:10px;background:rgba(0,0,0,0.12);">';
    h += '<div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:6px;align-items:center;">';
    h += '<span style="font-size:12px;color:var(--text-dim);">#' + rid;
    if (rec.created_at) h += ' · ' + escapeHtml(String(rec.created_at).replace('T', ' ').slice(0, 16));
    h += '</span>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
    h += '<button type="button" class="btn btn-outline btn-sm" onclick="editNyagiIaRecordNote(\'' + k + '\',' + rid + ')">メモ編集</button>';
    h += '<button type="button" class="btn btn-outline btn-sm" style="color:#f87171;border-color:rgba(248,113,113,0.5);" onclick="deleteNyagiIaRecord(\'' + k + '\',' + rid + ')">レコード削除</button>';
    h += '</div></div>';
    h += '<div style="font-size:13px;margin-top:6px;white-space:pre-wrap;word-break:break-word;">';
    h += rec.note ? escapeHtml(String(rec.note)) : '<span style="color:var(--text-dim);">（メモなし）</span>';
    h += '</div>';
    h += '<div style="margin-top:8px;font-size:11px;color:var(--text-dim);">📎 資料（PDF・画像・各10MB以下・複数ファイル可）</div>';
    if (files.length === 0) {
      h += '<div class="empty-msg" style="padding:6px 0;font-size:12px;">まだ資料がありません</div>';
    } else {
      h += '<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;">';
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        h += '<li style="margin:4px 0;">' + escapeHtml(f.original_name || ('file-' + f.id)) + ' ';
        h += '<button type="button" class="btn-edit-loc" style="font-size:11px;" onclick="openNyagiIaRecordFile(\'' + k + '\',' + rid + ',' + f.id + ')">開く</button> ';
        h += '<button type="button" class="btn-edit-loc" style="font-size:11px;color:#f87171;" onclick="deleteNyagiIaRecordFile(\'' + k + '\',' + rid + ',' + f.id + ')">削除</button></li>';
      }
      h += '</ul>';
    }
    h += '<label class="btn btn-outline btn-sm nyagi-ia-upload-btn nyagi-ia-record-upload" style="margin-top:8px;" data-ia-kind="' + k + '" data-ia-rid="' + rid + '" for="iaRecordFileInput">＋ ファイルを追加</label>';
    h += '</div>';
    return h;
  }

  function renderIntakeAdoptionSections(cat) {
    if (!intakeInfoArea || !adoptionInfoArea) return;
    var intake = (cat && cat.intake_info != null) ? String(cat.intake_info) : '';
    var adopt = (cat && cat.adoption_info != null) ? String(cat.adoption_info) : '';
    var intakeTrim = intake.trim();
    var adoptTrim = adopt.trim();
    var inRecs = (cat && Array.isArray(cat.intake_records)) ? cat.intake_records : [];
    var adRecs = (cat && Array.isArray(cat.adoption_records)) ? cat.adoption_records : [];

    var ih = '<div class="detail-section intake-adoption-card">';
    ih += '<div class="section-header" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">';
    ih += '<div class="detail-title" style="margin-bottom:0;">📥 引き受け情報</div>';
    ih += '<button type="button" class="btn btn-outline btn-sm" onclick="openIntakeAdoptionModal()">テキスト編集</button></div>';
    ih += '<p style="font-size:11px;color:var(--text-dim);margin:4px 0 8px;">保護・入所経緯、引き取り元、当初の状態など（共有メモ）</p>';
    if (intakeTrim) {
      ih += '<div class="intake-adoption-body" style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:var(--text-main);word-break:break-word;">' + escapeHtml(intake) + '</div>';
    } else {
      ih += '<div class="empty-msg" style="padding:8px 0;">テキスト未入力</div>';
    }
    ih += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">';
    ih += '<div style="font-size:12px;font-weight:700;color:var(--text-main);margin-bottom:6px;">📂 資料レコード（複数可・1件に複数ファイル可）</div>';
    ih += '<button type="button" class="btn btn-outline btn-sm" onclick="createNyagiIaRecord(\'intake\')">＋ 資料レコードを追加</button>';
    for (var ii = 0; ii < inRecs.length; ii++) {
      ih += renderIaRecordCard('intake', inRecs[ii]);
    }
    if (inRecs.length === 0) {
      ih += '<p style="font-size:11px;color:var(--text-dim);margin-top:8px;">レコードを追加してから「ファイルを追加」で画像・PDFを紐づけます。</p>';
    }
    ih += '</div></div>';
    intakeInfoArea.innerHTML = ih;

    var ah = '<div class="detail-section intake-adoption-card">';
    ah += '<div class="section-header" style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;">';
    ah += '<div class="detail-title" style="margin-bottom:0;">🏠 譲渡関連情報</div>';
    ah += '<button type="button" class="btn btn-outline btn-sm" onclick="openIntakeAdoptionModal()">テキスト編集</button></div>';
    ah += '<p style="font-size:11px;color:var(--text-dim);margin:4px 0 8px;">トライアル・譲渡条件、里親連絡、手続きメモなど</p>';
    if (adoptTrim) {
      ah += '<div class="intake-adoption-body" style="white-space:pre-wrap;font-size:14px;line-height:1.55;color:var(--text-main);word-break:break-word;">' + escapeHtml(adopt) + '</div>';
    } else {
      ah += '<div class="empty-msg" style="padding:8px 0;">テキスト未入力</div>';
    }
    ah += '<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);">';
    ah += '<div style="font-size:12px;font-weight:700;color:var(--text-main);margin-bottom:6px;">📂 資料レコード（複数可・1件に複数ファイル可）</div>';
    ah += '<button type="button" class="btn btn-outline btn-sm" onclick="createNyagiIaRecord(\'adoption\')">＋ 資料レコードを追加</button>';
    for (var ai = 0; ai < adRecs.length; ai++) {
      ah += renderIaRecordCard('adoption', adRecs[ai]);
    }
    if (adRecs.length === 0) {
      ah += '<p style="font-size:11px;color:var(--text-dim);margin-top:8px;">レコードを追加してから「ファイルを追加」で画像・PDFを紐づけます。</p>';
    }
    ah += '</div></div>';
    adoptionInfoArea.innerHTML = ah;
  }

  function renderCatDetail(data) {
    var cat = data.cat || {};
    currentCatData = cat;

    // ヘッダー
    var level = cat.alert_level || 'normal';
    var html = '<div class="cat-header">';
    html += '<div class="cat-avatar-wrap" onclick="triggerCatPhotoUpload()">';
    if (cat.photo_url) {
      if (cat.photo_url.indexOf('r2:') === 0) {
        html += '<img class="cat-avatar-img" id="catAvatarImg" src="" alt="' + escapeHtml(cat.name) + '" style="display:none;">';
        html += '<div class="cat-header-emoji" id="catAvatarFallback">🐱</div>';
        loadCatPhotoFromR2();
      } else {
        html += '<img class="cat-avatar-img" src="' + escapeHtml(cat.photo_url) + '" alt="' + escapeHtml(cat.name) + '">';
      }
    } else {
      html += '<div class="cat-header-emoji">🐱</div>';
    }
    html += '<div class="cat-avatar-overlay">📷</div>';
    html += '</div>';
    html += '<input type="file" id="catPhotoInput" accept="image/*" style="display:none;" onchange="onCatPhotoSelected(this)">';
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

    // 基本情報（各項目に編集）
    var infoHtml = '<div class="detail-section">';
    infoHtml += '<div class="detail-title">📋 基本情報</div>';
    infoHtml += '<div class="info-grid">';
    var speciesDisp = cat.species === 'dog' ? '🐶 犬' : '🐱 猫';
    infoHtml += renderBasicInfoEditableRow('種別', escapeHtml(speciesDisp), 'species', false, '');
    infoHtml += renderBasicInfoEditableRow('性別', escapeHtml(formatSexDisplayJa(cat.sex)), 'sex', false, '');
    infoHtml += renderBasicInfoEditableRow('誕生日', escapeHtml(cat.birth_date ? formatClinicDateWestern(cat.birth_date) : '—'), 'birth_date', false, '');
    var mcLine = escapeHtml(cat.microchip_id || '—');
    if (cat.has_microchip_image) {
      mcLine += ' <button type="button" class="btn-edit-loc" style="font-size:11px;padding:2px 6px;vertical-align:middle;" onclick="openCatMicrochipImageView()">📎 画像</button>';
    }
    infoHtml += renderBasicInfoEditableRow('マイクロチップ', mcLine, 'microchip_id', false, '');
    infoHtml += renderBasicInfoEditableRow('避妊/去勢', escapeHtml(cat.neutered ? '済' : '未'), 'neutered', false, '');
    var bcsVal = cat.body_condition_score;
    var bcsLabel = bcsVal != null ? (bcsVal === 5 ? '5（理想）' : bcsVal < 5 ? bcsVal + '（痩せ）' : bcsVal + '（肥満）') : '未設定';
    infoHtml += renderBasicInfoEditableRow(
      '体型（BCS 1-9）',
      escapeHtml(bcsLabel) + ' <a href="#calorieArea" style="font-size:11px;color:var(--accent);">カロリー欄へ</a>',
      'bcs',
      false,
      'bcsInfoCell'
    );
    var descDisp = cat.description ? escapeHtml(cat.description) : '<span style="color:var(--text-dim);">—</span>';
    infoHtml += renderBasicInfoEditableRow('説明', descDisp, 'description', true, '');
    infoHtml += '</div></div>';
    basicInfoArea.innerHTML = infoHtml;
    renderIntakeAdoptionSections(cat);

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
    if (!scoreCardArea) return Promise.resolve();
    scoreCardArea.innerHTML = '';

    return fetch(API_BASE + '/health-scores?cat_id=' + encodeURIComponent(catId) + '&live=true', {
      headers: apiHeaders(), cache: 'no-store',
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
    if (!weightChartArea) return Promise.resolve();
    weightChartArea.innerHTML = '<div class="detail-section"><div class="detail-title">⚖️ 体重推移</div><div class="loading" style="padding:20px;">読み込み中...</div></div>';

    return fetch(API_BASE + '/health/weight-history?cat_id=' + encodeURIComponent(catId) + '&months=6', {
      headers: apiHeaders(), cache: 'no-store',
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

  /** health_scores 行 → グラフ用 { date, value }（日付昇順・食欲スコアありのみ） */
  function normalizeAppetiteHistoryToPoints(scoreRows) {
    var rows = scoreRows || [];
    var pts = [];
    for (var i = 0; i < rows.length; i++) {
      var a = rows[i].appetite_score;
      if (a === null || a === undefined || a === '') continue;
      var v = Number(a);
      if (isNaN(v)) continue;
      var d = rows[i].score_date || '';
      if (!d) continue;
      pts.push({ date: d, value: Math.max(0, Math.min(100, v)) });
    }
    pts.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return pts;
  }

  function appetiteIndexChartBlockHtml(pts) {
    var h = '<div style="margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid var(--surface-alt);">';
    h += '<div class="detail-title" style="margin-bottom:4px;">📈 食欲指数（推移）</div>';
    h += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.45;">健康スコアの内訳（0〜100）。直近7日の給餌「摂取率」から日次算出された値の履歴です（サーバの日次ジョブで保存されます）。</div>';
    if (!pts || pts.length === 0) {
      h += '<div class="empty-msg" style="font-size:12px;">まだ履歴がありません。給餌の「あげた」記録が溜まると日次スコアに反映されます。</div>';
      h += '</div>';
      return h;
    }
    h += '<div class="weight-canvas-wrap"><canvas id="appetiteIndexCanvas" height="150"></canvas></div>';
    h += '</div>';
    return h;
  }

  function paintAppetiteIndexCanvas(pts) {
    if (!pts || pts.length === 0) return;
    var canvas = document.getElementById('appetiteIndexCanvas');
    if (!canvas) return;

    var dpr = window.devicePixelRatio || 1;
    var displayW = canvas.offsetWidth || 300;
    var displayH = 150;
    canvas.width = displayW * dpr;
    canvas.height = displayH * dpr;

    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var W = displayW;
    var H = displayH;
    var pad = { top: 14, right: 12, bottom: 28, left: 34 };
    var cW = W - pad.left - pad.right;
    var cH = H - pad.top - pad.bottom;
    var minV = 0;
    var maxV = 100;
    var rangeV = 100;

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = '#2a2a3e';
    ctx.lineWidth = 1;
    var yTicks = [100, 75, 50, 25, 0];
    for (var gi = 0; gi < yTicks.length; gi++) {
      var yVal = yTicks[gi];
      var gy = pad.top + cH - (cH * (yVal - minV) / rangeV);
      ctx.beginPath();
      ctx.moveTo(pad.left, gy);
      ctx.lineTo(pad.left + cW, gy);
      ctx.stroke();
      ctx.fillStyle = '#888';
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(String(yVal), pad.left - 4, gy + 4);
    }

    function appetiteChartX(i) {
      if (pts.length === 1) return pad.left + cW / 2;
      return pad.left + (cW / (pts.length - 1)) * i;
    }

    ctx.beginPath();
    for (var i = 0; i < pts.length; i++) {
      var x = appetiteChartX(i);
      var y = pad.top + cH - (cH * (pts[i].value - minV) / rangeV);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.lineTo(appetiteChartX(pts.length - 1), pad.top + cH);
    ctx.lineTo(appetiteChartX(0), pad.top + cH);
    ctx.closePath();
    ctx.fillStyle = 'rgba(251,146,60,.18)';
    ctx.fill();

    ctx.beginPath();
    for (var j = 0; j < pts.length; j++) {
      var x2 = appetiteChartX(j);
      var y2 = pad.top + cH - (cH * (pts[j].value - minV) / rangeV);
      if (j === 0) ctx.moveTo(x2, y2); else ctx.lineTo(x2, y2);
    }
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    for (var k = 0; k < pts.length; k++) {
      var x3 = appetiteChartX(k);
      var y3 = pad.top + cH - (cH * (pts[k].value - minV) / rangeV);
      ctx.beginPath();
      ctx.arc(x3, y3, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#fb923c';
      ctx.fill();
      var step = Math.max(1, Math.floor(pts.length / 5));
      if (k % step === 0 || k === pts.length - 1) {
        ctx.fillStyle = '#888';
        ctx.font = '9px sans-serif';
        ctx.textAlign = 'center';
        var dl = (pts[k].date || '').slice(5);
        ctx.fillText(dl, x3, pad.top + cH + 14);
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

  /** feeding_logs.served_time を表示用・input[type=time] 用 HH:mm に */
  function cdFmtFedServedTime(raw) {
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

  /** JST の「昨日」YYYY-MM-DD（給餌ログ取得を calc と揃える） */
  function yesterdayJstYmd() {
    var t = todayJstYmd();
    var d = new Date(t + 'T12:00:00+09:00');
    d.setTime(d.getTime() - 86400000);
    return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  function careQuickMapKey(recordType, detailLabel) {
    return (recordType || '') + '|' + String(detailLabel || '');
  }

  /** ブラシ・アゴ・耳・お尻・目ヤニ拭き（爪切り・肉球は除外）— ワンタップまとめ記録用 */
  var CARE_GROOMING_BUNDLE_SPECS = [
    { record_type: 'care', label: 'ブラシ' },
    { record_type: 'care', label: 'アゴ' },
    { record_type: 'care', label: '耳' },
    { record_type: 'care', label: 'お尻' },
    { record_type: 'eye_discharge', label: '目ヤニ拭き' },
  ];

  function careGroomingBundleRank(recordType, label) {
    var k = careQuickMapKey(recordType, label);
    for (var i = 0; i < CARE_GROOMING_BUNDLE_SPECS.length; i++) {
      var s = CARE_GROOMING_BUNDLE_SPECS[i];
      if (careQuickMapKey(s.record_type, s.label) === k) return i;
    }
    return 999;
  }

  function htmlAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function loadCareSection() {
    if (!careArea) return Promise.resolve();
    careArea.innerHTML = '<div class="detail-section"><div class="detail-title">🪮 ケア実施状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var catParam = encodeURIComponent(catId);
    var typeFetch = careTypesCache.length > 0
      ? Promise.resolve(null)
      : fetch(API_BASE + '/health/care-types', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); });

    return Promise.all([
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=care&limit=60', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=eye_discharge&limit=60', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      typeFetch,
    ]).then(function (results) {
      if (results[2] && results[2].care_types) {
        careTypesCache = results[2].care_types;
      }
      if (careTypesCache.length === 0) {
        careTypesCache = [
          { id: 'brush', label: 'ブラシ', record_type: 'care' },
          { id: 'chin', label: 'アゴ', record_type: 'care' },
          { id: 'ear', label: '耳', record_type: 'care' },
          { id: 'nail', label: '爪切り', record_type: 'care' },
          { id: 'paw', label: '肉球', record_type: 'care' },
          { id: 'butt', label: 'お尻', record_type: 'care' },
          { id: 'eye', label: '目ヤニ拭き', record_type: 'eye_discharge' },
        ];
      }
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

  function buildTodayCareQuickMap(records, todayYmd) {
    var map = {};
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if ((r.record_date || '') !== todayYmd) continue;
      if (r.record_type !== 'care' && r.record_type !== 'eye_discharge') continue;
      var label = parseCareDetails(r.details);
      var key = careQuickMapKey(r.record_type, label);
      var done = r.value !== '×' && r.value !== 'ー';
      var prev = map[key];
      var ca = (r.created_at || '');
      if (!prev) {
        map[key] = { id: String(r.id), done: done, recorded_time: r.recorded_time, recorder_name: r.recorder_name, recorded_by: r.recorded_by, created_at: ca };
      } else if (ca >= (prev.created_at || '')) {
        map[key] = { id: String(r.id), done: done, recorded_time: r.recorded_time, recorder_name: r.recorder_name, recorded_by: r.recorded_by, created_at: ca };
      }
    }
    return map;
  }

  /** 履歴表示用: 同一日・同一ケア項目は created_at 最新の1件だけ（今日の□と整合） */
  function dedupeCareHistoryItemsBySlot(items, typesForSort) {
    if (!items || items.length === 0) return items;
    var sorted = items.slice().sort(function (a, b) {
      var ca = (a.created_at || '');
      var cb = (b.created_at || '');
      if (ca !== cb) return cb.localeCompare(ca);
      return (b.id || 0) - (a.id || 0);
    });
    var seen = {};
    var out = [];
    for (var i = 0; i < sorted.length; i++) {
      var r = sorted[i];
      var label = parseCareDetails(r.details);
      var k = careQuickMapKey(r.record_type, label);
      if (seen[k]) continue;
      seen[k] = true;
      out.push(r);
    }
    if (!typesForSort || typesForSort.length === 0) return out;
    function orderOf(rec) {
      var lab = parseCareDetails(rec.details);
      var key = careQuickMapKey(rec.record_type, lab);
      for (var ti = 0; ti < typesForSort.length; ti++) {
        var t = typesForSort[ti];
        if (careQuickMapKey(t.record_type || 'care', t.label || '') === key) return ti;
      }
      return 999;
    }
    out.sort(function (a, b) { return orderOf(a) - orderOf(b); });
    return out;
  }

  /**
   * 同一日・同一ケア項目の health_records を整理。exceptId が null なら該当行をすべて削除（□解除）。
   * exceptId ありならその id 以外を削除（新規保存後の重複除去）。
   */
  function deleteCareRecordsForSlotExcept(recordDate, recordType, detailLabel, exceptId, done) {
    var key = careQuickMapKey(recordType, detailLabel);
    var typeParam = recordType === 'eye_discharge' ? 'eye_discharge' : 'care';
    fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=' + encodeURIComponent(typeParam) + '&limit=120', {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      var recs = data.records || [];
      var toDel = [];
      for (var i = 0; i < recs.length; i++) {
        var r = recs[i];
        if ((r.record_date || '') !== recordDate) continue;
        if (r.record_type !== recordType) continue;
        var lab = parseCareDetails(r.details);
        if (careQuickMapKey(r.record_type, lab) !== key) continue;
        if (exceptId != null && String(r.id) === String(exceptId)) continue;
        toDel.push(r.id);
      }
      if (toDel.length === 0) {
        if (done) done(false);
        return;
      }
      var idx = 0;
      var hadErr = false;
      function delNext() {
        if (idx >= toDel.length) {
          if (done) done(hadErr);
          return;
        }
        fetch(API_BASE + '/health/records/' + encodeURIComponent(toDel[idx]), {
          method: 'DELETE',
          headers: apiHeaders(), cache: 'no-store',
        }).then(function (r) {
          return r.text().then(function (t) {
            var d = {};
            try { d = t ? JSON.parse(t) : {}; } catch (_) { d = {}; }
            if (!r.ok || d.error) hadErr = true;
          });
        }).catch(function () { hadErr = true; })
        .finally(function () {
          idx++;
          delNext();
        });
      }
      delNext();
    }).catch(function () {
      if (done) done(true);
    });
  }

  function renderCareSection(records) {
    var addBtn = '<button class="btn btn-outline btn-sm" style="margin-left:8px;font-size:12px;" onclick="openCareModal()">＋ ケア記録</button>';
    var today = todayJstYmd();
    var todayMap = buildTodayCareQuickMap(records, today);
    var types = careTypesCache.length ? careTypesCache : [];

    var html = '<div class="detail-section">';
    html += '<div class="detail-title">🪮 ケア実施状況' + addBtn + '</div>';

    if (types.length > 0) {
      var doneCt = 0;
      for (var dc = 0; dc < types.length; dc++) {
        var dct = types[dc];
        var dqk = careQuickMapKey(dct.record_type || 'care', dct.label || '');
        var dent = todayMap[dqk];
        if (dent && dent.done) doneCt++;
      }
      var totalCt = types.length;
      var pendCt = totalCt - doneCt;
      var sumCls = 'care-today-summary';
      if (doneCt === totalCt) sumCls += ' care-today-summary--all';
      else if (doneCt === 0) sumCls += ' care-today-summary--none';
      else sumCls += ' care-today-summary--partial';

      var groomKeys = {};
      for (var gki = 0; gki < CARE_GROOMING_BUNDLE_SPECS.length; gki++) {
        var gks = CARE_GROOMING_BUNDLE_SPECS[gki];
        groomKeys[careQuickMapKey(gks.record_type, gks.label)] = true;
      }
      var groomTypes = [];
      var otherTypes = [];
      for (var tix = 0; tix < types.length; tix++) {
        var tx = types[tix];
        var txk = careQuickMapKey(tx.record_type || 'care', tx.label || '');
        if (groomKeys[txk]) groomTypes.push(tx);
        else otherTypes.push(tx);
      }
      groomTypes.sort(function (a, b) {
        return careGroomingBundleRank(a.record_type || 'care', a.label || '') -
          careGroomingBundleRank(b.record_type || 'care', b.label || '');
      });

      html += '<div class="care-today-panel">';
      html += '<div class="' + sumCls + '">';
      html += '<span class="care-today-summary-main">今日のケア <b>' + doneCt + '</b> / ' + totalCt + ' 項目</span>';
      if (pendCt > 0) {
        html += '<span class="care-today-summary-warn">未実施 <b>' + pendCt + '</b></span>';
      } else {
        html += '<span class="care-today-summary-ok">すべて記録済み</span>';
      }
      html += '</div>';
      html += '<p class="care-today-help">下の「まとめて記録」でブラシ・アゴ・耳・お尻・目ヤニ拭きの5項目を<strong>一括で実施済み</strong>にします（チェック不要）。<strong>済</strong>の行は<strong>もう一度タップで取り消し</strong>できます。爪切り・肉球はその下の行の□から個別に記録・取り消しできます。</p>';
      html += '<div class="care-bundle-actions" style="margin:10px 0 14px;padding:12px;background:rgba(167,139,250,0.1);border-radius:10px;border:1px solid rgba(167,139,250,0.35);">';
      html += '<button type="button" class="btn btn-primary" id="careGroomingBundleBtn" onclick="completeCareGroomingBundle()" style="width:100%;max-width:100%;font-size:14px;padding:12px 14px;font-weight:800;">🪮 5項目まとめて記録（ブラシ・アゴ・耳・お尻・目ヤニ）</button>';
      html += '<p class="dim" style="font-size:11px;margin:8px 0 0;line-height:1.45;">本日まだ「済」になっていない5項目だけ追加します。</p>';
      html += '</div>';
      if (groomTypes.length > 0) {
        html += '<div class="care-today-divider">グルーミング5項目（上のボタンで記録・済の行はタップで取り消し）</div>';
        html += '<div class="care-today-rows">';
        for (var gi = 0; gi < groomTypes.length; gi++) {
          var ctg = groomTypes[gi];
          var rtg = ctg.record_type || 'care';
          var labg = ctg.label || '';
          var qkg = careQuickMapKey(rtg, labg);
          var entg = todayMap[qkg];
          var chkg = entg && entg.done;
          var escLabg = escapeHtml(labg);
          var rowClsg = chkg
            ? 'care-today-item care-today-item--done care-today-item--undoable'
            : 'care-today-item care-today-item--readonly care-today-item--pending';
          var hintg = '';
          if (chkg) {
            var hmg = [];
            if (entg.recorded_time) hmg.push(entg.recorded_time);
            if (entg.recorder_name) hmg.push(entg.recorder_name);
            else if (entg.recorded_by) hmg.push(String(entg.recorded_by));
            hintg = hmg.length ? escapeHtml(hmg.join(' · ')) + ' — タップで取り消し' : '記録済み — タップで取り消し';
          } else {
            hintg = '未実施 — 上のまとめて記録で一括登録';
          }
          var pillClsg = chkg ? 'care-today-item-pill care-today-item-pill--done' : 'care-today-item-pill care-today-item-pill--wait';
          var pillTxtg = chkg ? '済' : '未';
          if (chkg) {
            html += '<div tabindex="0" role="button" class="' + rowClsg + '" data-record-type="' + htmlAttr(rtg) + '" data-details="' + htmlAttr(labg) + '" onclick="undoCareGroomingRowFromEl(this)" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();undoCareGroomingRowFromEl(this);}">';
          } else {
            html += '<div class="' + rowClsg + '">';
          }
          html += '<span class="care-today-cb-spacer" aria-hidden="true"></span>';
          html += '<span class="care-today-item-main">';
          html += '<span class="care-today-item-title">' + escLabg + '</span>';
          html += '<span class="care-today-item-hint">' + hintg + '</span>';
          html += '</span>';
          html += '<span class="' + pillClsg + '">' + pillTxtg + '</span>';
          html += '</div>';
        }
        html += '</div>';
      }
      if (otherTypes.length > 0) {
        html += '<div class="care-today-divider">爪切り・肉球（□で個別記録）</div>';
        html += '<div class="care-today-rows">';
        for (var ti = 0; ti < otherTypes.length; ti++) {
          var ct = otherTypes[ti];
          var rt = ct.record_type || 'care';
          var lab = ct.label || '';
          var qk = careQuickMapKey(rt, lab);
          var ent = todayMap[qk];
          var chk = ent && ent.done;
          var rid = (ent && ent.done) ? ent.id : '';
          var escLab = escapeHtml(lab);
          var rowCls = 'care-today-item' + (chk ? ' care-today-item--done' : ' care-today-item--pending');
          var hint = '';
          if (chk) {
            var hm = [];
            if (ent.recorded_time) hm.push(ent.recorded_time);
            if (ent.recorder_name) hm.push(ent.recorder_name);
            else if (ent.recorded_by) hm.push(String(ent.recorded_by));
            hint = hm.length ? escapeHtml(hm.join(' · ')) + ' — もう一度タップで取り消し' : '記録済み — もう一度タップで取り消し';
          } else {
            hint = '未実施 — タップで記録';
          }
          var pillCls = chk ? 'care-today-item-pill care-today-item-pill--done' : 'care-today-item-pill care-today-item-pill--wait';
          var pillTxt = chk ? '済' : '未';
          html += '<label class="' + rowCls + '">';
          html += '<input type="checkbox" class="care-today-cb"' + (chk ? ' checked' : '') + ' data-record-type="' + htmlAttr(rt) + '" data-details="' + htmlAttr(lab) + '" data-record-id="' + htmlAttr(rid) + '" onchange="toggleCareQuick(this)">';
          html += '<span class="care-today-item-main">';
          html += '<span class="care-today-item-title">' + escLab + '</span>';
          html += '<span class="care-today-item-hint">' + hint + '</span>';
          html += '</span>';
          html += '<span class="' + pillCls + '">' + pillTxt + '</span>';
          html += '</label>';
        }
        html += '</div>';
      }
      html += '</div>';
    }

    if (records.length === 0) {
      html += '<div class="care-history-heading">履歴</div>';
      html += '<div class="empty-msg">まだ記録がありません</div></div>';
      careArea.innerHTML = html;
      return;
    }

    html += '<div class="care-history-heading">履歴</div>';

    var byDate = {};
    var dateOrder = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      var d = r.record_date || '';
      if (!byDate[d]) { byDate[d] = []; dateOrder.push(d); }
      byDate[d].push(r);
    }

    var visibleCount = 0;
    for (var k = 0; k < dateOrder.length; k++) {
      if (dateOrder[k] === today) { visibleCount = 1; break; }
    }

    var foldId = 'careFold';

    for (var di = 0; di < dateOrder.length && di < 7; di++) {
      var date = dateOrder[di];
      var items = dedupeCareHistoryItemsBySlot(byDate[date], types);
      var hidden = (visibleCount > 0 && di >= visibleCount) || (visibleCount === 0 && di >= 1);
      if (hidden && di === Math.max(visibleCount, 1)) {
        html += '<div id="' + foldId + '" class="fold-area" style="display:none;">';
      }
      var isTodayGroup = date === today;
      html += '<div class="care-date-group' + (isTodayGroup ? ' care-date-group--today' : '') + '">';
      html += '<div class="care-date-label">' + (isTodayGroup ? '今日 ' : '') + escapeHtml(date.slice(5)) + '</div>';
      html += '<div class="care-row">';
      for (var ci = 0; ci < items.length; ci++) {
        var done = items[ci].value !== '×' && items[ci].value !== 'ー';
        var cls = done ? 'care-done' : 'care-skip';
        var detailLabel = parseCareDetails(items[ci].details);
        var mark = done ? '<span class="care-chip-mark care-chip-mark--ok">済</span>' : '<span class="care-chip-mark care-chip-mark--skip">未</span>';
        html += '<span class="care-chip ' + cls + '">' + mark + '<span class="care-chip-name">' + escapeHtml(detailLabel) + '</span>';
        if (done) {
          var meta = [];
          if (items[ci].recorded_time) meta.push(items[ci].recorded_time);
          if (items[ci].recorder_name) meta.push(items[ci].recorder_name);
          else if (items[ci].recorded_by) meta.push(items[ci].recorded_by);
          if (meta.length > 0) {
            html += '<small>' + escapeHtml(meta.join(' · ')) + '</small>';
          } else if (items[ci].value) {
            html += '<small>' + escapeHtml(items[ci].value) + '</small>';
          }
        } else {
          html += '<small class="care-chip-skiplabel">スキップ</small>';
        }
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

  /** グルーミング5項目: 済の行をもう一度タップで取り消し */
  window.undoCareGroomingRowFromEl = function (el) {
    if (!el || el.getAttribute('data-care-undo-busy') === '1') return;
    var rt = el.getAttribute('data-record-type');
    var det = el.getAttribute('data-details') || '';
    if (!rt) return;
    el.setAttribute('data-care-undo-busy', '1');
    deleteCareRecordsForSlotExcept(todayJstYmd(), rt, det, null, function (hadErr) {
      el.removeAttribute('data-care-undo-busy');
      if (hadErr) alert('取り消しに失敗しました');
      loadCareSection();
    });
  };

  window.completeCareGroomingBundle = function () {
    var btn = document.getElementById('careGroomingBundleBtn');
    if (btn && btn.getAttribute('data-care-bundle-busy') === '1') return;
    if (btn) {
      btn.setAttribute('data-care-bundle-busy', '1');
      btn.disabled = true;
    }
    var today = todayJstYmd();
    var catParam = encodeURIComponent(catId);
    Promise.all([
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=care&limit=120', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/records?cat_id=' + catParam + '&type=eye_discharge&limit=120', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      var careRecs = (results[0] && results[0].records) ? results[0].records : [];
      var eyeRecs = (results[1] && results[1].records) ? results[1].records : [];
      var merged = careRecs.slice();
      for (var ei = 0; ei < eyeRecs.length; ei++) {
        eyeRecs[ei].details = '目ヤニ拭き';
        merged.push(eyeRecs[ei]);
      }
      var todayMap = buildTodayCareQuickMap(merged, today);
      var pending = [];
      for (var pi = 0; pi < CARE_GROOMING_BUNDLE_SPECS.length; pi++) {
        var sp = CARE_GROOMING_BUNDLE_SPECS[pi];
        var qk = careQuickMapKey(sp.record_type, sp.label);
        var ent = todayMap[qk];
        if (!ent || !ent.done) pending.push(sp);
      }
      if (pending.length === 0) {
        if (btn) {
          btn.disabled = false;
          btn.removeAttribute('data-care-bundle-busy');
        }
        alert('ブラシ・アゴ・耳・お尻・目ヤニ拭きは本日すでにすべて記録済みです');
        return;
      }
      var idx = 0;
      function finishAll() {
        if (btn) {
          btn.disabled = false;
          btn.removeAttribute('data-care-bundle-busy');
        }
        loadCareSection();
      }
      function postNext() {
        if (idx >= pending.length) {
          finishAll();
          return;
        }
        var sp = pending[idx];
        var body = {
          cat_id: catId,
          record_type: sp.record_type,
          record_date: today,
          value: '記録',
          details: sp.label,
          recorded_time: nowJstHm(),
        };
        fetch(API_BASE + '/health/records', {
          method: 'POST',
          headers: apiHeaders(),
          cache: 'no-store',
          body: JSON.stringify(body),
        }).then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) {
              if (btn) {
                btn.disabled = false;
                btn.removeAttribute('data-care-bundle-busy');
              }
              alert('エラー: ' + (data.message || data.error));
              loadCareSection();
              return;
            }
            var newId = data.record && data.record.id;
            if (newId) {
              deleteCareRecordsForSlotExcept(today, sp.record_type, sp.label, newId, function () {
                idx++;
                postNext();
              });
            } else {
              idx++;
              postNext();
            }
          })
          .catch(function () {
            if (btn) {
              btn.disabled = false;
              btn.removeAttribute('data-care-bundle-busy');
            }
            alert('ケア記録の保存に失敗しました');
            loadCareSection();
          });
      }
      postNext();
    }).catch(function () {
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute('data-care-bundle-busy');
      }
      alert('記録の取得に失敗しました');
    });
  };

  window.toggleCareQuick = function (el) {
    if (!el || el.getAttribute('data-care-busy') === '1') return;
    var rt = el.getAttribute('data-record-type');
    var det = el.getAttribute('data-details') || '';
    var rid = el.getAttribute('data-record-id') || '';
    var wantOn = el.checked;
    if (wantOn) {
      if (rid) return;
      el.setAttribute('data-care-busy', '1');
      el.disabled = true;
      var body = {
        cat_id: catId,
        record_type: rt,
        record_date: todayJstYmd(),
        value: '記録',
        details: det,
        recorded_time: nowJstHm(),
      };
      fetch(API_BASE + '/health/records', {
        method: 'POST',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify(body),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          alert('エラー: ' + (data.message || data.error));
          el.checked = false;
          el.disabled = false;
          el.removeAttribute('data-care-busy');
          return;
        }
        var newId = data.record && data.record.id;
        if (newId) {
          deleteCareRecordsForSlotExcept(todayJstYmd(), rt, det, newId, function () {
            el.disabled = false;
            el.removeAttribute('data-care-busy');
            loadCareSection();
          });
        } else {
          el.disabled = false;
          el.removeAttribute('data-care-busy');
          loadCareSection();
        }
      }).catch(function () {
        alert('ケア記録の保存に失敗しました');
        el.checked = false;
        el.disabled = false;
        el.removeAttribute('data-care-busy');
      });
    } else {
      if (!rid) {
        el.checked = false;
        return;
      }
      el.setAttribute('data-care-busy', '1');
      el.disabled = true;
      deleteCareRecordsForSlotExcept(todayJstYmd(), rt, det, null, function (hadErr) {
        el.disabled = false;
        el.removeAttribute('data-care-busy');
        if (hadErr) {
          alert('取り消しに失敗しました');
          el.checked = true;
          return;
        }
        loadCareSection();
      });
    }
  };

  // ── 排便状況セクション ─────────────────────────────────────────────────────────

  function loadStoolSection() {
    if (!stoolArea) return Promise.resolve();
    stoolArea.innerHTML = '<div class="detail-section"><div class="detail-title">🚽 排便状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    return fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=stool&limit=30', {
      headers: apiHeaders(), cache: 'no-store',
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
    }, 3, 'stoolFold', true);
    html += '</div></div>';
    stoolArea.innerHTML = html;
  }

  // ── 排尿状況セクション ─────────────────────────────────────────────────────────

  function loadUrineSection() {
    if (!urineArea) return Promise.resolve();
    urineArea.innerHTML = '<div class="detail-section"><div class="detail-title">💧 排尿状況</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    return fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=urine&limit=30', {
      headers: apiHeaders(), cache: 'no-store',
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

  // ── 共通ヘルパー: 2週間日付リスト / 日別グルーピング / 行レンダリング ──

  /** 直近 n 日の YYYY-MM-DD（日本日付）。排便・排尿一覧の列と record_date を一致させる */
  function buildRecentDays(n) {
    var result = [];
    var cur = todayJstYmd();
    for (var i = 0; i < n; i++) {
      result.push(cur);
      var d = new Date(cur + 'T12:00:00+09:00');
      d.setTime(d.getTime() - 86400000);
      cur = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
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

  function renderDailyRows(days, byDate, chipFn, visibleDays, foldId, grayPastExcretionRows) {
    var html = '';
    var folded = false;
    var todayYmd = todayJstYmd();
    for (var di = 0; di < days.length; di++) {
      var day = days[di];
      var dayLabel = day.slice(5);
      var entries = byDate[day];
      var pastClass = grayPastExcretionRows && day !== todayYmd ? ' stool-row-past' : '';

      if (visibleDays && foldId && di === visibleDays && !folded) {
        html += '<div id="' + foldId + '" class="fold-area" style="display:none;">';
        folded = true;
      }

      if (!entries) {
        html += '<div class="stool-row stool-none' + pastClass + '">';
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

        html += '<div class="stool-row' + pastClass + '">';
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
    if (!healthRecordsArea) return Promise.resolve();
    healthRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">⚖️ 体重記録</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    return fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&limit=30', {
      headers: apiHeaders(), cache: 'no-store',
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
    if (!clinicRecordsArea) return Promise.resolve();
    clinicRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">🏥 病院記録</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    // scope=clinic: API 側で病院系のみ取得（従来は全種別最新50件→クライアント絞り込みで病院行が欠落していた）
    return fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&scope=clinic&limit=100', {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.error) {
        clinicRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">🏥 病院記録</div><div style="padding:16px;color:#f87171;font-size:13px;">読み込みエラー: ' + escapeHtml(String(data.message || data.error)) + '</div></div>';
        return;
      }
      var recs = data.records || [];
      var clinicTypes = { vaccine: 1, checkup: 1, surgery: 1, dental: 1, emergency: 1, test: 1, observation: 1, medication_start: 1, medication_end: 1 };
      var filtered = [];
      for (var i = 0; i < recs.length; i++) {
        if (clinicTypes[recs[i].record_type]) filtered.push(recs[i]);
      }
      renderClinicRecords(filtered);
    }).catch(function () {
      clinicRecordsArea.innerHTML = '<div class="detail-section"><div class="detail-title">🏥 病院記録</div><div style="padding:16px;color:#f87171;font-size:13px;">通信に失敗しました。再読み込みしてください。</div></div>';
    });
  }

  var vetScheduleArea = document.getElementById('vetScheduleArea');

  function renderClinicRecords(records) {
    var typeLabels = { vaccine: 'ワクチン', checkup: '健診', surgery: '手術', dental: '歯科', emergency: '緊急', test: '検査', observation: '経過観察', medication_start: '投薬開始', medication_end: '投薬終了' };
    var todayStr = new Date().toISOString().slice(0, 10);

    // ── 病院予定セクション ──
    var scheduled = [];
    for (var u = 0; u < records.length; u++) {
      if (records[u].next_due) scheduled.push(records[u]);
    }
    scheduled.sort(function (a, b) { return a.next_due < b.next_due ? -1 : 1; });

    var schedHtml = '<div class="detail-section">';
    schedHtml += '<div class="section-header">';
    schedHtml += '<div class="detail-title">📅 病院予定</div>';
    schedHtml += '<button class="btn-add" onclick="openVetScheduleModal()" style="background:rgba(99,102,241,0.15);color:#a78bfa;">+ 予定追加</button>';
    schedHtml += '</div>';

    if (scheduled.length === 0) {
      schedHtml += '<div class="empty-msg">予定なし</div>';
    } else {
      for (var ui = 0; ui < scheduled.length; ui++) {
        var up = scheduled[ui];
        var upLabel = typeLabels[up.record_type] || up.record_type;
        var diffDays = Math.ceil((new Date(up.next_due) - new Date(todayStr)) / 86400000);
        var isOverdue = diffDays < 0;
        var urgColor = isOverdue ? '#f87171' : diffDays <= 7 ? '#fb923c' : diffDays <= 30 ? '#facc15' : '#4ade80';
        var daysText = diffDays === 0 ? '今日' : isOverdue ? Math.abs(diffDays) + '日超過' : diffDays + '日後';
        var bgColor = isOverdue ? 'rgba(248,113,113,0.1)' : 'rgba(99,102,241,0.08)';
        schedHtml += '<div class="vet-schedule-card" style="background:' + bgColor + ';border-left:3px solid ' + urgColor + ';">';
        schedHtml += '<div class="vet-schedule-main">';
        schedHtml += '<span style="font-size:18px;">' + (isOverdue ? '⚠️' : '📅') + '</span>';
        schedHtml += '<div style="flex:1;">';
        schedHtml += '<div style="font-size:14px;font-weight:600;color:var(--text-main);">' + escapeHtml(upLabel) + '</div>';
        schedHtml += '<div style="font-size:12px;color:var(--text-dim);margin-top:2px;">' + escapeHtml(formatClinicDateWestern(up.next_due)) + '</div>';
        var schedNote = '';
        if (up.details) {
          try {
            var pd = typeof up.details === 'string' ? JSON.parse(up.details) : up.details;
            schedNote = (pd && pd.note) ? String(pd.note).trim() : '';
          } catch (_sn) { schedNote = ''; }
        }
        if (schedNote) schedHtml += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;">📝 ' + escapeHtml(schedNote) + '</div>';
        schedHtml += '</div>';
        schedHtml += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">';
        schedHtml += '<span style="font-size:13px;font-weight:700;color:' + urgColor + ';white-space:nowrap;">' + daysText + '</span>';
        schedHtml += '<button type="button" class="btn-add" onclick="openClinicRecordFromSchedule(' + up.id + ')" style="background:rgba(99,102,241,0.15);color:#a78bfa;font-size:11px;padding:4px 8px;white-space:nowrap;">📝 受診を記録する</button>';
        schedHtml += '<div style="display:flex;gap:4px;">';
        schedHtml += '<button class="btn-edit-small" onclick="editVetScheduleDate(' + up.id + ',\'' + escapeHtml(up.next_due) + '\')" style="font-size:10px;color:var(--text-dim);padding:2px 6px;" title="日付変更">📅 変更</button>';
        schedHtml += '<button class="btn-edit-small" onclick="deleteVetSchedule(' + up.id + ')" style="font-size:10px;color:#f87171;padding:2px 6px;" title="削除">🗑</button>';
        schedHtml += '</div>';
        schedHtml += '</div>';
        schedHtml += '</div>';
        schedHtml += '</div>';
      }
    }
    schedHtml += '</div>';
    if (vetScheduleArea) vetScheduleArea.innerHTML = schedHtml;

    // ── 病院記録セクション ──
    var html = '<div class="detail-section">';
    html += '<div class="section-header">';
    html += '<div class="detail-title">🏥 病院記録</div>';
    html += '<button class="btn-add" onclick="openClinicRecordModal()">+ 記録</button>';
    html += '</div>';

    var pastRecords = [];
    for (var pi = 0; pi < records.length; pi++) {
      if (!records[pi].next_due) pastRecords.push(records[pi]);
    }

    if (pastRecords.length === 0) {
      html += '<div class="empty-msg">記録なし</div>';
    } else {
      for (var i = 0; i < pastRecords.length; i++) {
        var r = pastRecords[i];
        var typeLabel = typeLabels[r.record_type] || r.record_type;
        var badgeClass = 'hr-type-badge' + (r.record_type === 'emergency' ? ' emergency' : r.record_type === 'vaccine' ? ' vaccine' : '');
        html += '<div class="clinic-record-card">';
        html += '<div class="hr-head">';
        html += '<span><span class="' + badgeClass + '">' + escapeHtml(typeLabel) + '</span>' + escapeHtml(formatClinicDateWestern(r.record_date)) + '</span>';
        html += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;justify-content:flex-end;">';
        var visitedRevert = parseVetVisitedScheduleDate(r.value);
        if (visitedRevert) {
          html += '<button type="button" class="btn-edit-small" onclick="restoreVetScheduleFromVisited(' + r.id + ',\'' + escapeHtml(visitedRevert) + '\',\'' + escapeHtml(r.record_type) + '\')" title="受診済みを取り消して予定に戻す" style="font-size:10px;padding:2px 8px;color:#38bdf8;">↩ 予定に戻す</button>';
        }
        html += '<span style="font-size:11px;color:var(--text-dim);">' + escapeHtml(r.recorded_by || '') + '</span>';
        html += '<button type="button" class="btn-edit-small" onclick="openClinicRecordEditModal(' + r.id + ')" title="編集" style="font-size:11px;padding:2px 6px;">✏️</button>';
        html += '<button type="button" class="btn-edit-small" onclick="deleteClinicRecord(' + r.id + ')" title="削除" style="font-size:11px;color:#f87171;padding:2px 4px;">🗑</button>';
        html += '</div>';
        html += '</div>';

        var parsed = null;
        if (r.details) {
          try { parsed = JSON.parse(r.details); } catch (_) { parsed = null; }
        }
        var summaryOnly = '';
        if (parsed) {
          if (parsed.summary) summaryOnly = String(parsed.summary).trim();
          else if (parsed.structured && parsed.structured.summary) summaryOnly = String(parsed.structured.summary).trim();
          else if (parsed.note) summaryOnly = String(parsed.note).replace(/\s+/g, ' ').trim();
        }
        if (!summaryOnly && r.value) summaryOnly = String(r.value).trim();
        if (summaryOnly) {
          html += '<div class="cr-summary">' + escapeHtml(summaryOnly) + '</div>';
        }

        var att = r.attachments || [];
        if (att.length > 0) {
          html += '<div style="margin-top:8px;font-size:12px;">';
          for (var ai = 0; ai < att.length; ai++) {
            var af = att[ai];
            html += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0;">';
            html += '<span style="word-break:break-all;">' + escapeHtml(af.original_name || ('file-' + af.id)) + '</span>';
            html += '<button type="button" class="btn-edit-loc" style="font-size:11px;" onclick="openClinicRecordFile(' + r.id + ',' + af.id + ')">開く</button>';
            html += '<button type="button" class="btn-edit-loc" style="font-size:11px;color:#f87171;" onclick="deleteClinicRecordAttachment(' + r.id + ',' + af.id + ')">削除</button>';
            html += '</div>';
          }
          html += '</div>';
        }
        html +=
          '<label class="btn btn-outline btn-sm nyagi-ia-upload-btn nyagi-clinic-extra-upload" style="margin-top:8px;display:inline-flex;" data-cr-id="' +
          r.id +
          '" for="clinicExtraFileInput">＋ ファイルを追加</label>';
        html += '</div>';
      }
    }
    html += '</div>';
    clinicRecordsArea.innerHTML = html;
  }

  window.openClinicRecordFile = function (recordId, fileId) {
    fetch(API_BASE + '/health/records/' + recordId + '/files/' + fileId, {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw new Error('not found');
      var disposition = r.headers.get('Content-Disposition') || '';
      var nameMatch = disposition.match(/filename="([^"]+)"/);
      var fileName = nameMatch ? nameMatch[1] : 'document';
      return r.blob().then(function (blob) {
        return { blob: blob, name: fileName };
      });
    }).then(function (result) {
      var url = URL.createObjectURL(result.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 120000);
    }).catch(function () {
      alert('ファイルの取得に失敗しました');
    });
  };

  window.deleteClinicRecordAttachment = function (recordId, fileId) {
    if (!window.confirm('この添付ファイルを削除しますか？')) return;
    fetch(API_BASE + '/health/records/' + recordId + '/files/' + fileId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      if (!x.ok || (x.j && x.j.error)) {
        alert('削除に失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      var ed = document.getElementById('crEditId');
      if (ed && String(ed.value) === String(recordId)) {
        window.openClinicRecordEditModal(recordId);
      }
      loadClinicRecords();
    }).catch(function () {
      alert('削除に失敗しました');
    });
  };

  window.onClinicExtraFilesSelected = function (input) {
    if (!input || !input.files || input.files.length === 0) return;
    if (!_clinicExtraRecordId) {
      alert('対象の記録が選べていません。');
      input.value = '';
      return;
    }
    var rid = _clinicExtraRecordId;
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      if (f.size > CLINIC_RECORD_FILE_MAX_BYTES) {
        alert('「' + (f.name || 'file') + '」が大きすぎます（各10MB以下）');
        input.value = '';
        _clinicExtraRecordId = null;
        return;
      }
      var allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (allowed.indexOf(f.type) === -1) {
        alert('「' + (f.name || 'file') + '」は未対応形式です');
        input.value = '';
        _clinicExtraRecordId = null;
        return;
      }
    }
    var fd = new FormData();
    for (var j = 0; j < input.files.length; j++) {
      fd.append('file', input.files[j], input.files[j].name || 'file');
    }
    fetch(API_BASE + '/health/records/' + rid + '/file', {
      method: 'POST',
      headers: apiHeadersMultipart(),
      body: fd,
      cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      input.value = '';
      _clinicExtraRecordId = null;
      if (!x.ok || (x.j && x.j.error)) {
        alert('アップロードに失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadClinicRecords();
    }).catch(function () {
      input.value = '';
      _clinicExtraRecordId = null;
      alert('アップロードに失敗しました');
    });
  };

  // ── 投薬スケジュールセクション ─────────────────────────────────────────────────

  var _medLogDate = null;

  var _medActiveTab = 'schedule';

  function loadMedicationSchedule(selectedDate) {
    if (!medicationScheduleArea) return Promise.resolve();
    medicationScheduleArea.innerHTML = '<div class="detail-section"><div class="detail-title">💊 お薬管理</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var date = selectedDate || _medLogDate || new Date().toISOString().slice(0, 10);
    _medLogDate = date;

    return Promise.all([
      fetch(API_BASE + '/health/medications?cat_id=' + encodeURIComponent(catId), { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/medication-logs?cat_id=' + encodeURIComponent(catId) + '&date=' + date, { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&type=medication&limit=60', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch(API_BASE + '/health/medication-presets', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); }),
    ]).then(function (results) {
      renderMedicationUnified(results[0].medications || [], results[1].logs || [], date, results[2].records || [], results[3].presets || []);
    }).catch(function () {
      medicationScheduleArea.innerHTML = '';
    });
  }

  window.onMedLogDateChange = function () {
    var inp = document.getElementById('medLogDate');
    if (inp && inp.value) loadMedicationSchedule(inp.value);
  };

  var _medicationsList = [];

  function renderMedicationUnified(medications, logs, date, historyRecords, presets) {
    _medicationsList = medications;
    _medPresets = presets;

    var html = '<div class="detail-section">';
    html += '<div class="detail-title">💊 お薬管理</div>';

    // ── タブ ──
    html += '<div class="med-tabs">';
    html += '<div class="med-tab' + (_medActiveTab === 'schedule' ? ' active' : '') + '" onclick="switchMedTab(\'schedule\')">💊 スケジュール</div>';
    html += '<div class="med-tab' + (_medActiveTab === 'history' ? ' active' : '') + '" onclick="switchMedTab(\'history\')">📝 投薬履歴</div>';
    html += '<div class="med-tab' + (_medActiveTab === 'preset' ? ' active' : '') + '" onclick="switchMedTab(\'preset\')">📋 プリセット</div>';
    html += '</div>';

    // ── タブ1: スケジュール ──
    html += '<div id="medTabSchedule" class="med-tab-panel' + (_medActiveTab === 'schedule' ? ' active' : '') + '">';
    html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap;">';
    html += '<label style="font-size:12px;color:var(--text-dim);">記録日:</label>';
    html += '<input type="date" id="medLogDate" class="form-input" value="' + escapeHtml(date) + '" style="width:140px;padding:6px 8px;font-size:13px;" onchange="onMedLogDateChange()">';
    html += '<button class="btn-med-add" onclick="openMedScheduleModal()">＋ 追加</button>';
    html += '</div>';

    // 今日のサマリーバー
    var todayStr2 = new Date().toISOString().slice(0, 10);
    if (date === todayStr2 && logs.length > 0) {
      var doneCount = 0; var totalCount = logs.length;
      for (var lx = 0; lx < logs.length; lx++) { if (logs[lx].status === 'done') doneCount++; }
      var allDone = doneCount === totalCount;
      var barBg = allDone ? 'rgba(34,197,94,0.15)' : 'rgba(250,204,21,0.12)';
      var barIcon = allDone ? '✅' : '⏳';
      var barText = allDone ? '本日の投薬 すべて完了 (' + doneCount + '/' + totalCount + ')' : '本日の投薬 ' + doneCount + '/' + totalCount + ' 完了';
      html += '<div style="background:' + barBg + ';padding:8px 12px;border-radius:8px;margin-bottom:10px;font-size:13px;font-weight:600;">' + barIcon + ' ' + barText + '</div>';
    }

    if (medications.length === 0) {
      html += '<div class="empty-msg">投薬スケジュールなし</div>';
    } else {
      for (var i = 0; i < medications.length; i++) {
        var med = medications[i];
        html += '<div class="med-schedule-card">';
        html += '<div class="med-schedule-head"><div>';
        html += '<div class="med-schedule-name">' + escapeHtml(med.medicine_name || '') + '</div>';
        html += '<div class="med-schedule-meta">';
        if (med.dosage_amount) html += med.dosage_amount + (med.dosage_unit ? escapeHtml(med.dosage_unit) : '') + '&nbsp;';
        if (med.frequency) html += escapeHtml(formatFreqLabel(med.frequency)) + '&nbsp;';
        var slots = [];
        try { slots = JSON.parse(med.time_slots || '[]'); } catch (_) {}
        if (slots.length) html += '[' + slots.map(escapeHtml).join('/') + '] ';
        if (med.route) html += '(' + escapeHtml(med.route) + ')&nbsp;';
        var isCycleFreq = med.frequency === '隔日' || med.frequency === '隔日(A)' || med.frequency === '隔日(B)' || med.frequency === '2日に1回' || med.frequency === '3日に1回' || med.frequency === '週1回';
        html += (isCycleFreq ? '起算日: ' : '開始: ') + escapeHtml(med.start_date || '');
        if (med.end_date) {
          html += ' 〜 <span style="color:#f87171;">' + escapeHtml(med.end_date) + '</span>';
          var endDt = new Date(med.end_date + 'T00:00:00Z');
          var nowDt = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
          var daysLeft = Math.round((endDt - nowDt) / 86400000);
          if (daysLeft >= 0 && daysLeft <= 7) html += ' <span style="background:#f87171;color:#fff;padding:0 4px;border-radius:3px;font-size:10px;">残' + daysLeft + '日</span>';
        } else {
          html += ' 〜 <span style="color:var(--text-dim)">継続中</span>';
        }
        html += '</div>';
        if (med.frequency && med.frequency !== '毎日') {
          var nextD = calcNextDoseDate(med.frequency, med.start_date);
          if (nextD) html += '<div class="med-schedule-meta">📅 次回: ' + nextD.slice(5).replace('-', '/') + '</div>';
        }
        if (med.purpose) html += '<div class="med-schedule-meta">目的: ' + escapeHtml(med.purpose) + '</div>';
        if (med.notes) html += '<div class="med-schedule-tip">💡 ' + escapeHtml(med.notes) + '</div>';
        html += '</div></div>';

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
        html += '</div></div>';
      }
    }
    html += '</div>';

    // ── タブ2: 投薬履歴 ──
    html += '<div id="medTabHistory" class="med-tab-panel' + (_medActiveTab === 'history' ? ' active' : '') + '">';
    html += renderMedHistoryContent(historyRecords);
    html += '</div>';

    // ── タブ3: プリセット ──
    html += '<div id="medTabPreset" class="med-tab-panel' + (_medActiveTab === 'preset' ? ' active' : '') + '">';
    html += renderMedPresetContent(presets);
    html += '</div>';

    html += '</div>';
    medicationScheduleArea.innerHTML = html;
  }

  function renderMedHistoryContent(records) {
    var days = buildRecentDays(14);
    var byDate = groupByDate(records);
    var html = '<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;">直近14日間の投薬記録（手動入力・インポート）</div>';
    html += '<div class="stool-list">';
    html += renderDailyRows(days, byDate, function (r) {
      var name = r.value || '—';
      return '<span class="stool-chip med-chip">' + escapeHtml(name) + '</span>';
    }, 4, 'medHistFold');
    html += '</div>';
    return html;
  }

  function renderMedPresetContent(presets) {
    var html = '';
    if (presets.length === 0) {
      html += '<div class="empty-msg">プリセットがありません</div>';
    } else {
      for (var i = 0; i < presets.length; i++) {
        var p = presets[i];
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface);border-radius:6px;margin-bottom:6px;">';
        html += '<div>';
        html += '<div style="font-size:13px;font-weight:600;">' + escapeHtml(p.name) + '</div>';
        if (p.description) html += '<div style="font-size:11px;color:var(--text-dim);">' + escapeHtml(p.description) + '</div>';
        html += '<div style="font-size:11px;color:var(--text-dim);">💊 ' + (p.item_count || 0) + ' 件の薬</div>';
        html += '</div>';
        html += '<div style="display:flex;gap:4px;">';
        html += '<button class="btn-med-edit" onclick="editMedPreset(' + p.id + ')" title="編集">✏️</button>';
        html += '<button class="btn-med-stop" onclick="deleteMedPresetConfirm(' + p.id + ')" title="削除">🗑</button>';
        html += '<button class="btn-med-edit" style="background:rgba(74,222,128,0.18);color:#4ade80;font-size:11px;" onclick="applyMedPresetDirect(' + p.id + ',' + (p.item_count || 0) + ')" title="プリセット内の全薬をこの猫に適用">全て適用</button>';
        html += '</div></div>';
      }
    }
    html += '<div style="margin-top:10px;display:flex;gap:6px;align-items:center;">';
    html += '<input type="text" id="mpNewNameInline" class="form-input" placeholder="新しいプリセット名..." style="flex:1;min-width:0;font-size:12px;">';
    html += '<button type="button" class="btn btn-primary btn-med-preset-create" onclick="createMedPresetInline()">作成</button>';
    html += '</div>';
    return html;
  }

  window.switchMedTab = function (tab) {
    _medActiveTab = tab;
    var tabs = document.querySelectorAll('.med-tab');
    var panels = document.querySelectorAll('.med-tab-panel');
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove('active');
    for (var i = 0; i < panels.length; i++) panels[i].classList.remove('active');
    var tabMap = { schedule: 0, history: 1, preset: 2 };
    var panelMap = { schedule: 'medTabSchedule', history: 'medTabHistory', preset: 'medTabPreset' };
    if (tabs[tabMap[tab]]) tabs[tabMap[tab]].classList.add('active');
    var panel = document.getElementById(panelMap[tab]);
    if (panel) panel.classList.add('active');
  };

  window.applyMedPresetDirect = function (presetId, itemCount) {
    if (itemCount === 0) {
      alert('このプリセットには薬が登録されていません。先に編集で薬を追加してください。');
      return;
    }
    if (!confirm('プリセット内の全ての薬をこの猫の投薬スケジュールに追加しますか？')) return;
    fetch(API_BASE + '/health/medication-presets/' + presetId + '/apply', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ cat_id: catId }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      alert(data.count + ' 件の投薬スケジュールを追加しました');
      _medActiveTab = 'schedule';
      loadMedicationSchedule();
    }).catch(function () { alert('適用に失敗しました'); });
  };

  window.applyMedPresetItemToCat = function (presetItemId) {
    if (!_editingMedPresetId) { alert('プリセットが不明です'); return; }
    if (!confirm('この1件の薬だけ、この猫の投薬スケジュールに追加しますか？')) return;
    fetch(API_BASE + '/health/medication-presets/' + _editingMedPresetId + '/apply', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ cat_id: catId, preset_item_id: presetItemId }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      alert((data.count || 1) + ' 件の投薬スケジュールを追加しました');
      closeMedPresetEditModal('schedule');
    }).catch(function () { alert('適用に失敗しました'); });
  };

  window.createMedPresetInline = function () {
    var nameEl = document.getElementById('mpNewNameInline');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) { alert('プリセット名を入力してください'); return; }
    fetch(API_BASE + '/health/medication-presets', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ name: name }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      _medActiveTab = 'preset';
      loadMedicationSchedule();
    }).catch(function () { alert('作成に失敗しました'); });
  };

  function renderMedicationLogItem(log) {
    var rawSlot = (log.scheduled_at || '').slice(11);
    var slotLabel = rawSlot;
    if (rawSlot === '朝' || rawSlot === '昼' || rawSlot === '晩') { slotLabel = rawSlot; }
    else { slotLabel = rawSlot.slice(0, 5); }

    var stClass = 'med-log-item';
    if (log.status === 'done') stClass += ' med-log--done';
    else if (log.status === 'skipped') stClass += ' med-log--skip';
    else stClass += ' med-log--pending';

    var html = '<div class="' + stClass + '" id="medlog-' + log.id + '">';

    if (log.status === 'done') {
      var adminTime = (log.administered_at || '').slice(11, 16);
      html += '<span class="med-log-status">✅</span>';
      html += '<span class="med-log-time">' + escapeHtml(slotLabel) + '</span>';
      html += '<span class="med-log-label">' + escapeHtml(log.medicine_name || '') + '</span>';
      html += '<span class="med-log-detail">投与済 ' + escapeHtml(adminTime) + '</span>';
    } else if (log.status === 'skipped') {
      html += '<span class="med-log-status">⏭</span>';
      html += '<span class="med-log-time">' + escapeHtml(slotLabel) + '</span>';
      html += '<span class="med-log-label">' + escapeHtml(log.medicine_name || '') + '</span>';
      html += '<span class="med-log-detail">スキップ</span>';
    } else {
      html += '<span class="med-log-status">⬜</span>';
      html += '<span class="med-log-time">' + escapeHtml(slotLabel) + '</span>';
      html += '<span class="med-log-label">' + escapeHtml(log.medicine_name || '') + '</span>';
      html += '<span class="med-log-actions">';
      html += '<button class="btn-log-action done" onclick="doMedicationLog(' + log.id + ',\'done\')">💊 あげた</button>';
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
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({}),
    }).then(function (r) {
      return r.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : {}; } catch (_) {}
        return { ok: r.ok, status: r.status, data: data, raw: text };
      });
    })
    .then(function (res) {
      if (!res.ok) {
        var msg = (res.data && (res.data.message || res.data.error)) || ('HTTP ' + res.status);
        alert('エラー: ' + msg);
        return;
      }
      var data = res.data || {};
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
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
    return fetch(API_BASE + '/health/medicines?species=' + sp, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _medicinesList = data.medicines || [];
        return _medicinesList;
      })
      .catch(function () {
        _medicinesList = null;
        return [];
      });
  }

  function populateMedicineSelect(medicines, selectedId) {
    var sel = document.getElementById('msMedicineId');
    if (!sel) return;
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
      var ng = document.getElementById('msNewMedicineGroup');
      if (ng) ng.style.display = sel.value === '__new__' ? 'block' : 'none';
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
        var nmg = document.getElementById('msNewMedicineGroup');
        if (nmg) nmg.style.display = 'none';
        document.getElementById('msNewMedicineName').value = '';
        var nmu = document.getElementById('msNewMedicineUrl');
        if (nmu) nmu.value = '';

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
    var cycleHint = document.getElementById('msCycleHint');
    if (hint) hint.style.display = (freq === '隔日(A)' || freq === '隔日(B)') ? '' : 'none';
    var isCycle = freq === '隔日(A)' || freq === '隔日(B)' || freq === '3日に1回' || freq === '週1回';
    if (cycleHint) cycleHint.style.display = isCycle ? '' : 'none';
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
        headers: apiHeaders(), cache: 'no-store',
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
        headers: apiHeaders(), cache: 'no-store',
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
      var newUrlEl = document.getElementById('msNewMedicineUrl');
      var newRefUrl = newUrlEl && newUrlEl.value ? String(newUrlEl.value).trim() : '';
      var medBody = { id: 'med_' + newName.replace(/\s+/g, '_').toLowerCase() + '_' + Date.now(), name: newName };
      if (newRefUrl) medBody.reference_url = newRefUrl;
      fetch(API_BASE + '/health/medicines', {
        method: 'POST',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify(medBody),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('薬の登録に失敗: ' + (data.message || data.error)); return; }
        _medicinesList = null;
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
      headers: apiHeaders(), cache: 'no-store',
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
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('削除エラー: ' + (data.message || data.error)); return; }
      loadMedicationSchedule();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  // ── 給餌セクション（P5）──────────────────────────────────────────────────────

  function loadFeedingSection() {
    if (!feedingArea) return Promise.resolve();
    feedingArea.innerHTML = '<div class="detail-section"><div class="detail-title">🍽 給餌プラン</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';
    if (calorieArea) calorieArea.innerHTML = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    var today = todayJstYmd();
    var yesterday = yesterdayJstYmd();

    function attempt(retryCount) {
      retryCount = retryCount || 0;
      return Promise.all([
        _feedFetchJson(API_BASE + '/feeding/calc?cat_id=' + encodeURIComponent(catId)),
        _feedFetchJson(API_BASE + '/feeding/logs?cat_id=' + encodeURIComponent(catId) + '&date=' + today),
        _feedFetchJson(API_BASE + '/health/records?cat_id=' + encodeURIComponent(catId) + '&limit=40'),
        _feedFetchJson(API_BASE + '/feeding/foods'),
        _feedFetchJson(API_BASE + '/feeding/logs?cat_id=' + encodeURIComponent(catId) + '&date=' + yesterday),
        _feedFetchJsonSoft(API_BASE + '/health-scores?cat_id=' + encodeURIComponent(catId) + '&limit=60'),
      ]).then(function (results) {
        var calcData = results[0];
        _lastCalcData = calcData;
        renderCalorieCard(calcData);
        var healthRecs = (results[2] && results[2].records) || [];
        var foodsDb = (results[3] && results[3].foods) || [];
        var yesterdayLogs = (results[4] && results[4].logs) || [];
        var appetiteHist = (results[5] && results[5].scores) || [];
        renderFeedingSection(calcData, results[1].logs || [], today, healthRecs, foodsDb, yesterdayLogs, appetiteHist);
      }).catch(function (err) {
        if (retryCount < 2) {
          return new Promise(function (resolve) {
            setTimeout(function () {
              attempt(retryCount + 1).then(resolve, resolve);
            }, 1200);
          });
        }
        var hint = '';
        if (err && err.kind === 'http' && err.status === 401) {
          hint = '<div style="margin-top:8px;font-size:12px;">ログインの有効期限が切れている可能性があります。一度ログアウトしてから再ログインしてください。</div>';
        } else if (err && err.kind === 'parse') {
          hint = '<div style="margin-top:8px;font-size:12px;">サーバー応答が不正です。通信環境を確認するか、しばらくしてから再試行してください。</div>';
        }
        var errHtml = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div style="padding:16px;background:rgba(248,113,113,0.15);border-radius:8px;font-size:13px;color:#f87171;">データ取得に失敗しました。' + hint + '<button class="btn btn-outline" style="margin-top:8px;font-size:12px;" onclick="loadFeedingSection()">再読み込み</button></div></div>';
        if (calorieArea) calorieArea.innerHTML = errHtml;
        feedingArea.innerHTML = '<div class="detail-section"><div class="detail-title">🍽 給餌プラン</div><div style="padding:16px;color:var(--text-dim);">データ取得に失敗しました。' + hint + '<button class="btn btn-outline" style="margin-top:8px;" onclick="loadFeedingSection()">再読み込み</button></div></div>';
      });
    }
    return attempt(0);
  }

  function renderCalorieCard(calc) {
    if (!calorieArea) return;
    if (!calc || calc.error) {
      calorieArea.innerHTML = '<div class="detail-section"><div class="detail-title">🔥 カロリー評価</div><div style="padding:12px;color:var(--text-dim);font-size:13px;">データを取得できませんでした。</div></div>';
      return;
    }
    var hasKcal = calc.required_kcal && calc.required_kcal > 0;
    var displaySpecies = (calc && calc.species) || (currentCatData && currentCatData.species) || 'cat';
    var html = '<div class="detail-section">';
    html += '<div class="detail-title">🔥 カロリー評価・体型（BCS）</div>';
    html += '<div style="background:var(--surface);border-radius:8px;padding:12px;">';
    html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:8px;flex-wrap:wrap;gap:6px;">';
    html += '<span style="color:var(--text-dim);">種別（必要カロリー・ライフステージ）</span>';
    html += '<div style="display:flex;gap:6px;align-items:center;">';
    html += '<select id="speciesSelect" style="background:var(--surface-alt);color:var(--text-main);border:1px solid var(--surface-alt);border-radius:6px;padding:4px 8px;font-size:13px;">';
    html += '<option value="cat"' + (displaySpecies === 'cat' ? ' selected' : '') + '>🐱 猫</option>';
    html += '<option value="dog"' + (displaySpecies === 'dog' ? ' selected' : '') + '>🐶 犬</option>';
    html += '</select>';
    html += '<button type="button" class="btn-outline" style="font-size:11px;padding:4px 8px;" onclick="saveSpeciesFromCalorie()">保存</button>';
    html += '</div></div>';
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
      var stageLabel = escapeHtml(lifeStageLabel(calc.life_stage, displaySpecies));
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

  window.saveSpeciesFromCalorie = function () {
    var sel = document.getElementById('speciesSelect');
    if (!sel || !catId) return;
    var sp = sel.value;
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ species: sp }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (currentCatData) currentCatData.species = sp;
      loadFeedingSection();
    }).catch(function () {
      alert('種別の保存に失敗しました');
    });
  };

  window.saveBCS = function (value) {
    if (!value || !catId) return;
    var bcsNum = parseInt(value, 10);
    var bcsLabel = bcsNum === 5 ? '5（理想）' : bcsNum < 5 ? bcsNum + '（痩せ）' : bcsNum + '（肥満）';
    fetch(API_BASE + '/feeding/nutrition-profile?cat_id=' + encodeURIComponent(catId), {
      method: 'PATCH',
      headers: apiHeaders(), cache: 'no-store',
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

  function isEveningMealSlotForYesterdayBlock(slot) {
    var s = String(slot || '').toLowerCase();
    return s === 'evening' || s === 'night' || s === 'dinner';
  }

  /** 昨夜ブロックと重複しないよう、昨日ログのうち朝・昼・その他のみ一覧＋取消 */
  function renderYesterdayNonEveningLogsBlock(yesterdayLogs) {
    yesterdayLogs = yesterdayLogs || [];
    var rows = [];
    for (var i = 0; i < yesterdayLogs.length; i++) {
      if (!isEveningMealSlotForYesterdayBlock(yesterdayLogs[i].meal_slot)) rows.push(yesterdayLogs[i]);
    }
    if (rows.length === 0) return '';
    rows.sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
    var h = '<div style="background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.2);border-radius:10px;padding:12px;margin-bottom:12px;">';
    h += '<div style="font-size:14px;font-weight:700;color:#fbbf24;margin-bottom:6px;">📅 昨日のあげた記録（朝・昼・その他）</div>';
    h += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:8px;line-height:1.4;">誤って「あげた」が残っているときは取消してください。夜分は上の「昨夜の夜ごはん」でも取消できます。</div>';
    for (var j = 0; j < rows.length; j++) {
      var l = rows[j];
      var yMuted = cdLeftoverPctIsNonZero(l.eaten_pct);
      var yDim = yMuted ? '#94a3b8' : 'var(--text-dim)';
      h += '<div style="background:var(--surface);border-radius:8px;padding:8px 12px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;gap:8px;' + (yMuted ? 'color:#94a3b8;' : '') + '">';
      h += '<div style="font-size:13px;flex:1;min-width:0;">' + escapeHtml(slotLabel(l.meal_slot)) + ' · ' + escapeHtml(l.food_name || '—');
      if (l.offered_g) h += ' <span style="color:' + yDim + ';">' + l.offered_g + 'g</span>';
      if (l.eaten_pct !== null && l.eaten_pct !== undefined) h += ' <span style="color:' + yDim + ';">' + l.eaten_pct + '%</span>';
      h += '</div>';
      h += '<button type="button" class="btn-outline" style="font-size:11px;padding:4px 10px;flex-shrink:0;color:#f87171;" onclick="undoFed(' + l.id + ')">取消</button>';
      h += '</div>';
    }
    h += '</div>';
    return h;
  }

  /** 摂取率が 0 以外（数値として入力・記録されている）→ 残し記録まわりは文字をグレーに */
  function cdLeftoverPctIsNonZero(ep) {
    if (ep == null || ep === '') return false;
    var n = Number(ep);
    return !isNaN(n) && n !== 0;
  }

  function renderLeftoverInput(eveningPlans, eveningLogs) {
    var logByPlanId = {};
    for (var li = 0; li < eveningLogs.length; li++) {
      if (eveningLogs[li].plan_id) logByPlanId[eveningLogs[li].plan_id] = eveningLogs[li];
    }

    var items = [];
    for (var pi = 0; pi < eveningPlans.length; pi++) {
      var plan = eveningPlans[pi];
      var log = logByPlanId[plan.id] || null;
      items.push({ plan: plan, log: log, type: 'plan' });
    }
    for (var lli = 0; lli < eveningLogs.length; lli++) {
      if (!eveningLogs[lli].plan_id) {
        items.push({ plan: null, log: eveningLogs[lli], type: 'manual' });
      }
    }
    if (items.length === 0) return '';

    var allRecorded = true;
    for (var ci = 0; ci < items.length; ci++) {
      var it = items[ci];
      if (it.log && it.log.eaten_pct !== null && it.log.eaten_pct !== undefined && it.log.eaten_pct < 100) continue;
      if (it.log && it.log.eaten_pct === 100) continue;
      allRecorded = false;
      break;
    }

    var h = '<div style="background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.2);border-radius:10px;padding:12px;margin-bottom:12px;">';
    h += '<div style="font-size:14px;font-weight:700;color:#a78bfa;margin-bottom:8px;">🌙 昨夜の夜ごはん — 残り量を記録</div>';

    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var log = item.log;
      var plan = item.plan;
      var foodName = (log && log.food_name) || (plan && plan.food_name) || '不明';
      var offG = (log && log.offered_g) || (plan && plan.amount_g) || 0;

      var isLoMuted = !!(log && cdLeftoverPctIsNonZero(log.eaten_pct));
      var loOk = isLoMuted ? '#94a3b8' : '#4ade80';
      h += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:6px;' + (isLoMuted ? 'color:#94a3b8;' : '') + '">';
      h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
      h += '<div style="font-size:13px;font-weight:600;">' + escapeHtml(foodName) + '</div>';
      if (offG) h += '<span style="font-size:12px;color:' + (isLoMuted ? '#94a3b8' : 'var(--text-dim)') + ';">提供: ' + offG + 'g</span>';
      h += '</div>';

      if (log && log.eaten_pct !== null && log.eaten_pct !== undefined && log.eaten_pct < 100) {
        var leftG = Math.round(offG * (100 - log.eaten_pct) / 100 * 10) / 10;
        var ateG = Math.round(offG * log.eaten_pct / 100 * 10) / 10;
        h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        h += '<span style="font-size:12px;color:' + loOk + ';">✅ ' + log.eaten_pct + '% 食べた（' + ateG + 'g） / 残り ' + leftG + 'g</span>';
        h += '<span style="display:flex;gap:4px;flex-shrink:0;">';
        h += '<button class="btn-edit-small" onclick="openLeftoverEdit(' + log.id + ',' + offG + ')" title="修正" style="font-size:11px;color:var(--text-main);">✏️</button>';
        h += '<button type="button" class="btn-edit-small" onclick="undoFed(' + log.id + ')" title="この記録を削除" style="font-size:11px;color:#f87171;">取消</button>';
        h += '</span></div>';
      } else if (log && log.eaten_pct === 100) {
        h += '<div style="display:flex;justify-content:space-between;align-items:center;">';
        h += '<span style="font-size:12px;color:' + loOk + ';">✅ 完食</span>';
        h += '<span style="display:flex;gap:4px;flex-shrink:0;">';
        h += '<button class="btn-edit-small" onclick="openLeftoverEdit(' + log.id + ',' + offG + ')" title="修正" style="font-size:11px;color:var(--text-main);">✏️</button>';
        h += '<button type="button" class="btn-edit-small" onclick="undoFed(' + log.id + ')" title="この記録を削除" style="font-size:11px;color:#f87171;">取消</button>';
        h += '</span></div>';
      } else if (log && (log.eaten_pct === null || log.eaten_pct === undefined)) {
        h += '<div style="font-size:11px;color:#fbbf24;margin-bottom:6px;">摂取 0%（未確認）</div>';
        h += renderLeftoverControls(log.id, offG, 'log', false);
        h += '<div style="margin-top:6px;text-align:right;"><button type="button" class="btn-outline" style="font-size:11px;padding:4px 10px;color:#f87171;" onclick="undoFed(' + log.id + ')">記録を削除（取消）</button></div>';
      } else if (log) {
        h += renderLeftoverControls(log.id, offG, 'log', isLoMuted);
        h += '<div style="margin-top:6px;text-align:right;"><button type="button" class="btn-outline" style="font-size:11px;padding:4px 10px;color:#f87171;" onclick="undoFed(' + log.id + ')">記録を削除（取消）</button></div>';
      } else if (plan) {
        h += renderLeftoverControls(plan.id, offG, 'plan', false);
      }
      h += '</div>';
    }

    if (allRecorded) {
      h += '<div style="text-align:center;font-size:11px;color:var(--text-dim);margin-top:4px;">全品目の残り量が記録済みです</div>';
    }

    h += '</div>';
    return h;
  }

  function renderLeftoverControls(id, offG, mode, labelMuted) {
    var prefix = mode === 'plan' ? 'plan' : 'log';
    var labCol = labelMuted ? '#94a3b8' : 'var(--text-dim)';
    var h = '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">';
    h += '<label style="font-size:12px;color:' + labCol + ';">残り:</label>';
    h += '<input type="number" id="leftover-g-' + prefix + '-' + id + '" placeholder="g" min="0" step="0.1" style="width:60px;font-size:13px;padding:4px 6px;border:1px solid rgba(255,255,255,0.15);border-radius:6px;background:var(--surface-alt);color:var(--text-main);"';
    if (offG) h += ' max="' + offG + '"';
    h += '>';
    if (mode === 'plan') {
      h += '<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="saveLeftoverFromPlan(' + id + ',' + offG + ')">保存</button>';
      h += '<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;background:rgba(74,222,128,0.15);color:#4ade80;border-color:rgba(74,222,128,0.3);" onclick="saveLeftoverFromPlanComplete(' + id + ')">完食</button>';
    } else {
      h += '<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;" onclick="saveLeftover(' + id + ',' + offG + ')">保存</button>';
      h += '<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;background:rgba(74,222,128,0.15);color:#4ade80;border-color:rgba(74,222,128,0.3);" onclick="saveLeftoverComplete(' + id + ')">完食</button>';
    }
    h += '</div>';
    return h;
  }

  function renderFeedingSection(calc, logs, today, healthRecs, foodsDb, yesterdayLogs, appetiteScoreHistory) {
    healthRecs = healthRecs || [];
    foodsDb = foodsDb || [];
    yesterdayLogs = yesterdayLogs || [];

    var html = '<div class="detail-section">';
    var appetitePts = normalizeAppetiteHistoryToPoints(appetiteScoreHistory || []);
    html += appetiteIndexChartBlockHtml(appetitePts);

    var eveningPlans = [];
    var allPlans = (calc && calc.plans) || [];
    for (var epi = 0; epi < allPlans.length; epi++) {
      var ps = allPlans[epi].meal_slot || '';
      if (ps === 'evening') eveningPlans.push(allPlans[epi]);
    }
    var eveningLogs = [];
    for (var yl = 0; yl < yesterdayLogs.length; yl++) {
      var slot = yesterdayLogs[yl].meal_slot || '';
      if (slot === 'evening' || slot === 'night' || slot === 'dinner') {
        eveningLogs.push(yesterdayLogs[yl]);
      }
    }
    if (eveningPlans.length > 0 || eveningLogs.length > 0) {
      html += renderLeftoverInput(eveningPlans, eveningLogs);
    }

    html += renderYesterdayNonEveningLogsBlock(yesterdayLogs);

    var yesterdayRel = (function (ymd) {
      var d = new Date(ymd + 'T12:00:00+09:00');
      d.setTime(d.getTime() - 86400000);
      return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    })(today);
    var prevEvening = null, morningMeal = null, eveningMeal = null;
    for (var hi = 0; hi < healthRecs.length; hi++) {
      var hr = healthRecs[hi];
      if (hr.record_type !== 'observation') continue;
      var det = hr.details || '';
      if (!prevEvening && det === '前日夜ごはん' && hr.record_date === today) prevEvening = hr;
      if (!morningMeal && det === '朝飯内容' && hr.record_date === today) morningMeal = hr;
      if (!eveningMeal && det === '夜飯内容' && hr.record_date === today) eveningMeal = hr;
      if (!eveningMeal && det === '夜飯内容' && hr.record_date === yesterdayRel) eveningMeal = hr;
      if (!prevEvening && det === '前日夜ごはん' && hr.record_date === yesterdayRel) prevEvening = hr;
      if (!morningMeal && det === '朝飯内容' && hr.record_date === yesterdayRel) morningMeal = hr;
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

    var presetName = currentCatData && currentCatData.assigned_preset_name;
    var presetId = currentCatData && currentCatData.assigned_preset_id;
    html += '<div style="background:var(--surface);border-radius:8px;padding:8px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">';
    html += '<div style="font-size:12px;color:var(--text-dim);">';
    html += '🔗 紐づけプリセット: ';
    if (presetName) {
      html += '<b style="color:var(--primary, #a78bfa);">' + escapeHtml(presetName) + '</b>';
    } else {
      html += '<span style="color:var(--text-dim);">未設定</span>';
    }
    html += '</div>';
    html += '<button class="btn-outline" style="font-size:11px;padding:3px 8px;" onclick="openAssignPresetModal()">変更</button>';
    html += '</div>';
    var presetDesc = currentCatData && currentCatData.assigned_preset_description;
    var presetMemoHasName = presetName && String(presetName).trim();
    var presetMemoHasDesc = presetDesc && String(presetDesc).trim();
    if (presetMemoHasDesc || presetMemoHasName) {
      html += '<div style="font-size:11px;color:var(--text-dim);line-height:1.4;margin:-4px 0 10px;padding:8px 10px;background:rgba(168,139,250,0.08);border-radius:8px;border-left:3px solid rgba(168,139,250,0.45);">';
      html += '<span style="font-weight:600;color:var(--primary,#a78bfa);">📝 プリセットメモ</span>';
      if (presetMemoHasDesc) {
        html += '<br><span style="color:var(--text-main);white-space:pre-wrap;">' + escapeHtml(String(presetDesc).trim()) + '</span>';
      } else {
        html += '<br><span style="font-size:10px;color:var(--text-dim);">プリセット全体の説明・各フードのメモは未登録です</span>';
      }
      html += '</div>';
    }

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
      // プラン0件の分岐でも朝/夕ボタンに使うため、ここで必ず定義する（else 内のみだと undefined で例外→「データ取得に失敗」になる）
      var _slotFixed = ['morning', 'afternoon', 'evening'];
      // 同一プランに同日複数ログがあると object 上書きで1件しか持たず、取り消し1回では残りが残って「消えない」ように見える
      var todayLogsByPlanId = {};
      for (var li = 0; li < logs.length; li++) {
        if (!logs[li].plan_id) continue;
        if (logs[li].log_date && logs[li].log_date !== today) continue;
        var pkey = String(logs[li].plan_id);
        if (!todayLogsByPlanId[pkey]) todayLogsByPlanId[pkey] = [];
        todayLogsByPlanId[pkey].push(logs[li]);
      }
      for (var pk in todayLogsByPlanId) {
        if (!todayLogsByPlanId.hasOwnProperty(pk)) continue;
        todayLogsByPlanId[pk].sort(function (a, b) { return (a.id || 0) - (b.id || 0); });
      }

      if (plans.length === 0) {
        html += '<div class="empty-msg" style="margin-bottom:8px;">給餌プランなし — 下のボタンか「📋 プリセット」で登録してください</div>';
        html += '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:8px;">';
        for (var emsi = 0; emsi < _slotFixed.length; emsi++) {
          if (_slotFixed[emsi] === 'afternoon') continue;
          html += '<button type="button" class="btn-add" onclick="openAddPlanModal(\'' + _slotFixed[emsi] + '\')" style="font-size:12px;">+ ' + slotLabel(_slotFixed[emsi]) + 'に追加</button>';
        }
        html += '</div>';
      } else {
        var slots = {};
        for (var i = 0; i < plans.length; i++) {
          var sl = plans[i].meal_slot || 'other';
          if (!slots[sl]) slots[sl] = { items: [], totalG: 0, totalKcal: 0 };
          slots[sl].items.push(plans[i]);
          slots[sl].totalG += plans[i].amount_g || 0;
          slots[sl].totalKcal += plans[i].kcal_calc || 0;
        }
        var slotOrder = [];
        for (var sfi = 0; sfi < _slotFixed.length; sfi++) {
          if (slots[_slotFixed[sfi]]) slotOrder.push(_slotFixed[sfi]);
        }
        for (var sk in slots) { if (slots.hasOwnProperty(sk) && slotOrder.indexOf(sk) === -1) slotOrder.push(sk); }
        var grandG = 0;
        var grandKcal = 0;
        var _slotColors = { morning: 'rgba(251,191,36,0.10)', afternoon: 'rgba(96,165,250,0.08)', evening: 'rgba(139,92,246,0.10)' };
        var _slotBorders = { morning: 'rgba(251,191,36,0.4)', afternoon: 'rgba(96,165,250,0.3)', evening: 'rgba(139,92,246,0.4)' };
        for (var si = 0; si < slotOrder.length; si++) {
          var sKey = slotOrder[si];
          var slot = slots[sKey];
          grandG += slot.totalG;
          grandKcal += slot.totalKcal;
          var sBg = _slotColors[sKey] || 'var(--surface)';
          var sBorder = _slotBorders[sKey] || 'transparent';
          html += '<div style="background:' + sBg + ';border-left:3px solid ' + sBorder + ';border-radius:8px;padding:10px 12px;margin-bottom:6px;">';
          html += '<div style="display:flex;justify-content:space-between;margin-bottom:6px;">';
          html += '<b style="font-size:14px;">' + slotLabel(sKey) + '</b>';
          html += '<span style="font-size:11px;color:var(--text-dim);">計 ' + Math.round(slot.totalG) + 'g / ' + Math.round(slot.totalKcal) + 'kcal</span>';
          html += '</div>';
          for (var ii = 0; ii < slot.items.length; ii++) {
            var p = slot.items[ii];
            var fedList = todayLogsByPlanId[String(p.id)] || [];
            var fedLog = fedList.length ? fedList[fedList.length - 1] : null;
            var isFed = fedList.length > 0;
            var undoIdCsv = fedList.map(function (fl) { return fl.id; }).join(',');
            var typeTag = p.plan_type === 'preset' ? '<span style="font-size:9px;background:rgba(168,139,250,0.2);color:#c4b5fd;padding:1px 4px;border-radius:3px;margin-right:4px;">プリセット</span>' :
              p.plan_type === 'nyagi' ? '<span style="font-size:9px;background:rgba(74,222,128,0.2);color:#4ade80;padding:1px 4px;border-radius:3px;margin-right:4px;">NYAGI</span>' : '';

            html += '<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.04);">';

            if (isFed) {
              var undoTitle = fedList.length > 1
                ? '取り消し（同日の記録が' + fedList.length + '件あります。確認のうえまとめて削除）'
                : 'もう一度タップで取り消し' + (fedLog.served_time ? '（' + String(fedLog.served_time) + '）' : '');
              html += '<button type="button" onclick="undoFedMany(\'' + undoIdCsv + '\')" style="font-size:18px;background:none;border:none;cursor:pointer;padding:0;" title="' + escapeHtml(undoTitle) + '">✅' + (fedList.length > 1 ? '<span style="font-size:10px;vertical-align:super;">' + fedList.length + '</span>' : '') + '</button>';
            } else {
              html += '<button type="button" onclick=\'openQuickFedModal(' + p.id + ',' + JSON.stringify(String(p.food_name || '')) + ',' + (p.amount_g != null && !isNaN(Number(p.amount_g)) ? Number(p.amount_g) : 'null') + ')\' style="font-size:18px;background:none;border:none;cursor:pointer;padding:0;" title="あげた！">⬜</button>';
            }

            html += '<div style="flex:1;min-width:0;">';
            html += '<div style="font-size:12px;display:flex;align-items:center;">' + typeTag + escapeHtml(p.food_name || '') + '</div>';
            html += '<div style="font-size:11px;color:var(--text-dim);">' + p.amount_g + 'g (' + Math.round(p.kcal_calc || 0) + 'kcal)';
            if (p.scheduled_time) html += ' ⏰' + escapeHtml(p.scheduled_time);
            html += '</div>';
            if (isFed) {
              var fedStDisp = cdFmtFedServedTime(fedLog.served_time);
              html += '<div style="font-size:11px;color:#93c5fd;margin-top:2px;">🕐 ' + (fedStDisp ? escapeHtml(fedStDisp) : '—') + '</div>';
            }
            if (p.notes && String(p.notes).trim()) {
              html += '<div style="font-size:10px;color:var(--text-dim);margin-top:3px;line-height:1.35;padding:4px 6px;background:rgba(255,255,255,0.04);border-radius:4px;">📝 ' + escapeHtml(String(p.notes).trim()) + '</div>';
            }
            if (isFed && fedLog.eaten_pct !== null && fedLog.eaten_pct !== undefined && fedLog.eaten_pct < 100) {
              var cFed = cdLeftoverPctIsNonZero(fedLog.eaten_pct) ? '#94a3b8' : '#facc15';
              html += '<div style="font-size:10px;color:' + cFed + ';">食べた量: ' + fedLog.eaten_pct + '%</div>';
            } else if (isFed && (fedLog.eaten_pct === null || fedLog.eaten_pct === undefined)) {
              html += '<div style="font-size:10px;color:#fbbf24;">食べた量: 0%（未確認・🍽で入力）</div>';
            } else if (isFed && fedLog.eaten_pct === 100) {
              var c100 = cdLeftoverPctIsNonZero(100) ? '#94a3b8' : '#4ade80';
              html += '<div style="font-size:10px;color:' + c100 + ';">食べた量: 100%（完食）</div>';
            }
            html += '</div>';

            html += '<div style="display:flex;gap:2px;">';
            if (isFed) {
              html += '<button type="button" class="btn-edit-small" onclick="openFeedingLogModalForEdit(' + fedLog.id + ')" title="食べ残し修正（最新の1件）" style="font-size:11px;">🍽</button>';
            }
            html += '<button type="button" class="btn-edit-small" onclick="editPlan(' + p.id + ')" title="編集" style="font-size:11px;">✏️</button>';
            html += '<button type="button" class="btn-edit-small" onclick="deletePlan(' + p.id + ',\'' + String(p.meal_slot || '').replace(/'/g, '') + '\')" title="削除" style="font-size:11px;color:#f87171;">🗑</button>';
            html += '</div>';
            html += '</div>';
          }
          html += '<div style="text-align:center;margin-top:6px;">';
          html += '<button type="button" class="btn-outline" style="font-size:11px;padding:4px 12px;opacity:0.8;" onclick="openAddPlanModal(\'' + sKey + '\')" title="' + slotLabel(sKey) + 'に追加">+ ' + slotLabel(sKey) + 'に追加</button>';
          html += '</div>';
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
      if (logs[mli].plan_id) continue;
      if (logs[mli].log_date && logs[mli].log_date !== today) continue;
      manualLogs.push(logs[mli]);
    }
    if (manualLogs.length > 0) {
      html += '<div style="margin-top:12px;font-size:13px;font-weight:700;padding:4px 0;border-top:1px solid var(--surface-alt);">📝 手動記録</div>';
      for (var i = 0; i < manualLogs.length; i++) {
        var l = manualLogs[i];
        html += '<div class="feeding-log-row" style="background:var(--surface);border-radius:8px;padding:8px 12px;margin-top:6px;display:flex;justify-content:space-between;align-items:center;">';
        html += '<span style="font-size:13px;">' + escapeHtml(slotLabel(l.meal_slot)) + ': ';
        if (l.food_name) html += escapeHtml(l.food_name) + ' ';
        if (l.offered_g) html += l.offered_g + 'g';
        var manSt = cdFmtFedServedTime(l.served_time);
        if (manSt) html += ' <span style="color:#93c5fd;">🕐 ' + escapeHtml(manSt) + '</span>';
        html += '</span>';
        html += '<span style="display:flex;align-items:center;gap:8px;">';
        if (l.eaten_pct !== null && l.eaten_pct !== undefined) {
          var eatColor = cdLeftoverPctIsNonZero(l.eaten_pct) ? '#94a3b8' : (l.eaten_pct >= 80 ? '#4ade80' : l.eaten_pct >= 50 ? '#facc15' : '#f87171');
          html += '<span style="font-size:12px;color:' + eatColor + ';">' + l.eaten_pct + '%</span>';
        } else {
          html += '<span style="font-size:12px;color:#fbbf24;">0%</span>';
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
    _feedingSectionRenderedDate = today;
    setTimeout(function () { paintAppetiteIndexCanvas(appetitePts); }, 0);
  }

  window.saveLeftoverFromPlan = function (planId, offeredG) {
    var input = document.getElementById('leftover-g-plan-' + planId);
    if (!input) return;
    var leftG = parseFloat(input.value);
    if (isNaN(leftG) || leftG < 0) { alert('残り量を入力してください'); return; }
    if (offeredG > 0 && leftG > offeredG) { alert('提供量(' + offeredG + 'g)を超えています'); return; }
    var eatenPct = offeredG > 0 ? Math.round((offeredG - leftG) / offeredG * 100) : 0;
    var yesterday = yesterdayJstYmd();
    fetch(API_BASE + '/feeding/plans/' + planId + '/fed', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ eaten_pct: eatenPct, log_date: yesterday, served_time: nowJstHm() }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('保存に失敗しました'); });
  };

  window.saveLeftoverFromPlanComplete = function (planId) {
    var yesterday = yesterdayJstYmd();
    fetch(API_BASE + '/feeding/plans/' + planId + '/fed', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ eaten_pct: 100, log_date: yesterday, served_time: nowJstHm() }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('保存に失敗しました'); });
  };

  window.openLeftoverEdit = function (logId, offeredG) {
    var row = document.getElementById('leftover-row-' + logId);
    if (!row) {
      var parent = document.querySelector('[onclick*="openLeftoverEdit(' + logId + '"]');
      if (parent) row = parent.closest('[style*="background:var(--surface)"]');
    }
    if (!row) return;
    var existingInput = row.querySelector('input[type="number"]');
    if (existingInput) return;
    var editDiv = document.createElement('div');
    editDiv.style.cssText = 'margin-top:6px;';
    editDiv.innerHTML = renderLeftoverControls(logId, offeredG, 'log', false);
    row.appendChild(editDiv);
  };

  window.saveLeftover = function (logId, offeredG) {
    var input = document.getElementById('leftover-g-log-' + logId);
    if (!input) return;
    var leftG = parseFloat(input.value);
    if (isNaN(leftG) || leftG < 0) { alert('残り量を入力してください'); return; }
    if (offeredG > 0 && leftG > offeredG) { alert('提供量(' + offeredG + 'g)を超えています'); return; }
    var eatenPct = offeredG > 0 ? Math.round((offeredG - leftG) / offeredG * 100) : 0;
    if (eatenPct < 0) eatenPct = 0;
    if (eatenPct > 100) eatenPct = 100;
    fetch(API_BASE + '/feeding/logs/' + logId, {
      method: 'PUT', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ eaten_pct: eatenPct }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('保存に失敗しました'); });
  };

  window.saveLeftoverComplete = function (logId) {
    fetch(API_BASE + '/feeding/logs/' + logId, {
      method: 'PUT', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ eaten_pct: 100 }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadFeedingSection();
    }).catch(function () { alert('保存に失敗しました'); });
  };

  var _cdQfPlanId = null;
  var _cdQfPlanAmountG = null;

  window.openQuickFedModal = function (planId, foodName, amountG) {
    _cdQfPlanId = planId;
    var ag = amountG != null && !isNaN(Number(amountG)) ? Number(amountG) : NaN;
    _cdQfPlanAmountG = !isNaN(ag) && ag > 0 ? ag : null;
    var t = document.getElementById('cdQfTitle');
    if (t) t.textContent = '🍚 あげた記録';
    var fn = document.getElementById('cdQfFoodName');
    if (fn) fn.textContent = foodName || '—';
    var og = document.getElementById('cdQfOfferedG');
    if (og) og.value = amountG != null && !isNaN(Number(amountG)) ? String(amountG) : '';
    var lfg = document.getElementById('cdQfLeftG');
    if (lfg) lfg.value = '';
    var qfst = document.getElementById('cdQfServedTime');
    if (qfst) qfst.value = nowJstHm();
    var m = document.getElementById('cdQuickFedModal');
    if (m) m.classList.add('open');
  };

  window.closeCdQuickFedModal = function () {
    _cdQfPlanId = null;
    _cdQfPlanAmountG = null;
    var modal = document.getElementById('cdQuickFedModal');
    if (modal) modal.classList.remove('open');
  };

  window.submitCdQuickFed = function (deferIntake) {
    if (!_cdQfPlanId) return;
    deferIntake = !!deferIntake;
    var og = document.getElementById('cdQfOfferedG');
    var offeredG = og && String(og.value).trim() !== '' ? parseFloat(og.value) : null;
    var qfst = document.getElementById('cdQfServedTime');
    var st = qfst && qfst.value ? qfst.value.trim() : '';
    if (!st) st = nowJstHm();
    var payload = { log_date: todayJstYmd(), served_time: st };
    if (offeredG != null && !isNaN(offeredG) && offeredG > 0) payload.offered_g = offeredG;
    if (!deferIntake) {
      var lfin = document.getElementById('cdQfLeftG');
      var leftStr = lfin && lfin.value != null ? String(lfin.value).trim() : '';
      // 空欄＝サーバで摂取0%。残りgで％算出。0 入力＝完食(100%)。
      if (leftStr !== '') {
        var leftG = parseFloat(leftStr);
        if (isNaN(leftG) || leftG < 0) {
          alert('残り量は0以上の数値にしてください');
          return;
        }
        var effectiveOff = offeredG != null && !isNaN(offeredG) && offeredG > 0 ? offeredG : _cdQfPlanAmountG;
        if (effectiveOff != null && leftG > effectiveOff) {
          alert('残りが提供量(' + effectiveOff + 'g)を超えています');
          return;
        }
        payload.leftover_g = leftG;
      }
    }
    fetch(API_BASE + '/feeding/plans/' + encodeURIComponent(_cdQfPlanId) + '/fed', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeCdQuickFedModal();
        loadFeedingSection();
      }).catch(function () { alert('記録に失敗しました'); });
  };

  /** カンマ区切りのログIDを順に削除（同日・同一プランの重複「あげた」対策） */
  window.undoFedMany = function (idCsv) {
    var ids = String(idCsv || '').split(',').map(function (x) { return parseInt(x.trim(), 10); }).filter(function (n) { return !isNaN(n); });
    if (ids.length === 0) { alert('取り消すログが見つかりません'); return; }
    if (ids.length > 1) {
      var msg = 'このプランの給餌記録が ' + ids.length + ' 件あります。まとめて取り消しますか？';
      if (!confirm(msg)) return;
    }
    _setFeedingAreaBusy('取り消し中です…（通信に失敗する場合は数十秒後にメッセージが出ます）');
    function deleteAt(i) {
      if (i >= ids.length) {
        loadFeedingSection();
        return;
      }
      _fetchDeleteJsonWithTimeout(API_BASE + '/feeding/logs/' + ids[i], 28000).then(function (data) {
        if (!data._httpOk || data.error) {
          alert('エラー: ' + (data.message || data.error || '取り消しに失敗しました'));
          loadFeedingSection();
          return;
        }
        deleteAt(i + 1);
      }).catch(function (e) {
        if (e && e._nyagiTimeout) {
          alert('取り消しの通信がタイムアウトしました。電波・VPN・ログイン状態を確認し、再読み込みしてください。');
        } else {
          alert('取り消しに失敗しました');
        }
        loadFeedingSection();
      });
    }
    // confirm 直後に同期的に fetch すると一部 WebView で応答が返らないことがあるため defer
    setTimeout(function () { deleteAt(0); }, 0);
  };

  window.undoFed = function (logId) {
    window.undoFedMany(String(logId));
  };

  window.deletePlan = function (planId, mealSlot) {
    var slotJa = { morning: '朝', afternoon: '昼', evening: '夕', night: '夕', dinner: '夕' };
    var sj = mealSlot && slotJa[mealSlot] ? slotJa[mealSlot] : '';
    var msg = sj
      ? '🍽 ' + sj + 'の給餌プランを削除しますか？（取り消したい場合はプリセットの「適用」で再登録できます）'
      : 'この給餌プランを削除しますか？';
    if (!confirm(msg)) return;
    _setFeedingAreaBusy('プラン削除中です…');
    setTimeout(function () {
      _fetchDeleteJsonWithTimeout(API_BASE + '/feeding/plans/' + planId, 28000).then(function (data) {
        if (!data._httpOk || data.error) {
          alert('エラー: ' + (data.message || data.error || '削除に失敗しました'));
          loadFeedingSection();
          return;
        }
        loadFeedingSection();
      }).catch(function (e) {
        if (e && e._nyagiTimeout) {
          alert('削除の通信がタイムアウトしました。電波・ログインを確認し、再読み込みしてください。');
        } else {
          alert('削除に失敗しました');
        }
        loadFeedingSection();
      });
    }, 0);
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
      if (plan.food_id) setFoodSearchValue('apFoodId', plan.food_id);
      calcPlanKcal();
    });
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  var _editingPlanId = null;
  var _lastCalcData = null;

  var _addPlanMode = 'plan'; // 'plan' or 'preset'

  window.openAddPlanModal = function (defaultSlot) {
    _editingPlanId = null;
    _addPlanMode = 'plan';
    _pendingPresetId = null;
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 プランを追加';
    var slotSel = document.getElementById('apSlot');
    if (slotSel) slotSel.value = defaultSlot || 'morning';
    if (document.getElementById('apAmount')) document.getElementById('apAmount').value = '';
    if (document.getElementById('apTime')) document.getElementById('apTime').value = '';
    if (document.getElementById('apNotes')) document.getElementById('apNotes').value = '';
    if (document.getElementById('apKcalPreview')) document.getElementById('apKcalPreview').style.display = 'none';
    setFoodSearchValue('apFoodId', '');
    ensureFoodList(function () {});
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  window.closeAddPlanModal = function () {
    _editingPresetItemId = null;
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

    var notesPl = (notes != null && String(notes).trim() !== '') ? String(notes).trim() : null;
    var payload = { food_id: foodId, meal_slot: slot, amount_g: amountG, scheduled_time: time || null, notes: notesPl };

    if (_editingPlanId) {
      fetch(API_BASE + '/feeding/plans/' + _editingPlanId, {
        method: 'PUT', headers: apiHeaders(), cache: 'no-store', body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeAddPlanModal();
        loadFeedingSection();
      }).catch(function () { alert('更新に失敗しました'); });
    } else {
      payload.cat_id = catId;
      fetch(API_BASE + '/feeding/plans', {
        method: 'POST', headers: apiHeaders(), cache: 'no-store', body: JSON.stringify(payload)
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        closeAddPlanModal();
        loadFeedingSection();
      }).catch(function () { alert('追加に失敗しました'); });
    }
  };

  // プリセット適用（拠点フィルタ: cafe = BAKENEKO CAFE / nekomata = 猫又療養所）
  function _fillPresetApplyModal(loc) {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    var sp = (currentCatData && currentCatData.species) || 'cat';
    setStoredPresetLocation(loc);
    fetch(feedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var innerHtml = '<div class="modal-box" style="max-height:80vh;overflow-y:auto;">';
        innerHtml += '<div class="modal-title">📋 プリセットを適用</div>';
        innerHtml += '<div style="margin:0 0 10px;text-align:center;"><button type="button" class="btn btn-outline" style="font-size:12px;width:100%;max-width:100%;" onclick="openPresetManageModal()">⚙️ プリセット管理</button></div>';
        innerHtml += renderPresetLocationSwitcher(loc, 'apply');
        if (presets.length === 0) {
          innerHtml += '<div class="empty-msg">この拠点のプリセットがありません。タブを切り替えるか、「プリセット管理」で作成してください。</div>';
        } else {
          var lastAlphaApply = { v: null };
          for (var i = 0; i < presets.length; i++) {
            var ps = presets[i];
            innerHtml += feedingPresetAlphaSectionHtml(loc, ps, lastAlphaApply);
            innerHtml += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
            innerHtml += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">';
            innerHtml += '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px;">' + presetLocationBadgeHtml(ps.location_id) + '<b style="font-size:13px;">' + escapeHtml(ps.name) + '</b></div>';
            if (ps.description) innerHtml += '<div style="font-size:11px;color:var(--text-dim);margin-top:2px;line-height:1.4;white-space:pre-wrap;word-break:break-word;">' + escapeHtml(ps.description) + '</div>';
            innerHtml += _renderPresetItemsSummary(ps.items || [], ps.total_kcal, ps.id);
            innerHtml += '</div>';
            innerHtml += '<button class="btn btn-primary" style="font-size:11px;padding:4px 10px;width:auto;min-width:0;flex-shrink:0;align-self:center;" onclick="applyPreset(' + ps.id + ',null)" title="プリセット内の全フードを献立に追加">全て適用</button>';
            innerHtml += '</div></div>';
          }
        }
        innerHtml += '<div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div>';
        innerHtml += '</div>';
        modal.innerHTML = innerHtml;
      }).catch(function () { alert('プリセットの読み込みに失敗しました'); closePresetApplyModal(); });
  }

  window.openPresetApplyModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    var loc = effectivePresetLocationForApply();
    setStoredPresetLocation(loc);
    modal.innerHTML = '<div class="modal-box"><div class="modal-title">📋 プリセットを適用</div><div class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div></div>';
    modal.classList.add('open');
    _fillPresetApplyModal(loc);
  };

  window.switchFedPresetLocation = function (loc, ctx) {
    if (loc !== 'cafe' && loc !== 'nekomata') return;
    setStoredPresetLocation(loc);
    if (ctx === 'apply') _fillPresetApplyModal(loc);
    else if (ctx === 'manage') _fillPresetManageModal(loc);
    else if (ctx === 'assign') _fillPresetAssignModal(loc);
  };

  window.closePresetApplyModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (modal) modal.classList.remove('open');
  };

  function _fillPresetAssignModal(loc) {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    var sp = (currentCatData && currentCatData.species) || 'cat';
    setStoredPresetLocation(loc);
    fetch(feedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var currentId = currentCatData && currentCatData.assigned_preset_id;
        var innerHtml = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;">';
        innerHtml += '<div class="modal-title">🔗 プリセット紐づけ</div>';
        innerHtml += '<p style="font-size:12px;color:var(--text-dim);margin:0 0 10px;">業務終了時にこのプリセットが自動で再適用されます。</p>';
        innerHtml += renderPresetLocationSwitcher(loc, 'assign');

        innerHtml += '<div style="margin-bottom:8px;">';
        innerHtml += '<div class="preset-assign-item' + (!currentId ? ' active' : '') + '" onclick="assignPreset(null)" style="cursor:pointer;padding:10px 12px;border-radius:8px;margin-bottom:4px;background:' + (!currentId ? 'rgba(168,139,250,0.15)' : 'var(--surface)') + ';border:1px solid ' + (!currentId ? 'var(--primary,#a78bfa)' : 'var(--border,rgba(255,255,255,0.08))') + ';">';
        innerHtml += '<div style="font-size:13px;font-weight:600;color:var(--text-main);">紐づけ解除（なし）</div>';
        innerHtml += '</div>';

        var lastAlphaAssign = { v: null };
        for (var i = 0; i < presets.length; i++) {
          var ps = presets[i];
          innerHtml += feedingPresetAlphaSectionHtml(loc, ps, lastAlphaAssign);
          var isActive = currentId === ps.id;
          innerHtml += '<div class="preset-assign-item' + (isActive ? ' active' : '') + '" onclick="assignPreset(' + ps.id + ')" style="cursor:pointer;padding:10px 12px;border-radius:8px;margin-bottom:4px;background:' + (isActive ? 'rgba(168,139,250,0.15)' : 'var(--surface)') + ';border:1px solid ' + (isActive ? 'var(--primary,#a78bfa)' : 'var(--border,rgba(255,255,255,0.08))') + ';">';
          innerHtml += '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">';
          innerHtml += '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">' + presetLocationBadgeHtml(ps.location_id) + '<b style="font-size:13px;">' + escapeHtml(ps.name) + '</b></div>';
          if (isActive) innerHtml += '<span style="font-size:11px;color:var(--primary,#a78bfa);font-weight:600;">✔ 現在</span>';
          innerHtml += '</div>';
          innerHtml += _renderPresetItemsSummary(ps.items || [], ps.total_kcal);
          innerHtml += '</div>';
        }
        innerHtml += '</div>';
        innerHtml += '<div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div>';
        innerHtml += '</div>';
        modal.innerHTML = innerHtml;
      }).catch(function () { alert('プリセットの読み込みに失敗しました'); closePresetApplyModal(); });
  }

  window.openAssignPresetModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    var loc = effectivePresetLocationForApply();
    setStoredPresetLocation(loc);
    modal.innerHTML = '<div class="modal-box"><div class="modal-title">🔗 プリセット紐づけ</div><div class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div></div>';
    modal.classList.add('open');
    _fillPresetAssignModal(loc);
  };

  window.assignPreset = function (presetId) {
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ assigned_preset_id: presetId }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (currentCatData) {
        currentCatData.assigned_preset_id = presetId;
        currentCatData.assigned_preset_name = null;
      }
      closePresetApplyModal();
      loadFeedingSection();
      fetch(API_BASE + '/cats/' + encodeURIComponent(catId), { headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.cat) {
            currentCatData.assigned_preset_id = d.cat.assigned_preset_id;
            currentCatData.assigned_preset_name = d.cat.assigned_preset_name;
            currentCatData.assigned_preset_description = d.cat.assigned_preset_description;
            loadFeedingSection();
          }
        });
    }).catch(function () { alert('紐づけの保存に失敗しました'); });
  };

  window.applyPreset = function (presetId, presetItemId) {
    var oneOnly = presetItemId != null && presetItemId !== '' && String(presetItemId) !== 'null';
    var msg = oneOnly
      ? 'この1品だけ献立に追加しますか？'
      : 'プリセット内の全フードを献立に追加しますか？（紐づけプリセットも更新されます）';
    if (!confirm(msg)) return;
    var body = { cat_id: catId };
    if (oneOnly) body.preset_item_id = parseInt(presetItemId, 10);
    fetch(API_BASE + '/feeding/presets/' + presetId + '/apply', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store', body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      alert('プリセット「' + (data.preset_name || '') + '」を適用しました（' + (data.applied || []).length + '品追加）');
      closePresetApplyModal();
      if (oneOnly) {
        loadFeedingSection();
        return;
      }
      fetch(API_BASE + '/cats/' + encodeURIComponent(catId), { headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.cat && currentCatData) {
            currentCatData.assigned_preset_id = d.cat.assigned_preset_id;
            currentCatData.assigned_preset_name = d.cat.assigned_preset_name;
            currentCatData.assigned_preset_description = d.cat.assigned_preset_description;
          }
          loadFeedingSection();
        })
        .catch(function () { loadFeedingSection(); });
    }).catch(function () { alert('適用に失敗しました'); });
  };

  function _fillPresetManageModal(loc) {
    var area = document.getElementById('presetManageContent');
    var modal = document.getElementById('presetApplyModal');
    if (!area || !modal) return;
    var sp = (currentCatData && currentCatData.species) || 'cat';
    setStoredPresetLocation(loc);
    area.className = 'loading';
    area.style.padding = '16px';
    area.textContent = '読み込み中...';

    fetch(feedingPresetsListUrl(sp, loc), { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var presets = data.presets || [];
        var h = '';
        h += renderPresetLocationSwitcher(loc, 'manage');
        h += '<p style="font-size:11px;color:var(--text-dim);margin:0 0 10px;line-height:1.45;">上のタブで拠点を選んでから <b>+ 新規プリセット</b> を押すと、その拠点（<b>' + escapeHtml(presetLocShortLabel(loc)) + '</b>）用として登録されます。</p>';
        h += '<button class="btn btn-primary" style="font-size:12px;margin-bottom:12px;width:100%;" onclick="openCreatePresetModal()">+ 新規プリセット（' + escapeHtml(presetLocShortLabel(loc)) + '）</button>';
        if (presets.length === 0) {
          h += '<div class="empty-msg">この拠点のプリセットはまだありません。タブを切り替えると他拠点の一覧が表示されます。</div>';
        }
        var lastAlphaManage = { v: null };
        for (var i = 0; i < presets.length; i++) {
          var ps = presets[i];
          h += feedingPresetAlphaSectionHtml(loc, ps, lastAlphaManage);
          var ploc = ps.location_id === 'nekomata' ? 'nekomata' : 'cafe';
          h += '<div style="background:var(--surface);border-radius:8px;padding:10px 12px;margin-bottom:8px;">';
          h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">';
          h += '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:4px;">' + presetLocationBadgeHtml(ps.location_id) + '<b>' + escapeHtml(ps.name) + '</b></div>';
          h += '<div style="font-size:11px;color:var(--text-dim);">' + (ps.items || []).length + '品</div>';
          var psDescM = ps.description != null ? String(ps.description).trim() : '';
          h += '<div style="font-size:10px;color:var(--text-dim);margin:4px 0 0;line-height:1.35;white-space:pre-wrap;word-break:break-word;">';
          h += psDescM ? escapeHtml(psDescM.length > 140 ? psDescM.slice(0, 140) + '…' : psDescM) : '<span class="dim">全体メモなし</span>';
          h += '</div>';
          h += '<button type="button" class="btn btn-outline" style="font-size:10px;padding:3px 8px;margin-top:4px;" onclick="openEditPresetDescriptionModal(' + ps.id + ')">📋 全体メモを編集</button></div>';
          h += '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0;">';
          h += '<button type="button" class="btn-edit-small" style="font-size:10px;" onclick="cyclePresetLocation(' + ps.id + ',\'' + ploc + '\')" title="拠点を切替">🏷 拠点切替</button>';
          h += '<div><button class="btn-edit-small" onclick="renamePreset(' + ps.id + ',\'' + escapeHtml(ps.name).replace(/'/g, "\\'") + '\')" title="名前変更">📝</button> <button class="btn-edit-small" onclick="editPresetItems(' + ps.id + ')" title="中身編集">✏️</button> <button class="btn-edit-small" style="color:#f87171;" onclick="deletePreset(' + ps.id + ')" title="削除">🗑</button></div>';
          h += '</div></div></div></div>';
        }
        area.className = '';
        area.style.padding = '';
        area.innerHTML = h;
      }).catch(function () {
        area.className = '';
        area.style.padding = '';
        area.innerHTML = '<div class="empty-msg">読み込みに失敗しました</div>';
      });
  }

  // プリセット管理モーダル
  window.openPresetManageModal = function () {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    var loc = getStoredPresetLocation();
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">⚙️ プリセット管理</div><div id="presetManageContent" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="closePresetApplyModal()">閉じる</button></div></div>';
    modal.classList.add('open');
    _fillPresetManageModal(loc);
  };

  window.cyclePresetLocation = function (id, cur) {
    var next = cur === 'nekomata' ? 'cafe' : 'nekomata';
    var nextJa = next === 'nekomata' ? '猫又療養所' : 'BAKENEKO CAFE';
    if (!confirm('このプリセットの拠点を「' + nextJa + '」に変更しますか？')) return;
    fetch(API_BASE + '/feeding/presets/' + id, {
      method: 'PUT', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ location_id: next }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      _fillPresetManageModal(getStoredPresetLocation());
    }).catch(function () { alert('拠点の更新に失敗しました'); });
  };

  window.renamePreset = function (id, currentName) {
    var newName = prompt('新しいプリセット名を入力', currentName);
    if (!newName || newName === currentName) return;
    fetch(API_BASE + '/feeding/presets/' + id, {
      method: 'PUT', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ name: newName }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      _fillPresetManageModal(getStoredPresetLocation());
    }).catch(function () { alert('名前変更に失敗しました'); });
  };

  window.openEditPresetDescriptionModal = function (presetId) {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="loading" style="padding:24px;">読み込み中...</div></div>';
    fetch(API_BASE + '/feeding/presets/' + presetId, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error || !data.preset) {
          alert('読み込みに失敗しました');
          window.openPresetManageModal();
          return;
        }
        var cur = data.preset.description != null ? String(data.preset.description) : '';
        modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📋 プリセット全体メモ</div>' +
          '<div style="padding:12px 16px 16px;">' +
          '<p class="dim" style="font-size:11px;margin:0 0 8px;line-height:1.4;">献立カード等に表示されるプリセット単位のメモです。<b>改行で段落分け</b>できます。フード行ごとのメモは「中身編集」→ 各品の ✏️ から変更できます。</p>' +
          '<textarea id="presetDescTa" rows="6" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:var(--surface);color:inherit;font-size:13px;line-height:1.45;resize:vertical;"></textarea>' +
          '<div class="modal-actions" style="margin-top:12px;">' +
          '<button type="button" class="btn btn-primary" onclick="savePresetDescription(' + presetId + ')">保存</button> ' +
          '<button type="button" class="btn btn-outline" onclick="openPresetManageModal()">戻る</button>' +
          '</div></div></div>';
        var ta = document.getElementById('presetDescTa');
        if (ta) ta.value = cur;
      })
      .catch(function () {
        alert('読み込みに失敗しました');
        window.openPresetManageModal();
      });
  };

  window.savePresetDescription = function (presetId) {
    var ta = document.getElementById('presetDescTa');
    var v = ta ? String(ta.value).trim() : '';
    fetch(API_BASE + '/feeding/presets/' + presetId, {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ description: v === '' ? null : v }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        window.openPresetManageModal();
      }).catch(function () { alert('保存に失敗しました'); });
  };

  window.deletePreset = function (id) {
    if (!confirm('このプリセットを削除しますか？')) return;
    fetch(API_BASE + '/feeding/presets/' + id, { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        _fillPresetManageModal(getStoredPresetLocation());
      });
  };

  window.openCreatePresetModal = function () {
    var loc = getStoredPresetLocation();
    if (!confirm('拠点「' + presetLocShortLabel(loc) + '」用のプリセットを新規作成します。\n（別の拠点の場合は、一覧の上でタブを切り替えてから再度「+ 新規」を押してください）')) return;
    var name = prompt('プリセット名を入力してください（例: 腎臓ケアセット）');
    if (name == null) return;
    name = String(name).trim();
    if (!name) { alert('プリセット名を入力してください'); return; }
    _pendingCreatePreset = { name: name, loc: loc };
    showCreatePresetDescriptionModal();
  };

  window.editPresetItems = function (presetId) {
    var modal = document.getElementById('presetApplyModal');
    if (!modal) return;
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">📋 プリセット フード編集</div><div id="presetItemsContent" class="loading" style="padding:16px;">読み込み中...</div><div class="modal-actions"><button class="btn btn-outline" onclick="openPresetManageModal()">戻る</button></div></div>';
    modal.classList.add('open');

    fetch(API_BASE + '/feeding/presets/' + presetId + '/items', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var items = data.items || [];
        _presetItemsEditCache = { presetId: presetId, items: items };
        var area = document.getElementById('presetItemsContent');
        if (!area) return;

        var morningItems = [];
        var eveningItems = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].meal_slot === 'evening') { eveningItems.push(items[i]); }
          else { morningItems.push(items[i]); }
        }

        var h = '';
        h += _renderPresetSlotGroup('☀️ 朝ごはん', 'morning', morningItems, presetId);
        h += _renderPresetSlotGroup('🌙 夕ごはん', 'evening', eveningItems, presetId);
        area.className = '';
        area.innerHTML = h;
      });
  };

  function _renderPresetSlotGroup(title, slot, items, presetId) {
    var totalKcal = 0;
    for (var k = 0; k < items.length; k++) {
      totalKcal += (items[k].amount_g || 0) * (items[k].kcal_per_100g || 0) / 100;
    }
    var h = '<div style="margin-bottom:14px;">';
    h += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">';
    h += '<div style="font-size:13px;font-weight:700;color:var(--text-main);">' + title + '</div>';
    if (totalKcal > 0) h += '<span style="font-size:11px;color:var(--accent,#fb923c);">' + Math.round(totalKcal) + ' kcal</span>';
    h += '</div>';
    if (items.length === 0) {
      h += '<div style="font-size:12px;color:var(--text-dim);padding:8px 0;">未登録</div>';
    } else {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        var kcal = Math.round((it.amount_g || 0) * (it.kcal_per_100g || 0) / 100);
        h += '<div style="padding:6px 8px;background:var(--surface);border-radius:6px;margin-bottom:4px;">';
        h += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:6px;">';
        h += '<div style="flex:1;min-width:0;font-size:12px;">' + escapeHtml(it.food_name || '') + ' <b>' + it.amount_g + 'g</b>';
        if (kcal) h += ' <span style="color:var(--text-dim);font-size:11px;">(' + kcal + 'kcal)</span>';
        if (it.scheduled_time) h += ' <span style="color:var(--text-dim);font-size:10px;">⏰' + escapeHtml(it.scheduled_time) + '</span>';
        if (it.notes && String(it.notes).trim()) {
          h += '<div style="font-size:10px;color:var(--text-dim);margin-top:4px;line-height:1.35;white-space:pre-wrap;word-break:break-word;">📝 ' + escapeHtml(String(it.notes).trim()) + '</div>';
        }
        h += '</div>';
        h += '<div style="display:flex;gap:2px;flex-shrink:0;">';
        h += '<button type="button" class="btn-edit-small" style="font-size:11px;" onclick="openEditPresetItem(' + presetId + ',' + it.id + ')" title="量・メモなどを変更">✏️</button>';
        h += '<button type="button" class="btn-edit-small" style="color:#f87171;font-size:11px;" onclick="deletePresetItem(' + presetId + ',' + it.id + ')">🗑</button>';
        h += '</div></div></div>';
      }
    }
    h += '<button class="btn btn-outline" style="font-size:11px;margin-top:4px;padding:4px 10px;" onclick="addPresetItemForSlot(' + presetId + ',\'' + slot + '\')">+ 追加</button>';
    h += '</div>';
    return h;
  }

  window.deletePresetItem = function (presetId, itemId) {
    fetch(API_BASE + '/feeding/presets/' + presetId + '/items/' + itemId, { method: 'DELETE', headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function () { editPresetItems(presetId); });
  };

  window.addPresetItemPrompt = function (presetId) {
    addPresetItemForSlot(presetId, 'morning');
  };

  var _editingPresetItemId = null;
  var _presetItemsEditCache = null;

  window.openEditPresetItem = function (presetId, itemId) {
    var it = null;
    if (_presetItemsEditCache && _presetItemsEditCache.presetId === presetId && _presetItemsEditCache.items) {
      for (var i = 0; i < _presetItemsEditCache.items.length; i++) {
        if (_presetItemsEditCache.items[i].id === itemId) { it = _presetItemsEditCache.items[i]; break; }
      }
    }
    if (!it) { alert('データが見つかりません。プリセット一覧を開き直してください。'); return; }
    _pendingPresetId = presetId;
    _editingPresetItemId = itemId;
    _addPlanMode = 'preset';
    var presetModal = document.getElementById('presetApplyModal');
    if (presetModal) presetModal.classList.remove('open');

    _editingPlanId = null;
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '📋 プリセット項目を編集';
    if (document.getElementById('apSlot')) document.getElementById('apSlot').value = it.meal_slot || 'morning';
    if (document.getElementById('apAmount')) document.getElementById('apAmount').value = it.amount_g != null ? String(it.amount_g) : '';
    if (document.getElementById('apTime')) document.getElementById('apTime').value = it.scheduled_time ? String(it.scheduled_time).slice(0, 5) : '';
    if (document.getElementById('apNotes')) document.getElementById('apNotes').value = it.notes || '';
    if (document.getElementById('apKcalPreview')) document.getElementById('apKcalPreview').style.display = 'none';
    ensureFoodList(function () {
      if (it.food_id) setFoodSearchValue('apFoodId', it.food_id);
      calcPlanKcal();
    });
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  window.addPresetItemForSlot = function (presetId, slot) {
    _pendingPresetId = presetId;
    _editingPresetItemId = null;
    _addPlanMode = 'preset';
    var presetModal = document.getElementById('presetApplyModal');
    if (presetModal) presetModal.classList.remove('open');

    _editingPlanId = null;
    var titleEl = document.querySelector('#addPlanModal .modal-title');
    if (titleEl) titleEl.textContent = '📋 プリセットに追加（' + slotLabelShort(slot) + '）';
    if (document.getElementById('apSlot')) document.getElementById('apSlot').value = slot;
    if (document.getElementById('apAmount')) document.getElementById('apAmount').value = '';
    if (document.getElementById('apTime')) document.getElementById('apTime').value = '';
    if (document.getElementById('apNotes')) document.getElementById('apNotes').value = '';
    if (document.getElementById('apKcalPreview')) document.getElementById('apKcalPreview').style.display = 'none';
    setFoodSearchValue('apFoodId', '');
    ensureFoodList(function () {});
    var modal = document.getElementById('addPlanModal');
    if (modal) modal.classList.add('open');
  };

  var _pendingPresetId = null;
  var _pendingCreatePreset = null;

  function showCreatePresetDescriptionModal() {
    var modal = document.getElementById('presetApplyModal');
    if (!modal || !_pendingCreatePreset) return;
    var nm = _pendingCreatePreset.name;
    modal.classList.add('open');
    modal.innerHTML = '<div class="modal-box" style="max-height:85vh;overflow-y:auto;"><div class="modal-title">新規プリセット — 全体メモ <span class="dim">' + escapeHtml(nm) + '</span></div>' +
      '<div style="padding:12px 16px;"><p class="dim" style="font-size:11px;margin:0 0 8px;line-height:1.4;">改行で段落分けできます。空欄のままでも作成できます。</p>' +
      '<textarea id="cdNewPresetDescTa" rows="5" style="width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid rgba(255,255,255,0.12);background:var(--surface);color:inherit;font-size:13px;line-height:1.45;resize:vertical;"></textarea>' +
      '<div class="modal-actions" style="margin-top:12px;">' +
      '<button type="button" class="btn btn-primary" onclick="submitCreatePresetWithDescription()">作成</button> ' +
      '<button type="button" class="btn btn-outline" onclick="cancelCreatePresetDescription()">キャンセル</button>' +
      '</div></div></div>';
  }

  window.cancelCreatePresetDescription = function () {
    _pendingCreatePreset = null;
    window.openPresetManageModal();
  };

  window.submitCreatePresetWithDescription = function () {
    if (!_pendingCreatePreset) return;
    var ta = document.getElementById('cdNewPresetDescTa');
    var raw = ta ? String(ta.value) : '';
    var desc = raw.trim() === '' ? null : raw.trim();
    var loc = _pendingCreatePreset.loc;
    var name = _pendingCreatePreset.name;
    var sp = (currentCatData && currentCatData.species) || 'cat';
    _pendingCreatePreset = null;
    fetch(API_BASE + '/feeding/presets', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({
        name: name,
        description: desc,
        location_id: loc,
        species: sp,
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
      if (!data.preset || data.preset.id == null) {
        alert('エラー: プリセット情報が返りませんでした');
        return;
      }
      window.editPresetItems(data.preset.id);
    }).catch(function (e) {
      alert('作成に失敗しました: ' + (e && e.message ? e.message : 'network'));
    });
  };

  window.submitAddPlan = function () {
    if (_addPlanMode === 'preset') {
      _doSubmitPresetItem();
    } else {
      submitPlan();
    }
  };

  function _doSubmitPresetItem() {
    var foodId = document.getElementById('apFoodId') ? document.getElementById('apFoodId').value : '';
    var slot = document.getElementById('apSlot') ? document.getElementById('apSlot').value : 'morning';
    var amountG = document.getElementById('apAmount') ? parseFloat(document.getElementById('apAmount').value) : 0;
    var time = document.getElementById('apTime') ? document.getElementById('apTime').value : '';
    if (!foodId || !amountG) { alert('フードと量は必須です'); return; }
    if (!_pendingPresetId) { alert('プリセットが選択されていません'); return; }
    var presetNotes = document.getElementById('apNotes') ? document.getElementById('apNotes').value : '';
    var notesTrim = presetNotes != null && String(presetNotes).trim() !== '' ? String(presetNotes).trim() : null;
    var payload = { food_id: foodId, meal_slot: slot, amount_g: amountG, scheduled_time: time || null, notes: notesTrim };
    var url = API_BASE + '/feeding/presets/' + _pendingPresetId + '/items';
    var method = 'POST';
    var savingEdit = !!_editingPresetItemId;
    if (_editingPresetItemId) {
      url = API_BASE + '/feeding/presets/' + _pendingPresetId + '/items/' + _editingPresetItemId;
      method = 'PUT';
    }
    fetch(url, {
      method: method, headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      closeAddPlanModal();
      var presetModal = document.getElementById('presetApplyModal');
      if (presetModal) presetModal.classList.add('open');
      editPresetItems(_pendingPresetId);
    }).catch(function () { alert(savingEdit ? '更新に失敗しました' : '追加に失敗しました'); });
  }

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
        var vPayload = { text: text, context: 'feeding' };
        try { var fl = localStorage.getItem('nyagi_dash_location'); if (fl && fl !== 'all') vPayload.filter_location = fl; } catch (_) {}
        try { var fs = localStorage.getItem('nyagi_dash_status'); if (fs && fs !== 'all') vPayload.filter_status = fs; } catch (_) {}
        fetch(API_BASE.replace('/ops', '/ops') + '/voice/submit', {
          method: 'POST', headers: apiHeaders(), cache: 'no-store',
          body: JSON.stringify(vPayload)
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
    fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders(), cache: 'no-store' })
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
      headers: apiHeaders(), cache: 'no-store',
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
    if (document.getElementById('flDate')) document.getElementById('flDate').value = log.log_date || todayJstYmd();
    if (document.getElementById('flSlot')) document.getElementById('flSlot').value = log.meal_slot || 'morning';
    if (document.getElementById('flOfferedG')) document.getElementById('flOfferedG').value = log.offered_g != null ? log.offered_g : '';
    if (document.getElementById('flEatenPct')) document.getElementById('flEatenPct').value = log.eaten_pct != null ? log.eaten_pct : '';
    if (document.getElementById('flNote')) document.getElementById('flNote').value = log.note || '';
    var flSt = document.getElementById('flServedTime');
    if (flSt) {
      var stEd = cdFmtFedServedTime(log.served_time);
      flSt.value = stEd || nowJstHm();
    }
    document.getElementById('flKcalPreview').style.display = 'none';
    document.getElementById('flFoodInfo').textContent = log.food_name ? log.food_name : '';
    var sel = document.getElementById('flFoodId');
    if (sel && _feedFoodsList.length === 0) {
      var sp = (currentCatData && currentCatData.species) || 'cat';
      fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          _feedFoodsList = data.foods || [];
          populateFoodSelect(sel, _feedFoodsList);
          if (log.food_id) setFoodSearchValue('flFoodId', log.food_id);
          if (document.getElementById('feedingLogModal')) document.getElementById('feedingLogModal').classList.add('open');
        });
    } else {
      if (sel && _feedFoodsList.length > 0) {
        populateFoodSelect(sel, _feedFoodsList);
        if (log.food_id) setFoodSearchValue('flFoodId', log.food_id);
      }
      if (document.getElementById('feedingLogModal')) document.getElementById('feedingLogModal').classList.add('open');
    }
  };

  function lifeStageLabel(stage, species) {
    var sp = species || 'cat';
    if (sp === 'dog') {
      var dogLabels = { adult: '成犬', puppy: '子犬', senior: 'シニア犬' };
      return dogLabels[stage] || (stage || '成犬');
    }
    var labels = { adult: '成猫', kitten: '子猫', senior: 'シニア', diet: 'ダイエット', puppy: '子犬' };
    return labels[stage] || (stage || '成猫');
  }

  function slotLabel(slot) {
    var labels = { morning: '☀️ 朝', afternoon: '☀️ 昼', evening: '🌙 夕' };
    return labels[slot] || slot;
  }
  function slotLabelShort(slot) {
    var labels = { morning: '朝', afternoon: '昼', evening: '夕' };
    return labels[slot] || slot;
  }

  function _renderPresetItemsSummary(items, totalKcal, presetIdForOneApply) {
    var morn = [];
    var eve = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].meal_slot === 'evening') { eve.push(items[i]); }
      else { morn.push(items[i]); }
    }
    function rowHtml(it) {
      var line = '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:6px;padding:2px 0 2px 8px;">';
      line += '<div style="min-width:0;flex:1;font-size:11px;color:var(--text-dim);">' + escapeHtml(it.food_name || '') + ' ' + it.amount_g + 'g';
      if (it.notes && String(it.notes).trim()) {
        line += '<span style="display:block;font-size:10px;color:var(--text-dim);opacity:0.9;margin-top:2px;">📝 ' + escapeHtml(String(it.notes).trim()) + '</span>';
      }
      line += '</div>';
      if (presetIdForOneApply && it.id != null) {
        line += '<button type="button" class="btn btn-outline" style="font-size:9px;padding:2px 8px;flex-shrink:0;white-space:nowrap;" onclick="applyPreset(' + presetIdForOneApply + ',' + it.id + ')" title="この1品だけ献立に追加">1品</button>';
      }
      line += '</div>';
      return line;
    }
    var h = '<div style="margin-top:4px;">';
    if (morn.length > 0) {
      h += '<div style="font-size:10px;color:var(--accent,#fb923c);font-weight:600;margin-top:2px;">☀️ 朝</div>';
      for (var m = 0; m < morn.length; m++) h += rowHtml(morn[m]);
    }
    if (eve.length > 0) {
      h += '<div style="font-size:10px;color:var(--accent,#fb923c);font-weight:600;margin-top:2px;">🌙 夕</div>';
      for (var e = 0; e < eve.length; e++) h += rowHtml(eve[e]);
    }
    if (items.length === 0) {
      h += '<div style="font-size:11px;color:var(--text-dim);">未登録</div>';
    }
    if (totalKcal) h += '<div style="font-size:11px;color:var(--accent,#fb923c);margin-top:2px;">計 ' + totalKcal + ' kcal</div>';
    h += '</div>';
    return h;
  }

  // 給餌ログ記録モーダル
  var _feedFoodsList = [];
  var _feedingLogsCache = [];
  var _editingLogId = null;

  window.openFeedingLogModal = function () {
    _editingLogId = null;
    var titleEl = document.querySelector('#feedingLogModal .modal-title');
    if (titleEl) titleEl.textContent = '🍽 給餌ログを記録';
    var today = todayJstYmd();
    if (document.getElementById('flDate')) document.getElementById('flDate').value = today;
    document.getElementById('flKcalPreview').style.display = 'none';
    document.getElementById('flFoodInfo').textContent = '';
    document.getElementById('flOfferedG').value = '';
    document.getElementById('flEatenPct').value = '';
    document.getElementById('flNote').value = '';
    if (document.getElementById('flServedTime')) document.getElementById('flServedTime').value = nowJstHm();

    setFoodSearchValue('flFoodId', '');
    var sel = document.getElementById('flFoodId');
    if (sel && _feedFoodsList.length === 0) {
      var sp = (currentCatData && currentCatData.species) || 'cat';
      fetch(API_BASE + '/feeding/foods?species=' + sp, { headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          _feedFoodsList = data.foods || [];
          populateFoodSelect(sel, _feedFoodsList);
        });
    }

    if (document.getElementById('feedingLogModal')) {
      document.getElementById('feedingLogModal').classList.add('open');
    }
  };

  var _typeLabels = { therapeutic: '🏥 療法食', complete: '🍚 総合栄養食', general: '🥫 一般食', supplement: '🥫 一般食(補助)', treat: '🍬 おやつ' };
  var _typeOrder = ['therapeutic', 'complete', 'general', 'supplement', 'treat'];

  var _touchStartY = null;
  var _TAP_THRESHOLD = 10;

  function _addTapHandler(el, handler) {
    el.addEventListener('mousedown', function (e) { e.preventDefault(); handler(); });
    el.addEventListener('touchstart', function (e) { _touchStartY = e.touches[0].clientY; }, { passive: true });
    el.addEventListener('touchend', function (e) {
      if (_touchStartY !== null && e.changedTouches && e.changedTouches.length > 0) {
        var dy = Math.abs(e.changedTouches[0].clientY - _touchStartY);
        if (dy < _TAP_THRESHOLD) { e.preventDefault(); handler(); }
      }
      _touchStartY = null;
    });
  }

  function _formTag(f) {
    return f === 'dry' ? '(ﾄﾞﾗｲ)' : f === 'wet' ? '(ｳｪｯﾄ)' : f === 'liquid' ? '(液状)' : '';
  }

  function _foodDisplayName(food) {
    return food.name + ' ' + _formTag(food.form);
  }

  function _matchesQuery(food, words) {
    var haystack = ((food.name || '') + ' ' + (food.brand || '') + ' ' + (food.flavor || '') + ' ' + (food.form || '')).toLowerCase();
    for (var w = 0; w < words.length; w++) {
      if (haystack.indexOf(words[w]) === -1) return false;
    }
    return true;
  }

  function _renderFoodDropdown(dropdownEl, foods, query, onSelect) {
    dropdownEl.innerHTML = '';
    var words = query.toLowerCase().replace(/[\u3000]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 0; });
    var groups = {};
    var totalCount = 0;
    var maxItems = words.length > 0 ? 50 : 20;
    for (var i = 0; i < foods.length; i++) {
      if (totalCount >= maxItems) break;
      if (words.length > 0 && !_matchesQuery(foods[i], words)) continue;
      var ft = foods[i].food_type || 'complete';
      if (!groups[ft]) groups[ft] = [];
      groups[ft].push(foods[i]);
      totalCount++;
    }
    var hasAny = false;
    for (var oi = 0; oi < _typeOrder.length; oi++) {
      var key = _typeOrder[oi];
      if (!groups[key] || groups[key].length === 0) continue;
      hasAny = true;
      var lbl = document.createElement('div');
      lbl.className = 'food-search-group-label';
      lbl.textContent = _typeLabels[key] || key;
      dropdownEl.appendChild(lbl);
      for (var gi = 0; gi < groups[key].length; gi++) {
        var f = groups[key][gi];
        var item = document.createElement('div');
        item.className = 'food-search-item';
        item.setAttribute('data-food-id', f.id);
        var nameSpan = document.createElement('span');
        nameSpan.textContent = _foodDisplayName(f);
        item.appendChild(nameSpan);
        if (f.kcal_per_100g) {
          var kcalSpan = document.createElement('span');
          kcalSpan.className = 'food-search-item-kcal';
          kcalSpan.textContent = f.kcal_per_100g + ' kcal/100g';
          item.appendChild(kcalSpan);
        }
        (function (foodObj) {
          _addTapHandler(item, function () { onSelect(foodObj); });
        })(f);
        dropdownEl.appendChild(item);
      }
    }
    if (!hasAny && words.length > 0) {
      var empty = document.createElement('div');
      empty.className = 'food-search-empty';
      empty.textContent = '「' + query + '」に一致するフードなし';
      dropdownEl.appendChild(empty);

      var webBtn = document.createElement('div');
      webBtn.className = 'food-search-item';
      webBtn.style.cssText = 'color:#60a5fa;font-weight:600;justify-content:center;gap:6px;border-top:1px solid rgba(255,255,255,0.08);margin-top:4px;padding-top:10px;';
      webBtn.textContent = '🔍 「' + query + '」をWeb検索して登録';
      (function (q, dd, sel) {
        _addTapHandler(webBtn, function () { _webSearchAndRegister(q, dd, sel); });
      })(query, dropdownEl, onSelect);
      dropdownEl.appendChild(webBtn);
    } else if (!hasAny) {
      var emptyMsg = document.createElement('div');
      emptyMsg.className = 'food-search-empty';
      emptyMsg.textContent = 'フードが登録されていません';
      dropdownEl.appendChild(emptyMsg);
    } else if (words.length === 0 && totalCount >= maxItems) {
      var hint = document.createElement('div');
      hint.className = 'food-search-empty';
      hint.textContent = '…他にもあります。キーワードで絞り込んでください';
      dropdownEl.appendChild(hint);
    }
    if (hasAny && words.length >= 2) {
      var webBtnExtra = document.createElement('div');
      webBtnExtra.className = 'food-search-item';
      webBtnExtra.style.cssText = 'color:#60a5fa;font-size:12px;justify-content:center;gap:4px;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px;padding-top:8px;';
      webBtnExtra.textContent = '🔍 「' + query + '」をWeb検索';
      (function (q, dd, sel) {
        _addTapHandler(webBtnExtra, function () { _webSearchAndRegister(q, dd, sel); });
      })(query, dropdownEl, onSelect);
      dropdownEl.appendChild(webBtnExtra);
    }
  }

  var _webSearching = false;

  function _webSearchAndRegister(query, dropdownEl, onSelectCb) {
    if (_webSearching) return;
    _webSearching = true;
    dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#60a5fa;">🔍 「' + escapeHtml(query) + '」を検索中...</div>';

    var sp = (currentCatData && currentCatData.species) || 'cat';
    fetch(API_BASE + '/feeding/foods/search', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ query: query, species: sp })
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      _webSearching = false;
      dropdownEl.innerHTML = '';

      if (data.status === 'ok' && data.extracted && (data.extracted.name || data.extracted.kcal_per_100g)) {
        _showWebFoodResult(dropdownEl, data.extracted, data.url, data.candidates || [], onSelectCb);
      } else if (data.candidates && data.candidates.length > 0) {
        _showWebCandidates(dropdownEl, data.candidates, onSelectCb);
      } else {
        var noResult = document.createElement('div');
        noResult.className = 'food-search-empty';
        noResult.textContent = 'Web検索結果なし — フードDBページからURL直接入力してください';
        dropdownEl.appendChild(noResult);
      }
    }).catch(function () {
      _webSearching = false;
      dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#f87171;">検索に失敗しました</div>';
    });
  }

  function _showWebFoodResult(dropdownEl, extracted, url, candidates, onSelectCb) {
    var lbl = document.createElement('div');
    lbl.className = 'food-search-group-label';
    lbl.textContent = '🌐 Web検索結果';
    dropdownEl.appendChild(lbl);

    var mainItem = document.createElement('div');
    mainItem.className = 'food-search-item';
    mainItem.style.cssText = 'flex-direction:column;align-items:flex-start;padding:10px;background:rgba(96,165,250,0.08);border-radius:6px;margin:4px 6px;';
    var nameText = (extracted.brand ? extracted.brand + ' ' : '') + (extracted.name || '不明');
    mainItem.innerHTML = '<div style="font-weight:600;font-size:13px;">' + escapeHtml(nameText) + '</div>'
      + (extracted.kcal_per_100g ? '<div style="font-size:11px;color:var(--accent);">' + extracted.kcal_per_100g + ' kcal/100g</div>' : '')
      + (extracted.category ? '<div style="font-size:10px;color:var(--text-dim);">' + escapeHtml(extracted.category) + '</div>' : '')
      + '<div style="font-size:11px;color:#4ade80;font-weight:600;margin-top:4px;">↑ タップでDB登録＆選択</div>';

    (function (ext, u) {
      _addTapHandler(mainItem, function () { _registerAndSelect(ext, u, dropdownEl, onSelectCb); });
    })(extracted, url);
    dropdownEl.appendChild(mainItem);

    if (candidates.length > 1) {
      var altLbl = document.createElement('div');
      altLbl.className = 'food-search-group-label';
      altLbl.textContent = '他の候補（タップでスクレイプ）';
      dropdownEl.appendChild(altLbl);
      for (var ci = 1; ci < Math.min(candidates.length, 4); ci++) {
        _appendCandidateItem(dropdownEl, candidates[ci], onSelectCb);
      }
    }
  }

  function _showWebCandidates(dropdownEl, candidates, onSelectCb) {
    var lbl = document.createElement('div');
    lbl.className = 'food-search-group-label';
    lbl.textContent = '🌐 候補（タップでデータ取得＆登録）';
    dropdownEl.appendChild(lbl);
    for (var ci = 0; ci < Math.min(candidates.length, 5); ci++) {
      _appendCandidateItem(dropdownEl, candidates[ci], onSelectCb);
    }
  }

  function _appendCandidateItem(dropdownEl, candidate, onSelectCb) {
    var cItem = document.createElement('div');
    cItem.className = 'food-search-item';
    cItem.style.cssText = 'font-size:12px;';
    var domain = '';
    try { domain = new URL(candidate.url).hostname.replace('www.', ''); } catch (_) {}
    cItem.innerHTML = '<span>' + escapeHtml(candidate.title || candidate.url) + '</span><span style="font-size:10px;color:var(--text-dim);">' + escapeHtml(domain) + '</span>';
    (function (c) {
      _addTapHandler(cItem, function () { _scrapeAndRegister(c.url, dropdownEl, onSelectCb); });
    })(candidate);
    dropdownEl.appendChild(cItem);
  }

  function _scrapeAndRegister(url, dropdownEl, onSelectCb) {
    dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#60a5fa;">📥 データ取得中...</div>';
    fetch(API_BASE + '/feeding/foods/scrape', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ url: url })
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.status === 'ok' && data.extracted && (data.extracted.name || data.extracted.kcal_per_100g)) {
        _registerAndSelect(data.extracted, url, dropdownEl, onSelectCb);
      } else {
        dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#fb923c;">データ抽出失敗 — フードDBページからURL入力してください</div>';
      }
    }).catch(function () {
      dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#f87171;">取得に失敗しました</div>';
    });
  }

  function _registerAndSelect(extracted, url, dropdownEl, onSelectCb) {
    if (!extracted.name) { alert('製品名が取得できませんでした'); return; }
    if (!extracted.kcal_per_100g) {
      var kcalInput = prompt('カロリー（kcal/100g）を入力してください\n製品名: ' + extracted.name, '');
      if (!kcalInput) return;
      extracted.kcal_per_100g = parseFloat(kcalInput);
      if (isNaN(extracted.kcal_per_100g) || extracted.kcal_per_100g <= 0) { alert('有効なカロリー値を入力してください'); return; }
    }

    dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#4ade80;">📝 フードDB登録中...</div>';

    var body = {
      brand: extracted.brand || null,
      name: extracted.name,
      category: extracted.category || '総合栄養食',
      food_type: extracted.category === '療法食' ? 'therapeutic' : 'complete',
      form: extracted.form || 'dry',
      species: (currentCatData && currentCatData.species) || 'cat',
      kcal_per_100g: extracted.kcal_per_100g,
      protein_pct: extracted.protein_pct || null,
      fat_pct: extracted.fat_pct || null,
      fiber_pct: extracted.fiber_pct || null,
      water_pct: extracted.water_pct || null,
      product_url: url || null,
    };

    fetch(API_BASE + '/feeding/foods/import', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(body)
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      var food = null;
      if (data.status === 'created' && data.food) {
        food = data.food;
      } else if (data.status === 'duplicate' && data.existing) {
        food = data.existing;
      }
      if (food) {
        _feedFoodsList.push(food);
        var sel = document.getElementById('apFoodId');
        if (sel) {
          var opt = document.createElement('option');
          opt.value = food.id;
          opt.textContent = _foodDisplayName(food);
          sel.appendChild(opt);
        }
        onSelectCb(food);
      } else {
        dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#f87171;">登録に失敗: ' + escapeHtml(data.message || data.error || '') + '</div>';
      }
    }).catch(function () {
      dropdownEl.innerHTML = '<div class="food-search-empty" style="color:#f87171;">登録に失敗しました</div>';
    });
  }

  function _initFoodSearch(selectId, wrapId, searchId, clearId, dropdownId, onChangeCallback) {
    var sel = document.getElementById(selectId);
    var wrap = document.getElementById(wrapId);
    var input = document.getElementById(searchId);
    var clearBtn = document.getElementById(clearId);
    var dropdown = document.getElementById(dropdownId);
    if (!sel || !wrap || !input || !dropdown) return;

    var selectFood = function (food) {
      sel.value = food.id;
      input.value = _foodDisplayName(food);
      wrap.classList.add('has-value');
      wrap.classList.remove('open');
      if (onChangeCallback) onChangeCallback();
    };

    input.addEventListener('input', function () {
      var q = input.value.trim();
      if (sel.value && q !== _foodDisplayName(_findFood(sel.value))) {
        sel.value = '';
        wrap.classList.remove('has-value');
        if (onChangeCallback) onChangeCallback();
      }
      _renderFoodDropdown(dropdown, _feedFoodsList, q, selectFood);
      wrap.classList.add('open');
    });

    input.addEventListener('focus', function () {
      _renderFoodDropdown(dropdown, _feedFoodsList, input.value.trim(), selectFood);
      wrap.classList.add('open');
    });

    clearBtn.addEventListener('click', function () {
      sel.value = '';
      input.value = '';
      wrap.classList.remove('has-value');
      wrap.classList.remove('open');
      if (onChangeCallback) onChangeCallback();
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(e.target)) {
        wrap.classList.remove('open');
      }
    });
  }

  function _findFood(foodId) {
    for (var i = 0; i < _feedFoodsList.length; i++) {
      if (_feedFoodsList[i].id === foodId) return _feedFoodsList[i];
    }
    return null;
  }

  function setFoodSearchValue(selectId, foodId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    sel.value = foodId || '';
    var wrapId = selectId === 'apFoodId' ? 'apFoodSearchWrap' : 'flFoodSearchWrap';
    var searchId = selectId === 'apFoodId' ? 'apFoodSearch' : 'flFoodSearch';
    var wrap = document.getElementById(wrapId);
    var input = document.getElementById(searchId);
    if (!input) return;
    if (foodId) {
      var food = _findFood(foodId);
      if (food) {
        input.value = _foodDisplayName(food);
        if (wrap) wrap.classList.add('has-value');
        return;
      }
    }
    input.value = '';
    if (wrap) wrap.classList.remove('has-value');
  }

  var _foodSearchInited = {};
  function populateFoodSelect(sel, foods) {
    sel.innerHTML = '<option value="">-- 選択 --</option>';
    for (var i = 0; i < foods.length; i++) {
      var opt = document.createElement('option');
      opt.value = foods[i].id;
      opt.textContent = _foodDisplayName(foods[i]);
      sel.appendChild(opt);
    }
    if (sel.id === 'apFoodId' && !_foodSearchInited['ap']) {
      _foodSearchInited['ap'] = true;
      _initFoodSearch('apFoodId', 'apFoodSearchWrap', 'apFoodSearch', 'apFoodClear', 'apFoodDropdown', function () { calcPlanKcal(); });
    }
    if (sel.id === 'flFoodId' && !_foodSearchInited['fl']) {
      _foodSearchInited['fl'] = true;
      _initFoodSearch('flFoodId', 'flFoodSearchWrap', 'flFoodSearch', 'flFoodClear', 'flFoodDropdown', function () { onFoodSelect(); });
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

    var flStEl = document.getElementById('flServedTime');
    var servedTime = flStEl && flStEl.value ? String(flStEl.value).trim() : '';
    if (!servedTime) servedTime = nowJstHm();

    var body = {
      meal_slot: mealSlot,
      food_id: foodId || null,
      offered_g: offeredG ? parseFloat(offeredG) : null,
      eaten_pct: eatenPct !== '' ? parseInt(eatenPct, 10) : null,
      kcal: kcalCalc,
      note: note || null,
      served_time: servedTime,
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
      headers: apiHeaders(), cache: 'no-store',
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
      headers: apiHeaders(), cache: 'no-store',
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

  /** 病院記録添付の上限（API health.js の HEALTH_RECORD_MAX_FILE_BYTES と揃える） */
  var CLINIC_RECORD_FILE_MAX_BYTES = 10 * 1024 * 1024;

  var _clearScheduleId = null;

  var _clinicPendingFiles = [];

  function renderCrExistingFilesInModal(recordId, attachments) {
    var wrap = document.getElementById('crExistingFilesWrap');
    if (!wrap) return;
    var att = attachments || [];
    if (att.length === 0) {
      wrap.style.display = 'none';
      wrap.innerHTML = '';
      return;
    }
    wrap.style.display = 'block';
    var h = '<div style="color:var(--text-dim);margin-bottom:6px;font-weight:600;">現在の添付（' + att.length + '件）</div>';
    for (var i = 0; i < att.length; i++) {
      var af = att[i];
      h += '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0;padding:6px;background:rgba(0,0,0,0.2);border-radius:6px;">';
      h += '<span style="flex:1;min-width:0;word-break:break-all;font-size:12px;">' + escapeHtml(af.original_name || ('file-' + af.id)) + '</span>';
      h += '<button type="button" class="btn-edit-loc" style="font-size:11px;" onclick="openClinicRecordFile(' + recordId + ',' + af.id + ')">開く</button>';
      h += '<button type="button" class="btn-edit-loc" style="font-size:11px;color:#f87171;" onclick="deleteClinicRecordAttachment(' + recordId + ',' + af.id + ')">削除</button>';
      h += '</div>';
    }
    wrap.innerHTML = h;
  }

  window.openClinicRecordModal = function (prefillType, prefillDate, linkedScheduleRecordId, prefillNote) {
    _clearScheduleId = null;
    _clinicPendingFiles = [];
    var crEdit = document.getElementById('crEditId');
    if (crEdit) crEdit.value = '';
    var fromSchedule = linkedScheduleRecordId != null && String(linkedScheduleRecordId).trim() !== '';
    var crTitle = document.getElementById('crModalTitle');
    if (crTitle) crTitle.textContent = fromSchedule ? '🏥 予定から病院記録を作成' : '🏥 病院記録を追加';
    var crHint = document.getElementById('crExistingFileHint');
    if (crHint) { crHint.style.display = 'none'; crHint.textContent = ''; }
    renderCrExistingFilesInModal(0, []);
    var today = new Date().toISOString().slice(0, 10);
    document.getElementById('crDate').value = prefillDate || today;
    document.getElementById('crType').value = prefillType || 'checkup';
    document.getElementById('crContent').value = prefillNote != null ? String(prefillNote) : '';
    document.getElementById('crFileInput').value = '';
    document.getElementById('crFileName').textContent = '';
    document.getElementById('crFileClear').style.display = 'none';
    if (fromSchedule) {
      _clearScheduleId = String(linkedScheduleRecordId).trim();
    }
    document.getElementById('clinicRecordModal').classList.add('open');
  };

  /** 病院予定カードから記録モーダルを開く（保存後に予定行を削除して重複を防ぐ） */
  window.openClinicRecordFromSchedule = function (scheduleRecordId) {
    var sid = scheduleRecordId != null ? String(scheduleRecordId).trim() : '';
    if (!sid) return;
    fetch(API_BASE + '/health/records/' + encodeURIComponent(sid), {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error || !data.record) {
        alert('読み込みに失敗しました: ' + (data.message || data.error || ''));
        return;
      }
      var rec = data.record;
      if (!rec.next_due) {
        alert('この行には予定日がありません。');
        return;
      }
      var note = '';
      if (rec.details) {
        try {
          var p = typeof rec.details === 'string' ? JSON.parse(rec.details) : rec.details;
          note = (p && p.note) ? String(p.note) : '';
        } catch (_) { note = ''; }
      }
      openClinicRecordModal(rec.record_type || 'checkup', rec.next_due, sid, note);
    }).catch(function () {
      alert('読み込みに失敗しました');
    });
  };

  window.openClinicRecordEditModal = function (recordId) {
    _clearScheduleId = null;
    _clinicPendingFiles = [];
    clearClinicFile();
    var crEdit = document.getElementById('crEditId');
    if (crEdit) crEdit.value = String(recordId);
    var crTitle = document.getElementById('crModalTitle');
    if (crTitle) crTitle.textContent = '🏥 病院記録を編集';
    var crHint = document.getElementById('crExistingFileHint');
    if (crHint) {
      crHint.textContent = '下で追加したファイルは、保存後に既存の添付に加わります。';
      crHint.style.display = 'block';
    }

    fetch(API_BASE + '/health/records/' + recordId, {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error || !data.record) {
        alert('読み込みに失敗しました: ' + (data.message || data.error || ''));
        return;
      }
      var rec = data.record;
      document.getElementById('crType').value = rec.record_type || 'checkup';
      document.getElementById('crDate').value = rec.record_date || '';
      var note = '';
      if (rec.details) {
        try {
          var p = typeof rec.details === 'string' ? JSON.parse(rec.details) : rec.details;
          note = (p && p.note) ? String(p.note) : '';
        } catch (_) { note = ''; }
      }
      if (!note && rec.value) note = String(rec.value);
      document.getElementById('crContent').value = note;
      renderCrExistingFilesInModal(recordId, rec.attachments || []);
      document.getElementById('clinicRecordModal').classList.add('open');
    }).catch(function () {
      alert('読み込みに失敗しました');
    });
  };

  window.onClinicFileSelected = function (input) {
    if (!input.files || input.files.length === 0) return;
    _clinicPendingFiles = [];
    var allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    var names = [];
    for (var i = 0; i < input.files.length; i++) {
      var file = input.files[i];
      if (file.size > CLINIC_RECORD_FILE_MAX_BYTES) {
        alert('「' + (file.name || 'file') + '」が大きすぎます（各10MB以下）');
        input.value = '';
        _clinicPendingFiles = [];
        document.getElementById('crFileName').textContent = '';
        document.getElementById('crFileClear').style.display = 'none';
        return;
      }
      if (allowed.indexOf(file.type) === -1) {
        alert('「' + (file.name || 'file') + '」は未対応形式です（PDF・画像）');
        input.value = '';
        _clinicPendingFiles = [];
        document.getElementById('crFileName').textContent = '';
        document.getElementById('crFileClear').style.display = 'none';
        return;
      }
      _clinicPendingFiles.push(file);
      names.push(file.name || 'file');
    }
    document.getElementById('crFileName').textContent = names.length ? names.join(', ') : '';
    document.getElementById('crFileClear').style.display = names.length ? '' : 'none';
  };

  window.clearClinicFile = function () {
    _clinicPendingFiles = [];
    document.getElementById('crFileInput').value = '';
    document.getElementById('crFileName').textContent = '';
    document.getElementById('crFileClear').style.display = 'none';
  };

  window.closeClinicRecordModal = function () {
    _clearScheduleId = null;
    var crEdit = document.getElementById('crEditId');
    if (crEdit) crEdit.value = '';
    var crHint = document.getElementById('crExistingFileHint');
    if (crHint) { crHint.style.display = 'none'; crHint.textContent = ''; }
    renderCrExistingFilesInModal(0, []);
    document.getElementById('clinicRecordModal').classList.remove('open');
  };

  window.markVetVisited = function (recordId, recordType, scheduledDate) {
    if (!confirm('この予定を受診済みにしますか？\n（あとから病院記録の「↩ 予定に戻す」で取り消せます）')) return;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ next_due: null, value: (scheduledDate || '') + ' 受診済み' }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('更新に失敗しました');
    });
  };

  /** 「YYYY-MM-DD 受診済み」形式（受診済みボタン由来）なら予定日を返す */
  function parseVetVisitedScheduleDate(val) {
    if (val == null) return null;
    var s = String(val).trim();
    var m = s.match(/^(\d{4}-\d{2}-\d{2})\s*受診済み\s*$/);
    return m ? m[1] : null;
  }

  window.restoreVetScheduleFromVisited = function (recordId, nextDueYmd, recordType) {
    if (!confirm('受診済みを取り消し、病院予定に戻しますか？')) return;
    var typeLabels = { vaccine: 'ワクチン', checkup: '健康診断', surgery: '手術', dental: '歯科', emergency: '緊急', test: '検査', observation: '経過観察', medication_start: '投薬開始', medication_end: '投薬終了' };
    var label = typeLabels[recordType] || recordType;
    var newVal = nextDueYmd + ' ' + label;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ next_due: nextDueYmd, value: newVal }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () {
      alert('更新に失敗しました');
    });
  };

  window.deleteVetSchedule = function (recordId) {
    if (!confirm('この病院予定を削除しますか？')) return;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('削除エラー: ' + (data.message || data.error)); return; }
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.editVetScheduleDate = function (recordId, currentDate) {
    var newDate = prompt('新しい予定日（YYYY-MM-DD）:', currentDate);
    if (!newDate || newDate === currentDate) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) { alert('日付形式が正しくありません（YYYY-MM-DD）'); return; }
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ next_due: newDate }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadClinicRecords();
      loadScoreCard();
    }).catch(function () { alert('更新に失敗しました'); });
  };

  window.deleteClinicRecord = function (recordId) {
    if (!confirm('この病院記録を削除しますか？\nこの操作は取り消せません。')) return;
    fetch(API_BASE + '/health/records/' + recordId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
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

    if (!recordDate) { alert('日付を入力してください'); return; }
    if (!content) { alert('内容を入力してください'); return; }

    var crEditEl = document.getElementById('crEditId');
    var editId = (crEditEl && crEditEl.value) ? String(crEditEl.value).trim() : '';

    var postBody = {
      cat_id: catId,
      record_type: recordType,
      record_date: recordDate,
      value: content.slice(0, 100),
      details: { note: content },
      next_due: null,
    };
    var putBody = {
      record_type: recordType,
      record_date: recordDate,
      value: content.slice(0, 100),
      details: { note: content },
    };

    var btn = document.getElementById('crSubmitBtn');
    if (btn) { btn.disabled = true; btn.textContent = '📝 要約を作成中…'; }
    var scheduleIdToClear = _clearScheduleId;
    var pendingFiles = _clinicPendingFiles.slice();

    var saveUrl = editId
      ? (API_BASE + '/health/records/' + encodeURIComponent(editId))
      : (API_BASE + '/health/records');
    var saveMethod = editId ? 'PUT' : 'POST';
    var saveBody = editId ? JSON.stringify(putBody) : JSON.stringify(postBody);

    fetch(saveUrl, {
      method: saveMethod,
      headers: apiHeaders(), cache: 'no-store',
      body: saveBody,
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) {
        alert('エラー: ' + (data.message || data.error));
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
        throw new Error('record_failed');
      }
      var rid = editId ? Number(editId) : (data.record && data.record.id);
      var chain = Promise.resolve();
      if (pendingFiles && pendingFiles.length > 0 && rid) {
        var fd = new FormData();
        for (var pi = 0; pi < pendingFiles.length; pi++) {
          fd.append('file', pendingFiles[pi], pendingFiles[pi].name || 'file');
        }
        chain = fetch(API_BASE + '/health/records/' + rid + '/file', {
          method: 'POST',
          headers: apiHeadersMultipart(),
          body: fd,
          cache: 'no-store',
        }).then(function (ur) {
          return ur.json().then(function (uj) {
            if (!ur.ok || uj.error) {
              alert('添付ファイルのアップロードに失敗しました（本文は保存済みです）。\n' + (uj.message || uj.error || ('HTTP ' + ur.status)));
            }
          });
        });
      }
      return chain.then(function () {
        if (!scheduleIdToClear) return;
        return fetch(API_BASE + '/health/records/' + encodeURIComponent(scheduleIdToClear), {
          method: 'DELETE',
          headers: apiHeaders(), cache: 'no-store',
        }).then(function (dr) {
          return dr.json().then(function (dj) {
            if (!dr.ok || dj.error) {
              alert('病院記録は保存しましたが、元の予定の削除に失敗しました。一覧に予定が残っている場合は手動で削除してください。\n' + (dj.message || dj.error || ('HTTP ' + dr.status)));
            }
          });
        });
      });
    }).then(function () {
      _clearScheduleId = null;
      _clinicPendingFiles = [];
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
      closeClinicRecordModal();
      loadClinicRecords();
      loadScoreCard();
    }).catch(function (err) {
      if (err && err.message === 'record_failed') return;
      if (btn) { btn.disabled = false; btn.textContent = '保存'; }
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
      record_date: todayJstYmd(),
      value: valueSummary,
      details: memo ? JSON.stringify({ note: memo }) : null,
      next_due: schedDate,
    };

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
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
      headers: apiHeaders(), cache: 'no-store',
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

  // ── 基本情報（各項目）編集モーダル ───────────────────────────────────────────────

  var _catBasicEditField = '';
  var _cbfMicrochipPendingFile = null;
  var _cbfMicrochipDeleteImage = false;

  function formatSexDisplayJa(sex) {
    if (sex == null || sex === '') return '—';
    var s = String(sex).toLowerCase();
    if (s === 'm' || s === 'male' || s === 'オス' || s === '雄') return 'オス';
    if (s === 'f' || s === 'female' || s === 'メス' || s === '雌') return 'メス';
    if (s === 'unknown' || s === '不明') return '不明';
    return String(sex);
  }

  function sexSelectValueFromCat(sex) {
    if (sex == null || sex === '') return '';
    var s = String(sex).toLowerCase();
    if (s === 'm' || s === 'male' || s === 'オス' || s === '雄') return 'male';
    if (s === 'f' || s === 'female' || s === 'メス' || s === '雌') return 'female';
    if (s === 'unknown' || s === '不明') return 'unknown';
    return '';
  }

  window.openCatMicrochipImageView = function () {
    if (!catId) return;
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/microchip-file', {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw new Error('not found');
      var disposition = r.headers.get('Content-Disposition') || '';
      var nameMatch = disposition.match(/filename="([^"]+)"/);
      var fileName = nameMatch ? nameMatch[1] : 'microchip';
      return r.blob().then(function (blob) { return { blob: blob, name: fileName }; });
    }).then(function (result) {
      var url = URL.createObjectURL(result.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () { URL.revokeObjectURL(url); }, 120000);
    }).catch(function () { alert('ファイルの取得に失敗しました'); });
  };

  window.onCbfMicrochipFileSelected = function (input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    if (file.size > 5 * 1024 * 1024) {
      alert('ファイルサイズが大きすぎます（5MB以下）');
      input.value = '';
      return;
    }
    var allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.indexOf(file.type) === -1) {
      alert('対応形式: PDF・画像（JPEG/PNG/GIF/WebP）');
      input.value = '';
      return;
    }
    _cbfMicrochipPendingFile = file;
    _cbfMicrochipDeleteImage = false;
    var hint = document.getElementById('cbfMicrochipDeleteHint');
    if (hint) hint.style.display = 'none';
    var nameEl = document.getElementById('cbfMicrochipFileName');
    var clr = document.getElementById('cbfMicrochipFileClear');
    if (nameEl) nameEl.textContent = file.name;
    if (clr) clr.style.display = '';
  };

  window.clearCbfMicrochipFile = function () {
    _cbfMicrochipPendingFile = null;
    var finput = document.getElementById('cbfMicrochipFileInput');
    if (finput) finput.value = '';
    var nameEl = document.getElementById('cbfMicrochipFileName');
    var clr = document.getElementById('cbfMicrochipFileClear');
    if (nameEl) nameEl.textContent = '';
    if (clr) clr.style.display = 'none';
  };

  window.markCbfMicrochipImageDelete = function () {
    _cbfMicrochipDeleteImage = true;
    _cbfMicrochipPendingFile = null;
    var finput = document.getElementById('cbfMicrochipFileInput');
    if (finput) finput.value = '';
    var nameEl = document.getElementById('cbfMicrochipFileName');
    var clr = document.getElementById('cbfMicrochipFileClear');
    if (nameEl) nameEl.textContent = '';
    if (clr) clr.style.display = 'none';
    var hint = document.getElementById('cbfMicrochipDeleteHint');
    if (hint) hint.style.display = 'block';
  };

  window.openCatBasicFieldModal = function (field) {
    if (!currentCatData) return;
    _cbfMicrochipPendingFile = null;
    _cbfMicrochipDeleteImage = false;
    _catBasicEditField = field;
    var titleEl = document.getElementById('cbfModalTitle');
    var bodyEl = document.getElementById('cbfBody');
    if (!titleEl || !bodyEl) return;
    var cat = currentCatData;
    var html = '';

    if (field === 'species') {
      titleEl.textContent = '🐾 種別を編集';
      var sp = cat.species === 'dog' ? 'dog' : 'cat';
      html = '<div class="form-group"><label class="form-label">種別</label>' +
        '<select id="cbfInput" class="form-select">' +
        '<option value="cat"' + (sp === 'cat' ? ' selected' : '') + '>🐱 猫</option>' +
        '<option value="dog"' + (sp === 'dog' ? ' selected' : '') + '>🐶 犬</option>' +
        '</select></div>';
    } else if (field === 'sex') {
      titleEl.textContent = '性別を編集';
      var sv = sexSelectValueFromCat(cat.sex);
      html = '<div class="form-group"><label class="form-label">性別</label>' +
        '<select id="cbfInput" class="form-select">' +
        '<option value="">未設定</option>' +
        '<option value="male"' + (sv === 'male' ? ' selected' : '') + '>オス</option>' +
        '<option value="female"' + (sv === 'female' ? ' selected' : '') + '>メス</option>' +
        '<option value="unknown"' + (sv === 'unknown' ? ' selected' : '') + '>不明</option>' +
        '</select></div>';
    } else if (field === 'birth_date') {
      titleEl.textContent = '誕生日を編集';
      var bd = (cat.birth_date && String(cat.birth_date).slice(0, 10)) || '';
      html = '<div class="form-group"><label class="form-label">誕生日（西暦）</label>' +
        '<input type="date" id="cbfInput" class="form-input" value="' + escapeHtml(bd) + '"></div>' +
        '<div style="font-size:11px;color:var(--text-dim);margin-top:4px;">未入力のまま保存すると未設定にします</div>';
    } else if (field === 'microchip_id') {
      titleEl.textContent = 'マイクロチップを編集';
      html = '<div class="form-group"><label class="form-label">マイクロチップID</label>' +
        '<input type="text" id="cbfInput" class="form-input" placeholder="未登録の場合は空欄" value="' + escapeHtml(cat.microchip_id || '') + '"></div>';
      html += '<div class="form-group"><label class="form-label">登録票・スキャン画像（任意）</label>' +
        '<div style="display:flex;flex-wrap:wrap;align-items:center;gap:8px;">' +
        '<input type="file" id="cbfMicrochipFileInput" accept=".pdf,image/*" style="display:none;" onchange="onCbfMicrochipFileSelected(this)">' +
        '<button type="button" class="btn btn-outline btn-sm" onclick="document.getElementById(\'cbfMicrochipFileInput\').click()">ファイルを選択</button>' +
        '<span id="cbfMicrochipFileName" class="file-attach-name"></span>' +
        '<button type="button" id="cbfMicrochipFileClear" style="display:none;font-size:11px;padding:2px 6px;" onclick="clearCbfMicrochipFile()">✕</button>' +
        '</div></div>';
      html += '<div style="font-size:11px;color:var(--text-dim);margin-bottom:4px;">PDF・画像 / 5MB以下。保存時にアップロードされます（既存がある場合は差し替え）。</div>';
      if (cat.has_microchip_image) {
        html += '<div class="form-group" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;">' +
          '<button type="button" class="btn btn-outline btn-sm" onclick="openCatMicrochipImageView()">現在の画像を表示</button>' +
          '<button type="button" class="btn btn-outline btn-sm" style="color:#f87171;border-color:rgba(248,113,113,0.5);" onclick="markCbfMicrochipImageDelete()">画像のみ削除（保存で反映）</button></div>' +
          '<div id="cbfMicrochipDeleteHint" style="display:none;font-size:11px;color:#fb923c;margin-bottom:8px;">※ 保存すると登録画像が削除されます。新しいファイルを選ぶと削除指定は取り消されます。</div>';
      }
    } else if (field === 'neutered') {
      titleEl.textContent = '避妊・去勢を編集';
      var nv = cat.neutered ? '1' : '0';
      html = '<div class="form-group"><label class="form-label">状態</label>' +
        '<select id="cbfInput" class="form-select">' +
        '<option value="0"' + (nv === '0' ? ' selected' : '') + '>未</option>' +
        '<option value="1"' + (nv === '1' ? ' selected' : '') + '>済</option>' +
        '</select></div>';
    } else if (field === 'bcs') {
      titleEl.textContent = '体型（BCS）を編集';
      var curBcs = cat.body_condition_score;
      html = '<div class="form-group"><label class="form-label">BCS 1〜9</label>' +
        '<select id="cbfInput" class="form-select">';
      html += '<option value="">-- 選択 --</option>';
      for (var bi = 1; bi <= 9; bi++) {
        var bl = bi === 5 ? '5（理想）' : bi < 5 ? bi + '（痩せ）' : bi + '（肥満）';
        html += '<option value="' + bi + '"' + (curBcs == bi ? ' selected' : '') + '>' + bl + '</option>';
      }
      html += '</select></div>' +
        '<div style="font-size:11px;color:var(--text-dim);margin-top:6px;">詳細は下部の「🔥 カロリー評価」でも変更できます</div>';
    } else if (field === 'description') {
      titleEl.textContent = '説明を編集';
      html = '<div class="form-group"><label class="form-label">説明（公開向けメモ）</label>' +
        '<textarea id="cbfDescInput" class="form-textarea" rows="5" placeholder="性格・注意点など"></textarea></div>';
      bodyEl.innerHTML = html;
      var ta = document.getElementById('cbfDescInput');
      if (ta) ta.value = cat.description || '';
      document.getElementById('catBasicFieldModal').classList.add('open');
      setTimeout(function () { if (ta) { ta.focus(); } }, 80);
      return;
    } else {
      return;
    }

    bodyEl.innerHTML = html;
    document.getElementById('catBasicFieldModal').classList.add('open');
    setTimeout(function () {
      var inp = document.getElementById('cbfInput');
      if (inp && inp.focus) inp.focus();
    }, 80);
  };

  window.closeCatBasicFieldModal = function () {
    _catBasicEditField = '';
    _cbfMicrochipPendingFile = null;
    _cbfMicrochipDeleteImage = false;
    var m = document.getElementById('catBasicFieldModal');
    if (m) m.classList.remove('open');
    var bodyEl = document.getElementById('cbfBody');
    if (bodyEl) bodyEl.innerHTML = '';
  };

  window.submitCatBasicFieldModal = function () {
    var field = _catBasicEditField;
    if (!field || !catId) return;
    var btn = document.getElementById('cbfSaveBtn');
    if (btn) btn.disabled = true;

    function finishOk() {
      if (btn) btn.disabled = false;
      closeCatBasicFieldModal();
      loadCatDetail();
    }

    function finishErr(msg) {
      if (btn) btn.disabled = false;
      alert(msg || '保存に失敗しました');
    }

    if (field === 'bcs') {
      var binp = document.getElementById('cbfInput');
      if (!binp || !binp.value) {
        if (btn) btn.disabled = false;
        alert('BCS の値を選んでください');
        return;
      }
      var bcsNum = parseInt(binp.value, 10);
      fetch(API_BASE + '/feeding/nutrition-profile?cat_id=' + encodeURIComponent(catId), {
        method: 'PATCH',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({ body_condition_score: bcsNum }),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { finishErr(data.message || data.error); return; }
        if (currentCatData) currentCatData.body_condition_score = bcsNum;
        var bcsLabel = bcsNum === 5 ? '5（理想）' : bcsNum < 5 ? bcsNum + '（痩せ）' : bcsNum + '（肥満）';
        var cell = document.getElementById('bcsInfoCell');
        if (cell) {
          var valEl = cell.querySelector('.info-value');
          if (valEl) {
            valEl.innerHTML = escapeHtml(bcsLabel) + ' <a href="#calorieArea" style="font-size:11px;color:var(--accent);">カロリー欄へ</a>';
          }
        }
        finishOk();
      }).catch(function () { finishErr('通信エラーです'); });
      return;
    }

    if (field === 'description') {
      var ta = document.getElementById('cbfDescInput');
      var descVal = ta ? ta.value.trim() : '';
      fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
        method: 'PUT',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({ description: descVal || null }),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { finishErr(data.message || data.error); return; }
        finishOk();
      }).catch(function () { finishErr('通信エラーです'); });
      return;
    }

    if (field === 'microchip_id') {
      var inpMc = document.getElementById('cbfInput');
      var midVal = inpMc ? (inpMc.value || '').trim() : '';

      function mcDoneErr(msg) {
        if (btn) btn.disabled = false;
        alert(msg || '保存に失敗しました');
      }
      function mcDoneOk() {
        if (btn) btn.disabled = false;
        _cbfMicrochipPendingFile = null;
        _cbfMicrochipDeleteImage = false;
        closeCatBasicFieldModal();
        loadCatDetail();
      }

      fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
        method: 'PUT',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({ microchip_id: midVal ? midVal : null }),
      }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { mcDoneErr(data.message || data.error); return; }
        if (currentCatData) currentCatData.microchip_id = midVal ? midVal : null;

        var chain = Promise.resolve();
        if (_cbfMicrochipPendingFile) {
          var fd = new FormData();
          fd.append('file', _cbfMicrochipPendingFile, _cbfMicrochipPendingFile.name || 'file');
          chain = chain.then(function () {
            return fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/microchip-file', {
              method: 'POST',
              headers: apiHeadersMultipart(),
              body: fd,
              cache: 'no-store',
            }).then(function (ur) {
              return ur.json().then(function (uj) {
                if (!ur.ok || uj.error) {
                  alert('画像のアップロードに失敗しました（IDは保存済みです）。\n' + (uj.message || uj.error || ('HTTP ' + ur.status)));
                }
              });
            });
          });
        } else if (_cbfMicrochipDeleteImage) {
          chain = chain.then(function () {
            return fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/microchip-file', {
              method: 'DELETE',
              headers: apiHeaders(), cache: 'no-store',
            }).then(function (dr) {
              return dr.json().then(function (dj) {
                if (!dr.ok || dj.error) {
                  alert('画像の削除に失敗しました: ' + (dj.message || dj.error || ('HTTP ' + dr.status)));
                }
              });
            });
          });
        }
        return chain;
      }).then(function () { mcDoneOk(); })
      .catch(function () { mcDoneErr('通信エラーです'); });
      return;
    }

    var inp = document.getElementById('cbfInput');
    if (!inp) { if (btn) btn.disabled = false; return; }

    var payload = {};
    if (field === 'species') {
      payload.species = inp.value === 'dog' ? 'dog' : 'cat';
    } else if (field === 'sex') {
      payload.sex = inp.value === '' ? null : inp.value;
    } else if (field === 'birth_date') {
      var bdv = (inp.value || '').trim();
      payload.birth_date = bdv ? bdv : null;
    } else if (field === 'neutered') {
      payload.neutered = inp.value === '1' ? 1 : 0;
    } else {
      if (btn) btn.disabled = false;
      return;
    }

    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { finishErr(data.message || data.error); return; }
      if (currentCatData) {
        if (field === 'species') currentCatData.species = payload.species;
        if (field === 'sex') currentCatData.sex = payload.sex;
        if (field === 'birth_date') currentCatData.birth_date = payload.birth_date;
        if (field === 'neutered') currentCatData.neutered = payload.neutered;
      }
      finishOk();
    }).catch(function () { finishErr('通信エラーです'); });
  };

  // ── 猫写真アップロード ─────────────────────────────────────────────────────────

  window.triggerCatPhotoUpload = function () {
    var input = document.getElementById('catPhotoInput');
    if (input) input.click();
  };

  window.onCatPhotoSelected = function (input) {
    if (!input.files || !input.files[0]) return;
    var file = input.files[0];
    if (file.size > 10 * 1024 * 1024) { alert('ファイルが大きすぎます（10MB以下）'); return; }

    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var canvas = document.createElement('canvas');
        var size = 300;
        var sx = 0, sy = 0, sw = img.width, sh = img.height;
        if (sw > sh) { sx = (sw - sh) / 2; sw = sh; }
        else { sy = (sh - sw) / 2; sh = sw; }
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        saveCatPhoto(dataUrl);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  };

  function saveCatPhoto(dataUrl) {
    var wrap = document.querySelector('.cat-avatar-wrap');
    if (wrap) {
      var existing = wrap.querySelector('.cat-avatar-img, .cat-header-emoji, #catAvatarFallback');
      if (existing) existing.outerHTML = '<img class="cat-avatar-img" src="' + dataUrl + '" alt="">';
      var hiddenImg = wrap.querySelector('#catAvatarImg');
      if (hiddenImg) hiddenImg.remove();
    }

    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ photo_url: dataUrl }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('写真の保存に失敗: ' + (data.message || data.error)); return; }
      if (currentCatData) currentCatData.photo_url = 'r2:cat-photos/' + catId + '.jpg';
    }).catch(function () { alert('写真の保存に失敗しました'); });
  }

  function loadCatPhotoFromR2() {
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/photo?t=' + Date.now(), {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw new Error('not found');
      return r.blob();
    }).then(function (blob) {
      var url = URL.createObjectURL(blob);
      var img = document.getElementById('catAvatarImg');
      var fallback = document.getElementById('catAvatarFallback');
      if (img) { img.src = url; img.style.display = ''; }
      if (fallback) fallback.style.display = 'none';
    }).catch(function () {
      /* R2 photo not available — keep emoji fallback visible */
    });
  }

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
      headers: apiHeaders(), cache: 'no-store',
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
    var today = todayJstYmd();
    document.getElementById('careDate').value = today;
    document.getElementById('careDone').value = '1';
    document.getElementById('careTypeVoice').value = '';
    document.getElementById('careType').value = '';
    if (careTypesCache.length === 0) {
      fetch(API_BASE + '/health/care-types', { headers: apiHeaders(), cache: 'no-store' }).then(function (r) { return r.json(); })
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
      headers: apiHeaders(), cache: 'no-store',
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
    var today = todayJstYmd();
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
      headers: apiHeaders(), cache: 'no-store',
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
    if (careDone && (recordType === 'care' || recordType === 'eye_discharge')) {
      body.recorded_time = nowJstHm();
    }

    fetch(API_BASE + '/health/records', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(body),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      var newId = data.record && data.record.id;
      if (!newId) {
        closeCareModal();
        loadCareSection();
        return;
      }
      deleteCareRecordsForSlotExcept(careDate, recordType, details, newId, function () {
        closeCareModal();
        loadCareSection();
      });
    }).catch(function () {
      alert('ケア記録の保存に失敗しました');
    });
  };

  // ── レンダリングヘルパー ──────────────────────────────────────────────────────

  function renderInfoCell(label, value) {
    return '<div class="info-cell"><div class="info-label">' + escapeHtml(label) + '</div><div class="info-value">' + escapeHtml(value) + '</div></div>';
  }

  /** 基本情報用: ラベル横に編集ボタン。valueHtml は既にエスケープ済みのテキスト、または意図した HTML のみ */
  function renderBasicInfoEditableRow(labelText, valueHtml, fieldKey, isFull, domId) {
    var cls = isFull ? 'info-cell full' : 'info-cell';
    var idAttr = domId ? (' id="' + domId + '"') : '';
    return '<div class="' + cls + '"' + idAttr + '>' +
      '<div class="info-label" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:4px;">' +
      '<span>' + escapeHtml(labelText) + '</span>' +
      '<button type="button" class="btn-edit-loc" style="font-size:11px;padding:2px 8px;flex-shrink:0;" onclick="openCatBasicFieldModal(\'' + fieldKey + '\')">編集</button>' +
      '</div>' +
      '<div class="info-value" style="font-size:13px;white-space:pre-wrap;word-break:break-word;">' + valueHtml + '</div>' +
      '</div>';
  }

  // ── 次回投薬日計算 ─────────────────────────────────────────────────────────────
  var _DOW_MAP = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };

  function _shouldDose(freq, dateStr, startDate) {
    if (!freq || freq === '毎日' || freq === '1日1回' || freq === '1日2回' || freq === '1日3回') return true;
    if (freq === '必要時') return false;
    var d = new Date(dateStr + 'T00:00:00Z');
    if (freq === '月末のみ') {
      var lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === lastDay;
    }
    if (freq.indexOf('週:') === 0) {
      var days = freq.slice(2).split(',');
      var dow = d.getUTCDay();
      for (var i = 0; i < days.length; i++) { if (_DOW_MAP[days[i].trim()] === dow) return true; }
      return false;
    }
    if (freq.indexOf('月1:') === 0) {
      var dayPart = freq.slice(3);
      if (dayPart === '末日') {
        var lastDay2 = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
        return d.getUTCDate() === lastDay2;
      }
      var targetDay = parseInt(dayPart, 10);
      var monthLastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      return d.getUTCDate() === Math.min(targetDay, monthLastDay);
    }
    var daysBetween = Math.round((d - new Date((startDate || dateStr) + 'T00:00:00Z')) / 86400000);
    if (daysBetween < 0) return false;
    if (freq === '隔日' || freq === '隔日(A)') return daysBetween % 2 === 0;
    if (freq === '隔日(B)') return daysBetween % 2 === 1;
    if (freq === '2日に1回') return daysBetween % 2 === 0;
    if (freq === '3日に1回') return daysBetween % 3 === 0;
    if (freq === '週1回') return daysBetween % 7 === 0;
    if (freq === '週3回') {
      var dow2 = d.getUTCDay();
      return dow2 === 1 || dow2 === 3 || dow2 === 5;
    }
    return true;
  }

  function calcNextDoseDate(freq, startDate) {
    var today = new Date();
    for (var i = 1; i <= 60; i++) {
      var check = new Date(today.getTime() + i * 86400000);
      var ds = check.toISOString().slice(0, 10);
      if (_shouldDose(freq, ds, startDate || ds)) return ds;
    }
    return null;
  }

  function formatFreqLabel(freq) {
    if (!freq) return '毎日';
    if (freq.indexOf('週:') === 0) return '毎週 ' + freq.slice(2);
    if (freq === '月1:末日') return '毎月末日';
    if (freq.indexOf('月1:') === 0) return '毎月' + freq.slice(3) + '日';
    return freq;
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

  /** 病院記録・予定の表示用: 西暦 YYYY-MM-DD（record_date / next_due） */
  function formatClinicDateWestern(str) {
    if (!str) return '';
    var s = String(str).trim();
    if (s.length >= 10 && s.charAt(4) === '-') s = s.slice(0, 10);
    var parts = s.split('-');
    if (parts.length >= 3 && /^\d{4}$/.test(parts[0])) {
      var mo = ('0' + Number(parts[1])).slice(-2);
      var da = ('0' + Number(parts[2])).slice(-2);
      return parts[0] + '-' + mo + '-' + da;
    }
    return s;
  }

  // ── この猫のタスク ──────────────────────────────────────────────────────

  function loadCatTasks(opts) {
    opts = opts || {};
    var skipScroll = !!opts.skipScrollRestore;
    var area = document.getElementById('catTasksArea');
    if (!area) return Promise.resolve();
    var savedY = 0;
    if (!skipScroll && window.NyagiScrollRestore && window.NyagiScrollRestore.capture) {
      savedY = window.NyagiScrollRestore.capture();
    }
    area.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク</div></div><div class="loading" style="padding:8px;font-size:12px;"><span class="spinner"></span> 読み込み中...</div></div>';

    var today = new Date();
    var y = today.getFullYear();
    var mo = ('0' + (today.getMonth() + 1)).slice(-2);
    var d = ('0' + today.getDate()).slice(-2);
    var dateStr = y + '-' + mo + '-' + d;
    var url = API_BASE + '/tasks?date=' + dateStr + '&cat_id=' + encodeURIComponent(catId);

    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
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
          html += '<div class="cat-task-row' + (isDone ? ' cat-task-row--done' : '') + '">';
          html += '<span class="cat-task-icon" aria-hidden="true">' + icon + '</span>';
          html += '<div class="cat-task-main">';
          var overdueMark = '';
          if ((t.task_type || '') === 'event' && !isDone && t.due_date && String(t.due_date).slice(0, 10) < todayJstYmd()) {
            overdueMark = ' <span class="cat-task-overdue">期限切れ</span>';
          }
          html += '<div class="cat-task-title"' + (isDone ? ' style="text-decoration:line-through;"' : '') + '>' + escapeHtml(t.title) + overdueMark + '</div>';
          if (t.assigned_name) {
            html += '<div class="cat-task-assignee">担当: ' + escapeHtml(t.assigned_name) + '</div>';
          }
          html += '</div>';
          if (!isDone) {
            html += '<button type="button" class="btn btn-primary btn-sm" onclick="catTaskDone(' + t.id + ')">完了</button>';
          }
          html += '</div>';
        }
        html += '</div></div>';
        area.innerHTML = html;
      })
      .catch(function () {
        area.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">✅ この猫のタスク</div></div><div class="empty-msg" style="font-size:12px;padding:8px;">読み込み失敗</div></div>';
      })
      .then(function () {
        if (!skipScroll && window.NyagiScrollRestore && window.NyagiScrollRestore.restore) {
          window.NyagiScrollRestore.restore(savedY);
        }
      });
  }

  window.catTaskDone = function (taskId) {
    fetch(API_BASE + '/tasks/' + taskId + '/done', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({}),
    }).then(function (res) {
      if (res.ok) loadCatTasks();
    });
  };

  // ── 猫注意事項（P5.7）──────────────────────────────────────────────────────

  function loadCatNotes() {
    if (!catNotesArea) return Promise.resolve();
    catNotesArea.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">📝 注意事項</div><div style="display:flex;gap:8px;"><button type="button" class="btn-edit-loc" onclick="openInternalNoteModal()">内部メモ</button><button class="btn-add" onclick="openCatNoteModal()">+ 追加</button></div></div><div class="loading" style="padding:16px;">読み込み中...</div></div>';

    return fetch(API_BASE + '/cat-notes?cat_id=' + encodeURIComponent(catId) + '&exclude_categories=feeding,nutrition,medication&limit=30', {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (res) { return res.json(); })
    .then(function (data) {
      renderCatNotes(data.notes || []);
    }).catch(function () {
      catNotesArea.innerHTML = '<div class="detail-section"><div class="section-header"><div class="detail-title">📝 注意事項</div><div style="display:flex;gap:8px;"><button type="button" class="btn-edit-loc" onclick="openInternalNoteModal()">内部メモ</button><button class="btn-add" onclick="openCatNoteModal()">+ 追加</button></div></div><div class="empty-msg">読み込みに失敗しました</div></div>';
    });
  }

  function renderCatNotes(notes) {
    _catNotesListCache = notes.slice();
    var internalNote = currentCatData ? (currentCatData.internal_note || '') : '';
    var noteTexts = {};
    for (var i = 0; i < notes.length; i++) {
      noteTexts[(notes[i].note || '').trim()] = true;
    }

    var html = '<div class="detail-section">';
    html += '<div class="section-header"><div class="detail-title">📝 注意事項・メモ</div>';
    html += '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">';
    html += '<button type="button" class="btn-edit-loc" onclick="openInternalNoteModal()" title="スタッフ向け内部メモ（cats.internal_note）">内部メモ</button>';
    html += '<button class="btn-add" onclick="openCatNoteModal()">+ 追加</button>';
    html += '</div></div>';

    var hasContent = false;

    if (internalNote && !noteTexts[internalNote.trim()]) {
      hasContent = true;
      html += '<div class="cat-note-item pinned">';
      html += '<span class="cat-note-pin">📋</span>';
      html += '<div class="cat-note-head">';
      html += '<span><span class="cat-note-category general">内部メモ</span></span>';
      html += '<span><button type="button" class="btn-edit-loc" onclick="openInternalNoteModal()">編集</button></span>';
      html += '</div>';
      html += '<div class="cat-note-body">' + escapeHtml(internalNote) + '</div>';
      html += '</div>';
    } else if (currentCatData && (!internalNote || !internalNote.trim())) {
      hasContent = true;
      html += '<div class="cat-note-item" style="border:1px dashed rgba(255,255,255,0.15);">';
      html += '<div class="cat-note-head"><span class="cat-note-category general">内部メモ</span>';
      html += '<button type="button" class="btn-edit-loc" onclick="openInternalNoteModal()">＋ 追加</button></div>';
      html += '<div class="empty-msg" style="margin:0;font-size:12px;">未登録（スタッフ向けの長文メモ）</div>';
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
      html += '<div class="cat-note-actions">';
      html += '<button type="button" onclick="openEditCatNote(' + n.id + ')">編集</button>';
      html += '<button type="button" class="cat-note-del" onclick="deleteCatNoteConfirm(' + n.id + ')">削除</button>';
      html += '</div>';
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
    var eid = document.getElementById('cnEditId');
    var ttl = document.getElementById('cnModalTitle');
    if (eid) eid.value = '';
    if (ttl) ttl.textContent = '注意事項を追加';
    document.getElementById('cnNote').value = '';
    document.getElementById('cnCategory').value = 'general';
    document.getElementById('cnPinned').checked = false;
    document.getElementById('catNoteModal').classList.add('open');
  };

  window.openEditCatNote = function (noteId) {
    var row = null;
    for (var i = 0; i < _catNotesListCache.length; i++) {
      if (String(_catNotesListCache[i].id) === String(noteId)) {
        row = _catNotesListCache[i];
        break;
      }
    }
    if (!row) {
      alert('メモが見つかりません。一覧を再読み込みしてください。');
      return;
    }
    var eid = document.getElementById('cnEditId');
    var ttl = document.getElementById('cnModalTitle');
    if (eid) eid.value = String(row.id);
    if (ttl) ttl.textContent = '注意事項を編集';
    document.getElementById('cnNote').value = row.note || '';
    document.getElementById('cnCategory').value = row.category || 'general';
    document.getElementById('cnPinned').checked = !!row.pinned;
    document.getElementById('catNoteModal').classList.add('open');
  };

  window.deleteCatNoteConfirm = function (noteId) {
    if (!confirm('この注意事項を削除しますか？')) return;
    fetch(API_BASE + '/cat-notes/' + encodeURIComponent(noteId), {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      loadCatNotes();
    }).catch(function () {
      alert('削除に失敗しました');
    });
  };

  window.closeCatNoteModal = function () {
    document.getElementById('catNoteModal').classList.remove('open');
    var eid = document.getElementById('cnEditId');
    if (eid) eid.value = '';
  };

  window.submitCatNote = function () {
    var note = document.getElementById('cnNote').value.trim();
    if (!note) { alert('内容を入力してください'); return; }

    var editIdEl = document.getElementById('cnEditId');
    var editId = editIdEl && editIdEl.value ? String(editIdEl.value).trim() : '';

    if (editId) {
      fetch(API_BASE + '/cat-notes/' + encodeURIComponent(editId), {
        method: 'PUT',
        headers: apiHeaders(), cache: 'no-store',
        body: JSON.stringify({
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
      return;
    }

    fetch(API_BASE + '/cat-notes', {
      method: 'POST',
      headers: apiHeaders(), cache: 'no-store',
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

  window.openInternalNoteModal = function () {
    if (!currentCatData) return;
    var t = document.getElementById('inNoteText');
    if (t) t.value = currentCatData.internal_note || '';
    var m = document.getElementById('internalNoteModal');
    if (m) m.classList.add('open');
  };

  window.closeInternalNoteModal = function () {
    var m = document.getElementById('internalNoteModal');
    if (m) m.classList.remove('open');
  };

  window.submitInternalNote = function () {
    var text = document.getElementById('inNoteText');
    var val = text ? text.value.trim() : '';
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ internal_note: val || null }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (currentCatData) currentCatData.internal_note = val || null;
      closeInternalNoteModal();
      loadCatNotes();
    }).catch(function () {
      alert('保存に失敗しました');
    });
  };

  var IA_DOC_MAX_BYTES = 10 * 1024 * 1024;
  var IA_DOC_MIMES = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];

  function nyagiIaPath(kind) {
    return kind === 'adoption' ? 'adoption-records' : 'intake-records';
  }

  window.createNyagiIaRecord = function (kind) {
    if (!catId) return;
    var note = window.prompt('資料レコードのメモ（空欄可）', '');
    if (note === null) return;
    var path = nyagiIaPath(kind);
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path, {
      method: 'POST',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ note: note ? note.trim() : null }),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      if (!x.ok || (x.j && x.j.error)) {
        alert('追加に失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadCatDetail();
    }).catch(function () {
      alert('追加に失敗しました');
    });
  };

  window.editNyagiIaRecordNote = function (kind, recordId) {
    if (!catId) return;
    var recs = kind === 'adoption' ? (currentCatData && currentCatData.adoption_records) : (currentCatData && currentCatData.intake_records);
    var cur = '';
    if (recs && recs.length) {
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].id === recordId) {
          cur = recs[i].note != null ? String(recs[i].note) : '';
          break;
        }
      }
    }
    var note = window.prompt('メモを編集（空欄でクリア）', cur);
    if (note === null) return;
    var path = nyagiIaPath(kind);
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path + '/' + recordId, {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({ note: note.trim() ? note.trim() : null }),
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      if (!x.ok || (x.j && x.j.error)) {
        alert('保存に失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadCatDetail();
    }).catch(function () {
      alert('保存に失敗しました');
    });
  };

  window.deleteNyagiIaRecord = function (kind, recordId) {
    if (!catId) return;
    if (!window.confirm('この資料レコードと紐づく全ファイルを削除しますか？')) return;
    var path = nyagiIaPath(kind);
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path + '/' + recordId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      if (!x.ok || (x.j && x.j.error)) {
        alert('削除に失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadCatDetail();
    }).catch(function () {
      alert('削除に失敗しました');
    });
  };

  window.openNyagiIaRecordFile = function (kind, recordId, fileId) {
    if (!catId) return;
    var path = nyagiIaPath(kind);
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path + '/' + recordId + '/files/' + fileId, {
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      if (!r.ok) throw new Error('not found');
      var disposition = r.headers.get('Content-Disposition') || '';
      var nameMatch = disposition.match(/filename="([^"]+)"/);
      var fileName = nameMatch ? nameMatch[1] : 'file';
      return r.blob().then(function (blob) {
        return { blob: blob, name: fileName };
      });
    }).then(function (result) {
      var url = URL.createObjectURL(result.blob);
      window.open(url, '_blank', 'noopener');
      setTimeout(function () {
        URL.revokeObjectURL(url);
      }, 120000);
    }).catch(function () {
      alert('ファイルの取得に失敗しました');
    });
  };

  window.deleteNyagiIaRecordFile = function (kind, recordId, fileId) {
    if (!catId) return;
    if (!window.confirm('このファイルを削除しますか？')) return;
    var path = nyagiIaPath(kind);
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path + '/' + recordId + '/files/' + fileId, {
      method: 'DELETE',
      headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      if (!x.ok || (x.j && x.j.error)) {
        alert('削除に失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadCatDetail();
    }).catch(function () {
      alert('削除に失敗しました');
    });
  };

  window.onIaRecordFileInputChange = function (input) {
    if (!input || !input.files || input.files.length === 0) return;
    if (!catId) {
      alert('猫の情報がまだ読み込まれていません。');
      input.value = '';
      return;
    }
    if (!_iaRecordUploadTarget || !_iaRecordUploadTarget.recordId) {
      alert('対象のレコードが選べていません。もう一度「ファイルを追加」から選び直してください。');
      input.value = '';
      return;
    }
    var path = nyagiIaPath(_iaRecordUploadTarget.kind);
    var rid = _iaRecordUploadTarget.recordId;
    for (var i = 0; i < input.files.length; i++) {
      var f = input.files[i];
      if (f.size > IA_DOC_MAX_BYTES) {
        alert('「' + (f.name || 'file') + '」が大きすぎます（各10MB以下）');
        input.value = '';
        return;
      }
      if (IA_DOC_MIMES.indexOf(f.type) === -1) {
        alert('「' + (f.name || 'file') + '」は未対応形式です（PDF・JPEG/PNG/GIF/WebP）');
        input.value = '';
        return;
      }
    }
    var fd = new FormData();
    for (var j = 0; j < input.files.length; j++) {
      fd.append('file', input.files[j], input.files[j].name || 'file');
    }
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId) + '/' + path + '/' + rid + '/files', {
      method: 'POST',
      headers: apiHeadersMultipart(),
      body: fd,
      cache: 'no-store',
    }).then(function (r) {
      return r.json().then(function (j) {
        return { ok: r.ok, j: j };
      });
    }).then(function (x) {
      input.value = '';
      _iaRecordUploadTarget = null;
      if (!x.ok || (x.j && x.j.error)) {
        alert('アップロードに失敗しました\n' + ((x.j && (x.j.message || x.j.error)) || ''));
        return;
      }
      loadCatDetail();
    }).catch(function () {
      input.value = '';
      _iaRecordUploadTarget = null;
      alert('アップロードに失敗しました');
    });
  };

  window.openIntakeAdoptionModal = function () {
    if (!currentCatData) return;
    var ti = document.getElementById('iaIntake');
    var ta = document.getElementById('iaAdoption');
    if (ti) ti.value = currentCatData.intake_info || '';
    if (ta) ta.value = currentCatData.adoption_info || '';
    var m = document.getElementById('intakeAdoptionModal');
    if (m) m.classList.add('open');
  };

  window.closeIntakeAdoptionModal = function () {
    var m = document.getElementById('intakeAdoptionModal');
    if (m) m.classList.remove('open');
  };

  window.submitIntakeAdoptionInfo = function () {
    var ti = document.getElementById('iaIntake');
    var ta = document.getElementById('iaAdoption');
    var iv = ti ? ti.value.trim() : '';
    var av = ta ? ta.value.trim() : '';
    fetch(API_BASE + '/cats/' + encodeURIComponent(catId), {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify({ intake_info: iv || null, adoption_info: av || null }),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (currentCatData) {
        currentCatData.intake_info = iv || null;
        currentCatData.adoption_info = av || null;
      }
      closeIntakeAdoptionModal();
      renderIntakeAdoptionSections(currentCatData);
    }).catch(function () {
      alert('保存に失敗しました');
    });
  };

  window.togglePin = function (noteId, pinned) {
    fetch(API_BASE + '/cat-notes/' + noteId, {
      method: 'PUT',
      headers: apiHeaders(), cache: 'no-store',
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
      if (mod === 'feeding') { loadFeedingSection(); }
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

  // ── 投薬プリセット ─────────────────────────────────────────────────────────────

  var _medPresets = [];
  var _editingMedPresetId = null;
  var _editingMedPresetItemId = null;
  var _mpItemsCache = {};

  function applyFrequencyStringToMpForm(freq) {
    var sel = document.getElementById('mpFrequency');
    if (!sel) return;
    var f = (freq != null && freq !== '') ? String(freq) : '毎日';
    if (f === '隔日') f = '隔日(A)';

    if (f.indexOf('月1:') === 0) {
      sel.value = 'monthly';
      var dom = document.getElementById('mpMonthDay');
      if (dom) {
        var dayPart = f.slice(3);
        dom.value = (dayPart === '末日') ? 'last' : String(parseInt(dayPart, 10) || '');
      }
      onMpFreqChange();
      return;
    }
    if (f.indexOf('週:') === 0) {
      sel.value = 'weekly';
      onMpFreqChange();
      var allDow = document.querySelectorAll('input[name="mpDow"]');
      for (var i = 0; i < allDow.length; i++) allDow[i].checked = false;
      var days = f.slice(2).split(',');
      for (var j = 0; j < days.length; j++) {
        var d = days[j].trim();
        for (var k = 0; k < allDow.length; k++) {
          if (allDow[k].value === d) allDow[k].checked = true;
        }
      }
      return;
    }

    var found = false;
    for (var oi = 0; oi < sel.options.length; oi++) {
      if (sel.options[oi].value === f) { sel.selectedIndex = oi; found = true; break; }
    }
    if (!found) sel.value = '毎日';
    onMpFreqChange();
  }

  function clearMedPresetItemForm() {
    _editingMedPresetItemId = null;
    var btn = document.getElementById('mpItemSubmitBtn');
    if (btn) btn.textContent = '＋ この薬を追加';
    var hint = document.getElementById('mpItemEditHint');
    if (hint) hint.style.display = 'none';
    var cbtn = document.getElementById('mpItemCancelEditBtn');
    if (cbtn) cbtn.style.display = 'none';

    var selM = document.getElementById('mpMedicineId');
    if (selM) selM.value = '';
    var inp = document.getElementById('mpMedSearchInput');
    if (inp) inp.value = '';
    var amt = document.getElementById('mpDosageAmount');
    if (amt) amt.value = '';
    var unit = document.getElementById('mpDosageUnit');
    if (unit) unit.value = '';
    var route = document.getElementById('mpRoute');
    if (route) route.value = '経口';
    var fq = document.getElementById('mpFrequency');
    if (fq) fq.value = '毎日';
    var md = document.getElementById('mpMonthDay');
    if (md) md.value = '';
    var slots = document.querySelectorAll('#mpSlotChecks input[type="checkbox"]');
    for (var si = 0; si < slots.length; si++) {
      slots[si].checked = (slots[si].value === '朝' || slots[si].value === '晩');
    }
    var dows = document.querySelectorAll('input[name="mpDow"]');
    for (var dj = 0; dj < dows.length; dj++) dows[dj].checked = false;
    onMpFreqChange();
  }

  window.cancelEditMedPresetItem = function () {
    clearMedPresetItemForm();
  };

  window.startEditMedPresetItem = function (itemId) {
    var it = _mpItemsCache[itemId];
    if (!it) { alert('データが見つかりません。一覧を再読み込みしてください。'); return; }
    _editingMedPresetItemId = itemId;

    var btn = document.getElementById('mpItemSubmitBtn');
    if (btn) btn.textContent = '💾 変更を保存';
    var hint = document.getElementById('mpItemEditHint');
    if (hint) hint.style.display = 'block';
    var cbtn = document.getElementById('mpItemCancelEditBtn');
    if (cbtn) cbtn.style.display = 'block';

    var selM = document.getElementById('mpMedicineId');
    if (selM) selM.value = it.medicine_id || '';
    var inp = document.getElementById('mpMedSearchInput');
    if (inp) {
      inp.value = (it.medicine_name || '') + (it.medicine_form ? ' (' + it.medicine_form + ')' : '');
    }
    var amt = document.getElementById('mpDosageAmount');
    if (amt) amt.value = (it.dosage_amount != null && it.dosage_amount !== '') ? String(it.dosage_amount) : '';
    var unit = document.getElementById('mpDosageUnit');
    if (unit) unit.value = it.dosage_unit || '';
    var route = document.getElementById('mpRoute');
    if (route) route.value = it.route || '経口';

    applyFrequencyStringToMpForm(it.frequency);

    var slotArr = [];
    try { slotArr = JSON.parse(it.time_slots || '[]'); } catch (_) { slotArr = []; }
    var slotChecks = document.querySelectorAll('#mpSlotChecks input[type="checkbox"]');
    for (var sc = 0; sc < slotChecks.length; sc++) {
      slotChecks[sc].checked = slotArr.indexOf(slotChecks[sc].value) !== -1;
    }
    var anySlot = false;
    for (var sc2 = 0; sc2 < slotChecks.length; sc2++) { if (slotChecks[sc2].checked) anySlot = true; }
    if (!anySlot && slotChecks.length) {
      for (var sc3 = 0; sc3 < slotChecks.length; sc3++) {
        if (slotChecks[sc3].value === '朝') slotChecks[sc3].checked = true;
      }
    }

    var formAnchor = document.getElementById('mpItemSubmitBtn');
    if (formAnchor && formAnchor.scrollIntoView) {
      try { formAnchor.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (_) { formAnchor.scrollIntoView(false); }
    }
  };

  window.saveMedPresetMeta = function () {
    if (!_editingMedPresetId) return;
    var nameIn = document.getElementById('mpPresetName');
    var descIn = document.getElementById('mpPresetDescription');
    var name = nameIn ? nameIn.value.trim() : '';
    if (!name) { alert('プリセット名を入力してください'); return; }
    fetch(API_BASE + '/health/medication-presets/' + _editingMedPresetId, {
      method: 'PUT',
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify({
        name: name,
        description: descIn && descIn.value.trim() ? descIn.value.trim() : null,
      }),
    }).then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
        var titleEl = document.getElementById('mpEditTitle');
        if (titleEl) titleEl.textContent = '📋 ' + name + ' の編集';
        for (var pi = 0; pi < _medPresets.length; pi++) {
          if (_medPresets[pi].id === _editingMedPresetId) {
            _medPresets[pi].name = name;
            _medPresets[pi].description = descIn && descIn.value.trim() ? descIn.value.trim() : null;
            break;
          }
        }
        alert('プリセット情報を保存しました');
      }).catch(function () { alert('保存に失敗しました'); });
  };

  window.deleteMedPresetConfirm = function (presetId) {
    if (!confirm('このプリセットを削除しますか？')) return;
    fetch(API_BASE + '/health/medication-presets/' + presetId, {
      method: 'DELETE', headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      _medActiveTab = 'preset';
      loadMedicationSchedule();
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.editMedPreset = function (presetId) {
    _editingMedPresetId = presetId;
    clearMedPresetItemForm();
    var p = null;
    for (var i = 0; i < _medPresets.length; i++) {
      if (_medPresets[i].id === presetId) { p = _medPresets[i]; break; }
    }
    var titleEl = document.getElementById('mpEditTitle');
    if (titleEl && p) titleEl.textContent = '📋 ' + p.name + ' の編集';

    var nameIn = document.getElementById('mpPresetName');
    var descIn = document.getElementById('mpPresetDescription');
    if (nameIn) nameIn.value = p ? (p.name || '') : '';
    if (descIn) descIn.value = p ? (p.description || '') : '';

    var editModal = document.getElementById('medPresetEditModal');
    if (editModal) editModal.classList.add('open');

    loadMedPresetMedicines();
    loadMedPresetItems(presetId);
  };

  function loadMedPresetMedicines() {
    var sel = document.getElementById('mpMedicineId');
    if (!sel) return;
    if (_medicinesList && _medicinesList.length > 0) {
      populateMedPresetMedicineSelect(sel);
      _initMedSearch();
      return;
    }
    var sp = (currentCatData && currentCatData.species) || 'cat';
    fetch(API_BASE + '/health/medicines?species=' + sp, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        _medicinesList = data.medicines || [];
        populateMedPresetMedicineSelect(sel);
        _initMedSearch();
      })
      .catch(function () {
        _medicinesList = null;
        populateMedPresetMedicineSelect(sel);
        alert('薬マスターの読み込みに失敗しました。通信を確認してください。');
      });
  }

  function populateMedPresetMedicineSelect(sel) {
    sel.innerHTML = '<option value="">選択してください</option>';
    var list = Array.isArray(_medicinesList) ? _medicinesList : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name + (m.form ? ' (' + m.form + ')' : '');
      sel.appendChild(opt);
    }
  }

  // ── 薬検索UI ──
  function _initMedSearch() {
    var input = document.getElementById('mpMedSearchInput');
    var dropdown = document.getElementById('mpMedSearchDropdown');
    var sel = document.getElementById('mpMedicineId');
    if (!input || !dropdown || !sel) return;

    input.removeEventListener('input', _onMedSearchInput);
    input.addEventListener('input', _onMedSearchInput);
    input.removeEventListener('focus', _onMedSearchFocus);
    input.addEventListener('focus', _onMedSearchFocus);
    document.removeEventListener('click', _onMedSearchBlur);
    document.addEventListener('click', _onMedSearchBlur);
  }

  function _onMedSearchInput() { _renderMedDropdown(); }
  function _onMedSearchFocus() { _renderMedDropdown(); }
  function _onMedSearchBlur(e) {
    var wrap = document.getElementById('mpMedSearchWrap');
    if (wrap && !wrap.contains(e.target)) {
      var dd = document.getElementById('mpMedSearchDropdown');
      if (dd) dd.style.display = 'none';
    }
  }

  function _renderMedDropdown() {
    var input = document.getElementById('mpMedSearchInput');
    var dropdown = document.getElementById('mpMedSearchDropdown');
    if (!input || !dropdown) return;
    var q = input.value.trim().toLowerCase();

    var list = Array.isArray(_medicinesList) ? _medicinesList : [];
    var filtered = list;
    if (q) {
      filtered = list.filter(function (m) {
        var label = (m.name || '') + ' ' + (m.form || '') + ' ' + (m.category || '');
        return label.toLowerCase().indexOf(q) !== -1;
      });
    }

    if (filtered.length === 0) {
      dropdown.innerHTML = '<div style="padding:8px;color:var(--text-dim);font-size:12px;">該当なし</div>';
      dropdown.style.display = 'block';
      return;
    }

    var html = '';
    for (var i = 0; i < Math.min(filtered.length, 30); i++) {
      var m = filtered[i];
      var label = escapeHtml(m.name) + (m.form ? ' <span style="color:var(--text-dim);font-size:11px;">(' + escapeHtml(m.form) + ')</span>' : '');
      html += '<div class="food-search-item" data-med-id="' + escapeHtml(m.id) + '" data-med-name="' + escapeHtml(m.name + (m.form ? ' (' + m.form + ')' : '')) + '">' + label + '</div>';
    }
    dropdown.innerHTML = html;
    dropdown.style.display = 'block';

    var items = dropdown.querySelectorAll('.food-search-item');
    for (var j = 0; j < items.length; j++) {
      items[j].addEventListener('click', function () {
        var medId = this.getAttribute('data-med-id');
        var medName = this.getAttribute('data-med-name');
        var sel = document.getElementById('mpMedicineId');
        if (sel) sel.value = medId;
        var inp = document.getElementById('mpMedSearchInput');
        if (inp) inp.value = medName;
        dropdown.style.display = 'none';
      });
    }
  }

  // ── 新規薬登録 ──
  window.toggleNewMedForm = function () {
    var form = document.getElementById('mpNewMedForm');
    if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
  };

  window.registerNewMedicine = function () {
    var nameEl = document.getElementById('mpNewMedName');
    var name = nameEl ? nameEl.value.trim() : '';
    if (!name) { alert('薬名を入力してください'); return; }

    var urlEl = document.getElementById('mpNewMedUrl');
    var refUrl = urlEl && urlEl.value ? String(urlEl.value).trim() : '';

    var btn = document.querySelector('#mpNewMedForm .btn-primary');
    if (btn) { btn.disabled = true; btn.textContent = '🔍 情報取得中...'; }

    var postBody = { name: name };
    if (refUrl) postBody.reference_url = refUrl;

    fetch(API_BASE + '/health/medicines', {
      method: 'POST', headers: apiHeaders(), cache: 'no-store',
      body: JSON.stringify(postBody),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (btn) { btn.disabled = false; btn.textContent = '登録して選択'; }
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      var med = data.medicine;
      if (!Array.isArray(_medicinesList)) _medicinesList = [];
      _medicinesList.push(med);
      var sel = document.getElementById('mpMedicineId');
      if (sel) {
        var opt = document.createElement('option');
        opt.value = med.id;
        opt.textContent = med.name + (med.form ? ' (' + med.form + ')' : '');
        sel.appendChild(opt);
        sel.value = med.id;
      }
      var inp = document.getElementById('mpMedSearchInput');
      if (inp) inp.value = med.name + (med.form ? ' (' + med.form + ')' : '');
      if (nameEl) nameEl.value = '';
      if (urlEl) urlEl.value = '';
      var form = document.getElementById('mpNewMedForm');
      if (form) form.style.display = 'none';

      var msg = '「' + med.name + '」を登録しました';
      if (data.ai_enriched) {
        var details = [];
        if (med.category && med.category !== 'other') details.push('分類: ' + med.category);
        if (med.form) details.push('剤形: ' + med.form);
        if (med.generic_name) details.push('一般名: ' + med.generic_name);
        if (med.notes) details.push('備考: ' + med.notes);
        if (details.length) msg += '\n\n📋 自動取得情報:\n' + details.join('\n');
      }
      alert(msg);
    }).catch(function () {
      if (btn) { btn.disabled = false; btn.textContent = '登録して選択'; }
      alert('登録に失敗しました');
    });
  };

  // ── 頻度の切り替え ──
  window.onMpFreqChange = function () {
    var val = document.getElementById('mpFrequency') ? document.getElementById('mpFrequency').value : '';
    var wk = document.getElementById('mpFreqWeekly');
    var mo = document.getElementById('mpFreqMonthly');
    var altHint = document.getElementById('mpAlternateHint');
    var cycleHint = document.getElementById('mpCycleHint');
    if (wk) wk.style.display = val === 'weekly' ? 'block' : 'none';
    if (mo) mo.style.display = val === 'monthly' ? 'block' : 'none';
    if (altHint) altHint.style.display = (val === '隔日(A)' || val === '隔日(B)') ? '' : 'none';
    var isCycle = val === '隔日(A)' || val === '隔日(B)' || val === '3日に1回' || val === '週1回';
    if (cycleHint) cycleHint.style.display = isCycle ? '' : 'none';
  };

  function loadMedPresetItems(presetId) {
    fetch(API_BASE + '/health/medication-presets/' + presetId + '/items', { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderMedPresetItems(data.items || []);
      });
  }

  function renderMedPresetItems(items) {
    var el = document.getElementById('mpEditItemList');
    if (!el) return;
    _mpItemsCache = {};
    if (items.length === 0) {
      el.innerHTML = '<div class="empty-msg">薬が登録されていません</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      _mpItemsCache[it.id] = it;
      var slots = [];
      try { slots = JSON.parse(it.time_slots || '[]'); } catch (_) {}
      var slotLabels = '';
      for (var s = 0; s < slots.length; s++) {
        var cls = slots[s] === '朝' ? 'background:rgba(250,204,21,0.2);color:#facc15;' : slots[s] === '晩' ? 'background:rgba(129,140,248,0.2);color:#818cf8;' : 'background:rgba(74,222,128,0.15);color:#4ade80;';
        slotLabels += '<span style="display:inline-block;padding:1px 6px;border-radius:4px;font-size:10px;font-weight:600;' + cls + '">' + escapeHtml(slots[s]) + '</span> ';
      }
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 10px;background:var(--surface);border-radius:6px;margin-bottom:4px;gap:6px;">';
      html += '<div style="min-width:0;flex:1;">';
      html += '<div style="font-size:13px;font-weight:600;">' + escapeHtml(it.medicine_name || '') + '</div>';
      html += '<div style="font-size:11px;color:var(--text-dim);">';
      if (it.dosage_amount) html += it.dosage_amount + (it.dosage_unit ? escapeHtml(it.dosage_unit) : '') + ' ';
      html += escapeHtml(formatFreqLabel(it.frequency || '毎日')) + ' ';
      html += slotLabels;
      if (it.route) html += '(' + escapeHtml(it.route) + ')';
      html += '</div></div>';
      html += '<div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">';
      html += '<button type="button" class="btn-med-edit" style="background:rgba(56,189,248,0.2);color:#38bdf8;font-size:10px;" onclick="applyMedPresetItemToCat(' + it.id + ')" title="この猫にこの1件だけ適用">1件適用</button>';
      html += '<button type="button" class="btn-med-edit" onclick="startEditMedPresetItem(' + it.id + ')" title="編集">✏️</button>';
      html += '<button type="button" class="btn-med-stop" onclick="deleteMedPresetItemConfirm(' + it.id + ')" title="削除">🗑</button>';
      html += '</div></div>';
    }
    el.innerHTML = html;
  }

  window.addMedPresetItem = function () {
    var medId = document.getElementById('mpMedicineId') ? document.getElementById('mpMedicineId').value : '';
    if (!medId) { alert('薬を選択してください'); return; }
    var amount = document.getElementById('mpDosageAmount') ? parseFloat(document.getElementById('mpDosageAmount').value) : null;
    var unit = document.getElementById('mpDosageUnit') ? document.getElementById('mpDosageUnit').value : '';
    var freqSelect = document.getElementById('mpFrequency') ? document.getElementById('mpFrequency').value : '毎日';
    var route = document.getElementById('mpRoute') ? document.getElementById('mpRoute').value : '経口';

    // 頻度の値を組み立て
    var freq = freqSelect;
    if (freqSelect === 'weekly') {
      var dowChecks = document.querySelectorAll('input[name="mpDow"]:checked');
      var days = [];
      for (var d = 0; d < dowChecks.length; d++) days.push(dowChecks[d].value);
      if (days.length === 0) { alert('曜日を1つ以上選択してください'); return; }
      freq = '週:' + days.join(',');
    } else if (freqSelect === 'monthly') {
      var monthDayVal = document.getElementById('mpMonthDay') ? document.getElementById('mpMonthDay').value : '';
      if (!monthDayVal) { alert('日付を選択してください'); return; }
      if (monthDayVal === 'last') {
        freq = '月1:末日';
      } else {
        var dayOfMonth = parseInt(monthDayVal, 10);
        if (!dayOfMonth || dayOfMonth < 1 || dayOfMonth > 31) { alert('1〜31の日付を選択してください'); return; }
        freq = '月1:' + dayOfMonth;
      }
    }

    var checks = document.querySelectorAll('#mpSlotChecks input[type="checkbox"]:checked');
    var slots = [];
    for (var c = 0; c < checks.length; c++) slots.push(checks[c].value);
    if (slots.length === 0) { alert('タイミング（朝/晩）を1つ以上選択してください'); return; }

    var payload = {
      medicine_id: medId,
      dosage_amount: amount || null,
      dosage_unit: unit || null,
      frequency: freq,
      time_slots: slots,
      route: route,
    };

    var url = API_BASE + '/health/medication-presets/' + _editingMedPresetId + '/items';
    var method = 'POST';
    if (_editingMedPresetItemId) {
      url += '/' + _editingMedPresetItemId;
      method = 'PUT';
    }

    fetch(url, {
      method: method,
      headers: apiHeaders(),
      cache: 'no-store',
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      clearMedPresetItemForm();
      loadMedPresetItems(_editingMedPresetId);
    }).catch(function () { alert(method === 'PUT' ? '更新に失敗しました' : '追加に失敗しました'); });
  };

  window.deleteMedPresetItemConfirm = function (itemId) {
    if (!confirm('この薬をプリセットから削除しますか？')) return;
    fetch(API_BASE + '/health/medication-presets/' + _editingMedPresetId + '/items/' + itemId, {
      method: 'DELETE', headers: apiHeaders(), cache: 'no-store',
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data.error) { alert('エラー: ' + (data.message || data.error)); return; }
      if (String(itemId) === String(_editingMedPresetItemId)) clearMedPresetItemForm();
      loadMedPresetItems(_editingMedPresetId);
    }).catch(function () { alert('削除に失敗しました'); });
  };

  window.closeMedPresetEditModal = function (nextMedTab) {
    var editModal = document.getElementById('medPresetEditModal');
    if (editModal) editModal.classList.remove('open');
    clearMedPresetItemForm();
    _mpItemsCache = {};
    _medActiveTab = nextMedTab || 'preset';
    loadMedicationSchedule();
  };

})();
