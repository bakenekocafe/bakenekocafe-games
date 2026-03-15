# NYAGI ローカル開発

## 起動手順

### 1. 一括起動（推奨）

```powershell
cd nyagi-app
.\run-dev.ps1
```

→ Worker (8787) を先に起動し、応答確認後に静的サーバー (8003) を起動。接続拒否を防ぐ。

### 2. 動作確認

```powershell
cd nyagi-app
.\run-full-verify.ps1
```

### 3. アクセス

- **URL**: http://localhost:8003/nyagi-app/
- **パスワード**: 3374

※ API は 8787 直。静的は 8003。プロキシ不要（接続拒否の原因を排除）。

## 手動起動

```powershell
# ターミナル1: Worker（必ず先に）
cd api/worker
npx wrangler dev --port 8787

# ターミナル2: 静的配信
cd KohadaJump_Migration
python nyagi-app/dev-server-static.py
# → http://localhost:8003/nyagi-app/
```

## トラブルシュート

- **接続拒否 (10061)**: Worker が起動していない。`run-dev.ps1` で Worker を先に起動する。
- **読み込み中で止まる**: `.\run-full-verify.ps1` で起動確認。
