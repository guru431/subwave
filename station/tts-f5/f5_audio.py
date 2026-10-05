"""Звук F5-службы: WAV без soundfile, обрезка тишины, эталон ≤12 с, громкость, склейка.

Только numpy и стандартный `wave`: модуль грузится и в быстром наборе music, где
нет ни soundfile, ни torch, и в контейнере службы. Эталон владельца digital_me
проходит здесь целиком в памяти — ни одна функция не пишет на диск.
"""
import io
import wave

import numpy as np

SR = 24000                    # частота выхода F5 (вокодер vocos-mel-24khz)
REF_MAX_SECONDS = 12.0        # длиннее F5 эталон молча режет (utils_infer.py:344)
PEAK_CEILING = 32000 / 32768  # потолок пика, как PEAK_CEILING в digital_me/scripts/tts.py
MAX_SR = 384000               # выше — не запись, а мусор в заголовке: по частоте режутся буферы


class UnsupportedAudio(ValueError):
    """Не WAV с целочисленным PCM. Служба отвечает 415 и не отдаёт такие байты в
    pydub/ffmpeg: те на других форматах сами пишут временный файл."""


def decode_wav(data: bytes) -> tuple[np.ndarray, int]:
    """WAV → (моно float32 в [-1, 1], частота). PCM 16, 24 и 32 бит."""
    try:
        w = wave.open(io.BytesIO(data), "rb")
    except (wave.Error, EOFError) as e:
        raise UnsupportedAudio(f"не WAV PCM: {e}") from None
    with w:
        channels, width, sr = w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(w.getnframes())
    if not 0 < sr <= MAX_SR or channels <= 0:
        raise UnsupportedAudio(f"частота {sr} Гц, каналов {channels}")
    # оборванный файл кончается посреди кадра: wave отдаёт хвост как есть, а
    # numpy на нём падал ValueError — клиент получал 500 вместо 415 или звука
    raw = raw[: len(raw) // (width * channels) * (width * channels)]
    if width == 2:
        x = np.frombuffer(raw, "<i2").astype(np.float32) / 32768.0
    elif width == 3:
        b = np.frombuffer(raw, np.uint8).reshape(-1, 3).astype(np.int32)
        i = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        x = np.where(i & 0x800000, i - 0x1000000, i).astype(np.float32) / 8388608.0
    elif width == 4:
        x = np.frombuffer(raw, "<i4").astype(np.float32) / 2147483648.0
    else:
        raise UnsupportedAudio(f"глубина {8 * width} бит не поддерживается")
    if channels > 1:
        x = x.reshape(-1, channels).mean(axis=1)
    if x.size == 0:
        raise UnsupportedAudio("в WAV нет ни одного отсчёта")
    return x.astype(np.float32), sr


def encode_wav(x: np.ndarray, sr: int = SR) -> bytes:
    """Моно float → WAV PCM 16 бит: его ждут audio_join.py digital_me и контроллер станции."""
    pcm = np.clip(np.round(np.asarray(x, np.float32) * 32768.0), -32768, 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _frame_db(x: np.ndarray, sr: int, win_ms: int) -> tuple[np.ndarray, int]:
    n = max(1, int(sr * win_ms / 1000))
    frames = len(x) // n
    if frames == 0:
        return np.zeros(0), n
    f = np.asarray(x[: frames * n], np.float32).reshape(frames, n)
    return 20 * np.log10(np.sqrt(np.mean(f * f, axis=1)) + 1e-12), n


def trim_edges(x, sr, thresh_db=-42.0, win_ms=10, keep_ms=0):
    """Срезать тишину по краям — порог как у remove_silence_edges в F5 (−42 dBFS);
    keep_ms оставляет запас, чтобы не срезать тихие окончания слов."""
    db, n = _frame_db(x, sr, win_ms)
    loud = np.nonzero(db > thresh_db)[0]
    if loud.size == 0:
        return x[:0]
    k = int(sr * keep_ms / 1000)
    return x[max(0, loud[0] * n - k): min(len(x), (loud[-1] + 1) * n + k)]


def trim_tail(x, sr, thresh_db=-42.0, win_ms=10, keep_ms=50):
    """Срезать хвостовую тишину, оставив keep_ms: секунды HeyGen у digital_me платные."""
    db, n = _frame_db(x, sr, win_ms)
    loud = np.nonzero(db > thresh_db)[0]
    if loud.size == 0:
        return x
    return x[: min(len(x), (loud[-1] + 1) * n + int(sr * keep_ms / 1000))]


def cap_seconds(x, sr, seconds=REF_MAX_SECONDS, min_seconds=6.0, gap_db=-40.0,
                gap_ms=100, win_ms=10):
    """Эталон не длиннее `seconds`. Резать по последней паузе, начавшейся после
    `min_seconds`, как F5 (utils_infer.py:318-346); пауз нет — ровно по пределу."""
    limit = int(sr * seconds)
    if len(x) <= limit:
        return x
    db, n = _frame_db(x[:limit], sr, win_ms)
    need = max(1, gap_ms // win_ms)
    first = int(min_seconds * sr) // n
    cut, run = None, 0
    for i, quiet in enumerate(db < gap_db):
        run = run + 1 if quiet else 0
        start = i - run + 1
        if run >= need and start >= first:
            cut = start * n
    return x[:cut] if cut else x[:limit]


def reference(x, sr):
    """Эталон для F5: без тишины по краям, ≤12 с, плюс 50 мс тишины в конце —
    та же подготовка, что preprocess_ref_audio_text (utils_infer.py:316-348),
    только в памяти."""
    y = trim_edges(cap_seconds(trim_edges(x, sr), sr), sr)
    return np.concatenate([y, np.zeros(int(sr * 0.05), np.float32)]).astype(np.float32)


def normalize_broadcast(x, target_dbfs=-17.0, peak_ceiling=PEAK_CEILING):
    """Громкость эфира: RMS −17 dBFS, но пик не выше потолка.

    F5 на ~12 dB тише Chatterbox, а ручка станции tts.gainDb зажата в ±12 и уже
    стоит на +9. Потолок пика — по образцу digital_me/scripts/tts.py: без него на
    пик-факторе 18 dB нормализация по RMS срезала бы вершины."""
    x = np.asarray(x, np.float32)
    if x.size == 0:
        return x
    rms = float(np.sqrt(np.mean(x * x)))
    peak = float(np.max(np.abs(x)))
    if rms < 1e-6 or peak < 1e-6:
        return x
    gain = min(10 ** (target_dbfs / 20) / rms, peak_ceiling / peak)
    return np.clip(x * gain, -1.0, 1.0).astype(np.float32)


def join_with_pauses(waves, pauses_ms, sr=SR, lead_ms=100):
    """Куски подряд, после каждого — тишина заданной длины (f5_text.pieces).

    Вместо кроссфейда 0.15 с, как у infer_batch_process: он съедал паузу на стыке,
    а паузы теперь ставятся явно по знакам препинания."""
    if not waves:
        return np.zeros(0, np.float32)
    out = [np.zeros(int(sr * lead_ms / 1000), np.float32)]
    for wave, ms in zip(waves, pauses_ms):
        out += [np.asarray(wave, np.float32), np.zeros(int(sr * ms / 1000), np.float32)]
    return np.concatenate(out)
