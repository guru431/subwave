"""Operator shell contracts without containers, privilege changes or network."""
import os
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
BASH = (r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else shutil.which("bash"))


def shell(code, *args, env=None):
    paths = [str(arg).replace("\\", "/") if os.name == "nt" else str(arg) for arg in args]
    return subprocess.run([BASH, "-c", code, "ops-test", *paths],
                          capture_output=True, text=True, encoding="utf-8", timeout=5,
                          env={**os.environ, **(env or {})})


@pytest.mark.parametrize("relative,flag", [
    ("docker/broadcast-entrypoint.sh", "SUBWAVE_BROADCAST_LIB"),
    ("docker/aio/supervisor.sh", "SUBWAVE_SUPERVISOR_LIB"),
])
def test_icecast_renderer_preserves_password_and_auth_url_data(tmp_path, relative, flag):
    password = ' "&|\\$()`<secret>\' '
    auth_url = 'http://controller/listener-auth?a=1&b="<ok>"'
    mounts, proxies = tmp_path / "mounts.xml", tmp_path / "proxies.xml"
    proxies.write_text("<x-forwarded-for>127.0.0.1</x-forwarded-for>\n", encoding="utf-8")
    result = shell('''
set -eu
source "$1"
printf '<mount><authentication><option name="listener_add" value="%s"/></authentication></mount>\n' "$(xml_escape "$LISTENER_AUTH_URL")" > "$3"
render_icecast_template "$2" "$3" "$4"
''', ROOT / relative, ROOT / "docker/icecast.xml.template", mounts, proxies, env={
        flag: "1", "ICECAST_SOURCE_PASSWORD": password, "ICECAST_ADMIN_PASSWORD": password,
        "ICECAST_RELAY_PASSWORD": password, "ICECAST_MAX_CLIENTS": "100",
        "ICECAST_QUEUE_SIZE": "2097152", "ICECAST_BURST_SIZE": "1024", "LISTENER_AUTH_URL": auth_url,
    })
    assert result.returncode == 0, result.stderr
    xml = ET.fromstring(result.stdout)
    for name in ("source-password", "admin-password", "relay-password"):
        assert xml.findtext(f"authentication/{name}") == password
    assert xml.find("mount/authentication/option").attrib["value"] == auth_url
    assert xml.findtext("limits/clients") == "100"
    assert xml.findtext("paths/x-forwarded-for") == "127.0.0.1"


@pytest.mark.integration  # Three shell launches take >1s on Windows.
def test_update_compares_all_compose_files_in_order_before_any_mutation(tmp_path):
    (tmp_path / "scripts").mkdir()
    script = tmp_path / "scripts/update.sh"
    script.write_bytes((ROOT / "scripts/update.sh").read_bytes())
    base, override, other = (tmp_path / name for name in ("base.yml", "override.yml", "other.yml"))
    for path in (base, override, other):
        path.write_text("services: {}\n", encoding="utf-8")
    code = '''
set -eu
docker() {
    case "$*" in
        *" ps -q") printf 'container-id\n' ;;
        inspect*) printf '%s\n' "$ACTIVE_CONFIG" ;;
    esac
}
git() { printf '%s\n' "$*" >> "$MUTATIONS"; }
export -f docker git
bash "$1"
'''
    marker = tmp_path / "git-calls"
    # Ask Bash for its own absolute path spelling (MSYS uses /c/... labels).
    absolute = shell('cd "$1" && pwd', tmp_path)
    assert absolute.returncode == 0, absolute.stderr
    absolute = absolute.stdout.strip()
    env = {"COMPOSE_FILE": "base.yml:override.yml", "MUTATIONS": str(marker),
           "ACTIVE_CONFIG": f"{absolute}/base.yml,{absolute}/other.yml"}
    result = shell(code, script, env=env)
    assert result.returncode == 1 and "Running containers" in result.stderr
    assert not marker.exists()
    env["ACTIVE_CONFIG"] = f"{absolute}/override.yml,{absolute}/base.yml"
    result = shell(code, script, env=env)
    assert result.returncode == 1 and not marker.exists()
    env["ACTIVE_CONFIG"] = f"{absolute}/base.yml,{absolute}/override.yml"
    result = shell(code, script, env=env)
    assert result.returncode == 0, result.stderr
    assert "pull --ff-only" in marker.read_text(encoding="utf-8")
