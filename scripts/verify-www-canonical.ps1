#Requires -Version 5.1
<#
.SYNOPSIS
  Checks apex -> www 301 and www 200 (curl.exe).
#>
$ErrorActionPreference = 'Stop'
$apex = 'https://bakenekocafe.studio/'
$www  = 'https://www.bakenekocafe.studio/'

function Get-CurlHeaders {
  param([string]$Url)
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) {
    throw 'curl.exe not found.'
  }
  $out = & curl.exe -sI --max-redirs 0 $Url 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed: $out"
  }
  return ($out -join "`n")
}

Write-Host 'Step 1: apex (expect 301 Location -> www when rule is set)' -ForegroundColor Cyan
$h1 = Get-CurlHeaders -Url $apex
Write-Host $h1
$lines1 = $h1 -split "`n"
$status1 = ($lines1 | Where-Object { $_ -match '^HTTP/' } | Select-Object -First 1)
$loc1 = ($lines1 | Where-Object { $_ -match '^[Ll]ocation:\s*' } | Select-Object -First 1)
if ($status1 -match '\s301\s' -or $status1 -match '\s302\s' -or $status1 -match '\s308\s') {
  if ($loc1 -match 'www\.bakenekocafe\.studio') {
    Write-Host 'OK: apex redirects to www' -ForegroundColor Green
  } else {
    Write-Host 'WARN: redirect but Location may be wrong:' $loc1 -ForegroundColor Yellow
  }
} else {
  Write-Host 'Not set: apex returns 200 without redirect. Add Cloudflare Redirect Rule (see docs).' -ForegroundColor Yellow
}

Write-Host ''
Write-Host 'Step 2: www root' -ForegroundColor Cyan
$h2 = Get-CurlHeaders -Url $www
Write-Host $h2
$status2 = (($h2 -split "`n") | Where-Object { $_ -match '^HTTP/' } | Select-Object -First 1)
if ($status2 -match '\s200\s') {
  Write-Host 'OK: www returns 200' -ForegroundColor Green
} else {
  Write-Host 'WARN: unexpected status line:' $status2 -ForegroundColor Yellow
}
