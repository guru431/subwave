"""Лента комнаты в SQLite.

База лежит на локальном диске хоста, не на шаре: SQLite на CIFS повреждается —
правило проекта. Таблица одна: и лента, и источник ответа на вопрос «сколько
этот слушатель написал за последнюю минуту». Второе хранилище ради счётчиков
дало бы два места, где живёт одна и та же правда.

Время передаётся параметром `now`, а не берётся изнутри: тест, зависящий от
календаря, зелёный через раз — тоже правило проекта.
"""
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,
  listener_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  text        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_at ON messages (at);
CREATE INDEX IF NOT EXISTS messages_listener ON messages (listener_id, at);

-- подписки Web Push: адрес push-сервиса браузера и ключи шифрования.
-- `name` — имя слушателя на момент подписки, по нему ловится упоминание;
-- `last_success_at` — последний 2xx push-сервиса (NULL — успеха ещё не было)
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint        TEXT PRIMARY KEY,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  listener_id     TEXT NOT NULL,
  name            TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  failures        INTEGER NOT NULL DEFAULT 0,
  last_success_at TEXT
);

-- дизлайки слушателей: одна отметка слушателя на цель. target — song_id у
-- track, norm(artist) у artist; artist_key есть у всех строк: по нему дизлайки
-- песен складываются в предложение исполнителя
CREATE TABLE IF NOT EXISTS dislikes (
  listener_id TEXT NOT NULL,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  target      TEXT NOT NULL,
  artist_key  TEXT NOT NULL,
  song_id     TEXT NOT NULL,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  album       TEXT NOT NULL,
  at          TEXT NOT NULL,
  PRIMARY KEY (listener_id, kind, target)
);
CREATE INDEX IF NOT EXISTS dislikes_artist ON dislikes (artist_key);

-- решение владельца по предложению (keep | blocked) и его время
CREATE TABLE IF NOT EXISTS dislike_decisions (
  kind       TEXT NOT NULL,
  target     TEXT NOT NULL,
  action     TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (kind, target)
);
"""

# Подписка забывается по отказам, только если их подряд не меньше
# PUSH_FAILURES_MAX И успеха не было дольше PUSH_STALE_DAYS: так выглядит
# браузер, который удалили, не отписавшись. Одного счётчика мало — пачка 5xx
# за вечер означает беду push-сервиса, а не смерть подписки.
PUSH_FAILURES_MAX = 5
PUSH_STALE_DAYS = 30
PUSH_GONE = (404, 410)
# Сколько дней хранится лента. Она открыта всем, кто знает адрес станции,
# поэтому короткая память — часть защиты; неделя — то, что нужно от чата
# ведущему и слушателям.
RETENTION_DAYS = 7


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).isoformat(timespec="seconds")


def _iso_ms(moment: datetime) -> str:
    """Время дизлайков и решений — с миллисекундами: решение владельца и
    дизлайк в одну секунду иначе были бы неразличимы, и новый дизлайк не
    вернул бы строку, скрытую решением."""
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds")


class Store:
    def __init__(self, path: str, retention_days: int = RETENTION_DAYS,
                 now: datetime | None = None):
        # check_same_thread=False: сервер — ThreadingHTTPServer, соединение одно
        # на процесс. Блокировка — потому что рассылка push идёт фоновым
        # потоком: пара «запрос + commit» из двух потоков иначе может сойтись
        # на одном соединении и зафиксировать чужую половину.
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate(now or datetime.now(timezone.utc))
        self.db.commit()
        self.retention_days = retention_days
        self.lock = threading.Lock()

    def _migrate(self, now: datetime) -> None:
        """Довести базу прежней схемы. `CREATE TABLE IF NOT EXISTS` заводит
        новые таблицы сам, а новую колонку в старой таблице — нет.

        `last_success_at` у подписок, заведённых до неё, ставится временем
        этого старта: о прошлых успехах ничего не известно, и отсчёт от даты
        подписки стёр бы давние подписки первым же отказом.
        """
        columns = {r["name"] for r in self.db.execute(
            "PRAGMA table_info(push_subscriptions)")}
        if "last_success_at" not in columns:
            # Колонка и её заполнение — одной транзакцией: упади процесс между
            # ними, следующий старт увидел бы колонку и не заполнил её вовсе
            self.db.execute("BEGIN")
            self.db.execute("ALTER TABLE push_subscriptions ADD COLUMN last_success_at TEXT")
            self.db.execute("UPDATE push_subscriptions SET last_success_at = ?", (_iso(now),))

    def close(self) -> None:
        self.db.close()

    def add(self, listener_id: str, name: str, text: str,
            now: datetime | None = None,
            rate: tuple[int, int] | None = None,
            room_rate: tuple[int, int] | None = None) -> dict | str:
        """Добавить сообщение. `rate` — (секунд, сообщений): лимит слушателя;
        `room_rate` — такой же, но на всю комнату. Исчерпан — строка-причина
        (`"listener"` или `"room"`), и ничего не добавлено.

        Общий потолок нужен потому, что `listener_id` выбирает сам клиент: новый
        id на каждое сообщение снимал бы личный лимит целиком. Личный
        проверяется первым — исчерпавшему свой честнее сказать про него.

        Подсчёт и вставка — под одной блокировкой, как у set_dislike: иначе два
        запроса разом прошли бы проверку оба.
        """
        now = now or datetime.now(timezone.utc)
        moment = _iso(now)
        with self.lock:
            if rate is not None:
                seconds, cap = rate
                (count,) = self.db.execute(
                    "SELECT COUNT(*) FROM messages WHERE listener_id = ? AND at > ?",
                    (listener_id, _iso(now - timedelta(seconds=seconds)))).fetchone()
                if count >= cap:
                    return "listener"
            if room_rate is not None:
                seconds, cap = room_rate
                (count,) = self.db.execute(
                    "SELECT COUNT(*) FROM messages WHERE at > ?",
                    (_iso(now - timedelta(seconds=seconds)),)).fetchone()
                if count >= cap:
                    return "room"
            cur = self.db.execute(
                "INSERT INTO messages (at, listener_id, name, text) VALUES (?, ?, ?, ?)",
                (moment, listener_id, name, text))
            self.db.commit()
        return {"id": cur.lastrowid, "at": moment, "name": name, "text": text}

    def since(self, after_id: int, limit: int) -> list[dict]:
        """Сообщения после `after_id`, не больше `limit` — самые свежие.

        Лимит режет хвост, а не голову: если за время отсутствия написали
        сотню сообщений, читать надо последние, а не первые.
        """
        with self.lock:
            rows = self.db.execute(
                "SELECT id, at, name, text FROM messages WHERE id > ? "
                "ORDER BY id DESC LIMIT ?", (after_id, limit)).fetchall()
        return [dict(r) for r in reversed(rows)]

    def prune(self, now: datetime | None = None) -> int:
        """Удалить сообщения старше срока хранения. Возвращает число удалённых.

        `AUTOINCREMENT` в схеме стоит ради этого: без него SQLite переиспользует
        освободившиеся id, и курсор навыка («прочитано до N») начал бы
        пропускать новые сообщения с уже виденными номерами.
        """
        edge = _iso((now or datetime.now(timezone.utc))
                    - timedelta(days=self.retention_days))
        with self.lock:
            cur = self.db.execute("DELETE FROM messages WHERE at <= ?", (edge,))
            self.db.commit()
        return cur.rowcount

    def subscribe(self, sub: dict, listener_id: str, name: str,
                  now: datetime | None = None, cap: int | None = None,
                  per_listener: int | None = None) -> bool:
        """Завести или обновить подписку. Повторная подписка того же браузера —
        обычное дело (плеер переподписывается при каждом открытии, чтобы имя
        для упоминаний не отставало), поэтому это upsert, а не отказ.

        Счётчик отказов upsert не трогает: переподписаться может кто угодно
        снаружи, и обнуление держало бы мёртвый адрес в рассылке вечно.

        `cap` — потолок подписок: новую сверх него не заводим (False), прежнюю
        обновляем всегда. `per_listener` — потолок на один `listener_id`: новая
        подписка сверх него вытесняет самую старую того же слушателя. Один id —
        один браузер, и лишние адреса у него — брошенные прежние подписки;
        отказ оставил бы настоящего слушателя без уведомлений из-за них.
        Проверка и вставка — под одной блокировкой.
        """
        with self.lock:
            known = self.db.execute(
                "SELECT 1 FROM push_subscriptions WHERE endpoint = ?",
                (sub["endpoint"],)).fetchone()
            if not known and per_listener is not None:
                self.db.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint IN ("
                    " SELECT endpoint FROM push_subscriptions WHERE listener_id = ?"
                    " ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
                    (listener_id, max(per_listener - 1, 0)))
            if cap is not None and not known:
                (count,) = self.db.execute(
                    "SELECT COUNT(*) FROM push_subscriptions").fetchone()
                if count >= cap:
                    self.db.rollback()
                    return False
            self.db.execute(
                "INSERT INTO push_subscriptions "
                "(endpoint, p256dh, auth, listener_id, name, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET "
                "p256dh = excluded.p256dh, auth = excluded.auth, "
                "listener_id = excluded.listener_id, name = excluded.name",
                (sub["endpoint"], sub["p256dh"], sub["auth"], listener_id, name,
                 _iso(now or datetime.now(timezone.utc))))
            self.db.commit()
        return True

    def unsubscribe(self, endpoint: str) -> bool:
        with self.lock:
            cur = self.db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?",
                                  (endpoint,))
            self.db.commit()
        return cur.rowcount > 0

    def subscriptions(self) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT endpoint, p256dh, auth, listener_id, name "
                "FROM push_subscriptions").fetchall()
        return [dict(r) for r in rows]

    def push_result(self, endpoint: str, status: int,
                    now: datetime | None = None) -> None:
        """Учесть ответ push-сервиса.

        404/410 — подписки больше нет, она забывается сразу. Успех обнуляет
        счётчик отказов и помечает время. 0 — сбой на стороне комнаты (сеть,
        DNS, таймаут; см. push.send): подписка тут ни при чём, и он не
        считается вовсе — иначе пять сообщений в чате во время обрыва стёрли
        бы все подписки разом. Прочий отказ (429, 5xx, …) растит счётчик, а
        подписку забывает, только если отказов подряд не меньше
        PUSH_FAILURES_MAX и успеха (или, пока его не было, подписки) нет
        дольше PUSH_STALE_DAYS.
        """
        if status == 0:
            return
        moment = now or datetime.now(timezone.utc)
        with self.lock:
            if status in PUSH_GONE:
                self.db.execute("DELETE FROM push_subscriptions WHERE endpoint = ?",
                                (endpoint,))
            elif 200 <= status < 300:
                self.db.execute("UPDATE push_subscriptions SET failures = 0, "
                                "last_success_at = ? WHERE endpoint = ?",
                                (_iso(moment), endpoint))
            else:
                self.db.execute("UPDATE push_subscriptions SET failures = failures + 1 "
                                "WHERE endpoint = ?", (endpoint,))
                self.db.execute(
                    "DELETE FROM push_subscriptions WHERE endpoint = ? AND failures >= ? "
                    "AND COALESCE(last_success_at, created_at) <= ?",
                    (endpoint, PUSH_FAILURES_MAX,
                     _iso(moment - timedelta(days=PUSH_STALE_DAYS))))
            self.db.commit()

    def set_dislike(self, row: dict, cap: int, now: datetime | None = None) -> str:
        """Поставить отметку: 'added', 'exists' (уже стояла — время не
        трогаем) или 'full' (в таблице уже `cap` записей).

        Проверка потолка и вставка — под одной блокировкой: иначе два запроса
        разом прошли бы проверку оба.
        """
        moment = _iso_ms(now or datetime.now(timezone.utc))
        with self.lock:
            if self.db.execute(
                    "SELECT 1 FROM dislikes WHERE listener_id = ? AND kind = ? "
                    "AND target = ?",
                    (row["listener_id"], row["kind"], row["target"])).fetchone():
                return "exists"
            (count,) = self.db.execute("SELECT COUNT(*) FROM dislikes").fetchone()
            if count >= cap:
                return "full"
            self.db.execute(
                "INSERT INTO dislikes (listener_id, name, kind, target, artist_key, "
                "song_id, title, artist, album, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (row["listener_id"], row["name"], row["kind"], row["target"],
                 row["artist_key"], row["song_id"], row["title"], row["artist"],
                 row["album"], moment))
            self.db.commit()
        return "added"

    def unset_dislike(self, listener_id: str, kind: str, target: str) -> bool:
        with self.lock:
            cur = self.db.execute(
                "DELETE FROM dislikes WHERE listener_id = ? AND kind = ? AND target = ?",
                (listener_id, kind, target))
            self.db.commit()
        return cur.rowcount > 0

    def rename_listener(self, listener_id: str, name: str) -> None:
        """Имя слушателя — во все его записи: назвался позже — владелец увидит
        имя и у прежних отметок."""
        with self.lock:
            self.db.execute("UPDATE dislikes SET name = ? WHERE listener_id = ?",
                            (name, listener_id))
            self.db.commit()

    def listener_dislikes(self, listener_id: str) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT kind, target FROM dislikes WHERE listener_id = ?",
                (listener_id,)).fetchall()
        return [dict(r) for r in rows]

    def all_dislikes(self) -> list[dict]:
        with self.lock:
            rows = self.db.execute(
                "SELECT listener_id, name, kind, target, artist_key, song_id, "
                "title, artist, album, at FROM dislikes").fetchall()
        return [dict(r) for r in rows]

    def has_dislikes(self, kind: str, target: str) -> bool:
        """Есть ли у цели хоть один вклад. У исполнителя вклад — и явный
        дизлайк, и дизлайк любой его песни: предложение исполнителя бывает и
        без явного дизлайка."""
        if kind == "artist":
            sql = ("SELECT 1 FROM dislikes WHERE (kind = 'artist' AND target = ?) "
                   "OR (kind = 'track' AND artist_key = ?) LIMIT 1")
            args: tuple = (target, target)
        else:
            sql = "SELECT 1 FROM dislikes WHERE kind = 'track' AND target = ? LIMIT 1"
            args = (target,)
        with self.lock:
            return self.db.execute(sql, args).fetchone() is not None

    def decide(self, kind: str, target: str, action: str,
               now: datetime | None = None) -> None:
        """Записать решение владельца; новое решение заменяет прежнее."""
        moment = _iso_ms(now or datetime.now(timezone.utc))
        with self.lock:
            self.db.execute(
                "INSERT INTO dislike_decisions (kind, target, action, decided_at) "
                "VALUES (?, ?, ?, ?) ON CONFLICT(kind, target) DO UPDATE SET "
                "action = excluded.action, decided_at = excluded.decided_at",
                (kind, target, action, moment))
            self.db.commit()

    def decisions(self) -> dict[tuple[str, str], str]:
        with self.lock:
            rows = self.db.execute(
                "SELECT kind, target, decided_at FROM dislike_decisions").fetchall()
        return {(r["kind"], r["target"]): r["decided_at"] for r in rows}
