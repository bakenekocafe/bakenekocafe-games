/**
 * NYAGI 共通ヘッダーナビ注入
 *
 * 各ページの `<nav class="header-nav">` の中身を、統一されたリンク一覧で
 * 置き換える。現在ページにあたるリンクは `class="nav-current"` が付与される。
 *
 * 項目の増減やラベル変更はこのファイルだけを編集すれば全ページに反映される。
 */
(function () {
  'use strict';

  var ITEMS = [
    { href: 'dashboard.html', label: 'ダッシュボード' },
    { href: 'cats.html', label: '猫一覧' },
    { href: 'tasks.html', label: 'タスク' },
    { href: 'bulletin.html', label: '掲示板' },
    { href: 'inquiries.html', label: '📮 問い合わせ' },
    { href: 'foods.html', label: 'フード' },
    { href: 'voice-dict.html', label: '🎤 辞書' },
    { href: 'medicines.html', label: '薬' },
    { href: 'manual.html', label: '📖 マニュアル' },
    { href: 'intake-admin.html', label: '引き受け申請' },
  ];

  /** 現在ページ判定用: 猫詳細(cat.html) は 猫一覧(cats.html) を active にする */
  var ALIAS = {
    'cat.html': 'cats.html',
    'index.html': 'dashboard.html',
    '': 'dashboard.html',
  };

  function currentPageFile() {
    var p = location.pathname || '';
    var m = p.match(/([^\/]+\.html)$/i);
    if (m) return m[1].toLowerCase();
    if (p === '/' || p === '') return 'index.html';
    return '';
  }

  function build() {
    var nav = document.querySelector('nav.header-nav');
    if (!nav) return;

    var cur = currentPageFile();
    var activeHref = ALIAS[cur] || cur;

    var html = '';
    for (var i = 0; i < ITEMS.length; i++) {
      var it = ITEMS[i];
      var cls = it.href === activeHref ? ' class="nav-current"' : '';
      html += '<a href="' + it.href + '"' + cls + '>' + it.label + '</a>';
    }
    nav.innerHTML = html;

    try {
      if (window.NyagiFixedHeader && typeof window.NyagiFixedHeader.update === 'function') {
        window.NyagiFixedHeader.update();
      }
    } catch (_) {}
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', build);
  } else {
    build();
  }
})();
