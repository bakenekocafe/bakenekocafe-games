/**
 * NYAGI フロント共通: テキスト内の URL（特に Google Drive の共有 URL）を
 * インラインプレビュー可能な HTML に変換するユーティリティ。
 *
 * - Google Drive の共有リンクは iframe の `/preview` 形式で埋め込める。
 *   参考: https://developers.google.com/drive/api/v3/reference/files/get
 * - それ以外の http(s) URL は単純なクリック可能リンクにする。
 *
 * 典型的な使い方:
 *   var r = NyagiDriveEmbed.renderText(record.note);
 *   container.innerHTML = r.html + r.embeds;
 *
 * 返り値:
 *   html   : 本文 HTML（エスケープ済み・URL は <a> 化済み）
 *   embeds : 本文末尾に追記する iframe プレビュー群 HTML
 *   drives : { id, viewUrl, previewUrl } の配列（個別に使いたい場合用）
 */
(function (global) {
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** URL が Google Drive の共有 URL なら file id を抽出する。該当しなければ null。 */
  function extractDriveId(url) {
    if (!url) return null;
    var s = String(url);
    var m1 = /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]{10,})/.exec(s);
    if (m1) return m1[1];
    var m2 = /drive\.google\.com\/(?:open|uc|thumbnail)\?[^#]*\bid=([a-zA-Z0-9_-]{10,})/.exec(s);
    if (m2) return m2[1];
    var m3 = /docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]{10,})/.exec(s);
    if (m3) return m3[1];
    return null;
  }

  function driveViewUrl(id) {
    return 'https://drive.google.com/file/d/' + id + '/view';
  }
  function drivePreviewUrl(id) {
    return 'https://drive.google.com/file/d/' + id + '/preview';
  }

  /**
   * テキストから URL を検出し、クリック可能な <a> + Drive の場合は末尾用 iframe 埋め込みを生成する。
   */
  function renderText(text) {
    var src = String(text == null ? '' : text);
    var urlRe = /(https?:\/\/[^\s<>"'\u3000]+)/g;
    var out = '';
    var lastIndex = 0;
    var drives = [];
    var seen = {};
    var m;
    while ((m = urlRe.exec(src)) !== null) {
      if (m.index > lastIndex) {
        out += escapeHtml(src.slice(lastIndex, m.index));
      }
      var url = m[0];
      var cleanUrl = url.replace(/[)\].,;:!?]+$/, '');
      var trailing = url.slice(cleanUrl.length);
      var id = extractDriveId(cleanUrl);
      if (id) {
        var view = driveViewUrl(id);
        out +=
          '<a href="' + escapeHtml(view) +
          '" target="_blank" rel="noopener noreferrer" class="nyagi-drive-link">' +
          escapeHtml(cleanUrl) +
          '</a>';
        if (!seen[id]) {
          seen[id] = true;
          drives.push({ id: id, viewUrl: view, previewUrl: drivePreviewUrl(id) });
        }
      } else {
        out +=
          '<a href="' + escapeHtml(cleanUrl) +
          '" target="_blank" rel="noopener noreferrer" class="nyagi-ext-link">' +
          escapeHtml(cleanUrl) +
          '</a>';
      }
      if (trailing) out += escapeHtml(trailing);
      lastIndex = m.index + url.length;
    }
    if (lastIndex < src.length) {
      out += escapeHtml(src.slice(lastIndex));
    }

    var embeds = '';
    for (var i = 0; i < drives.length; i++) {
      embeds +=
        '<div class="nyagi-drive-embed-wrap">' +
        '<iframe class="nyagi-drive-embed" src="' + escapeHtml(drives[i].previewUrl) +
        '" title="Google Drive プレビュー" loading="lazy" allow="autoplay" referrerpolicy="no-referrer"></iframe>' +
        '<a class="nyagi-drive-embed-open" href="' + escapeHtml(drives[i].viewUrl) +
        '" target="_blank" rel="noopener noreferrer">📎 Google Drive で開く</a>' +
        '</div>';
    }

    return { html: out, embeds: embeds, drives: drives };
  }

  /** テキスト中に Google Drive の URL が含まれるか */
  function hasDrive(text) {
    if (!text) return false;
    return /drive\.google\.com|docs\.google\.com/.test(String(text));
  }

  var CSS_ID = 'nyagi-drive-embed-style';
  function injectStyleOnce() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(CSS_ID)) return;
    var css =
      '.nyagi-drive-embed-wrap{display:flex;flex-direction:column;gap:4px;margin-top:10px;}' +
      '.nyagi-drive-embed{display:block;width:100%;height:480px;max-height:70vh;border:0;border-radius:8px;background:rgba(0,0,0,0.35);}' +
      '.nyagi-drive-embed-open{font-size:12px;color:var(--accent,#f472b6);word-break:break-all;text-decoration:underline;}' +
      '.nyagi-drive-link,.nyagi-ext-link{color:var(--accent,#f472b6);word-break:break-all;}';
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.type = 'text/css';
    s.appendChild(document.createTextNode(css));
    (document.head || document.documentElement).appendChild(s);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', injectStyleOnce);
    } else {
      injectStyleOnce();
    }
  }

  global.NyagiDriveEmbed = {
    extractDriveId: extractDriveId,
    driveViewUrl: driveViewUrl,
    drivePreviewUrl: drivePreviewUrl,
    renderText: renderText,
    hasDrive: hasDrive,
    injectStyle: injectStyleOnce,
  };
})(typeof window !== 'undefined' ? window : this);
