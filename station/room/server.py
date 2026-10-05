"""Комната: чат станции, из которого ведущий берёт реплики слушателей.

Поверхность нарочно крошечная и вся описана здесь:

    GET  /health                      → {"ok": true}
    POST /messages                    → {"id": N, "at": "..."}   (201)
    GET  /messages?since=&limit=      → {"messages": [...], "last": N}
    GET  /unread?since=&limit=        → то же, для навыка ведущего
    GET  /resolve?q=                  → {"exact": …|null, "alternatives": [...]}
    GET  /download?id=                → файл прозвучавшего трека (отказ — .txt с честным кодом)
    GET  /push/key                    → {"key": "<открытый ключ VAPID>"}
    POST /push/subscribe              → {"ok": true}   (201; тело — {subscription})
    POST /push/unsubscribe            → {"ok": true, "removed": …}   (тело — {endpoint})
    GET  /dislikes                    → {"marks": {songId: {"track", "artist"}}}
    POST /dislikes                    → {"songId", "track", "artist"}   (тело — {songId, kind, on})
    GET  /admin/dislikes              → {"artists": [...], "tracks": [...]}   (пароль владельца)
    POST /admin/dislikes/decide       → {"ok": true}   (тело — {kind, key, action})

Личность слушателя приезжает заголовками `X-Listener-Id` и `X-Listener-Name`:
ни паролей, ни базы пользователей — станция закрыта общим паролем, аудитория
семейная, и подмена имени даёт ровно то, что и так доступно (написать под чужим
именем). Имя едет percent-encoded: заголовки по RFC 7230 — latin-1, и кириллица
в них иначе не проходит.

Запросы `/admin/…` — владельцу станции: вместо личности слушателя у них пароль
админки в `Authorization`, и проверяет его контроллер (`admin.py`).

`/messages` и `/unread` отвечают одинаково. Два пути оставлены намеренно: по
ним в логе Caddy видно, кто приходил — плеер за лентой или ведущий за новым.

Стандартная библиотека плюс один пакет — `cryptography` для Web Push
(`push.py`, там же почему).
"""
import http.client
import json
import os
import sys
import threading
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import admin
import dislikes
import guard
import naming
import navidrome
import notify
import push
import station
import subsonic
from store import Store

FEED_LIMIT = 50          # сколько отдаём плееру по умолчанию
UNREAD_LIMIT = 20        # сколько отдаём ведущему: он читает вслух, не листает
LIMIT_MAX = 200
# Сколько байт отвергнутого тела согласны вычитать, чтобы ответ дошёл до
# клиента. Больше — обрываем соединение: дочитывать мегабайты за тем, кто уже
# нарушил лимит, значит выполнять его работу.
DISCARD_CAP = 1024 * 1024
# Порция перелива файла. Читать тело целиком нельзя: файлы коллекции 8-14 МБ,
# и `read()` без границы означает отдать столько памяти, сколько попросили.
CHUNK = 64 * 1024
# Сколько согласны читать у Navidrome, когда вместо файла приехал конверт.
ENVELOPE_CAP = 64 * 1024
# `Config.read_timeout` уходит в socket.settimeout и действует на ЗАПИСЬ тоже:
# клиент, замолчавший на полминуты (свёрнутый PWA), рвал бы отдачу на середине.
DOWNLOAD_SOCKET_TIMEOUT = 300
# Заголовки Navidrome, которые отдаются дальше. Белый список, а не перелив:
# Navidrome шлёт `Set-Cookie` со своей сессией, и она уехала бы слушателю.
PASS_HEADERS = ("Content-Type", "Content-Length", "Content-Range",
                "Accept-Ranges", "Last-Modified")


@dataclass
class Config:
    rate_seconds: int = 60
    rate_max: int = 10
    max_body: int = 8 * 1024
    read_timeout: float = 30
    navidrome: tuple[str, str, str] = field(default_factory=lambda: ("", "", ""))
    controller_url: str = ""
    download_slots: int = 4
    # None — push не настроен: ручки /push/* отвечают 404, рассылки нет
    notifier: object | None = None
    # Потолок подписок: адрес ручки открыт наружу, и без предела таблицу
    # можно было бы раздувать сколько угодно
    push_max: int = 500
    # Потолок записей в таблице дизлайков: адрес открыт наружу, и без предела
    # её можно было бы раздувать сколько угодно — как подписки push
    dislikes_max: int = 5000


def _limit(raw: str | None, default: int) -> int:
    try:
        value = int(raw) if raw else default
    except ValueError:
        value = default
    return max(1, min(value, LIMIT_MAX))


def _since(raw: str | None) -> int:
    try:
        return max(0, int(raw or 0))
    except ValueError:
        return 0


def build_handler(store: Store, config: Config):
    # Счётчик живёт на сервере, а не модульной глобалью: тесты поднимают
    # несколько серверов в одном процессе, и общий счётчик протёк бы между ними.
    slots = threading.BoundedSemaphore(config.download_slots)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        timeout = config.read_timeout

        def log_message(self, fmt, *args):     # access-лог ведёт Caddy
            pass

        def _send(self, code: int, payload: dict, close: bool = False,
                  headers: dict | None = None) -> None:
            body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            # Отказ до чтения тела оставляет его в сокете: на keep-alive
            # соединении хвост разберётся как следующий запрос.
            if close:
                self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)

        def _discard(self, length: int) -> None:
            """Вычитать и выбросить тело отвергнутого запроса."""
            left = min(length, DISCARD_CAP)
            while left > 0:
                chunk = self.rfile.read(min(left, 64 * 1024))
                if not chunk:
                    break
                left -= len(chunk)

        def _query(self) -> dict:
            return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        def _path(self) -> str:
            return urllib.parse.urlparse(self.path).path.rstrip("/") or "/"

        def _refuse(self, code: int, name: str, text: str) -> None:
            """Отказ приезжает файлом с говорящим именем — где браузер это сохраняет.

            Ссылка `<a href download>` того же origin ПРОСИТ сохранить тело
            ответа, но решает браузер: Chromium (Chrome, Edge, Chrome на
            Android) при кодах ошибки загрузку обрывает и тело не пишет
            (`fetch_error_body` по умолчанию `false` — см. спеку §4.3), так
            что слушатель увидит там просто «Сбой» без текста причины, но и
            json-конверт под именем песни, от которого защищаемся, тоже не
            появится. Файл с текстом причины сохранит браузер, который тело
            ошибки не отбрасывает (Firefox/Safari — проверяется руками при
            выкатке). HTTP-код при этом остаётся честным всегда — 200 ради
            файла не ставим. Тост вместо файла потребовал бы предварительной
            пробы — второго запроса и состояния в компоненте под `memo`.
            """
            body = text.encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Disposition", naming.disposition(name))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _download(self, query: dict) -> None:
            track_id = (query.get("id", [""])[0] or "").strip()
            if not track_id:
                # Кнопка сюда не приводит — только самодельный адрес, поэтому
                # ответ json-ошибкой, как у /resolve без q.
                self._send(400, {"error": "нужен параметр id"})
                return
            try:
                window = station.window(config.controller_url)
            except Exception as e:                       # noqa: BLE001
                # Текст исключения несёт адрес контроллера — слушателю он ни к чему
                print(f"room: /download {track_id}: станция: {e!r}",
                      file=sys.stderr, flush=True)
                self._refuse(502, "станция недоступна.txt",
                             "Не удалось спросить станцию, что сейчас в эфире.\n")
                return
            entry = window.get(track_id)
            if entry is None:
                # Отвечаем раньше, чем куда-либо ходим: так ручка заодно не
                # подтверждает существование чужих идентификаторов.
                self._refuse(403, "трек уже не в эфире.txt",
                             "Скачать можно то, что звучит сейчас, и всё, что уже "
                             "прозвучало. Этот трек в эфире не был или уже уехал "
                             "из истории.\n")
                return
            # Слот занимается ПОСЛЕ сверки окна: он ограничивает трафик, а
            # запрос, который ничего не передаст, занимать его не должен.
            if not slots.acquire(blocking=False):
                self._refuse(429, "слишком много загрузок сразу.txt",
                             f"Одновременно отдаём не больше {config.download_slots} "
                             "файлов. Попробуйте через минуту.\n")
                return
            try:
                self._stream_track(track_id, entry)
            finally:
                slots.release()

        def _stream_track(self, track_id: str, entry: dict) -> None:
            base, user, password = config.navidrome
            if not base:
                # Без адреса navidrome.download() слепит из query-параметров
                # относительный URL и уронит ValueError с токеном и солью
                # Subsonic внутри текста — та строка ушла бы слушателю файлом
                # ниже, если бы текст исключения попал в отказ как есть.
                self._refuse(502, "не удалось получить файл.txt",
                             "Navidrome не настроен.\n")
                return
            try:
                upstream = navidrome.download(track_id, base, user, password,
                                              rng=self.headers.get("Range"),
                                              if_range=self.headers.get("If-Range"))
            except Exception as e:                       # noqa: BLE001
                # Текст исключения может нести токен и соль Subsonic (см. выше) —
                # слушателю уходит нейтральная фраза, подробности только в лог.
                print(f"room: /download {track_id}: Navidrome: {e!r}",
                      file=sys.stderr, flush=True)
                self._refuse(502, "не удалось получить файл.txt",
                             "Navidrome не ответил.\n")
                return
            with upstream:
                # Ошибки Navidrome приходят с кодом 200 и конвертом, а не
                # исключением, поэтому «файл или отказ» решается по типу — и
                # решается ДО первого send_response: после него передумать нельзя.
                ctype = (upstream.headers.get("Content-Type") or "").lower()
                if not ctype.startswith("audio/"):
                    code = navidrome.envelope_code(upstream.read(ENVELOPE_CAP))
                    if code == 70:
                        self._refuse(404, "трека больше нет.txt",
                                     "Станция помнит этот трек, а в коллекции его "
                                     "уже нет.\n")
                    else:
                        self._refuse(502, "не удалось получить файл.txt",
                                     f"Navidrome отказал (код {code}).\n")
                    return
                ext = naming.ext_from_disposition(
                    upstream.headers.get("Content-Disposition"))
                name = naming.filename(entry.get("artist"), entry.get("title"), ext)
                self.send_response(upstream.status)
                for header in PASS_HEADERS:
                    value = upstream.headers.get(header)
                    if value is not None:
                        self.send_header(header, value)
                self.send_header("Content-Disposition", naming.disposition(name))
                if upstream.headers.get("Content-Length") is None:
                    # Без длины тела HTTP/1.1 закончить его может только закрытие
                    # соединения — иначе клиент на keep-alive ждёт следующий байт
                    # вплоть до DOWNLOAD_SOCKET_TIMEOUT. Заголовок сообщает это
                    # клиенту, флаг — заставляет сервер закрыть сокет на деле.
                    self.send_header("Connection", "close")
                    self.close_connection = True
                self.end_headers()
                self._pump(upstream)

        def _pump(self, upstream) -> None:
            """Перелить тело кусками, посчитав отданное.

            У комнаты `protocol_version = "HTTP/1.1"`, то есть соединение
            переиспользуется: недописанное тело рассинхронизирует его, и
            следующий запрос плеера разберётся как мусор. Поэтому при недоборе
            соединение закрывается.
            """
            declared = upstream.headers.get("Content-Length")
            self.connection.settimeout(DOWNLOAD_SOCKET_TIMEOUT)
            sent = 0
            try:
                while True:
                    chunk = upstream.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    sent += len(chunk)
            except (OSError, http.client.HTTPException):
                # Слушатель отменил закачку (OSError) или Navidrome оборвал
                # тело (IncompleteRead — не OSError). handle_one_request ловит
                # только TimeoutError, поэтому без этого трейсбек уехал бы в
                # stderr контейнера на каждый обрыв.
                self.close_connection = True
                return
            finally:
                # Следующие запросы keep-alive — снова с коротким таймаутом:
                # пять минут нужны отдаче файла, а не ожиданию нового запроса
                self.connection.settimeout(config.read_timeout)
            try:
                if declared is not None and sent != int(declared):
                    self.close_connection = True
            except ValueError:
                self.close_connection = True

        def do_GET(self) -> None:
            path, query = self._path(), self._query()
            if path == "/health":
                self._send(200, {"ok": True})
            elif path in ("/messages", "/unread"):
                default = FEED_LIMIT if path == "/messages" else UNREAD_LIMIT
                since = _since(query.get("since", [None])[0])
                items = store.since(since, _limit(query.get("limit", [None])[0], default))
                self._send(200, {"messages": items,
                                 "last": items[-1]["id"] if items else since})
            elif path == "/resolve":
                q = (query.get("q", [""])[0] or "").strip()
                if not q:
                    self._send(400, {"error": "нужен параметр q"})
                    return
                base, user, password = config.navidrome
                try:
                    self._send(200, subsonic.resolve(q, base, user, password))
                except Exception as e:                       # noqa: BLE001
                    # Плееру важно отличить «в коллекции нет» от «сверка не
                    # состоялась»: первое — ответ, второе — повод не скрывать
                    # ошибку за пустым списком. Текст исключения — только в
                    # лог: в нём бывает URL запроса с токеном и солью Subsonic.
                    print(f"room: /resolve: {e!r}", file=sys.stderr, flush=True)
                    self._send(502, {"error": "сверка не удалась"})
            elif path == "/download":
                self._download(query)
            elif path == "/push/key":
                if config.notifier is None:
                    self._send(404, {"error": "push не настроен"})
                else:
                    self._send(200, {"key": config.notifier.vapid.public_key})
            elif path == "/dislikes":
                self._marks()
            elif path == "/admin/dislikes":
                if not self._admin_refused():
                    self._send(200, dislikes.suggestions(store.all_dislikes(),
                                                         store.decisions()))
            else:
                self._send(404, {"error": "not found"})

        def do_POST(self) -> None:
            path = self._path()
            if path not in ("/messages", "/push/subscribe", "/push/unsubscribe",
                            "/dislikes", "/admin/dislikes/decide"):
                self._send(404, {"error": "not found"}, close=True)
                return
            # Решение владельца приходит из админки, а у неё нет id слушателя:
            # там личность — пароль, и проверяется он после чтения тела (отказ
            # до чтения оставил бы тело в сокете — см. _read_body).
            request = self._read_body(need_listener=path != "/admin/dislikes/decide")
            if request is None:
                return
            body, listener = request
            if path == "/messages":
                self._post_message(body, listener)
            elif path == "/push/subscribe":
                self._push_subscribe(body, listener)
            elif path == "/push/unsubscribe":
                self._push_unsubscribe(body)
            elif path == "/dislikes":
                self._dislike(body, listener)
            elif not self._admin_refused():
                self._decide(body)

        def _read_body(self, need_listener: bool = True) -> tuple[dict, str] | None:
            """Тело POST и id слушателя; None — отказ уже отправлен.

            `need_listener=False` — для запросов владельца: id слушателя у них
            нет, и пустая строка вместо него — законный ответ.
            """
            if self.headers.get("Transfer-Encoding"):
                # Тело кусками комната не разбирает (браузер шлёт Content-Length
                # всегда), а непрочитанные куски на keep-alive разобрались бы как
                # следующий запрос. Заголовок важнее Content-Length (RFC 9112),
                # поэтому проверяется первым.
                self._send(411, {"error": "нужен Content-Length"}, close=True)
                return None
            try:
                length = int(self.headers.get("Content-Length", 0))
                if length < 0:
                    # read(-1) читал бы до EOF и держал поток до таймаута
                    raise ValueError(length)
            except ValueError:
                # Длина неизвестна — вычитать нечего и незачем; это единственный
                # отказ, после которого соединение честно рвётся.
                self._send(400, {"error": "bad content-length"}, close=True)
                return None
            listener = (self.headers.get("X-Listener-Id") or "").strip()[:64]
            if need_listener and not listener:
                self._discard(length)
                self._send(400, {"error": "нет заголовка X-Listener-Id"}, close=True)
                return None
            if length > config.max_body:
                # Ответить и закрыть, не прочитав тело, нельзя: неприбранные
                # байты в сокете Windows закрывает через RST, и клиент вместо
                # честного 413 получает «соединение разорвано» (проверено —
                # тест ловил именно это). Тело отбрасывается порциями и не
                # больше DISCARD_CAP: читать в память сколько прислали значит
                # отдать память тому же запросу, от которого защищает лимит.
                self._discard(length)
                self._send(413, {"error": f"тело больше {config.max_body} байт"},
                           close=True)
                return None
            try:
                body = json.loads(self.rfile.read(length) or b"{}")
            except (ValueError, TypeError):
                self._send(400, {"error": "bad json"})
                return None
            except (OSError, TimeoutError):
                self.close_connection = True
                return None
            if not isinstance(body, dict):
                self._send(400, {"error": "тело должно быть объектом JSON"})
                return None
            return body, listener

        def _post_message(self, body: dict, listener: str) -> None:
            raw_name = self.headers.get("X-Listener-Name")
            name = urllib.parse.unquote(raw_name) if raw_name else None
            value, problem = guard.validate(body.get("text"), name)
            if problem:
                self._send(400, {"error": problem})
                return
            text, who = value

            record = store.add(listener, who, text,
                               rate=(config.rate_seconds, config.rate_max))
            if record is None:
                self._send(429, {"error": f"не больше {config.rate_max} сообщений "
                                          f"за {config.rate_seconds} с"})
                return
            store.prune()
            self._send(201, {"id": record["id"], "at": record["at"]})
            if config.notifier is not None:
                config.notifier.on_message(listener, who, text)

        def _push_subscribe(self, body: dict, listener: str) -> None:
            if config.notifier is None:
                self._send(404, {"error": "push не настроен"})
                return
            sub, problem = push.check_subscription(body.get("subscription"))
            if problem:
                self._send(400, {"error": problem})
                return
            raw_name = self.headers.get("X-Listener-Name")
            # Пустое имя — «упоминаний нет», а не «гость»: иначе слово «гость»
            # в любом сообщении будило бы всех, кто не назвался
            name = (guard.sanitize(urllib.parse.unquote(raw_name))[:guard.NAME_MAX]
                    if raw_name else "")
            if not store.subscribe(sub, listener, name, cap=config.push_max):
                self._send(429, {"error": f"подписок уже {config.push_max}"})
                return
            self._send(201, {"ok": True})

        def _push_unsubscribe(self, body: dict) -> None:
            endpoint = body.get("endpoint")
            if not isinstance(endpoint, str) or not endpoint:
                self._send(400, {"error": "нет адреса подписки"})
                return
            self._send(200, {"ok": True, "removed": store.unsubscribe(endpoint)})

        def _listener_name(self) -> str:
            """Имя из заголовка: percent-encoded, чистится и режется, как в
            подписке push. Нет заголовка — пустая строка («не назвался»)."""
            raw = self.headers.get("X-Listener-Name")
            return (guard.sanitize(urllib.parse.unquote(raw))[:guard.NAME_MAX]
                    if raw else "")

        def _window(self) -> dict | None:
            """Окно станции; None — отказ 502 уже отправлен."""
            try:
                return station.window(config.controller_url)
            except Exception as e:                       # noqa: BLE001
                print(f"room: окно станции: {e!r}", file=sys.stderr, flush=True)
                self._send(502, {"error": "станция не ответила"})
                return None

        def _marks(self) -> None:
            listener = (self.headers.get("X-Listener-Id") or "").strip()[:64]
            if not listener:
                self._send(400, {"error": "нет заголовка X-Listener-Id"})
                return
            window = self._window()
            if window is None:
                return
            self._send(200, {"marks": dislikes.marks_for(
                window, store.listener_dislikes(listener))})

        def _dislike(self, body: dict, listener: str) -> None:
            song_id, kind, on = body.get("songId"), body.get("kind"), body.get("on")
            if not isinstance(song_id, str) or not song_id.strip():
                self._send(400, {"error": "нужен songId"})
                return
            if kind not in dislikes.KINDS:
                self._send(400, {"error": "kind — track или artist"})
                return
            if not isinstance(on, bool):
                self._send(400, {"error": "on — true или false"})
                return
            song_id = song_id.strip()
            window = self._window()
            if window is None:
                return
            entry = window.get(song_id)
            if entry is None:
                # Как у скачивания: отметить можно то, что звучит, и то, что
                # уже прозвучало, — снятие тоже, иначе цель исполнителя не найти.
                self._send(403, {"error": "отметить можно то, что звучит сейчас "
                                          "или уже прозвучало"})
                return
            target = dislikes.target_of(kind, song_id, entry.get("artist"))
            if target is None:
                self._send(400, {"error": "у этого трека нет исполнителя"})
                return
            name = self._listener_name()
            store.rename_listener(listener, name)
            if on:
                outcome = store.set_dislike({
                    "listener_id": listener, "name": name, "kind": kind,
                    "target": target,
                    "artist_key": dislikes.artist_key(entry.get("artist")),
                    "song_id": song_id, "title": entry.get("title") or "",
                    "artist": entry.get("artist") or "",
                    "album": entry.get("album") or ""}, config.dislikes_max)
                if outcome == "full":
                    self._send(429, {"error": f"отметок уже {config.dislikes_max}"})
                    return
            else:
                store.unset_dislike(listener, kind, target)
            mark = dislikes.marks_for({song_id: entry},
                                      store.listener_dislikes(listener))
            self._send(200, {"songId": song_id,
                             **mark.get(song_id, {"track": False, "artist": False})})

        def _admin_refused(self) -> bool:
            """Отказать, если это не владелец. True — отказ уже отправлен.

            Пароль проверяет контроллер (admin.py). `WWW-Authenticate` не шлём:
            на него браузер поднял бы поверх админки своё окно входа.
            """
            code, retry = admin.verify(self.headers.get("Authorization"),
                                       config.controller_url)
            if code == 200:
                return False
            text = {401: "нужен пароль администратора станции",
                    429: "слишком много неверных паролей — вход ненадолго закрыт",
                    }.get(code, "пароль не проверить: контроллер не ответил")
            self._send(code, {"error": text},
                       headers={"Retry-After": retry} if retry else None)
            return True

        def _decide(self, body: dict) -> None:
            kind, key, action = body.get("kind"), body.get("key"), body.get("action")
            if (kind not in dislikes.KINDS or action not in dislikes.ACTIONS
                    or not isinstance(key, str) or not key):
                self._send(400, {"error": "нужны kind (track|artist), key и "
                                          "action (keep|blocked)"})
                return
            if not store.has_dislikes(kind, key):
                self._send(404, {"error": "у этой цели нет дизлайков"})
                return
            store.decide(kind, key, action)
            self._send(200, {"ok": True})

    return Handler


def push_subject(environ) -> str:
    """Адрес отправителя для подписи VAPID: `https://<домен станции>` или `mailto:`."""
    subject = environ.get("PUSH_SUBJECT", "").strip()
    if not subject.startswith(("https://", "mailto:")):
        raise SystemExit("PUSH_SUBJECT не задан или не https://… / mailto:… — "
                         "это адрес станции в подписи Web Push")
    return subject


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    store = Store(os.environ.get("ROOM_DB", "/data/room.db"),
                  retention_days=int(os.environ.get("RETENTION_DAYS", "14")))
    config = Config(
        rate_seconds=int(os.environ.get("RATE_SECONDS", "60")),
        rate_max=int(os.environ.get("RATE_MAX", "10")),
        navidrome=(os.environ.get("NAVIDROME_URL", ""),
                   os.environ.get("NAVIDROME_USER", ""),
                   os.environ.get("NAVIDROME_PASS", "")),
        controller_url=os.environ.get("CONTROLLER_URL", ""),
        download_slots=int(os.environ.get("DOWNLOAD_SLOTS", "4")))
    # Ключ VAPID — на томе рядом с базой: подписки браузеров привязаны к нему,
    # и ключ, пересозданный вместе с контейнером, обесценил бы их все разом
    vapid = push.Vapid.load_or_create(os.environ.get("VAPID_KEY", "/data/vapid.pem"))
    config.notifier = notify.Notifier(store, vapid, push_subject(os.environ))
    if config.controller_url:
        watch = notify.DjWatch(lambda: notify.fetch_session(config.controller_url),
                               config.notifier, store)
        threading.Thread(target=watch.run, daemon=True).start()
    print(f"room: :{port} → {config.navidrome[0] or 'без Navidrome'}"
          f", станция {config.controller_url or 'НЕ ЗАДАНА'}"
          f", push {len(store.subscriptions())} подписок", flush=True)
    ThreadingHTTPServer(("0.0.0.0", port), build_handler(store, config)).serve_forever()


if __name__ == "__main__":
    main()
