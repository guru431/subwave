# Start the new TTS bridge on :4124 in front of F5 (spec music 2026-09-23, stage 3).
# ASCII only: PS 5.1 reads BOM-less UTF-8 as ANSI.
param(
  [Parameter(Mandatory)][string]$Root,    # bridge dir on the GPU host, e.g. <gpu-ssd>\LLM\docker\tts-bridge
  [Parameter(Mandatory)][string]$Source   # bridge.py to roll out (a copy of station/tts-bridge/bridge.py)
)
$ErrorActionPreference = 'Continue'
$src = $Source
$dir = $Root
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath $src -Destination "$dir\bridge.py" -Force
$h1 = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
$h2 = (Get-FileHash -LiteralPath "$dir\bridge.py" -Algorithm SHA256).Hash
"bridge.py byte copy, hash match: $($h1 -eq $h2)"
if ($h1 -ne $h2) { throw 'bridge.py copy mismatch' }
$envs = docker inspect chatterbox-bridge --format '{{range .Config.Env}}{{println .}}{{end}}'
$token = ($envs | Where-Object { $_ -like 'GPU_CTL_TOKEN=*' }) -replace '^GPU_CTL_TOKEN=', ''
if (-not $token) { throw 'no GPU_CTL_TOKEN in the old bridge env' }
$old = docker ps -a --filter name=^tts-bridge$ --format '{{.Names}}'
if ($old) { docker rm -f tts-bridge | Out-Null }
docker run -d --name tts-bridge --restart unless-stopped --memory 256m --memory-swap 256m `
  -p 4124:4124 `
  --label com.docker.compose.project=tts-bridge --label com.docker.compose.service=tts-bridge `
  -e PORT=4124 -e UPSTREAM=http://host.docker.internal:4126 `
  -e GPU_CTL_URL=http://host.docker.internal:8119 -e "GPU_CTL_TOKEN=$token" -e GPU_CTL_SLOT=tts `
  -v "${dir}:/bridge:ro" --entrypoint python3 vllm/vllm-openai:v0.27.1 /bridge/bridge.py | Out-Null
Start-Sleep 6
docker ps --filter name=^tts-bridge$ --format '{{.Names}} | {{.Status}} | {{.Ports}}'
docker inspect tts-bridge --format 'mounts={{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}| nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}| labels={{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}'
try { 'health: ' + (Invoke-RestMethod http://127.0.0.1:4124/health -TimeoutSec 20 | ConvertTo-Json -Compress) } catch { "health error: $_" }
docker logs --tail 5 tts-bridge 2>&1
