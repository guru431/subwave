"""f5_service: запрос целиком — голос, ударения, нарезка, очередь, громкость.

Ручки эфира выравнивают громкость (F5 на ~12 dB тише Chatterbox), /clone — нет:
громкость digital_me выставляет сам tts.py, и срезанный здесь пик он не вернул бы.
"""
import sys
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")      # без него пропускается этот файл, а не весь набор
pytest.importorskip("num2words")       # f5_service → f5_numbers
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
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


def test_fallback_headers_survive_a_real_response(voices):
    """Starlette кодирует заголовки в latin-1: имя из чужой раскладки давало 500 уже
    после синтеза, а мостик повторял 5xx ещё дважды — и эфир молчал."""
    from starlette.responses import Response
    r = make(voices).speak("Привет.", "кг-кфше")
    assert r.headers["X-TTS-Voice-Used"] == "ru-host" and r.headers["X-TTS-Fell-Back"] == "1"
    Response(r.wav, media_type="audio/wav", headers=r.headers)


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


def test_clone_rejects_zero_sample_rate_with_415(voices):
    data = bytearray(ref_wav())
    data[24:28] = (0).to_bytes(4, "little")      # nSamplesPerSec
    with pytest.raises(S.ServiceError) as e:
        make(voices).clone("Привет.", "Эталон", bytes(data))
    assert e.value.status == 415


def test_clone_accepts_a_truncated_reference(voices):
    """Эталон, оборванный посреди отсчёта, — это эталон без последнего кадра, а не 500."""
    assert make(voices).clone("Привет.", "Эталон", ref_wav()[:-1]).wav[:4] == b"RIFF"


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


class EmptyAccent:
    def apply(self, text):
        return " "                      # RUAccent сняла всё, что было в тексте


def test_text_empty_after_accent_is_400(voices):
    """Из текста, от которого после разметки ничего не осталось, служба собрала бы
    WAV без единого отсчёта и ответила 200."""
    svc = S.Service(FakeEngine(), voices, "ru-host", EmptyAccent(), W.Worker(),
                    queue_wait=1.0, log=lambda *_: None)
    with pytest.raises(S.ServiceError) as e:
        svc.speak("́")
    assert e.value.status == 400


def test_accent_is_applied_before_synthesis(voices):
    eng = FakeEngine()
    make(voices, eng).speak("Старый замок.")
    assert eng.calls[0][3] == "Старый з+амок."


def test_latin_is_respelled_before_synthesis(voices):
    eng = FakeEngine()
    make(voices, eng).speak("Это AI радио.")
    assert eng.calls[0][3] == "Это эй ай радио."


class SpyAccent(FakeAccent):
    def __init__(self):
        self.seen = []

    def apply(self, text):
        self.seen.append(text)
        return super().apply(text)


def test_numbers_are_spelled_before_the_accent(voices):
    """Годы и проценты доходили до F5 цифрами: числительных в цепочке не было. Слова
    нужны до RUAccent — иначе числительное осталось бы без ударений."""
    accent, eng = SpyAccent(), FakeEngine()
    S.Service(eng, voices, "ru-host", accent, W.Worker(), queue_wait=1.0,
              log=lambda *_: None).speak("В 1969 году дождь шёл с вероятностью 80%.")
    assert accent.seen == ["В тысяча девятьсот шестьдесят девятом году дождь шёл "
                           "с вероятностью восемьдесят процентов."]
    assert not any(ch.isdigit() for call in eng.calls for ch in call[3])


class StrictAccent(FakeAccent):
    """Как настоящая: текст, где «+» уже стоят, не размечается вовсе."""

    def apply(self, text):
        return text if "+" in text else super().apply(text)


def test_numbers_failure_keeps_the_line(voices, monkeypatch):
    """Сбой нормализации чисел давал 500, а подмена движка запрещена (C05): реплика
    пропадала. Лучше цифры в эфире, чем тишина."""
    import f5_numbers

    def broken(text, keep=None):
        raise ValueError("сломалось")

    monkeypatch.setattr(f5_numbers, "normalize", broken)
    logs, eng = [], FakeEngine()
    r = S.Service(eng, voices, "ru-host", FakeAccent(), W.Worker(), queue_wait=1.0,
                  log=logs.append).speak("В 1969 году.")
    assert r.wav[:4] == b"RIFF" and eng.calls[0][3] == "В 1969 году."
    assert any("numbers failed" in line and "сломалось" in line for line in logs)


def test_plus_between_numbers_does_not_switch_the_accent_off(voices):
    """«1+1» становилось «один+один», а «+о» RUAccent принимает за ручное ударение и
    оставляет без разметки всю реплику."""
    eng = FakeEngine()
    S.Service(eng, voices, "ru-host", StrictAccent(), W.Worker(), queue_wait=1.0,
              log=lambda *_: None).speak("Старый замок, а 1+1 и 2 + 2 всё ещё 4.")
    assert " ".join(c[3] for c in eng.calls) == \
        "Старый з+амок, а один плюс один и два плюс два всё ещё четыре."


def test_collection_dictionary_goes_after_the_accent(voices, monkeypatch, tmp_path):
    # «+» словаря, попади он к RUAccent раньше, оставил бы без ударений всю реплику
    import json

    import f5_text
    path = tmp_path / "pronunciation.json"
    path.write_text(json.dumps({"words": {}, "phrases": {"dire straits": "Д+айр Стр+ейтс"}},
                               ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(f5_text, "DICTIONARY", f5_text.Dictionary(path, fallback=path))
    eng = FakeEngine()
    S.Service(eng, voices, "ru-host", StrictAccent(), W.Worker(), queue_wait=1.0,
              log=lambda *_: None).speak("Старый замок и Dire Straits.")
    assert eng.calls[0][3] == "Старый з+амок и Д+айр Стр+ейтс."


def test_every_dictionary_key_with_digits_survives_the_numbers(monkeypatch):
    """Числа читаются до словаря коллекции, а «рядом латиница» смотрит на одно соседнее
    слово: «Links 2 3 4» становилось «Линкс 2 три четыре», «Song #1» — «Song #один», и
    ключ словаря больше не совпадал. Фрагмент, который словарь узнаёт, числа не трогают."""
    import f5_text
    shipped = f5_text.Dictionary(f5_text.DICTIONARY_FILE, fallback=f5_text.DICTIONARY_FILE)
    monkeypatch.setattr(f5_text, "DICTIONARY", shipped)
    words, _ = shipped.current()
    keys = [k for k in words if any(ch.isdigit() for ch in k)]
    assert len(keys) > 50
    broken = [k for k in keys
              if f5_text.cyrillize(S.before_accent(f"Сейчас прозвучит {k}.")) !=
              f"Сейчас прозвучит {words[k]}."]
    assert broken == []


def test_sentences_are_synthesized_apart_with_a_pause(voices):
    eng = FakeEngine()
    x, sr = A.decode_wav(make(voices, eng).speak("Первая фраза тут. Вторая фраза там.").wav)
    assert [c[3] for c in eng.calls] == ["Первая фраза тут.", "Вторая фраза там."]
    quiet = np.abs(x) < 1e-4
    runs, run = [], 0
    for q in quiet:
        run = run + 1 if q else 0
        runs.append(run)
    assert max(runs) / sr >= 0.44            # пауза после первой фразы — 450 мс


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
