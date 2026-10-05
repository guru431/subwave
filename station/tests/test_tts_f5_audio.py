"""f5_audio: звук F5-службы без soundfile и без записи на диск.

Эталон владельца digital_me проходит через эти функции целиком в памяти, а
громкость эфира выравнивается здесь, потому что F5 на ~12 dB тише Chatterbox.
"""
import io
import sys
import wave
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
import f5_audio as A  # noqa: E402

SR = 24000


def tone(seconds, db=-20.0, sr=SR, hz=220.0):
    t = np.arange(int(sr * seconds)) / sr
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def silence(seconds, sr=SR):
    return np.zeros(int(sr * seconds), np.float32)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.asarray(x, np.float64) ** 2)))


def pcm_wav(x, sr=SR, width=2, channels=1):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(sr)
        samples = np.repeat(x, channels)
        if width == 2:
            frames = np.round(samples * 32767).astype("<i2").tobytes()
        else:
            ints = np.round(samples * 8388607).astype(np.int64)
            frames = b"".join(int(v).to_bytes(3, "little", signed=True) for v in ints)
        w.writeframes(frames)
    return buf.getvalue()


def test_pcm16_roundtrip_keeps_samples():
    x = tone(0.1)
    y, sr = A.decode_wav(A.encode_wav(x, SR))
    assert sr == SR and len(y) == len(x)
    assert np.max(np.abs(y - x)) <= 1 / 32768 + 1e-6


def test_24bit_stereo_decodes_to_mono():
    x = tone(0.01, db=-6.0)
    y, sr = A.decode_wav(pcm_wav(x, width=3, channels=2))
    assert sr == SR and np.max(np.abs(y - x)) < 1e-4


def test_not_a_wav_is_unsupported():
    with pytest.raises(A.UnsupportedAudio):
        A.decode_wav(b"ID3\x03\x00 mp3 bytes")
    with pytest.raises(A.UnsupportedAudio):
        A.decode_wav(b"")


def test_float_wav_is_unsupported():
    """IEEE float (формат 3) stdlib wave не читает — это отказ 415, а не ffmpeg."""
    data = bytearray(pcm_wav(tone(0.01)))
    data[20:22] = (3).to_bytes(2, "little")      # wFormatTag: PCM → IEEE float
    with pytest.raises(A.UnsupportedAudio):
        A.decode_wav(bytes(data))


@pytest.mark.parametrize("width,channels,cut", [(2, 1, 1), (2, 2, 2), (3, 2, 1), (3, 2, 3)],
                         ids=["16bit-mono-1", "16bit-stereo-2", "24bit-stereo-1", "24bit-stereo-3"])
def test_truncated_wav_drops_the_partial_frame(width, channels, cut):
    """Оборванная копия кончается посреди отсчёта: wave отдаёт хвост как есть, и
    numpy падал ValueError — клиент получал 500 вместо звука без последнего кадра."""
    x = tone(0.01)
    y, sr = A.decode_wav(pcm_wav(x, width=width, channels=channels)[:-cut])
    assert sr == SR and len(y) == len(x) - 1


def test_zero_sample_rate_is_unsupported():
    """Частота 0 проходит stdlib wave и роняла бы деление в длине эталона."""
    data = bytearray(pcm_wav(tone(0.01)))
    data[24:28] = (0).to_bytes(4, "little")      # nSamplesPerSec
    with pytest.raises(A.UnsupportedAudio):
        A.decode_wav(bytes(data))


def test_implausible_sample_rate_is_unsupported():
    """Частота из заголовка задаёт размер буферов эталона: 4 ГГц в запросе на 50 байт
    — это ~1.6 ГиБ нулей внутри контейнера на 3 ГиБ, который обслуживает и эфир."""
    data = bytearray(pcm_wav(tone(0.01)))
    data[24:28] = (4_000_000_000).to_bytes(4, "little")
    with pytest.raises(A.UnsupportedAudio):
        A.decode_wav(bytes(data))


def test_trim_edges_removes_silence_on_both_sides():
    x = np.concatenate([silence(0.5), tone(1.0), silence(0.5)])
    assert abs(len(A.trim_edges(x, SR)) / SR - 1.0) < 0.02


def test_reference_cuts_at_last_pause_before_12s():
    """18 с: тон 8 с, пауза 0.3 с, тон 9.7 с — резать по паузе, а не по 12 с."""
    x = np.concatenate([tone(8.0), silence(0.3), tone(9.7)])
    assert abs(len(A.reference(x, SR)) / SR - 8.05) < 0.03


def test_reference_without_pause_is_hard_capped():
    assert abs(len(A.reference(tone(18.0), SR)) / SR - 12.05) < 0.02


def test_trim_tail_keeps_50ms():
    x = np.concatenate([tone(1.0), silence(1.0)])
    assert abs(len(A.trim_tail(x, SR)) / SR - 1.05) < 0.02


def test_broadcast_level_reaches_minus_17():
    assert abs(rms_db(A.normalize_broadcast(tone(2.0, db=-30.0))) + 17.0) < 0.1


def test_broadcast_peak_stays_under_ceiling():
    """Пик-фактор 18 dB, как у пробной фразы F5: по одному RMS пик ушёл бы за шкалу."""
    x = tone(2.0, db=-40.0)
    x[1000] = 10 ** (-22 / 20)
    y = A.normalize_broadcast(x)
    assert np.max(np.abs(y)) <= A.PEAK_CEILING + 1e-6
    assert rms_db(y) < -17.0


def test_silence_stays_silent():
    assert not np.any(A.normalize_broadcast(silence(0.5)))


def test_trim_edges_can_keep_a_margin():
    x = np.concatenate([silence(0.5), tone(1.0), silence(0.5)])
    assert abs(len(A.trim_edges(x, SR, keep_ms=30)) / SR - 1.06) < 0.02


def test_join_puts_the_asked_pause_after_each_piece():
    a, b = tone(0.5), tone(0.5)
    y = A.join_with_pauses([a, b], [450, 0], SR, lead_ms=100)
    assert len(y) == int(0.1 * SR) + len(a) + int(0.45 * SR) + len(b)
    gap = y[int(0.1 * SR) + len(a): int(0.1 * SR) + len(a) + int(0.45 * SR)]
    assert not np.any(gap)
