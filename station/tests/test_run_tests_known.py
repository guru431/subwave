"""Списки известных падений run-tests.sh: KNOWN (образ) и KNOWN_SRC (--src).

«файл :: *» засчитывал известным любое падение файла — и регрессию тех его
тестов, что гоняют код форка. Сопоставление проверяется самой функцией
is_known из скрипта, через bash; имена тестов — по исходникам controller/scripts.
"""
import re
import shutil
import subprocess
from pathlib import Path

import pytest

STATION = Path(__file__).resolve().parent.parent
REPO = STATION.parent
SCRIPT = STATION / "run-tests.sh"
TESTS = REPO / "controller" / "scripts"


def _bash():
    bash = shutil.which("bash")
    # System32\bash.exe — запуск WSL, а не оболочка этой машины.
    if not bash or "system32" in bash.lower():
        pytest.skip("нет bash")
    return bash


def _known_block() -> str:
    text = SCRIPT.read_text(encoding="utf-8")
    start = re.search(r"^KNOWN(_SRC)?=\(", text, re.M).start()
    end = re.search(r"^SKIP_FILES=", text, re.M).start()
    func = re.search(r"^is_known\(\) \{.*?^\}", text, re.M | re.S).group(0)
    return text[start:end] + "\n" + func + "\n"


def _known(tmp_path, src: str, keys: list[str]) -> dict[str, bool]:
    script = tmp_path / "known.sh"
    script.write_bytes(("set -u\nSRC=$1\n" + _known_block() + """
while IFS= read -r k; do
  if is_known "$k"; then echo 1; else echo 0; fi
done
""").encode("utf-8"))
    out = subprocess.run([_bash(), str(script), src], input="\n".join(keys).encode("utf-8") + b"\n",
                         capture_output=True, check=True, timeout=20).stdout.decode().split()
    return dict(zip(keys, (v == "1" for v in out)))


# Ключи в формате, в каком их собирает failures(): «файл» или «файл :: тест».
READS_ABSENT = "show-boundary-drain.test.ts :: a boundary cut is a plain crossfade — every gesture stands down"
NEIGHBOURS = [
    "show-boundary-drain.test.ts :: a re-drain takes a stale flag back off again",
    "transition-effects.test.ts :: the drain strips only the switched-off gesture, never its partner",
    "settings-talk-placement-route.test.ts :: GET /settings returns saved DJ behaviour for authoritative form hydration",
    "gemini-tts.test.ts :: gemini still reads the standard key, never the pool",
    "gemini-tts-settings.test.ts :: the real choices round-trip",
]


def test_image_run_knows_only_the_tests_that_read_absent_dirs(tmp_path):
    got = _known(tmp_path, "-", [READS_ABSENT, "jingle-play.test.ts", "gen-schemas.test.ts", *NEIGHBOURS])
    assert got[READS_ABSENT] and got["jingle-play.test.ts"] and got["gen-schemas.test.ts"]
    assert [k for k in NEIGHBOURS if got[k]] == []


def test_src_run_knows_only_what_the_image_lacks(tmp_path):
    keys = ["gen-schemas.test.ts", "analyzer-python.test.ts", "jingle-play.test.ts", READS_ABSENT]
    got = _known(tmp_path, "/home/u/radio", keys)
    assert got == {"gen-schemas.test.ts": True, "analyzer-python.test.ts": True,
                   "jingle-play.test.ts": False, READS_ABSENT: False}


def test_remote_watchdog_polls_proc_not_kill_0():
    """$pid удалённой части — процесс `sudo docker run`, он принадлежит root.
    `kill -0` ему отвечает «нет прав», цикл сторожа кончался с первой проверки —
    ни сторожа памяти, ни потолка времени. Проверка на хосте — руками:
    `sudo sleep 30 & kill -0 $!; echo $?` даёт 1."""
    text = SCRIPT.read_text(encoding="utf-8")
    remote = re.search(r"<<'EOF'\n(.*?)^EOF$", text, re.M | re.S).group(1)
    code = [ln for ln in remote.splitlines() if not ln.lstrip().startswith("#")]
    assert not [ln for ln in code if "kill -0" in ln]
    assert 'while [ -e "/proc/$pid" ]; do' in remote


def test_every_entry_names_an_existing_test():
    entries = re.findall(r'^\s*"([^"$]+)"\s*$', _known_block(), re.M)
    assert entries
    for entry in entries:
        file, _, name = entry.partition(" :: ")
        source = TESTS / file
        assert source.is_file(), entry
        if name and name != "*":
            assert name in source.read_text(encoding="utf-8"), entry


def _summary(tmp_path, log: str) -> subprocess.CompletedProcess:
    """Разбор итога из самого скрипта — от проверки TESTS_ENV до конца — над
    подставным выводом прогона (SRC=-, ssh не нужен)."""
    text = SCRIPT.read_text(encoding="utf-8")
    tail = text[re.search(r"^grep -qE '\^TESTS_", text, re.M).start():]
    script = tmp_path / "summary.sh"
    script.write_bytes(("set -u\nSRC=-\nout=$1\nrc=$2\n" + _known_block() + tail).encode("utf-8"))
    out = tmp_path / "out.log"
    out.write_bytes(log.encode("utf-8"))
    return subprocess.run([_bash(), script.as_posix(), out.as_posix(), "1"],
                          capture_output=True, encoding="utf-8", timeout=20)


MIRROR = "the mirror carries the skill schema to the browser"


def _log(fail: int, *entries: str) -> str:
    failing = "".join(f"test at /app/scripts/skill-schema.test.ts:1:1\n✖ {e} (0.5ms)\n  Error: x\n\n"
                      for e in entries)
    return (f"ℹ tests 30\nℹ pass {30 - fail}\nℹ fail {fail}\nℹ skipped 0\nℹ todo 0\n\n"
            f"✖ failing tests:\n\n{failing}")


def test_summary_with_only_known_failures_passes(tmp_path):
    r = _summary(tmp_path, _log(1, MIRROR))
    assert r.returncode == 0, r.stdout + r.stderr
    assert "TESTS_RESULT pass=29 fail=0 skip=1" in r.stdout


def test_a_failure_the_parser_missed_is_a_new_failure(tmp_path):
    # ℹ fail 2, а в списке одна строка: второе падение разбор не узнал.
    r = _summary(tmp_path, _log(2, MIRROR))
    assert r.returncode == 1, r.stdout + r.stderr
    assert "ℹ fail 2" in r.stdout and "TESTS_RESULT pass=28 fail=1" in r.stdout


def test_two_failures_with_one_name_are_not_a_parser_miss(tmp_path):
    r = _summary(tmp_path, _log(2, MIRROR, MIRROR))
    assert r.returncode == 0, r.stdout + r.stderr
