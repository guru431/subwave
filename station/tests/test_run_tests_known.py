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


def test_every_entry_names_an_existing_test():
    entries = re.findall(r'^\s*"([^"$]+)"\s*$', _known_block(), re.M)
    assert entries
    for entry in entries:
        file, _, name = entry.partition(" :: ")
        source = TESTS / file
        assert source.is_file(), entry
        if name and name != "*":
            assert name in source.read_text(encoding="utf-8"), entry
