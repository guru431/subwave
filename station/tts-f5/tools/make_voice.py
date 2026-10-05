"""Эталон голоса для F5 из длинной записи: срез до 12 с по паузе + транскрипт.

    python make_voice.py <запись.wav> <имя> <каталог voices> [--text "транскрипт"]

Срез делает тот же f5_audio.reference, что служба применяет при загрузке голоса,
поэтому транскрипт описывает ровно то, что услышит модель. Без --text его
снимает whisper-small (нужны transformers и torch — на хосте gpu-host они есть в
venv пробы D:\\Temp\\f5-probe\\venv). Транскрипт проверить глазами: F5
выравнивает эталон по тексту, и лишнее или пропущенное слово портит клон.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

import f5_audio  # noqa: E402


def transcribe(x: np.ndarray, sr: int) -> str:
    from transformers import pipeline
    asr = pipeline("automatic-speech-recognition", model="openai/whisper-small", device="cpu")
    out = asr({"array": x.astype(np.float32), "sampling_rate": sr},
              generate_kwargs={"task": "transcribe", "language": "ru"})
    return out["text"].strip()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("source")
    ap.add_argument("name")
    ap.add_argument("out_dir")
    ap.add_argument("--text", help="транскрипт среза; без него — whisper-small")
    a = ap.parse_args(argv)
    x, sr = f5_audio.decode_wav(Path(a.source).read_bytes())
    ref = f5_audio.reference(x, sr)
    text = a.text if a.text else transcribe(ref, sr)
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / f"{a.name}.wav").write_bytes(f5_audio.encode_wav(ref, sr))
    (out / f"{a.name}.txt").write_text(text.strip() + "\n", encoding="utf-8")
    print(f"{a.name}: {len(ref) / sr:.2f} s at {sr} Hz")
    return 0


if __name__ == "__main__":
    sys.exit(main())
