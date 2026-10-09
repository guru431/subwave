"""Синтез по запросу: голос, ударения, нарезка, очередь, склейка, громкость.

Ручки эфира (speak) нормализуют громкость до −17 dBFS с потолком пика; /clone
(digital_me) отдаёт родную громкость модели — её выставляет сам tts.py
(−20 dBFS, PEAK_CEILING 32000), а срезанный здесь пик он бы уже не вернул.
"""
import functools
import re
import time
from dataclasses import dataclass, field

import f5_audio
import f5_numbers
import f5_text
from f5_voices import resolve, voice_from_audio
from f5_worker import BROADCAST, CLONE, QueueTimeout

MAX_TEXT_CHARS = 20000


def before_accent(text: str, log=print) -> str:
    """Текст до RUAccent: латиница из PRONUNCIATION и числа — словами (числительному
    тоже нужны ударения). Имена словаря коллекции с цифрами числа не трогают — их
    после RUAccent заменит cyrillize. Тем же путём реплику размечает
    tools/stress_audit.py."""
    text = f5_text.respell(text)
    _, names = f5_text.DICTIONARY.current()
    # ключи словаря — латиница: без неё искать нечего, а регулярка на тысячи имён дорогая
    keep = names if re.search(r"[A-Za-z]", text) else None
    try:
        return f5_numbers.normalize(text, keep=keep)
    except Exception as e:                 # noqa: BLE001 — реплика важнее чисел
        # 500 здесь — потерянная реплика: подмена движка запрещена (C05)
        log(f"numbers failed, text left as is: {type(e).__name__}: {e}")
        return text


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
        wave, chunks, wait = self._run(voice, marked, BROADCAST, t0, lead_ms=100)
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
        # без вступительной тишины: секунды HeyGen у digital_me платные
        wave, chunks, wait = self._run(voice, marked, CLONE, t0, lead_ms=0)
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
        marked = f5_text.cyrillize(self.accentizer.apply(before_accent(text.strip(), self.log)))
        if not marked.strip():
            # иначе нарезка не даёт ни куска, и ответ 200 несёт WAV без отсчётов
            raise ServiceError(400, "после разметки ударений от текста ничего не осталось")
        return marked

    def _run(self, voice, text, priority, t0, lead_ms):
        pieces = f5_text.pieces(text, voice.max_chars)
        started = []

        def job(piece, first):
            if first:
                started.append(self.clock())
            return self.engine.synth(voice.samples, voice.sr, voice.ref_text, piece)

        fns = [functools.partial(job, p, i == 0) for i, (p, _) in enumerate(pieces)]
        try:
            waves = self.worker.run_all(fns, priority, self.queue_wait)
        except QueueTimeout as e:
            raise ServiceError(503, str(e)) from None
        except Exception as e:                 # noqa: BLE001 — наружу текст, не traceback
            raise ServiceError(500, f"синтез не удался: {e}") from None
        # края каждого куска — по порогу −45 dB с запасом 30 мс: пауза между кусками
        # должна быть той, что задана знаком, а не суммой случайных хвостов F5
        cut = [f5_audio.trim_edges(w, f5_audio.SR, -45.0, keep_ms=30) for w in waves]
        wave = f5_audio.join_with_pauses(cut, [ms for _, ms in pieces], lead_ms=lead_ms)
        wave = f5_audio.trim_tail(wave, f5_audio.SR)
        return wave, len(pieces), (started[0] - t0) if started else 0.0

    def _journal(self, kind, voice, text, chunks, wave, wait, t0, reason):
        """Строка на запрос: у Chatterbox журнал обрывался, и суточный объём так и
        не удалось посчитать."""
        total = self.clock() - t0
        line = (f"{kind} voice={voice} chars={len(text)} chunks={chunks} "
                f"audio_s={len(wave) / f5_audio.SR:.1f} synth_s={total - wait:.1f} "
                f"wait_s={wait:.1f}")
        self.log(line + (f" fell_back={reason}" if reason else ""))
