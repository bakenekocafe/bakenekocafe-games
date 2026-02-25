# Core（共通レイヤ）

ゲーム群で共有するスクリプト。

- **config-loader.js** … 広告設定を API から遅延取得。`BakenekoCore.getAdsConfig(gameId)`。
- **rewarded-adapter.js** … リワード広告の抽象化。`BakenekoAds.showRewarded()`。広告 SDK はここでのみ遅延ロード。
- **analytics.js** … 計測イベントのキューと遅延送信。`BakenekoAnalytics.event(name, props)`。

## 原則

- 初期表示時に広告 SDK をロードしない。
- API 失敗時はゲームを止めない（フェイルセーフ）。
- ゲームは gameId を指定して利用する。
