"""Сторож памяти guarded.sh снимает команду целиком — с её детьми — и выходит с кодом 3.

Дети — то, ради чего правка: `sudo docker build` переживал сигнал, посланный
одному процессу sudo. Здесь вместо sudo — sh с фоновым sleep; MIN_AVAIL выше
любой памяти, так что сторож снимает команду на первом же замере. Эти тесты
нужны Linux (/proc/meminfo) и setsid — на рабочей машине Windows пропускаются.

Код 3 против кода команды проверяется и без Linux: setsid, sudo, kill и awk
подменены функциями bash (память — 0 МБ), так что логика сторожа идёт и в Git Bash
(дольше секунды — `-m integration`).
Проверка с настоящим sudo — руками на хосте станции
(station/docs/controller-changes.md, «Сборка образа под сторожем памяти»).
"""
import os
import shutil
import subprocess
import time
from pathlib import Path

import pytest

GUARD = Path(__file__).resolve().parent.parent / "tools" / "guarded.sh"
BASH = shutil.which("bash")
if BASH and "system32" in BASH.lower():      # запуск WSL, а не оболочка этой машины
    BASH = None

linux = pytest.mark.skipif(
    not (Path("/proc/meminfo").is_file() and shutil.which("setsid") and BASH),
    reason="нужны Linux /proc/meminfo, setsid и bash")
with_bash = pytest.mark.skipif(not BASH, reason="нет bash")


def _guard(script: str, **env) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, str(GUARD), "sh", "-c", script],
                          env={**os.environ, "MIN_AVAIL": "999999", **env},
                          capture_output=True, text=True, timeout=25)


def _gone(pid: int, within: float = 3.0) -> bool:
    """Процесс завершился: его нет или он зомби (родитель-init ещё не забрал)."""
    deadline = time.monotonic() + within
    while time.monotonic() < deadline:
        try:
            state = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0]
        except (FileNotFoundError, ProcessLookupError):
            return True
        if state == "Z":
            return True
        time.sleep(0.05)
    return False


@linux
def test_low_memory_stops_the_command_with_its_children(tmp_path):
    child = tmp_path / "child"
    start = time.monotonic()
    r = _guard(f"sleep 30 & echo $! > {child}; wait")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "GUARD MemAvailable" in r.stdout
    assert time.monotonic() - start < 10
    assert _gone(int(child.read_text())), "фоновый sleep команды пережил сторожа"


@linux
@pytest.mark.integration      # ~2 с: ждёт GRACE
def test_a_command_deaf_to_sigterm_is_killed_after_grace(tmp_path):
    child = tmp_path / "child"
    r = _guard(f"trap '' TERM; sleep 30 & echo $! > {child}; wait", GRACE="1")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "SIGKILL" in r.stdout
    assert _gone(int(child.read_text()))


# Подмены для логики без Linux: группа — сам процесс (setsid просто exec),
# sudo -n отказывает, памяти 0 МБ — снятие на первой проверке. kill — по
# сценарию: доставляет сигнал процессу или отказывает, как «нет прав».
SUBST = """setsid() { exec "$@"; }
sudo() { return 1; }
awk() { echo 0; }
%s
export -f setsid sudo awk kill
exec bash "$1" sleep "$2"
"""
KILL_DELIVERS = 'kill() { [ "$2" = -- ] && set -- "$1" "${3#-}"; command kill "$@"; }'
KILL_DENIED = "kill() { return 1; }"


def _substituted(tmp_path, kill: str, sleep: str) -> subprocess.CompletedProcess:
    wrapper = tmp_path / "subst.sh"
    wrapper.write_bytes((SUBST % kill).encode())
    return subprocess.run([BASH, wrapper.as_posix(), GUARD.as_posix(), sleep],
                          capture_output=True, encoding="utf-8", timeout=25)


@with_bash
@pytest.mark.integration      # ~1.2 с: две проверки сторожа по 0.5 с
def test_a_delivered_stop_exits_3(tmp_path):
    r = _substituted(tmp_path, KILL_DELIVERS, "30")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "GUARD снято" in r.stdout


@with_bash
@pytest.mark.integration      # ~1.3 с
def test_an_undelivered_stop_keeps_the_command_own_code(tmp_path):
    # Сигнал не дошёл, команда доработала сама — это не «снято», и код её.
    r = _substituted(tmp_path, KILL_DENIED, "0.8")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "нет прав" in r.stdout and "снять не удалось" in r.stdout
    assert "GUARD снято" not in r.stdout
