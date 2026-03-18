# NYAGI 一括起動＋動作検証
# Usage: .\run-full-verify.ps1
# 事前に run-dev.ps1 で起動済みの場合は verify のみ実行

$ErrorActionPreference = "Stop"
$root = (Get-Item $PSScriptRoot).Parent.FullName
$workerDir = Join-Path $root "api\worker"
$nyagiDir = Join-Path $root "nyagi-app"

function Test-PortListening {
  param([int]$Port)
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return ($null -ne $conn)
}

function Stop-PortProcesses {
  param([int]$Port)
  $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($c in $conns) {
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
  }
  if ($conns) { Start-Sleep -Seconds 2 }
}

# 疎通確認
function Test-WorkerResponding {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/ops/auth/login" -Method POST -Headers @{"Content-Type"="application/json"; "X-Admin-Key"="dev-admin-key-change-in-production"} -Body '{"password":"3374"}' -TimeoutSec 5
    return ($r -and $r.staffId)
  } catch { return $false }
}
function Test-StaticResponding {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8003/nyagi-app/index.html" -UseBasicParsing -TimeoutSec 5
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

$workerUp = Test-WorkerResponding
$staticUp = Test-StaticResponding

if (-not $workerUp -and (Test-PortListening -Port 8787)) {
  Write-Host "Worker 8787 in bad state, freeing..." -ForegroundColor Yellow
  Stop-PortProcesses -Port 8787
  $workerUp = $false
}

if (-not $workerUp -or -not $staticUp) {
  Write-Host "Servers not ready. Run: .\run-dev.ps1" -ForegroundColor Yellow
  if (-not $workerUp) { Write-Host "  Worker (8787) not responding" -ForegroundColor Red }
  if (-not $staticUp) { Write-Host "  Static (8003) not responding" -ForegroundColor Red }
  exit 1
}

& (Join-Path $nyagiDir "verify.ps1")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
