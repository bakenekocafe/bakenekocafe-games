/**
 * NYAGI / Worker 共通: 日本時間（Asia/Tokyo）の暦日・壁時計。
 * Worker の既定 TZ は UTC のため、toISOString().slice(0,10) や +9h オフセットに依存しない。
 */

export function jstCalendarYmdFromInstant(ms) {
  var t = ms == null ? Date.now() : ms;
  var d = new Date(t);
  var parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  var y = '';
  var m = '';
  var day = '';
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].type === 'year') y = parts[i].value;
    if (parts[i].type === 'month') m = parts[i].value;
    if (parts[i].type === 'day') day = parts[i].value;
  }
  return y + '-' + m + '-' + day;
}

export function jstCalendarHmFromInstant(ms) {
  var t = ms == null ? Date.now() : ms;
  var d = new Date(t);
  return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function jstCalendarHourFromInstant(ms) {
  var t = ms == null ? Date.now() : ms;
  var d = new Date(t);
  var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }).formatToParts(d);
  for (var i = 0; i < p.length; i++) {
    if (p[i].type === 'hour') return parseInt(p[i].value, 10);
  }
  return 0;
}

export function jstCalendarMinuteFromInstant(ms) {
  var t = ms == null ? Date.now() : ms;
  var d = new Date(t);
  var p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Tokyo', minute: 'numeric' }).formatToParts(d);
  for (var i = 0; i < p.length; i++) {
    if (p[i].type === 'minute') return parseInt(p[i].value, 10);
  }
  return 0;
}

export function jstCalendarYmFromInstant(ms) {
  return jstCalendarYmdFromInstant(ms).slice(0, 7);
}

export function jstCalendarAddDays(ymd, deltaDays) {
  var d = new Date(ymd + 'T12:00:00+09:00');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return jstCalendarYmdFromInstant(d.getTime());
}

/** fromYmd から toYmd までの暦日差（to が早ければ負） */
export function jstCalendarDiffDays(fromYmd, toYmd) {
  if (!fromYmd || !toYmd || String(fromYmd).length < 10 || String(toYmd).length < 10) return 0;
  var a = new Date(String(fromYmd).slice(0, 10) + 'T12:00:00+09:00').getTime();
  var b = new Date(String(toYmd).slice(0, 10) + 'T12:00:00+09:00').getTime();
  return Math.round((b - a) / 86400000);
}

export function jstNowIsoTimestamp() {
  var s = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  return s.replace(' ', 'T') + '+09:00';
}

/** レート制限 KV キー用: JST の YYYY-MM-DDTHH:mm */
export function jstRateLimitMinuteKeyFromInstant(ms) {
  return jstCalendarYmdFromInstant(ms) + 'T' + jstCalendarHmFromInstant(ms);
}

/** アナリティクス時間バケット（JST 壁時計の時を 0 分に丸めたソート可能キー） */
export function jstAnalyticsHourBucketFromInstant(ms) {
  var ymd = jstCalendarYmdFromInstant(ms);
  var h = jstCalendarHourFromInstant(ms);
  return ymd + 'T' + (h < 10 ? '0' : '') + h + ':00:00';
}

export function jstWeekdaySUN0(ymd) {
  var d = new Date(ymd + 'T12:00:00+09:00');
  var wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tokyo', weekday: 'short' }).format(d);
  var map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd] !== undefined ? map[wd] : 0;
}

/** ISO8601 / SQLite datetime 文字列 → その瞬間の JST 暦日 */
export function jstCalendarYmdFromParsedIso(iso) {
  if (!iso || typeof iso !== 'string') return '';
  var ms = Date.parse(iso.replace(' ', 'T'));
  if (isNaN(ms)) return iso.length >= 10 ? iso.slice(0, 10) : '';
  return jstCalendarYmdFromInstant(ms);
}

/** ISO8601 / SQLite datetime 文字列 → JST の HH:mm */
export function jstHmFromParsedIso(iso) {
  if (!iso || typeof iso !== 'string') return '';
  var ms = Date.parse(iso.replace(' ', 'T'));
  if (isNaN(ms)) return iso.length >= 16 ? iso.slice(11, 16) : '';
  return jstCalendarHmFromInstant(ms);
}
