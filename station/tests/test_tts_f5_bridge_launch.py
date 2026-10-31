"""The Windows launcher must not expose its controller token in Docker argv."""
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "tts-f5" / "tts-bridge-run.ps1"


@pytest.mark.skipif(os.name != "nt", reason="Windows launcher")
def test_bridge_passes_token_through_environment_and_restores_parent(tmp_path):
    source = tmp_path / "bridge.py"
    source.write_text("# fixture\n", encoding="utf-8")
    harness = tmp_path / "launch.ps1"
    harness.write_bytes(('''param($Launcher, $Root, $Source)
$ErrorActionPreference = 'Stop'
$global:radioRunArgs = @()
$global:radioChildToken = ''
function docker {
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'run') {
    $global:radioRunArgs = $args
    $global:radioChildToken = $env:GPU_CTL_TOKEN
  }
}
function Invoke-RestMethod { @{ok = $true} }
$env:GPU_CTL_TOKEN = 'previous-fixture'
& $Launcher -Root $Root -Source $Source -Token 'secret-fixture' -HealthWaitSec 1
if ($global:radioRunArgs.Count -eq 0) { throw 'docker run was not called' }
if (($global:radioRunArgs -join ' ') -match 'secret-fixture') { throw 'token exposed in argv' }
if ($global:radioChildToken -ne 'secret-fixture') { throw 'child did not receive token' }
if ($env:GPU_CTL_TOKEN -ne 'previous-fixture') { throw 'parent environment was not restored' }
'''.replace('\n', '\r\n')).encode('utf-8-sig'))
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", str(harness),
                             str(SCRIPT), str(tmp_path / "installed"), str(source)],
                            capture_output=True, timeout=10)
    assert result.returncode == 0, result.stderr.decode("utf-8", errors="replace")
