"""Что из чата будит закрытую вкладку и кому это отправить.

Правило то же, что у плеера (`web/lib/roomRules.ts`): громко звучит каждое
чужое сообщение и ответ ведущего в чат (реплика с `kind == "chat"`). Так решил
владелец 2026-09-23 — до того громким было только упоминание имени, и на «Всем
привет!» от другого слушателя не всплывало ничего. Своё не звенит: автор
узнаётся по id слушателя и по имени, чтобы молчало и собственное сообщение,
отправленное с другого устройства. Две реализации одного правила — цена того,
что плеер живёт в браузере, а закрытую вкладку может разбудить только сервер;
тесты держат их на одних примерах.

Ответ ведущего комната узнаёт опросом ленты сессии контроллера (`/session` —
та же ручка, что читает плеер): контроллер о комнате не знает, и учить его
этому ради одного события значило бы ещё одну правку форка.
"""
import json
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request

import push

CHAT_SKILL = "chat"
BODY_MAX = 180            # шторка всё равно обрежет, а полезная нагрузка не резиновая
WATCH_INTERVAL_SEC = 20
WATCH_TIMEOUT_SEC = 10


def fold(text: str) -> str:
    """Свёртка как у `fold()` плеера: регистр, ё=е, латинская диакритика."""
    text = (text or "").lower().replace("ё", "е")
    text = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in text if not 0x300 <= ord(ch) <= 0x36F).strip()


def is_author(sub: dict, author_id: str, author: str) -> bool:
    """Подписка принадлежит автору сообщения: тот же слушатель либо то же имя
    (другое устройство того же человека). Пустое имя подписки — только по id."""
    name = fold(sub.get("name", ""))
    return sub["listener_id"] == author_id or (bool(name) and name == fold(author))


def turn_key(turn: dict) -> str:
    """Опознание реплики, как `turnKey()` плеера: время эфира плюс начало текста."""
    meta = turn.get("meta") if isinstance(turn.get("meta"), dict) else {}
    aired = meta.get("airedAt")
    stamp = aired if isinstance(aired, str) else str(turn.get("t", ""))
    return f"{stamp}|{(turn.get('text') or '')[:64]}"


def _clip(text: str) -> str:
    return text if len(text) <= BODY_MAX else text[:BODY_MAX - 1].rstrip() + "…"


class Notifier:
    """Рассылка важного подписчикам — одним фоновым потоком на всю комнату.

    Слушатель, написавший в чат, не ждёт, пока комната обойдёт push-сервисы:
    сообщение только встаёт в очередь. Очередь — по адресу подписки, и новое
    сообщение заменяет неотправленное тому же адресату: в шторке у чата всё
    равно одна карточка (тег `subwave-chat`, `Topic` у push-сервиса). Поэтому
    очередь не длиннее числа подписок, сколько бы сообщений ни пришло, пока
    рассылка занята. Прежде каждое сообщение запускало свой поток, и сотня
    сообщений с разных id — сотня параллельных обходов до 500 подписок.
    """

    def __init__(self, store, vapid: "push.Vapid", subject: str, sender=push.send,
                 wake=None):
        self.store = store
        self.vapid = vapid
        self.subject = subject
        self.sender = sender
        self.pending: dict[str, tuple[dict, dict]] = {}
        self.lock = threading.Lock()
        self.ready = threading.Event()
        self.worker: threading.Thread | None = None
        # wake(drain) — как запустить доставку. По умолчанию будится один
        # фоновый поток; тест передаёт свой вызов, чтобы проверять, что
        # уехало, а не планировщик
        self.wake = wake or self._wake_worker

    def on_message(self, author_id: str, author: str, text: str) -> int:
        targets = [s for s in self.store.subscriptions()
                   if not is_author(s, author_id, author)]
        if targets:
            self._enqueue(targets, {"title": f"{author} — в чате", "body": _clip(text)})
        return len(targets)

    def on_dj_reply(self, text: str) -> int:
        targets = self.store.subscriptions()
        if targets:
            self._enqueue(targets, {"title": "Ведущий ответил", "body": _clip(text)})
        return len(targets)

    def _enqueue(self, targets: list[dict], payload: dict) -> None:
        # тег один на весь чат — тот же, что у уведомления страницы: живая
        # вкладка и push-сервис не выстроят в шторке двух карточек об одном
        payload = {**payload, "tag": "subwave-chat", "url": "/?chat=1"}
        with self.lock:
            for sub in targets:
                self.pending[sub["endpoint"]] = (sub, payload)
        self.wake(self.drain)

    def _wake_worker(self, _drain) -> None:
        with self.lock:
            if self.worker is None:
                self.worker = threading.Thread(target=self._run, name="room-push",
                                               daemon=True)
                self.worker.start()
        self.ready.set()

    def _run(self) -> None:
        while True:
            self.ready.wait()
            # сбросить ДО того, как забрать очередь: пришедшее после — в
            # следующий круг, пришедшее раньше — уже в этой пачке
            self.ready.clear()
            try:
                self.drain()
            except Exception as e:                      # noqa: BLE001
                # поток рассылки один на комнату — умереть ему нельзя
                print(f"room: рассылка push: {e!r}", file=sys.stderr, flush=True)

    def drain(self) -> int:
        """Отправить всё, что ждёт в очереди. Возвращает число отправок."""
        with self.lock:
            batch, self.pending = list(self.pending.values()), {}
        for sub, payload in batch:
            try:
                status = self.sender(sub, payload, self.vapid, self.subject)
            except Exception as e:                      # noqa: BLE001
                # чужой сломанный ключ не должен ронять рассылку остальным. В
                # журнал — только хост: путь адреса и есть токен подписки
                host = urllib.parse.urlsplit(sub["endpoint"]).hostname
                print(f"room: push на {host}: {type(e).__name__}", file=sys.stderr, flush=True)
                status = 0
            self.store.push_result(sub["endpoint"], status)
        return len(batch)


def fetch_session(base: str, timeout: float = WATCH_TIMEOUT_SEC) -> list[dict]:
    with urllib.request.urlopen(base.rstrip("/") + "/session", timeout=timeout) as r:
        payload = json.loads(r.read().decode("utf-8", "replace"))
    turns = payload.get("messages") if isinstance(payload, dict) else None
    return [t for t in turns if isinstance(t, dict)] if isinstance(turns, list) else []


class DjWatch:
    """Опрос ленты станции: новый ответ ведущего в чат → push всем подписчикам.

    Первый удачный опрос только засевает виденное: история в окне ленты — не
    новость, иначе каждый рестарт комнаты звонил бы всем по старым репликам.
    Пока подписчиков нет, станцию не спрашивает вовсе.
    """

    def __init__(self, fetch, notifier: Notifier, store):
        self.fetch = fetch
        self.notifier = notifier
        self.store = store
        self.seen: set[str] | None = None

    def tick(self) -> int:
        if not self.store.subscriptions():
            return 0
        replies = [t for t in self.fetch() if t.get("kind") == CHAT_SKILL and t.get("text")]
        keys = [turn_key(t) for t in replies]
        if self.seen is None:
            self.seen = set(keys)
            return 0
        fresh = [t for t, k in zip(replies, keys) if k not in self.seen]
        # помнить только то, что ещё в окне ленты: иначе множество растёт вечно
        self.seen = set(keys)
        for turn in fresh:
            self.notifier.on_dj_reply(turn["text"])
        return len(fresh)

    def run(self, interval: float = WATCH_INTERVAL_SEC) -> None:
        while True:
            try:
                self.tick()
            except Exception as e:                      # noqa: BLE001
                # станция на перезапуске — не повод останавливать наблюдение
                print(f"room: лента станции: {e!r}", file=sys.stderr, flush=True)
            time.sleep(interval)
