# NYAGI 静的ファイルを Cloudflare Pages「bakenekocafe-nyagi」へデプロイする。
# nyagi.bakenekocafe.studio および bakenekocafe.studio/nyagi-app/*（301 リダイレクト先）はこのプロジェクト。
# pages-final や bakenekocafe-games へのデプロイでは NYAGI 本体は更新されない。
$ErrorActionPreference = "Stop"
$nyagiDir = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$repoRoot = (Get-Item $PSScriptRoot).Parent.FullName
$workerDir = Join-Path $repoRoot "api\worker"
Set-Location $workerDir
# クォートなしだと wrangler にパスが渡らず失敗することがある（Windows / npx 経由）
npx wrangler pages deploy $nyagiDir --project-name=bakenekocafe-nyagi --commit-dirty=true
