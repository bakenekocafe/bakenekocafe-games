/**
 * NYAGI マスタ検索用: 部分一致しやすいよう表記を寄せる
 * - Unicode NFKC（全半・互換字形）
 * - カタカナ → ひらがな（アーキ→あーき など）
 * - ASCII 英字は toLowerCase
 * - 空白類は除去（連続・全角含む）
 */
(function (global) {
  function katakanaToHiraganaStr(str) {
    var r = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0x30A1 && c <= 0x30F6) {
        r += String.fromCharCode(c - 0x60);
      } else {
        r += str.charAt(i);
      }
    }
    return r;
  }

  function normalizeSearchFold(s) {
    if (s == null || s === '') return '';
    var str = String(s);
    try {
      str = str.normalize('NFKC');
    } catch (e) {}
    str = katakanaToHiraganaStr(str);
    str = str.toLowerCase();
    return str.replace(/[\s\u3000\u2000-\u200B\uFEFF]+/g, '');
  }

  /** 空白で区切られた複数語はすべてが部分一致する必要がある（AND） */
  function textMatchesQuery(haystackRaw, queryRaw) {
    var q = String(queryRaw || '').trim();
    if (!q) return true;
    var foldHay = normalizeSearchFold(haystackRaw);
    var parts = q.replace(/\u3000/g, ' ').split(/\s+/).filter(function (w) { return w.length > 0; });
    for (var i = 0; i < parts.length; i++) {
      if (normalizeSearchFold(parts[i]).length === 0) continue;
      if (foldHay.indexOf(normalizeSearchFold(parts[i])) === -1) return false;
    }
    return true;
  }

  global.nyagiSearchNormalizeFold = normalizeSearchFold;
  global.nyagiSearchTextMatchesQuery = textMatchesQuery;
})(typeof window !== 'undefined' ? window : this);
