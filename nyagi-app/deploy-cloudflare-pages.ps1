# NYAGI 静的ファイルを Cloudflare Pages「bakenekocafe-nyagi」へデプロイする。
# nyagi.bakenekocafe.studio および bakenekocafe.studio/nyagi-app/*（301 リダイレクト先）はこのプロジェクト。
# pages-final や bakenekocafe-games へのデプロイでは NYAGI 本体は更新されない。
$ErrorActionPreference = "Stop"
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$workerDir = Join-Path $repoRoot "api\worker"
Set-Location $workerDir
npx wrangler pages deploy $PSScriptRoot --project-name=bakenekocafe-nyagi --commit-dirty=true
