"""merge-preview.sh: сбой git — код 2, а не 1 («конфликты есть») и не 128.

Только чтение: скрипт падает на проверке ревизий, до merge-tree.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "merge-preview.sh"
BASH = shutil.which("bash")
if BASH and "system32" in BASH.lower():      # запуск WSL, а не оболочка этой машины
    BASH = None


def _preview(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run([BASH, SCRIPT.as_posix(), *args],
                          capture_output=True, encoding="utf-8", timeout=20)


@pytest.mark.skipif(not BASH or not shutil.which("git"), reason="нужны bash и git")
@pytest.mark.parametrize("args", [("no-such-target-ref",), ("HEAD", "no-such-ours-ref")])
def test_a_ref_git_cannot_resolve_exits_2(args):
    r = _preview(*args)
    assert r.returncode == 2, r.stdout + r.stderr
