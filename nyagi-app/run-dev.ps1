# NYAGI local dev - Worker + proxy server (same-origin, CORS回避)
# Usage: .\run-dev.ps1

$root = (Get-Item $PSScriptRoot).Parent.FullName
$workerDir = Join-Path $root "api\worker"
$nyagiDir = Join-Path $root "nyagi-app"

Write-Host "NYAGI dev server" -ForegroundColor Cyan
Write-Host "  http://localhost:8003/nyagi-app/"
Write-Host "  Login password: 3374"
Write-Host ""

# 1. Worker を先に起動（プロキシが 8787 に転送するため必須）
Write-Host "Starting Worker (8787)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$workerDir'; npx wrangler dev --port 8787"

# 2. Worker が応答するまで待機（接続拒否を防ぐ）
$maxWait = 30
$waited = 0
while ($waited -lt $maxWait) {
  Start-Sleep -Seconds 2
  $waited += 2
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/ops/auth/login" -Method POST -Headers @{"Content-Type"="application/json"; "X-Admin-Key"="dev-admin-key-change-in-production"} -Body '{"password":"3374"}' -TimeoutSec 3 -ErrorAction Stop
    if ($r.staffId) { Write-Host "  Worker OK" -ForegroundColor Green; break }
  } catch {}
  if ($waited -ge $maxWait) {
    Write-Host "  Worker が起動しません。Worker ウィンドウを確認してください。" -ForegroundColor Red
    exit 1
  }
}

# 3. 静的配信（8003。localhost は 8787 直、LAN/Tailscale は /api プロキシ経由）
Write-Host "Starting static server (8003)..." -ForegroundColor Yellow
Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$root'; python nyagi-app/dev-server-static.py"
Start-Sleep -Seconds 3

Start-Process "http://localhost:8003/nyagi-app/index.html"
Write-Host "Browser opened. Login with password 3374" -ForegroundColor Green

# スマホ用（モバイル回線＋Tailscale VPN）
$lanIp = $null
try {
  $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^192\.168\.' -or $_.IPAddress -match '^10\.' -or $_.IPAddress -match '^100\.' } | Select-Object -First 1
  if ($a) { $lanIp = $a.IPAddress }
} catch {}
if ($lanIp) {
  Write-Host ""
  Write-Host "スマホ（Tailscale/VPN）: http://${lanIp}:8003/nyagi-app/" -ForegroundColor Cyan
}
