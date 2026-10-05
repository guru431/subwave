"""Обезличиватель: карта «реальное → плейсхолдер» и остатки по денилисту.

Значения здесь вымышленные: настоящая карта лежит вне git.
"""
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("sanitize", ROOT / "tools" / "sanitize.py")
S = importlib.util.module_from_spec(_spec)
sys.modules["sanitize"] = S
_spec.loader.exec_module(S)

MAP = {"10.0.0.1": "<router>", "10.0.0.10": "<station-host>", "nas01": "gpu-host",
       "\\\\nas01\\data$\\Private": "<share>", "ru-anna": "ru-host"}


def rules():
    return S.compile_map(MAP)


def test_longest_key_wins_and_digits_are_bounded():
    text = r"\\nas01\data$\Private\x, nas01, 10.0.0.10 и 10.0.0.1, 10.0.0.100"
    assert S.sanitize_text(text, rules()) == \
        r"<share>\x, gpu-host, <station-host> и <router>, 10.0.0.100"


def test_replacement_ignores_case():
    assert S.sanitize_text("NAS01 и Ru-Anna", rules()) == "gpu-host и ru-host"


def test_patterns_catch_what_the_map_cannot(tmp_path):
    f = tmp_path / "doc.md"
    f.write_text("эталон Анны Петровой\n", encoding="utf-8")
    assert S.process(f, rules(), [re.compile("Петров", re.I)], check=False) == [f"{f}:1: Петров"]


def test_bom_and_crlf_survive(tmp_path):
    f = tmp_path / "a.ps1"
    f.write_bytes(S.BOM + "$h = 'nas01'\r\n".encode("utf-8"))
    assert S.process(f, rules(), [], check=False) == []
    assert f.read_bytes() == S.BOM + "$h = 'gpu-host'\r\n".encode("utf-8")


def test_check_mode_reports_and_does_not_write(tmp_path):
    f = tmp_path / "a.md"
    f.write_text("ssh nas01\n", encoding="utf-8")
    assert S.process(f, rules(), [], check=True) == [f"{f}:1: nas01"]
    assert f.read_text(encoding="utf-8") == "ssh nas01\n"


def test_main_exit_codes(tmp_path):
    m = tmp_path / "map.json"
    m.write_text(json.dumps(MAP), encoding="utf-8")
    none = str(tmp_path / "none")
    clean, dirty = tmp_path / "c.md", tmp_path / "d.md"
    clean.write_text("ничего\n", encoding="utf-8")
    dirty.write_text("nas01\n", encoding="utf-8")
    assert S.main(["--map", str(m), "--patterns", none, str(clean)]) == 0
    assert S.main(["--check", "--map", str(m), "--patterns", none, str(dirty)]) == 1
    assert S.main(["--map", str(m), "--patterns", none, str(dirty)]) == 0
    assert S.main(["--map", str(tmp_path / "absent.json"), str(clean)]) == 2
