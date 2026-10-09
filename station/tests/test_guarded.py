"""Сторож памяти guarded.sh снимает команду целиком — с её детьми — и выходит с кодом 3.

Дети — то, ради чего правка: `sudo docker build` переживал сигнал, посланный
одному процессу sudo. Здесь вместо sudo — sh с фоновым sleep; MIN_AVAIL выше
любой памяти, так что сторож снимает команду на первом же замере. Нужны Linux
(/proc/meminfo) и setsid — на рабочей машине Windows тесты пропускаются.
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

pytestmark = pytest.mark.skipif(
    not (Path("/proc/meminfo").is_file() and shutil.which("setsid") and shutil.which("bash")),
    reason="нужны Linux /proc/meminfo, setsid и bash")


def _guard(script: str, **env) -> subprocess.CompletedProcess:
    return subprocess.run(["bash", str(GUARD), "sh", "-c", script],
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


def test_low_memory_stops_the_command_with_its_children(tmp_path):
    child = tmp_path / "child"
    start = time.monotonic()
    r = _guard(f"sleep 30 & echo $! > {child}; wait")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "GUARD MemAvailable" in r.stdout
    assert time.monotonic() - start < 10
    assert _gone(int(child.read_text())), "фоновый sleep команды пережил сторожа"


@pytest.mark.integration      # ~2 с: ждёт GRACE
def test_a_command_deaf_to_sigterm_is_killed_after_grace(tmp_path):
    child = tmp_path / "child"
    r = _guard(f"trap '' TERM; sleep 30 & echo $! > {child}; wait", GRACE="1")
    assert r.returncode == 3, r.stdout + r.stderr
    assert "SIGKILL" in r.stdout
    assert _gone(int(child.read_text()))
