"""Мостик между Remote-движком subwave и OpenAI-совместимым TTS.

subwave ждёт от «своего» TTS-сервера ровно два эндпоинта (docs/custom-tts.md):

    GET  /health  → {"ok": true}
    POST /speak   → {"text": "...", "voice": "..."} → тело ответа = аудио

Chatterbox TTS API говорит по схеме OpenAI: `POST /v1/audio/speech`. Спека
проекта (§5.5) предполагала подключение «как Cloud engine с провайдером
OpenAI-compatible» — у subwave такого варианта нет, зато есть первоклассный
движок Remote. Мостик переводит одно в другое и ничего больше не делает.

Запуск: UPSTREAM=http://127.0.0.1:4123 python bridge.py  (порт 4124)
Зависимостей нет — только стандартная библиотека.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM = os.environ.get("UPSTREAM", "http://127.0.0.1:4123").rstrip("/")
PORT = int(os.environ.get("PORT", "4124"))
# Chatterbox рендерит фразу на GPU не мгновенно; 30 с subwave ждёт спокойно,
# а короткий таймаут превратил бы каждую длинную реплику в «движок недоступен»
TIMEOUT = float(os.environ.get("TIMEOUT", "180"))

# Пульт GPU на gpu-host (_boss/gpu-ctl, :8119). Карта одна на шесть слотов, и
# слот без аренды пульт вправе погасить в любой момент — в том числе на
# середине синтеза фразы. Запрос к /ensure-up перед синтезом и берёт слот, и
# продлевает аренду, пока идёт диалог. Тот же приём, что у шима ollama-gate.
GPU_CTL_URL = os.environ.get("GPU_CTL_URL", "").rstrip("/")
GPU_CTL_TOKEN = os.environ.get("GPU_CTL_TOKEN", "")
GPU_CTL_SLOT = os.environ.get("GPU_CTL_SLOT", "chatterbox")
GPU_CTL_TIMEOUT = float(os.environ.get("GPU_CTL_TIMEOUT", "90"))
# Аренда и при неудачном /health. Гейт C05 контроллера не шлёт /speak, пока /health
# мостика — 503, а аренду берёт только /speak: выгнанный пультом слот раньше будили
# именно ошибочные /speak. Без этой страховки его поднимал бы только пульт сам.
HEALTH_LEASE_EVERY = float(os.environ.get("HEALTH_LEASE_EVERY", "60"))
# …и только пока станция говорит: /health контроллер спрашивает раз в 30 с и ночью
# без слушателей, и без окна выгнанный слот будился бы круглые сутки. Окно — от
# последнего /speak, как раньше будили только настоящие реплики.
HEALTH_LEASE_WINDOW = float(os.environ.get("HEALTH_LEASE_WINDOW", "1800"))
_health_lease_lock = threading.Lock()     # занят, пока идёт аренда из /health
_health_lease_at = None                   # time.monotonic() последней такой аренды
_last_speak_at = None                     # time.monotonic() последнего /speak

# Реплика ведущего — это килобайты текста; всё, что больше, к синтезу отношения
# не имеет, а читать его в память по чужой команде мостик не обязан
MAX_BODY_BYTES = int(os.environ.get("MAX_BODY_BYTES", str(64 * 1024)))
# оборванное соединение без таймаута оставляет обработчик висеть навсегда,
# а ThreadingHTTPServer копит такие потоки
READ_TIMEOUT = float(os.environ.get("READ_TIMEOUT", "30"))
# Синтез строго по одному. Chatterbox не потокобезопасен: два запроса разом
# попадают в общий батч, и оба падают с `stack expects each tensor to be equal
# size` либо `expected Tensor … got NoneType`. Замер 2026-09-22 на одной паре
# фраз — одновременно 1 успех из 6, теми же фразами подряд 6 из 6.
#
# Раньше здесь стояло 2 «потому что карта одна», и это был неверный вывод:
# ограничение защищало память, а не состояние модели.
MAX_CONCURRENT = int(os.environ.get("MAX_CONCURRENT", "1"))
_synthesis = threading.BoundedSemaphore(MAX_CONCURRENT)
# Занятый движок — повод подождать, а не отказать: станция на отказ отвечает
# сменой движка, и слушатель слышит чужой голос из-за очереди длиной один.
# Потолок — 60 с: контроллер ждёт ответа 180 с (`REQUEST_TIMEOUT_MS`), а на
# синтез с повторами уходит до ~130 с, так что ожидание дольше минуты клиент
# всё равно не дослушает.
QUEUE_WAIT = float(os.environ.get("QUEUE_WAIT", "60"))

# Chatterbox срывается на части запросов с ошибкой генерации
# (`expected Tensor … got NoneType`, `stack expects each tensor to be equal size`).
# От текста это не зависит: та же фраза, упавшая минуту назад, проходит при
# повторе. Зависит от ТЕМПА, и срывы идут пачками — замер 2026-09-22 на
# одинаковой фразе: подряд 20% отказов и череда до трёх подряд, с паузой 6 с
# между запросами — 0 из 15.
#
# Отсюда пауза между попытками: повтор без неё попадает в ту же пачку и
# бесполезен (проверено — 2 из 24 фраз не пережили трёх мгновенных попыток).
# Цена ожидания ниже цены отказа: без ретрая subwave откатывается на piper, и
# слушателю это слышно как смена голоса посреди эфира.
RETRIES = int(os.environ.get("RETRIES", "2"))
RETRY_DELAY = float(os.environ.get("RETRY_DELAY", "5"))

# Заголовки голоса из контракта Remote subwave (remoteTts.ts): по X-TTS-Fell-Back
# контроллер пишет в журнал, что голос персоны подменён голосом по умолчанию (#238).
# Белым списком, а не переливом: прочие заголовки upstream станции не нужны.
VOICE_HEADERS = ("X-TTS-Voice-Used", "X-TTS-Fell-Back", "X-TTS-Fell-Back-Reason")


def speak_payload(req) -> tuple[dict | None, str | None]:
    """Тело запроса → тело для upstream либо причина отказа.

    Валидный JSON ещё не валидный запрос: `[]` проходит парсер и падает на
    `req.get`, числовой `voice` — на `.strip()`. Проверка идёт до аренды GPU,
    чтобы мусорный запрос не будил карту.
    """
    if not isinstance(req, dict):
        return None, "тело должно быть объектом JSON"
    text = req.get("text")
    if not isinstance(text, str) or not text.strip():
        return None, "поле text обязательно и должно быть непустой строкой"
    voice = req.get("voice") or ""
    if not isinstance(voice, str):
        return None, "поле voice должно быть строкой"
    payload = {"input": text}
    if voice.strip():                 # пустая строка = голос по умолчанию сервера
        payload["voice"] = voice.strip()
    return payload, None


def lease_slot() -> None:
    """Взять/продлить аренду слота. Тихо не мешает работе, если пульт не задан
    или недоступен: TTS, который молчит из-за пульта, хуже TTS без аренды."""
    if not GPU_CTL_URL:
        return
    req = urllib.request.Request(
        f"{GPU_CTL_URL}/ensure-up?slot={GPU_CTL_SLOT}", data=b"", method="POST",
        headers={"X-Token": GPU_CTL_TOKEN} if GPU_CTL_TOKEN else {})
    try:
        with urllib.request.urlopen(req, timeout=GPU_CTL_TIMEOUT) as r:
            r.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        print(f"bridge: аренда слота {GPU_CTL_SLOT} не взята: {e}", flush=True)


def lease_after_failed_health() -> bool:
    """Аренда слота в фоне: /health отвечает сразу, а /ensure-up идёт до GPU_CTL_TIMEOUT.
    Не чаще раза в HEALTH_LEASE_EVERY, не больше одного потока разом — контроллер
    спрашивает /health часто — и только в HEALTH_LEASE_WINDOW после последнего /speak.
    Возвращает, запущена ли аренда."""
    global _health_lease_at
    now = time.monotonic()
    if _last_speak_at is None or now - _last_speak_at > HEALTH_LEASE_WINDOW:
        return False
    lock = _health_lease_lock
    if not GPU_CTL_URL or not lock.acquire(blocking=False):
        return False
    if _health_lease_at is not None and now - _health_lease_at < HEALTH_LEASE_EVERY:
        lock.release()
        return False
    _health_lease_at = now

    def run():
        try:
            lease_slot()
        finally:
            lock.release()

    try:
        threading.Thread(target=run, daemon=True).start()
    except RuntimeError as e:          # «can't start new thread»: замок занят навсегда
        lock.release()
        print(f"bridge: аренда из /health не запущена: {e}", flush=True)
        return False
    return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    timeout = READ_TIMEOUT

    def log_message(self, fmt, *args):    # без шумного access-лога в stderr
        pass

    def _send(self, code: int, body: bytes, ctype: str, close: bool = False,
              headers: dict | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        # отказ до чтения тела оставляет его в сокете: на keep-alive-соединении
        # хвост разбирается как строка следующего запроса, и subwave получает
        # каскад ложных 400/404 после одного отвергнутого запроса.
        # send_header сам выставит close_connection по этому заголовку
        if close:
            self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.rstrip("/") != "/health":
            self._send(404, b'{"ok":false}', "application/json")
            return
        # Готовность меряется по `model_loaded`, а не по коду ответа: Chatterbox
        # отдаёт 200 и в состоянии `initializing`, пока тянет веса с HuggingFace,
        # и синтез в это время падает с 500. Считать такой ответ здоровьем значит
        # объявить движок доступным ровно тогда, когда он гарантированно не работает.
        try:
            with urllib.request.urlopen(f"{UPSTREAM}/health", timeout=10) as r:
                body = json.loads(r.read().decode("utf-8", "replace"))
            ok = r.status == 200 and bool(body.get("model_loaded"))
        except (urllib.error.URLError, OSError, TimeoutError, ValueError):
            ok = False
        if not ok:
            lease_after_failed_health()
        self._send(200 if ok else 503,
                   json.dumps({"ok": ok}).encode(), "application/json")

    def do_POST(self) -> None:
        if self.path.rstrip("/") != "/speak":
            self._send(404, b'{"error":"not found"}', "application/json", close=True)
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length < 0:
                # read(-1) читал бы до EOF и держал обработчик до READ_TIMEOUT
                raise ValueError(length)
        except ValueError:
            self._send(400, b'{"error":"bad content-length"}', "application/json",
                       close=True)
            return
        if length > MAX_BODY_BYTES:
            self._send(413, json.dumps(
                {"error": f"тело больше {MAX_BODY_BYTES} байт"}).encode(),
                "application/json", close=True)
            return
        try:
            raw = self.rfile.read(length)
            req = json.loads(raw or b"{}")
        except (ValueError, TypeError):
            self._send(400, b'{"error":"bad json"}', "application/json")
            return
        except (OSError, TimeoutError):
            self.close_connection = True
            return                    # соединение оборвалось — отвечать некому

        # язык у многоязычной модели берётся из метаданных голоса,
        # отдельного поля в схеме TTSRequest нет — не выдумываем его
        payload, problem = speak_payload(req)
        if problem:
            self._send(400, json.dumps({"error": problem}).encode(), "application/json")
            return
        global _last_speak_at
        _last_speak_at = time.monotonic()      # станция говорит: окно аренды из /health

        if not _synthesis.acquire(timeout=QUEUE_WAIT):
            self._send(503, json.dumps(
                {"error": f"очередь не разошлась за {QUEUE_WAIT} с"}
            ).encode(), "application/json")
            return
        try:
            audio, ctype, headers, problem = self._synthesize(payload)
        finally:
            _synthesis.release()
        if problem:
            self._send(502, json.dumps({"error": problem}).encode(),
                       "application/json")
            return
        self._send(200, audio, ctype, headers=headers)

    def _synthesize(self, payload: dict):
        """Синтез с повтором срывов генерации.

        Возвращает `(audio, ctype, заголовки голоса, None)` либо
        `(None, None, None, причина)`.

        Повторяются только ответы 5xx и обрывы связи: они означают, что сорвался
        сам синтез, а он у Chatterbox случаен (см. RETRIES). Ответы 4xx не
        повторяются — упрёк в наш адрес повтором не исправить, а карту он займёт.

        Перед повтором выдерживается пауза: срывы идут пачками, и повтор без
        паузы попадает в ту же пачку.
        """
        problem = "синтез не выполнен"
        for attempt in range(RETRIES + 1):
            # аренда берётся ДО синтеза и обновляется перед каждой попыткой:
            # иначе пульт вправе погасить слот ровно в тот момент, когда карта
            # нужна нам, а повтор растягивает окно, в котором это возможно
            lease_slot()
            upstream_req = urllib.request.Request(
                f"{UPSTREAM}/v1/audio/speech",
                data=json.dumps(payload).encode(),
                headers={"Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(upstream_req, timeout=TIMEOUT) as r:
                    voice = {h: r.headers.get(h) for h in VOICE_HEADERS if r.headers.get(h)}
                    return r.read(), r.headers.get("Content-Type", "audio/wav"), voice, None
            except urllib.error.HTTPError as e:
                problem = e.read()[:500].decode("utf-8", "replace")
                if e.code < 500:
                    return None, None, None, problem
            except (urllib.error.URLError, OSError, TimeoutError) as e:
                problem = str(e)
            if attempt < RETRIES:
                print(f"bridge: попытка {attempt + 1} сорвалась, повтор через "
                      f"{RETRY_DELAY} с: {problem[:200]}", flush=True)
                time.sleep(RETRY_DELAY)
        return None, None, None, problem


if __name__ == "__main__":
    print(f"bridge: :{PORT} → {UPSTREAM}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
