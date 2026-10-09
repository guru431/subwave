"""Web Push комнаты: шифрование, подпись, подписки и что будит закрытую вкладку.

Уведомления страницы (`web/lib/roomNotify.ts`) живут, пока жива вкладка; при
закрытой будит только push-сервис браузера, а ему комната шлёт зашифрованное
сообщение. Ошибку в шифровании или подписи push-сервис не объясняет — просто
отбрасывает, поэтому шифрование сверяется с примером из RFC 8291 байт в байт.
"""
import importlib.util
import json
import os
import sqlite3
import sys
import threading
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.parse
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "room"))


def _load(name: str):
    spec = importlib.util.spec_from_file_location(f"room_{name}",
                                                  ROOT / "room" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


push = _load("push")
notify = _load("notify")
store_mod = _load("store")
server_mod = _load("server")

# RFC 8291, приложение A (пробелы из RFC убираются при разборе)
RFC_PLAIN = "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24"
RFC_AS_PRIVATE = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"
RFC_UA_PUBLIC = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
RFC_AUTH = "BTBZMqHH6r4Tts7J_aSIgg"
RFC_SALT = "DGv6ra1nlYgDCS1FRnbzlw"
RFC_HEADER = ("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml "
              "mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8")
RFC_CIPHERTEXT = ("8pfeW0KbunFT06SuDKoJH9Ql87S1QUrd irN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs "
                  "bI_0LpXMuGvnzQ")

FCM = "https://fcm.googleapis.com/fcm/send/abc:def"


def _browser_keys():
    """Ключи «браузера» для подписки: как их отдал бы PushManager.subscribe()."""
    ua = ec.generate_private_key(ec.SECP256R1())
    point = ua.public_key().public_bytes(push.serialization.Encoding.X962,
                                         push.serialization.PublicFormat.UncompressedPoint)
    return ua, push.b64u(point), push.b64u(os.urandom(16))


def _subscription(endpoint=FCM):
    _, p256dh, auth = _browser_keys()
    return {"endpoint": endpoint, "keys": {"p256dh": p256dh, "auth": auth}}


# --- протокол ---------------------------------------------------------------

def test_encryption_matches_rfc_8291_example_byte_for_byte():
    server_key = ec.derive_private_key(
        int.from_bytes(push.unb64u(RFC_AS_PRIVATE), "big"), ec.SECP256R1())
    body = push.encrypt(push.unb64u(RFC_PLAIN), RFC_UA_PUBLIC, RFC_AUTH,
                        salt=push.unb64u(RFC_SALT), server_key=server_key)
    assert body == push.unb64u(RFC_HEADER) + push.unb64u(RFC_CIPHERTEXT)


def test_fresh_salt_and_key_on_every_message():
    # одинаковые соль и ключ сервера на двух сообщениях — одинаковый nonce при
    # одном ключе AES-GCM, то есть сломанное шифрование
    _, p256dh, auth = _browser_keys()
    a = push.encrypt(b"x", p256dh, auth)
    b = push.encrypt(b"x", p256dh, auth)
    assert a[:16] != b[:16] and a[21:86] != b[21:86]


def test_oversized_payload_is_refused_before_sending():
    _, p256dh, auth = _browser_keys()
    with pytest.raises(ValueError):
        push.encrypt(b"x" * (push.MAX_PLAINTEXT + 1), p256dh, auth)


def test_vapid_header_is_a_valid_es256_jwt_for_the_push_origin():
    vapid = push.Vapid(ec.generate_private_key(ec.SECP256R1()))
    header = vapid.authorization(FCM, "https://fm.example.org", now=1_790_000_000)
    token = header.split("t=", 1)[1].split(",", 1)[0]
    head, claims, sig = token.split(".")
    raw = push.unb64u(sig)
    vapid.private_key.public_key().verify(
        encode_dss_signature(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big")),
        f"{head}.{claims}".encode(), ec.ECDSA(hashes.SHA256()))
    assert json.loads(push.unb64u(claims)) == {
        "aud": "https://fcm.googleapis.com", "exp": 1_790_000_000 + push.JWT_LIFETIME_SEC,
        "sub": "https://fm.example.org"}
    assert header.endswith(f", k={vapid.public_key}")


def test_vapid_key_survives_a_restart(tmp_path):
    # новый ключ на каждом старте обесценил бы все подписки браузеров разом
    path = str(tmp_path / "vapid.pem")
    first = push.Vapid.load_or_create(path)
    assert push.Vapid.load_or_create(path).public_key == first.public_key
    if os.name == "posix":
        assert os.stat(path).st_mode & 0o777 == 0o600


@pytest.mark.parametrize("endpoint", [
    "http://fcm.googleapis.com/fcm/send/x",            # не https
    "https://10.0.0.10/internal",                   # адрес в LAN: комната — не прокси
    "https://evil.example/fcm.googleapis.com",         # имя сервиса в пути, а не в хосте
    "https://fcm.googleapis.com.evil.example/x",       # и суффиксом чужого домена
])
def test_subscription_to_anything_but_a_push_service_is_refused(endpoint):
    sub, problem = push.check_subscription(_subscription(endpoint))
    assert sub is None and problem


def test_subscription_of_known_push_services_is_accepted():
    for endpoint in (FCM, "https://updates.push.services.mozilla.com/wpush/v2/x",
                     "https://web.push.apple.com/QGx"):
        sub, problem = push.check_subscription(_subscription(endpoint))
        assert problem is None and sub["endpoint"] == endpoint


def test_subscription_with_broken_keys_is_refused():
    bad = _subscription()
    bad["keys"]["auth"] = push.b64u(b"short")
    assert push.check_subscription(bad)[0] is None


def test_subscription_with_a_key_off_the_curve_is_refused():
    # 65 байт с 0x04 впереди, но не точка P-256: шифрование на таком ключе
    # падает исключением, а исключение рассылки (код 0) подписку не стирает —
    # значит, её нельзя и принять
    bad = _subscription()
    bad["keys"]["p256dh"] = push.b64u(b"\x04" + b"\x00" * 64)
    sub, problem = push.check_subscription(bad)
    assert sub is None and problem


def test_send_reports_the_push_service_answer():
    vapid = push.Vapid(ec.generate_private_key(ec.SECP256R1()))
    ua, p256dh, auth = _browser_keys()
    seen = {}

    class Answer:
        status = 201

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def opener(req, timeout=None):
        seen.update(url=req.full_url, headers=dict(req.header_items()), body=req.data)
        return Answer()

    status = push.send({"endpoint": FCM, "p256dh": p256dh, "auth": auth},
                       {"title": "t", "body": "b"}, vapid, "https://fm.example.org",
                       opener=opener)
    assert status == 201 and seen["url"] == FCM
    assert seen["headers"]["Content-encoding"] == "aes128gcm"
    assert seen["headers"]["Authorization"].startswith("vapid t=")


# --- что считается важным ----------------------------------------------------

@pytest.mark.parametrize("sub,author_id,author,expected", [
    # те же случаи, что у fromOthers в web/lib/roomRules.test.ts
    ({"listener_id": "a", "name": "Петр"}, "a", "Старое имя", True),     # тот же слушатель
    ({"listener_id": "b", "name": "Алена"}, "a", "алёна", True),         # то же имя, другое устройство
    ({"listener_id": "b", "name": "Петр"}, "a", "Alex", False),          # чужой
    ({"listener_id": "b", "name": ""}, "a", "гость", False),             # без имени — только по id
])
def test_author_rule_matches_the_player(sub, author_id, author, expected):
    assert notify.is_author(sub, author_id, author) is expected


@pytest.fixture
def store(tmp_path):
    s = store_mod.Store(str(tmp_path / "room.db"))
    yield s
    s.close()


def _subscribe(store, listener, name, endpoint=None):
    sub, _ = push.check_subscription(_subscription(endpoint or f"{FCM}{listener}"))
    store.subscribe(sub, listener, name)
    return sub["endpoint"]


class Inline:
    """wake без потока: тест проверяет, что уехало, а не планировщик."""
    def __call__(self, fn, *args):
        fn(*args)


def test_every_message_wakes_everyone_but_its_author(store):
    # владелец 23.09: на «Всем привет!» от другого слушателя не всплыло ничего —
    # громким тогда было только упоминание имени
    _subscribe(store, "anya", "Аня")
    _subscribe(store, "anya-phone", "аня")        # тот же человек, другое устройство
    _subscribe(store, "petya", "Петя")
    sent = []
    n = notify.Notifier(store, vapid=None, subject="s", wake=Inline(),
                        sender=lambda sub, payload, *_: sent.append((sub["listener_id"], payload)) or 201)
    assert n.on_message("petya", "Петя", "Всем привет!") == 2
    assert sorted(who for who, _ in sent) == ["anya", "anya-phone"]
    assert sent[0][1]["title"] == "Петя — в чате" and sent[0][1]["tag"] == "subwave-chat"
    sent.clear()
    # своё не звенит — ни на этом устройстве, ни на другом
    assert n.on_message("anya", "Аня", "это я") == 1
    assert [who for who, _ in sent] == ["petya"]


def test_messages_waiting_for_delivery_collapse_into_the_latest(store):
    # в шторке у чата одна карточка (тег и Topic `subwave-chat`), поэтому
    # неотправленное заменяется новым: очередь не длиннее числа подписок,
    # сколько бы сообщений ни пришло, пока рассылка занята
    _subscribe(store, "anya", "Аня")
    _subscribe(store, "petya", "Петя")
    sent = []
    n = notify.Notifier(store, vapid=None, subject="s", wake=lambda drain: None,
                        sender=lambda sub, payload, *_: sent.append(
                            (sub["listener_id"], payload["body"])) or 201)
    for i in range(50):
        n.on_message(f"spam{i}", f"Спамер {i}", f"сообщение {i}")
    assert len(n.pending) == 2
    assert n.drain() == 2
    assert sorted(sent) == [("anya", "сообщение 49"), ("petya", "сообщение 49")]
    assert n.drain() == 0


def test_delivery_runs_on_one_thread_however_many_messages(store):
    # прежде каждое сообщение запускало свой поток, и сотня сообщений с разных
    # id — сотня параллельных обходов до 500 подписок по 10 с на каждую
    _subscribe(store, "anya", "Аня")
    entered, release = threading.Event(), threading.Event()
    sent = []

    def sender(sub, payload, *_):
        entered.set()
        release.wait(timeout=5)
        sent.append(payload["body"])
        return 201

    before = set(threading.enumerate())
    n = notify.Notifier(store, vapid=None, subject="s", sender=sender)
    n.on_message("petya", "Петя", "первое")
    assert entered.wait(timeout=5)                  # рассылка занята первым
    for i in range(2, 6):
        n.on_message("petya", "Петя", f"сообщение {i}")
    assert len(set(threading.enumerate()) - before) == 1
    release.set()
    for _ in range(250):
        if len(sent) == 2:
            break
        threading.Event().wait(0.02)
    # пока шла первая рассылка, четыре сообщения схлопнулись в последнее
    assert sent == ["первое", "сообщение 5"]


T0 = datetime(2026, 10, 1, 12, 0, 0, tzinfo=timezone.utc)


def _subscribe_at(store, listener, now):
    sub, _ = push.check_subscription(_subscription(f"{FCM}{listener}"))
    store.subscribe(sub, listener, listener, now=now)
    return sub["endpoint"]


def test_gone_subscription_is_forgotten_at_once(store):
    gone = _subscribe_at(store, "a", T0)
    kept = _subscribe_at(store, "b", T0)
    store.push_result(gone, 410, now=T0)
    assert [s["endpoint"] for s in store.subscriptions()] == [kept]
    store.push_result(kept, 404, now=T0)
    assert store.subscriptions() == []


def test_network_failure_on_our_side_never_erases_subscriptions(store):
    # код 0 — URLError, OSError, таймаут: обрыв интернета или DNS у комнаты.
    # Прежде пять таких отказов подряд стирали подписку, то есть пять
    # сообщений в чате во время обрыва — все подписки разом
    flaky = _subscribe_at(store, "a", T0)
    for day in range(60):
        store.push_result(flaky, 0, now=T0 + timedelta(days=day))
    assert [s["endpoint"] for s in store.subscriptions()] == [flaky]


def test_refusals_erase_only_a_subscription_without_success_for_a_month(store):
    flaky = _subscribe_at(store, "a", T0)
    # пачка отказов в первый же день — временная беда push-сервиса, а не смерть
    for _ in range(store_mod.PUSH_FAILURES_MAX * 3):
        store.push_result(flaky, 503, now=T0 + timedelta(hours=1))
    assert store.subscriptions()
    store.push_result(flaky, 201, now=T0 + timedelta(days=10))    # жива
    late = T0 + timedelta(days=10 + store_mod.PUSH_STALE_DAYS + 1)
    # успеха нет больше месяца, но отказов ещё мало — рано
    for _ in range(store_mod.PUSH_FAILURES_MAX - 1):
        store.push_result(flaky, 429, now=late)
    assert store.subscriptions()
    store.push_result(flaky, 500, now=late)
    assert store.subscriptions() == []


def test_database_from_before_success_times_keeps_its_subscriptions(tmp_path):
    # room.db на станции заведён без времени последнего успеха: колонка
    # появляется сама, а старые строки получают отсрочку от первого старта,
    # а не стираются первым же отказом из-за давней даты подписки
    path = tmp_path / "room.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE push_subscriptions (endpoint TEXT PRIMARY KEY, "
               "p256dh TEXT NOT NULL, auth TEXT NOT NULL, listener_id TEXT NOT NULL, "
               "name TEXT NOT NULL, created_at TEXT NOT NULL, "
               "failures INTEGER NOT NULL DEFAULT 0)")
    db.execute("INSERT INTO push_subscriptions VALUES (?, 'k', 'a', 'l1', 'Аня', ?, ?)",
               (FCM, (T0 - timedelta(days=90)).isoformat(), store_mod.PUSH_FAILURES_MAX))
    db.commit()
    db.close()
    s = store_mod.Store(str(path), now=T0)
    try:
        s.push_result(FCM, 503, now=T0 + timedelta(days=1))
        assert [x["endpoint"] for x in s.subscriptions()] == [FCM]
        s.push_result(FCM, 503, now=T0 + timedelta(days=store_mod.PUSH_STALE_DAYS + 1))
        assert s.subscriptions() == []
    finally:
        s.close()
    # повторный старт колонку не заводит заново и не падает
    store_mod.Store(str(path), now=T0).close()


def _turn(text, aired, kind="chat"):
    return {"role": "segment", "kind": kind, "text": text, "meta": {"airedAt": aired}}


def test_dj_reply_rings_once_and_history_never(store):
    _subscribe(store, "anya", "Аня")
    window = [_turn("старый ответ", "2026-09-23T10:00:00Z"),
              _turn("это была подводка", "2026-09-23T10:01:00Z", kind="link")]
    replies = []
    n = notify.Notifier(store, vapid=None, subject="s", wake=Inline(),
                        sender=lambda sub, payload, *_: replies.append(payload["body"]) or 201)
    watch = notify.DjWatch(lambda: list(window), n, store)
    assert watch.tick() == 0                           # засев: история — не новость
    window.append(_turn("Аня, ставлю Кино", "2026-09-23T10:05:00Z"))
    assert watch.tick() == 1
    assert watch.tick() == 0                           # второй опрос — та же реплика
    assert replies == ["Аня, ставлю Кино"]


def test_dj_watch_does_not_poll_the_station_without_subscribers(store):
    calls = []
    watch = notify.DjWatch(lambda: calls.append(1) or [], notify.Notifier(store, None, "s"),
                           store)
    watch.tick()
    assert calls == []


# --- ручки -------------------------------------------------------------------

@pytest.fixture
def room(tmp_path):
    store = store_mod.Store(str(tmp_path / "room.db"))
    delivered = []
    notifier = notify.Notifier(
        store, push.Vapid(ec.generate_private_key(ec.SECP256R1())), "https://fm.example.org",
        wake=Inline(),
        sender=lambda sub, payload, *_: delivered.append((sub["listener_id"], payload)) or 201)
    config = server_mod.Config(rate_seconds=60, rate_max=10, max_body=8192,
                               notifier=notifier)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(store, config))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", store, notifier, delivered
    srv.shutdown()
    srv.server_close()
    store.close()


def call(base, path, body=None, listener="anya", name="Аня"):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "X-Listener-Id": listener,
               "X-Listener-Name": urllib.parse.quote(name)}
    req = urllib.request.Request(base + path, data=data,
                                 method="POST" if data else "GET", headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


def test_player_gets_the_public_key(room):
    base, _, notifier, _ = room
    assert call(base, "/push/key") == (200, {"key": notifier.vapid.public_key})


def test_subscribe_then_a_message_from_another_reaches_the_subscriber(room):
    base, store, notifier, delivered = room
    # Комната отвечает 201 раньше, чем зовёт уведомитель (отправитель не ждёт
    # push-сервис), поэтому проверка ждёт конца on_message, а не ответа.
    handled = threading.Semaphore(0)
    on_message = notifier.on_message
    notifier.on_message = lambda *a: (on_message(*a), handled.release())
    status, _ = call(base, "/push/subscribe", {"subscription": _subscription()})
    assert status == 201
    assert [(s["listener_id"], s["name"]) for s in store.subscriptions()] == [("anya", "Аня")]
    assert call(base, "/messages", {"text": "Всем привет!"}, listener="petya",
                name="Петя")[0] == 201
    assert handled.acquire(timeout=5)
    assert [(who, p["body"]) for who, p in delivered] == [("anya", "Всем привет!")]
    # своё сообщение подписчику не приходит
    assert call(base, "/messages", {"text": "и вам привет"})[0] == 201
    assert handled.acquire(timeout=5)
    assert len(delivered) == 1


def test_subscription_outside_push_services_is_refused_by_the_route(room):
    base, store, _, _ = room
    status, body = call(base, "/push/subscribe",
                        {"subscription": _subscription("https://10.0.0.10/x")})
    assert status == 400 and "push-сервис" in body["error"]
    assert store.subscriptions() == []


def test_unsubscribe_forgets_the_browser(room):
    base, store, _, _ = room
    sub = _subscription()
    call(base, "/push/subscribe", {"subscription": sub})
    assert call(base, "/push/unsubscribe", {"endpoint": sub["endpoint"]}) == \
        (200, {"ok": True, "removed": True})
    assert store.subscriptions() == []


def test_without_push_the_routes_say_so(tmp_path):
    store = store_mod.Store(str(tmp_path / "room.db"))
    srv = ThreadingHTTPServer(("127.0.0.1", 0),
                              server_mod.build_handler(store, server_mod.Config()))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        assert call(base, "/push/key")[0] == 404
        assert call(base, "/push/subscribe", {"subscription": _subscription()})[0] == 404
    finally:
        srv.shutdown()
        srv.server_close()
        store.close()


def test_subscription_over_the_cap_is_refused_but_renewal_is_not(tmp_path):
    store = store_mod.Store(str(tmp_path / "room.db"))
    notifier = notify.Notifier(
        store, push.Vapid(ec.generate_private_key(ec.SECP256R1())), "https://fm.example.org",
        wake=Inline())
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(
        store, server_mod.Config(notifier=notifier, push_max=1)))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        first = _subscription()
        assert call(base, "/push/subscribe", {"subscription": first})[0] == 201
        assert call(base, "/push/subscribe", {"subscription": _subscription(f"{FCM}petya")},
                    listener="petya", name="Петя")[0] == 429
        assert call(base, "/push/subscribe", {"subscription": first})[0] == 201
        assert len(store.subscriptions()) == 1
    finally:
        srv.shutdown()
        srv.server_close()
        store.close()


def test_one_listener_cannot_hold_more_than_its_share_of_subscriptions(tmp_path):
    store = store_mod.Store(str(tmp_path / "room.db"))
    notifier = notify.Notifier(
        store, push.Vapid(ec.generate_private_key(ec.SECP256R1())), "https://fm.example.org",
        wake=Inline())
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(
        store, server_mod.Config(notifier=notifier, push_per_listener=2)))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    try:
        base = f"http://127.0.0.1:{srv.server_address[1]}"
        for i in range(5):
            assert call(base, "/push/subscribe",
                        {"subscription": _subscription(f"{FCM}{i}")})[0] == 201
        assert [s["endpoint"] for s in store.subscriptions()
                if s["listener_id"] == "anya"] == [f"{FCM}3", f"{FCM}4"]
    finally:
        srv.shutdown()
        srv.server_close()
        store.close()
