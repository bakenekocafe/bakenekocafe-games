/**
 * NYAGI 業務連絡掲示板 (ES5)
 *
 * 拠点・ステータス（猫一覧と同一）→ 猫 → 項目 でフィルター。
 * 注意事項・病院記録・病院予定・業務連絡を統合。直近30日以内のみ、新しい順。
 */
(function () {
  'use strict';

  var API_BASE = (window.NYAGI_API_ORIGIN || '') + '/api/ops';
  var LOC_KEY = 'nyagi_dash_location';
  var STATUS_KEY = 'nyagi_dash_status';

  /** 30日（ms）— 表示・並びの基準 */
  var WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

  var LOCATIONS = [
    { id: 'all', label: '全部' },
    { id: 'cafe', label: 'CAFE' },
    { id: 'nekomata', label: '猫又' },
    { id: 'endo', label: '遠藤宅' },
    { id: 'azukari', label: '預かり' }
  ];

  var STATUSES = [
    { id: 'all', label: '全部' },
    { id: 'active', label: '在籍' },
    { id: 'adopted', label: '卒業' },
    { id: 'trial', label: 'トライアル中' }
  ];

  /** health_records.record_type 表示名（掲示板は API が病院9種のみ返す。他は猫詳細等のフォールバック。マスター: api/worker/src/ops/display-catalog.js） */
  var TYPE_LABELS = {
    vaccine: 'ワクチン',
    checkup: '健康診断',
    surgery: '手術',
    dental: '歯科',
    emergency: '緊急',
    test: '検査',
    observation: '経過観察',
    medication_start: '投薬開始',
    medication_end: '投薬終了',
    weight: '体重',
    care: 'ケア',
    eye_discharge: '目ヤニ',
    stool: '排便',
    urine: '排尿',
    urination: '排尿',
    medication: '投薬（記録）',
    medication_evening: '投薬（夜）',
    vomiting: '嘔吐',
    /** TSV 取込・日報系など DB に存在しうる種別 */
    feeding_morning: '給餌（朝）',
    feeding_evening: '給餌（夜）',
    feeding_prev_evening: '給餌（前夜）',
    stool_midday: '排便（日中）',
    churu_water: 'ちゅる・水分',
    cough: '咳',
    sneeze: 'くしゃみ',
    handover_morning: '申し送り（朝）',
    handover_evening: '申し送り（夜）',
    daily_report: '日報',
    dental_care: '歯磨き（ケア）',
  };

  /** 注意事項カード用（cat-detail のカテゴリと揃える。サーバー側マスター同期: api/worker/src/ops/display-catalog.js） */
  var NOTE_CATEGORY_LABEL_JA = {
    general: '一般',
    health: '健康',
    behavior: '行動',
    feeding: '食事',
    medication: '投薬',
    task: 'タスク関連',
    warning: '警告',
    nutrition: '栄養',
  };

  /** CSS サフィックス用（任意文字列を class に直結しない） */
  var NOTE_CATEGORY_CLASS = {
    general: 'general',
    health: 'health',
    behavior: 'behavior',
    feeding: 'feeding',
    medication: 'medication',
    task: 'task',
    warning: 'warning',
    nutrition: 'nutrition',
  };

  function noteCategoryLabelJa(cat) {
    var k = String(cat || 'general').toLowerCase();
    if (NOTE_CATEGORY_LABEL_JA[k]) return NOTE_CATEGORY_LABEL_JA[k];
    return cat ? String(cat) : '一般';
  }

  function noteCategoryClassSuffix(cat) {
    var k = String(cat || 'general').toLowerCase();
    return NOTE_CATEGORY_CLASS[k] ? NOTE_CATEGORY_CLASS[k] : 'other';
  }

  var currentLocationId = 'all';
  var currentStatusId = 'active';
  var currentCatId = 'all';
  var currentItem = 'all';
  var credentials = null;
  var viewerInfo = { staffId: '', role: '' };
  var editingBulletinId = null;
  var commentingBulletinId = null;
  var commentEditingId = null;
  var catsList = [];
  /** ステータス・拠点に合致した猫ID（注意事項・病院系のフィルタ用） */
  var allowedCatIds = {};
  var allFeedItems = [];

  var locBar = document.getElementById('locBar');
  var catFilter = document.getElementById('catFilter');
  var itemFilter = document.getElementById('itemFilter');
  var feedArea = document.getElementById('feedArea');
  var composeSection = document.getElementById('composeSection');
  var composeTitle = document.getElementById('composeTitle');
  var composeBody = document.getElementById('composeBody');
  var composeBtn = document.getElementById('composeBtn');
  var composePinned = document.getElementById('composePinned');
  var composeFiles = document.getElementById('composeFiles');
  var bulletinFoldWrap = document.getElementById('bulletinFoldWrap');
  var bulletinFoldToggle = document.getElementById('bulletinFoldToggle');
  var bulletinFoldBody = document.getElementById('bulletinFoldBody');
  var bulletinListArea = document.getElementById('bulletinListArea');
  var bulletinFoldCount = document.getElementById('bulletinFoldCount');
  var bbDisplayCatalog = document.getElementById('bbDisplayCatalog');
  var bbDisplayCatalogBody = document.getElementById('bbDisplayCatalogBody');
  var displayCatalogFetched = false;
  var displayCatalogFetching = false;
  /** 業務連絡カードの開閉（項目「すべて」のとき。項目「業務連絡」は常に開く） */
  var bulletinFoldIsOpen = false;

  /** 業務連絡カード内 Blob URL（再描画時に revoke） */
  var bulletinAttachmentBlobUrls = [];
  /** 注意事項カード（タイムライン）内 Blob URL */
  var feedNoteAttachmentBlobUrls = [];

  var BULLETIN_CLIENT_MAX_FILES = 25;
  var BULLETIN_CLIENT_MAX_FILE_BYTES = 32 * 1024 * 1024;
  var BULLETIN_CLIENT_MAX_TOTAL_BYTES = 200 * 1024 * 1024;

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function apiHeaders() {
    var h = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (credentials) {
      h['X-Admin-Key'] = credentials.adminKey || '';
      h['X-Staff-Id'] = String(credentials.staffId != null ? credentials.staffId : '');
    }
    return h;
  }

  /** multipart 用（Content-Type はブラウザ任せ） */
  function apiHeadersForm() {
    var h = { Accept: 'application/json' };
    if (credentials) {
      h['X-Admin-Key'] = credentials.adminKey || '';
      h['X-Staff-Id'] = String(credentials.staffId != null ? credentials.staffId : '');
    }
    return h;
  }

  /** 添付バイナリ取得 */
  function apiHeadersBinary() {
    var h = { Accept: '*/*' };
    if (credentials) {
      h['X-Admin-Key'] = credentials.adminKey || '';
      h['X-Staff-Id'] = String(credentials.staffId != null ? credentials.staffId : '');
    }
    return h;
  }

  function revokeBulletinAttachmentBlobs() {
    for (var i = 0; i < bulletinAttachmentBlobUrls.length; i++) {
      try {
        URL.revokeObjectURL(bulletinAttachmentBlobUrls[i]);
      } catch (_) {}
    }
    bulletinAttachmentBlobUrls = [];
  }

  function revokeFeedNoteAttachmentBlobs() {
    for (var j = 0; j < feedNoteAttachmentBlobUrls.length; j++) {
      try {
        URL.revokeObjectURL(feedNoteAttachmentBlobUrls[j]);
      } catch (_) {}
    }
    feedNoteAttachmentBlobUrls = [];
  }

  function hydrateBulletinAttachments() {
    revokeBulletinAttachmentBlobs();
    if (!bulletinListArea) return;

    var imgs = bulletinListArea.querySelectorAll(
      'img[data-bb-bid][data-bb-fid], video[data-bb-bid][data-bb-fid], iframe[data-bb-bid][data-bb-fid][data-pdf="1"]'
    );
    for (var ii = 0; ii < imgs.length; ii++) {
      (function (el) {
        var bid = el.getAttribute('data-bb-bid');
        var fid = el.getAttribute('data-bb-fid');
        var isPdfIframe = el.tagName === 'IFRAME';
        fetch(API_BASE + '/bulletin/' + bid + '/files/' + fid, {
          headers: apiHeadersBinary(),
          cache: 'no-store',
        })
          .then(function (r) {
            if (!r.ok) throw new Error('fail');
            var ct = '';
            try {
              ct = (r.headers.get('Content-Type') || '').split(';')[0].trim();
            } catch (_) {}
            return r.blob().then(function (blob) {
              // PDF は Content-Type が pdf でないと iframe ビューアが起動しないのでフォールバック
              var forceType = isPdfIframe ? 'application/pdf' : ct;
              if (forceType && (!blob.type || blob.type === 'application/octet-stream' || (isPdfIframe && blob.type !== 'application/pdf'))) {
                try {
                  return new Blob([blob], { type: forceType });
                } catch (_) {
                  return blob;
                }
              }
              return blob;
            });
          })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            bulletinAttachmentBlobUrls.push(u);
            el.src = u;
            el.style.display = 'block';
          })
          .catch(function () {
            el.style.display = 'block';
            if (el.tagName === 'VIDEO') {
              el.outerHTML = '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（動画を読み込めませんでした）</div>';
            } else if (isPdfIframe) {
              el.outerHTML = '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（PDF を読み込めませんでした）</div>';
            } else {
              el.alt = '（画像を読み込めませんでした）';
            }
          });
      })(imgs[ii]);
    }

    var links = bulletinListArea.querySelectorAll('a.bb-bull-att-file');
    for (var lj = 0; lj < links.length; lj++) {
      links[lj].addEventListener('click', onBulletinFileLinkClick);
    }
  }

  /** 注意事項カードの添付（猫ノート API）を認証付き fetch → Blob URL */
  function hydrateFeedNoteAttachments() {
    revokeFeedNoteAttachmentBlobs();
    if (!feedArea) return;

    var imgs = feedArea.querySelectorAll(
      'img[data-cn-nid][data-cn-fid], video[data-cn-nid][data-cn-fid], iframe[data-cn-nid][data-cn-fid][data-pdf="1"]'
    );
    for (var ii = 0; ii < imgs.length; ii++) {
      (function (el) {
        var nid = el.getAttribute('data-cn-nid');
        var fid = el.getAttribute('data-cn-fid');
        var isPdfIframe = el.tagName === 'IFRAME';
        fetch(
          API_BASE + '/cat-notes/' + encodeURIComponent(nid) + '/attachments/' + encodeURIComponent(fid),
          { headers: apiHeadersBinary(), cache: 'no-store' }
        )
          .then(function (r) {
            if (!r.ok) throw new Error('fail');
            var ct = '';
            try {
              ct = (r.headers.get('Content-Type') || '').split(';')[0].trim();
            } catch (_) {}
            return r.blob().then(function (blob) {
              var forceType = isPdfIframe ? 'application/pdf' : ct;
              if (forceType && (!blob.type || blob.type === 'application/octet-stream' || (isPdfIframe && blob.type !== 'application/pdf'))) {
                try {
                  return new Blob([blob], { type: forceType });
                } catch (_) {
                  return blob;
                }
              }
              return blob;
            });
          })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            feedNoteAttachmentBlobUrls.push(u);
            el.src = u;
            el.style.display = 'block';
          })
          .catch(function () {
            el.style.display = 'block';
            if (el.tagName === 'VIDEO') {
              el.outerHTML =
                '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（動画を読み込めませんでした）</div>';
            } else if (isPdfIframe) {
              el.outerHTML =
                '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（PDF を読み込めませんでした）</div>';
            } else {
              el.alt = '（添付を読み込めませんでした）';
            }
          });
      })(imgs[ii]);
    }

    var nlinks = feedArea.querySelectorAll('a.bb-note-att-file');
    for (var nk = 0; nk < nlinks.length; nk++) {
      nlinks[nk].addEventListener('click', onCatNoteFileLinkClick);
    }

    // 病院記録（health_records）の添付 — 画像/動画/PDF を認証付き fetch → Blob URL
    var hrMedia = feedArea.querySelectorAll(
      'img[data-hr-rid][data-hr-fid], video[data-hr-rid][data-hr-fid], iframe[data-hr-rid][data-hr-fid][data-pdf="1"]'
    );
    for (var hi = 0; hi < hrMedia.length; hi++) {
      (function (el) {
        var rid = el.getAttribute('data-hr-rid');
        var fid = el.getAttribute('data-hr-fid');
        var isPdfIframe = el.tagName === 'IFRAME';
        fetch(
          API_BASE + '/health/records/' + encodeURIComponent(rid) + '/files/' + encodeURIComponent(fid),
          { headers: apiHeadersBinary(), cache: 'no-store' }
        )
          .then(function (r) {
            if (!r.ok) throw new Error('fail');
            var ct = '';
            try { ct = (r.headers.get('Content-Type') || '').split(';')[0].trim(); } catch (_) {}
            return r.blob().then(function (blob) {
              var forceType = isPdfIframe ? 'application/pdf' : ct;
              if (forceType && (!blob.type || blob.type === 'application/octet-stream' || (isPdfIframe && blob.type !== 'application/pdf'))) {
                try { return new Blob([blob], { type: forceType }); } catch (_) { return blob; }
              }
              return blob;
            });
          })
          .then(function (blob) {
            var u = URL.createObjectURL(blob);
            feedNoteAttachmentBlobUrls.push(u);
            el.src = u;
            el.style.display = 'block';
          })
          .catch(function () {
            el.style.display = 'block';
            if (el.tagName === 'VIDEO') {
              el.outerHTML = '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（動画を読み込めませんでした）</div>';
            } else if (isPdfIframe) {
              el.outerHTML = '<div class="bb-bull-att-vid-fail" style="font-size:12px;color:#f87171;">（PDF を読み込めませんでした）</div>';
            } else {
              el.alt = '（添付を読み込めませんでした）';
            }
          });
      })(hrMedia[hi]);
    }

    var hrLinks = feedArea.querySelectorAll('a.bb-hr-att-file');
    for (var hk = 0; hk < hrLinks.length; hk++) {
      hrLinks[hk].addEventListener('click', onHealthRecordFileLinkClick);
    }
  }

  function onHealthRecordFileLinkClick(e) {
    e.preventDefault();
    var a = e.currentTarget;
    var rid = a.getAttribute('data-hr-rid');
    var fid = a.getAttribute('data-hr-fid');
    fetch(
      API_BASE + '/health/records/' + encodeURIComponent(rid) + '/files/' + encodeURIComponent(fid),
      { headers: apiHeadersBinary(), cache: 'no-store' }
    )
      .then(function (r) {
        if (!r.ok) throw new Error('fail');
        var ct = '';
        try { ct = (r.headers.get('Content-Type') || '').split(';')[0].trim(); } catch (_) {}
        return r.blob().then(function (blob) {
          if (ct && (!blob.type || blob.type === 'application/octet-stream')) {
            try { return new Blob([blob], { type: ct }); } catch (_) { return blob; }
          }
          return blob;
        });
      })
      .then(function (blob) {
        var u = URL.createObjectURL(blob);
        feedNoteAttachmentBlobUrls.push(u);
        window.open(u, '_blank', 'noopener,noreferrer');
      })
      .catch(function () { alert('ファイルを開けませんでした'); });
  }

  function onCatNoteFileLinkClick(e) {
    e.preventDefault();
    var a = e.currentTarget;
    var nid = a.getAttribute('data-cn-nid');
    var fid = a.getAttribute('data-cn-fid');
    fetch(
      API_BASE + '/cat-notes/' + encodeURIComponent(nid) + '/attachments/' + encodeURIComponent(fid),
      { headers: apiHeadersBinary(), cache: 'no-store' }
    )
      .then(function (r) {
        if (!r.ok) throw new Error('fail');
        var ct = '';
        try {
          ct = (r.headers.get('Content-Type') || '').split(';')[0].trim();
        } catch (_) {}
        return r.blob().then(function (blob) {
          if (ct && (!blob.type || blob.type === 'application/octet-stream')) {
            try {
              return new Blob([blob], { type: ct });
            } catch (_) {
              return blob;
            }
          }
          return blob;
        });
      })
      .then(function (blob) {
        var u = URL.createObjectURL(blob);
        feedNoteAttachmentBlobUrls.push(u);
        window.open(u, '_blank', 'noopener,noreferrer');
      })
      .catch(function () {
        alert('ファイルを開けませんでした');
      });
  }

  function onBulletinFileLinkClick(e) {
    e.preventDefault();
    var a = e.currentTarget;
    var bid = a.getAttribute('data-bb-bid');
    var fid = a.getAttribute('data-bb-fid');
    fetch(API_BASE + '/bulletin/' + bid + '/files/' + fid, {
      headers: apiHeadersBinary(),
      cache: 'no-store',
    })
      .then(function (r) {
        if (!r.ok) throw new Error('fail');
        var ct = '';
        try {
          ct = (r.headers.get('Content-Type') || '').split(';')[0].trim();
        } catch (_) {}
        return r.blob().then(function (blob) {
          if (ct && (!blob.type || blob.type === 'application/octet-stream')) {
            try {
              return new Blob([blob], { type: ct });
            } catch (_) {
              return blob;
            }
          }
          return blob;
        });
      })
      .then(function (blob) {
        var u = URL.createObjectURL(blob);
        bulletinAttachmentBlobUrls.push(u);
        window.open(u, '_blank', 'noopener,noreferrer');
      })
      .catch(function () {
        alert('ファイルを開けませんでした');
      });
  }

  /**
   * タイムゾーン関連は `js/nyagi-jst.js`（window.NyagiJst）に集中させた。
   * 下記ローカル関数は後方互換のための薄いラッパー（すべて NyagiJst に委譲）。
   */
  if (!window.NyagiJst) {
    /** bulletin.html が nyagi-jst.js を読み込み忘れたとき早期に気付く */
    console.error('NyagiJst が見つかりません。bulletin.html に js/nyagi-jst.js を読み込んでください。');
  }
  var Jst = window.NyagiJst;

  function pad2(n) { return Jst.pad2(n); }
  function jstTodayYmd() { return Jst.todayYmd(); }
  function jstYear() { return Jst.year(); }
  function normalizeToYmd(s) { return Jst.normalizeYmd(s); }
  function ymdToUtcMs(ymd) { return Jst.ymdToUtcMidnightMs(ymd); }
  /** D1/SQLite の TZ 無し日時は UTC として解釈（NyagiJst.parseDbMs が処理） */
  function parseSqliteAsJstMs(s) { return Jst.parseDbMs(s); }
  function parseDbDateTime(s) { return Jst.parseDbMs(s); }
  function formatWesternYmd(ymd) { return Jst.formatWesternYmd(ymd); }
  function formatWesternDateTime(iso) { return Jst.formatWesternDateTime(iso); }
  function toDateInputString(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && !isNaN(v)) {
      try {
        var d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString();
      } catch (_) {}
      return '';
    }
    return typeof v === 'string' ? v : String(v);
  }

  function locationQuery() {
    if (!currentLocationId || currentLocationId === 'all') return '';
    return currentLocationId;
  }

  function computeSortMs(item) {
    var d;
    if (item.type === 'note') {
      d = item.data;
      var nMs = parseSqliteAsJstMs(d.created_at);
      if (!isNaN(nMs)) return nMs;
      var ny = ymdToUtcMs(normalizeToYmd(d.created_at));
      return isNaN(ny) ? 0 : ny;
    }
    if (item.type === 'clinic') {
      d = item.data;
      var ymd = normalizeToYmd(d.record_date);
      var rMs = ymd ? ymdToUtcMs(ymd) : NaN;
      if (!isNaN(rMs)) return rMs;
      var cMs = parseSqliteAsJstMs(d.created_at);
      if (!isNaN(cMs)) return cMs;
      var cy = ymdToUtcMs(normalizeToYmd(d.created_at));
      return isNaN(cy) ? 0 : cy;
    }
    if (item.type === 'schedule') {
      d = item.data;
      /**
       * next_due だけで並べると「来年の予定」が先頭に来て日付順が崩れる。
       * タイムラインは「登録・更新が新しい順」＝ created_at を優先。
       */
      var sc = parseSqliteAsJstMs(d.created_at);
      if (!isNaN(sc)) return sc;
      var nd = normalizeToYmd(d.next_due);
      var dueMs = nd ? ymdToUtcMs(nd) : NaN;
      return isNaN(dueMs) ? 0 : dueMs;
    }
    if (item.type === 'bulletin') {
      d = item.data;
      var bMs = parseSqliteAsJstMs(d.created_at);
      if (!isNaN(bMs)) return bMs;
      var by = ymdToUtcMs(normalizeToYmd(d.created_at));
      return isNaN(by) ? 0 : by;
    }
    return 0;
  }

  /** 予定だけ、古い created_at でも直近の next_due なら30日枠に含める */
  function passesTimeWindow(item, sortMs, cutoff) {
    if (!isNaN(sortMs) && sortMs >= cutoff) return true;
    if (item.type === 'schedule' && item.data) {
      var nd = normalizeToYmd(item.data.next_due);
      if (!nd) return false;
      var dueMs = ymdToUtcMs(nd);
      var todayMs = ymdToUtcMs(jstTodayYmd());
      var ahead = Math.round((dueMs - todayMs) / 86400000);
      return ahead >= -30 && ahead <= 120;
    }
    /** computeSortMs が 0 になるのは主に日時型の取り違え（数値 ms 等）— 生データで再判定 */
    if (item.data) {
      var raw =
        item.type === 'note'
          ? item.data.created_at
          : item.type === 'clinic'
            ? item.data.record_date || item.data.created_at
            : item.data.created_at;
      var retry = parseSqliteAsJstMs(toDateInputString(raw));
      if (!isNaN(retry) && retry >= cutoff) return true;
      var y2 = ymdToUtcMs(normalizeToYmd(raw));
      if (!isNaN(y2) && y2 >= cutoff) return true;
    }
    return false;
  }

  function tieBreakId(item) {
    if (!item || !item.data || item.data.id == null) return 0;
    var n = Number(item.data.id);
    return isNaN(n) ? 0 : n;
  }

  /** カード右上に出す基準日（西暦付き） */
  function computeDisplayDate(item) {
    var d;
    if (item.type === 'note') {
      d = item.data;
      return formatWesternDateTime(d.created_at);
    }
    if (item.type === 'clinic') {
      d = item.data;
      var ymd = normalizeToYmd(d.record_date);
      if (ymd) return formatWesternYmd(ymd);
      return formatWesternDateTime(d.created_at);
    }
    if (item.type === 'schedule') {
      d = item.data;
      var nd = normalizeToYmd(d.next_due);
      if (nd) return formatWesternYmd(nd);
      return formatWesternDateTime(d.created_at);
    }
    if (item.type === 'bulletin') {
      d = item.data;
      return formatWesternDateTime(d.created_at);
    }
    return '';
  }

  // ── 認証 ──────────────────────────────────────────
  function loadCredentials() {
    try {
      var raw = localStorage.getItem('nyagi_creds');
      if (raw) {
        credentials = JSON.parse(raw);
        return;
      }
    } catch (_) {}
    try {
      var m = document.cookie.match(/(?:^|; )nyagi_creds=([^;]*)/);
      if (m && m[1]) {
        var ck = decodeURIComponent(m[1]);
        credentials = JSON.parse(ck);
        try {
          localStorage.setItem('nyagi_creds', ck);
        } catch (_) {}
      }
    } catch (_) {}
  }

  // ── 拠点・ステータスフィルター ────────────────────
  function renderFilterBars() {
    if (!locBar) return;
    try {
      currentLocationId = localStorage.getItem(LOC_KEY) || 'all';
      currentStatusId = localStorage.getItem(STATUS_KEY) || 'active';
    } catch (_) {}

    var html = '<div class="filter-row"><span class="filter-label">拠点</span>';
    for (var i = 0; i < LOCATIONS.length; i++) {
      var loc = LOCATIONS[i];
      var la = loc.id === currentLocationId ? ' active' : '';
      html += '<button type="button" class="loc-btn' + la + '" data-loc="' + esc(loc.id) + '">' + esc(loc.label) + '</button>';
    }
    html += '</div><div class="filter-row"><span class="filter-label">ステータス</span>';
    for (var j = 0; j < STATUSES.length; j++) {
      var st = STATUSES[j];
      var sa = st.id === currentStatusId ? ' active' : '';
      html += '<button type="button" class="loc-btn' + sa + '" data-status="' + esc(st.id) + '">' + esc(st.label) + '</button>';
    }
    html += '</div>';
    locBar.innerHTML = html;

    var forEach = Array.prototype.forEach;
    forEach.call(locBar.querySelectorAll('[data-loc]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-loc');
        if (id === currentLocationId) return;
        currentLocationId = id;
        try { localStorage.setItem(LOC_KEY, id); } catch (_) {}
        forEach.call(locBar.querySelectorAll('[data-loc]'), function (b) {
          b.classList.toggle('active', b.getAttribute('data-loc') === id);
        });
        currentCatId = 'all';
        fetchAll();
      });
    });
    forEach.call(locBar.querySelectorAll('[data-status]'), function (btn) {
      btn.addEventListener('click', function () {
        var id = this.getAttribute('data-status');
        if (id === currentStatusId) return;
        currentStatusId = id;
        try { localStorage.setItem(STATUS_KEY, id); } catch (_) {}
        forEach.call(locBar.querySelectorAll('[data-status]'), function (b) {
          b.classList.toggle('active', b.getAttribute('data-status') === id);
        });
        currentCatId = 'all';
        fetchAll();
      });
    });
  }

  // ── 猫一覧取得 & プルダウン更新 ────────────────────
  function fetchCatsList() {
    var locQ = locationQuery();
    var url = API_BASE + '/cats/overview?location=' + encodeURIComponent(locQ || 'all');
    var st = currentStatusId || 'active';
    url += '&status=' + encodeURIComponent(st);

    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        catsList = (data.cats || []).map(function (c) { return { id: c.id, name: c.name }; });
        catsList.sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
        allowedCatIds = {};
        for (var i = 0; i < catsList.length; i++) {
          allowedCatIds[String(catsList[i].id)] = 1;
        }
        updateCatDropdown();
      })
      .catch(function () {
        catsList = [];
        allowedCatIds = {};
        updateCatDropdown();
      });
  }

  function catAllowed(catId) {
    if (catId == null || catId === '') return false;
    return !!allowedCatIds[String(catId)];
  }

  function updateCatDropdown() {
    if (!catFilter) return;
    var html = '<option value="all">すべて</option>';
    for (var i = 0; i < catsList.length; i++) {
      var c = catsList[i];
      var sel = c.id === currentCatId ? ' selected' : '';
      html += '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.name) + '</option>';
    }
    catFilter.innerHTML = html;
  }

  // ── データ取得 ────────────────────────────────────
  function fetchAll() {
    feedArea.innerHTML = '<div class="bb-loading">読み込み中…</div>';
    allFeedItems = [];

    fetchCatsList().then(function () {
      return Promise.all([fetchNotes(), fetchClinicRecords(), fetchBulletinMessages()]);
    }).then(function () {
      renderFeed();
    }).catch(function () {
      feedArea.innerHTML = '<div class="bb-empty">データの取得に失敗しました。</div>';
    });
  }

  function fetchNotes() {
    var locQ = locationQuery();
    if (!locQ) {
      return fetchNotesAllLocations();
    }
    var url = API_BASE + '/cat-notes?location=' + encodeURIComponent(locQ) + '&limit=300&order=created_at';

    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.viewer) {
          viewerInfo.staffId = data.viewer.staff_id || viewerInfo.staffId;
          viewerInfo.role = data.viewer.role || viewerInfo.role;
        }
        var notes = data.notes || [];
        for (var i = 0; i < notes.length; i++) {
          var n = notes[i];
          if (!catAllowed(n.cat_id)) continue;
          allFeedItems.push({
            type: 'note',
            catId: n.cat_id,
            catName: n.cat_name || '',
            pinned: n.pinned,
            data: n
          });
        }
      }).catch(function () {});
  }

  function fetchNotesAllLocations() {
    var locs = ['cafe', 'nekomata', 'endo', 'azukari'];
    var promises = locs.map(function (loc) {
      var url = API_BASE + '/cat-notes?location=' + encodeURIComponent(loc) + '&limit=200&order=created_at';
      return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && data.viewer) {
            viewerInfo.staffId = data.viewer.staff_id || viewerInfo.staffId;
            viewerInfo.role = data.viewer.role || viewerInfo.role;
          }
          var notes = data.notes || [];
          for (var i = 0; i < notes.length; i++) {
            var n = notes[i];
            if (!catAllowed(n.cat_id)) continue;
            allFeedItems.push({
              type: 'note',
              catId: n.cat_id,
              catName: n.cat_name || '',
              pinned: n.pinned,
              data: n
            });
          }
        }).catch(function () {});
    });
    return Promise.all(promises);
  }

  function fetchClinicRecords() {
    /**
     * match_cats_context: API 側で cats の現拠点・ステータスに一致する猫の病院記録だけ取得。
     * 全猫グローバル上位500件だと、他猫の記録で枠を埋めてギザ等の直近が落ちるため必須。
     */
    var url =
      API_BASE +
      '/health/records?scope=clinic&limit=400&match_cats_context=1' +
      '&filter_cat_location=' +
      encodeURIComponent(currentLocationId || 'all') +
      '&filter_cat_status=' +
      encodeURIComponent(currentStatusId || 'active');

    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.viewer) {
          viewerInfo.staffId = data.viewer.staff_id || viewerInfo.staffId;
          viewerInfo.role = data.viewer.role || viewerInfo.role;
        }
        var recs = data.records || [];
        for (var i = 0; i < recs.length; i++) {
          var r = recs[i];
          if (!catAllowed(r.cat_id)) continue;
          var isSchedule = !!r.next_due;
          allFeedItems.push({
            type: isSchedule ? 'schedule' : 'clinic',
            catId: r.cat_id,
            catName: r.cat_name || '',
            data: r
          });
        }
      }).catch(function () {});
  }

  function fetchBulletinMessages() {
    var locQ = locationQuery();
    var url = API_BASE + '/bulletin?limit=80';
    if (locQ) url += '&location=' + encodeURIComponent(locQ);

    return fetch(url, { headers: apiHeaders(), cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.viewer) {
          viewerInfo.staffId = data.viewer.staff_id || '';
          viewerInfo.role = data.viewer.role || '';
        }
        var msgs = data.messages || [];
        for (var i = 0; i < msgs.length; i++) {
          var m = msgs[i];
          allFeedItems.push({
            type: 'bulletin',
            catId: null,
            catName: '',
            pinned: m.pinned,
            data: m
          });
        }
      }).catch(function () {});
  }

  function isOwnerOrAuthor(rowStaffId) {
    if (!viewerInfo) return false;
    if (viewerInfo.role === 'owner') return true;
    var my = viewerInfo.staffId ? String(viewerInfo.staffId) : '';
    var target = rowStaffId != null ? String(rowStaffId) : '';
    return !!my && !!target && my === target;
  }

  function applyBulletinFoldDOM() {
    var open = bulletinFoldIsOpen || currentItem === 'bulletin';
    if (bulletinFoldWrap) bulletinFoldWrap.classList.toggle('open', open);
    if (bulletinFoldToggle) {
      bulletinFoldToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      var forced = currentItem === 'bulletin';
      bulletinFoldToggle.disabled = !!forced;
      bulletinFoldToggle.style.opacity = forced ? '0.92' : '';
    }
    if (bulletinFoldBody) {
      if (open) bulletinFoldBody.removeAttribute('hidden');
      else bulletinFoldBody.setAttribute('hidden', '');
    }
  }

  function renderBulletinSection(bulletinPrepared) {
    if (!bulletinListArea || !bulletinFoldCount) return;
    bulletinFoldCount.textContent = String(bulletinPrepared.length);
    var html = '';
    if (bulletinPrepared.length === 0) {
      html = '<div class="bb-empty" style="padding:16px 8px;">業務連絡はありません</div>';
    } else {
      for (var bi = 0; bi < bulletinPrepared.length; bi++) {
        html += renderBulletinCard(bulletinPrepared[bi]);
      }
    }
    bulletinListArea.innerHTML = html;
    bindBulletinDeleteButtons();
    hydrateBulletinAttachments();
    applyBulletinFoldDOM();
  }

  function findBulletinById(id) {
    var sid = String(id);
    for (var i = 0; i < allFeedItems.length; i++) {
      if (allFeedItems[i].type !== 'bulletin') continue;
      var m = allFeedItems[i].data;
      if (m && String(m.id) === sid) return m;
    }
    return null;
  }

  function findCommentById(bulletinId, commentId) {
    var m = findBulletinById(bulletinId);
    if (!m) return null;
    var list = m.comments || [];
    var sid = String(commentId);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === sid) return list[i];
    }
    return null;
  }

  /**
   * 掲示板に出る全てのカードのアクション（追記 / 編集 / 削除）を
   * bulletinListArea と feedArea の両方にバインドする。
   */
  function findFeedItem(entityType, entityId) {
    var sid = String(entityId);
    var want = entityType === 'bulletin' ? ['bulletin'] : entityType === 'note' ? ['note'] : ['clinic', 'schedule'];
    for (var i = 0; i < allFeedItems.length; i++) {
      var it = allFeedItems[i];
      if (want.indexOf(it.type) === -1) continue;
      var d = it.data || {};
      if (d.id != null && String(d.id) === sid) return it;
    }
    return null;
  }

  function findCommentByIdAnyEntity(entityType, entityId, commentId) {
    var it = findFeedItem(entityType, entityId);
    if (!it) return null;
    var list = (it.data && it.data.comments) || [];
    var sid = String(commentId);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === sid) return list[i];
    }
    return null;
  }

  function entityLabelJa(entityType) {
    if (entityType === 'bulletin') return '業務連絡';
    if (entityType === 'note') return '注意事項';
    if (entityType === 'clinic') return '病院記録';
    return '項目';
  }

  function bindFeedActionButtons() {
    var areas = [bulletinListArea, feedArea];
    for (var a = 0; a < areas.length; a++) {
      var area = areas[a];
      if (!area) continue;

      var delBtns = area.querySelectorAll('[data-thread-del="1"]');
      for (var d = 0; d < delBtns.length; d++) {
        delBtns[d].addEventListener('click', function () {
          var et = this.getAttribute('data-entity-type');
          var eid = this.getAttribute('data-entity-id');
          if (confirm('この' + entityLabelJa(et) + 'を削除しますか？')) {
            deleteEntity(et, eid);
          }
        });
      }
      var editBtns = area.querySelectorAll('[data-thread-edit="1"]');
      for (var e = 0; e < editBtns.length; e++) {
        editBtns[e].addEventListener('click', function () {
          openEditModal(this.getAttribute('data-entity-type'), this.getAttribute('data-entity-id'));
        });
      }
      var commentBtns = area.querySelectorAll('[data-thread-comment="1"]');
      for (var c = 0; c < commentBtns.length; c++) {
        commentBtns[c].addEventListener('click', function () {
          openCommentModal(this.getAttribute('data-entity-type'), this.getAttribute('data-entity-id'), null);
        });
      }
      var cEditBtns = area.querySelectorAll('[data-edit-comment]');
      for (var ce = 0; ce < cEditBtns.length; ce++) {
        cEditBtns[ce].addEventListener('click', function () {
          openCommentModal(
            this.getAttribute('data-entity-type'),
            this.getAttribute('data-entity-id'),
            this.getAttribute('data-edit-comment')
          );
        });
      }
      var cDelBtns = area.querySelectorAll('[data-del-comment]');
      for (var cd = 0; cd < cDelBtns.length; cd++) {
        cDelBtns[cd].addEventListener('click', function () {
          if (!confirm('この追記を削除しますか？')) return;
          deleteThreadComment(this.getAttribute('data-del-comment'));
        });
      }
    }
  }

  // 旧名互換
  function bindBulletinDeleteButtons() { bindFeedActionButtons(); }

  // ── フィード描画 ──────────────────────────────────
  function renderFeed() {
    var now = Date.now();
    var cutoff = now - WINDOW_MS;

    var bulletinPrepared = [];
    var mainPrepared = [];
    for (var i = 0; i < allFeedItems.length; i++) {
      var raw = allFeedItems[i];
      var sortMs = computeSortMs(raw);
      if (!passesTimeWindow(raw, sortMs, cutoff)) continue;
      raw._sortMs = sortMs;
      raw._displayDate = computeDisplayDate(raw);
      if (raw.type === 'bulletin') bulletinPrepared.push(raw);
      else mainPrepared.push(raw);
    }

    bulletinPrepared.sort(function (a, b) {
      var ma = Number(a._sortMs) || 0;
      var mb = Number(b._sortMs) || 0;
      if (mb !== ma) return mb - ma;
      return tieBreakId(b) - tieBreakId(a);
    });

    var mainFiltered = filterMainFeedItems(mainPrepared);
    mainFiltered.sort(function (a, b) {
      var ma2 = Number(a._sortMs) || 0;
      var mb2 = Number(b._sortMs) || 0;
      if (mb2 !== ma2) return mb2 - ma2;
      return tieBreakId(b) - tieBreakId(a);
    });

    if (currentItem === 'notes' || currentItem === 'clinic' || currentItem === 'schedule') {
      if (bulletinFoldWrap) bulletinFoldWrap.style.display = 'none';
    } else {
      if (bulletinFoldWrap) bulletinFoldWrap.style.display = '';
      renderBulletinSection(bulletinPrepared);
    }

    if (currentItem === 'bulletin') {
      feedArea.innerHTML =
        '<div class="bb-empty">業務連絡は上部の「業務連絡」カード内に表示しています</div>';
      hydrateFeedNoteAttachments();
      return;
    }

    if (mainFiltered.length === 0) {
      feedArea.innerHTML = '<div class="bb-empty">該当する情報はありません（直近30日以内）</div>';
      hydrateFeedNoteAttachments();
      return;
    }

    var html = '';
    for (var j = 0; j < mainFiltered.length; j++) {
      html += renderCard(mainFiltered[j]);
    }
    feedArea.innerHTML = html;
    hydrateFeedNoteAttachments();
    bindFeedActionButtons();
  }

  function filterMainFeedItems(items) {
    var result = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      if (it.type === 'bulletin') continue;
      if (currentCatId !== 'all' && it.catId !== currentCatId) continue;
      if (currentItem !== 'all') {
        if (currentItem === 'notes' && it.type !== 'note') continue;
        if (currentItem === 'clinic' && it.type !== 'clinic') continue;
        if (currentItem === 'schedule' && it.type !== 'schedule') continue;
      }
      result.push(it);
    }
    return result;
  }

  function renderCard(item) {
    if (item.type === 'note') return renderNoteCard(item);
    if (item.type === 'clinic') return renderClinicCard(item);
    if (item.type === 'schedule') return renderScheduleCard(item);
    return '';
  }

  /**
   * 本文テキストを「URL リンク化＋Google Drive の iframe プレビュー付き」で描画する共通ヘルパ。
   * NyagiDriveEmbed が読み込まれていれば委譲、無ければ esc() にフォールバック。
   */
  function renderBodyWithDrive(text) {
    if (window.NyagiDriveEmbed && typeof window.NyagiDriveEmbed.renderText === 'function') {
      return window.NyagiDriveEmbed.renderText(String(text == null ? '' : text));
    }
    return { html: esc(String(text == null ? '' : text)), embeds: '', drives: [] };
  }

  /** 注意事項（猫ノート）の添付 HTML — 掲示板タイムラインで画像を表示する */
  function renderCatNoteAttRow(noteId, att) {
    var mime = String(att.mime_type || '');
    var on = att.original_name;
    var isImg = bulletinAttLooksImage(on, mime);
    var isVid = !isImg && bulletinAttLooksVideo(on, mime);
    var isPdf = !isImg && !isVid && bulletinAttLooksPdf(on, mime);
    var label = esc(String(att.original_name || 'ファイル').slice(0, 120));
    var nid = esc(String(noteId));
    var fid = esc(String(att.id));
    if (isImg) {
      return (
        '<div><img class="bb-bull-att-img" alt="" data-cn-nid="' +
        nid +
        '" data-cn-fid="' +
        fid +
        '" style="display:none"/></div>'
      );
    }
    if (isVid) {
      return (
        '<div><video class="bb-bull-att-video" controls playsinline preload="metadata" data-cn-nid="' +
        nid +
        '" data-cn-fid="' +
        fid +
        '" style="display:none"></video></div>'
      );
    }
    if (isPdf) {
      return (
        '<div class="bb-bull-att-pdf-wrap">' +
        '<iframe class="bb-bull-att-pdf" data-cn-nid="' + nid + '" data-cn-fid="' + fid +
        '" data-pdf="1" title="PDF プレビュー" style="display:none"></iframe>' +
        '<a href="#" class="bb-bull-att-link bb-note-att-file" data-cn-nid="' + nid +
        '" data-cn-fid="' + fid + '">📎 ' + label + '（別タブで開く）</a>' +
        '</div>'
      );
    }
    return (
      '<div><a href="#" class="bb-bull-att-link bb-note-att-file" data-cn-nid="' +
      nid +
      '" data-cn-fid="' +
      fid +
      '">📎 ' +
      label +
      '</a></div>'
    );
  }

  function renderCatNoteAttachmentsHtml(noteId, n) {
    var atts = [];
    if (n.attachments && n.attachments.length) {
      for (var zi = 0; zi < n.attachments.length; zi++) atts.push(n.attachments[zi]);
    } else if (n.attachment_file_id) {
      atts.push({
        id: n.attachment_file_id,
        original_name:
          n.attachment_mime && String(n.attachment_mime).indexOf('pdf') !== -1 ? 'attachment.pdf' : 'image.jpg',
        mime_type: n.attachment_mime || '',
      });
    }
    if (!atts.length) return '';
    var h = '<div class="bb-bull-atts">';
    for (var aj = 0; aj < atts.length; aj++) {
      h += renderCatNoteAttRow(noteId, atts[aj]);
    }
    h += '</div>';
    return h;
  }

  function renderNoteCard(item) {
    var n = item.data;
    var pinIcon = n.pinned ? '<span style="color:#facc15;">📌</span> ' : '';
    var catLabel = item.catName ? esc(item.catName) : esc(n.cat_id);
    var staffLabel = n.staff_name ? ' / ' + esc(n.staff_name) : '';
    var dateStr = item._displayDate || computeDisplayDate(item);
    var catJa = noteCategoryLabelJa(n.category);
    var catCls = noteCategoryClassSuffix(n.category);
    var attBlock = renderCatNoteAttachmentsHtml(n.id, n);
    var noteRendered = renderBodyWithDrive(n.note || '');
    return '<div class="bb-card">' +
      '<div class="bb-card-head">' +
        '<div>' + pinIcon + '<span class="bb-type-badge bb-type-note">注意事項</span>' +
        '<span class="bb-note-cat bb-note-cat--' + esc(catCls) + '">' + esc(catJa) + '</span>' +
        '<span class="bb-cat-name">' + catLabel + '</span></div>' +
        '<span class="bb-date">' + esc(dateStr) + staffLabel + '</span>' +
      '</div>' +
      '<div class="bb-card-body" style="white-space:pre-wrap;word-break:break-word;">' + noteRendered.html + '</div>' +
      (noteRendered.embeds || '') +
      attBlock +
      renderThreadComments('note', n.id, n.comments) +
      renderThreadActions('note', n.id, n.staff_id) +
    '</div>';
  }

  /** 病院記録（health_records）の添付 HTML — 画像/動画/PDF はインラインプレビュー、他はリンク */
  function renderClinicAttRow(recordId, att) {
    var mime = String(att.mime_type || '');
    var on = att.original_name;
    var isImg = bulletinAttLooksImage(on, mime);
    var isVid = !isImg && bulletinAttLooksVideo(on, mime);
    var isPdf = !isImg && !isVid && bulletinAttLooksPdf(on, mime);
    var label = esc(String(att.original_name || 'ファイル').slice(0, 120));
    var rid = esc(String(recordId));
    var fid = esc(String(att.id));
    if (isImg) {
      return (
        '<div><img class="bb-bull-att-img" alt=""' +
        ' data-hr-rid="' + rid + '" data-hr-fid="' + fid + '" style="display:none"/></div>'
      );
    }
    if (isVid) {
      return (
        '<div><video class="bb-bull-att-video" controls playsinline preload="metadata"' +
        ' data-hr-rid="' + rid + '" data-hr-fid="' + fid + '" style="display:none"></video></div>'
      );
    }
    if (isPdf) {
      return (
        '<div class="bb-bull-att-pdf-wrap">' +
        '<iframe class="bb-bull-att-pdf" data-hr-rid="' + rid + '" data-hr-fid="' + fid +
        '" data-pdf="1" title="PDF プレビュー" style="display:none"></iframe>' +
        '<a href="#" class="bb-bull-att-link bb-hr-att-file" data-hr-rid="' + rid +
        '" data-hr-fid="' + fid + '">📎 ' + label + '（別タブで開く）</a>' +
        '</div>'
      );
    }
    return (
      '<div><a href="#" class="bb-bull-att-link bb-hr-att-file"' +
      ' data-hr-rid="' + rid + '" data-hr-fid="' + fid + '">📎 ' + label + '</a></div>'
    );
  }

  function renderClinicAttachmentsHtml(r) {
    var atts = r && r.attachments && r.attachments.length ? r.attachments : [];
    if (!atts.length) return '';
    var h = '<div class="bb-bull-atts">';
    for (var i = 0; i < atts.length; i++) h += renderClinicAttRow(r.id, atts[i]);
    h += '</div>';
    return h;
  }

  function renderClinicCard(item) {
    var r = item.data;
    var typeLabel = TYPE_LABELS[r.record_type] || r.record_type || '';
    var catLabel = item.catName ? esc(item.catName) : esc(r.cat_id);
    var parsed = null;
    try { parsed = typeof r.details === 'string' ? JSON.parse(r.details) : r.details; } catch (_) {}
    var noteText = '';
    if (parsed) {
      if (parsed.note) noteText = String(parsed.note);
      else if (parsed.reason) noteText = String(parsed.reason);
    }
    var clinicName = parsed && parsed.clinic_name ? String(parsed.clinic_name).trim() : '';
    var clinicLabel = clinicName ? ' <span style="color:#a5b4fc;font-size:11px;">🏥 ' + esc(clinicName) + '</span>' : '';
    var recorderLabel = r.recorder_name ? ' / ' + esc(r.recorder_name) : '';
    var dateStr = item._displayDate || computeDisplayDate(item);

    var noteBlock = '';
    if (noteText) {
      var rendered = renderBodyWithDrive(noteText);
      noteBlock = '<div class="bb-card-body" style="white-space:pre-wrap;word-break:break-word;">' + rendered.html + '</div>' + (rendered.embeds || '');
    }
    return '<div class="bb-card">' +
      '<div class="bb-card-head">' +
        '<div><span class="bb-type-badge bb-type-clinic">' + esc(typeLabel) + '</span><span class="bb-cat-name">' + catLabel + '</span>' + clinicLabel + '</div>' +
        '<span class="bb-date">' + esc(dateStr) + recorderLabel + '</span>' +
      '</div>' +
      noteBlock +
      renderClinicAttachmentsHtml(r) +
      renderThreadComments('clinic', r.id, r.comments) +
      renderThreadActions('clinic', r.id, r.recorded_by) +
    '</div>';
  }

  function renderScheduleCard(item) {
    var r = item.data;
    var typeLabel = TYPE_LABELS[r.record_type] || r.record_type || '';
    var catLabel = item.catName ? esc(item.catName) : esc(r.cat_id);
    var nextDueRaw = r.next_due || '';
    var nextYmd = normalizeToYmd(nextDueRaw);
    var parsed = null;
    try { parsed = typeof r.details === 'string' ? JSON.parse(r.details) : r.details; } catch (_) {}
    var clinicName = parsed && parsed.clinic_name ? String(parsed.clinic_name).trim() : '';
    var schedNote = parsed && parsed.note ? String(parsed.note).trim() : '';

    var todayYmd = jstTodayYmd();
    var diffDays = 999;
    if (nextYmd) {
      var dueMs = ymdToUtcMs(nextYmd);
      var todayMs = ymdToUtcMs(todayYmd);
      if (!isNaN(dueMs) && !isNaN(todayMs)) {
        diffDays = Math.round((dueMs - todayMs) / 86400000);
      }
    }
    var isOverdue = diffDays < 0;
    var urgColor = isOverdue ? '#f87171' : diffDays <= 7 ? '#fb923c' : diffDays <= 30 ? '#facc15' : '#4ade80';
    var daysText = diffDays === 0 ? '今日' : isOverdue ? Math.abs(diffDays) + '日超過' : diffDays + '日後';
    var badgeClass = isOverdue ? 'bb-type-badge bb-type-overdue' : 'bb-type-badge bb-type-schedule';

    var dateLabel = nextYmd ? formatWesternYmd(nextYmd) : (item._displayDate || '');

    var schedNoteBlock = '';
    if (schedNote) {
      var sRendered = renderBodyWithDrive(schedNote);
      schedNoteBlock = '<div class="bb-card-body" style="white-space:pre-wrap;word-break:break-word;">' + sRendered.html + '</div>' + (sRendered.embeds || '');
    }
    return '<div class="bb-card bb-sched-card">' +
      '<div class="bb-urgency-bar" style="background:' + urgColor + ';"></div>' +
      '<div style="flex:1;">' +
        '<div class="bb-card-head">' +
          '<div><span class="' + badgeClass + '">' + esc(typeLabel) + '</span><span class="bb-cat-name">' + catLabel + '</span></div>' +
          '<span class="bb-date" style="color:' + urgColor + ';">' + esc(dateLabel) + '（' + daysText + '）</span>' +
        '</div>' +
        (clinicName ? '<div style="font-size:11px;color:#a5b4fc;margin-bottom:2px;">🏥 ' + esc(clinicName) + '</div>' : '') +
        schedNoteBlock +
        renderClinicAttachmentsHtml(r) +
        renderThreadComments('clinic', r.id, r.comments) +
        renderThreadActions('clinic', r.id, r.recorded_by) +
      '</div>' +
    '</div>';
  }

  /** DB の mime が空・octet-stream のとき、拡張子で画像扱い（GET 側もファイル名推定と揃える） */
  function bulletinAttLooksImage(origName, mime) {
    var m = String(mime || '').trim();
    if (/^image\//i.test(m)) return true;
    if (/^video\//i.test(m)) return false;
    if (m === 'application/octet-stream' || m === '') {
      return /\.(jpe?g|png|gif|webp|heic|heif|bmp|svg|avif|tiff?)$/i.test(String(origName || ''));
    }
    return false;
  }

  function bulletinAttLooksVideo(origName, mime) {
    var m = String(mime || '').trim();
    if (/^video\//i.test(m)) return true;
    if (/^image\//i.test(m)) return false;
    if (m === 'application/octet-stream' || m === '') {
      return /\.(mp4|webm|mov|m4v|ogv|avi|mkv)$/i.test(String(origName || ''));
    }
    return false;
  }

  /** PDF 判定（mime が pdf / application/pdf、または拡張子 .pdf） */
  function bulletinAttLooksPdf(origName, mime) {
    var m = String(mime || '').trim().toLowerCase();
    if (m.indexOf('pdf') !== -1) return true;
    if (m === 'application/octet-stream' || m === '') {
      return /\.pdf$/i.test(String(origName || ''));
    }
    return false;
  }

  /**
   * 追記リストの描画。
   * どのエンティティタイプのカードでも使える。
   * entityType は 'bulletin' | 'note' | 'clinic'。
   */
  function renderThreadComments(entityType, entityId, comments) {
    var list = comments || [];
    if (!list.length) return '';
    var html = '<div class="bb-comments"><div class="bb-comments-title">追記 (' + list.length + ')</div>';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      var cDate = '';
      try {
        var ms = window.NyagiJst && window.NyagiJst.parseDbMs ? window.NyagiJst.parseDbMs(c.created_at) : null;
        if (ms) {
          cDate = window.NyagiJst.formatWesternDateTime
            ? window.NyagiJst.formatWesternDateTime(ms)
            : new Date(ms).toLocaleString('ja-JP');
        } else {
          cDate = String(c.created_at || '');
        }
      } catch (_) { cDate = String(c.created_at || ''); }
      var editable = isOwnerOrAuthor(c.staff_id);
      var actions = '';
      if (editable) {
        actions =
          '<div class="bb-comment-actions">' +
          '<button type="button" class="bb-btn-sm bb-btn-edit" data-edit-comment="' + esc(String(c.id)) +
          '" data-entity-type="' + esc(entityType) + '" data-entity-id="' + esc(String(entityId)) + '">編集</button>' +
          '<button type="button" class="bb-btn-sm bb-btn-del" data-del-comment="' + esc(String(c.id)) +
          '" data-entity-type="' + esc(entityType) + '" data-entity-id="' + esc(String(entityId)) + '">削除</button>' +
          '</div>';
      }
      html +=
        '<div class="bb-comment">' +
        '<div class="bb-comment-head">' +
        '<span>' + esc(cDate) + (c.staff_name ? ' / ' + esc(c.staff_name) : '') + '</span>' +
        actions +
        '</div>' +
        '<div class="bb-comment-body">' + esc(c.body || '') + '</div>' +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  /**
   * カード右下のアクションバー（追記／編集／削除）。
   * 編集・削除は投稿者本人か owner のみ。追記は誰でも可。
   */
  function renderThreadActions(entityType, entityId, ownerStaffId) {
    var canEdit = isOwnerOrAuthor(ownerStaffId);
    var html = '<div class="bb-card-actions">';
    html +=
      '<button type="button" class="bb-btn-sm bb-btn-comment" data-thread-comment="1"' +
      ' data-entity-type="' + esc(entityType) + '"' +
      ' data-entity-id="' + esc(String(entityId)) + '">+ 追記</button>';
    if (canEdit) {
      html +=
        '<button type="button" class="bb-btn-sm bb-btn-edit" data-thread-edit="1"' +
        ' data-entity-type="' + esc(entityType) + '"' +
        ' data-entity-id="' + esc(String(entityId)) + '">編集</button>' +
        '<button type="button" class="bb-btn-sm bb-btn-del" data-thread-del="1"' +
        ' data-entity-type="' + esc(entityType) + '"' +
        ' data-entity-id="' + esc(String(entityId)) + '">削除</button>';
    }
    html += '</div>';
    return html;
  }

  // 旧名の互換（既存コードから呼ばれているため）
  function renderBulletinComments(m) { return renderThreadComments('bulletin', m.id, m.comments); }

  function renderBulletinCard(item) {
    var m = item.data;
    var pinIcon = m.pinned ? '<span style="color:#fb923c;">📌</span> ' : '';
    var staffLabel = m.staff_name ? esc(m.staff_name) : '';
    var dateStr = item._displayDate || computeDisplayDate(item);
    var atts = m.attachments && m.attachments.length ? m.attachments : [];
    var attHtml = '';
    if (atts.length) {
      attHtml += '<div class="bb-bull-atts">';
      for (var ai = 0; ai < atts.length; ai++) {
        var att = atts[ai];
        var mime = String(att.mime_type || '');
        var on = att.original_name;
        var isImg = bulletinAttLooksImage(on, mime);
        var isVid = !isImg && bulletinAttLooksVideo(on, mime);
        var isPdf = !isImg && !isVid && bulletinAttLooksPdf(on, mime);
        var label = esc(String(att.original_name || 'ファイル').slice(0, 120));
        var bid = esc(String(m.id));
        var fid = esc(String(att.id));
        if (isImg) {
          attHtml +=
            '<div><img class="bb-bull-att-img" alt="" data-bb-bid="' +
            bid +
            '" data-bb-fid="' +
            fid +
            '" style="display:none"/></div>';
        } else if (isVid) {
          attHtml +=
            '<div><video class="bb-bull-att-video" controls playsinline preload="metadata" data-bb-bid="' +
            bid +
            '" data-bb-fid="' +
            fid +
            '" style="display:none"></video></div>';
        } else if (isPdf) {
          // PDF は iframe でブラウザ内蔵ビューアにインライン表示、下に別タブで開くリンクも併設。
          attHtml +=
            '<div class="bb-bull-att-pdf-wrap">' +
            '<iframe class="bb-bull-att-pdf" data-bb-bid="' + bid + '" data-bb-fid="' + fid +
            '" data-pdf="1" title="PDF プレビュー" style="display:none"></iframe>' +
            '<a href="#" class="bb-bull-att-link bb-bull-att-file" data-bb-bid="' + bid +
            '" data-bb-fid="' + fid + '">📎 ' + label + '（別タブで開く）</a>' +
            '</div>';
        } else {
          attHtml +=
            '<div><a href="#" class="bb-bull-att-link bb-bull-att-file" data-bb-bid="' +
            bid +
            '" data-bb-fid="' +
            fid +
            '">📎 ' +
            label +
            '</a></div>';
        }
      }
      attHtml += '</div>';
    }
    return (
      '<div class="bb-card" style="border-left:3px solid #fb923c;">' +
      '<div class="bb-card-head">' +
      '<div>' +
      pinIcon +
      '<span style="font-size:14px;font-weight:700;">' +
      esc(m.title || '') +
      '</span></div>' +
      '<span class="bb-date">' +
      esc(dateStr) +
      (staffLabel ? ' / ' + staffLabel : '') +
      '</span>' +
      '</div>' +
      (function () {
        var rb = renderBodyWithDrive(m.body || '');
        return '<div class="bb-card-body" style="white-space:pre-wrap;word-break:break-word;">' + rb.html + '</div>' + (rb.embeds || '');
      })() +
      attHtml +
      renderThreadComments('bulletin', m.id, m.comments) +
      renderThreadActions('bulletin', m.id, m.staff_id) +
      '</div>'
    );
  }

  // ── 業務連絡の投稿 ────────────────────────────────
  function updateComposeBtn() {
    var hasTitle = (composeTitle.value || '').trim().length > 0;
    var hasBody = (composeBody.value || '').trim().length > 0;
    composeBtn.disabled = !(hasTitle && hasBody);
  }

  function postBulletin() {
    var title = (composeTitle.value || '').trim();
    var body = (composeBody.value || '').trim();
    if (!title || !body) return;

    var locId = currentLocationId === 'all' ? 'cafe' : currentLocationId;
    var pinned = composePinned.checked;

    var fileList = composeFiles && composeFiles.files ? composeFiles.files : null;
    var n = fileList ? fileList.length : 0;
    if (n > BULLETIN_CLIENT_MAX_FILES) {
      alert('添付は最大' + BULLETIN_CLIENT_MAX_FILES + '件までです');
      return;
    }
    var totalSz = 0;
    for (var fi = 0; fi < n; fi++) {
      var sz = fileList[fi].size || 0;
      if (sz > BULLETIN_CLIENT_MAX_FILE_BYTES) {
        alert('「' + fileList[fi].name + '」が大きすぎます（1ファイル最大32MB）');
        return;
      }
      totalSz += sz;
    }
    if (totalSz > BULLETIN_CLIENT_MAX_TOTAL_BYTES) {
      alert('添付の合計が大きすぎます（合計約200MBまで）');
      return;
    }

    composeBtn.disabled = true;
    composeBtn.textContent = '送信中…';

    var reqInit;
    if (n > 0) {
      var fd = new FormData();
      fd.append('title', title);
      fd.append('body', body);
      fd.append('location_id', locId);
      fd.append('pinned', pinned ? '1' : '0');
      for (var fj = 0; fj < n; fj++) {
        fd.append('files', fileList[fj]);
      }
      reqInit = { method: 'POST', headers: apiHeadersForm(), body: fd };
    } else {
      reqInit = {
        method: 'POST',
        headers: apiHeaders(),
        body: JSON.stringify({
          title: title,
          body: body,
          location_id: locId,
          pinned: pinned
        })
      };
    }

    fetch(API_BASE + '/bulletin', reqInit)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (data.error) {
          alert('投稿に失敗しました: ' + (data.message || data.error));
          composeBtn.disabled = false;
          composeBtn.textContent = '投稿';
          return;
        }
        composeTitle.value = '';
        composeBody.value = '';
        composePinned.checked = false;
        if (composeFiles) composeFiles.value = '';
        composeBtn.textContent = '投稿';
        updateComposeBtn();
        fetchAll();
      })
      .catch(function () {
        alert('通信エラーが発生しました');
        composeBtn.disabled = false;
        composeBtn.textContent = '投稿';
      });
  }

  function deleteBulletin(id) { deleteEntity('bulletin', id); }

  /** エンティティタイプ別の API パス（単体操作・PUT/DELETE 用） */
  function entityApiUrl(entityType, entityId) {
    if (entityType === 'bulletin') return API_BASE + '/bulletin/' + encodeURIComponent(entityId);
    if (entityType === 'note') return API_BASE + '/cat-notes/' + encodeURIComponent(entityId);
    if (entityType === 'clinic') return API_BASE + '/health/records/' + encodeURIComponent(entityId);
    return null;
  }

  function deleteEntity(entityType, entityId) {
    var url = entityApiUrl(entityType, entityId);
    if (!url) return;
    fetch(url, { method: 'DELETE', headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.error) { alert('削除に失敗: ' + (data.message || data.error)); return; }
        fetchAll();
      })
      .catch(function () { alert('削除に失敗しました'); });
  }

  // ── 編集モーダル ────────────────────────────────
  // entityType 別に表示する項目を切替える:
  //   bulletin: タイトル + 本文 + 固定 + 添付
  //   note    : 本文 + 固定（カテゴリは既存値維持）
  //   clinic  : メモ（details.note or details.reason）本文のみ
  var editingEntity = { type: null, id: null };

  function openEditModal(entityType, entityId) {
    var it = findFeedItem(entityType, entityId);
    if (!it) return;
    editingEntity = { type: entityType, id: entityId };
    var modal = document.getElementById('editModal');
    var titleEl = document.getElementById('editModalTitle');
    var titleRow = document.getElementById('editTitleRow');
    var pinnedRow = document.getElementById('editPinnedRow');
    var attachBlock = document.getElementById('editAttachBlock');
    var tInp = document.getElementById('editTitle');
    var bInp = document.getElementById('editBody');
    var pInp = document.getElementById('editPinned');
    var filesInp = document.getElementById('editFiles');
    var hint = document.getElementById('editHint');

    if (filesInp) filesInp.value = '';

    if (entityType === 'bulletin') {
      var m = it.data;
      if (titleEl) titleEl.textContent = '業務連絡を編集';
      if (titleRow) titleRow.style.display = '';
      if (pinnedRow) pinnedRow.style.display = '';
      if (attachBlock) attachBlock.style.display = '';
      if (tInp) tInp.value = m.title || '';
      if (bInp) bInp.value = m.body || '';
      if (pInp) pInp.checked = !!m.pinned;
      if (hint) hint.textContent = '';
      renderEditAttachList(m);
      editingBulletinId = entityId; /* 既存の添付削除ハンドラ互換 */
    } else if (entityType === 'note') {
      var n = it.data;
      if (titleEl) titleEl.textContent = '注意事項を編集';
      if (titleRow) titleRow.style.display = 'none';
      if (pinnedRow) pinnedRow.style.display = '';
      if (attachBlock) attachBlock.style.display = 'none';
      if (bInp) bInp.value = n.note || '';
      if (pInp) pInp.checked = !!n.pinned;
      if (hint) hint.textContent = 'カテゴリは変更せず、本文と固定のみ編集します';
    } else if (entityType === 'clinic') {
      var r = it.data;
      var parsed = {};
      try { parsed = typeof r.details === 'string' ? (r.details ? JSON.parse(r.details) : {}) : (r.details || {}); } catch (_) { parsed = {}; }
      var currentNote = parsed.note != null ? String(parsed.note) : (parsed.reason != null ? String(parsed.reason) : '');
      if (titleEl) titleEl.textContent = '病院記録メモを編集';
      if (titleRow) titleRow.style.display = 'none';
      if (pinnedRow) pinnedRow.style.display = 'none';
      if (attachBlock) attachBlock.style.display = 'none';
      if (bInp) bInp.value = currentNote;
      if (hint) hint.textContent = 'メモ本文のみ編集します（日付・種別・病院名は猫詳細から編集してください）';
    }

    if (modal) modal.classList.add('open');
  }

  // 旧名互換
  function openEditBulletinModal(id) { openEditModal('bulletin', id); }

  function renderEditAttachList(m) {
    var wrap = document.getElementById('editAttachList');
    if (!wrap) return;
    var atts = m.attachments || [];
    if (!atts.length) { wrap.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">なし</div>'; return; }
    var html = '';
    for (var i = 0; i < atts.length; i++) {
      var a = atts[i];
      html +=
        '<div class="bb-attach-row">' +
        '<span>📎 ' + esc(String(a.original_name || 'ファイル').slice(0, 80)) + '</span>' +
        '<button type="button" class="bb-btn-sm bb-btn-del" data-remove-att="' + esc(String(a.id)) + '">削除</button>' +
        '</div>';
    }
    wrap.innerHTML = html;
    var rmBtns = wrap.querySelectorAll('[data-remove-att]');
    for (var r = 0; r < rmBtns.length; r++) {
      rmBtns[r].addEventListener('click', function () {
        var fid = this.getAttribute('data-remove-att');
        if (!confirm('この添付を削除しますか？')) return;
        removeAttachment(editingBulletinId, fid);
      });
    }
  }

  function removeAttachment(bulletinId, fileId) {
    fetch(API_BASE + '/bulletin/' + bulletinId + '/files/' + fileId, {
      method: 'DELETE', headers: apiHeaders()
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.error) { alert('削除に失敗: ' + (data.message || data.error)); return; }
      var m = findBulletinById(bulletinId);
      if (m && m.attachments) {
        m.attachments = m.attachments.filter(function (a) { return String(a.id) !== String(fileId); });
        renderEditAttachList(m);
      }
    }).catch(function () { alert('削除に失敗しました'); });
  }

  function closeEditModal() {
    editingBulletinId = null;
    editingEntity = { type: null, id: null };
    var modal = document.getElementById('editModal');
    if (modal) modal.classList.remove('open');
  }

  function saveEditEntity() {
    var saveBtn = document.getElementById('editSave');
    var tInp = document.getElementById('editTitle');
    var bInp = document.getElementById('editBody');
    var pInp = document.getElementById('editPinned');
    var filesInp = document.getElementById('editFiles');

    var type = editingEntity.type;
    var id = editingEntity.id;
    if (!type || !id) return;

    var body = (bInp && bInp.value || '').trim();
    if (!body) { alert('本文を入力してください'); return; }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '保存中…'; }

    var putUrl = entityApiUrl(type, id);
    var payload = null;
    if (type === 'bulletin') {
      var title = (tInp && tInp.value || '').trim();
      if (!title) { alert('タイトルを入力してください'); if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; } return; }
      payload = { title: title, body: body, pinned: !!(pInp && pInp.checked) };
    } else if (type === 'note') {
      payload = { note: body, pinned: !!(pInp && pInp.checked) };
    } else if (type === 'clinic') {
      var it = findFeedItem(type, id);
      var parsed = {};
      if (it && it.data) {
        try { parsed = typeof it.data.details === 'string' ? (it.data.details ? JSON.parse(it.data.details) : {}) : (it.data.details || {}); } catch (_) { parsed = {}; }
      }
      parsed.note = body;
      payload = { details: JSON.stringify(parsed) };
    }

    fetch(putUrl, { method: 'PUT', headers: apiHeaders(), body: JSON.stringify(payload) })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data && data.error) {
          alert('保存に失敗: ' + (data.message || data.error));
          if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
          return null;
        }
        if (type === 'bulletin') {
          var files = filesInp && filesInp.files ? filesInp.files : null;
          if (files && files.length) {
            var fd = new FormData();
            for (var i = 0; i < files.length; i++) fd.append('files', files[i]);
            return fetch(API_BASE + '/bulletin/' + id + '/files', {
              method: 'POST', headers: apiHeadersForm(), body: fd
            }).then(function (r2) { return r2.json(); });
          }
        }
        return data;
      })
      .then(function (res) {
        if (res && res.error) {
          alert('添付追加に失敗: ' + (res.message || res.error));
        }
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
        closeEditModal();
        fetchAll();
      })
      .catch(function () {
        alert('保存に失敗しました');
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存'; }
      });
  }

  function saveEditBulletin() { saveEditEntity(); }

  // ── 追記モーダル（汎用）──────────────────────────
  var commentingEntity = { type: null, id: null };

  function openCommentModal(entityType, entityId, commentId) {
    commentingEntity = { type: entityType, id: entityId };
    commentingBulletinId = entityType === 'bulletin' ? entityId : null; /* 後方互換 */
    commentEditingId = commentId || null;
    var modal = document.getElementById('commentModal');
    var bInp = document.getElementById('commentBody');
    var title = document.getElementById('commentModalTitle');
    if (commentId) {
      var c = findCommentByIdAnyEntity(entityType, entityId, commentId);
      if (bInp) bInp.value = c ? (c.body || '') : '';
      if (title) title.textContent = '追記を編集（' + entityLabelJa(entityType) + '）';
    } else {
      if (bInp) bInp.value = '';
      if (title) title.textContent = '追記を投稿（' + entityLabelJa(entityType) + '）';
    }
    if (modal) modal.classList.add('open');
    setTimeout(function () { if (bInp) bInp.focus(); }, 0);
  }

  function closeCommentModal() {
    commentingEntity = { type: null, id: null };
    commentingBulletinId = null;
    commentEditingId = null;
    var modal = document.getElementById('commentModal');
    if (modal) modal.classList.remove('open');
  }

  function saveComment() {
    if (!commentingEntity.type || !commentingEntity.id) return;
    var bInp = document.getElementById('commentBody');
    var text = (bInp && bInp.value || '').trim();
    if (!text) { alert('本文を入力してください'); return; }
    var saveBtn = document.getElementById('commentSave');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '送信中…'; }
    var url, method, payload;
    if (commentEditingId) {
      url = API_BASE + '/thread-comments/' + encodeURIComponent(commentEditingId);
      method = 'PUT';
      payload = { body: text };
    } else {
      url = API_BASE + '/thread-comments';
      method = 'POST';
      payload = { entity_type: commentingEntity.type, entity_id: Number(commentingEntity.id), body: text };
    }
    fetch(url, {
      method: method,
      headers: apiHeaders(),
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.error) {
        alert('投稿に失敗: ' + (data.message || data.error));
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '投稿'; }
        return;
      }
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '投稿'; }
      closeCommentModal();
      fetchAll();
    }).catch(function () {
      alert('通信エラー');
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '投稿'; }
    });
  }

  function deleteThreadComment(commentId) {
    fetch(API_BASE + '/thread-comments/' + encodeURIComponent(commentId), {
      method: 'DELETE', headers: apiHeaders()
    }).then(function (r) { return r.json(); })
    .then(function (data) {
      if (data && data.error) { alert('削除に失敗: ' + (data.message || data.error)); return; }
      fetchAll();
    }).catch(function () { alert('削除に失敗しました'); });
  }

  function renderDisplayCatalogTwoColRows(rows) {
    var h = '<table class="bb-catalog-table"><thead><tr><th>ID</th><th>表示名</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      h += '<tr><td><code>' + esc(r.id) + '</code></td><td>' + esc(r.label) + '</td></tr>';
    }
    h += '</tbody></table>';
    return h;
  }

  function fetchDisplayCatalogOnce() {
    if (displayCatalogFetched || displayCatalogFetching || !bbDisplayCatalogBody) return;
    displayCatalogFetching = true;
    bbDisplayCatalogBody.textContent = '読み込み中…';
    fetch(API_BASE + '/bulletin/meta/display-catalog', { method: 'GET', headers: apiHeaders() })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        displayCatalogFetching = false;
        if (data && data.error) {
          bbDisplayCatalogBody.innerHTML = '取得失敗: ' + esc(String(data.message || data.error));
          return;
        }
        var html = '';
        html += '<p class="bb-catalog-intro">API のキーと日本語ラベルの対応です。今後「表示OK」だけに絞る実装をするときのキーに使えます（<code>api/worker/src/ops/display-catalog.js</code> と同期）。</p>';
        html += '<div class="bb-catalog-subtitle">注意事項（<code>cat_notes.category</code>）</div>';
        html += renderDisplayCatalogTwoColRows(data.note_categories || []);
        html += '<div class="bb-catalog-subtitle">健康記録・掲示板に出る（<code>health_records.record_type</code>）</div>';
        html += renderDisplayCatalogTwoColRows(data.health_record_types_bulletin || []);
        html += '<div class="bb-catalog-subtitle">健康記録・掲示板に出ない（猫詳細・日報など）</div>';
        html += renderDisplayCatalogTwoColRows(data.health_record_types_not_on_bulletin || []);
        var care = data.care_detail_types || [];
        if (care.length) {
          html += '<div class="bb-catalog-subtitle">ケア内訳（<code>details.care_type</code>・掲示板タイムラインでは <code>care</code> 行は返さないため参照用）</div>';
          html += '<table class="bb-catalog-table"><thead><tr><th>care_type</th><th>表示名</th><th>record_type</th></tr></thead><tbody>';
          for (var j = 0; j < care.length; j++) {
            var c = care[j];
            html += '<tr><td><code>' + esc(c.id) + '</code></td><td>' + esc(c.label) + '</td><td><code>' + esc(c.record_type || '') + '</code></td></tr>';
          }
          html += '</tbody></table>';
        }
        bbDisplayCatalogBody.innerHTML = html;
        displayCatalogFetched = true;
      })
      .catch(function () {
        displayCatalogFetching = false;
        bbDisplayCatalogBody.textContent = '通信エラー';
      });
  }

  // ── イベントバインド ──────────────────────────────
  if (catFilter) {
    catFilter.addEventListener('change', function () {
      currentCatId = this.value;
      renderFeed();
    });
  }
  if (itemFilter) {
    itemFilter.addEventListener('change', function () {
      currentItem = this.value;
      if (currentItem === 'bulletin') {
        composeSection.style.display = '';
      } else if (currentItem !== 'all') {
        composeSection.style.display = 'none';
      } else {
        composeSection.style.display = '';
      }
      renderFeed();
    });
  }
  if (bulletinFoldToggle) {
    bulletinFoldToggle.addEventListener('click', function () {
      bulletinFoldIsOpen = !bulletinFoldIsOpen;
      applyBulletinFoldDOM();
    });
  }
  if (composeTitle) composeTitle.addEventListener('input', updateComposeBtn);
  if (composeBody) composeBody.addEventListener('input', updateComposeBtn);
  if (composeBtn) composeBtn.addEventListener('click', postBulletin);
  if (composeFiles) composeFiles.addEventListener('change', updateComposeBtn);
  if (bbDisplayCatalog && bbDisplayCatalogBody) {
    bbDisplayCatalog.addEventListener('toggle', function () {
      if (bbDisplayCatalog.open) fetchDisplayCatalogOnce();
    });
  }

  var editCancelBtn = document.getElementById('editCancel');
  var editSaveBtn = document.getElementById('editSave');
  var editModalEl = document.getElementById('editModal');
  if (editCancelBtn) editCancelBtn.addEventListener('click', closeEditModal);
  if (editSaveBtn) editSaveBtn.addEventListener('click', saveEditEntity);
  if (editModalEl) editModalEl.addEventListener('click', function (ev) {
    if (ev.target === editModalEl) closeEditModal();
  });

  var commentCancelBtn = document.getElementById('commentCancel');
  var commentSaveBtn = document.getElementById('commentSave');
  var commentModalEl = document.getElementById('commentModal');
  if (commentCancelBtn) commentCancelBtn.addEventListener('click', closeCommentModal);
  if (commentSaveBtn) commentSaveBtn.addEventListener('click', saveComment);
  if (commentModalEl) commentModalEl.addEventListener('click', function (ev) {
    if (ev.target === commentModalEl) closeCommentModal();
  });

  // ── 初期化 ────────────────────────────────────────
  loadCredentials();
  if (!credentials) return;
  renderFilterBars();
  fetchAll();
})();
