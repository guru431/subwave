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

# Потолок тела запроса: эталон плюс текстовые поля формы. Starlette разбирает
# форму и JSON целиком до вызова ручки, и без потолка запрос в сотни мегабайт
# лёг бы в память службы раньше, чем сработает проверка MAX_REF_BYTES в /clone.
MAX_BODY_BYTES = MAX_REF_BYTES + 2 ** 20
TOO_LARGE = f"тело запроса больше {MAX_BODY_BYTES // 2 ** 20} МиБ"

# Starlette сбрасывает загружаемый файл больше 1 МиБ во временный файл на диске
# (MultiPartParser.spool_max_size). Эталон владельца digital_me — биометрия, на
# диск gpu-host он попадать не должен, а 10 с стерео 48 кГц — это уже 1.9 МиБ.
# Порог — потолок тела, а не MAX_REF_BYTES: эталон чуть больше предела ручка
# отвергает уже после разбора формы, и до того он тоже лежал бы на диске.
if not hasattr(_formparsers.MultiPartParser, "spool_max_size"):
    raise RuntimeError("у этой версии Starlette нет spool_max_size — эталон ушёл бы на диск")
_formparsers.MultiPartParser.spool_max_size = MAX_BODY_BYTES


class BodyLimit:
    """ASGI-обёртка: 413 на тело больше потолка — до разбора формы и JSON.

    Заявленная длина проверяется сразу, тело без неё (chunked) — по мере
    чтения: лишний кусок обрывает разбор, и дальше служба его не читает.
    """

    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        declared = dict(scope["headers"]).get(b"content-length", b"")
        if declared.isdigit() and int(declared) > self.limit:
            body = TOO_LARGE.encode("utf-8")
            await send({"type": "http.response.start", "status": 413,
                        "headers": [(b"content-type", b"text/plain; charset=utf-8"),
                                    (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        received = 0

        async def counted():
            nonlocal received
            message = await receive()
            received += len(message.get("body", b""))
            if received > self.limit:
                raise HTTPException(413, TOO_LARGE)
            return message

        await self.app(scope, counted, send)


app = FastAPI(title="F5-TTS")
app.add_middleware(BodyLimit, limit=MAX_BODY_BYTES)
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
        # ESpeech-TTS-1 обучен на v1: конфиг F5TTS_Base с теми же размерами сети грузит
        # его веса без ошибок, но выдаёт шипение вместо речи (эфир 23.09).
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
