"""Голоса службы: пары <имя>.wav + <имя>.txt в каталоге voices/.

Имя пары — то же, что стоит в persona.tts.voice станции. Эталоны грузятся в
память при старте тем же путём, что и эталон /clone (f5_audio.reference), и с
диска больше не читаются.
"""
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from f5_audio import decode_wav, reference
from f5_text import max_chars, normalize_ref_text

# Имена голосов OpenAI: мостик и шлюз шлют их по старой памяти Chatterbox (алиас
# alloy). Это не опечатка, а «голос по умолчанию» — без пометки о подмене.
OPENAI_VOICES = frozenset({"alloy", "ash", "ballad", "coral", "echo", "fable",
                           "nova", "onyx", "sage", "shimmer", "verse"})


@dataclass(frozen=True)
class Voice:
    name: str
    samples: np.ndarray
    sr: int
    ref_text: str
    max_chars: int


def voice_from_audio(name, samples, sr, ref_text) -> Voice:
    ref_audio = reference(samples, sr)
    if len(ref_audio) < sr:
        raise ValueError(f"{name}: после обрезки тишины эталон короче секунды")
    ref = normalize_ref_text(ref_text)
    return Voice(name, ref_audio, sr, ref, max_chars(ref, len(ref_audio) / sr))


def load_voices(directory) -> dict[str, Voice]:
    voices = {}
    for wav in sorted(Path(directory).glob("*.wav")):
        # имя едет в заголовке X-TTS-Voice-Used, а заголовки HTTP — latin-1:
        # голос с кириллицей в имени ронял бы в 500 каждый свой ответ
        if not (wav.stem.isascii() and wav.stem.isprintable()):
            raise ValueError(f"{wav.name}: имя голоса — только ASCII, оно едет в заголовке ответа")
        txt = wav.with_suffix(".txt")
        if not txt.exists():
            raise ValueError(f"{wav.name}: нет транскрипта {txt.name}")
        ref_text = txt.read_text(encoding="utf-8").strip()
        if not ref_text:
            raise ValueError(f"{txt.name}: пустой транскрипт")
        samples, sr = decode_wav(wav.read_bytes())
        voices[wav.stem] = voice_from_audio(wav.stem, samples, sr, ref_text)
    if not voices:
        raise ValueError(f"в {directory} нет ни одного голоса")
    return voices


def resolve(voices, requested, default):
    """(голос, подменён ли, причина).

    Пустое имя и имена OpenAI — голос по умолчанию без пометки; неизвестное
    непустое — тот же голос с пометкой: отказ 4xx на опечатке означал бы молчание
    эфира (мостик 4xx не повторяет, отката на piper нет).

    Причина уходит в заголовок X-TTS-Fell-Back-Reason, а заголовки — latin-1:
    имя экранируется json.dumps до ASCII. Опечатка в чужой раскладке («кг-кфше»)
    иначе дала бы 500 уже после синтеза; ASCII-имя остаётся как есть. Не строка
    (число, список из JSON клиента) — тоже неизвестное имя, а не 500."""
    if requested is not None and not isinstance(requested, str):
        requested = json.dumps(requested)
    name = (requested or "").strip()
    if not name or name.lower() in OPENAI_VOICES:
        return voices[default], False, None
    if name in voices:
        return voices[name], False, None
    return voices[default], True, f"unknown voice {json.dumps(name)}"
