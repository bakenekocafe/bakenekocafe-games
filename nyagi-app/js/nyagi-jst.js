/**
 * NYAGI フロント: 日本時間（Asia/Tokyo）を唯一のタイムゾーンとする集中モジュール。
 *
 * - 表示・入力は常に JST の壁時計。ブラウザのローカル TZ に依存しない。
 * - D1/SQLite は既定で UTC（`datetime('now')` / `CURRENT_TIMESTAMP`）を返すため、
 *   タイムゾーン無しの "YYYY-MM-DD HH:MM:SS" は UTC として解釈する（parseDbMs）。
 *   末尾 Z / +09:00 等が付く ISO 文字列はそのまま Date.parse。
 * - 新しい TZ ヘルパーを増やすときはここ 1 ファイルに追加する（散らさない）。
 */
(function (global) {
  var TZ = 'Asia/Tokyo';

  var EN_WDAY_JP = {
    Sunday: '日',
    Monday: '月',
    Tuesday: '火',
    Wednesday: '水',
    Thursday: '木',
    Friday: '金',
    Saturday: '土',
  };

  function pad2(n) {
    n = Number(n);
    return n < 10 ? '0' + n : String(n);
  }

  function partsMap(d, opts) {
    var map = {};
    var parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(d);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    return map;
  }

  /** 入力値を文字列に寄せる（Unix ms を ISO に寄せる、null/undefined は空） */
  function toTextLike(v) {
    if (v == null || v === '') return '';
    if (typeof v === 'number' && !isNaN(v)) {
      try {
        var d = new Date(v);
        if (!isNaN(d.getTime())) return d.toISOString();
      } catch (_) { /* noop */ }
      return '';
    }
    return typeof v === 'string' ? v : String(v);
  }

  var NyagiJst = {
    TZ: TZ,
    pad2: pad2,

    /** JST の今日 YYYY-MM-dd（API・input[type=date] 用） */
    todayYmd: function () {
      return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    },

    /** JST の現在年 */
    year: function () {
      var y = NyagiJst.todayYmd().split('-')[0];
      var n = parseInt(y, 10);
      return isNaN(n) ? new Date().getFullYear() : n;
    },

    /**
     * DB / ISO 日時文字列 → ms（数値）
     * - タイムゾーン無し "YYYY-MM-DD HH:MM:SS" は UTC として解釈（D1/SQLite 既定）
     * - 末尾 Z / +HH:MM 付きはそのまま Date.parse
     * - "YYYY-MM-DD" のみは JST の暦日を UTC 午前 0 時として返す（日単位ソート用）
     */
    parseDbMs: function (s) {
      var u = toTextLike(s).trim();
      if (!u) return NaN;
      if (/^\d{4}-\d{2}-\d{2}$/.test(u)) {
        return NyagiJst.ymdToUtcMidnightMs(u);
      }
      if (/[zZ]$/.test(u) || /[+-]\d{2}:?\d{2}$/.test(u)) {
        var g = Date.parse(u);
        return isNaN(g) ? NaN : g;
      }
      var m = u.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        var hh = pad2(parseInt(m[2], 10));
        var mm = pad2(parseInt(m[3], 10));
        var ss = pad2(m[4] != null ? parseInt(m[4], 10) : 0);
        return Date.parse(m[1] + 'T' + hh + ':' + mm + ':' + ss + 'Z');
      }
      return NaN;
    },

    /** YYYY-MM-DD → 並び用 UTC 午前 0 時相当の ms */
    ymdToUtcMidnightMs: function (ymd) {
      if (!ymd) return NaN;
      var p = String(ymd).slice(0, 10).split('-');
      if (p.length !== 3) return NaN;
      var y = parseInt(p[0], 10);
      var mo = parseInt(p[1], 10);
      var d = parseInt(p[2], 10);
      if (isNaN(y) || isNaN(mo) || isNaN(d)) return NaN;
      return Date.UTC(y, mo - 1, d);
    },

    /**
     * 日付文字列を YYYY-MM-DD に正規化。
     * 年なし（M/D、MM-DD）は JST 現在年を補う。認識不能は null。
     */
    normalizeYmd: function (s) {
      var t = toTextLike(s).trim();
      if (!t) return null;
      var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (m) {
        return m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
      }
      m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:$|[^0-9])/);
      if (m) {
        return NyagiJst.year() + '-' + pad2(parseInt(m[1], 10)) + '-' + pad2(parseInt(m[2], 10));
      }
      m = t.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
      if (m) {
        return m[1] + '-' + pad2(parseInt(m[2], 10)) + '-' + pad2(parseInt(m[3], 10));
      }
      return null;
    },

    /**
     * ISO 等のインスタント → 表示用 M/D HH:mm（日本時間の壁時計）
     */
    formatMdHm: function (iso) {
      if (!iso) return '';
      try {
        var d = new Date(iso);
        if (isNaN(d.getTime())) return String(iso);
        var map = partsMap(d, {
          timeZone: TZ,
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
        return Number(map.month) + '/' + Number(map.day) + ' ' + map.hour + ':' + map.minute;
      } catch (e) {
        return String(iso);
      }
    },

    /**
     * YYYY-MM-DD を「日本の暦日」として解釈し M/D（曜）を返す（タスク期限表示など）
     */
    formatYmdWithWday: function (ymdRaw) {
      var ymd = String(ymdRaw || '').slice(0, 10);
      if (ymd.length !== 10 || ymd.charAt(4) !== '-') return '';
      var d = new Date(ymd + 'T12:00:00+09:00');
      if (isNaN(d.getTime())) return '';
      var wk = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(d);
      var wch = EN_WDAY_JP[wk] || '';
      var map = partsMap(d, { timeZone: TZ, month: 'numeric', day: 'numeric' });
      return Number(map.month) + '/' + Number(map.day) + '（' + wch + '）';
    },

    /**
     * 病院予約など "YYYY-MM-DD HH:mm" を日本暦の M/D（曜）+ 時刻で表示
     */
    formatBookedDateTime: function (val) {
      if (!val) return '';
      var sp = String(val).split(' ');
      var datePart = (sp[0] || '').slice(0, 10);
      var timePart = sp[1] || '';
      var base = NyagiJst.formatYmdWithWday(datePart);
      if (!base) return String(val);
      return timePart ? base + ' ' + timePart : base;
    },

    /** 表示用: 西暦付き（"YYYY年M月D日"） */
    formatWesternYmd: function (ymd) {
      var v = String(ymd || '');
      if (!v) return '';
      var p = v.split('-');
      if (p.length !== 3) return v;
      return parseInt(p[0], 10) + '年' + parseInt(p[1], 10) + '月' + parseInt(p[2], 10) + '日';
    },

    /**
     * 表示用: 西暦＋日時（"YYYY年M月D日 HH:MM"）を JST で返す。
     * SQLite の TZ 無し文字列は UTC として正しく解釈してから JST 表示する。
     */
    formatWesternDateTime: function (v) {
      if (!v) return '';
      var ms = NyagiJst.parseDbMs(v);
      if (isNaN(ms)) {
        var ymd = NyagiJst.normalizeYmd(v);
        if (ymd) return NyagiJst.formatWesternYmd(ymd);
        return String(v).slice(0, 16);
      }
      var d = new Date(ms);
      try {
        var parts = new Intl.DateTimeFormat('ja-JP', {
          timeZone: TZ,
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).formatToParts(d);
        var y = ''; var mo = ''; var da = ''; var h = ''; var mi = '';
        for (var i = 0; i < parts.length; i++) {
          var pt = parts[i];
          if (pt.type === 'year') y = pt.value;
          if (pt.type === 'month') mo = pt.value;
          if (pt.type === 'day') da = pt.value;
          if (pt.type === 'hour') h = pt.value;
          if (pt.type === 'minute') mi = pt.value;
        }
        if (y && mo && da) return y + '年' + mo + '月' + da + '日 ' + h + ':' + mi;
      } catch (_) { /* noop */ }
      return String(v).slice(0, 19).replace('T', ' ');
    },

    /** 表示用: 相対日数（例: 「今日」「3日後」「2日超過」） */
    diffDaysFromTodayJst: function (ymd) {
      if (!ymd) return null;
      var dueMs = NyagiJst.ymdToUtcMidnightMs(String(ymd).slice(0, 10));
      var todayMs = NyagiJst.ymdToUtcMidnightMs(NyagiJst.todayYmd());
      if (isNaN(dueMs) || isNaN(todayMs)) return null;
      return Math.round((dueMs - todayMs) / 86400000);
    },
  };

  global.NyagiJst = NyagiJst;
})(typeof window !== 'undefined' ? window : this);
