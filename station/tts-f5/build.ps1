# Build f5-tts:local on the GPU host. Must run in the interactive session: Docker
# Desktop's credential helper fails in SSH session 0. Started by a temporary
# scheduled task with LogonType Interactive (see README.md). ASCII only: PS 5.1
# reads BOM-less UTF-8 as ANSI.
param([Parameter(Mandatory)][string]$Root)   # service dir on the GPU host, e.g. <gpu-ssd>\LLM\docker\f5-tts
$ErrorActionPreference = 'Continue'
$ctx = Join-Path $Root 'app'
$log = Join-Path $Root 'build.log'
"build started $(Get-Date -Format s)" | Set-Content -LiteralPath $log -Encoding ascii
docker build --progress=plain -t f5-tts:local $ctx 2>&1 | Out-File -LiteralPath $log -Append -Encoding utf8
"exit $LASTEXITCODE $(Get-Date -Format s)" | Add-Content -LiteralPath $log -Encoding ascii
