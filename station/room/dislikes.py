"""Дизлайки слушателей: цель отметки, отметки для плеера и сводка в предложения.

Ни базы, ни сети: строки приходят из `store.py`, окно станции — из
`station.py`, и всё здесь проверяется тестом без сервера.

Дизлайк — только сигнал владельцу станции: эфир от него не меняется, блокирует
человек кнопкой в админке (спека 2026-09-24-listener-dislikes-design.md).
Поэтому порог нарочно низкий: песня попадает в предложения с первого дизлайка,
исполнитель — с явного дизлайка или с двух разных дизлайкнутых песен.

Имя исполнителя сводится `norm()` из `normalize.py` рядом — той же функцией,
что у сверки заказа: регистр, ё/е, диакритика латиницы и пунктуация не делят
одного исполнителя на два предложения.
"""
import sys
from pathlib import Path

try:                                   # в образе модуль лежит рядом
    from normalize import norm
except ImportError:                    # в тестах модуль грузится по пути, каталог не в sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from normalize import norm

KINDS = ("track", "artist")
ACTIONS = ("keep", "blocked")
# Сколько разных песен исполнителя надо дизлайкнуть, чтобы он попал в
# предложения без явного дизлайка (решение владельца 2026-09-24).
ARTIST_SONGS_MIN = 2
# Потолок строк в каждой группе. Админка проверяет их в контроллере одним
# запросом `POST /library/blocklist/check`, а тот берёт не больше 500 строк.
SUGGESTIONS_MAX = 200
# Сколько символов id показывать у неназвавшегося слушателя: различить хватает,
# а весь id владельцу ни к чему.
TAG_LEN = 4


def artist_key(artist: str | None) -> str:
    """Ключ исполнителя; пустая строка — исполнителя нет."""
    return norm(artist)


def target_of(kind: str, song_id: str, artist: str | None) -> str | None:
    """Цель отметки: `song_id` у песни, ключ исполнителя у исполнителя.

    None — дизлайк исполнителя у трека без исполнителя: цели у него нет.
    """
    if kind == "track":
        return song_id
    return artist_key(artist) or None


def marks_for(window: dict[str, dict], mine: list[dict]) -> dict[str, dict]:
    """Отметки одного слушателя по песням окна: `{songId: {track, artist}}`.

    `mine` — его строки `{kind, target}`. Песни без отметок не перечисляются:
    плеер читает отсутствие как «отметок нет», и ответ не раздувается окном в
    полсотни треков.
    """
    tracks = {r["target"] for r in mine if r["kind"] == "track"}
    artists = {r["target"] for r in mine if r["kind"] == "artist"}
    out: dict[str, dict] = {}
    for song_id, entry in window.items():
        key = artist_key(entry.get("artist"))
        mark = {"track": song_id in tracks, "artist": bool(key) and key in artists}
        if mark["track"] or mark["artist"]:
            out[song_id] = mark
    return out


def _item(kind: str, key: str, rows: list[dict]) -> dict:
    """Строка предложения из строк-вкладов. Подписи и «представитель» — из
    самой свежей: по его `songId` контроллер найдёт, что блокировать."""
    ordered = sorted(rows, key=lambda r: r["at"])
    latest = ordered[-1]
    listeners: dict[str, dict] = {}
    for r in ordered:                  # по времени первого вклада
        listeners.setdefault(r["listener_id"],
                             {"name": r["name"], "tag": r["listener_id"][:TAG_LEN]})
    return {"kind": kind, "key": key, "songId": latest["song_id"],
            "title": latest["title"], "artist": latest["artist"],
            "album": latest["album"], "listeners": list(listeners.values()),
            "lastAt": latest["at"]}


def _visible(item: dict, decisions: dict[tuple[str, str], str]) -> bool:
    """Решение владельца прячет строку, пока нет вклада строго новее него."""
    decided = decisions.get((item["kind"], item["key"]))
    return decided is None or decided < item["lastAt"]


def _ranked(items: list[dict], limit: int) -> list[dict]:
    """Больше слушателей — выше, при равенстве — свежее, затем по ключу.

    Три устойчивые сортировки от младшего признака к старшему; ключ в конце
    нужен, чтобы порядок не зависел от обхода множества.
    """
    items.sort(key=lambda s: s["key"])
    items.sort(key=lambda s: s["lastAt"], reverse=True)
    items.sort(key=lambda s: len(s["listeners"]), reverse=True)
    return items[:limit]


def suggestions(rows: list[dict], decisions: dict[tuple[str, str], str],
                limit: int = SUGGESTIONS_MAX) -> dict:
    """Видимые предложения: `{"artists": [...], "tracks": [...]}`.

    `rows` — все строки таблицы `dislikes`, `decisions` — `{(kind, target):
    decided_at}`. Время сравнивается строками: оба столбца пишет `store.py`
    одним форматом ISO с миллисекундами в UTC.
    """
    by_song: dict[str, list[dict]] = {}
    by_artist: dict[str, list[dict]] = {}
    explicit: dict[str, list[dict]] = {}
    for r in rows:
        if r["kind"] == "track":
            by_song.setdefault(r["target"], []).append(r)
            if r["artist_key"]:
                by_artist.setdefault(r["artist_key"], []).append(r)
        elif r["kind"] == "artist":
            explicit.setdefault(r["target"], []).append(r)

    tracks = [_item("track", song_id, rs) for song_id, rs in by_song.items()]
    artists = []
    for key in set(by_artist) | set(explicit):
        own = explicit.get(key, [])
        songs = by_artist.get(key, [])
        distinct = len({r["song_id"] for r in songs})
        if not own and distinct < ARTIST_SONGS_MIN:
            continue
        item = _item("artist", key, own + songs)
        item["explicit"] = len(own)
        item["songs"] = distinct
        artists.append(item)

    return {"artists": _ranked([a for a in artists if _visible(a, decisions)], limit),
            "tracks": _ranked([t for t in tracks if _visible(t, decisions)], limit)}
