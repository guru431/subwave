"""Проверки операторских инструментов без моделей и сетевых вызовов."""
import importlib.util
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

TOOLS = Path(__file__).resolve().parent.parent / "tts-f5" / "tools"


@pytest.mark.parametrize("heard,code,share", [("да", 1, "33%"), ("да да да", 0, "100%")])
def test_speech_check_counts_word_occurrences(monkeypatch, capsys, heard, code, share):
    spec = importlib.util.spec_from_file_location("check_speech", TOOLS / "check_speech.py")
    check = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(check)
    # Keep the command's exit-code contract under test, without loading Whisper.
    monkeypatch.setattr(check, "load", lambda _: (check.np.zeros(24000), 24000))
    monkeypatch.setattr(check, "flatness", lambda _: 0.2)
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(
        pipeline=lambda *a, **kw: lambda *a, **kw: {"text": heard}))
    monkeypatch.setattr(check.sys.stdout, "reconfigure", lambda **kw: None)
    assert check.main(["clip.wav", "--expect", "да да да"]) == code
    assert share in capsys.readouterr().out


@pytest.mark.parametrize("args", [[], ["--help"]])
def test_stress_audit_validates_arguments_before_loading_models(args):
    result = subprocess.run([sys.executable, "-X", "utf8", str(TOOLS / "stress_audit.py"), *args],
                            capture_output=True, text=True, encoding="utf-8", timeout=5)
    assert result.returncode == (0 if args else 2)
    assert "usage:" in result.stdout + result.stderr
    assert "Traceback" not in result.stderr


def test_prep_voice_missing_arguments_prints_usage_without_creating_files(tmp_path):
    script = TOOLS.parents[1] / "tts-bridge" / "prep_voice.py"
    result = subprocess.run([sys.executable, "-X", "utf8", str(script)], cwd=tmp_path,
                            capture_output=True, text=True, encoding="utf-8", timeout=5)
    assert result.returncode == 2
    assert "usage:" in result.stderr and "Traceback" not in result.stderr
    assert list(tmp_path.iterdir()) == []
