/**
 * NYAGI フロント: 表示・入力の基準は常に日本時間（Asia/Tokyo）。
 * ブラウザのローカルタイムゾーンには依存しない。
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

  function partsMap(d, opts) {
    var map = {};
    var parts = new Intl.DateTimeFormat('en-GB', opts).formatToParts(d);
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type !== 'literal') map[parts[i].type] = parts[i].value;
    }
    return map;
  }

  var NyagiJst = {
    TZ: TZ,

    /** JST の今日 YYYY-MM-dd（API・input[type=date] 用） */
    todayYmd: function () {
      return new Date().toLocaleDateString('sv-SE', { timeZone: TZ });
    },

    /**
     * ISO 等のインスタント → 表示用 M/D HH:mm（日本時間の壁時計）
     * @param {string} iso
     * @returns {string}
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
     * @param {string} ymdRaw
     * @returns {string}
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
     * 病院予約など "YYYY-MM-DD HH:mm" 形式の文字列を日本暦の M/D（曜）+ 時刻で表示
     * @param {string} val
     * @returns {string}
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
  };

  global.NyagiJst = NyagiJst;
})(typeof window !== 'undefined' ? window : this);
