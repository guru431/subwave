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
$code = $LASTEXITCODE
"exit $code $(Get-Date -Format s)" | Add-Content -LiteralPath $log -Encoding ascii
# The service reads the pronunciation dictionary from the volume first (F5_PRONUNCIATION),
# so a fresh image must not keep running on an older volume copy. Temp file + rename: the
# service may look at the file in the middle of a copy.
if ($code -eq 0) {
  $vol = Join-Path $Root 'pronunciation'
  New-Item -ItemType Directory -Force -Path $vol | Out-Null
  $tmp = Join-Path $vol 'pronunciation.json.tmp'
  Copy-Item -LiteralPath (Join-Path $ctx 'pronunciation.json') -Destination $tmp -Force
  Move-Item -LiteralPath $tmp -Destination (Join-Path $vol 'pronunciation.json') -Force
  "pronunciation.json -> $vol" | Add-Content -LiteralPath $log -Encoding ascii
}
