"""store.py: лента комнаты и частотный лимит на одной таблице.

Второго хранилища для лимитов нет намеренно: «сколько этот слушатель написал за
минуту» — вопрос к тем же сообщениям.
"""
import importlib.util
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

STORE = Path(__file__).resolve().parent.parent / "room" / "store.py"
_spec = importlib.util.spec_from_file_location("room_store", STORE)
store_mod = importlib.util.module_from_spec(_spec)
sys.modules["room_store"] = store_mod
_spec.loader.exec_module(store_mod)

T0 = datetime(2026, 9, 22, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def store(tmp_path):
    s = store_mod.Store(str(tmp_path / "room.db"))
    yield s
    s.close()


def test_added_message_comes_back(store):
    rec = store.add("l1", "Аня", "привет", now=T0)
    assert rec["id"] == 1 and rec["name"] == "Аня" and rec["text"] == "привет"
    assert store.since(0, 10) == [rec]


def test_since_returns_only_newer(store):
    first = store.add("l1", "Аня", "раз", now=T0)
    second = store.add("l2", "Боря", "два", now=T0)
    assert [m["id"] for m in store.since(first["id"], 10)] == [second["id"]]


def test_since_limit_keeps_the_newest(store):
    for i in range(5):
        store.add("l1", "Аня", f"сообщение {i}", now=T0)
    got = store.since(0, 2)
    # лимит режет хвост, а не голову: свежее важнее старого
    assert [m["text"] for m in got] == ["сообщение 3", "сообщение 4"]


def test_order_is_chronological(store):
    store.add("l1", "Аня", "раз", now=T0)
    store.add("l1", "Аня", "два", now=T0)
    assert [m["text"] for m in store.since(0, 10)] == ["раз", "два"]


def test_rate_counts_only_this_listener(store):
    store.add("l1", "Аня", "раз", now=T0)
    store.add("l2", "Боря", "два", now=T0)
    assert isinstance(store.add("l1", "Аня", "ещё", now=T0, rate=(60, 2)), dict)
    assert store.add("l1", "Аня", "лишнее", now=T0, rate=(60, 2)) == "listener"


def test_room_rate_counts_every_listener(store):
    # id слушателя выбирает сам клиент: новый id на каждое сообщение снимал
    # личный лимит, и общего потолка на комнату не было вовсе
    for i in range(3):
        assert isinstance(store.add(f"l{i}", "Аня", "раз", now=T0,
                                    rate=(60, 10), room_rate=(60, 3)), dict)
    assert store.add("l9", "Боря", "четвёртое", now=T0,
                     rate=(60, 10), room_rate=(60, 3)) == "room"
    assert len(store.since(0, 10)) == 3
    # окно общее, но скользящее: через минуту комната снова принимает
    assert isinstance(store.add("l9", "Боря", "позже", now=T0 + timedelta(seconds=61),
                                rate=(60, 10), room_rate=(60, 3)), dict)


def test_listener_limit_is_named_before_the_room_one(store):
    # исчерпавшему СВОЙ лимит честнее сказать про него, а не про переполненный чат
    store.add("l1", "Аня", "раз", now=T0)
    assert store.add("l1", "Аня", "два", now=T0,
                     rate=(60, 1), room_rate=(60, 1)) == "listener"


def test_rate_ignores_older_than_window(store):
    store.add("l1", "Аня", "давно", now=T0 - timedelta(seconds=120))
    assert isinstance(store.add("l1", "Аня", "сейчас", now=T0, rate=(60, 1)), dict)


def test_rate_holds_against_simultaneous_posts(store):
    # подсчёт и вставка порознь пропускали оба запроса, пришедших разом
    import threading
    start = threading.Barrier(8)
    added = []

    def post():
        start.wait()
        added.append(store.add("l1", "Аня", "раз", rate=(60, 3)))

    threads = [threading.Thread(target=post) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(isinstance(r, dict) for r in added) == 3


def test_room_rate_holds_against_simultaneous_posts(store):
    # тот же гонщик, но с разных id: общий потолок считается под той же блокировкой
    import threading
    start = threading.Barrier(8)
    added = []

    def post(i):
        start.wait()
        added.append(store.add(f"l{i}", "Аня", "раз", rate=(60, 10), room_rate=(60, 3)))

    threads = [threading.Thread(target=post, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(isinstance(r, dict) for r in added) == 3


def test_subscription_cap_lets_a_known_browser_renew(store):
    sub = {"endpoint": "https://fcm.googleapis.com/a", "p256dh": "k", "auth": "a"}
    other = {**sub, "endpoint": "https://fcm.googleapis.com/b"}
    assert store.subscribe(sub, "l1", "Аня", cap=1)
    assert not store.subscribe(other, "l2", "Боря", cap=1)
    assert store.subscribe(sub, "l1", "Аня Н.", cap=1)        # переподписка — не новая
    assert [s["name"] for s in store.subscriptions()] == ["Аня Н."]


def _sub(tail):
    return {"endpoint": f"https://fcm.googleapis.com/{tail}", "p256dh": "k", "auth": "a"}


def test_new_subscription_over_the_listener_cap_replaces_its_own_oldest(store):
    # один id — один браузер; лишние адреса у него — брошенные прежние
    # подписки, а новые id ничего не стоят: потолок не даёт одному id занять
    # всю таблицу, а вытеснение — застрять настоящему слушателю
    store.subscribe(_sub("a1"), "l1", "Аня", now=T0, per_listener=2)
    store.subscribe(_sub("b1"), "l2", "Боря", now=T0, per_listener=2)
    store.subscribe(_sub("a2"), "l1", "Аня", now=T0 + timedelta(seconds=1), per_listener=2)
    assert store.subscribe(_sub("a3"), "l1", "Аня", now=T0 + timedelta(seconds=2),
                           per_listener=2)
    assert sorted(s["endpoint"].rsplit("/", 1)[1] for s in store.subscriptions()) == \
        ["a2", "a3", "b1"]
    # переподписка известного адреса никого не вытесняет
    store.subscribe(_sub("a2"), "l1", "Аня", now=T0 + timedelta(seconds=3), per_listener=2)
    assert len(store.subscriptions()) == 3


def _failures(store, tail):
    (n,) = store.db.execute("SELECT failures FROM push_subscriptions WHERE endpoint = ?",
                            (_sub(tail)["endpoint"],)).fetchone()
    return n


def test_resubscription_keeps_the_failure_count(store):
    # переподписка обнуляла счётчик отказов: мёртвый адрес, переподписанный
    # снаружи, не забывался никогда
    store.subscribe(_sub("a1"), "l1", "Аня", now=T0)
    store.push_result(_sub("a1")["endpoint"], 503)
    store.push_result(_sub("a1")["endpoint"], 503)
    store.subscribe(_sub("a1"), "l1", "Аня Н.", now=T0)
    assert _failures(store, "a1") == 2
    assert [s["name"] for s in store.subscriptions()] == ["Аня Н."]


def test_prune_drops_old_and_keeps_fresh(store):
    store.add("l1", "Аня", "древнее", now=T0 - timedelta(days=30))
    fresh = store.add("l1", "Аня", "свежее", now=T0)
    assert store.prune(now=T0) == 1
    assert [m["id"] for m in store.since(0, 10)] == [fresh["id"]]


def test_feed_is_kept_for_a_week_by_default(store):
    # лента открыта всем, кто знает адрес станции: короткая память — часть
    # защиты, и неделя — то, что ведущему и слушателям нужно от чата
    store.add("l1", "Аня", "восемь дней назад", now=T0 - timedelta(days=8))
    kept = store.add("l1", "Аня", "шесть дней назад", now=T0 - timedelta(days=6))
    assert store.prune(now=T0) == 1
    assert [m["id"] for m in store.since(0, 10)] == [kept["id"]]


def test_prune_on_read_runs_at_most_once_per_interval(store):
    # путь чтения открыт наружу: DELETE с commit на каждый запрос — лишняя
    # работа, а при сроке хранения в неделю десять минут ничего не решают
    store.add("l1", "Аня", "древнее", now=T0 - timedelta(days=30))
    assert store.prune_on_read(now=T0) == 1
    store.add("l1", "Аня", "тоже древнее", now=T0 - timedelta(days=30))
    assert store.prune_on_read(now=T0 + timedelta(minutes=1)) == 0
    assert len(store.since(0, 10)) == 1
    assert store.prune_on_read(now=T0 + store_mod.PRUNE_READ_EVERY) == 1
    assert store.since(0, 10) == []


def test_reopened_store_keeps_messages(tmp_path):
    path = str(tmp_path / "room.db")
    s = store_mod.Store(path)
    s.add("l1", "Аня", "переживу рестарт", now=T0)
    s.close()
    s2 = store_mod.Store(path)
    assert [m["text"] for m in s2.since(0, 10)] == ["переживу рестарт"]
    s2.close()


def test_ids_keep_growing_after_prune(tmp_path):
    # id — курсор навыка «что уже прочитано»; переиспользованный id после
    # чистки заставил бы ведущего пропустить сообщение
    s = store_mod.Store(str(tmp_path / "room.db"))
    old = s.add("l1", "Аня", "древнее", now=T0 - timedelta(days=30))
    s.prune(now=T0)
    new = s.add("l1", "Аня", "свежее", now=T0)
    assert new["id"] > old["id"]
    s.close()


def dis(listener="l1", kind="track", target="s1", song_id="s1", name=""):
    """Строка дизлайка для Store.set_dislike — как её собирает server.py."""
    return {"listener_id": listener, "name": name, "kind": kind, "target": target,
            "artist_key": "кино", "song_id": song_id, "title": "Звезда",
            "artist": "Кино", "album": "Звезда по имени Солнце"}


def ms(moment):
    return moment.isoformat(timespec="milliseconds")


def test_dislike_is_stored_once_and_keeps_its_time(store):
    assert store.set_dislike(dis(), cap=10, now=T0) == "added"
    assert store.set_dislike(dis(), cap=10, now=T0 + timedelta(minutes=5)) == "exists"
    rows = store.all_dislikes()
    assert len(rows) == 1 and rows[0]["at"] == ms(T0)


def test_cap_refuses_new_rows_but_not_repeats(store):
    assert store.set_dislike(dis(), cap=1, now=T0) == "added"
    assert store.set_dislike(dis(target="s2", song_id="s2"), cap=1, now=T0) == "full"
    assert store.set_dislike(dis(), cap=1, now=T0) == "exists"


def test_unset_removes_only_that_mark(store):
    store.set_dislike(dis(), cap=10, now=T0)
    store.set_dislike(dis(kind="artist", target="кино"), cap=10, now=T0)
    assert store.unset_dislike("l1", "track", "s1") is True
    assert store.unset_dislike("l1", "track", "s1") is False
    assert store.listener_dislikes("l1") == [{"kind": "artist", "target": "кино"}]


def test_undo_and_redo_is_a_new_dislike(store):
    store.set_dislike(dis(), cap=10, now=T0)
    store.unset_dislike("l1", "track", "s1")
    store.set_dislike(dis(), cap=10, now=T0 + timedelta(minutes=1))
    assert store.all_dislikes()[0]["at"] == ms(T0 + timedelta(minutes=1))


def test_rename_reaches_every_row_of_the_listener(store):
    store.set_dislike(dis(), cap=10, now=T0)
    store.set_dislike(dis(target="s2", song_id="s2"), cap=10, now=T0)
    store.set_dislike(dis(listener="l2", name="Боря"), cap=10, now=T0)
    store.rename_listener("l1", "Аня")
    names = {(r["listener_id"], r["song_id"]): r["name"] for r in store.all_dislikes()}
    assert names == {("l1", "s1"): "Аня", ("l1", "s2"): "Аня", ("l2", "s1"): "Боря"}


def test_artist_has_dislikes_through_its_songs(store):
    store.set_dislike(dis(), cap=10, now=T0)
    assert store.has_dislikes("track", "s1") is True
    assert store.has_dislikes("artist", "кино") is True     # явного нет, есть песня
    assert store.has_dislikes("track", "s2") is False
    assert store.has_dislikes("artist", "ария") is False


def test_new_decision_replaces_the_old_one(store):
    store.decide("track", "s1", "keep", now=T0)
    store.decide("track", "s1", "blocked", now=T0 + timedelta(minutes=1))
    assert store.decisions() == {("track", "s1"): ms(T0 + timedelta(minutes=1))}


def test_prune_leaves_dislikes_alone(store):
    # чистка по возрасту — для ленты; дизлайки хранятся бессрочно
    store.set_dislike(dis(), cap=10, now=T0 - timedelta(days=30))
    store.prune(now=T0)
    assert len(store.all_dislikes()) == 1


def test_dislikes_survive_reopen(tmp_path):
    path = str(tmp_path / "room.db")
    s = store_mod.Store(path)
    s.set_dislike(dis(), cap=10, now=T0)
    s.decide("track", "s1", "keep", now=T0)
    s.close()
    s2 = store_mod.Store(path)
    assert len(s2.all_dislikes()) == 1 and ("track", "s1") in s2.decisions()
    s2.close()


def test_database_from_before_dislikes_gets_the_tables(tmp_path):
    # room.db на станции заведён до дизлайков: таблицы должны появиться сами
    path = tmp_path / "room.db"
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, "
               "at TEXT NOT NULL, listener_id TEXT NOT NULL, name TEXT NOT NULL, "
               "text TEXT NOT NULL)")
    db.commit()
    db.close()
    s = store_mod.Store(str(path))
    assert s.set_dislike(dis(), cap=10, now=T0) == "added"
    s.close()
