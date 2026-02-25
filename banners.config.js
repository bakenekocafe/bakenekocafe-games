/**
 * 共通バナー一括管理（名前で参照）
 *
 * HTML では <div data-banner="名前"></div> で配置。
 * banner-loader.js が自動で画像 or AdSense を挿入する。
 *
 * type:
 *   "image"   → 画像リンクバナー（imgSrc / url / alt / width / height）
 *   "adsense" → AdSense 広告ユニット（client / slot / width / height）
 */
window.BANNERS_CONFIG = {
  version: 2,

  placements: {
    猫又療養所: {
      type: "image",
      url: "https://nekomata-sanatorium.com/support/",
      imgSrc: "siyougazou/bananekomata.png",
      alt: "猫又療養所｜ハンディキャプシェルター 支援・寄付",
      width: 320,
      height: 100,
    },
    LINEスタンプ: {
      type: "image",
      url: "https://store.line.me/stickershop/author/2987510/ja",
      imgSrc: "siyougazou/banaline.png",
      alt: "BAKENEKO CAFE LINEスタンプ",
      width: 320,
      height: 50,
    },
  },

  gameOverrides: {},
};
