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

# без них пропускается этот файл, а не весь набор; numpy нужен f5_service (f5_audio)
pytest.importorskip("numpy")
MultiPartParser = pytest.importorskip("starlette.formparsers").MultiPartParser
F5_DIR = Path(__file__).resolve().parent.parent / "tts-f5"
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
        self.middleware = []

    def add_middleware(self, cls, **kw):
        self.middleware.append((cls, kw))

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


def _through_limit(server, headers, chunks):
    """Прогнать запрос через BodyLimit: (что ушло клиенту, сколько прочла ручка)."""
    import asyncio

    sent, read = [], []

    async def inner(scope, receive, send):
        while True:
            message = await receive()
            read.append(len(message["body"]))
            if not message.get("more_body"):
                break
        await send({"type": "http.response.start", "status": 200, "headers": []})

    async def receive():
        body = chunks.pop(0)
        return {"type": "http.request", "body": body, "more_body": bool(chunks)}

    async def send(message):
        sent.append(message)

    scope = {"type": "http", "headers": headers}
    asyncio.run(server.BodyLimit(inner, server.MAX_BODY_BYTES)(scope, receive, send))
    return sent, read


def test_body_limit_is_registered(server):
    assert (server.BodyLimit, {"limit": server.MAX_BODY_BYTES}) in server.app.middleware
    assert server.MAX_BODY_BYTES > server.MAX_REF_BYTES      # эталон на пределе проходит


def test_declared_oversized_body_is_413_before_reading(server):
    length = str(server.MAX_BODY_BYTES + 1).encode()
    sent, read = _through_limit(server, [(b"content-length", length)], [b"x"])
    assert sent[0]["status"] == 413 and read == []


def test_chunked_oversized_body_stops_at_the_limit(server):
    # без Content-Length размер известен только по мере чтения
    piece = b"x" * 2 ** 20
    chunks = [piece] * (server.MAX_BODY_BYTES // len(piece) + 5)
    with pytest.raises(FakeHTTPException) as e:
        _through_limit(server, [], chunks)
    assert e.value.status_code == 413
    assert len(chunks) >= 3                  # хвост тела так и не прочитан


def test_body_within_the_limit_passes(server):
    sent, read = _through_limit(server, [(b"content-length", b"4")], [b"RIFF"])
    assert sent[0]["status"] == 200 and read == [4]


def test_reference_upload_stays_in_memory(server):
    """Starlette сбрасывает загрузку больше 1 МиБ во временный файл; эталон
    владельца — биометрия, и 10 с стерео 48 кГц это уже 1.9 МиБ. Порог — не
    ниже потолка тела: эталон чуть больше MAX_REF_BYTES отвергается ручкой
    уже после разбора формы, и на диск не должен попасть и он."""
    assert MultiPartParser.spool_max_size >= server.MAX_BODY_BYTES


def test_default_model_config_is_v1(server, monkeypatch):
    """ESpeech-TTS-1 обучен на F5TTS_v1_Base. Конфиг F5TTS_Base с теми же размерами
    сети грузит его веса без ошибок, но из-за text_mask_padding и pe_attn_head
    выдаёт шипение вместо речи — так 23.09 эфир 18 минут шёл с хрипами."""
    import f5_accent
    import f5_engine
    import f5_voices
    import numpy as np

    class NoAccent:
        def __init__(self, workdir, log=print):
            pass

        def load(self):
            pass

    loaded = {}

    def fake_load(model_name, ckpt, vocab, vocos_dir, device="cuda"):
        loaded["model"] = model_name
        return types.SimpleNamespace(device="cuda", dtype="torch.float16", vram=dict)

    voice = f5_voices.Voice("ru-host", np.zeros(24000, np.float32), 24000, "Эталон. ", 100)
    monkeypatch.setattr(f5_accent, "Accentizer", NoAccent)
    monkeypatch.setattr(f5_voices, "load_voices", lambda directory: {"ru-host": voice})
    monkeypatch.setattr(f5_engine.Engine, "load", staticmethod(fake_load))
    for name in ("F5_MODEL", "F5_ENGINE", "F5_DEFAULT_VOICE"):
        monkeypatch.delenv(name, raising=False)
    server.build_service()
    assert loaded["model"] == "F5TTS_v1_Base"
