# F5-TTS: служба и слот у пульта (план 1 из 4) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Написать, протестировать, собрать и развернуть F5-службу TTS на gpu-host и объявить её у пульта gpu-ctl слотом `tts` в варианте `on-demand` — так, чтобы к окну приёмки служба была готова, а эфир за весь план ни разу не прервался.

**Architecture:** Служба — FastAPI поверх чистых модулей `station/tts-f5/f5_*.py`: звук (numpy + stdlib `wave`), текст, очередь с приоритетом, голоса, ударения (RUAccent), движок F5 (единственный модуль с torch). `/clone` идёт в F5 мимо `F5TTS.infer` — эталон владельца digital_me не касается диска. Образ `f5-tts:local` на базе `vllm/vllm-openai:v0.27.1` (torch 2.13+cu130, `sm_120`), данные в `<gpu-ssd>\LLM\docker\f5-tts\`, compose — у пульта.

**Tech Stack:** Python 3.12 (контейнер) / 3.14 (тесты music), FastAPI + uvicorn, numpy, f5-tts 1.1.22, ruaccent 1.5.8.3, Docker Desktop на gpu-host, PowerShell, pytest, Pester.

**Spec:** [docs/superpowers/specs/2026-09-23-tts-f5-migration-design.md](../specs/2026-09-23-tts-f5-migration-design.md) — план реализует его этапы 0 и 1.

**Что дальше (отдельные планы):** 2 — окно приёмки, переключение и сутки наблюдения (этапы 2–4, время согласуется с владельцем); 3 — digital_me (этап 6, в том числе правило брандмауэра на :4126 для `tts.py --local` с work); 4 — уборка Chatterbox, `prep_voice.py`, остальные голоса (этапы 5а, 5б, 7).

## Global Constraints

- **Эфир в этом плане не трогается.** Никаких `/ensure-up?slot=tts`, никаких правок контейнеров `chatterbox-*`, мостика `:4124`, настроек станции. Слот `tts` объявляется, но **не поднимается**.
- **Любой разовый контейнер на gpu-host — только с `--memory`**; без `--gpus` (GPU-потребитель мимо пульта запрещён правилом `llm_routers/gpu-ctl/CLAUDE.md`). Инцидент 22.09: контейнер без лимита выбил оперативку ВМ Docker (10.4 ГБ) и ядро убило Chatterbox.
- Чекпойнт: ESpeech-TTS-1 RL-V2, `espeech_tts_rlv2_fp16.safetensors` (643 МБ, только EMA, fp16) + `vocab.txt`; конфиг **`F5TTS_v1_Base`** (с `F5TTS_Base` веса грузятся, но модель шипит вместо речи — эфир 23.09); вокодер Vocos локально. Исходник на gpu-host: `D:\Temp\f5-probe\ckpt\`.
- Выход: WAV PCM 16 бит, моно, **24000 Гц**.
- Громкость: ручки эфира (`/v1/audio/speech`, `/speak`) — RMS **−17 dBFS** с потолком пика **32000/32768**; `/clone` — родная громкость модели, без нормализации.
- Эталон ≤ **12 с**; `ref_text` обязателен.
- Ударения — `+` перед гласной, **никогда не `U+0301`**; текст с уже стоящими `+` не размечается.
- Голос по умолчанию `ru-host` для пустого, OpenAI-имени (`alloy`, …) и неизвестного имени. Заголовки: `X-TTS-Voice-Used` всегда; `X-TTS-Fell-Back: 1` и `X-TTS-Fell-Back-Reason` — только для непустого неизвестного имени.
- Приоритет: эфир (`BROADCAST=0`) выше `/clone` (`CLONE=1`); ожидание очереди 60 с, дальше 503.
- Эталон `/clone` не пишется на диск: без `F5TTS.infer`, `infer_process`, `preprocess_ref_audio_text`; `MultiPartParser.spool_max_size` Starlette поднят до 10 МБ.
- Размещение: `<gpu-ssd>\LLM\docker\f5-tts\{app,models\espeech,models\vocos,ruaccent,voices,voices-src}`; compose — `llm_routers/gpu-ctl/deploy/compose/tts.yaml`.
- Слот `tts`: `on-demand`, `priority 20`, `vram_gb 3.0` и `cold_start_sec 90` (временные, до замера), `excludes ["chatterbox"]`, `idle_timeout_sec 900`, `port 4126`, `mem_limit "3g"`, compose `restart: "no"`.
- База образа `vllm/vllm-openai:v0.27.1`; её `ENTRYPOINT ["vllm","serve"]` перебивается.
- В репозитории music есть **чужие незакоммиченные правки** (`bridge.py`, `CLAUDE.md`, `FINDINGS.md`, `station/tts-bridge/README.md` и др.). Коммитить только свои пути: `git add <пути>`, никогда `-A`. Многострочные сообщения коммита — через файл и `git commit -F`; последняя строка: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Тесты music: каждый < 1 с, у быстрого набора бюджет 60 с и запаса нет. Запуск: `PY="/c/Program Files/Python314/python"`, `M=c:/AI/projects/music`, `"$PY" -m pytest -q <файл>` из `$M`. В этом Python есть numpy, httpx, starlette; **нет** fastapi, soundfile, torch — модули службы грузятся тестами через `sys.path`, а fastapi/torch/f5_tts подменяются заглушками.
- SSH на gpu-host: `SSH="ssh -p <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR -o ServerAliveInterval=30 <gpu-user>@<gpu-host>"`, вызов `$SSH "<PowerShell>"`; удалённый шелл — PowerShell; `.ps1` писать только ASCII (PS 5.1 без BOM читает UTF-8 как ANSI). Порты gpu-host из LAN закрыты брандмауэром — проверки ходят на `127.0.0.1` изнутри SSH.

---

## File Structure

| Файл | Ответственность |
|---|---|
| `station/tts-f5/f5_audio.py` | WAV ↔ numpy (stdlib `wave`), обрезка тишины, эталон ≤12 с, громкость эфира, склейка кусков |
| `station/tts-f5/f5_text.py` | знаки ударения, транскрипт эталона, предел куска, нарезка |
| `station/tts-f5/f5_worker.py` | один поток на GPU, очередь с приоритетом, таймаут очереди |
| `station/tts-f5/f5_accent.py` | RUAccent: расстановка `+`, пропуск размеченного текста |
| `station/tts-f5/f5_voices.py` | голоса из `voices/`, голос по умолчанию и подмена |
| `station/tts-f5/f5_engine.py` | единственный модуль с torch/f5-tts: загрузка и синтез куска; `DryEngine` для проверки обвязки |
| `station/tts-f5/f5_service.py` | запрос целиком: голос → ударения → нарезка → очередь → склейка → громкость → WAV |
| `station/tts-f5/server.py` | HTTP-обёртка: `/health`, `/v1/audio/speech`, `/speak`, `/clone` |
| `station/tts-f5/tools/make_voice.py` | эталон голоса ≤12 с + транскрипт из длинной записи |
| `station/tts-f5/tools/smoke.py` | дымовая проверка живой службы (stdlib, хостовый Python gpu-host) |
| `station/tts-f5/requirements.txt`, `Dockerfile`, `build.ps1`, `README.md` | сборка и описание |
| `station/tts-f5/voices/ru-host.{wav,txt}` | эталон голоса по умолчанию — источник правды для `J:\…\voices` |
| `tests/test_tts_f5_*.py` | по файлу тестов на модуль |
| `llm_routers/gpu-ctl/slots.json`, `deploy/compose/tts.yaml`, `CURRENT-STATE.md`, `README.md`, `CLAUDE.md` | слот `tts` |

---

### Task 1: Звук — `f5_audio.py`

**Files:**
- Create: `station/tts-f5/f5_audio.py`
- Test: `tests/test_tts_f5_audio.py`

**Interfaces:**
- Produces: `SR = 24000`, `REF_MAX_SECONDS = 12.0`, `PEAK_CEILING = 32000/32768`, `class UnsupportedAudio(ValueError)`, `decode_wav(data: bytes) -> tuple[np.ndarray, int]`, `encode_wav(x: np.ndarray, sr: int = SR) -> bytes`, `trim_edges(x, sr, thresh_db=-42.0, win_ms=10) -> np.ndarray`, `trim_tail(x, sr, thresh_db=-42.0, win_ms=10, keep_ms=50) -> np.ndarray`, `cap_seconds(x, sr, seconds=12.0, min_seconds=6.0, gap_db=-40.0, gap_ms=100, win_ms=10) -> np.ndarray`, `reference(x, sr) -> np.ndarray`, `normalize_broadcast(x, target_dbfs=-17.0, peak_ceiling=PEAK_CEILING) -> np.ndarray`, `join_crossfade(waves, sr=SR, fade_s=0.15) -> np.ndarray`. Все массивы — моно float32 в [-1, 1].

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_audio.py`:

```python
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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
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


def test_crossfade_joins_without_a_seam():
    a, b = np.ones(SR, np.float32), np.ones(SR, np.float32)
    y = A.join_crossfade([a, b], SR, 0.15)
    assert len(y) == 2 * SR - int(0.15 * SR)
    assert np.allclose(y, 1.0)
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_audio.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'f5_audio'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_audio.py`:

```python
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


def trim_edges(x, sr, thresh_db=-42.0, win_ms=10):
    """Срезать тишину по краям — порог как у remove_silence_edges в F5 (−42 dBFS)."""
    db, n = _frame_db(x, sr, win_ms)
    loud = np.nonzero(db > thresh_db)[0]
    if loud.size == 0:
        return x[:0]
    return x[loud[0] * n : (loud[-1] + 1) * n]


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


def join_crossfade(waves, sr=SR, fade_s=0.15):
    """Склейка кусков линейным кроссфейдом — как infer_batch_process
    (utils_infer.py:562-598): куски синтезируются отдельными заданиями очереди,
    и шов между ними не должен щёлкать."""
    waves = [np.asarray(w, np.float32) for w in waves if w is not None and len(w)]
    if not waves:
        return np.zeros(0, np.float32)
    out = waves[0]
    for nxt in waves[1:]:
        k = min(int(fade_s * sr), len(out), len(nxt))
        if k <= 0:
            out = np.concatenate([out, nxt])
            continue
        fade = np.linspace(1.0, 0.0, k, dtype=np.float32)
        out = np.concatenate([out[:-k], out[-k:] * fade + nxt[:k] * (1.0 - fade), nxt[k:]])
    return out
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_audio.py --durations=3`
Expected: 12 passed; ни один тест не дольше 1 с.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_audio.py tests/test_tts_f5_audio.py
git -C $M commit -m "F5-служба: звук без soundfile и без записи на диск"
```

---

### Task 2: Текст — `f5_text.py`

**Files:**
- Create: `station/tts-f5/f5_text.py`
- Test: `tests/test_tts_f5_text.py`

**Interfaces:**
- Produces: `VOWELS: str`, `MIN_MAX_CHARS = 20`, `has_stress_marks(text: str) -> bool`, `normalize_ref_text(ref_text: str) -> str` (кончается на `". "`), `max_chars(ref_text: str, ref_seconds: float, speed: float = 1.0) -> int` (≥ 20; `ValueError` вне (0, 22)), `chunk(text: str, limit: int) -> list[str]` (каждый кусок ≤ `limit` байт UTF-8).

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_text.py`:

```python
"""f5_text: ударения, транскрипт эталона и нарезка по пределу F5.

Нарезка повторяет chunk_text из f5-tts 1.1.22 — ожидаемые ответы UPSTREAM сняты
с настоящей функции 2026-09-23 на тех же входах. Отличие одно и проверено отдельно:
отрезок длиннее предела дорезается по словам — штатная функция отдаёт его целиком,
и F5 на таком куске комкает окончание.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
import f5_text as T  # noqa: E402

PODVODKA = ("Добрый вечер. Это AI радио, и рядом со мной та самая коллекция, "
            "которую собирали годами. Только что отзвучали Dire Straits — "
            "«Brothers in Arms». Дальше поставлю Кино, «Звезда по имени Солнце», "
            "восемьдесят девятый год. А потом будет потише, обещаю.")

UPSTREAM = [
    (PODVODKA, 180, [
        "Добрый вечер. Это AI радио, и рядом со мной та самая коллекция, "
        "которую собирали годами.",
        "Только что отзвучали Dire Straits — «Brothers in Arms». Дальше поставлю "
        "Кино, «Звезда по имени Солнце»,",
        "восемьдесят девятый год. А потом будет потише, обещаю.",
    ]),
    ("Раз. Два. Три. Четыре!", 100, ["Раз. Два. Три. Четыре!"]),
]


@pytest.mark.parametrize("text,limit,expected", UPSTREAM, ids=["podvodka", "short"])
def test_chunks_match_upstream_chunk_text(text, limit, expected):
    assert T.chunk(text, limit) == expected


def test_overlong_sentence_is_split_by_words_keeping_marks():
    """Штатный chunk_text на этом входе отдал третьим куском все 66 байт при пределе
    60 (замер 2026-09-23). Здесь отрезок дорезается по словам, знаки '+' целы."""
    text = "Д+обрый в+ечер. +Это дом+ашнее р+адио, и р+ядом со мн+ой та с+амая колл+екция."
    assert T.chunk(text, 60) == [
        "Д+обрый в+ечер.",
        "+Это дом+ашнее р+адио,",
        "и р+ядом со мн+ой та с+амая",
        "колл+екция.",
    ]


def test_run_without_punctuation_is_split_by_words():
    text = " ".join(["слово"] * 40)
    chunks = T.chunk(text, 60)
    assert len(chunks) > 1
    assert all(len(c.encode("utf-8")) <= 60 for c in chunks)
    assert " ".join(chunks).split() == text.split()


def test_word_pieces_are_not_glued():
    """Штатный chunk_text не ставит пробел за кириллической буквой: у него так
    кончается только последний кусок. Дорезанные по словам куски кончаются буквой
    всегда, и при склейке без пробела вышло бы «словотри» (54 + 6 = ровно 60)."""
    assert T.chunk("слово слово слово слово слово три", 60) == [
        "слово слово слово слово слово", "три"]


def test_stress_marks_are_plus_before_a_vowel():
    assert T.has_stress_marks("м+олоко") and T.has_stress_marks("+Это")
    assert not T.has_stress_marks("C++ и A+B")
    assert not T.has_stress_marks("молоко")


def test_ref_text_ends_with_period_and_space():
    assert T.normalize_ref_text("  текст ") == "текст. "
    assert T.normalize_ref_text("текст.") == "текст. "


def test_max_chars_formula_and_bounds():
    ref = "а" * 75                                 # 150 байт UTF-8
    assert T.max_chars(ref, 10.0) == int(150 / 10 * 12)
    assert T.max_chars("а", 11.9) == T.MIN_MAX_CHARS
    with pytest.raises(ValueError):
        T.max_chars(ref, 22.0)
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_text.py`
Expected: FAIL — `No module named 'f5_text'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_text.py`:

```python
"""Текст для F5: знаки ударения, транскрипт эталона, нарезка на куски.

Нарезка повторяет алгоритм chunk_text из f5-tts 1.1.22
(f5_tts/infer/utils_infer.py:73-102) — перенесён сюда, чтобы модуль грузился в
тестах music без torch; совпадение сверяет tests/test_tts_f5_text.py. Отличие
одно: отрезок между знаками препинания длиннее предела дорезается по словам —
штатный chunk_text такой кусок не делит, а F5 на куске длиннее предела комкает
окончание.
"""
import re

VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
MIN_MAX_CHARS = 20
_STRESS = re.compile(f"\\+[{VOWELS}]")
_CJK_PUNCT = "；：，。！？"
_SENTENCE = re.compile(r"(?<=[;:,.!?])\s+|(?<=[；：，。！？])")


def has_stress_marks(text: str) -> bool:
    """Есть ли ударения в нотации RUAccent: '+' прямо перед гласной."""
    return bool(_STRESS.search(text))


def normalize_ref_text(ref_text: str) -> str:
    """Транскрипт эталона кончается на '. ' — как в preprocess_ref_audio_text
    (utils_infer.py:369-374): F5 склеивает его с текстом синтеза в одну строку."""
    ref = ref_text.strip()
    if ref.endswith("。"):
        return ref
    return ref + " " if ref.endswith(".") else ref + ". "


def max_chars(ref_text: str, ref_seconds: float, speed: float = 1.0) -> int:
    """Предел куска в байтах UTF-8 — формула infer_process (utils_infer.py:404).
    F5 генерирует эталон и текст одним окном около 22 с: чем длиннее эталон,
    тем меньше места под новый текст."""
    if not 0 < ref_seconds < 22:
        raise ValueError(f"длина эталона {ref_seconds:.1f} с вне (0, 22)")
    n = int(len(ref_text.encode("utf-8")) / ref_seconds * (22 - ref_seconds) * speed)
    return max(MIN_MAX_CHARS, n)


def _bytes(s: str) -> int:
    return len(s.encode("utf-8"))


def _split_words(piece: str, limit: int) -> list[str]:
    """Отрезок длиннее предела — по словам; слово длиннее предела (URL, мусор) — по буквам."""
    out, cur = [], ""
    for word in piece.split():
        while _bytes(word) > limit:
            head = ""
            for ch in word:
                if head and _bytes(head + ch) > limit:
                    break
                head += ch
            if cur:
                out.append(cur)
                cur = ""
            out.append(head)
            word = word[len(head):]
        if not word:
            continue
        joined = f"{cur} {word}" if cur else word
        if _bytes(joined) <= limit:
            cur = joined
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def chunk(text: str, limit: int) -> list[str]:
    pieces = []
    for s in _SENTENCE.split(text.strip()):
        if not s:
            continue
        pieces.extend([s] if _bytes(s) <= limit else _split_words(s, limit))
    chunks, cur = [], ""
    for s in pieces:
        # Штатный chunk_text ставит пробел, только если последний символ однобайтный.
        # Его куски, кроме последнего, кончаются знаком препинания, так что правило
        # «пробел везде, кроме китайской пунктуации» даёт на них тот же ответ, — а
        # дорезанные по словам куски кончаются буквой, и без пробела слова слиплись бы.
        tail = s if s[-1] in _CJK_PUNCT else s + " "
        if _bytes(cur) + _bytes(s) <= limit:
            cur += tail
        else:
            if cur:
                chunks.append(cur.strip())
            cur = tail
    if cur:
        chunks.append(cur.strip())
    return chunks
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_text.py`
Expected: 8 passed.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_text.py tests/test_tts_f5_text.py
git -C $M commit -m "F5-служба: ударения, транскрипт эталона и нарезка по пределу F5"
```

---

### Task 3: Очередь — `f5_worker.py`

**Files:**
- Create: `station/tts-f5/f5_worker.py`
- Test: `tests/test_tts_f5_worker.py`

**Interfaces:**
- Produces: `BROADCAST = 0`, `CLONE = 1`, `class QueueTimeout(Exception)`, `class Worker` с методами `run_all(fns: list[Callable[[], T]], priority: int, wait_s: float) -> list[T]`, `pending() -> int` и атрибутом `jobs_done: int`.

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_worker.py`:

```python
"""f5_worker: одна генерация на карте за раз, эфир — вперёд digital_me.

У Chatterbox два синтеза разом валили оба (инцидент 2026-09-22); у F5 то же не
проверено, поэтому воркер один. А приоритет нужен, чтобы абзац /clone на две
минуты речи не держал реплику эфира дольше одного куска.
"""
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
import f5_worker as W  # noqa: E402


def wait_until(cond, timeout=1.0):
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "условие не наступило"
        time.sleep(0.001)


@pytest.fixture
def worker():
    return W.Worker()


def blocking_job():
    started, gate = threading.Event(), threading.Event()

    def job():
        started.set()
        gate.wait(2)
    return job, started, gate


def test_results_come_back_in_order(worker):
    assert worker.run_all([lambda: 1, lambda: 2, lambda: 3], W.BROADCAST, 1.0) == [1, 2, 3]


def test_broadcast_overtakes_queued_clone(worker):
    job, started, gate = blocking_job()
    order = []
    t0 = threading.Thread(target=worker.run_all, args=([job], W.CLONE, 1.0))
    t0.start()
    assert started.wait(1)
    t1 = threading.Thread(target=worker.run_all,
                          args=([lambda: order.append("clone")], W.CLONE, 1.0))
    t1.start()
    wait_until(lambda: worker.pending() == 1)
    t2 = threading.Thread(target=worker.run_all,
                          args=([lambda: order.append("broadcast")], W.BROADCAST, 1.0))
    t2.start()
    wait_until(lambda: worker.pending() == 2)
    gate.set()
    for t in (t0, t1, t2):
        t.join(2)
    assert order == ["broadcast", "clone"]


def test_one_generation_at_a_time(worker):
    active, peak, lock = [0], [0], threading.Lock()

    def job():
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.01)
        with lock:
            active[0] -= 1

    threads = [threading.Thread(target=worker.run_all, args=([job, job], W.BROADCAST, 2.0))
               for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(3)
    assert peak[0] == 1


def test_queue_timeout_withdraws_the_request(worker):
    job, started, gate = blocking_job()
    ran = []
    t = threading.Thread(target=worker.run_all, args=([job], W.BROADCAST, 1.0))
    t.start()
    assert started.wait(1)
    with pytest.raises(W.QueueTimeout):
        worker.run_all([lambda: ran.append(1)], W.CLONE, 0.05)
    gate.set()
    t.join(2)
    worker.run_all([lambda: None], W.BROADCAST, 1.0)     # воркер жив, очередь чиста
    assert ran == []


def test_error_reaches_the_caller_and_worker_survives(worker):
    def boom():
        raise RuntimeError("CUDA OOM")
    with pytest.raises(RuntimeError, match="CUDA OOM"):
        worker.run_all([boom], W.BROADCAST, 1.0)
    assert worker.run_all([lambda: "ok"], W.BROADCAST, 1.0) == ["ok"]
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_worker.py`
Expected: FAIL — `No module named 'f5_worker'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_worker.py`:

```python
"""Одна генерация на карте за раз, эфир — вперёд digital_me.

Один поток-воркер и очередь с приоритетом. Каждый кусок текста — отдельное
задание: длинный абзац /clone не держит реплику эфира дольше одного куска.
"""
import heapq
import itertools
import threading

BROADCAST, CLONE = 0, 1


class QueueTimeout(Exception):
    """Первое задание запроса не начало исполняться за отведённое время."""


class _Job:
    __slots__ = ("fn", "started", "cancelled", "done", "result", "error")

    def __init__(self, fn):
        self.fn = fn
        self.started = False
        self.cancelled = False
        self.done = threading.Event()
        self.result = None
        self.error = None


class Worker:
    def __init__(self):
        self._heap = []
        self._seq = itertools.count()
        self._cv = threading.Condition()
        self.jobs_done = 0
        threading.Thread(target=self._loop, name="f5-worker", daemon=True).start()

    def pending(self) -> int:
        with self._cv:
            return sum(1 for _, _, job in self._heap if not job.cancelled)

    def _loop(self):
        while True:
            with self._cv:
                while not self._heap:
                    self._cv.wait()
                _, _, job = heapq.heappop(self._heap)
                if job.cancelled:
                    continue
                job.started = True
                self._cv.notify_all()
            try:
                job.result = job.fn()
            except BaseException as e:           # noqa: BLE001 — ошибка уходит тому, кто ждёт
                job.error = e
            finally:
                job.done.set()
                with self._cv:
                    self.jobs_done += 1

    def run_all(self, fns, priority, wait_s):
        """Поставить все куски запроса разом и дождаться всех по порядку.

        Если первый кусок не начал исполняться за wait_s — снимаются все, и
        QueueTimeout. Ошибка куска снимает ещё не начатые и поднимается наружу."""
        jobs = [_Job(fn) for fn in fns]
        with self._cv:
            for job in jobs:
                heapq.heappush(self._heap, (priority, next(self._seq), job))
            self._cv.notify_all()
            if jobs and not self._cv.wait_for(lambda: jobs[0].started, timeout=wait_s):
                for job in jobs:
                    job.cancelled = True
                raise QueueTimeout(f"очередь не разошлась за {wait_s:.0f} с")
        results = []
        for job in jobs:
            job.done.wait()
            if job.error is not None:
                with self._cv:
                    for rest in jobs:
                        if not rest.started:
                            rest.cancelled = True
                raise job.error
            results.append(job.result)
        return results
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_worker.py --durations=5`
Expected: 5 passed; каждый < 1 с.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_worker.py tests/test_tts_f5_worker.py
git -C $M commit -m "F5-служба: одна генерация за раз, эфир вперёд digital_me"
```

---

### Task 4: Ударения и голоса — `f5_accent.py`, `f5_voices.py`

**Files:**
- Create: `station/tts-f5/f5_accent.py`, `station/tts-f5/f5_voices.py`
- Test: `tests/test_tts_f5_voices.py`

**Interfaces:**
- Consumes: `f5_text.has_stress_marks`, `f5_text.max_chars`, `f5_text.normalize_ref_text`, `f5_audio.decode_wav`, `f5_audio.reference`.
- Produces: `class Accentizer(workdir: Path)` с `load() -> None`, `apply(text: str) -> str`; `OPENAI_VOICES: frozenset[str]`; `@dataclass(frozen=True) class Voice(name: str, samples: np.ndarray, sr: int, ref_text: str, max_chars: int)`; `voice_from_audio(name, samples, sr, ref_text) -> Voice` (`ValueError`, если эталон короче секунды); `load_voices(directory) -> dict[str, Voice]` (`ValueError` без транскрипта и в пустом каталоге); `resolve(voices, requested, default) -> tuple[Voice, bool, str | None]`.

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_voices.py`:

```python
"""f5_accent и f5_voices: ударения RUAccent и голоса станции.

Голос по умолчанию отвечает на пустое, OpenAI-имя и опечатку: отказ 4xx на
опечатке означал бы молчание эфира — мостик 4xx не повторяет, отката нет.
"""
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
import f5_accent  # noqa: E402
import f5_audio as A  # noqa: E402
import f5_voices as V  # noqa: E402


def tone(seconds, db=-20.0, sr=24000):
    t = np.arange(int(sr * seconds)) / sr
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


class FakeRUAccent:
    loads = []

    def load(self, **kw):
        FakeRUAccent.loads.append(kw)

    def process_all(self, text):
        return text.replace("молоко", "молок+о")


@pytest.fixture
def ruaccent(monkeypatch):
    FakeRUAccent.loads = []
    mod = types.ModuleType("ruaccent")
    mod.RUAccent = FakeRUAccent
    monkeypatch.setitem(sys.modules, "ruaccent", mod)
    return FakeRUAccent


def write_voice(d, name, x, text="Эталонная фраза"):
    (d / f"{name}.wav").write_bytes(A.encode_wav(x, 24000))
    if text is not None:
        (d / f"{name}.txt").write_text(text, encoding="utf-8")


def test_accentizer_marks_plain_text(ruaccent, tmp_path):
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("Купи молоко") == "Купи молок+о"
    kw = ruaccent.loads[0]
    assert kw["omograph_model_size"] == "tiny2.1" and kw["device"] == "CPU"
    assert kw["workdir"] == str(tmp_path)


def test_accentizer_keeps_author_marks(ruaccent, tmp_path):
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("з+амок и молоко") == "з+амок и молоко"
    assert ruaccent.loads == []                   # размеченный текст модель не будит


def test_voice_is_capped_and_has_transcript(tmp_path):
    write_voice(tmp_path, "ru-host", tone(18.0))
    v = V.load_voices(tmp_path)["ru-host"]
    assert len(v.samples) / v.sr <= 12.06
    assert v.ref_text == "Эталонная фраза. "
    assert v.max_chars >= 20


def test_voice_without_transcript_refuses(tmp_path):
    write_voice(tmp_path, "ru-host", tone(3.0), text=None)
    with pytest.raises(ValueError, match="транскрипт"):
        V.load_voices(tmp_path)


def test_empty_voice_dir_refuses(tmp_path):
    with pytest.raises(ValueError):
        V.load_voices(tmp_path)


def test_silent_reference_refuses():
    with pytest.raises(ValueError, match="секунд"):
        V.voice_from_audio("clone", np.zeros(48000, np.float32), 24000, "текст")


def test_resolve_default_and_fallback(tmp_path):
    write_voice(tmp_path, "ru-host", tone(3.0))
    write_voice(tmp_path, "ru-voice-4", tone(3.0))
    voices = V.load_voices(tmp_path)
    assert V.resolve(voices, "", "ru-host")[1:] == (False, None)
    assert V.resolve(voices, None, "ru-host")[0].name == "ru-host"
    assert V.resolve(voices, "Alloy", "ru-host")[1:] == (False, None)
    assert V.resolve(voices, "ru-voice-4", "ru-host")[0].name == "ru-voice-4"
    voice, fell_back, reason = V.resolve(voices, "ru-rajt", "ru-host")
    assert voice.name == "ru-host" and fell_back and "ru-rajt" in reason
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_voices.py`
Expected: FAIL — `No module named 'f5_accent'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_accent.py`:

```python
"""Ударения — RUAccent внутри службы, общий слой для всех клиентов.

Нотация — '+' перед ударной гласной, на ней обучен ESpeech. В U+0301 не
переводить (в отличие от плана radio-upgrades, писавшегося под Chatterbox).
Текст с уже стоящими '+' не трогается: ручная правка автора сохраняется.
"""
import threading
from pathlib import Path

from f5_text import has_stress_marks


class Accentizer:
    def __init__(self, workdir: Path):
        self.workdir = Path(workdir)
        self._model = None
        self._lock = threading.Lock()     # эфир и /clone зовут из разных потоков

    def load(self) -> None:
        """Грузить при старте службы: первая реплика эфира не должна ждать модель."""
        from ruaccent import RUAccent
        acc = RUAccent()
        acc.load(omograph_model_size="tiny2.1", use_dictionary=True, device="CPU",
                 workdir=str(self.workdir))
        self._model = acc

    def apply(self, text: str) -> str:
        if has_stress_marks(text):
            return text
        with self._lock:
            if self._model is None:
                self.load()
            return self._model.process_all(text)
```

`station/tts-f5/f5_voices.py`:

```python
"""Голоса службы: пары <имя>.wav + <имя>.txt в каталоге voices/.

Имя пары — то же, что стоит в persona.tts.voice станции. Эталоны грузятся в
память при старте тем же путём, что и эталон /clone (f5_audio.reference), и с
диска больше не читаются.
"""
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
    эфира (мостик 4xx не повторяет, отката на piper нет)."""
    name = (requested or "").strip()
    if not name or name.lower() in OPENAI_VOICES:
        return voices[default], False, None
    if name in voices:
        return voices[name], False, None
    return voices[default], True, f'unknown voice "{name}"'
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_voices.py --durations=3`
Expected: 7 passed; каждый < 1 с.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_accent.py station/tts-f5/f5_voices.py tests/test_tts_f5_voices.py
git -C $M commit -m "F5-служба: ударения RUAccent и голоса станции с голосом по умолчанию"
```

---

### Task 5: Движок — `f5_engine.py`

**Files:**
- Create: `station/tts-f5/f5_engine.py`
- Test: `tests/test_tts_f5_engine.py`

**Interfaces:**
- Produces: `class Engine(model, vocoder, mel_spec_type: str, device: str)` с `classmethod load(model_name, ckpt, vocab, vocos_dir, device="cuda") -> Engine`, свойством `dtype -> str`, методами `synth(samples: np.ndarray, sr: int, ref_text: str, text: str) -> np.ndarray` (float32, 24 кГц), `vram() -> dict`; `class DryEngine` с тем же интерфейсом (без torch; для проверки обвязки контейнера).

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_engine.py`:

```python
"""f5_engine: синтез идёт мимо штатного пути F5, который пишет эталон на диск.

preprocess_ref_audio_text открывает эталон по пути, экспортирует копию в
NamedTemporaryFile(delete=False), не удаляет её и держит путь в глобальном кэше.
Для эталона владельца digital_me это утечка биометрии на диск gpu-host. Заглушки
ниже роняют тест при любом вызове этого пути.
"""
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
import f5_engine  # noqa: E402


class FakeTensor:
    def __init__(self, arr):
        self.arr = arr
        self.shape = arr.shape

    def unsqueeze(self, dim):
        return FakeTensor(np.expand_dims(self.arr, dim))


def forbidden(*args, **kwargs):
    raise AssertionError("путь через временный файл на диске")


@pytest.fixture
def f5(monkeypatch):
    calls = {"batch": [], "empty_cache": 0}
    torch = types.ModuleType("torch")
    torch.from_numpy = FakeTensor

    def empty_cache():
        calls["empty_cache"] += 1
    torch.cuda = types.SimpleNamespace(empty_cache=empty_cache, is_available=lambda: True)

    utils = types.ModuleType("f5_tts.infer.utils_infer")

    def infer_batch_process(ref_audio, ref_text, batches, model, vocoder, **kw):
        calls["batch"].append((ref_audio, ref_text, batches, kw))
        yield np.full(2400, 0.1, np.float64), 24000, None
    utils.infer_batch_process = infer_batch_process
    utils.preprocess_ref_audio_text = forbidden
    utils.infer_process = forbidden
    api = types.ModuleType("f5_tts.api")
    api.F5TTS = types.SimpleNamespace(infer=forbidden)
    for name, mod in [("torch", torch), ("f5_tts", types.ModuleType("f5_tts")),
                      ("f5_tts.infer", types.ModuleType("f5_tts.infer")),
                      ("f5_tts.infer.utils_infer", utils), ("f5_tts.api", api)]:
        monkeypatch.setitem(sys.modules, name, mod)
    return calls


def test_reference_goes_to_f5_as_tensor_not_path(f5):
    eng = f5_engine.Engine("model", "vocoder", "vocos", "cuda")
    wave = eng.synth(np.zeros(24000, np.float32), 24000, "эталон. ", "текст")
    (ref_audio, ref_text, batches, kw), = f5["batch"]
    assert isinstance(ref_audio, tuple) and isinstance(ref_audio[0], FakeTensor)
    assert ref_audio[0].shape == (1, 24000) and ref_audio[1] == 24000
    assert ref_text == "эталон. " and batches == ["текст"]
    assert kw["progress"] is None and kw["device"] == "cuda" and kw["mel_spec_type"] == "vocos"
    assert wave.dtype == np.float32 and len(wave) == 2400
    assert f5["empty_cache"] == 1


def test_empty_result_is_an_error(f5, monkeypatch):
    def nothing(*args, **kwargs):
        yield None, 24000, None
    monkeypatch.setattr(sys.modules["f5_tts.infer.utils_infer"], "infer_batch_process", nothing)
    with pytest.raises(RuntimeError):
        f5_engine.Engine("m", "v", "vocos", "cuda").synth(
            np.zeros(100, np.float32), 24000, "э. ", "т")


def test_dry_engine_needs_no_torch():
    dry = f5_engine.DryEngine()
    wave = dry.synth(np.zeros(100, np.float32), 24000, "э. ", "текст")
    assert wave.dtype == np.float32 and len(wave) > 0
    assert dry.dtype == "dry" and dry.vram() == {}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_engine.py`
Expected: FAIL — `No module named 'f5_engine'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_engine.py`:

```python
"""Единственный модуль службы, который трогает torch и f5-tts.

Модель грузится без f5_tts.api: там импортируется cached_path, а F5TTS.infer
идёт через preprocess_ref_audio_text — тот открывает эталон по пути, пишет
обработанную копию в NamedTemporaryFile(delete=False), не удаляет её и держит
путь в глобальном кэше. Для эталона владельца digital_me это утечка биометрии на
диск gpu-host. Поэтому синтез — напрямую infer_batch_process с кортежем
(тензор, частота), по одному куску за вызов: так же обходится и его
ThreadPoolExecutor без лимита, из-за которого пик VRAM не ограничен.
"""
import importlib
from importlib import resources

import numpy as np

from f5_audio import SR


class Engine:
    def __init__(self, model, vocoder, mel_spec_type: str, device: str):
        self.model = model
        self.vocoder = vocoder
        self.mel_spec_type = mel_spec_type
        self.device = device

    @classmethod
    def load(cls, model_name, ckpt, vocab, vocos_dir, device="cuda"):
        """Те же шаги, что F5TTS.__init__ (f5_tts/api.py:35-84), без cached_path и hydra."""
        import yaml
        from f5_tts.infer.utils_infer import load_model, load_vocoder
        text = resources.files("f5_tts").joinpath(f"configs/{model_name}.yaml").read_text(
            encoding="utf-8")
        cfg = yaml.safe_load(text)["model"]
        model_cls = getattr(importlib.import_module("f5_tts.model"), cfg["backbone"])
        mel = cfg["mel_spec"]["mel_spec_type"]
        vocoder = load_vocoder(mel, True, str(vocos_dir), device)
        # dtype не передаётся: load_checkpoint сам берёт fp16 на CUDA с архитектурой 7+
        model = load_model(model_cls, cfg["arch"], str(ckpt), mel, str(vocab), "euler", True, device)
        return cls(model, vocoder, mel, device)

    @property
    def dtype(self) -> str:
        return str(next(self.model.parameters()).dtype)

    def synth(self, samples, sr, ref_text, text) -> np.ndarray:
        import torch
        from f5_tts.infer.utils_infer import infer_batch_process
        audio = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32)).unsqueeze(0)
        try:
            wave, _, _ = next(infer_batch_process(
                (audio, sr), ref_text, [text], self.model, self.vocoder,
                mel_spec_type=self.mel_spec_type, progress=None, device=self.device))
        finally:
            if self.device.startswith("cuda"):
                # кэш аллокатора видит nvidia-smi, а по нему считает бюджет пульт gpu-ctl
                torch.cuda.empty_cache()
        if wave is None:
            raise RuntimeError("F5 не вернул звук")
        return np.asarray(wave, dtype=np.float32)

    def vram(self) -> dict:
        """Счётчики torch — диагностика роста памяти, а не источник vram_gb слота:
        CUDA-контекст (0.4–0.6 ГиБ) и память вне аллокатора в них не входят."""
        import torch
        if not (self.device.startswith("cuda") and torch.cuda.is_available()):
            return {}
        free, total = torch.cuda.mem_get_info()
        mb = 2 ** 20
        return {"vram_free_mb": free // mb, "vram_total_mb": total // mb,
                "vram_allocated_mb": torch.cuda.memory_allocated() // mb,
                "vram_peak_mb": torch.cuda.max_memory_allocated() // mb,
                "vram_reserved_mb": torch.cuda.memory_reserved() // mb}


class DryEngine:
    """Без модели: полсекунды тона на кусок. Проверяет обвязку контейнера —
    HTTP, голоса, RUAccent офлайн, путь /clone — в малой памяти и без карты."""
    device = "cpu"
    dtype = "dry"

    def synth(self, samples, sr, ref_text, text) -> np.ndarray:
        t = np.arange(SR // 2) / SR
        return (0.02 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    def vram(self) -> dict:
        return {}
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_engine.py`
Expected: 3 passed.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_engine.py tests/test_tts_f5_engine.py
git -C $M commit -m "F5-служба: синтез мимо штатного пути F5, который пишет эталон на диск"
```

---

### Task 6: Запрос целиком — `f5_service.py`

**Files:**
- Create: `station/tts-f5/f5_service.py`
- Test: `tests/test_tts_f5_service.py`

**Interfaces:**
- Consumes: всё из задач 1–5.
- Produces: `MAX_TEXT_CHARS = 20000`, `class ServiceError(Exception)` с полями `status: int`, `message: str`; `@dataclass class Result(wav: bytes, headers: dict)`; `class Service(engine, voices, default_voice, accentizer, worker, queue_wait=60.0, log=print, clock=time.monotonic)` с методами `speak(text, voice_name=None) -> Result`, `clone(text, ref_text, ref_audio: bytes) -> Result`, `health() -> dict` (ключи `ok`, `model_loaded`, `dtype`, `device`, `default_voice`, `voices`, `queue`, `jobs_done`, `uptime_s` + `engine.vram()`).

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_service.py`:

```python
"""f5_service: запрос целиком — голос, ударения, нарезка, очередь, громкость.

Ручки эфира выравнивают громкость (F5 на ~12 dB тише Chatterbox), /clone — нет:
громкость digital_me выставляет сам tts.py, и срезанный здесь пик он не вернул бы.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"))
import f5_audio as A  # noqa: E402
import f5_service as S  # noqa: E402
import f5_voices as V  # noqa: E402
import f5_worker as W  # noqa: E402


def tone(seconds, db=-20.0, sr=24000):
    t = np.arange(int(sr * seconds)) / sr
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


def rms_db(x):
    return 20 * np.log10(np.sqrt(np.mean(np.asarray(x, np.float64) ** 2)))


class FakeEngine:
    device, dtype = "cuda", "torch.float16"

    def __init__(self, db=-30.0, crest=False, fail=None):
        self.calls, self.db, self.crest, self.fail = [], db, crest, fail

    def synth(self, samples, sr, ref_text, text):
        if self.fail:
            raise self.fail
        self.calls.append((type(samples), sr, ref_text, text))
        x = tone(0.5, db=self.db)
        if self.crest:
            x[100] = 10 ** ((self.db + 18) / 20)
        return x

    def vram(self):
        return {"vram_peak_mb": 1}


class FakeAccent:
    def apply(self, text):
        return text.replace("замок", "з+амок")


class SpyWorker(W.Worker):
    def __init__(self):
        super().__init__()
        self.priorities = []

    def run_all(self, fns, priority, wait_s):
        self.priorities.append(priority)
        return super().run_all(fns, priority, wait_s)


class TimeoutWorker:
    jobs_done = 0

    def run_all(self, fns, priority, wait_s):
        raise W.QueueTimeout("очередь не разошлась за 1 с")

    def pending(self):
        return 0


@pytest.fixture
def voices(tmp_path):
    (tmp_path / "ru-host.wav").write_bytes(A.encode_wav(tone(3.0)))
    (tmp_path / "ru-host.txt").write_text("Эталон", encoding="utf-8")
    return V.load_voices(tmp_path)


def make(voices, engine=None, worker=None):
    return S.Service(engine or FakeEngine(), voices, "ru-host", FakeAccent(),
                     worker or W.Worker(), queue_wait=1.0, log=lambda *_: None)


def ref_wav(seconds=3.0):
    return A.encode_wav(tone(seconds))


def test_speak_returns_24k_wav_with_voice_header(voices):
    r = make(voices).speak("Добрый вечер.")
    x, sr = A.decode_wav(r.wav)
    assert sr == 24000 and len(x) > 0
    assert r.headers == {"X-TTS-Voice-Used": "ru-host"}


@pytest.mark.parametrize("name", ["", None, "alloy"])
def test_default_voice_is_not_a_fallback(voices, name):
    assert "X-TTS-Fell-Back" not in make(voices).speak("Привет.", name).headers


def test_unknown_voice_is_marked_as_fallback(voices):
    h = make(voices).speak("Привет.", "ru-rajt").headers
    assert h["X-TTS-Voice-Used"] == "ru-host" and h["X-TTS-Fell-Back"] == "1"
    assert "ru-rajt" in h["X-TTS-Fell-Back-Reason"]


def test_speak_is_brought_to_minus_17(voices):
    x, _ = A.decode_wav(make(voices, FakeEngine(db=-30.0)).speak("Привет.").wav)
    assert abs(rms_db(x) + 17.0) < 0.5


def test_speak_peak_stays_under_ceiling(voices):
    x, _ = A.decode_wav(make(voices, FakeEngine(db=-40.0, crest=True)).speak("Привет.").wav)
    assert np.max(np.abs(x)) <= A.PEAK_CEILING + 1 / 32768


def test_clone_keeps_model_loudness(voices):
    x, _ = A.decode_wav(make(voices, FakeEngine(db=-30.0)).clone("Привет.", "Эталон", ref_wav()).wav)
    assert abs(rms_db(x) + 30.0) < 0.5


def test_clone_hands_f5_an_array_and_normalized_ref_text(voices):
    eng = FakeEngine()
    make(voices, eng).clone("Привет.", "Эталон клона", ref_wav(18.0))
    samples_type, sr, ref_text, _ = eng.calls[0]
    assert samples_type is np.ndarray and sr == 24000
    assert ref_text == "Эталон клона. "


def test_clone_rejects_non_wav_with_415(voices):
    with pytest.raises(S.ServiceError) as e:
        make(voices).clone("Привет.", "Эталон", b"ID3 mp3")
    assert e.value.status == 415


# ids обязательны: без них имя теста несёт байты WAV, а pytest кладёт имя в
# PYTEST_CURRENT_TEST — Windows отвергает переменную длиннее 32767 символов.
@pytest.mark.parametrize("ref_text,audio", [("", ref_wav()), ("Эталон", b"")],
                         ids=["no-ref-text", "no-audio"])
def test_clone_requires_ref_text_and_audio(voices, ref_text, audio):
    with pytest.raises(S.ServiceError) as e:
        make(voices).clone("Привет.", ref_text, audio)
    assert e.value.status == 400


def test_clone_rejects_silent_reference(voices):
    with pytest.raises(S.ServiceError) as e:
        make(voices).clone("Привет.", "Эталон", A.encode_wav(np.zeros(48000, np.float32)))
    assert e.value.status == 400


def test_text_is_required_and_bounded(voices):
    svc = make(voices)
    with pytest.raises(S.ServiceError) as e:
        svc.speak("   ")
    assert e.value.status == 400
    with pytest.raises(S.ServiceError) as e:
        svc.speak("а" * (S.MAX_TEXT_CHARS + 1))
    assert e.value.status == 413


def test_accent_is_applied_before_synthesis(voices):
    eng = FakeEngine()
    make(voices, eng).speak("Старый замок.")
    assert eng.calls[0][3] == "Старый з+амок."


def test_long_text_is_split_within_voice_limit(voices):
    eng = FakeEngine()
    text = " ".join(f"Это предложение номер {i}." for i in range(20))
    make(voices, eng).speak(text)
    limit = voices["ru-host"].max_chars
    assert len(eng.calls) > 1
    assert all(len(call[3].encode("utf-8")) <= limit for call in eng.calls)


def test_clone_limit_follows_reference_length(voices):
    """F5 делит окно ~22 с между эталоном и текстом: длинный эталон — короче куски."""
    text = " ".join(f"Это предложение номер {i}." for i in range(10))
    short, long_ = FakeEngine(), FakeEngine()
    make(voices, short).clone(text, "Эталон", ref_wav(2.0))
    make(voices, long_).clone(text, "Эталон", ref_wav(10.0))
    assert len(long_.calls) > len(short.calls)


def test_queue_timeout_is_503(voices):
    with pytest.raises(S.ServiceError) as e:
        make(voices, worker=TimeoutWorker()).speak("Привет.")
    assert e.value.status == 503


def test_engine_failure_is_500_with_text(voices):
    with pytest.raises(S.ServiceError) as e:
        make(voices, FakeEngine(fail=RuntimeError("CUDA OOM"))).speak("Привет.")
    assert e.value.status == 500 and "CUDA OOM" in e.value.message


def test_broadcast_and_clone_priorities(voices):
    spy = SpyWorker()
    svc = make(voices, worker=spy)
    svc.speak("Привет.")
    svc.clone("Привет.", "Эталон", ref_wav())
    assert spy.priorities == [W.BROADCAST, W.CLONE]


def test_health_reports_model_and_queue(voices):
    h = make(voices).health()
    assert h["ok"] and h["model_loaded"] and h["dtype"] == "torch.float16"
    assert h["voices"] == ["ru-host"] and h["default_voice"] == "ru-host"
    assert h["queue"] == 0 and h["vram_peak_mb"] == 1


def test_unknown_default_voice_refuses_to_start(voices):
    with pytest.raises(ValueError):
        S.Service(FakeEngine(), voices, "ru-dmitri", FakeAccent(), W.Worker())
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_service.py`
Expected: FAIL — `No module named 'f5_service'`.

- [ ] **Step 3: Реализация**

`station/tts-f5/f5_service.py`:

```python
"""Синтез по запросу: голос, ударения, нарезка, очередь, склейка, громкость.

Ручки эфира (speak) нормализуют громкость до −17 dBFS с потолком пика; /clone
(digital_me) отдаёт родную громкость модели — её выставляет сам tts.py
(−20 dBFS, PEAK_CEILING 32000), а срезанный здесь пик он бы уже не вернул.
"""
import functools
import time
from dataclasses import dataclass, field

import f5_audio
import f5_text
from f5_voices import resolve, voice_from_audio
from f5_worker import BROADCAST, CLONE, QueueTimeout

MAX_TEXT_CHARS = 20000


class ServiceError(Exception):
    """Отказ с HTTP-кодом: server.py превращает его в ответ, текст уходит клиенту."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass
class Result:
    wav: bytes
    headers: dict = field(default_factory=dict)


class Service:
    def __init__(self, engine, voices, default_voice, accentizer, worker,
                 queue_wait=60.0, log=print, clock=time.monotonic):
        if default_voice not in voices:
            raise ValueError(f"голоса по умолчанию {default_voice!r} нет среди {sorted(voices)}")
        self.engine = engine
        self.voices = voices
        self.default_voice = default_voice
        self.accentizer = accentizer
        self.worker = worker
        self.queue_wait = queue_wait
        self.log = log
        self.clock = clock
        self.started = clock()

    def speak(self, text, voice_name=None) -> Result:
        t0 = self.clock()
        marked = self._text(text)
        voice, fell_back, reason = resolve(self.voices, voice_name, self.default_voice)
        wave, chunks, wait = self._run(voice, marked, BROADCAST, t0)
        wave = f5_audio.normalize_broadcast(wave)
        headers = {"X-TTS-Voice-Used": voice.name}
        if fell_back:
            headers["X-TTS-Fell-Back"] = "1"
            headers["X-TTS-Fell-Back-Reason"] = reason
        self._journal("speak", voice.name, marked, chunks, wave, wait, t0, reason)
        return Result(f5_audio.encode_wav(wave), headers)

    def clone(self, text, ref_text, ref_audio) -> Result:
        t0 = self.clock()
        marked = self._text(text)
        if not isinstance(ref_text, str) or not ref_text.strip():
            raise ServiceError(400, "ref_text обязателен: без транскрипта F5 полез бы в whisper")
        if not ref_audio:
            raise ServiceError(400, "ref_audio пуст")
        try:
            samples, sr = f5_audio.decode_wav(ref_audio)
        except f5_audio.UnsupportedAudio as e:
            raise ServiceError(415, str(e)) from None
        try:
            voice = voice_from_audio("clone", samples, sr, ref_text)
        except ValueError as e:
            raise ServiceError(400, str(e)) from None
        wave, chunks, wait = self._run(voice, marked, CLONE, t0)
        self._journal("clone", "-", marked, chunks, wave, wait, t0, None)
        return Result(f5_audio.encode_wav(wave))

    def health(self) -> dict:
        return {"ok": True, "model_loaded": True,
                "dtype": self.engine.dtype, "device": self.engine.device,
                "default_voice": self.default_voice, "voices": sorted(self.voices),
                "queue": self.worker.pending(), "jobs_done": self.worker.jobs_done,
                "uptime_s": int(self.clock() - self.started), **self.engine.vram()}

    def _text(self, text) -> str:
        if not isinstance(text, str) or not text.strip():
            raise ServiceError(400, "текст обязателен и должен быть непустой строкой")
        if len(text) > MAX_TEXT_CHARS:
            raise ServiceError(413, f"текст длиннее {MAX_TEXT_CHARS} символов")
        return self.accentizer.apply(text.strip())

    def _run(self, voice, text, priority, t0):
        chunks = f5_text.chunk(text, voice.max_chars)
        started = []

        def job(chunk, first):
            if first:
                started.append(self.clock())
            return self.engine.synth(voice.samples, voice.sr, voice.ref_text, chunk)

        fns = [functools.partial(job, c, i == 0) for i, c in enumerate(chunks)]
        try:
            waves = self.worker.run_all(fns, priority, self.queue_wait)
        except QueueTimeout as e:
            raise ServiceError(503, str(e)) from None
        except Exception as e:                 # noqa: BLE001 — наружу текст, не traceback
            raise ServiceError(500, f"синтез не удался: {e}") from None
        wave = f5_audio.trim_tail(f5_audio.join_crossfade(waves), f5_audio.SR)
        return wave, len(chunks), (started[0] - t0) if started else 0.0

    def _journal(self, kind, voice, text, chunks, wave, wait, t0, reason):
        """Строка на запрос: у Chatterbox журнал обрывался, и суточный объём так и
        не удалось посчитать."""
        total = self.clock() - t0
        line = (f"{kind} voice={voice} chars={len(text)} chunks={chunks} "
                f"audio_s={len(wave) / f5_audio.SR:.1f} synth_s={total - wait:.1f} "
                f"wait_s={wait:.1f}")
        self.log(line + (f" fell_back={reason}" if reason else ""))
```

- [ ] **Step 4: Прогнать тесты**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_service.py --durations=5`
Expected: 22 passed; каждый < 1 с.

- [ ] **Step 5: Коммит**

```bash
git -C $M add station/tts-f5/f5_service.py tests/test_tts_f5_service.py
git -C $M commit -m "F5-служба: запрос целиком — голос, нарезка, очередь, громкость эфира"
```

---

### Task 7: HTTP и сборка — `server.py`, `requirements.txt`, `Dockerfile`, `build.ps1`, `README.md`

**Files:**
- Create: `station/tts-f5/server.py`, `station/tts-f5/requirements.txt`, `station/tts-f5/Dockerfile`, `station/tts-f5/build.ps1`, `station/tts-f5/README.md`
- Test: `tests/test_tts_f5_server.py`

**Interfaces:**
- Consumes: `Service`, `ServiceError`, `Result` (задача 6); `Accentizer`, `load_voices`, `Engine`, `DryEngine`, `Worker`.
- Produces: `app`, `SERVICE`, `MAX_REF_BYTES = 10 * 2**20`, `build_service() -> Service`; обработчики `health()`, `openai_speech(payload: dict)`, `speak(payload: dict)`, `clone(text, ref_text, ref_audio, language)`. Переменные окружения: `F5_ENGINE` (`f5` | `dry`), `F5_MODEL`, `F5_CKPT`, `F5_VOCAB`, `F5_VOCOS`, `F5_VOICES`, `F5_DEFAULT_VOICE`, `F5_DEVICE`, `RUACCENT_DIR`, `QUEUE_WAIT`.

- [ ] **Step 1: Написать тесты**

`tests/test_tts_f5_server.py`:

```python
"""server.py: ручки F5-службы и защита эталона от записи на диск.

fastapi в Python music не стоит (он живёт в образе), поэтому подменяется
заглушкой — проверяется обвязка сервера, а не библиотека. Starlette настоящая:
на ней проверяется, что загрузка эталона не уходит во временный файл.
"""
import importlib.util
import io
import sys
import types
from pathlib import Path

import pytest
from starlette.formparsers import MultiPartParser

F5_DIR = Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"
sys.path.insert(0, str(F5_DIR))
import f5_service as S  # noqa: E402


class FakeHTTPException(Exception):
    def __init__(self, status_code, detail=""):
        super().__init__(f"{status_code}: {detail}")
        self.status_code = status_code
        self.detail = detail


class FakeResponse:
    def __init__(self, content, media_type=None, headers=None):
        self.content, self.media_type, self.headers = content, media_type, headers or {}


class FakeApp:
    def __init__(self, **kw):
        self.routes = []

    def _route(self, method, path):
        def register(fn):
            self.routes.append((method, path))
            return fn
        return register

    def get(self, path, **kw):
        return self._route("GET", path)

    def post(self, path, **kw):
        return self._route("POST", path)

    def on_event(self, name):
        return lambda fn: fn


@pytest.fixture
def server(monkeypatch):
    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = FakeApp
    fastapi.HTTPException = FakeHTTPException
    fastapi.Body = fastapi.File = fastapi.Form = lambda *a, **kw: None
    fastapi.UploadFile = object
    responses = types.ModuleType("fastapi.responses")
    responses.Response = FakeResponse
    monkeypatch.setitem(sys.modules, "fastapi", fastapi)
    monkeypatch.setitem(sys.modules, "fastapi.responses", responses)
    # вернуть порог Starlette после теста: модуль сервера меняет его глобально
    monkeypatch.setattr(MultiPartParser, "spool_max_size", MultiPartParser.spool_max_size)
    spec = importlib.util.spec_from_file_location("f5_server", F5_DIR / "server.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeService:
    def __init__(self, error=None):
        self.error, self.calls = error, []

    def speak(self, text, voice=None):
        self.calls.append(("speak", text, voice))
        if self.error:
            raise self.error
        return S.Result(b"RIFF", {"X-TTS-Voice-Used": "ru-host"})

    def clone(self, text, ref_text, ref_audio):
        self.calls.append(("clone", text, ref_text, len(ref_audio)))
        return S.Result(b"RIFF")

    def health(self):
        return {"ok": True, "model_loaded": True}


class FakeUpload:
    def __init__(self, data):
        self.file = io.BytesIO(data)


def test_all_routes_are_registered(server):
    assert set(server.app.routes) == {("GET", "/health"), ("POST", "/v1/audio/speech"),
                                      ("POST", "/speak"), ("POST", "/clone")}


def test_health_before_startup_is_503(server):
    server.SERVICE = None
    with pytest.raises(FakeHTTPException) as e:
        server.health()
    assert e.value.status_code == 503


def test_openai_route_passes_input_and_voice(server):
    server.SERVICE = svc = FakeService()
    r = server.openai_speech({"input": "Привет", "voice": "ru-host"})
    assert svc.calls == [("speak", "Привет", "ru-host")]
    assert r.media_type == "audio/wav" and r.headers["X-TTS-Voice-Used"] == "ru-host"


def test_speak_route_passes_text(server):
    server.SERVICE = svc = FakeService()
    server.speak({"text": "Привет"})
    assert svc.calls == [("speak", "Привет", None)]


def test_service_error_keeps_its_status(server):
    server.SERVICE = FakeService(error=S.ServiceError(415, "не WAV"))
    with pytest.raises(FakeHTTPException) as e:
        server.openai_speech({"input": "Привет"})
    assert e.value.status_code == 415


def test_oversized_reference_is_413(server):
    server.SERVICE = FakeService()
    big = FakeUpload(b"x" * (server.MAX_REF_BYTES + 1))
    with pytest.raises(FakeHTTPException) as e:
        server.clone(text="т", ref_text="э", ref_audio=big, language="ru")
    assert e.value.status_code == 413


def test_reference_upload_stays_in_memory(server):
    """Starlette сбрасывает загрузку больше 1 МиБ во временный файл; эталон
    владельца — биометрия, и 10 с стерео 48 кГц это уже 1.9 МиБ."""
    assert MultiPartParser.spool_max_size >= server.MAX_REF_BYTES
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_server.py`
Expected: FAIL — `FileNotFoundError` на `server.py`.

- [ ] **Step 3: `server.py`**

`station/tts-f5/server.py`:

```python
"""F5-TTS на gpu-host: HTTP-обёртка над f5_service.Service.

  GET  /health            → 200 {"ok":true,"model_loaded":true,…}: мостик music
                            ждёт model_loaded, пульт gpu-ctl — любой ответ < 500
  POST /v1/audio/speech   → JSON {input, voice?}  (мостик music, подмножество OpenAI)
  POST /speak             → JSON {text, voice?}   (шлюз /speech/tts, контракт Remote)
  POST /clone             → multipart {text, ref_text, ref_audio, language?} (digital_me)

Модель грузится в startup: пока она не готова, служба на /health отвечает 503.
"""
import os
from pathlib import Path

import starlette.formparsers as _formparsers
from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

from f5_service import Service, ServiceError

MAX_REF_BYTES = 10 * 2 ** 20

# Starlette сбрасывает загружаемый файл больше 1 МиБ во временный файл на диске
# (MultiPartParser.spool_max_size). Эталон владельца digital_me — биометрия, на
# диск gpu-host он попадать не должен, а 10 с стерео 48 кГц — это уже 1.9 МиБ.
if not hasattr(_formparsers.MultiPartParser, "spool_max_size"):
    raise RuntimeError("у этой версии Starlette нет spool_max_size — эталон ушёл бы на диск")
_formparsers.MultiPartParser.spool_max_size = MAX_REF_BYTES

app = FastAPI(title="F5-TTS")
SERVICE = None


def build_service() -> Service:
    from f5_accent import Accentizer
    from f5_engine import DryEngine, Engine
    from f5_voices import load_voices
    from f5_worker import Worker
    env = os.environ
    accent = Accentizer(Path(env.get("RUACCENT_DIR", "/ruaccent")))
    accent.load()
    voices = load_voices(env.get("F5_VOICES", "/voices"))
    if env.get("F5_ENGINE", "f5") == "dry":
        engine = DryEngine()
    else:
        engine = Engine.load(env.get("F5_MODEL", "F5TTS_v1_Base"),
                             env.get("F5_CKPT", "/models/espeech/espeech_tts_rlv2_fp16.safetensors"),
                             env.get("F5_VOCAB", "/models/espeech/vocab.txt"),
                             env.get("F5_VOCOS", "/models/vocos"),
                             env.get("F5_DEVICE", "cuda"))
        if engine.device.startswith("cuda") and "float16" not in engine.dtype:
            raise RuntimeError(f"модель на {engine.device} в {engine.dtype}, ожидался fp16")
    return Service(engine, voices, env.get("F5_DEFAULT_VOICE", "ru-host"), accent, Worker(),
                   queue_wait=float(env.get("QUEUE_WAIT", "60")))


@app.on_event("startup")
def startup():
    global SERVICE
    SERVICE = build_service()


def _service() -> Service:
    if SERVICE is None:
        raise HTTPException(503, "model still loading")
    return SERVICE


def _call(fn, *args):
    try:
        result = fn(*args)
    except ServiceError as e:
        raise HTTPException(e.status, e.message) from None
    return Response(result.wav, media_type="audio/wav", headers=result.headers)


@app.get("/health")
def health():
    return _service().health()


@app.post("/v1/audio/speech")
def openai_speech(payload: dict = Body(...)):
    return _call(_service().speak, payload.get("input"), payload.get("voice"))


@app.post("/speak")
def speak(payload: dict = Body(...)):
    return _call(_service().speak, payload.get("text"), payload.get("voice"))


@app.post("/clone")
def clone(text: str = Form(...), ref_text: str = Form(...), ref_audio: UploadFile = File(...),
          language: str = Form("ru")):
    # language принимается ради совместимости с tts.py digital_me и не используется:
    # ESpeech — русская модель, отказ на других языках делает сам tts.py
    data = ref_audio.file.read(MAX_REF_BYTES + 1)
    if len(data) > MAX_REF_BYTES:
        raise HTTPException(413, f"эталон больше {MAX_REF_BYTES // 2 ** 20} МиБ")
    return _call(_service().clone, text, ref_text, data)
```

- [ ] **Step 4: Прогнать тесты сервера**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_server.py`
Expected: 7 passed.

- [ ] **Step 5: `requirements.txt`**

`station/tts-f5/requirements.txt`:

```
# Поверх vllm/vllm-openai:v0.27.1. torch 2.13+cu130 (sm_120), torchaudio, numpy,
# transformers, safetensors, huggingface-hub, fastapi, uvicorn уже в базе — их
# версии Dockerfile прибивает констрейнтом. f5-tts ставится отдельно с --no-deps:
# его полный список тянет gradio, bitsandbytes и torchcodec, на синтезе ненужные.
# Версии — из венва пробы на хосте gpu-host (D:\Temp\f5-probe\venv, Python 3.12, как
# в базе), где F5 загрузил fp16-чекпойнт и заговорил 2026-09-22; ruaccent и
# onnxruntime — из венва SuperTonic, чей кэш моделей RUAccent переносится в службу.
vocos==0.1.0
x-transformers==2.30.1
einx==0.4.3
torchdiffeq==0.2.5
rjieba==0.2.1
pypinyin==0.55.0
librosa==1.0.0
pydub==0.25.1
soundfile==0.14.0
matplotlib==3.11.2
# f5_tts.model импортирует тренер, а он — wandb, accelerate, ema_pytorch, datasets
accelerate==1.15.0
ema-pytorch==0.8.3
wandb==0.30.0
datasets==5.0.1
ruaccent==1.5.8.3
onnxruntime==1.26.0
python-multipart==0.0.32
PyYAML==6.0.3
```

- [ ] **Step 6: `Dockerfile`**

`station/tts-f5/Dockerfile`:

```dockerfile
# F5-TTS на gpu-host. База — vllm/vllm-openai:v0.27.1: уже лежит на gpu-host (слоты
# ocr, ocr-cand, tts-qwen), torch 2.13+cu130 собран с sm_120 (RTX 5060 Ti,
# Blackwell), пакеты ставятся pip в системный Python, как у qwen3-tts:local.
# Слоёв Chatterbox в ней нет — после миграции его образ удаляется целиком.
FROM vllm/vllm-openai:v0.27.1

# у базы ENTRYPOINT ["vllm","serve"]
ENTRYPOINT []
WORKDIR /app

# Версии того, что уже в базе, прибиваются: иначе резолвер вправе заменить torch
# сборкой с PyPI без ядер sm_120. Сборки +cu130 живут только на индексе PyTorch —
# без него прибитая версия неразрешима (грабля 2026-09-22).
RUN python3 -c "import torch, torchaudio, numpy, transformers, safetensors, huggingface_hub as h; print(f'torch=={torch.__version__}'); print(f'torchaudio=={torchaudio.__version__}'); print(f'numpy=={numpy.__version__}'); print(f'transformers=={transformers.__version__}'); print(f'safetensors=={safetensors.__version__}'); print(f'huggingface-hub=={h.__version__}')" > /tmp/pin.txt \
 && cat /tmp/pin.txt

COPY requirements.txt /app/requirements.txt
# Сеть контейнеров за NAT Docker Desktop рвёт загрузки: кэш pip переживает
# повтор, попыток пять.
RUN --mount=type=cache,target=/root/.cache/pip \
    ok=0; for i in 1 2 3 4 5; do \
      if pip install --retries 10 --timeout 120 -c /tmp/pin.txt \
           --extra-index-url https://download.pytorch.org/whl/cu130 \
           -r /app/requirements.txt; then ok=1; break; fi; \
      echo "pip attempt $i failed, retrying"; sleep 15; \
    done; test "$ok" = 1
RUN pip install --retries 10 --no-deps f5-tts==1.1.22 \
 && python3 -c "import f5_tts.infer.utils_infer, f5_tts.model, ruaccent, soundfile, pydub, multipart, yaml; print('imports ok')"

COPY f5_audio.py f5_text.py f5_worker.py f5_accent.py f5_voices.py f5_engine.py f5_service.py server.py /app/
ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
EXPOSE 4126
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "4126"]
```

- [ ] **Step 7: `build.ps1`** (только ASCII — PS 5.1 без BOM)

`station/tts-f5/build.ps1`:

```powershell
# Build f5-tts:local on gpu-host. Must run in the interactive session: Docker Desktop's
# credential helper fails in SSH session 0. Started by a temporary scheduled task
# with LogonType Interactive (see README.md). ASCII only: PS 5.1 reads BOM-less
# UTF-8 as ANSI.
$ErrorActionPreference = 'Continue'
$ctx = '<gpu-ssd>\LLM\docker\f5-tts\app'
$log = '<gpu-ssd>\LLM\docker\f5-tts\build.log'
"build started $(Get-Date -Format s)" | Set-Content -LiteralPath $log -Encoding ascii
docker build --progress=plain -t f5-tts:local $ctx 2>&1 | Out-File -LiteralPath $log -Append -Encoding utf8
"exit $LASTEXITCODE $(Get-Date -Format s)" | Add-Content -LiteralPath $log -Encoding ascii
```

- [ ] **Step 8: `README.md`**

`station/tts-f5/README.md`:

```markdown
# F5-TTS — общая TTS-служба gpu-host

Замена Chatterbox. Спека: [2026-09-23-tts-f5-migration-design.md](../specs/2026-09-23-tts-f5-migration-design.md).
Движок — F5-TTS в русском дообучении ESpeech-TTS-1 RL-V2 (fp16 safetensors, 643 МБ).

## Ручки

| Ручка | Клиент | Контракт |
|---|---|---|
| `GET /health` | мостик music, пульт gpu-ctl | `{"ok":true,"model_loaded":true,…}` после загрузки модели |
| `POST /v1/audio/speech` | мостик music (`:4124`) | JSON `{input, voice?}` → WAV |
| `POST /speak` | шлюз `/speech/tts` | JSON `{text, voice?}` → WAV |
| `POST /clone` | digital_me `tts.py --local` | multipart `{text, ref_text, ref_audio}` → WAV |

Выход — WAV PCM 16 бит, моно, 24 кГц. Громкость эфира выравнивается до −17 dBFS с
потолком пика; `/clone` отдаёт родную громкость. Неизвестный голос даёт `ru-host`
и заголовки `X-TTS-Fell-Back*`.

**Эталон `/clone` не касается диска:** синтез идёт мимо `F5TTS.infer` (тот пишет
копию эталона во временный файл и не удаляет), а порог Starlette, после которого
загрузка сбрасывается на диск, поднят до 10 МиБ.

## Размещение на gpu-host

    <gpu-ssd>\LLM\docker\f5-tts\
      app\          контекст сборки: этот каталог без tests и voices
      models\       espeech\ (fp16 safetensors + vocab.txt), vocos\
      ruaccent\     модели RUAccent (tiny2.1 + словарь), монтируются на запись
      voices\       <имя>.wav ≤12 с + <имя>.txt — копия voices/ из репозитория
      voices-src\   исходные записи, из которых резались эталоны

Compose слота — у пульта: `llm_routers/gpu-ctl/deploy/compose/tts.yaml`; поднимает
и гасит службу только пульт (`/ensure-up?slot=tts`).

## Сборка

`docker build` по SSH на gpu-host не работает (кредхелпер Docker Desktop в
session 0) — сборка идёт временной задачей планировщика в интерактивной сессии:

    $a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File <gpu-ssd>\LLM\docker\f5-tts\app\build.ps1'
    $p = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName 'TmpF5Build' -Action $a -Principal $p -Force
    Start-ScheduledTask -TaskName 'TmpF5Build'
    # ждать строки "exit …" в <gpu-ssd>\LLM\docker\f5-tts\build.log, затем:
    Unregister-ScheduledTask -TaskName 'TmpF5Build' -Confirm:$false

## Голоса

`tools/make_voice.py <запись.wav> <имя> <каталог>` режет эталон ≤12 с по последней
паузе и снимает транскрипт whisper-small; транскрипт проверить глазами — F5
выравнивает эталон по тексту. Готовая пара кладётся в `voices/` репозитория и
копируется в `<gpu-ssd>\LLM\docker\f5-tts\voices\`.

## Проверка без карты

`F5_ENGINE=dry` подменяет модель тоном: проверяются HTTP, голоса, RUAccent офлайн
и путь `/clone` в малой памяти. Разовые контейнеры на gpu-host — только с `--memory`
и без `--gpus`: на карту служба выходит только через пульт.
```

- [ ] **Step 9: Весь быстрый набор music**

Run: `cd $M && "$PY" -m pytest -q --durations=10`
Expected: все зелёные; новые тесты — в хвосте списка длительностей, < 1 с каждый.

- [ ] **Step 10: Коммит**

```bash
git -C $M add station/tts-f5/server.py station/tts-f5/requirements.txt station/tts-f5/Dockerfile \
    station/tts-f5/build.ps1 station/tts-f5/README.md tests/test_tts_f5_server.py
git -C $M commit -m "F5-служба: HTTP-ручки и сборка образа на базе vllm"
```

---

### Task 8: Инструменты — `tools/make_voice.py`, `tools/smoke.py`

**Files:**
- Create: `station/tts-f5/tools/make_voice.py`, `station/tts-f5/tools/smoke.py`
- Test: `tests/test_tts_f5_make_voice.py`

**Interfaces:**
- Consumes: `f5_audio.decode_wav`, `f5_audio.reference`, `f5_audio.encode_wav`.
- Produces: CLI `make_voice.py <source.wav> <name> <out_dir> [--text T]` → `<out_dir>/<name>.wav` (≤12.05 с) и `<out_dir>/<name>.txt`; функция `main(argv) -> int`. CLI `smoke.py [--url U] [--voices DIR] [--out DIR] [--wait S] [--no-clone]` — код выхода 0, если все проверки прошли; пригодится и окну приёмки плана 2.

- [ ] **Step 1: Написать тест**

`tests/test_tts_f5_make_voice.py`:

```python
"""make_voice.py: эталон режется тем же f5_audio.reference, что служба применяет
при загрузке голоса, — транскрипт описывает ровно то, что услышит модель."""
import importlib.util
import sys
from pathlib import Path

import numpy as np

F5_DIR = Path(__file__).resolve().parent.parent / "deploy" / "tts-f5"
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
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_make_voice.py`
Expected: FAIL — `FileNotFoundError` на `tools/make_voice.py`.

- [ ] **Step 3: Реализация**

`station/tts-f5/tools/make_voice.py`:

```python
"""Эталон голоса для F5 из длинной записи: срез ≤12 с по паузе + транскрипт.

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
```

- [ ] **Step 4: Прогнать тест**

Run: `cd $M && "$PY" -m pytest -q tests/test_tts_f5_make_voice.py`
Expected: 1 passed.

- [ ] **Step 5: Дымовая проверка живой службы — `tools/smoke.py`**

Ручной инструмент для задачи 10 и окна приёмки. Отдельного теста нет: его
проверка — прогон против живой службы. Зачем скрипт, а не `curl` в командной
строке SSH: кириллица в аргументах через SSH и кодовую страницу PowerShell
доезжает битой, а здесь она в теле запроса из UTF-8-файла.

`station/tts-f5/tools/smoke.py`:

```python
"""Дымовая проверка живой F5-службы: /health, /speak с опечаткой в голосе, /clone.

    python smoke.py [--url http://127.0.0.1:14126] [--voices J:\\LLM\\docker\\f5-tts\\voices]
                    [--out J:\\LLM\\docker\\f5-tts\\smoke] [--wait 180] [--no-clone]

Только stdlib — запускается хостовым Python gpu-host. Строка на проверку; код
выхода 1, если хоть одна не прошла.
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

TEXT = "Проверка связи."


def call(url, data=None, headers=None, timeout=900):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                   .encode() + value.encode("utf-8") + b"\r\n")
    for name, (filename, data) in files.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                   f'filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'
                   .encode() + data + b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def wav_info(data):
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnframes() / w.getframerate()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:14126")
    ap.add_argument("--voices", default=r"<gpu-ssd>\LLM\docker\f5-tts\voices")
    ap.add_argument("--out", help="куда сложить полученные WAV для прослушивания")
    ap.add_argument("--wait", type=float, default=180, help="сколько ждать /health, с")
    ap.add_argument("--no-clone", action="store_true", help="только /health и /speak")
    a = ap.parse_args(argv)
    out = Path(a.out) if a.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    results = []

    def check(name, ok, detail):
        results.append(ok)
        print(f"{'OK  ' if ok else 'FAIL'} {name}: {detail}", flush=True)

    deadline = time.monotonic() + a.wait
    while True:
        try:
            status, _, body = call(a.url + "/health", timeout=5)
        except OSError:
            status, body = 0, b""
        if status == 200 or time.monotonic() > deadline:
            break
        time.sleep(2)
    check("health", status == 200, body.decode("utf-8", "replace") or f"нет ответа за {a.wait:.0f} с")
    if status != 200:
        return 1

    t0 = time.monotonic()
    status, h, data = call(a.url + "/speak", json.dumps({"text": TEXT, "voice": "ru-rajt"}).encode(),
                           {"Content-Type": "application/json"})
    detail = (f"{status} voice={h.get('X-TTS-Voice-Used')} fell_back={h.get('X-TTS-Fell-Back')} "
              f"reason={h.get('X-TTS-Fell-Back-Reason')} {time.monotonic() - t0:.1f} s")
    ok = status == 200 and h.get("X-TTS-Voice-Used") == "ru-host" and h.get("X-TTS-Fell-Back") == "1"
    if status == 200:
        sr, secs = wav_info(data)
        ok = ok and sr == 24000
        detail += f", {sr} Hz, {secs:.1f} s звука"
        if out:
            (out / "speak.wav").write_bytes(data)
    check("speak", ok, detail)

    if not a.no_clone:
        voices = Path(a.voices)
        ref = (voices / "ru-host.wav").read_bytes()
        ref_text = (voices / "ru-host.txt").read_text(encoding="utf-8").strip()
        body, hdr = multipart({"text": TEXT, "ref_text": ref_text}, {"ref_audio": ("ref.wav", ref)})
        t0 = time.monotonic()
        status, _, data = call(a.url + "/clone", body, hdr)
        detail, ok = f"{status} {time.monotonic() - t0:.1f} s", status == 200
        if ok:
            sr, secs = wav_info(data)
            ok = sr == 24000
            detail += f", {sr} Hz, {secs:.1f} s звука"
            if out:
                (out / "clone.wav").write_bytes(data)
        check("clone", ok, detail)
        body, hdr = multipart({"text": TEXT, "ref_text": ref_text},
                              {"ref_audio": ("ref.mp3", b"ID3\x03\x00 not a wav")})
        status, _, _ = call(a.url + "/clone", body, hdr)
        check("clone-not-wav", status == 415, str(status))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 6: Коммит**

```bash
git -C $M add station/tts-f5/tools/make_voice.py station/tts-f5/tools/smoke.py tests/test_tts_f5_make_voice.py
git -C $M commit -m "F5-служба: инструменты — эталон голоса и дымовая проверка"
```

---

### Task 9: Раскладка на `<gpu-ssd>\LLM` и эталон `ru-host`

**Files:**
- Create на gpu-host: `<gpu-ssd>\LLM\docker\f5-tts\{app,models\espeech,models\vocos,ruaccent,voices,voices-src}`
- Create в репозитории: `station/tts-f5/voices/ru-host.wav`, `station/tts-f5/voices/ru-host.txt`

**Interfaces:**
- Consumes: `tools/make_voice.py` (задача 8); веса `D:\Temp\f5-probe\ckpt\`; кэш RUAccent `<gpu-data>\SuperTonic\.ruaccent_cache` (проверен в бейк-оффе 2026-09-22); koziev из пакета ruaccent венва SuperTonic `<gpu-data>\SuperTonic\.venv\Lib\site-packages\ruaccent\koziev`.
- Produces: каталоги, которые монтирует compose задачи 11 и контейнеры задачи 10; `app\ruaccent-koziev` — его Dockerfile кладёт в пакет ruaccent образа.

koziev (POS-теггер и лемматизатор RuleEngine) в колесо ruaccent не входит и в кэше
`.ruaccent_cache` его нет: RUAccent докачивает его при первом `load` в каталог
**пакета**, а не в `workdir` (`ruaccent.py:82-87`). В контейнере с `HF_HUB_OFFLINE=1`
без него `load` падает на старте — даже с `F5_ENGINE=dry`.

- [ ] **Step 1: Каталоги и веса**

```bash
ssh -p <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR <gpu-user>@<gpu-host> "\
\$r='<gpu-ssd>\LLM\docker\f5-tts'; \
New-Item -ItemType Directory -Force -Path \"\$r\app\tools\",\"\$r\models\espeech\",\"\$r\models\vocos\",\"\$r\ruaccent\",\"\$r\voices\",\"\$r\voices-src\" | Out-Null; \
Copy-Item -LiteralPath 'D:\Temp\f5-probe\ckpt\espeech\espeech_tts_rlv2_fp16.safetensors','D:\Temp\f5-probe\ckpt\espeech\vocab.txt' -Destination \"\$r\models\espeech\"; \
robocopy 'D:\Temp\f5-probe\ckpt\vocos' \"\$r\models\vocos\" /E /NFL /NDL /NJH /NJS | Out-Null; \
robocopy '<gpu-data>\SuperTonic\.ruaccent_cache' \"\$r\ruaccent\" /E /NFL /NDL /NJH /NJS | Out-Null; \
robocopy '<gpu-data>\SuperTonic\.venv\Lib\site-packages\ruaccent\koziev' \"\$r\app\ruaccent-koziev\" /E /XD __pycache__ /NFL /NDL /NJH /NJS | Out-Null; \
Get-ChildItem -Recurse -File \"\$r\models\",\"\$r\ruaccent\",\"\$r\app\ruaccent-koziev\" | Group-Object Directory | ForEach-Object { '{0}  {1} files  {2:N0} MB' -f \$_.Name, \$_.Count, ((\$_.Group | Measure-Object Length -Sum).Sum/1MB) }"
```

Expected: `models\espeech` — 2 файла, ~643 МБ; `models\vocos` — `config.yaml` + `pytorch_model.bin` (~52 МБ); `ruaccent` — ~194 МБ, в том числе `nn\nn_omograph\tiny2.1\model.onnx`, `dictionary\accents.json.gz` и `dictionary\rule_engine\forms.json`; `app\ruaccent-koziev` — ~28 МБ: `rulemma\rulemma.dat`, `rupostagger\rupostagger.model`, `rupostagger\ruword2tags.dat`, `rupostagger\database\ruword2tags.db`.

- [ ] **Step 2: Файлы службы в `app`**

```bash
scp -P <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR \
    $M/station/tts-f5/f5_*.py $M/station/tts-f5/server.py $M/station/tts-f5/requirements.txt \
    $M/station/tts-f5/Dockerfile $M/station/tts-f5/build.ps1 \
    <gpu-user>@<gpu-host>:J:/LLM/docker/f5-tts/app/
scp -P <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR \
    $M/station/tts-f5/tools/make_voice.py $M/station/tts-f5/tools/smoke.py \
    <gpu-user>@<gpu-host>:J:/LLM/docker/f5-tts/app/tools/
scp -P <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR \
    $M/station/tts-bridge/refs/ru-host.wav <gpu-user>@<gpu-host>:J:/LLM/docker/f5-tts/voices-src/ru-host-18s.wav
```

Expected: копирование без ошибок; в `app` — 8 `.py` + `requirements.txt`, `Dockerfile`, `build.ps1` и `ruaccent-koziev\` из шага 1; в `app\tools` — `make_voice.py`, `smoke.py`. Исходник `ru-host.wav` — моно, 16 бит, 24000 Гц, 18.0 с (сверено 2026-09-23).

- [ ] **Step 3: Эталон `ru-host` на хосте**

Хост gpu-host — 192 ГБ, венв пробы с transformers и torch CPU; кэш Hugging Face — на J:, чтобы не занимать C:.

```bash
ssh -p <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR -o ServerAliveInterval=30 <gpu-user>@<gpu-host> "\
\$env:HF_HOME='<gpu-ssd>\LLM\docker\f5-tts\hf-host'; \$env:PYTHONIOENCODING='utf-8'; \
& 'D:\Temp\f5-probe\venv\Scripts\python.exe' '<gpu-ssd>\LLM\docker\f5-tts\app\tools\make_voice.py' \
  '<gpu-ssd>\LLM\docker\f5-tts\voices-src\ru-host-18s.wav' 'ru-host' '<gpu-ssd>\LLM\docker\f5-tts\voices'"
```

Expected: `ru-host: N s at 24000 Hz`, где N ≤ 12.05.

- [ ] **Step 4: Проверить транскрипт глазами**

Прочитать `\\gpu-host\jj$\LLM\docker\f5-tts\voices\ru-host.txt` (Read по UNC или `scp` обратно). Ориентир — транскрипт первых 11.5 с того же эталона, снятый 2026-09-22 тем же whisper-small: «нужен игровой ролик? Или же вам не хватает информационного официоза? Или вам нужен голос, чтобы привлечь молодежную аудиторию? В любом случае, думаю, что». Срез по паузе может кончиться раньше — тогда транскрипт короче, но обязан совпадать дословно со своим началом. Расхождение — поправить `.txt` руками.

- [ ] **Step 5: Пара в репозиторий и коммит**

```bash
mkdir -p $M/station/tts-f5/voices
scp -P <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR \
    "<gpu-user>@<gpu-host>:J:/LLM/docker/f5-tts/voices/ru-host.*" $M/station/tts-f5/voices/
git -C $M add station/tts-f5/voices/ru-host.wav station/tts-f5/voices/ru-host.txt
git -C $M commit -m "F5-служба: эталон ru-host ≤12 с с транскриптом"
```

---

### Task 10: Образ `f5-tts:local` и проверка без карты

**Files:**
- Create на gpu-host: образ `f5-tts:local`, `<gpu-ssd>\LLM\docker\f5-tts\build.log`, `<gpu-ssd>\LLM\docker\f5-tts\smoke\`
- Modify (только при конфликте зависимостей): `station/tts-f5/requirements.txt`

**Interfaces:**
- Consumes: `<gpu-ssd>\LLM\docker\f5-tts\app` (задача 9).
- Produces: образ `f5-tts:local`, на который ссылается compose задачи 11.

- [ ] **Step 1: Сборка временной задачей в интерактивной сессии**

```bash
ssh -p <ssh-port> -i <ssh-key> -o BatchMode=yes -o LogLevel=ERROR <gpu-user>@<gpu-host> "\
\$a = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoProfile -ExecutionPolicy Bypass -File <gpu-ssd>\LLM\docker\f5-tts\app\build.ps1'; \
\$p = New-ScheduledTaskPrincipal -UserId 'Administrator' -LogonType Interactive -RunLevel Highest; \
Register-ScheduledTask -TaskName 'TmpF5Build' -Action \$a -Principal \$p -Force | Out-Null; \
Start-ScheduledTask -TaskName 'TmpF5Build'; 'started'"
```

Ждать строку `exit …` в `\\gpu-host\jj$\LLM\docker\f5-tts\build.log` (фоновой командой, без foreground `sleep`; сборка идёт 15–40 минут — pip тянет librosa, numba, pyarrow, wandb). Затем:

```bash
$SSH "Unregister-ScheduledTask -TaskName 'TmpF5Build' -Confirm:\$false; docker image inspect f5-tts:local --format '{{.Id}} {{.Size}}'"
```

Expected: в логе `imports ok`, `koziev ok` и `exit 0`; образ существует. Без
`koziev ok` сборка падает на шаге koziev — значит, в `app\ruaccent-koziev` нет файлов
(задача 9, шаг 1).

- [ ] **Step 2: Если pip не разрешил зависимости**

Сообщение `ResolutionImpossible` в `build.log` называет пакет. Если конфликт с версией, прибитой из базы (`transformers`, `huggingface-hub`, `numpy`, `torch`), — ослабить **свою** строку в `requirements.txt`: снять `==версия` у конфликтующего пакета из нашего списка, пересобрать (шаг 1), взять из лога строку `Successfully installed …` с выбранной pip версией и вписать её обратно пином. Базовые пины не трогать. Повторять до `exit 0`; итоговый `requirements.txt` — в коммит шага 6.

- [ ] **Step 3: torch образа видит Blackwell — без карты**

```bash
$SSH "docker run --rm --memory=2g f5-tts:local python3 -c \"import torch; print(torch.__version__, torch.cuda.get_arch_list())\""
```

Expected: `2.13.0+cu130` и `sm_120` в списке архитектур.

**Стоп-условие выбора базы.** Если `sm_120` в списке нет или сборка не доходит до
`imports ok` после шага 2 — база `vllm/vllm-openai:v0.27.1` проверку не прошла.
Дальше не идти: запасная база по спеке (§5) — образ Chatterbox, а это 38.5 ГБ слоёв,
которые тогда нельзя будет удалить. Такой выбор делает владелец.

Шаги 4 и 5 запускают `tools/smoke.py` хостовым Python gpu-host:
`PYH='C:\Users\Administrator\AppData\Local\Programs\Python\Python312\python.exe'`,
`SMOKE='<gpu-ssd>\LLM\docker\f5-tts\app\tools\smoke.py'`. Порт публикуется на `127.0.0.1` —
наружу не торчит. Каталог для WAV — `<gpu-ssd>\LLM\docker\f5-tts\smoke`.

**Контейнер `f5-smoke` не должен пережить шаг.** Его `docker rm -f` — последняя
команда той же SSH-строки: если инструмент агента оборвёт ssh по таймауту (по
умолчанию 120 с, а шаг 5 идёт минуты), удаление не выполнится, и отвязанный
контейнер с моделью останется держать до 3 ГиБ памяти ВМ Docker рядом с живым
эфиром; повтор шага упадёт на занятом имени, а `smoke.py` проверит старый
контейнер. Поэтому: каждая строка **начинается** с `docker rm -f f5-smoke`; оба шага
запускать с таймаутом инструмента 600000 мс (шаг 5 — фоновой командой, если
600 с не хватит); после шага — проверка, что контейнера нет. `--rm` не ставится:
упавший на старте контейнер удалился бы вместе с `docker logs`, нужными для разбора.

```bash
$SSH "docker ps -a --filter name=f5-smoke --format '{{.Names}} {{.Status}}'; 'ps-done'"
```

Expected: между выводом и `ps-done` — пусто. Иначе — `docker rm -f f5-smoke`.

- [ ] **Step 4: Обвязка без модели (`F5_ENGINE=dry`)**

```bash
$SSH "\
docker rm -f f5-smoke 2>\$null | Out-Null; \
docker run -d --name f5-smoke --memory=1500m -p 127.0.0.1:14126:4126 -e F5_ENGINE=dry \
  -v <gpu-ssd>\LLM\docker\f5-tts\ruaccent:/ruaccent -v <gpu-ssd>\LLM\docker\f5-tts\voices:/voices:ro f5-tts:local | Out-Null; \
& '$PYH' '$SMOKE' --wait 120 --out <gpu-ssd>\LLM\docker\f5-tts\smoke\dry; \
docker exec f5-smoke touch /tmp/mark; \
& '$PYH' '$SMOKE' --wait 5 | Out-Null; \
docker exec f5-smoke sh -c 'find / -xdev -newer /tmp/mark -name \"*.wav\" 2>/dev/null'; 'find-done'; \
docker logs f5-smoke 2>&1 | Select-String 'speak voice=|clone voice=|accent failed'; \
docker logs --tail 40 f5-smoke 2>&1; 'logs-done'; \
docker rm -f f5-smoke | Out-Null"
```

(`$PYH` и `$SMOKE` подставить буквально — это пути на gpu-host, а не переменные
локального шелла.) Второй прогон `smoke.py` идёт после метки `/tmp/mark`: `find`
ищет WAV, появившиеся в контейнере во время `/clone`.

Expected:
- `OK   health: {"ok":true,"model_loaded":true,"dtype":"dry",…,"voices":["ru-host"]}` — голоса загрузились, **RUAccent поднялся офлайн** (без этого старт упал бы);
- `OK   speak: 200 voice=ru-host fell_back=1 reason=unknown voice "ru-rajt" …, 24000 Hz`;
- `OK   clone: 200 …, 24000 Hz` и `OK   clone-not-wav: 415`;
- между `find` и `find-done` — **пусто**: эталон `/clone` не лёг на диск контейнера;
- в журнале — строки `speak voice=ru-host …` и `clone voice=- …` и **ни одной**
  `accent failed`: сбой RUAccent служба глотает (реплика уходит без ударений с кодом
  200), и `smoke.py` его не видит — виден он только в журнале;
- проверка `docker ps -a` (см. выше) — пусто.

Хвост журнала (`--tail 40`, до `logs-done`) печатается без фильтра и до удаления
контейнера: упавший на старте контейнер иначе унёс бы traceback с собой.

Если RUAccent на старте падает — traceback в этом хвосте. koziev в образе (сборка
напечатала `koziev ok`), поэтому вероятнее всего в кэше `workdir` не хватает файла
(`dictionary\…` или `nn\…`). `RUAccent().load(...)` тут не поможет: он докачивает
только **целиком отсутствующий** каталог `dictionary\` или `nn\nn_omograph\tiny2.1\`
(`ruaccent.py:63-81`), а одиночный файл в существующем каталоге не трогает. Сверить
состав `<gpu-ssd>\LLM\docker\f5-tts\ruaccent` со списком файлов репозитория
`ruaccent/accentuator` на Hugging Face и докачать недостающий файл хостовым Python:
`huggingface_hub.hf_hub_download("ruaccent/accentuator", "<путь в репо>",
local_dir=r"<gpu-ssd>\LLM\docker\f5-tts\ruaccent")`; затем повторить шаг.

- [ ] **Step 5: Настоящая модель на процессоре**

```bash
$SSH "\
docker rm -f f5-smoke 2>\$null | Out-Null; \
docker run -d --name f5-smoke --memory=3g -p 127.0.0.1:14126:4126 -e F5_DEVICE=cpu \
  -v <gpu-ssd>\LLM\docker\f5-tts\models:/models:ro -v <gpu-ssd>\LLM\docker\f5-tts\ruaccent:/ruaccent \
  -v <gpu-ssd>\LLM\docker\f5-tts\voices:/voices:ro f5-tts:local | Out-Null; \
& '$PYH' '$SMOKE' --wait 300 --no-clone --out <gpu-ssd>\LLM\docker\f5-tts\smoke\cpu; \
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' f5-smoke; \
docker logs --tail 40 f5-smoke 2>&1; 'logs-done'; \
docker rm -f f5-smoke | Out-Null; \
docker events --since 30m --until 0s --filter event=oom --format '{{.Time}} {{.Actor.Attributes.name}} oom'; 'events-done'"
```

Expected: `OK   health` с `"dtype":"torch.float32","device":"cpu"`; `OK   speak` за несколько минут (на процессоре хоста 2.6 с речи считались 300 с); в хвосте журнала нет `accent failed`; память контейнера < 3 ГиБ; **между командой events и `events-done` пусто** — ни одного `oom`, в том числе у `chatterbox-tts-api-blackwell`; проверка `docker ps -a` (см. выше) — пусто. `speak.wav` в `<gpu-ssd>\LLM\docker\f5-tts\smoke\cpu` — первая фраза F5 голосом `ru-host`; дать владельцу послушать можно, но оценка голоса — дело окна приёмки на карте.

Если контейнер убит лимитом (`oom` у `f5-smoke`, у соседей — нет) — это не поломка службы: на карте веса fp16 живут в VRAM, а не в оперативке. Записать факт и оставить полную проверку модели окну приёмки плана 2. Если `oom` у **соседа** — остановиться и сообщить владельцу: значит лимит не сработал как ожидалось.

- [ ] **Step 6: Коммит (если менялся `requirements.txt`)**

```bash
git -C $M add station/tts-f5/requirements.txt
git -C $M commit -m "F5-служба: версии зависимостей, разрешённые сборкой на gpu-host"
```

---

### Task 11: Слот `tts` у пульта

**Files:**
- Modify: `c:/AI/projects/llm_routers/gpu-ctl/slots.json` (блок после `tts-qwen`, строки 70-83)
- Create: `c:/AI/projects/llm_routers/gpu-ctl/deploy/compose/tts.yaml`
- Modify: `c:/AI/projects/llm_routers/gpu-ctl/CURRENT-STATE.md` (блок facts — генерацией; таблица «Что стоит в слотах», строки 59-68)
- Modify: `c:/AI/projects/llm_routers/gpu-ctl/README.md:25-28`, `c:/AI/projects/llm_routers/gpu-ctl/CLAUDE.md:7-10`

**Interfaces:**
- Consumes: образ `f5-tts:local` (задача 10), каталоги `<gpu-ssd>\LLM\docker\f5-tts\` (задача 9).
- Produces: слот `tts` в декларации живого пульта — его поднимает план 2 в окне приёмки.

- [ ] **Step 1: Блок в `slots.json`**

Вставить после блока `tts-qwen` (перед `llm`):

```json
    {
      "name": "tts",
      "class": "on-demand",
      "priority": 20,
      "vram_gb": 3.0,
      "cold_start_sec": 90,
      "excludes": ["chatterbox"],
      "idle_timeout_sec": 900,
      "port": 4126,
      "health_url": "http://127.0.0.1:4126/health",
      "mem_limit": "3g",
      "up":   "docker compose -f <gpu-data>\\_task\\LLM\\gpu-ctl\\compose\\tts.yaml up -d",
      "down": "docker compose -f <gpu-data>\\_task\\LLM\\gpu-ctl\\compose\\tts.yaml down"
    },
```

- [ ] **Step 2: `deploy/compose/tts.yaml`**

```yaml
# Своё имя проекта на каждый слот — иначе Docker выводит его из имени каталога
# и соседние слоты считаются осиротевшими (см. asr.yaml).
name: gpuctl-tts

services:
  tts:
    # F5-TTS (ESpeech-TTS-1 RL-V2) — общий TTS gpu-host: эфир music через мостик :4124
    # и /clone для digital_me. Образ собирается на gpu-host из music/deploy/tts-f5
    # (база vllm/vllm-openai:v0.27.1, torch под sm_120). Тег локальный, в registry
    # его нет — `pull_policy: never`, иначе compose пойдёт в Hub и упрётся в credsStore.
    image: f5-tts:local
    pull_policy: never
    container_name: f5-tts
    # on-demand до переключения эфира (спека music 2026-09-23, этап 3): гасит пульт,
    # Docker возвращать не должен.
    restart: "no"
    ports:
      - "4126:4126"
    # Все контейнеры Docker Desktop делят одну ВМ WSL на 10.4 ГБ. Контейнер без
    # лимита 22.09 выбил её оперативку, и ядро убило chatterbox. Совпадает со slots.json.
    mem_limit: "3g"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: ["0"]
              capabilities: [gpu]
    environment:
      - F5_MODEL=F5TTS_v1_Base
      - F5_CKPT=/models/espeech/espeech_tts_rlv2_fp16.safetensors
      - F5_VOCAB=/models/espeech/vocab.txt
      - F5_VOCOS=/models/vocos
      - F5_VOICES=/voices
      - F5_DEFAULT_VOICE=ru-host
      - RUACCENT_DIR=/ruaccent
    volumes:
      # Данные службы — на хосте в <gpu-ssd>\LLM\docker\f5-tts, по раскладке «каталог на
      # службу». Эталон владельца digital_me сюда не кладётся: он приходит в теле /clone.
      - type: bind
        source: <gpu-ssd>\LLM\docker\f5-tts\models
        target: /models
        read_only: true
      - type: bind
        source: <gpu-ssd>\LLM\docker\f5-tts\ruaccent
        target: /ruaccent
      - type: bind
        source: <gpu-ssd>\LLM\docker\f5-tts\voices
        target: /voices
        read_only: true
    healthcheck:
      # python3, а не curl: curl в образе нет (та же ловушка, что у asr).
      test: ["CMD-SHELL", "python3 -c \"import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:4126/health').status==200 else 1)\""]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 180s
```

- [ ] **Step 3: Проза и таблица «Что стоит в слотах»**

`README.md:25-28` — в перечень слотов после `` `tts-qwen` (локальный Qwen3-TTS проекта `digital_me`) `` дописать `` `tts` (F5-TTS — общий TTS gpu-host для `music` и `digital_me`; до переключения эфира `on-demand` рядом с `chatterbox`) ``. `CLAUDE.md:7-10` — то же после `` `tts-qwen` (Qwen3-TTS проекта `digital_me`) ``: `` `tts` (F5-TTS, общий TTS для `music` и `digital_me`) ``. Число слотов словами **не писать** — это ловит `test_facts`.

`CURRENT-STATE.md`, таблица «Что стоит в слотах» — строка после `tts-qwen`:

```markdown
| `tts` | `f5-tts:local` (собран на gpu-host из `music/station/tts-f5/`, база `vllm/vllm-openai:v0.27.1`) | ESpeech-TTS-1 RL-V2 (F5-TTS, fp16 safetensors) + Vocos + RUAccent; данные bind-томами с `<gpu-ssd>\LLM\docker\f5-tts` |
```

- [ ] **Step 4: Блок фактов и тесты пульта**

```bash
L=c:/AI/projects/llm_routers
cd $L && "$PY" gpu-ctl/facts.py --write
cd $L/gpu-ctl && "$PY" -m pytest -q
powershell.exe -NoProfile -Command "Invoke-Pester C:\AI\projects\llm_routers\gpu-ctl\tests\ -Output Detailed" | tail -15
```

Expected: `facts.py` — «блок фактов обновлён», в таблице параметров строка `tts` и «Слотов в декларации: 8»; pytest зелёный (`test_slots_compose_contract`: порт 4126, `mem_limit "3g" == "3g"`, `restart "no"`, `pull_policy never`); Pester зелёный, `Config.Tests` прогоняет `Test-SlotConfig` по новому `slots.json`. Если Pester краснеет на тесте, который перебирает все слоты, — это находка для чтения, а не для подгонки: прочитать тест, понять, чего он требует от нового слота, и привести **декларацию** в соответствие; менять тест — только если он зашил старый состав слотов поимённо.

- [ ] **Step 5: Коммит в llm_routers**

Файл сообщения `$S/msg-slot.txt` (где `$S` — скретчпад сессии):

```
gpu-ctl: слот tts — F5-TTS, общий TTS gpu-host вместо Chatterbox

Замена Chatterbox на F5-TTS (ESpeech-TTS-1 RL-V2) по спеке music
2026-09-23-tts-f5-migration-design. Слот заводится в on-demand с
excludes: [chatterbox] — как tts-qwen: пока F5 под арендой, пульт держит
Chatterbox погашенным и возвращает его после. Резидентом tts станет в том же
деплое, что и переключение эфира (этап 3), а chatterbox тогда уйдёт в on-demand.

vram_gb 3.0 и cold_start_sec 90 — временные и завышенные: проба 22.09 убита на
первом куске, замер будет в окне приёмки. mem_limit 3g обязателен: 22.09
контейнер без лимита выбил оперативку ВМ Docker, и ядро убило chatterbox.

Данные службы — bind-томами с <gpu-ssd>\LLM\docker\f5-tts (раскладка владельца
«каталог на службу»), compose — здесь, как у остальных слотов.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

```bash
git -C $L add gpu-ctl/slots.json gpu-ctl/deploy/compose/tts.yaml gpu-ctl/CURRENT-STATE.md \
    gpu-ctl/README.md gpu-ctl/CLAUDE.md
git -C $L diff --cached --stat
git -C $L commit -F "$S/msg-slot.txt"
```

Expected: в `--stat` только эти пять файлов.

- [ ] **Step 6: Предупредить сессию llm_routers**

Обещано ей 2026-09-22. Сначала `ListAgents`; если в списке есть сессия проекта `llm_routers` — `SendMessage`:

```
Перед выкаткой слота tts в gpu-ctl: декларация закоммичена, через минуту deploy.ps1 -Ssh.

Что меняется: новый блок tts (on-demand, priority 20, vram_gb 3.0, cold_start 90, excludes [chatterbox], port 4126, mem_limit 3g) и compose/tts.yaml. Живые слоты не трогаю, tts не поднимаю. Если аудит нашёл что-то в логике excludes, аренды или возврата резидентов — напиши сейчас, подожду.
```

Ждать ответа до 10 минут; если сессии нет или ответа нет — продолжать.

- [ ] **Step 7: Выкатка и проверка**

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "C:\AI\projects\llm_routers\gpu-ctl\deploy\deploy.ps1" -Ssh
```

Затем:

```bash
V="c:/AI/projects/_boss/secrets/vault.env"; T=$(grep -m1 '^GPU_CTL_TOKEN=' "$V" | cut -d= -f2- | tr -d '\r')
curl -s --max-time 15 -H "X-Token: $T" http://<gpu-host>:8119/state | "$PY" -c "
import json, sys
d = json.load(sys.stdin)
for s in d['slots']:
    if s['Name'] in ('tts', 'chatterbox'):
        print(s['Name'], s['Class'], 'Loaded=', s['Loaded'], 'VramMb=', s['VramMb'])"
curl -s --max-time 10 -w " <- мостик %{http_code}\n" http://<gpu-host>:4124/health
```

Expected: `deploy.ps1` без исключения, SHA256 совпали; `tts on-demand Loaded= False VramMb= 3072`; `chatterbox resident Loaded= True`; мостик `{"ok": true} <- мостик 200`. Через 5 минут ещё раз `/state`: `tts` по-прежнему `Loaded=False` — пульт его сам не поднимает.

Перезапускать шим OllamaGate не нужно: `deploy.ps1` его не трогает, но из
`slots.json` он берёт только слот с `up: ollama-load` (`gate/ollama_gate.py:62-77`),
и `tts` его не касается.

**Передать в план 2** (находка аудита llm_routers 2026-09-23, P3): если после
гашения `chatterbox` места на карте всё же нет, пульт отвечает `503 no_capacity` и
**не включает** `up_backoff` (`gpu-ctl.ps1:655`, `:677`). Каждый повтор
`ensure-up tts` снова гасит Chatterbox и ждёт 60 с — эфир дёргается. Поэтому
`vram_gb` пишется по замеру с запасом, а в окне приёмки проверяется один отказной
сценарий.

---

### Task 12: Поправки спеки и итог

**Files:**
- Modify: `docs/superpowers/specs/2026-09-23-tts-f5-migration-design.md`

**Interfaces:**
- Consumes: итоги задач 1–11.

- [ ] **Step 1: Поправки, возникшие при составлении и исполнении плана**

1. §5 «Размещение», абзац про образ: «Зависимости — из wheelhouse, скачанного на хосте» → «Зависимости ставит pip в самой сборке, с кэшем и пятью попытками: `pip download` на хосте тянул бы транзитивно torch и CUDA-библиотеки с PyPI (гигабайты), а в сборке базовые версии прибиты констрейнтом».
2. §5, дерево каталогов: `models\ruaccent\` → отдельный `ruaccent\`, монтируется на запись (RUAccent при загрузке может писать служебные файлы в свой каталог).
3. §4 «Нарезка»: «Куски режет штатный `utils_infer.chunk_text`» → «Куски режет алгоритм `chunk_text` из f5-tts 1.1.22, перенесённый в `f5_text.py` (совпадение сверяет тест на ответах настоящей функции); пробел ставится после каждого куска, кроме китайской пунктуации, — иначе дорезанные по словам куски слипались бы».
4. §4 «`/clone` и биометрия», п. 1: `soundfile.read` → stdlib `wave` (PCM 16/24/32 бит; float-WAV — тоже 415). Дописать пункт про Starlette: загрузка больше 1 МиБ сбрасывается во временный файл; порог `MultiPartParser.spool_max_size` поднят до 10 МиБ.
5. §4 «Память»: «fp16 на CUDA задаётся явно» → «fp16 выбирает сам `load_checkpoint` (`load_model` не принимает dtype); служба проверяет его при старте и не стартует, если модель на CUDA не в fp16».
6. §7, этап 0: копия `bridge.py` переносится в этап 3 (план 2) — снимать её надо в момент переключения, иначе можно унести устаревшую версию.
7. Если задача 10 закончилась OOM контейнера на процессоре или стоп-условием выбора базы — записать это в §10 «Риски» с цифрами.
8. Шапка: «Статус: черновик на утверждение владельцу» → «Статус: утверждена владельцем 2026-09-23; этапы 0–1 — план 1».

- [ ] **Step 2: Быстрый набор music целиком**

Run: `cd $M && "$PY" -m pytest -q --durations=10`
Expected: всё зелёное; суммарное время не выросло больше чем на пару секунд.

- [ ] **Step 3: Коммит и пуш обоих репозиториев**

```bash
git -C $M add docs/superpowers/specs/2026-09-23-tts-f5-migration-design.md
git -C $M commit -m "Спека миграции TTS: поправки по итогам плана 1"
git -C $M push origin main
git -C c:/AI/projects/llm_routers push origin main
```

Expected: оба пуша — fast-forward без конфликтов.
