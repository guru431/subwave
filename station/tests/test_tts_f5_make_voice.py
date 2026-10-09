"""make_voice.py: эталон режется тем же f5_audio.reference, что служба применяет
при загрузке голоса, — транскрипт описывает ровно то, что услышит модель."""
import importlib.util
import io
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")      # без него пропускается этот файл, а не весь набор
F5_DIR = Path(__file__).resolve().parent.parent / "tts-f5"
sys.path.insert(0, str(F5_DIR))
import f5_audio as A  # noqa: E402

spec = importlib.util.spec_from_file_location("f5_make_voice", F5_DIR / "tools" / "make_voice.py")
tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tool)


def tone(seconds, sr=24000):
    t = np.arange(int(sr * seconds)) / sr
    return (0.1 * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def test_cut_at_pause_and_transcript_written(tmp_path):
    src = tmp_path / "long.wav"
    src.write_bytes(A.encode_wav(np.concatenate([tone(8.0), np.zeros(7200, np.float32), tone(9.7)])))
    out = tmp_path / "voices"
    assert tool.main([str(src), "ru-test", str(out), "--text", "Проверка связи"]) == 0
    y, sr = A.decode_wav((out / "ru-test.wav").read_bytes())
    assert abs(len(y) / sr - 8.05) < 0.03
    assert (out / "ru-test.txt").read_text(encoding="utf-8") == "Проверка связи\n"


def test_help_survives_a_cp1251_pipe(monkeypatch):
    """На Windows вывод в трубу (и по SSH на gpu-host) идёт в ANSI-кодировке: символ
    вне cp1251 в описании ронял --help трассой UnicodeEncodeError."""
    monkeypatch.setattr(sys, "stdout", io.TextIOWrapper(io.BytesIO(), encoding="cp1251"))
    with pytest.raises(SystemExit) as e:
        tool.main(["--help"])
    assert e.value.code == 0
