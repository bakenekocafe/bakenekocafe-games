# bakeneko-cafe.tokyo に ads.txt を置く（AdSense 乗せ続ける場合）

AdSense で **`bakeneko-cafe.tokyo`** をサイト一覧に載せ続ける場合、**ルートの `ads.txt` が必須**です。  
中身は **BAKENEKO GAMES（.studio）と同一の Publisher ID** で問題ありません（同じ AdSense アカウントなら同じ行）。

## 置く内容（そのままコピー可）

ファイル名: **`ads.txt`**（拡張子のみ・大文字小文字そのまま）

```
google.com, pub-5189561379756793, DIRECT, f08c47fec0942fa0
```

リポジトリ内のコピー: `docs/bakeneko-cafe.tokyo-ads.txt`

## 配置URL

公開後、ブラウザで次が **200 で1行（または上記と一致）** と表示されること:

- **https://bakeneko-cafe.tokyo/ads.txt**

`www` がある場合は **https://www.bakeneko-cafe.tokyo/ads.txt** も同様に確認。  
**AdSense に登録しているホスト名と一致する方**に必ず置く（両方使うなら両方に同じ内容を推奨）。

## 設置方法の例

- **レンタルサーバー / FTP**: ドキュメントルート（`public_html` 等）の直下に `ads.txt` をアップロード。
- **WordPress**:  
  - ルートに直接置けるなら上記と同じ。  
  - プラグインや「ファイルマネージャ」でルートにアップロード。  
  - キャッシュプラグイン利用時は `ads.txt` をキャッシュ対象から除外するか、パージ後に再確認。
- **Cloudflare 等 CDN**: オリジンにファイルがあり、パス `/ads.txt` が他ルールで上書きされていないことを確認。

## 反映確認

1. シークレットウィンドウで `https://bakeneko-cafe.tokyo/ads.txt` を開く。  
2. AdSense の **サイトの管理** で当該サイトの **ads.txt ステータス**が **承認済み** に近づくまで **24〜48時間** 程度かかることがあります。

## メモ

- Publisher ID はサイトごとに変えるものではなく、**アカウントに紐づく ID** です。  
- `.studio` のポータル用 `ads.txt` と**同じ1行**で正しいです。
