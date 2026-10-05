"""Речь или шум: whisper-small распознаёт WAV и сверяет слова с ожидаемым текстом.

    python check_speech.py <файл.wav> [--expect "ожидаемый текст"]

smoke.py проверяет только HTTP и формат: 23.09 он отвечал OK на шипение, которое
F5 выдавал с неверным конфигом, и эфир 18 минут шёл с хрипами. Эта проверка —
обязательная часть окна приёмки. Запускать в венве с transformers и torch (на
gpu-host — D:\\Temp\\f5-probe\\venv, кэш whisper — HF_HOME=<каталог службы>\\hf-host).
Код выхода 1 — если совпало меньше 40% ожидаемых слов. Порог низкий намеренно:
whisper пишет числа цифрами и коверкает латинские имена, так что даже чистая речь
F5 даёт 47–70% («девятнадцать сорок пять» → «19.45»), а шум — около нуля.
"""
import argparse
import re
import sys
import wave

import numpy as np


def words(text: str) -> list[str]:
    return re.findall(r"[a-zа-я0-9]+", text.lower().replace("ё", "е"))


def load(path):
    with wave.open(path, "rb") as w:
        sr, ch, width, n = w.getframerate(), w.getnchannels(), w.getsampwidth(), w.getnframes()
        raw = w.readframes(n)
    if width != 2:
        raise SystemExit(f"{path}: ожидался PCM 16 бит, а не {8 * width}")
    x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768
    return (x.reshape(-1, ch).mean(axis=1) if ch > 1 else x), sr


def flatness(x) -> float:
    """Спектральная плоскость — справочно, не критерий: у шума F5 23.09 было 0.31–0.41,
    у его речи 0.21–0.24, но у заведомо чистого Chatterbox она доходит до 0.35 (замер
    music-17 по ffmpeg aspectralstats). Решает только сверка слов."""
    frames = x[: len(x) // 1024 * 1024].reshape(-1, 1024) * np.hanning(1024)
    spec = np.abs(np.fft.rfft(frames, axis=1)) + 1e-9
    return float(np.median(np.exp(np.mean(np.log(spec), axis=1)) / np.mean(spec, axis=1)))


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("wav")
    ap.add_argument("--expect", help="текст, который должен прозвучать")
    a = ap.parse_args(argv)
    sys.stdout.reconfigure(encoding="utf-8")
    x, sr = load(a.wav)
    from transformers import pipeline
    asr = pipeline("automatic-speech-recognition", model="openai/whisper-small", device="cpu")
    heard = asr({"array": x, "sampling_rate": sr},
                generate_kwargs={"task": "transcribe", "language": "ru"})["text"].strip()
    print(f"{a.wav}: {len(x) / sr:.1f} с, плоскость спектра {flatness(x):.3f}\n  услышано: «{heard}»")
    if not a.expect:
        return 0
    want, got = words(a.expect), set(words(heard))
    share = sum(w in got for w in want) / max(1, len(want))
    print(f"  совпало слов: {share:.0%}")
    return 0 if share >= 0.4 else 1


if __name__ == "__main__":
    sys.exit(main())
