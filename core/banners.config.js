/**
 * BAKENEKO GAMES 共通バナー設定
 *
 * HTML では <div class="ad-banner" data-banner="名前"></div> で配置。
 * core/banner-loader.js が自動で画像 or AdSense を挿入する。
 *
 * type:
 *   "image"   → 画像リンクバナー（imgSrc / url / alt）
 *   "adsense" → AdSense 広告ユニット（client / slot / width / height）
 *
 * gameOverrides:
 *   特定ゲームだけバナーを差し替えたい場合に GAME_ID をキーにして上書き定義。
 *   例: gameOverrides: { nameko: { 猫又療養所: { type: "image", ... } } }
 */
window.BANNERS_CONFIG = {
  version: 3,

  placements: {
    猫又療養所: {
      type: 'image',
      url: 'https://nekomata-sanatorium.com/support/',
      imgSrc: 'siyougazou/bananekomata.png',
      alt: '猫又療養所｜ハンディキャプシェルター 支援・寄付',
      width: 320,
      height: 100,
    },
    LINEスタンプ: {
      type: 'image',
      url: 'https://store.line.me/stickershop/author/2987510/ja',
      imgSrc: 'siyougazou/banasita.png',
      alt: 'BAKENEKO CAFE バナー',
      width: 320,
      height: 100,
    },
  },

  gameOverrides: {},
};
