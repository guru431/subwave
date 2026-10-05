"""Ручка /download на поднятом в тесте сервере.

Фикстура своя, а не расширение `room` из test_room_server.py: ту распаковывают
тремя элементами четырнадцать тестов. Клиентский хелпер тоже свой — `call()`
оттуда всегда делает json.loads и на файле бросил бы JSONDecodeError.

Navidrome и контроллер подделаны на уровне `urllib.request.urlopen`, а не
подменой `subsonic.download`: только так проверка «Navidrome не спрошен вовсе»
ловит любой путь в сеть, а не один конкретный.
"""
import http.client
import importlib.util
import json
import socket
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from email.message import Message
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# server.py импортирует соседей как `import guard` — так они лежат в образе.
sys.path.insert(0, str(ROOT / "room"))


def _load(name: str):
    path = ROOT / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"dl_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"dl_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


server_mod = _load("server")
store_mod = _load("store")

# Больше трёх кусков по 64 КБ (server.CHUNK): тело, влезающее в один read(),
# не отличило бы перелив циклом от одного чтения и молчания после него.
AUDIO = b"ID3" + b"\x00" * (3 * 64 * 1024)


class FakeUpstream:
    """Ответ Navidrome. Тело отдаётся только кусками — как настоящий поток."""

    def __init__(self, body=AUDIO, headers=None, status=200, gate=None, started=None):
        self._body, self._pos, self.status = body, 0, status
        self.headers = Message()
        for k, v in (headers or {"Content-Type": "audio/mpeg",
                                 "Content-Length": str(len(body)),
                                 "Accept-Ranges": "bytes",
                                 "Content-Disposition": 'attachment; filename="x.mp3"',
                                 "Set-Cookie": "nd-player-secret=1; Max-Age=31536000"}).items():
            self.headers[k] = v
        self.reads = []
        self._gate, self._started = gate, started

    def read(self, size=-1):
        assert size not in (-1, None), "тело обязано читаться кусками, а не целиком"
        if self._started is not None:
            self._started.release()
            self._started = None
        if self._gate is not None:
            assert self._gate.wait(timeout=5), "тест не отпустил ворота"
        self.reads.append(size)
        chunk = self._body[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Station:
    """Фиктивный контроллер: окно можно менять между запросами."""

    def __init__(self):
        self.payload = {"current": {"subsonic_id": "cur", "artist": "Ария",
                                    "title": "Улица Роз"},
                        "history": [{"subsonic_id": "old", "artist": "AC/DC",
                                     "title": "Highway To Hell"}],
                        "upcoming": [{"subsonic_id": "soon", "artist": "X",
                                      "title": "Y"}]}
        self.hits = 0

    def response(self):
        self.hits += 1
        body = json.dumps(self.payload, ensure_ascii=False).encode("utf-8")

        class R:
            def read(self_inner):
                return body

            def __enter__(self_inner):
                return self_inner

            def __exit__(self_inner, *exc):
                return False

        return R()


class _Server(ThreadingHTTPServer):
    """Сервер, который отмечает каждое закрытое им соединение.

    `shutdown_request` зовётся из `process_request_thread` уже после того, как
    обработчик вернулся, то есть после `finally` со `slots.release()`. Нужен
    тесту отмены закачки: клиент, сам закрывший сокет, конца обработчика не
    увидит, а ждать его по часам нельзя.
    """

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.closed = threading.Semaphore(0)
        self.errors = []

    def handle_error(self, request, client_address):
        # Исключение, вышедшее из обработчика: в проде это трейсбек в stderr
        self.errors.append(sys.exc_info()[1])

    def shutdown_request(self, request):
        super().shutdown_request(request)
        self.closed.release()


@pytest.fixture(scope="module")
def _store(tmp_path_factory):
    # /download не трогает Store вовсе, а build_handler требует его —
    # держать один на модуль дешевле, чем поднимать SQLite на каждый тест.
    # Тест- и сервер-состояние (config, station, upstreams, net, сокет)
    # остаются per-test в `room` ниже, чтобы между тестами ничего не текло.
    store = store_mod.Store(str(tmp_path_factory.mktemp("room") / "room.db"))
    yield store
    store.close()


@pytest.fixture
def room(_store, monkeypatch):
    config = server_mod.Config(
        navidrome=("http://navidrome", "u", "p"),
        controller_url="http://controller:7701",
        download_slots=2)
    station = Station()
    upstreams = []
    net = []
    # Патч `urllib.request.urlopen` глобален для процесса: без разбора по
    # адресу он ловит не только выход сервера к Navidrome/контроллеру, но и
    # `fetch()` этого же файла, которым тест достаёт до СВОЕГО подопытного
    # сервера. Настоящий urlopen сохранён заранее и вызывается для 127.0.0.1 —
    # так подделаны только внешние зависимости, а до сервера ходят по-настоящему.
    real_urlopen = urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        net.append(url)
        if "/state" in url:
            return station.response()
        up = upstreams.pop(0) if upstreams else FakeUpstream()
        up.request_headers = dict(getattr(req, "headers", {}))
        return up

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = _Server(("127.0.0.1", 0), server_mod.build_handler(_store, config))
    # poll_interval по умолчанию 0.5 с, и столько же ждёт shutdown() в каждом
    # teardown — четверть бюджета быстрого набора ни на что.
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "station": station,
           "upstreams": upstreams, "net": net, "config": config, "closed": srv.closed,
           "errors": srv.errors}
    srv.shutdown()
    srv.server_close()


def fetch(base, path, headers=None):
    """(код, заголовки, тело). Отказы тоже несут тело — их и проверяем."""
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def fetch_until_closed(base, path):
    """(код, тело), дочитав до того, как сервер закрыл соединение.

    `fetch()` возвращается, как только пришёл последний байт тела, а слот
    сервер возвращает позже, в `finally`, — следующий запрос может застать
    его занятым и получить 429 на исправном коде. Сокет же сервер закрывает
    только после того, как обработчик вернулся, поэтому EOF здесь означает
    «слот уже свободен». Таймаут — только предохранитель.
    """
    parts = urllib.parse.urlparse(base)
    chunks = []
    with socket.create_connection((parts.hostname, parts.port), timeout=5) as s:
        s.sendall(f"GET {path} HTTP/1.1\r\nHost: localhost\r\n"
                  "Connection: close\r\n\r\n".encode("ascii"))
        while chunk := s.recv(64 * 1024):
            chunks.append(chunk)
    head, _, body = b"".join(chunks).partition(b"\r\n\r\n")
    return int(head.split(b" ", 2)[1]), body


def test_track_in_the_window_comes_back_as_a_file(room):
    code, headers, body = fetch(room["base"], "/download?id=cur")
    assert code == 200
    assert body == AUDIO
    assert headers.get("Content-Type") == "audio/mpeg"


def test_filename_is_built_from_the_window_not_from_navidrome(room):
    # Navidrome для кириллицы шлёт мохибейк, а своё имя он не знает вовсе:
    # в его заголовке нет исполнителя.
    _, headers, _ = fetch(room["base"], "/download?id=cur")
    value = headers.get("Content-Disposition")
    assert 'filename="Ariya - Ulitsa Roz.mp3"' in value
    assert "%D0%90%D1%80%D0%B8%D1%8F" in value
    value.encode("latin-1")            # иначе send_header уронил бы обработчик


def test_slash_in_the_artist_does_not_reach_the_filename(room):
    # Проверка «AC/DC в заголовке нет» прошла бы и у сервера, собравшего имя в
    # обход naming.filename(): disposition() сама чистит ASCII-запаску, а
    # quote() превращает слеш в %2F. Точное имя из filename* так не обмануть.
    _, headers, _ = fetch(room["base"], "/download?id=old")
    star = headers.get("Content-Disposition").split("filename*=UTF-8''", 1)[1]
    assert urllib.parse.unquote(star) == "AC DC — Highway To Hell.mp3"


def test_navidrome_cookie_is_not_relayed(room):
    _, headers, _ = fetch(room["base"], "/download?id=cur")
    assert headers.get("Set-Cookie") is None


def test_unknown_id_is_refused_without_asking_navidrome(room):
    code, headers, body = fetch(room["base"], "/download?id=nosuch")
    assert code == 403
    assert [u for u in room["net"] if "/rest/" in u] == []
    assert "attachment" in headers.get("Content-Disposition")
    assert body.decode("utf-8")


def test_upcoming_track_is_not_downloadable(room):
    # Трек, который ещё не звучал, не «прозвучавший» — и про него Navidrome не
    # спрашивают вовсе (критерий №3 спеки), а не только отвечают 403.
    before = len(room["net"])
    code, _, _ = fetch(room["base"], "/download?id=soon")
    assert code == 403
    assert [u for u in room["net"][before:] if "/rest/" in u] == []


def test_missing_id_is_a_plain_bad_request(room):
    # До этой ветки кнопка не доводит — только самодельный адрес, поэтому
    # ответ такой же json-ошибкой, как у /resolve без q.
    code, _, body = fetch(room["base"], "/download")
    assert code == 400
    assert "error" in json.loads(body)


def test_window_is_not_cached_between_requests(room):
    assert fetch(room["base"], "/download?id=cur")[0] == 200
    room["station"].payload["current"] = {"subsonic_id": "other", "artist": "A",
                                          "title": "B"}
    assert fetch(room["base"], "/download?id=cur")[0] == 403
    assert room["station"].hits == 2


def test_silent_station_refuses_instead_of_failing(room):
    # current == null бывает на свежем старте. Пустое окно означает «скачивать
    # нечего» — это 403, а не 502: сверка состоялась и ответила.
    room["station"].payload = {"current": None, "history": [], "upcoming": []}
    assert fetch(room["base"], "/download?id=cur")[0] == 403


def test_dead_controller_is_not_disguised_as_a_refusal(room, monkeypatch):
    # Тот же приём, что в фикстуре: без разбора по адресу этот патч оборвал бы
    # и запрос fetch() к самому подопытному серверу, а не только сервер → контроллер.
    real_urlopen = urllib.request.urlopen

    def boom(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        raise OSError("controller unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    code, headers, body = fetch(room["base"], "/download?id=cur")
    assert code == 502
    assert "attachment" in headers.get("Content-Disposition")
    # Текст исключения несёт адрес контроллера — в файл слушателю он не попадает
    assert "controller unreachable" not in body.decode("utf-8")


def test_navidrome_failure_envelope_becomes_404(room):
    room["upstreams"].append(FakeUpstream(
        body=b'{"subsonic-response":{"status":"failed","error":{"code":70}}}',
        headers={"Content-Type": "application/json"}))
    assert fetch(room["base"], "/download?id=cur")[0] == 404


def test_navidrome_credentials_envelope_becomes_502(room):
    room["upstreams"].append(FakeUpstream(
        body=b'{"subsonic-response":{"status":"failed","error":{"code":40}}}',
        headers={"Content-Type": "application/json"}))
    assert fetch(room["base"], "/download?id=cur")[0] == 502


def test_range_travels_both_ways(room):
    part = FakeUpstream(body=AUDIO[:1024],
                        headers={"Content-Type": "audio/mpeg",
                                 "Content-Length": "1024",
                                 "Content-Range": f"bytes 0-1023/{len(AUDIO)}",
                                 "Accept-Ranges": "bytes"},
                        status=206)
    room["upstreams"].append(part)
    code, headers, body = fetch(room["base"], "/download?id=cur",
                                {"Range": "bytes=0-1023"})
    assert code == 206
    assert headers.get("Content-Range") == f"bytes 0-1023/{len(AUDIO)}"
    assert len(body) == 1024
    assert part.request_headers.get("Range") == "bytes=0-1023"


def test_if_range_travels_with_range(room):
    # Last-Modified слушатель получает, и браузер докачивает с If-Range. Не
    # дойди условие до Navidrome — тот отдал бы кусок уже изменившегося файла,
    # и докачка склеила бы два разных файла.
    up = FakeUpstream()
    room["upstreams"].append(up)
    date = "Wed, 21 Oct 2015 07:28:00 GMT"
    fetch(room["base"], "/download?id=cur", {"Range": "bytes=100-", "If-Range": date})
    assert up.request_headers.get("Range") == "bytes=100-"
    assert up.request_headers.get("If-range") == date      # имя после .capitalize()


def test_body_is_streamed_in_bounded_chunks(room):
    up = FakeUpstream()
    room["upstreams"].append(up)
    _, _, body = fetch(room["base"], "/download?id=cur")
    # Равенство 65536 проверять нельзя: важно, что кусок ограничен, а не что
    # он ровно такой. Сам факт «не читалось целиком» пиннит assert в FakeUpstream.
    assert up.reads and max(up.reads) <= 64 * 1024
    # Тело больше трёх кусков: три полных чтения, хвост и пустое чтение в
    # конце. Перелив, отдавший первый read() и замолчавший, здесь краснеет.
    assert len(up.reads) >= 4
    assert body == AUDIO


def test_missing_content_length_closes_the_connection(room):
    # Без длины тела HTTP/1.1 может закончить его только закрытием
    # соединения — иначе на keep-alive клиент ждёт следующий байт вплоть до
    # DOWNLOAD_SOCKET_TIMEOUT (5 минут). Заголовок сообщает об этом клиенту.
    room["upstreams"].append(FakeUpstream(headers={"Content-Type": "audio/mpeg"}))
    code, headers, body = fetch(room["base"], "/download?id=cur")
    assert code == 200
    assert headers.get("Connection") == "close"
    assert body == AUDIO


def test_short_delivery_closes_the_connection(room):
    # urllib открывает новое TCP-соединение на каждый запрос и не увидит эту
    # утечку — нужен http.client.HTTPConnection, который его переиспользует.
    room["upstreams"].append(FakeUpstream(
        body=AUDIO[:1024],
        headers={"Content-Type": "audio/mpeg", "Content-Length": str(len(AUDIO))}))
    parts = urllib.parse.urlparse(room["base"])
    conn = http.client.HTTPConnection(parts.hostname, parts.port, timeout=5)
    try:
        conn.request("GET", "/download?id=cur")
        r = conn.getresponse()
        try:
            r.read()
        except http.client.IncompleteRead:
            pass                # заявленная длина не сошлась с телом — и не должна
        # Сервер обнаружил недобор и закрыл соединение сам: второй запрос по
        # нему не проходит — ни ложного keep-alive, ни висящего сокета.
        with pytest.raises((http.client.HTTPException, OSError)):
            conn.request("GET", "/download?id=cur")
            conn.getresponse()
    finally:
        conn.close()


def test_missing_navidrome_url_does_not_leak_credentials(tmp_path, monkeypatch):
    """`main()` поддерживает режим «без Navidrome» (пустой NAVIDROME_URL).

    В нём navidrome.download() слепил бы из query-параметров относительный
    URL и уронил ValueError с токеном и солью Subsonic внутри текста — эта
    строка не должна попасть в файл отказа, который скачивает слушатель.
    Отдельный сервер вместо `room`: там `config.navidrome` уже занят непустым
    адресом, а подменить его после старта сервера нельзя.
    """
    store = store_mod.Store(str(tmp_path / "room-no-navidrome.db"))
    config = server_mod.Config(
        navidrome=("", "u", "s3cret"),
        controller_url="http://controller:7701",
        download_slots=2)
    station = Station()
    net = []
    real_urlopen = urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        net.append(url)
        return station.response() if "/state" in url else FakeUpstream()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(store, config))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    try:
        code, _, body = fetch(f"http://127.0.0.1:{srv.server_address[1]}",
                              "/download?id=cur")
        text = body.decode("utf-8")
        assert code == 502
        assert "t=" not in text and "s=" not in text and "s3cret" not in text
        assert [u for u in net if "/rest/" in u] == []
    finally:
        srv.shutdown()
        srv.server_close()
        store.close()


def _hold(room, count):
    """Занять `count` слотов заблокированными отдачами. Без часов.

    Занятость моделируется воротами, которые отпускает сам тест: `sleep` и
    утверждения о прошедшем времени краснеют от чужой нагрузки на машине —
    правило «никакого реального времени в тестах» из CLAUDE.md. Отдачи идут
    через `fetch_until_closed`: после ворот и `join()` слоты уже возвращены.
    """
    gate = threading.Event()
    started = threading.Semaphore(0)
    for _ in range(count):
        room["upstreams"].append(FakeUpstream(gate=gate, started=started))
    threads = [threading.Thread(
        target=lambda: fetch_until_closed(room["base"], "/download?id=cur"),
        daemon=True) for _ in range(count)]
    for t in threads:
        t.start()
    for _ in range(count):
        assert started.acquire(timeout=5), "отдача не началась"
    return gate, threads


def test_requests_beyond_the_slot_count_are_refused(room):
    gate, threads = _hold(room, room["config"].download_slots)
    try:
        code, headers, _ = fetch(room["base"], "/download?id=cur")
        assert code == 429
        assert "attachment" in headers.get("Content-Disposition")
    finally:
        gate.set()
        for t in threads:
            t.join(timeout=5)


def test_a_slot_comes_back_after_a_normal_delivery(room):
    gate, threads = _hold(room, room["config"].download_slots)
    gate.set()
    for t in threads:
        t.join(timeout=5)
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_a_slot_comes_back_after_an_upstream_failure(room):
    for _ in range(room["config"].download_slots):
        room["upstreams"].append(FakeUpstream(
            body=b'{"subsonic-response":{"status":"failed","error":{"code":70}}}',
            headers={"Content-Type": "application/json"}))
        assert fetch_until_closed(room["base"], "/download?id=cur")[0] == 404
    # Этот отказ возвращается из _stream_track нормально, без исключения —
    # release() сработал бы и без finally. Что release стоит именно в finally,
    # проверяет отдельно test_a_slot_comes_back_when_the_stream_breaks.
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_a_slot_comes_back_after_the_listener_cancels(room):
    """Оборванная закачка не должна съедать слот навсегда.

    Смоук-тест на то, что отменённая закачка не вешает ручку, а не на ветку
    OSError в `_pump`: тело может целиком уйти в буфер сокета раньше, чем
    клиент закроет соединение, и тогда сервер никакого исключения не увидит
    вовсе.

    Клиент, закрывший сокет сам, конца обработчика не видит, поэтому перед
    проверкой тест ждёт, пока сервер закроет каждое отменённое соединение
    (`room["closed"]`): это происходит уже после `finally` со слотом.
    """
    parts = urllib.parse.urlparse(room["base"])
    slots = room["config"].download_slots
    for _ in range(slots):
        s = socket.create_connection((parts.hostname, parts.port), timeout=5)
        s.sendall(b"GET /download?id=cur HTTP/1.1\r\n"
                  b"Host: localhost\r\nConnection: close\r\n\r\n")
        s.recv(64)
        s.close()
    for _ in range(slots):
        assert room["closed"].acquire(timeout=5), "сервер не закрыл отменённую отдачу"
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_unknown_id_is_refused_even_when_all_slots_are_busy(room):
    """Окно проверяется раньше слота, и этот порядок — решение, а не случайность.

    Слот ограничивает трафик, а запрос, который ничего не передаст, занимать
    его не должен. Обратный порядок отвечал бы `429` на чужой идентификатор и
    прятал бы настоящую причину за временной.
    """
    gate, threads = _hold(room, room["config"].download_slots)
    try:
        # Сами занятые слоты — настоящие закачки id=cur, и Navidrome они уже
        # спросили (это и держит их занятыми); интересен только трафик ПОСЛЕ
        # этой точки, вызванный запросом с чужим id.
        before = len(room["net"])
        assert fetch(room["base"], "/download?id=nosuch")[0] == 403
        assert [u for u in room["net"][before:] if "/rest/" in u] == []
    finally:
        gate.set()
        for t in threads:
            t.join(timeout=5)


class BreakingUpstream(FakeUpstream):
    """Чтение тела бросает то, чего `_pump` не ждёт: заголовки уже ушли.

    Исключение выходит из обработчика, и слот после этого возвращает только
    `finally`. Обрыв самого Navidrome (IncompleteRead) `_pump` ловит — его
    проверяет test_torn_navidrome_body_is_handled_not_crashed.
    """

    def read(self, size=-1):
        raise RuntimeError("непредвиденный сбой чтения")


class TornUpstream(FakeUpstream):
    """Navidrome оборвал тело: http.client бросает IncompleteRead, не OSError."""

    def read(self, size=-1):
        raise http.client.IncompleteRead(b"")


def test_a_slot_comes_back_when_the_stream_breaks(room):
    for _ in range(room["config"].download_slots):
        room["upstreams"].append(BreakingUpstream())
        # Заголовки с Content-Length уже ушли, тело оборвано: клиент видит
        # недочитанный ответ либо разорванное соединение.
        with pytest.raises((http.client.HTTPException, ConnectionError)):
            fetch(room["base"], "/download?id=cur")
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_torn_navidrome_body_is_handled_not_crashed(room):
    room["upstreams"].append(TornUpstream())
    with pytest.raises((http.client.HTTPException, ConnectionError)):
        fetch(room["base"], "/download?id=cur")
    assert room["closed"].acquire(timeout=5), "сервер не закрыл оборванную отдачу"
    # Обработчик вернулся сам, а не вылетел трейсбеком в stderr контейнера
    assert room["errors"] == []


def test_keep_alive_after_a_download_gets_the_short_timeout_back(tmp_path, monkeypatch):
    """Пять минут таймаута нужны отдаче файла, а не ожиданию следующего запроса.

    Отдельный сервер с коротким read_timeout: с таймаутом загрузки (300 с)
    простаивающее keep-alive соединение сервер не закрыл бы за время теста.
    """
    store = store_mod.Store(str(tmp_path / "room-timeout.db"))
    config = server_mod.Config(navidrome=("http://navidrome", "u", "p"),
                               controller_url="http://controller:7701",
                               read_timeout=0.2)
    station = Station()
    real_urlopen = urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        return station.response() if "/state" in url else FakeUpstream()

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = _Server(("127.0.0.1", 0), server_mod.build_handler(store, config))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    conn = http.client.HTTPConnection("127.0.0.1", srv.server_address[1], timeout=5)
    try:
        conn.request("GET", "/download?id=cur")
        assert conn.getresponse().read() == AUDIO
        # Соединение живо и простаивает: сервер обязан закрыть его по
        # read_timeout, а не держать поток пять минут
        assert srv.closed.acquire(timeout=5), "простаивающий keep-alive не закрыт"
    finally:
        conn.close()
        srv.shutdown()
        srv.server_close()
        store.close()
