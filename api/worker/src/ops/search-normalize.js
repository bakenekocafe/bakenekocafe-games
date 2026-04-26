/**
 * サーバ側: フード/薬/辞書マッチ用（product-resolver 等）
 */

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

export function normalizeSearchFold(s) {
  if (s == null || s === '') return '';
  var str = String(s);
  try {
    str = str.normalize('NFKC');
  } catch (e) {}
  str = katakanaToHiraganaStr(str);
  str = str.toLowerCase();
  return str.replace(/[\s\u3000\u2000-\u200B\uFEFF]+/g, '');
}
