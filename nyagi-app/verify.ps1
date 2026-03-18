# NYAGI 動作検証スクリプト
$ErrorActionPreference = "Stop"

Write-Host "=== NYAGI 動作チェック ===" -ForegroundColor Cyan

# 1. Worker 直接
Write-Host "1. Worker (8787)..." -ForegroundColor Yellow
try {
  $login = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/ops/auth/login" -Method POST `
    -Headers @{"Content-Type"="application/json"; "X-Admin-Key"="dev-admin-key-change-in-production"} `
    -Body '{"password":"3374"}' -TimeoutSec 15
  if ($login.staffId) { Write-Host "   OK: staff_endo" -ForegroundColor Green } else { throw "No staffId" }
} catch {
  Write-Host "   NG: Worker not running. Run: cd api/worker; npx wrangler dev --port 8787" -ForegroundColor Red
  exit 1
}

# 2. API（8787 直接。アプリは 8787 直で通信）
Write-Host "2. API (8787)..." -ForegroundColor Yellow
try {
  $cats = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/ops/cats/overview?location=all&status=active" `
    -Headers @{"X-Admin-Key"="dev-admin-key-change-in-production"; "X-Staff-Id"="staff_endo"} -TimeoutSec 15
  $n = ($cats.cats | Measure-Object).Count
  if ($n -gt 0) { Write-Host "   OK: $n cats" -ForegroundColor Green } else { throw "No cats" }
} catch {
  Write-Host "   NG: Worker not responding. Step 1 passed?" -ForegroundColor Red
  exit 1
}

# 3. 静的ファイル（8003）
Write-Host "3. Static (8003/nyagi-app)..." -ForegroundColor Yellow
try {
  $r = Invoke-WebRequest -Uri "http://127.0.0.1:8003/nyagi-app/index.html" -UseBasicParsing -TimeoutSec 10
  if ($r.StatusCode -eq 200 -and $r.Content -match "NYAGI") { Write-Host "   OK" -ForegroundColor Green } else { throw "Bad" }
} catch {
  Write-Host "   NG: run-dev.ps1 で静的サーバーを起動してください" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "All checks passed." -ForegroundColor Green
Write-Host "Open: http://localhost:8003/nyagi-app/  Login: 3374" -ForegroundColor Cyan
