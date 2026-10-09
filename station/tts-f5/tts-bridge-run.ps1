# Start the new TTS bridge on :4124 in front of F5 (spec music 2026-09-23, stage 3).
# ASCII only: PS 5.1 reads BOM-less UTF-8 as ANSI.
# Everything that can fail is checked BEFORE the live bridge is removed: once it is
# gone the air has no TTS, so a failed start must end with a throw, not exit code 0.
param(
  [Parameter(Mandatory)][string]$Root,    # bridge dir on the GPU host, e.g. <gpu-ssd>\LLM\docker\tts-bridge
  [Parameter(Mandatory)][string]$Source,  # bridge.py to roll out (a copy of station/tts-bridge/bridge.py)
  [string]$Token = $env:GPU_CTL_TOKEN,    # GPU controller token; empty = from the live tts-bridge, then chatterbox-bridge
  [int]$HealthWaitSec = 120               # how long the new bridge may take to answer /health
)
$ErrorActionPreference = 'Continue'
$image = 'vllm/vllm-openai:v0.27.1'
$src = $Source
$dir = $Root

function Get-BridgeToken([string]$name) {
  $envs = docker inspect $name --format '{{range .Config.Env}}{{println .}}{{end}}' 2>$null
  if ($LASTEXITCODE -ne 0) { return '' }
  $line = $envs | Where-Object { $_ -like 'GPU_CTL_TOKEN=*' } | Select-Object -First 1
  return ($line -replace '^GPU_CTL_TOKEN=', '')
}

# 1. Token: parameter or environment, then the live tts-bridge, then the old chatterbox-bridge.
#    Read before the removal below: after it the live bridge env is gone.
if (-not $Token) { $Token = Get-BridgeToken 'tts-bridge' }
if (-not $Token) { $Token = Get-BridgeToken 'chatterbox-bridge' }
if (-not $Token) { throw 'no GPU_CTL_TOKEN: pass -Token or $env:GPU_CTL_TOKEN; neither tts-bridge nor chatterbox-bridge has one' }

# 2. Image: without it docker run fails after the live bridge is already removed.
docker image inspect $image --format '{{.Id}}' | Out-Null
if ($LASTEXITCODE -ne 0) { throw "image $image is not on this host; the live bridge is left running" }

# 3. Code: a byte copy, checked by hash.
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Copy-Item -LiteralPath $src -Destination "$dir\bridge.py" -Force
$h1 = (Get-FileHash -LiteralPath $src -Algorithm SHA256).Hash
$h2 = (Get-FileHash -LiteralPath "$dir\bridge.py" -Algorithm SHA256).Hash
"bridge.py byte copy, hash match: $($h1 -eq $h2)"
if ($h1 -ne $h2) { throw 'bridge.py copy mismatch' }

# 4. Replace the container. From here on a failure means the air has no bridge.
$old = docker ps -a --filter name=^tts-bridge$ --format '{{.Names}}'
if ($old) {
  docker rm -f tts-bridge | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "docker rm -f tts-bridge failed (exit $LASTEXITCODE)" }
}
docker run -d --name tts-bridge --restart unless-stopped --memory 256m --memory-swap 256m `
  -p 4124:4124 `
  --label com.docker.compose.project=tts-bridge --label com.docker.compose.service=tts-bridge `
  -e PORT=4124 -e UPSTREAM=http://host.docker.internal:4126 `
  -e GPU_CTL_URL=http://host.docker.internal:8119 -e "GPU_CTL_TOKEN=$Token" -e GPU_CTL_SLOT=tts `
  -v "${dir}:/bridge:ro" --entrypoint python3 $image /bridge/bridge.py | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker run tts-bridge failed (exit $LASTEXITCODE): the air has NO TTS bridge now" }

# 5. Health. The bridge answers 503 while F5 behind it is not ready, so an HTTP error
#    still proves the bridge itself is up; only silence means it did not start.
$deadline = (Get-Date).AddSeconds($HealthWaitSec)
$healthy = $false
$answered = $false
while (-not $healthy -and (Get-Date) -lt $deadline) {
  try {
    $health = Invoke-RestMethod http://127.0.0.1:4124/health -TimeoutSec 10
    $healthy = [bool]$health.ok
    $answered = $true
  } catch {
    if ($_.Exception.Response) { $answered = $true }
  }
  if (-not $healthy) { Start-Sleep 3 }
}
docker ps --filter name=^tts-bridge$ --format '{{.Names}} | {{.Status}} | {{.Ports}}'
docker inspect tts-bridge --format 'mounts={{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}| nets={{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}| labels={{index .Config.Labels "com.docker.compose.project"}}/{{index .Config.Labels "com.docker.compose.service"}}'
docker logs --tail 5 tts-bridge 2>&1
if (-not $healthy) {
  if ($answered) { throw "tts-bridge is up, but /health is not ok after $HealthWaitSec s: F5 on :4126 is not ready" }
  throw "tts-bridge did not answer /health in $HealthWaitSec s: the air has NO TTS bridge now"
}
'health: ok'
