"""bridge.py: аренда слота GPU берётся перед синтезом и не ломает работу.

Карта на gpu-host одна на шесть слотов, и слот без аренды пульт вправе погасить
в любой момент — в том числе на середине фразы (находка _boss 2026-08-25).
Мостик берёт слот сам, как это делает шим ollama-gate.
"""
import importlib.util
import sys
import threading
import urllib.error
from pathlib import Path

import pytest

BRIDGE = Path(__file__).resolve().parent.parent / "tts-bridge" / "bridge.py"
_spec = importlib.util.spec_from_file_location("tts_bridge", BRIDGE)
bridge = importlib.util.module_from_spec(_spec)
sys.modules["tts_bridge"] = bridge
_spec.loader.exec_module(bridge)


def _load_prep_voice():
    path = Path(__file__).resolve().parent.parent / "tts-bridge" / "prep_voice.py"
    spec = importlib.util.spec_from_file_location("tts_prep_voice", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def calls(monkeypatch):
    seen = []

    def fake_urlopen(req, timeout=None):
        seen.append({"url": req.full_url, "method": req.get_method(),
                     "headers": dict(req.header_items())})
        raise urllib.error.URLError("не ходим в сеть из теста")

    monkeypatch.setattr(bridge.urllib.request, "urlopen", fake_urlopen)
    return seen


def test_lease_asks_controller_for_the_slot(monkeypatch, calls):
    monkeypatch.setattr(bridge, "GPU_CTL_URL", "http://10.0.0.5:8119")
    monkeypatch.setattr(bridge, "GPU_CTL_TOKEN", "secret")
    monkeypatch.setattr(bridge, "GPU_CTL_SLOT", "chatterbox")
    bridge.lease_slot()
    assert len(calls) == 1
    assert calls[0]["url"] == "http://10.0.0.5:8119/ensure-up?slot=chatterbox"
    assert calls[0]["method"] == "POST"
    assert calls[0]["headers"].get("X-token") == "secret"


def test_no_controller_configured_means_no_call(monkeypatch, calls):
    """Пульт не задан — мостик работает как раньше, без обращений наружу."""
    monkeypatch.setattr(bridge, "GPU_CTL_URL", "")
    bridge.lease_slot()
    assert calls == []


def test_unreachable_controller_does_not_break_synthesis(monkeypatch, calls):
    """Fail-open: молчащий TTS хуже, чем TTS без аренды."""
    monkeypatch.setattr(bridge, "GPU_CTL_URL", "http://10.0.0.5:8119")
    bridge.lease_slot()   # urlopen бросает URLError — исключение наружу не идёт
    assert len(calls) == 1


def test_payload_refuses_json_of_the_wrong_shape():
    # `[]` проходит json.loads и падал на req.get уже после аренды GPU
    assert bridge.speak_payload([])[0] is None
    assert bridge.speak_payload("строка")[0] is None
    assert bridge.speak_payload({})[0] is None
    assert bridge.speak_payload({"text": "   "})[0] is None
    assert bridge.speak_payload({"text": 5})[0] is None
    # числовой voice падал на .strip()
    assert bridge.speak_payload({"text": "привет", "voice": 7})[0] is None


def test_payload_passes_valid_request():
    payload, problem = bridge.speak_payload({"text": "привет", "voice": " dmitri "})
    assert problem is None and payload == {"input": "привет", "voice": "dmitri"}
    payload, _ = bridge.speak_payload({"text": "привет", "voice": ""})
    assert payload == {"input": "привет"}     # пустой голос = голос сервера


class _FakeHandler(bridge.Handler):
    """Обработчик без сокета: тело из BytesIO, ответ — в список."""

    def __init__(self, body: bytes, headers: dict | None = None):
        import io
        self.rfile = io.BytesIO(body)
        self.headers = {"Content-Length": str(len(body)), **(headers or {})}
        self.path = "/speak"
        self.sent = []

    def _send(self, code, body, ctype, close=False, headers=None):
        self.sent.append((code, body, close, headers or {}))


def test_bad_request_answers_400_without_touching_gpu(monkeypatch):
    leased = []
    monkeypatch.setattr(bridge, "lease_slot", lambda: leased.append(1))
    handler = _FakeHandler(b"[]")
    handler.do_POST()
    assert handler.sent[0][0] == 400 and leased == []


def test_oversized_body_answers_413_without_reading_it(monkeypatch):
    monkeypatch.setattr(bridge, "MAX_BODY_BYTES", 10)
    leased = []
    monkeypatch.setattr(bridge, "lease_slot", lambda: leased.append(1))
    handler = _FakeHandler(b'{"text":"' + b"a" * 100 + b'"}')
    handler.do_POST()
    assert handler.sent[0][0] == 413 and leased == []


def test_refusal_before_reading_the_body_closes_the_connection(monkeypatch):
    # непрочитанное тело на keep-alive-соединении разбирается как строка
    # следующего запроса: subwave получал каскад ложных 400/404 после одного
    # отвергнутого запроса
    monkeypatch.setattr(bridge, "MAX_BODY_BYTES", 10)
    monkeypatch.setattr(bridge, "lease_slot", lambda: None)
    oversized = _FakeHandler(b'{"text":"' + b"a" * 100 + b'"}')
    oversized.do_POST()
    assert oversized.sent[0][0] == 413 and oversized.sent[0][2] is True

    bad_length = _FakeHandler(b'{"text":"a"}', {"Content-Length": "многовато"})
    bad_length.do_POST()
    assert bad_length.sent[0][0] == 400 and bad_length.sent[0][2] is True

    unknown = _FakeHandler(b'{"text":"a"}')
    unknown.path = "/synthesize"
    unknown.do_POST()
    assert unknown.sent[0][0] == 404 and unknown.sent[0][2] is True

    # тело прочитано целиком — соединение переиспользуется как обычно
    bad_json = _FakeHandler(b"[]")
    bad_json.do_POST()
    assert bad_json.sent[0][0] == 400 and bad_json.sent[0][2] is False


def test_negative_content_length_is_refused(monkeypatch):
    # read(-1) читал бы до EOF и держал обработчик до READ_TIMEOUT (30 с)
    leased = []
    monkeypatch.setattr(bridge, "lease_slot", lambda: leased.append(1))
    handler = _FakeHandler(b'{"text":"a"}', {"Content-Length": "-1"})
    handler.do_POST()
    assert handler.sent[0][0] == 400 and handler.sent[0][2] is True
    assert leased == []


# ── повтор срыва генерации ───────────────────────────────────────────────────
#
# Chatterbox срывается на части запросов независимо от текста. Слушателю это
# видно не как ошибка, а как смена голоса: subwave откатывается на piper и
# озвучивает фразу запасным движком.
#
# Срывы зависят от темпа и идут пачками — замер 2026-09-22 на одной и той же
# фразе: запросы подряд дали 20% отказов с чередой до трёх, а с паузой 6 с —
# 0 из 15. Поэтому лечит не сам повтор, а повтор с паузой: мгновенный попадает
# в ту же пачку и бесполезен (проверено на живом сервисе).


def _upstream(monkeypatch, answers, headers=None):
    """Подменяет upstream списком исходов: HTTPError(код) либо байты аудио.
    headers — заголовки удачного ответа сверх Content-Type."""
    import io
    seen = []
    reply_headers = {"Content-Type": "audio/wav", **(headers or {})}

    def fake_urlopen(req, timeout=None):
        if "audio/speech" not in req.full_url:
            raise urllib.error.URLError("не аренда — тест про синтез")
        outcome = answers[min(len(seen), len(answers) - 1)]
        seen.append(req.full_url)
        if isinstance(outcome, int):
            raise urllib.error.HTTPError(
                req.full_url, outcome, "err", {},
                io.BytesIO(b'{"error":"TTS generation failed"}'))

        class _Resp:
            headers = reply_headers
            def read(self): return outcome
            def __enter__(self): return self
            def __exit__(self, *a): return False
        return _Resp()

    monkeypatch.setattr(bridge.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(bridge, "lease_slot", lambda: None)
    return seen


def test_generation_failure_is_retried(monkeypatch):
    seen = _upstream(monkeypatch, [500, b"WAV"])
    monkeypatch.setattr(bridge, "RETRIES", 2)
    monkeypatch.setattr(bridge.time, "sleep", lambda s: None)
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 200 and handler.sent[0][1] == b"WAV"
    assert len(seen) == 2          # первый сорвался, второй отдал звук


def test_retry_waits_before_trying_again(monkeypatch):
    # срывы идут пачками: замер 2026-09-22 дал 20% отказов при запросах подряд
    # и 0 из 15 с паузой 6 с. Повтор без паузы попадает в ту же пачку, поэтому
    # пауза — не вежливость к серверу, а единственное, что делает повтор рабочим
    slept = []
    _upstream(monkeypatch, [500, b"WAV"])
    monkeypatch.setattr(bridge, "RETRIES", 2)
    monkeypatch.setattr(bridge, "RETRY_DELAY", 5)
    monkeypatch.setattr(bridge.time, "sleep", lambda s: slept.append(s))
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert slept == [5]            # ровно одна пауза — перед единственным повтором


def test_successful_call_does_not_wait(monkeypatch):
    slept = []
    _upstream(monkeypatch, [b"WAV"])
    monkeypatch.setattr(bridge, "RETRIES", 2)
    monkeypatch.setattr(bridge.time, "sleep", lambda s: slept.append(s))
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 200 and slept == []


def test_client_error_is_not_retried(monkeypatch):
    # 4xx — упрёк в наш адрес: повтор его не исправит, а карту займёт
    seen = _upstream(monkeypatch, [400])
    monkeypatch.setattr(bridge, "RETRIES", 2)
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 502 and len(seen) == 1


def test_retries_are_finite_and_the_failure_surfaces(monkeypatch):
    # бесконечный повтор держал бы слот GPU и вешал реплику вместо отката
    seen = _upstream(monkeypatch, [500])
    monkeypatch.setattr(bridge, "RETRIES", 2)
    monkeypatch.setattr(bridge.time, "sleep", lambda s: None)
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 502
    assert len(seen) == 3          # первая попытка плюс два повтора


def test_retry_renews_the_gpu_lease(monkeypatch):
    # повтор растягивает окно, в которое пульт вправе погасить слот
    leased = []
    _upstream(monkeypatch, [500, b"WAV"])
    monkeypatch.setattr(bridge, "lease_slot", lambda: leased.append(1))
    monkeypatch.setattr(bridge, "RETRIES", 2)
    monkeypatch.setattr(bridge.time, "sleep", lambda s: None)
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert len(leased) == 2


FELL_BACK = {"X-TTS-Voice-Used": "ru-host", "X-TTS-Fell-Back": "1",
             "X-TTS-Fell-Back-Reason": 'unknown voice "ru-rajt"'}


def test_voice_substitution_headers_reach_the_station(monkeypatch):
    # контроллер видит подмену голоса только по X-TTS-Fell-Back (#238, remoteTts.ts);
    # мостик отдавал Content-Type и Content-Length, и предупреждение молчало всегда
    _upstream(monkeypatch, [b"WAV"], {**FELL_BACK, "Server": "uvicorn", "Date": "x"})
    handler = _FakeHandler('{"text":"а","voice":"ru-rajt"}'.encode())
    handler.do_POST()
    code, body, _, headers = handler.sent[0]
    assert code == 200 and body == b"WAV"
    assert headers == FELL_BACK            # только три заголовка голоса, не всё подряд


def test_voice_headers_go_out_on_the_wire():
    import io
    handler = bridge.Handler.__new__(bridge.Handler)
    handler.wfile = io.BytesIO()
    handler.request_version, handler.requestline = "HTTP/1.1", "POST /speak HTTP/1.1"
    handler.command, handler.close_connection = "POST", False
    handler._send(200, b"WAV", "audio/wav", headers=FELL_BACK)
    wire = handler.wfile.getvalue().decode("latin-1")
    assert "\r\nX-TTS-Fell-Back: 1\r\n" in wire
    assert '\r\nX-TTS-Fell-Back-Reason: unknown voice "ru-rajt"\r\n' in wire
    assert wire.endswith("\r\n\r\nWAV")


def test_retries_can_be_switched_off(monkeypatch):
    seen = _upstream(monkeypatch, [500])
    monkeypatch.setattr(bridge, "RETRIES", 0)
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 502 and len(seen) == 1


def test_busy_engine_waits_for_its_turn(monkeypatch):
    # Chatterbox не потокобезопасен: два синтеза разом попадают в общий батч и
    # падают оба, причём с одинаковыми размерами тензоров в ошибке (замер
    # 2026-09-22 — одновременно 1 успех из 6, теми же фразами подряд 6 из 6).
    # Поэтому синтез идёт по одному, а занятый движок значит «подожди», а не
    # «откажи»: на отказ станция меняет движок, и слушатель слышит чужой голос.
    seen = _upstream(monkeypatch, [b"WAV"])
    monkeypatch.setattr(bridge, "_synthesis", threading.BoundedSemaphore(1))
    monkeypatch.setattr(bridge, "QUEUE_WAIT", 5)
    bridge._synthesis.acquire()
    # Проверяется порядок, а не часы: замер «прошло ≥ 0.1 с» от момента после
    # старта таймера под нагрузкой давал 0.0989 и краснел (2026-10-05).
    synth_before_release = []

    def release():
        synth_before_release.append(len(seen))
        bridge._synthesis.release()

    threading.Timer(0.1, release).start()
    handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
    handler.do_POST()
    assert handler.sent[0][0] == 200
    assert synth_before_release == [0]   # дождался очереди, а не проскочил
    assert len(seen) == 1


def test_queue_that_never_clears_answers_503(monkeypatch):
    # ждать без потолка нельзя: запросы копились бы молча, а контроллер всё
    # равно отваливается по своему таймауту в 180 с
    monkeypatch.setattr(bridge, "lease_slot", lambda: None)
    monkeypatch.setattr(bridge, "_synthesis", threading.BoundedSemaphore(1))
    monkeypatch.setattr(bridge, "QUEUE_WAIT", 0.05)
    bridge._synthesis.acquire()
    try:
        handler = _FakeHandler(b'{"text":"\xd0\xb0"}')
        handler.do_POST()
        assert handler.sent[0][0] == 503
    finally:
        bridge._synthesis.release()


# ── аренда слота при неудачном /health ───────────────────────────────────────
#
# Гейт C05 (группа voice) не шлёт /speak, пока /health мостика — 503. А аренду слота
# берёт только /speak: раньше выгнанный пультом слот tts будили именно ошибочные
# /speak, теперь их нет. Поэтому неудачный /health сам просит слот — в фоне.


def _health_upstream(monkeypatch, ok):
    def fake_urlopen(url, timeout=None):
        if not ok:
            raise urllib.error.URLError("F5 выгнан пультом")

        class _Resp:
            status = 200
            def read(self): return b'{"model_loaded": true}'
            def __enter__(self): return self
            def __exit__(self, *a): return False
        return _Resp()

    monkeypatch.setattr(bridge.urllib.request, "urlopen", fake_urlopen)


@pytest.fixture
def health_leases(monkeypatch):
    """Аренды, запущенные /health; пульт задан, окно и замок — свежие."""
    leased = threading.Semaphore(0)
    monkeypatch.setattr(bridge, "GPU_CTL_URL", "http://10.0.0.5:8119")
    monkeypatch.setattr(bridge, "lease_slot", leased.release)
    monkeypatch.setattr(bridge, "_health_lease_lock", threading.Lock())
    monkeypatch.setattr(bridge, "_health_lease_at", None)
    # станция говорила только что: /speak внутри окна HEALTH_LEASE_WINDOW
    monkeypatch.setattr(bridge, "_last_speak_at", bridge.time.monotonic())
    return leased


def _get_health():
    handler = _FakeHandler(b"")
    handler.path = "/health"
    handler.do_GET()
    return handler.sent[0][0]


def test_failed_health_leases_the_slot(monkeypatch, health_leases):
    _health_upstream(monkeypatch, ok=False)
    assert _get_health() == 503
    assert health_leases.acquire(timeout=5)


def test_failed_health_leases_once_per_window(monkeypatch, health_leases):
    monkeypatch.setattr(bridge, "HEALTH_LEASE_EVERY", 60)
    _health_upstream(monkeypatch, ok=False)
    assert _get_health() == 503 and health_leases.acquire(timeout=5)
    first = bridge._health_lease_at
    assert _get_health() == 503
    assert bridge._health_lease_at == first              # повтор внутри окна — без аренды


def test_healthy_upstream_does_not_lease(monkeypatch, health_leases):
    _health_upstream(monkeypatch, ok=True)
    assert _get_health() == 200
    assert bridge._health_lease_at is None


def test_health_lease_needs_the_controller(monkeypatch, health_leases):
    monkeypatch.setattr(bridge, "GPU_CTL_URL", "")
    _health_upstream(monkeypatch, ok=False)
    assert _get_health() == 503
    assert bridge._health_lease_at is None


def test_health_does_not_wait_for_the_lease_and_runs_one_at_a_time(monkeypatch, health_leases):
    # аренда идёт до GPU_CTL_TIMEOUT (90 с): /health её не ждёт, а второй поток при
    # окне 0 не стартует, пока первый не кончился
    monkeypatch.setattr(bridge, "HEALTH_LEASE_EVERY", 0)
    started, release, finished, calls = (threading.Event(), threading.Event(),
                                         threading.Event(), [])

    def slow_lease():
        calls.append(1)
        started.set()
        release.wait(5)
        finished.set()

    monkeypatch.setattr(bridge, "lease_slot", slow_lease)
    _health_upstream(monkeypatch, ok=False)
    try:
        assert _get_health() == 503
        assert started.wait(5) and not finished.is_set()     # ответ ушёл, аренда висит
        assert _get_health() == 503
        assert calls == [1]                                  # второй поток не стартовал
    finally:
        release.set()
        assert finished.wait(5)


def test_failed_thread_start_does_not_jam_the_lease(monkeypatch, health_leases):
    # Thread.start() стоял вне try: при «can't start new thread» замок оставался занят,
    # и аренда из /health молчала до перезапуска мостика
    monkeypatch.setattr(bridge, "HEALTH_LEASE_EVERY", 0)

    class NoThread:
        def __init__(self, *a, **kw):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    real_thread = bridge.threading.Thread
    monkeypatch.setattr(bridge.threading, "Thread", NoThread)
    assert bridge.lease_after_failed_health() is False
    monkeypatch.setattr(bridge.threading, "Thread", real_thread)
    assert bridge.lease_after_failed_health() is True       # тот же замок свободен
    assert health_leases.acquire(timeout=5)


@pytest.mark.parametrize("ago", [None, 1801.0], ids=["never-spoke", "spoke-long-ago"])
def test_health_does_not_lease_when_the_station_is_not_speaking(monkeypatch, health_leases, ago):
    # контроллер спрашивает /health раз в 30 с и ночью без слушателей: аренда из /health
    # будила бы выгнанный слот круглые сутки, хотя говорить станции некому
    monkeypatch.setattr(bridge, "HEALTH_LEASE_WINDOW", 1800)
    monkeypatch.setattr(bridge, "_last_speak_at",
                        None if ago is None else bridge.time.monotonic() - ago)
    _health_upstream(monkeypatch, ok=False)
    assert _get_health() == 503
    assert bridge._health_lease_at is None


def test_speak_opens_the_health_lease_window(monkeypatch, health_leases):
    monkeypatch.setattr(bridge, "_last_speak_at", None)
    _upstream(monkeypatch, [b"WAV"])
    monkeypatch.setattr(bridge, "lease_slot", health_leases.release)     # _upstream его глушит
    _FakeHandler('{"text":"а"}'.encode()).do_POST()
    assert health_leases.acquire(timeout=5)                              # аренда самого /speak
    _health_upstream(monkeypatch, ok=False)
    assert _get_health() == 503
    assert health_leases.acquire(timeout=5)                              # и из /health — тоже


def test_prep_voice_takes_library_url_from_environment(monkeypatch):
    prep = _load_prep_voice()
    monkeypatch.delenv("CHATTERBOX_VOICES_URL", raising=False)
    with pytest.raises(SystemExit):
        prep.library_url()
    monkeypatch.setenv("CHATTERBOX_VOICES_URL", "http://10.0.0.5:4123/voices/")
    assert prep.library_url() == "http://10.0.0.5:4123/voices"


def test_prep_voice_takes_bridge_url_from_environment(monkeypatch):
    prep = _load_prep_voice()
    monkeypatch.delenv("TTS_BRIDGE_URL", raising=False)
    with pytest.raises(SystemExit):
        prep.bridge_url()
    monkeypatch.setenv("TTS_BRIDGE_URL", "http://10.0.0.5:4124/")
    assert prep.bridge_url() == "http://10.0.0.5:4124"
