/**
 * BAKENEKO GAMES 共通 X(Twitter) シェアテンプレート
 *
 * 新規ゲーム開発時: リザルト画面のシェアでは imageBlob（リザルト画像）を実装すること。
 * リザルト画像を canvas で描画して toBlob し、post({ ..., imageBlob, imageFileName }) で渡す。
 * 実装例: こはだ game.js（createRecordImageBlob）、なめこ nameko-balance/js/app.js（createRecordImageBlob）。
 *
 * 使い方:
 *   BakenekoShare.post({
 *     result:   '🐱💨 こはだの飛距離: 45.123km！',   // メイン結果テキスト（必須）
 *     rank:     12,                                   // 世界ランキング順位（省略可）
 *     score:    '45.123km',                           // スコア表示（省略可、resultに含めてもOK）
 *     tags:     ['こはだジャンプ', 'BAKENEKOドリーム'], // ハッシュタグ（#は不要）
 *     gameUrl:  'https://www.bakenekocafe.studio/game.html',
 *     gameName: 'こはだジャンプ',                      // ゲーム名（省略可）
 *     imageBlob: blob,                                // シェア画像 Blob（新規ゲームでは実装推奨）
 *     imageFileName: 'result.png',                    // 画像ファイル名（省略時: share.png）
 *   });
 */
(function () {
  'use strict';

  var PORTAL_URL = 'https://www.bakenekocafe.studio/';

  function formatDate() {
    var d = new Date();
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function buildText(opts) {
    var lines = [];

    lines.push(opts.result || '');

    lines.push('\u{1F4C5} ' + formatDate());

    if (opts.rank && typeof opts.rank === 'number') {
      lines.push('\u{1F3C6} 世界ランキング ' + opts.rank + '位');
    }

    if (opts.tags && opts.tags.length) {
      lines.push(opts.tags.map(function (t) { return '#' + t; }).join(' '));
    }

    lines.push('');
    if (opts.gameUrl) lines.push('\u{1F3AE} ' + opts.gameUrl);
    lines.push('\u{1F3E0} ' + PORTAL_URL);

    return lines.join('\n');
  }

  function openTweet(text) {
    window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text), '_blank');
  }

  function post(opts) {
    if (!opts) opts = {};
    var text = buildText(opts);

    if (opts.imageBlob && typeof navigator !== 'undefined' && navigator.share) {
      var fileName = opts.imageFileName || 'share.png';
      try {
        var file = new File([opts.imageBlob], fileName, { type: opts.imageBlob.type || 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ text: text, files: [file] })
            .catch(function () { openTweet(text); });
          return;
        }
      } catch (_) {}
    }

    openTweet(text);
  }

  window.BakenekoShare = {
    post: post,
    buildText: buildText,
    PORTAL_URL: PORTAL_URL,
  };
})();
