# Дизлайки слушателей и предложения блокировки — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** слушатель отмечает в плеере «не нравится песня» или «не нравится исполнитель», а владелец видит из этих отметок предложения на вкладке Admin → Library → Blocked и блокирует или оставляет одной кнопкой.

**Architecture:** отметки хранит комната (`deploy/room`, Python на стандартной библиотеке, SQLite `room.db`). У неё два новых запроса для слушателя и два для владельца под `/admin/…`, пароль владельца проверяет контроллер (`GET /settings` с тем же `Authorization`). Плеер и карточка админки — правка патча веба `station/docs/web-changes.md`. Контроллер станции не меняется: блокировка и отсев уже заблокированного идут через его существующие `POST /library/blocklist` и `POST /library/blocklist/check`. Снаружи `/room/admin` закрывается правилом Apache «только из приватных сетей».

**Tech Stack:** Python 3.13 (образ `python:3.13-alpine`), `sqlite3`, pytest; Next.js 15 + React + Radix (`components/ui/dropdown-menu.tsx`) + `sonner` + TanStack Query v5 в `web/` апстрима subwave v1.8.0; `tsx` для тестов чистых модулей; Apache 2.4 и Docker Compose на Debian `<station-host>`.

**Spec:** [`docs/superpowers/specs/2026-09-24-listener-dislikes-design.md`](../specs/2026-09-24-listener-dislikes-design.md)

## Global Constraints

- **Дизлайк — только сигнал.** Эфир от отметки не меняется ни в одном пути; блокирует владелец кнопкой Block.
- **Пороги:** песня — с первого дизлайка; исполнитель — с явного дизлайка или с `ARTIST_SONGS_MIN = 2` разных дизлайкнутых песен. Порядок в группе: больше слушателей — выше, при равенстве — свежее.
- **Пределы:** в таблице не больше `dislikes_max = 5000` записей (новые отметки — 429, снятие работает всегда); в каждой группе предложений не больше `SUGGESTIONS_MAX = 200` (контроллер проверяет не больше 500 строк за раз); имя слушателя — `guard.sanitize` и не длиннее `guard.NAME_MAX = 40`; тело POST — `config.max_body` (8 КБ); `tag` неназвавшегося — первые `TAG_LEN = 4` символа id.
- **Цель отметки:** у `track` — `song_id`, у `artist` — `norm(artist)` из `music/normalize.py`; дизлайк исполнителя у трека без исполнителя — отказ 400.
- **Время дизлайков и решений — ISO с миллисекундами в UTC** (`isoformat(timespec="milliseconds")`), параметром `now`, не изнутри тестов. Решение прячет строку, пока нет вклада **строго** новее решения.
- **Отметить можно только песню из окна станции** (`station.window()`: текущая и история, без `upcoming`), как и скачать; вне окна — 403.
- **Админская часть комнаты — под `/admin/…`** (снаружи `/room/admin/…`). Пароль проверяет контроллер; `WWW-Authenticate` комната не шлёт никогда.
- **Язык:** тексты плеера и комнаты — по-русски; подписи и комментарии админки — по-английски, как вся админка; комментарии в коде плеера — по-русски, как в прежних правках патча.
- **Правится только классический скин** (`components/skins/classic/`), остальные пять остаются апстримными.
- **Патч веба пересобирается только так:** `git -C <клон> add -A && git -C <клон> diff --cached HEAD > station/docs/web-changes.md`, после чего проверяется наложением на **чистый** клон v1.8.0. Файл патча — LF (`*.patch -text` в `.gitattributes`).
- **Без новых зависимостей:** комната — стандартная библиотека плюс уже приколоченный `cryptography`; веб — только то, что уже есть в `web/package.json`.
- **Коммиты:** перед коммитом — `git -C <repo> status --short`, чужие незакоммиченные файлы не трогать; коммит только с явными путями: `git -C <repo> add <пути> && git -C <repo> commit -F <файл> -- <пути>`. Многострочное сообщение — файлом (Write в `<tmp>/dislikes-commit.txt`), по-русски в стиле журнала («Комната: …»), в конце строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Быстрые тесты:** `python -m pytest tests/test_room_*.py -q -p no:cacheprovider` из `<repo>` (эталон до плана — 152 passed, 5 deselected, 2.8 с). Тест дольше секунды в быстром наборе — чинится или получает маркер `integration`.
- **Если сессия идёт в worktree** (`EnterWorktree`): heredoc, `printf` с длинным текстом, `git -C` на чужой путь и `ssh` с `git` внутри обвязка отвергает — удалённые команды и сообщения коммитов писать файлами.

## Review Focus

1. **Один исполнитель в разных написаниях** (ё/е, регистр, `AC/DC` против `AC DC`) — одно предложение, и отметка исполнителя подсвечивает все его песни. Тест — Task 1 (`test_spelling_variants_are_one_artist`, `test_marks_cover_the_song_and_every_song_of_the_artist`).
2. **Трек без исполнителя в окне станции** (пустой `artist`): дизлайк песни работает, дизлайк исполнителя — 400, предложения исполнителя с пустым ключом не бывает. Тесты — Task 1 (`test_nameless_songs_never_become_an_artist_suggestion`), Task 4 (`test_artist_dislike_of_a_nameless_track_is_400`).
3. **Решение владельца в ту же миллисекунду, что последний дизлайк** (или позже): строка скрыта; вернуть её может только вклад строго новее. Тест — Task 1 (`test_decision_hides_until_a_strictly_newer_dislike`).
4. **Имя слушателя с разметкой, длиннее 40 символов или с битым percent-encoding** — чистится, режется, ответ не 500. Тест — Task 4 (`test_name_is_sanitised_cut_and_never_crashes`).
5. **`on` не булево** (`"true"`, `1`, нет поля) — 400, а не «поставить». Тест — Task 4 (`test_on_must_be_a_real_boolean`).

## Рабочее место

- Репозиторий — `<repo>`, ветка `main`. Комната (Tasks 1–4) правится прямо в нём.
- Веб (Tasks 5–6) правится в **клоне апстрима** `<tmp>/sw-dislikes` (v1.8.0 + текущий `ru-web.patch`), в репозиторий уезжает пересобранным патчем. Клон вне репозитория и живёт до конца плана; `node` (v26) и `npx` на <workstation> есть, тесты чистых модулей гоняются локально через `npx --yes tsx`.
- Выкатка (Tasks 7–8) — на Debian `<ssh-user>@<station-host>`, SSH `-p <ssh-port> -i <ssh-key>`. Tasks 7–8 выполняет основная сессия, не субагент: нужны SSH и живая проверка.

---

### Task 1: Комната — цель отметки и сводка в предложения (`station/room/dislikes.py`)

**Files:**
- Create: `station/room/dislikes.py`
- Test: `tests/test_room_dislikes.py`

**Interfaces:**
- Consumes: `norm()` из `music/normalize.py` (в образе — `normalize.py` рядом).
- Produces (модуль `dislikes`):
  - `KINDS = ("track", "artist")`, `ACTIONS = ("keep", "blocked")`, `ARTIST_SONGS_MIN = 2`, `SUGGESTIONS_MAX = 200`, `TAG_LEN = 4`;
  - `artist_key(artist: str | None) -> str` — `norm(artist)`, `""` — исполнителя нет;
  - `target_of(kind: str, song_id: str, artist: str | None) -> str | None`;
  - `marks_for(window: dict[str, dict], mine: list[dict]) -> dict[str, dict]` — `mine` из `{kind, target}`, ответ `{songId: {"track": bool, "artist": bool}}`, только песни с отметкой;
  - `suggestions(rows: list[dict], decisions: dict[tuple[str, str], str], limit: int = SUGGESTIONS_MAX) -> dict` — `rows` из `{listener_id, name, kind, target, artist_key, song_id, title, artist, album, at}`, ответ `{"artists": [...], "tracks": [...]}`; строка: `kind, key, songId, title, artist, album, listeners: [{name, tag}], lastAt`, у исполнителя ещё `explicit, songs`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_dislikes.py`:

```python
"""dislikes.py: цель отметки, отметки плеера и сводка в предложения.

Функции чистые — ни базы, ни сети; время приходит готовыми строками в том же
формате, в каком его пишет store.py (ISO с миллисекундами, UTC).
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    path = ROOT / "deploy" / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"room_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


dislikes = _load("dislikes")


def T(minute: int) -> str:
    """Время вклада: T(5) — 12:05 того же дня, в формате store.py."""
    return f"2026-09-24T12:{minute:02d}:00.000+00:00"


def row(listener, kind, song_id, artist="Кино", at=None, name="", title="Звезда"):
    """Строка таблицы dislikes — как её отдаёт Store.all_dislikes()."""
    key = dislikes.artist_key(artist)
    return {"listener_id": listener, "name": name, "kind": kind,
            "target": song_id if kind == "track" else key, "artist_key": key,
            "song_id": song_id, "title": title, "artist": artist,
            "album": "Звезда по имени Солнце", "at": at or T(0)}


def test_track_target_is_the_song_id():
    assert dislikes.target_of("track", "s1", "Кино") == "s1"


def test_artist_target_is_the_normalised_name():
    assert dislikes.target_of("artist", "s1", "Агата Кристи") == "агата кристи"


def test_nameless_track_has_no_artist_target():
    assert dislikes.target_of("artist", "s1", "") is None
    assert dislikes.target_of("artist", "s1", None) is None
    assert dislikes.target_of("track", "s1", None) == "s1"


def test_spelling_variants_are_one_artist():
    # Review Focus 1: регистр, ё/е и пунктуация не делят исполнителя надвое
    assert dislikes.artist_key("Ёлка") == dislikes.artist_key("елка")
    assert dislikes.artist_key("AC/DC") == dislikes.artist_key("ac dc")
    got = dislikes.suggestions([row("l1", "track", "s1", artist="Ёлка"),
                                row("l2", "track", "s2", artist="Елка")], {})
    assert [(a["key"], a["songs"]) for a in got["artists"]] == [("елка", 2)]


def test_marks_cover_the_song_and_every_song_of_the_artist():
    window = {"s1": {"artist": "Кино"}, "s2": {"artist": "КИНО"},
              "s3": {"artist": "Ария"}}
    mine = [{"kind": "track", "target": "s1"}, {"kind": "artist", "target": "кино"}]
    assert dislikes.marks_for(window, mine) == {
        "s1": {"track": True, "artist": True},
        "s2": {"track": False, "artist": True},
    }


def test_nameless_song_is_never_marked_by_an_artist_dislike():
    assert dislikes.marks_for({"s1": {"artist": ""}},
                              [{"kind": "artist", "target": ""}]) == {}


def test_track_is_suggested_from_the_first_dislike():
    got = dislikes.suggestions([row("l1-abcdef", "track", "s1", name="Маша")], {})
    assert [t["key"] for t in got["tracks"]] == ["s1"]
    assert got["tracks"][0]["listeners"] == [{"name": "Маша", "tag": "l1-a"}]
    assert got["artists"] == []


def test_two_songs_make_an_artist_suggestion():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l2", "track", "s2")], {})
    artist = got["artists"][0]
    assert (artist["key"], artist["songs"], artist["explicit"]) == ("кино", 2, 0)
    assert len(artist["listeners"]) == 2


def test_one_song_twice_is_still_one_song():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l2", "track", "s1")], {})
    assert got["artists"] == []


def test_explicit_artist_dislike_is_enough():
    got = dislikes.suggestions([row("l1", "artist", "s1")], {})
    artist = got["artists"][0]
    assert (artist["explicit"], artist["songs"]) == (1, 0)
    assert got["tracks"] == []


def test_same_listener_counts_once():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l1", "track", "s2")], {})
    assert len(got["artists"][0]["listeners"]) == 1


def test_latest_contribution_is_the_representative():
    got = dislikes.suggestions([row("l1", "track", "s1", at=T(1), title="Звезда"),
                                row("l2", "track", "s2", at=T(5), title="Кукушка")], {})
    artist = got["artists"][0]
    assert (artist["songId"], artist["title"], artist["lastAt"]) == ("s2", "Кукушка", T(5))


def test_names_follow_the_first_contribution():
    got = dislikes.suggestions([row("l1", "track", "s1", at=T(2), name="Маша"),
                                row("l2", "track", "s1", at=T(1), name="Дима")], {})
    assert [x["name"] for x in got["tracks"][0]["listeners"]] == ["Дима", "Маша"]


def test_decision_hides_until_a_strictly_newer_dislike():
    # Review Focus 3: решение в ту же миллисекунду, что последний дизлайк, прячет
    rows = [row("l1", "track", "s1", at=T(5))]
    assert dislikes.suggestions(rows, {("track", "s1"): T(5)})["tracks"] == []
    assert dislikes.suggestions(rows, {("track", "s1"): T(6)})["tracks"] == []
    assert len(dislikes.suggestions(rows, {("track", "s1"): T(4)})["tracks"]) == 1


def test_new_song_dislike_reopens_a_kept_artist():
    decided = {("artist", "кино"): T(5)}
    rows = [row("l1", "track", "s1", at=T(1)), row("l2", "track", "s2", at=T(2))]
    assert dislikes.suggestions(rows, decided)["artists"] == []
    rows.append(row("l3", "track", "s3", at=T(6)))
    assert len(dislikes.suggestions(rows, decided)["artists"]) == 1


def test_decision_on_the_artist_leaves_its_songs_alone():
    rows = [row("l1", "track", "s1"), row("l2", "track", "s2")]
    got = dislikes.suggestions(rows, {("artist", "кино"): T(9)})
    assert got["artists"] == [] and len(got["tracks"]) == 2


def test_more_listeners_first_then_fresher():
    rows = [row("a", "track", "s1", at=T(1)), row("b", "track", "s1", at=T(1)),
            row("c", "track", "s2", at=T(9)), row("d", "track", "s3", at=T(5))]
    assert [t["key"] for t in dislikes.suggestions(rows, {})["tracks"]] == ["s1", "s2", "s3"]


def test_limit_applies_to_each_group():
    rows = [row(f"l{i}", "track", f"s{i}", artist=f"Группа {i}") for i in range(5)]
    assert len(dislikes.suggestions(rows, {}, limit=2)["tracks"]) == 2


def test_nameless_songs_never_become_an_artist_suggestion():
    # Review Focus 2: два трека без исполнителя — не «исполнитель с пустым именем»
    got = dislikes.suggestions([row("l1", "track", "s1", artist=""),
                                row("l2", "track", "s2", artist="")], {})
    assert got["artists"] == [] and len(got["tracks"]) == 2
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_room_dislikes.py -q -p no:cacheprovider`
Expected: ошибка сбора — `FileNotFoundError` на `station/room/dislikes.py`.

- [ ] **Step 3: Написать модуль**

Создать `station/room/dislikes.py`:

```python
"""Дизлайки слушателей: цель отметки, отметки для плеера и сводка в предложения.

Ни базы, ни сети: строки приходят из `store.py`, окно станции — из
`station.py`, и всё здесь проверяется тестом без сервера.

Дизлайк — только сигнал владельцу станции: эфир от него не меняется, блокирует
человек кнопкой в админке (спека 2026-09-24-listener-dislikes-design.md).
Поэтому порог нарочно низкий: песня попадает в предложения с первого дизлайка,
исполнитель — с явного дизлайка или с двух разных дизлайкнутых песен.

Имя исполнителя сводится `norm()` из `music/normalize.py` — той же функцией,
что у сверки заказа: регистр, ё/е, диакритика латиницы и пунктуация не делят
одного исполнителя на два предложения.
"""
import sys
from pathlib import Path

try:                                   # в образе модуль лежит рядом
    from normalize import norm
except ImportError:                    # в тестах и при запуске из репозитория
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
    from music.normalize import norm

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
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `python -m pytest tests/test_room_dislikes.py -q -p no:cacheprovider`
Expected: `19 passed`.

- [ ] **Step 5: Коммит**

Сообщение (файлом `<tmp>/dislikes-commit.txt`):

```
Комната: дизлайки — цель отметки и сводка в предложения

Чистый модуль без базы и сети: цель отметки (песня или norm(artist)),
отметки слушателя по окну станции и предложения блокировки — трек с
первого дизлайка, исполнитель с явного дизлайка или с двух песен.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git -C <repo> add station/room/dislikes.py tests/test_room_dislikes.py
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- station/room/dislikes.py tests/test_room_dislikes.py
```

---

### Task 2: Комната — хранение дизлайков и решений (`station/room/store.py`)

**Files:**
- Modify: `station/room/store.py` (схема, `_iso_ms`, семь методов `Store`)
- Test: `tests/test_room_store.py` (дописать в конец; добавить `import sqlite3` к импортам)

**Interfaces:**
- Consumes: ничего из других задач.
- Produces (методы `Store`, время — параметром `now`):
  - `set_dislike(row: dict, cap: int, now: datetime | None = None) -> str` — `"added" | "exists" | "full"`; `row` — `{listener_id, name, kind, target, artist_key, song_id, title, artist, album}`;
  - `unset_dislike(listener_id: str, kind: str, target: str) -> bool`;
  - `rename_listener(listener_id: str, name: str) -> None`;
  - `listener_dislikes(listener_id: str) -> list[dict]` — `[{kind, target}]`;
  - `all_dislikes() -> list[dict]` — строки для `dislikes.suggestions()`;
  - `has_dislikes(kind: str, target: str) -> bool` — у исполнителя учитываются и дизлайки его песен;
  - `decide(kind: str, target: str, action: str, now: datetime | None = None) -> None`;
  - `decisions() -> dict[tuple[str, str], str]` — `{(kind, target): decided_at}`.

- [ ] **Step 1: Написать падающие тесты**

В `tests/test_room_store.py` к импортам вверху добавить `import sqlite3`, а в конец файла дописать:

```python
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
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `python -m pytest tests/test_room_store.py -q -p no:cacheprovider`
Expected: 10 новых тестов падают с `AttributeError: 'Store' object has no attribute 'set_dislike'` (или `decide`), прежние 9 проходят.

- [ ] **Step 3: Расширить схему и хранилище**

В `station/room/store.py` в строку `SCHEMA` после таблицы `push_subscriptions` (перед закрывающими `"""`) дописать:

```sql

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
```

Под функцией `_iso` добавить:

```python
def _iso_ms(moment: datetime) -> str:
    """Время дизлайков и решений — с миллисекундами: решение владельца и
    дизлайк в одну секунду иначе были бы неразличимы, и новый дизлайк не
    вернул бы строку, скрытую решением."""
    return moment.astimezone(timezone.utc).isoformat(timespec="milliseconds")
```

В конец класса `Store` (после `push_result`) дописать:

```python
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
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `python -m pytest tests/test_room_store.py -q -p no:cacheprovider`
Expected: `19 passed`.

- [ ] **Step 5: Коммит**

Сообщение:

```
Комната: дизлайки — таблицы и хранилище

dislikes (одна отметка слушателя на цель, потолок и повтор под одной
блокировкой) и dislike_decisions. Время — ISO с миллисекундами: решение и
дизлайк в одну секунду иначе неразличимы. Старый room.db получает таблицы
сам — CREATE TABLE IF NOT EXISTS.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git -C <repo> add station/room/store.py tests/test_room_store.py
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- station/room/store.py tests/test_room_store.py
```

---

### Task 3: Комната — пароль владельца проверяет контроллер (`station/room/admin.py`)

**Files:**
- Create: `station/room/admin.py`
- Test: `tests/test_room_admin.py`

**Interfaces:**
- Consumes: ничего из других задач.
- Produces: `admin.verify(authorization: str | None, controller_url: str, timeout: float = 10) -> tuple[int, str | None]` — `(200, None)` владелец; `(401, None)` пароля нет или неверный; `(429, retry_after)` контроллер заблокировал вход; `(502, None)` спросить не удалось.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_admin.py`:

```python
"""admin.py: пароль владельца проверяет контроллер, а не комната.

Контроллер подделан на уровне urlopen: своей сети тест не трогает.
"""
import importlib.util
import sys
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    path = ROOT / "deploy" / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"room_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


admin = _load("admin")
URL = "http://controller:7701"


class Ok:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def controller(monkeypatch):
    """Ответ контроллера на GET /settings: "ok", код ошибки или "down"."""
    seen = []
    mode = {"answer": "ok"}

    def fake(req, timeout=None):
        seen.append((req.full_url, req.get_header("Authorization")))
        answer = mode["answer"]
        if answer == "ok":
            return Ok()
        if answer == "down":
            raise OSError("connection refused")
        headers = Message()
        if answer == 429:
            headers["Retry-After"] = "900"
        raise urllib.error.HTTPError(req.full_url, answer, "refused", headers, None)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return seen, mode


def test_owner_is_recognised_and_the_header_travels(controller):
    seen, _ = controller
    assert admin.verify("Basic b3duZXI6cGFzcw==", URL) == (200, None)
    assert seen == [(URL + "/settings", "Basic b3duZXI6cGFzcw==")]


def test_wrong_password_is_401(controller):
    _, mode = controller
    mode["answer"] = 401
    assert admin.verify("Basic bad", URL) == (401, None)


def test_no_header_does_not_ask_the_controller(controller):
    seen, _ = controller
    assert admin.verify(None, URL) == (401, None)
    assert admin.verify("", URL) == (401, None)
    assert seen == []


def test_lockout_passes_retry_after(controller):
    _, mode = controller
    mode["answer"] = 429
    assert admin.verify("Basic bad", URL) == (429, "900")


def test_unreachable_controller_is_502(controller):
    _, mode = controller
    mode["answer"] = "down"
    assert admin.verify("Basic x", URL) == (502, None)


def test_other_controller_errors_are_502(controller):
    _, mode = controller
    mode["answer"] = 500
    assert admin.verify("Basic x", URL) == (502, None)


def test_trailing_slash_in_the_address(controller):
    seen, _ = controller
    admin.verify("Basic x", URL + "/")
    assert seen[0][0] == URL + "/settings"


def test_empty_controller_address_is_502(controller):
    seen, _ = controller
    assert admin.verify("Basic x", "") == (502, None)
    assert seen == []
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_room_admin.py -q -p no:cacheprovider`
Expected: ошибка сбора — `FileNotFoundError` на `station/room/admin.py`.

- [ ] **Step 3: Написать модуль**

Создать `station/room/admin.py`:

```python
"""Пароль владельца станции проверяет контроллер, а не комната.

Своего пароля у комнаты нет: заголовок `Authorization` пересылается в
`GET /settings` контроллера — тем же запросом админка проверяет вход
(`web/lib/adminAuth.ts::signIn`). Пароль живёт в одном месте, а перебирать его
через комнату бесполезно: после 10 неудач подряд `requireAdmin` контроллера
закрывает вход адресу на 15 минут, и адрес здесь — адрес комнаты.

Ответ — код для владельца и `Retry-After`, если контроллер его прислал.
`WWW-Authenticate` здесь не рождается нигде: на него браузер поднял бы поверх
админки своё окно входа.
"""
import urllib.error
import urllib.request

TIMEOUT = 10


def verify(authorization: str | None, controller_url: str,
           timeout: float = TIMEOUT) -> tuple[int, str | None]:
    """`(200, None)` — владелец; 401 — пароля нет или он неверный; 429 —
    контроллер заблокировал вход; 502 — спросить не удалось."""
    if not authorization:
        return 401, None                 # без заголовка контроллер не спрашиваем
    if not controller_url:
        return 502, None
    req = urllib.request.Request(controller_url.rstrip("/") + "/settings",
                                 headers={"Authorization": authorization})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return (200, None) if r.status == 200 else (502, None)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return 401, None
        if e.code == 429:
            return 429, e.headers.get("Retry-After") if e.headers else None
        return 502, None
    except (OSError, ValueError):
        return 502, None
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `python -m pytest tests/test_room_admin.py -q -p no:cacheprovider`
Expected: `8 passed`.

- [ ] **Step 5: Коммит**

Сообщение:

```
Комната: пароль владельца проверяет контроллер

Authorization уходит в GET /settings контроллера — тем же запросом
админка проверяет вход. Своей копии пароля у комнаты нет, блокировка
после 10 неудач у контроллера та же; 429 отдаёт Retry-After дальше.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git -C <repo> add station/room/admin.py tests/test_room_admin.py
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- station/room/admin.py tests/test_room_admin.py
```

---

### Task 4: Комната — запросы дизлайков и предложений (`server.py`, окно с альбомом, образ, README)

**Files:**
- Modify: `station/room/station.py` (в окно — `album`)
- Modify: `station/room/server.py` (импорты, docstring, `Config`, `_send`, `_read_body`, `do_GET`, `do_POST`, шесть новых методов)
- Modify: `station/room/Dockerfile` (COPY: `admin.py`, `dislikes.py`)
- Modify: `station/room/README.md` (поверхность, раздел «Дизлайки», база, число тестов)
- Modify: `tests/test_room_station.py` (ожидание окна с `album`)
- Test: `tests/test_room_dislikes_server.py`

**Interfaces:**
- Consumes: `dislikes.*` (Task 1), методы `Store` (Task 2), `admin.verify` (Task 3), `station.window` (окно `{sid: {artist, title, album}}`).
- Produces (снаружи — под `/room/`):
  - `GET /dislikes` + `X-Listener-Id` → `200 {"marks": {songId: {"track", "artist"}}}`; 400 без id; 502 станция не ответила;
  - `POST /dislikes` `{songId: str, kind: "track"|"artist", on: bool}` + `X-Listener-Id` (+ `X-Listener-Name`, percent-encoded) → `200 {"songId", "track", "artist"}`; 400/403/413/429/502;
  - `GET /admin/dislikes` + `Authorization` → `200 dislikes.suggestions(...)`; 401/429 (`Retry-After`)/502;
  - `POST /admin/dislikes/decide` `{kind, key, action: "keep"|"blocked"}` + `Authorization` → `200 {"ok": true}`; 400/401/404/429/502;
  - `Config.dislikes_max: int = 5000`.

- [ ] **Step 1: Написать падающий тест запросов**

Создать `tests/test_room_dislikes_server.py`:

```python
"""Запросы дизлайков на поднятом в тесте сервере: /dislikes и /admin/dislikes*.

Контроллер подделан на уровне urlopen, как в test_room_download.py: окно
станции — `/state`, проверка пароля — `/settings`. До своего подопытного
сервера тест ходит настоящим urlopen (адрес 127.0.0.1).
"""
import importlib.util
import json
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
sys.path.insert(0, str(ROOT / "deploy" / "room"))


def _load(name: str):
    path = ROOT / "deploy" / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"ds_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"ds_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


server_mod = _load("server")
store_mod = _load("store")

OWNER = "Basic b3duZXI6cGFzcw=="          # owner:pass — подделка знает только его
ME = {"X-Listener-Id": "l1", "X-Listener-Name": urllib.parse.quote("Аня")}
NAMELESS = {"X-Listener-Id": "l1"}


class _Body:
    status = 200

    def __init__(self, body: bytes):
        self._body = body

    def read(self, *args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Controller:
    """Фиктивный контроллер: окно станции и проверка пароля."""

    def __init__(self):
        self.state = {
            "current": {"subsonic_id": "cur", "artist": "Кино", "title": "Звезда",
                        "album": "Звезда по имени Солнце"},
            "history": [{"subsonic_id": "old", "artist": "Кино",
                         "title": "Пачка сигарет", "album": "Звезда по имени Солнце"},
                        {"subsonic_id": "anon", "artist": "", "title": "Джингл",
                         "album": ""}],
            "upcoming": [{"subsonic_id": "soon", "artist": "Ария", "title": "Улица Роз"}],
        }
        self.auth = "check"        # "check" — сверка с OWNER; 429; "down"
        self.asked = []

    def urlopen(self, req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        self.asked.append(url)
        if url.endswith("/state"):
            return _Body(json.dumps(self.state, ensure_ascii=False).encode("utf-8"))
        if url.endswith("/settings"):
            if self.auth == "down":
                raise OSError("controller unreachable")
            if self.auth == 429:
                headers = Message()
                headers["Retry-After"] = "900"
                raise urllib.error.HTTPError(url, 429, "locked", headers, None)
            if req.get_header("Authorization") != OWNER:
                raise urllib.error.HTTPError(url, 401, "no", Message(), None)
            return _Body(b"{}")
        raise AssertionError(f"неожиданный адрес {url}")


@pytest.fixture
def room(tmp_path, monkeypatch):
    store = store_mod.Store(str(tmp_path / "room.db"))
    config = server_mod.Config(controller_url="http://controller:7701", dislikes_max=5)
    ctl = Controller()
    real_urlopen = urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        return ctl.urlopen(req, timeout)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(store, config))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "store": store,
           "ctl": ctl}
    srv.shutdown()
    srv.server_close()
    store.close()


def call(base, path, body=None, headers=None):
    """(код, заголовки, json). С телом — POST, без — GET."""
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data,
                                 method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json",
                                          **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.headers, json.loads(e.read().decode("utf-8"))


def dislike(room, song, kind, on=True, headers=ME):
    return call(room["base"], "/dislikes", {"songId": song, "kind": kind, "on": on},
                headers)


def owner(room, path, body=None):
    return call(room["base"], path, body, {"Authorization": OWNER})


def test_dislike_of_the_current_song_is_marked(room):
    code, _, body = dislike(room, "cur", "track")
    assert code == 200 and body == {"songId": "cur", "track": True, "artist": False}
    code, _, body = call(room["base"], "/dislikes", headers=ME)
    assert code == 200 and body == {"marks": {"cur": {"track": True, "artist": False}}}


def test_artist_dislike_marks_every_song_of_the_artist(room):
    dislike(room, "cur", "artist")
    _, _, body = call(room["base"], "/dislikes", headers=ME)
    assert body["marks"] == {"cur": {"track": False, "artist": True},
                             "old": {"track": False, "artist": True}}


def test_song_outside_the_window_is_403(room):
    assert dislike(room, "soon", "track")[0] == 403      # ещё не звучала
    assert dislike(room, "nosuch", "track")[0] == 403
    assert room["store"].all_dislikes() == []


def test_artist_dislike_of_a_nameless_track_is_400(room):
    # Review Focus 2
    assert dislike(room, "anon", "artist")[0] == 400
    assert dislike(room, "anon", "track")[0] == 200


def test_on_must_be_a_real_boolean(room):
    # Review Focus 5: «true» строкой и единица — не «поставить»
    for on in ("true", 1, None):
        assert dislike(room, "cur", "track", on=on)[0] == 400
    assert call(room["base"], "/dislikes", {"songId": "cur", "kind": "track"}, ME)[0] == 400
    assert room["store"].all_dislikes() == []


def test_bad_kind_or_missing_song_is_400(room):
    assert dislike(room, "cur", "album")[0] == 400
    assert dislike(room, "", "track")[0] == 400
    assert call(room["base"], "/dislikes", {"kind": "track", "on": True}, ME)[0] == 400


def test_listener_id_is_required(room):
    assert dislike(room, "cur", "track", headers={})[0] == 400
    assert call(room["base"], "/dislikes")[0] == 400


def test_undo_removes_the_mark(room):
    dislike(room, "cur", "track")
    code, _, body = dislike(room, "cur", "track", on=False)
    assert code == 200 and body["track"] is False
    assert call(room["base"], "/dislikes", headers=ME)[2] == {"marks": {}}


def test_repeat_does_not_add_a_row(room):
    dislike(room, "cur", "track")
    dislike(room, "cur", "track")
    assert len(room["store"].all_dislikes()) == 1


def test_cap_refuses_new_marks_but_undo_still_works(room):
    for i in range(5):                                   # dislikes_max=5 в фикстуре
        assert dislike(room, "cur", "track", headers={"X-Listener-Id": f"l{i}"})[0] == 200
    assert dislike(room, "cur", "track", headers={"X-Listener-Id": "l9"})[0] == 429
    assert dislike(room, "cur", "track", on=False, headers={"X-Listener-Id": "l0"})[0] == 200
    assert dislike(room, "cur", "track", headers={"X-Listener-Id": "l9"})[0] == 200


def test_name_is_sanitised_cut_and_never_crashes(room):
    # Review Focus 4
    loud = {"X-Listener-Id": "l1", "X-Listener-Name": urllib.parse.quote("<b>" + "я" * 60)}
    assert dislike(room, "cur", "track", headers=loud)[0] == 200
    assert room["store"].all_dislikes()[0]["name"] == "я" * 40
    broken = {"X-Listener-Id": "l2", "X-Listener-Name": "%E0%A4%A"}
    assert dislike(room, "cur", "track", headers=broken)[0] == 200


def test_later_name_reaches_old_rows(room):
    dislike(room, "cur", "track", headers=NAMELESS)
    dislike(room, "old", "track", headers=ME)
    assert {r["name"] for r in room["store"].all_dislikes()} == {"Аня"}


def test_dead_station_is_502(room):
    room["ctl"].state = None                             # /state отвечает «null»
    assert dislike(room, "cur", "track")[0] == 502
    assert call(room["base"], "/dislikes", headers=ME)[0] == 502


def test_suggestions_need_the_owner_password(room):
    code, headers, _ = call(room["base"], "/admin/dislikes")
    assert code == 401 and headers.get("WWW-Authenticate") is None
    assert not [u for u in room["ctl"].asked if u.endswith("/settings")]


def test_wrong_password_is_401_without_the_browser_dialog(room):
    code, headers, _ = call(room["base"], "/admin/dislikes",
                            headers={"Authorization": "Basic bad"})
    assert code == 401 and headers.get("WWW-Authenticate") is None


def test_owner_sees_suggestions(room):
    dislike(room, "cur", "track")
    dislike(room, "old", "track")
    code, _, body = owner(room, "/admin/dislikes")
    assert code == 200
    assert {t["songId"] for t in body["tracks"]} == {"cur", "old"}
    assert body["tracks"][0]["listeners"] == [{"name": "Аня", "tag": "l1"}]
    assert [(a["key"], a["songs"]) for a in body["artists"]] == [("кино", 2)]


def test_lockout_is_passed_through(room):
    room["ctl"].auth = 429
    code, headers, _ = owner(room, "/admin/dislikes")
    assert code == 429 and headers.get("Retry-After") == "900"


def test_unreachable_controller_on_admin_is_502(room):
    room["ctl"].auth = "down"
    assert owner(room, "/admin/dislikes")[0] == 502


def test_keep_hides_the_suggestion(room):
    dislike(room, "cur", "track")
    code, _, body = owner(room, "/admin/dislikes/decide",
                          {"kind": "track", "key": "cur", "action": "keep"})
    assert code == 200 and body == {"ok": True}
    assert owner(room, "/admin/dislikes")[2]["tracks"] == []


def test_block_decision_hides_the_artist(room):
    dislike(room, "cur", "artist")
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "artist", "key": "кино", "action": "blocked"})[0] == 200
    assert owner(room, "/admin/dislikes")[2]["artists"] == []


def test_decide_needs_a_target_with_dislikes(room):
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "track", "key": "nosuch", "action": "keep"})[0] == 404


def test_decide_validates_fields(room):
    dislike(room, "cur", "track")
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "track", "key": "cur", "action": "delete"})[0] == 400
    assert owner(room, "/admin/dislikes/decide",
                 {"key": "cur", "action": "keep"})[0] == 400


def test_decide_without_password_is_401(room):
    dislike(room, "cur", "track")
    code, _, _ = call(room["base"], "/admin/dislikes/decide",
                      {"kind": "track", "key": "cur", "action": "keep"})
    assert code == 401
    assert owner(room, "/admin/dislikes")[2]["tracks"] != []


def test_unknown_admin_path_is_404(room):
    assert owner(room, "/admin/nope")[0] == 404
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `python -m pytest tests/test_room_dislikes_server.py -q -p no:cacheprovider`
Expected: сбор падает на `TypeError: Config.__init__() got an unexpected keyword argument 'dislikes_max'`.

- [ ] **Step 3: Окно станции — с альбомом**

В `station/room/station.py`:
- в docstring функции `window` строку `` `subsonic_id → {"artist", "title"}` для текущего трека и всей истории.`` заменить на `` `subsonic_id → {"artist", "title", "album"}` для текущего трека и всей истории.`` и дописать после неё абзац: `Альбом нужен дизлайкам: по нему админка отсеивает треки заблокированных альбомов.`;
- строку `out.setdefault(sid, {"artist": item.get("artist"), "title": item.get("title")})` заменить на:

```python
        out.setdefault(sid, {"artist": item.get("artist"), "title": item.get("title"),
                             "album": item.get("album")})
```

В `tests/test_room_station.py` в `test_window_carries_artist_and_title_for_the_filename` ожидание заменить на:

```python
    assert station.window("http://controller:7701")["cur"] == {
        "artist": "Ария", "title": "Улица Роз", "album": None}
```

и дописать тест:

```python
def test_window_carries_the_album(asked):
    # альбом нужен дизлайкам: по нему админка отсеивает заблокированные альбомы
    _, payload = asked
    payload["value"] = _state(current={**_track("cur"), "album": "Опиум"})
    assert station.window("http://controller:7701")["cur"]["album"] == "Опиум"
```

- [ ] **Step 4: Расширить сервер**

В `station/room/server.py`:

1. В docstring модуля в список поверхности после строки `POST /push/unsubscribe …` дописать:

```
    GET  /dislikes                    → {"marks": {songId: {"track", "artist"}}}
    POST /dislikes                    → {"songId", "track", "artist"}   (тело — {songId, kind, on})
    GET  /admin/dislikes              → {"artists": [...], "tracks": [...]}   (пароль владельца)
    POST /admin/dislikes/decide       → {"ok": true}   (тело — {kind, key, action})
```

и после абзаца про `X-Listener-Name` — абзац:

```
Запросы `/admin/…` — владельцу станции: вместо личности слушателя у них пароль
админки в `Authorization`, и проверяет его контроллер (`admin.py`).
```

2. Импорты соседних модулей привести к блоку (по алфавиту, `admin` и `dislikes` — новые):

```python
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
```

3. В `Config` после `push_max: int = 500` дописать:

```python
    # Потолок записей в таблице дизлайков: адрес открыт наружу, и без предела
    # её можно было бы раздувать сколько угодно — как подписки push
    dislikes_max: int = 5000
```

4. `_send` — необязательные заголовки:

```python
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
```

5. В `do_GET` перед веткой `else:` вставить:

```python
            elif path == "/dislikes":
                self._marks()
            elif path == "/admin/dislikes":
                if not self._admin_refused():
                    self._send(200, dislikes.suggestions(store.all_dislikes(),
                                                         store.decisions()))
```

6. `do_POST` целиком:

```python
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
```

7. `_read_body` — сигнатура и проверка id:

```python
        def _read_body(self, need_listener: bool = True) -> tuple[dict, str] | None:
            """Тело POST и id слушателя; None — отказ уже отправлен.

            `need_listener=False` — для запросов владельца: id слушателя у них
            нет, и пустая строка вместо него — законный ответ.
            """
```

и строку `if not listener:` заменить на `if need_listener and not listener:` (остальное тело метода — без изменений).

8. После `_push_unsubscribe` дописать методы:

```python
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
                self._send(502, {"error": f"станция не ответила: {e}"})
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
```

- [ ] **Step 5: Прогнать новые тесты и контракт образа**

Run: `python -m pytest tests/test_room_dislikes_server.py tests/test_room_station.py tests/test_room_dockerfile.py -q -p no:cacheprovider`
Expected: новые тесты и тесты окна проходят; `test_dockerfile_copies_every_module_server_imports` **падает** — `Dockerfile COPY не копирует модули ['admin', 'dislikes']`.

- [ ] **Step 6: Образ — копировать новые модули**

В `station/room/Dockerfile` строку COPY заменить на:

```dockerfile
COPY station/room/guard.py station/room/store.py station/room/subsonic.py \
     station/room/naming.py station/room/station.py station/room/navidrome.py \
     station/room/push.py station/room/notify.py station/room/admin.py \
     station/room/dislikes.py station/room/server.py ./
```

Run: `python -m pytest tests/test_room_*.py -q -p no:cacheprovider`
Expected: всё зелёное, `5 deselected`; passed — 152 плюс новые (19 + 10 + 8 + 24 + 1 = 62), то есть `214 passed`, время — единицы секунд. Записать фактическое число и время для README.

- [ ] **Step 7: README комнаты**

В `station/room/README.md`:

1. В таблицу «Поверхность» после строки `POST /push/unsubscribe` дописать:

```markdown
| `GET /dislikes` | отметки «не нравится» этого слушателя по песням окна станции |
| `POST /dislikes` | `{songId, kind, on}` + заголовки личности — поставить или снять отметку |
| `GET /admin/dislikes` | предложения блокировки для владельца: `{artists, tracks}` |
| `POST /admin/dislikes/decide` | `{kind, key, action}` — решение владельца: `keep` или `blocked` |
```

2. Перед разделом `## База` вставить раздел:

```markdown
## Дизлайки: сигнал владельцу, а не выключатель

Слушатель отмечает в плеере «не нравится песня» или «не нравится исполнитель»
(кнопка 👎 — [`l10n/README.md`](../web-changes.md)). Эфир от отметки не
меняется: из отметок владелец получает предложения на вкладке **Admin → Library →
Blocked** и решает сам. Спека —
[дизлайки слушателей](../specs/2026-09-24-listener-dislikes-design.md).

**Отметить можно только песню из окна станции** — ту же, что можно скачать:
текущую и прозвучавшие. Исполнитель, название и альбом берутся из окна, а не из
запроса. Цель отметки исполнителя — `norm(artist)`, поэтому «Ёлка» и «Елка»,
`AC/DC` и `AC DC` — один исполнитель. Снятие отметки тоже сверяется с окном:
без него не узнать исполнителя песни.

**Порог низкий нарочно:** песня — с первого дизлайка, исполнитель — с явного
дизлайка или с двух разных дизлайкнутых песен (`dislikes.py`). Решение владельца
(`keep` или `blocked`) прячет строку, пока не придёт дизлайк строго новее
решения. Время дизлайков и решений — с миллисекундами: иначе решение и дизлайк
в одну секунду были бы неразличимы.

**Пароль владельца проверяет контроллер.** Своего пароля у комнаты нет:
заголовок `Authorization` уходит в `GET /settings` контроллера, тем же запросом
админка проверяет вход (`admin.py`). Перебирать пароль через комнату бесполезно —
после 10 неудач контроллер закрывает вход её адресу на 15 минут, и комната
отдаёт его 429 с `Retry-After`. `WWW-Authenticate` комната не шлёт: на него
браузер поднял бы поверх админки своё окно входа. Снаружи `/room/admin` к тому
же закрыт правилом Apache «только из приватных сетей».

Записей не больше 5000 (`Config.dislikes_max`): адрес открыт наружу. Отметки
хранятся бессрочно — чистка по возрасту (`RETENTION_DAYS`) касается только ленты.
```

3. В разделе `## База` после предложения про вторую таблицу `push_subscriptions` дописать:

```markdown
Ещё две — `dislikes` (отметки слушателей) и `dislike_decisions` (решения
владельца); обе заводит `CREATE TABLE IF NOT EXISTS` при старте, так что прежний
`room.db` получает их сам.
```

4. В строке про быстрые тесты заменить `(154 штуки на 2026-09-23, весь набор — около четырёх секунд)` на фактическое число и время из Step 6 с датой `2026-09-24`.

- [ ] **Step 8: Коммит**

Сообщение:

```
Комната: запросы дизлайков и предложений

GET/POST /dislikes для плеера (личность — заголовками, песня — только из
окна станции), GET /admin/dislikes и POST /admin/dislikes/decide для
владельца (пароль проверяет контроллер, без WWW-Authenticate). Окно станции
несёт альбом — по нему админка отсеет треки заблокированных альбомов.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
P="station/room/server.py station/room/station.py station/room/Dockerfile station/room/README.md tests/test_room_station.py tests/test_room_dislikes_server.py"
git -C <repo> add $P
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- $P
```

---

### Task 5: Плеер — кнопка «не нравится» с меню (патч веба)

**Files (в клоне `<tmp>/sw-dislikes`, в репозиторий — патчем):**
- Create: `web/lib/roomDislikes.ts`, `web/lib/roomDislikes.test.ts`
- Create: `web/components/skins/classic/DislikesContext.tsx`
- Create: `web/components/skins/classic/DislikeMenu.tsx`
- Modify: `web/components/skins/classic/ClassicSkin.tsx`, `web/components/skins/classic/CenterStage.tsx`, `web/components/skins/classic/drawers/TimelineDrawer.tsx`
- Modify (репозиторий): `station/docs/web-changes.md`, `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `GET/POST /room/dislikes` (Task 4); `listener()` из `web/lib/listener.ts`; `DropdownMenu*` из `web/components/ui/dropdown-menu.tsx`; `toast` из `sonner`.
- Produces:
  - `web/lib/roomDislikes.ts`: `type DislikeKind = 'track' | 'artist'`, `interface Mark {track; artist}`, `type Marks = Record<string, Mark>`, `parseMarks(raw: unknown): Marks`, `markOf(marks, songId): Mark`, `isMarked(m): boolean`, `errorText(status: number): string`, `doneText(kind, on, title?, artist?): string`, `fetchMarks(): Promise<Marks | null>`, `setDislike(songId, kind, on): Promise<{ok: true} | {ok: false; status: number}>`;
  - `DislikesContext.tsx`: `DislikesProvider({windowKey, children})`, `useDislikes(): Dislikes | null`;
  - `DislikeMenu.tsx`: `default DislikeMenu({songId, title?, artist?, size = 15, className?})`.

- [ ] **Step 1: Рабочий клон**

```bash
W=<tmp>/sw-dislikes
test -d "$W/.git" || git -c core.autocrlf=false clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git "$W"
git -C "$W" status --short | head -1
```

Если клон свежий (вывод статуса пуст) — наложить текущий патч и застейджить его, чтобы свои правки дальше были видны отдельно (`git diff` — правки, `??` — новые файлы):

```bash
git -C "$W" apply <repo>/station/docs/web-changes.md
git -C "$W" add -A
grep -c "^diff --git" <repo>/station/docs/web-changes.md
```

Expected: `git apply` молчит, счёт — `50`.

- [ ] **Step 2: Написать падающий тест чистого модуля**

Создать `<tmp>/sw-dislikes/web/lib/roomDislikes.test.ts`:

```ts
// «Не нравится»: разбор ответа комнаты и тексты тостов.
// Приём тот же, что у roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск:  npx --yes tsx web/lib/roomDislikes.test.ts

import assert from 'node:assert/strict';
import { doneText, errorText, isMarked, markOf, parseMarks } from './roomDislikes';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

console.log('parseMarks');

test('отметки читаются по песням', () => {
  assert.deepEqual(parseMarks({ marks: { a: { track: true, artist: false } } }),
    { a: { track: true, artist: false } });
});

test('мусор вместо ответа — отметок нет', () => {
  assert.deepEqual(parseMarks(null), {});
  assert.deepEqual(parseMarks('<html>'), {});
  assert.deepEqual(parseMarks({ marks: 'x' }), {});
});

test('не булево — не отметка', () => {
  assert.deepEqual(parseMarks({ marks: { a: { track: 'true', artist: 1 } } }),
    { a: { track: false, artist: false } });
});

console.log('markOf / isMarked');

test('песня без отметок и пустой id — пустая отметка', () => {
  assert.deepEqual(markOf({}, 'a'), { track: false, artist: false });
  assert.deepEqual(markOf({ a: { track: true, artist: false } }, null),
    { track: false, artist: false });
});

test('отметка исполнителя подсвечивает кнопку', () => {
  assert.equal(isMarked({ track: false, artist: true }), true);
  assert.equal(isMarked({ track: false, artist: false }), false);
});

console.log('тексты');

test('отказ комнаты — по коду', () => {
  assert.equal(errorText(403), 'Песня уже уехала из ленты');
  assert.equal(errorText(429), 'Отметок слишком много');
  assert.equal(errorText(502), 'Станция не ответила, попробуйте позже');
  assert.equal(errorText(500), 'Не получилось отметить');
  assert.equal(errorText(0), 'Не получилось отметить');
});

test('тост называет песню или исполнителя', () => {
  assert.equal(doneText('track', true, 'Звезда', 'Кино'),
    'Отмечено: не нравится «Звезда». Решение за владельцем станции');
  assert.equal(doneText('artist', true, 'Звезда', 'Кино'),
    'Отмечено: не нравится «Кино». Решение за владельцем станции');
});

test('без названия — без пустых кавычек', () => {
  assert.equal(doneText('artist', true, 'Звезда', '  '),
    'Отмечено. Решение за владельцем станции');
});

test('снятие отметки', () => {
  assert.equal(doneText('track', false, 'Звезда', 'Кино'), 'Отметка снята');
});

if (failures) {
  console.error(`\n${failures} проверок не прошло`);
  process.exit(1);
}
console.log('\nвсё прошло');
```

- [ ] **Step 3: Убедиться, что тест падает**

Run: `npx --yes tsx <tmp>/sw-dislikes/web/lib/roomDislikes.test.ts`
Expected: ошибка `Cannot find module './roomDislikes'`.

- [ ] **Step 4: Написать модуль**

Создать `<tmp>/sw-dislikes/web/lib/roomDislikes.ts`:

```ts
// «Не нравится» слушателя: запросы в комнату (deploy/room, /room/dislikes) и
// всё, что о них решается без React. Эфир от отметки не меняется — это сигнал
// владельцу станции, и тост после нажатия говорит слушателю именно это.
//
// Тест:  npx --yes tsx web/lib/roomDislikes.test.ts

import { listener } from './listener';

export type DislikeKind = 'track' | 'artist';

export interface Mark {
  /** Слушатель отметил саму песню. */
  track: boolean;
  /** Слушатель отметил её исполнителя — любой его песней из окна. */
  artist: boolean;
}

/** Отметки по песням окна станции; песни без отметок в наборе нет. */
export type Marks = Record<string, Mark>;

const NO_MARK: Mark = { track: false, artist: false };

export function parseMarks(raw: unknown): Marks {
  const marks = raw && typeof raw === 'object' ? (raw as { marks?: unknown }).marks : null;
  if (!marks || typeof marks !== 'object') return {};
  const out: Marks = {};
  for (const [id, m] of Object.entries(marks as Record<string, unknown>)) {
    const v = m && typeof m === 'object' ? (m as Record<string, unknown>) : {};
    out[id] = { track: v.track === true, artist: v.artist === true };
  }
  return out;
}

export function markOf(marks: Marks, songId: string | null | undefined): Mark {
  return (songId ? marks[songId] : undefined) ?? NO_MARK;
}

export function isMarked(m: Mark): boolean {
  return m.track || m.artist;
}

/** Текст отказа по коду ответа комнаты; 0 — сеть не ответила вовсе. */
export function errorText(status: number): string {
  if (status === 403) return 'Песня уже уехала из ленты';
  if (status === 429) return 'Отметок слишком много';
  if (status === 502) return 'Станция не ответила, попробуйте позже';
  return 'Не получилось отметить';
}

/** Тост после удачного нажатия: что отмечено и что будет дальше. */
export function doneText(kind: DislikeKind, on: boolean,
                         title?: string | null, artist?: string | null): string {
  if (!on) return 'Отметка снята';
  const what = (kind === 'artist' ? artist : title)?.trim();
  return what
    ? `Отмечено: не нравится «${what}». Решение за владельцем станции`
    : 'Отмечено. Решение за владельцем станции';
}

function identity(): Record<string, string> {
  const me = listener();
  const headers: Record<string, string> = { 'X-Listener-Id': me.id };
  // Заголовки по RFC 7230 — latin-1, кириллица в них иначе не проходит.
  if (me.name) headers['X-Listener-Name'] = encodeURIComponent(me.name);
  return headers;
}

/** Отметки этого слушателя; null — комната не ответила, прежние не трогать. */
export async function fetchMarks(): Promise<Marks | null> {
  try {
    const r = await fetch('/room/dislikes', { headers: identity() });
    return r.ok ? parseMarks(await r.json()) : null;
  } catch {
    return null;
  }
}

/** Поставить или снять отметку; `status` 0 — сеть не ответила. */
export async function setDislike(songId: string, kind: DislikeKind, on: boolean):
    Promise<{ ok: true } | { ok: false; status: number }> {
  try {
    const r = await fetch('/room/dislikes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...identity() },
      body: JSON.stringify({ songId, kind, on }),
    });
    return r.ok ? { ok: true } : { ok: false, status: r.status };
  } catch {
    return { ok: false, status: 0 };
  }
}
```

- [ ] **Step 5: Убедиться, что тест проходит**

Run: `npx --yes tsx <tmp>/sw-dislikes/web/lib/roomDislikes.test.ts`
Expected: девять `✓` и `всё прошло`.

- [ ] **Step 6: Провайдер отметок**

Создать `<tmp>/sw-dislikes/web/components/skins/classic/DislikesContext.tsx`:

```tsx
'use client';

// Отметки «не нравится» этого слушателя — одно состояние на скин. Кнопок на
// экране до полусотни (карточка и каждая строка «Уже прозвучало»), и
// спрашивать комнату каждой значило бы полсотни запросов на смену трека.
// Кнопки читают контекст, поэтому сетевое состояние не перерисовывает
// CenterStage под memo — по той же причине сердце живёт в собственном хуке.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import {
  doneText, errorText, fetchMarks, setDislike, type DislikeKind, type Marks,
} from '@/lib/roomDislikes';

export interface DislikeLabel { title?: string | null; artist?: string | null }

export interface Dislikes {
  marks: Marks;
  /** Идёт запрос — пункты меню неактивны: двойное нажатие поставило бы и сняло. */
  busy: boolean;
  toggle: (songId: string, kind: DislikeKind, on: boolean, label: DislikeLabel) => Promise<void>;
}

const Ctx = createContext<Dislikes | null>(null);

export function DislikesProvider({ windowKey, children }: {
  /** Меняется вместе с окном станции (новый трек) — тогда отметки перечитываются. */
  windowKey: string;
  children: ReactNode;
}) {
  const [marks, setMarks] = useState<Marks>({});
  const [busy, setBusy] = useState(false);
  const seqRef = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++seqRef.current;
    const next = await fetchMarks();
    // Опоздавший ответ не затирает более свежий; отказ комнаты не стирает отметки.
    if (next && seq === seqRef.current) setMarks(next);
  }, []);

  useEffect(() => { void reload(); }, [windowKey, reload]);

  const toggle = useCallback<Dislikes['toggle']>(async (songId, kind, on, label) => {
    setBusy(true);
    try {
      const res = await setDislike(songId, kind, on);
      if (res.ok) toast(doneText(kind, on, label.title, label.artist));
      else toast.error(errorText(res.status));
      // И после отказа: 403 значит, что окно уже другое.
      await reload();
    } finally {
      setBusy(false);
    }
  }, [reload]);

  const value = useMemo(() => ({ marks, busy, toggle }), [marks, busy, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** null — кнопка вне провайдера: её просто не рисуют. */
export function useDislikes(): Dislikes | null {
  return useContext(Ctx);
}
```

- [ ] **Step 7: Кнопка с меню**

Создать `<tmp>/sw-dislikes/web/components/skins/classic/DislikeMenu.tsx`:

```tsx
'use client';

// «Не нравится» — одна кнопка с меню из двух пунктов: песня или исполнитель
// целиком. Одна, а не две: в строке «Уже прозвучало» уже стоит скачивание, а
// смысл второго значка на телефоне без подсказки не читается. Галочка —
// отметка ЭТОГО слушателя; эфир от неё не меняется, решает владелец станции.

import { ThumbsDown } from 'lucide-react';
import { cn } from '@/lib/cn';
import { isMarked, markOf } from '@/lib/roomDislikes';
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useDislikes } from './DislikesContext';

export default function DislikeMenu({ songId, title, artist, size = 15, className }: {
  songId: string | null | undefined;
  title?: string | null;
  artist?: string | null;
  size?: number;
  className?: string;
}) {
  const dislikes = useDislikes();
  if (!songId || !dislikes) return null;
  const id: string = songId;
  const mark = markOf(dislikes.marks, id);
  const on = isMarked(mark);
  const label = { title, artist };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Не нравится"
          title="Не нравится"
          className={cn(
            'v3-focus inline-flex cursor-pointer items-center border-0 bg-transparent p-0 transition-colors',
            on ? 'text-vermilion' : 'text-muted hover:text-ink',
            className,
          )}
        >
          <ThumbsDown size={size} strokeWidth={1.75} fill={on ? 'currentColor' : 'none'} aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuCheckboxItem
          checked={mark.track}
          disabled={dislikes.busy}
          onCheckedChange={v => { void dislikes.toggle(id, 'track', v === true, label); }}
        >
          Не нравится песня
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={mark.artist}
          disabled={dislikes.busy || !artist?.trim()}
          onCheckedChange={v => { void dislikes.toggle(id, 'artist', v === true, label); }}
        >
          Не нравится исполнитель
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

- [ ] **Step 8: Подключить к скину, карточке и ленте**

`web/components/skins/classic/ClassicSkin.tsx`:
- после `import ChatDrawer from './drawers/ChatDrawer';` добавить `import { DislikesProvider } from './DislikesContext';`;
- после блока `const upNext = useMemo<QueueEntry | null>(…);` добавить:

```tsx
  // Отметки «не нравится» перечитываются на смене трека: ключ — текущая песня
  // и голова истории (прозвучавшее уехало в ленту).
  const dislikeWindowKey = `${nowPlaying?.subsonic_id ?? ''}|${state.history?.[0]?.subsonic_id ?? ''}`;
```

- в `return (` открывающий `<>` заменить на `<DislikesProvider windowKey={dislikeWindowKey}>`, закрывающий `</>` в конце — на `</DislikesProvider>`; содержимое между ними не переотступать (так патч остаётся точечным).

`web/components/skins/classic/CenterStage.tsx`:
- после `import { useTrackLike } from '@/components/skins/sharedHooks';` добавить `import DislikeMenu from './DislikeMenu';`;
- между `<LikeHeart />` и `<DownloadTrack subsonicId={subsonicId} />` вставить:

```tsx
                    <DislikeMenu songId={subsonicId} title={nowPlaying?.title} artist={nowPlaying?.artist} className="ml-[10px] align-middle" />
```

`web/components/skins/classic/drawers/TimelineDrawer.tsx`:
- после `import { downloadUrl } from '@/lib/download';` добавить `import DislikeMenu from '../DislikeMenu';`;
- блок `{t.subsonic_id && ( <a … download …> … </a> )}` в строке «Уже прозвучало» заменить на группу, чтобы `justify-between` строки по-прежнему делил её на три части (название, время, значки):

```tsx
              {t.subsonic_id && (
                <span className="flex shrink-0 items-center gap-[10px]">
                  <DislikeMenu songId={t.subsonic_id} title={t.title} artist={t.artist} size={14} />
                  <a
                    href={downloadUrl(t.subsonic_id)}
                    download
                    aria-label={`Скачать: ${t.artist} — ${t.title}`}
                    title="Скачать"
                    className="v3-focus inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-muted transition-colors hover:text-ink"
                  >
                    <ArrowDownToLine size={14} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                </span>
              )}
```

- [ ] **Step 9: Типы и линтер по изменённым файлам**

Зависимости веба — один раз на клон:

```bash
npm --prefix <tmp>/sw-dislikes/web ci --no-audit --no-fund
```

Типы (скрипт `typecheck` = `tsc --noEmit`, `npm run` исполняет его в каталоге пакета):

```bash
npm --prefix <tmp>/sw-dislikes/web run typecheck
```

Expected: единственная ошибка — старая `lib/roomPush.test.ts(43,…)` из [README l10n](../web-changes.md); ни одной в новых и изменённых файлах.

ESLint ищет конфиг от текущего каталога — поэтому через PowerShell:

```powershell
Push-Location <tmp>\sw-dislikes\web; try { npx eslint lib/roomDislikes.ts lib/roomDislikes.test.ts components/skins/classic/DislikesContext.tsx components/skins/classic/DislikeMenu.tsx components/skins/classic/ClassicSkin.tsx components/skins/classic/CenterStage.tsx components/skins/classic/drawers/TimelineDrawer.tsx } finally { Pop-Location }
```

Expected: без ошибок. Если `npm ci` на Windows не собирается — те же проверки в контейнере на Debian, как тесты чата в README l10n (`node:22-bookworm-slim`, `-w /work/web`).

- [ ] **Step 10: README l10n**

В `station/docs/web-changes.md` перед разделом `## Вкладка Blocked: папки деревом и жанры папок` вставить:

```markdown
## Дизлайки: кнопка 👎

Добавлена 2026-09-24 ([спека](../specs/2026-09-24-listener-dislikes-design.md)).
Кнопка стоит на карточке «Сейчас играет» между сердцем и скачиванием и в каждой
строке «Уже прозвучало»; по нажатию — меню «Не нравится песня» / «Не нравится
исполнитель» с галочками. Отметки хранит комната
([`station/room/`](../../room/README.md)), эфир от них не меняется — об этом
говорит тост после нажатия, а решает владелец на вкладке Blocked.

| Где | Что |
|---|---|
| `lib/roomDislikes.ts` + тест | запросы в комнату с заголовками слушателя, разбор ответа, тексты тостов |
| `components/skins/classic/DislikesContext.tsx` | отметки слушателя по окну станции — одно состояние на скин; перечитываются на смене трека и после каждого нажатия |
| `components/skins/classic/DislikeMenu.tsx` | кнопка и меню (Radix, `components/ui/dropdown-menu.tsx`) |
| `ClassicSkin.tsx`, `CenterStage.tsx`, `drawers/TimelineDrawer.tsx` | подключение; в строке ленты дизлайк и скачивание собраны в одну группу, иначе `justify-between` разнёс бы их по строке |

**Состояние — в контексте, а не в кнопке.** Кнопок на экране до полусотни, и
спрашивать комнату каждой значило бы полсотни запросов на смену трека. А
`CenterStage` — под `memo`: сетевое состояние в его пропсах перерисовывало бы всю
сцену, по той же причине сердце живёт в своём хуке.

Тест — `npx --yes tsx web/lib/roomDislikes.test.ts`.
```

- [ ] **Step 11: Пересобрать патч и проверить на чистом клоне**

```bash
W=<tmp>/sw-dislikes
git -C "$W" status --short
```

Expected: изменённые — ровно `ClassicSkin.tsx`, `CenterStage.tsx`, `TimelineDrawer.tsx`; новые — ровно четыре файла этой задачи; ни `node_modules`, ни `.next`.

```bash
git -C "$W" add -A && git -C "$W" diff --cached HEAD > <repo>/station/docs/web-changes.md
grep -c "^diff --git" <repo>/station/docs/web-changes.md
rm -rf <tmp>/sw-check && git -c core.autocrlf=false clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git <tmp>/sw-check
git -C <tmp>/sw-check apply --check <repo>/station/docs/web-changes.md && echo APPLY_OK
```

Expected: счёт — `54`, затем `APPLY_OK`. В README l10n число в предложении «Всего в патче 50 файлов.» (оно разорвано переносом строки после «в патче») заменить на фактическое (`54`).

- [ ] **Step 12: Коммит**

Сообщение:

```
Плеер: кнопка «не нравится» — песня или исполнитель

Кнопка 👎 с меню на карточке «Сейчас играет» и в строках «Уже прозвучало».
Отметки хранит комната, эфир от них не меняется — тост говорит, что решает
владелец. Состояние — одно на скин, CenterStage под memo не перерисовывается.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
P="station/docs/web-changes.md station/docs/web-changes.md"
git -C <repo> add $P
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- $P
```

---

### Task 6: Админка — карточка Dislikes на вкладке Blocked (патч веба)

**Files (в клоне `<tmp>/sw-dislikes`, в репозиторий — патчем):**
- Create: `web/lib/dislikeSuggestions.ts`, `web/lib/dislikeSuggestions.test.ts`
- Create: `web/components/admin/library/DislikesCard.tsx`
- Modify: `web/components/admin/library/queries.ts` (ключ `libraryKeys.dislikes`)
- Modify: `web/components/admin/library/tabs/BlockedTabContainer.tsx`
- Modify (репозиторий): `station/docs/web-changes.md`, `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `GET /room/admin/dislikes`, `POST /room/admin/dislikes/decide` (Task 4); контроллер — `POST /api/library/blocklist {type, trackId}` (201 — заблокировано, 409 — уже было), `POST /api/library/blocklist/check {tracks: [...]}` → `{blocked: {id: BlockRef | null}}` (не больше 500 строк); `useLibrary()` → `adminFetch`, `ready`, `restampBlockMarks`; `useAdminAuth()` → `auth` (Basic-токен), `hydrated`.
- Produces: `web/lib/dislikeSuggestions.ts`: типы `Suggestion`, `Suggestions`, `SuggestionListener`, `CheckRow`; `parseSuggestions(raw): Suggestions`, `checkId(s): string`, `checkRows(all): CheckRow[]`, `withoutBlocked(all, blocked): Suggestions`, `listenerLabel(l): string`, `reasonLine(s): string`; компонент `DislikesCard()`; ключ `libraryKeys.dislikes()`.

- [ ] **Step 1: Написать падающий тест чистого модуля**

Создать `<tmp>/sw-dislikes/web/lib/dislikeSuggestions.test.ts`:

```ts
// Dislike suggestions: parsing the room's answer, the blocklist check rows and
// the reason line. Same harness as roomRules.test.ts (assert + ✓/✗ + exit 1).
// Run:  npx --yes tsx web/lib/dislikeSuggestions.test.ts

import assert from 'node:assert/strict';
import {
  checkRows, listenerLabel, parseSuggestions, reasonLine, withoutBlocked,
  type Suggestion,
} from './dislikeSuggestions';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

const artist: Suggestion = {
  kind: 'artist', key: 'кино', songId: 's2', title: 'Пачка сигарет', artist: 'Кино',
  album: 'Звезда по имени Солнце',
  listeners: [{ name: 'Маша', tag: 'a1b2' }, { name: '', tag: 'c3d4' }],
  explicit: 1, songs: 3, lastAt: '2026-09-24T12:00:00.000+00:00',
};
const track: Suggestion = {
  kind: 'track', key: 's1', songId: 's1', title: 'Звезда', artist: 'Кино',
  album: 'Звезда по имени Солнце', listeners: [{ name: 'Дима', tag: 'e5f6' }],
  lastAt: '2026-09-24T11:00:00.000+00:00',
};

console.log('parseSuggestions');

test('the room answer reads as is', () => {
  assert.deepEqual(parseSuggestions({ artists: [artist], tracks: [track] }),
    { artists: [artist], tracks: [track] });
});

test('garbage and the wrong kind are dropped', () => {
  assert.deepEqual(parseSuggestions(null), { artists: [], tracks: [] });
  assert.deepEqual(parseSuggestions({ artists: [track], tracks: [{ kind: 'track' }] }),
    { artists: [], tracks: [] });
});

test('a broken listener list becomes empty, not a crash', () => {
  const { tracks } = parseSuggestions({ tracks: [{ ...track, listeners: 'x' }] });
  assert.deepEqual(tracks[0]?.listeners, []);
});

console.log('checkRows / withoutBlocked');

test('an artist is checked by name only, a track by all its fields', () => {
  assert.deepEqual(checkRows({ artists: [artist], tracks: [track] }), [
    { id: 'artist:кино', artist: 'Кино' },
    { id: 's1', title: 'Звезда', artist: 'Кино', album: 'Звезда по имени Солнце' },
  ]);
});

test('anything the blocklist already catches is not suggested', () => {
  const all = { artists: [artist], tracks: [track] };
  assert.deepEqual(withoutBlocked(all, { 'artist:кино': { kind: 'entry' }, s1: null }),
    { artists: [], tracks: [track] });
});

test('a blocked representative song does not hide its artist', () => {
  const all = { artists: [artist], tracks: [] };
  assert.deepEqual(withoutBlocked(all, { s2: { kind: 'entry' } }), all);
});

console.log('labels');

test('a nameless listener is anon plus the id head', () => {
  assert.equal(listenerLabel({ name: '', tag: 'c3d4' }), 'anon·c3d4');
  assert.equal(listenerLabel({ name: ' Маша ', tag: 'a1b2' }), 'Маша');
});

test('the artist reason names listeners, artist dislikes and songs', () => {
  assert.equal(reasonLine(artist),
    'disliked by Маша, anon·c3d4 · 1 artist dislike · 3 songs disliked');
});

test('the track reason names listeners only', () => {
  assert.equal(reasonLine(track), 'disliked by Дима');
});

test('zero artist dislikes are not mentioned', () => {
  assert.equal(reasonLine({ ...artist, explicit: 0, songs: 2 }),
    'disliked by Маша, anon·c3d4 · 2 songs disliked');
});

if (failures) {
  console.error(`\n${failures} checks failed`);
  process.exit(1);
}
console.log('\nall passed');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `npx --yes tsx <tmp>/sw-dislikes/web/lib/dislikeSuggestions.test.ts`
Expected: ошибка `Cannot find module './dislikeSuggestions'`.

- [ ] **Step 3: Написать модуль**

Создать `<tmp>/sw-dislikes/web/lib/dislikeSuggestions.ts`:

```ts
// Block suggestions from listener dislikes (the room, /room/admin/dislikes) and
// everything done with them outside React: the rows that ask the controller
// "is this blocked already" and the filter over its answer.
//
// Test:  npx --yes tsx web/lib/dislikeSuggestions.test.ts

export type SuggestionKind = 'track' | 'artist';

export interface SuggestionListener {
  name: string;
  /** Head of the listener id — tells nameless listeners apart. */
  tag: string;
}

export interface Suggestion {
  kind: SuggestionKind;
  /** The room's target: song id for a track, normalised name for an artist. */
  key: string;
  /** Newest disliked song — the controller resolves what to block from it. */
  songId: string;
  title: string;
  artist: string;
  album: string;
  listeners: SuggestionListener[];
  /** Artist only: listeners who disliked the artist itself. */
  explicit?: number;
  /** Artist only: distinct songs of the artist disliked. */
  songs?: number;
  lastAt: string;
}

export interface Suggestions { artists: Suggestion[]; tracks: Suggestion[] }

export interface CheckRow { id: string; title?: string; artist?: string; album?: string }

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function one(raw: unknown, kind: SuggestionKind): Suggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.kind !== kind || !str(s.key) || !str(s.songId)) return null;
  const listeners = Array.isArray(s.listeners)
    ? s.listeners
        .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
        .map(l => ({ name: str(l.name), tag: str(l.tag) }))
    : [];
  const base: Suggestion = {
    kind, key: str(s.key), songId: str(s.songId), title: str(s.title),
    artist: str(s.artist), album: str(s.album), listeners, lastAt: str(s.lastAt),
  };
  return kind === 'artist' ? { ...base, explicit: num(s.explicit), songs: num(s.songs) } : base;
}

export function parseSuggestions(raw: unknown): Suggestions {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { artists?: unknown; tracks?: unknown };
  const pick = (list: unknown, kind: SuggestionKind) =>
    (Array.isArray(list) ? list : [])
      .map(x => one(x, kind))
      .filter((x): x is Suggestion => x !== null);
  return { artists: pick(r.artists, 'artist'), tracks: pick(r.tracks, 'track') };
}

/** What the blocklist check is asked with. An artist goes by NAME ONLY, under
 *  a made-up id: with the real songId the answer "blocked" about one song — a
 *  track entry, a genre or folder rule — would pass for the whole artist. */
export function checkId(s: Suggestion): string {
  return s.kind === 'artist' ? `artist:${s.key}` : s.songId;
}

export function checkRows(all: Suggestions): CheckRow[] {
  return [
    ...all.artists.map(s => ({ id: checkId(s), artist: s.artist })),
    ...all.tracks.map(s => ({ id: checkId(s), title: s.title, artist: s.artist, album: s.album })),
  ];
}

/** Whatever the blocklist already catches, by any entry or rule, is not suggested. */
export function withoutBlocked(all: Suggestions, blocked: Record<string, unknown>): Suggestions {
  const open = (s: Suggestion) => !blocked[checkId(s)];
  return { artists: all.artists.filter(open), tracks: all.tracks.filter(open) };
}

export function listenerLabel(l: SuggestionListener): string {
  return l.name.trim() || `anon·${l.tag}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why the row is here: "disliked by Маша, Дима · 3 songs disliked". */
export function reasonLine(s: Suggestion): string {
  const parts = [`disliked by ${s.listeners.map(listenerLabel).join(', ')}`];
  if (s.kind === 'artist') {
    if (s.explicit) parts.push(plural(s.explicit, 'artist dislike', 'artist dislikes'));
    if (s.songs) parts.push(`${plural(s.songs, 'song', 'songs')} disliked`);
  }
  return parts.join(' · ');
}
```

- [ ] **Step 4: Убедиться, что тест проходит**

Run: `npx --yes tsx <tmp>/sw-dislikes/web/lib/dislikeSuggestions.test.ts`
Expected: десять `✓` и `all passed`.

- [ ] **Step 5: Ключ кэша**

В `<tmp>/sw-dislikes/web/components/admin/library/queries.ts` в `libraryKeys` после строки `blocked: () => ['library', 'blocked'] as const,` добавить:

```ts
  // Dislike suggestions from the room — not Tracks, so not under `rows`.
  dislikes: () => ['library', 'dislikes'] as const,
```

- [ ] **Step 6: Карточка**

Создать `<tmp>/sw-dislikes/web/components/admin/library/DislikesCard.tsx`:

```tsx
'use client';

// Dislikes (Blocked tab): listeners mark tracks and artists with 👎 in the
// player; the room (deploy/room) keeps the marks and turns them into block
// suggestions. A dislike never changes the air by itself — Block here is the
// only way it does. Two backends on purpose: suggestions and decisions come
// from /room/admin/dislikes (the room has the controller check this same Basic
// token), blocking and the "already blocked" filter from the controller.

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, RefreshCw } from 'lucide-react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { cn } from '../../../lib/cn';
import { Card, Btn } from '../ui';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorState } from '@/components/ui/error-state';
import {
  checkRows, parseSuggestions, reasonLine, withoutBlocked,
  type Suggestion, type Suggestions,
} from '@/lib/dislikeSuggestions';
import { useLibrary } from './LibraryContext';
import { libraryKeys } from './queries';

// The room's refusals in the operator's words. Its 401 comes without
// WWW-Authenticate on purpose, so the browser never pops its own dialog.
const ROOM_ERRORS: Record<number, string> = {
  401: 'the room did not accept the admin sign-in — sign in again',
  429: 'too many wrong passwords — the controller locked sign-in for a while',
  502: "the room couldn't reach the controller",
};

async function roomAdmin(path: string, auth: string | null, body?: unknown): Promise<unknown> {
  const headers: Record<string, string> = {};
  if (auth) headers.Authorization = `Basic ${auth}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(`/room/admin${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('the room is unreachable');
  }
  if (!r.ok) throw new Error(ROOM_ERRORS[r.status] ?? `the room answered ${r.status}`);
  return r.json();
}

function Group({ label, items, busy, onBlock, onKeep }: {
  label: string;
  items: Suggestion[];
  busy: boolean;
  onBlock: (s: Suggestion) => void;
  onKeep: (s: Suggestion) => void;
}) {
  if (!items.length) return null;
  return (
    <>
      <div className="border-b border-dashed border-[var(--separator-strong)] px-4 py-2 text-[10px] tracking-wider text-muted uppercase">
        {label} · {items.length}
      </div>
      {items.map(s => (
        <div key={`${s.kind}:${s.key}`} className="flex items-center gap-3 border-b border-dashed border-[var(--separator-strong)] px-4 py-2.5 last:border-b-0">
          <span className="lib-mtag shrink-0" title={`disliked ${s.kind}`}>{s.kind}</span>
          <div className="min-w-0 flex-1">
            <div className="lib-title">{s.kind === 'artist' ? s.artist : s.title}</div>
            <div className="lib-artist">
              {s.kind === 'track' && s.artist ? `${s.artist} · ` : ''}{reasonLine(s)}
            </div>
          </div>
          <span className="hidden text-[11px] text-muted sm:block" title="last dislike">
            {s.lastAt ? new Date(s.lastAt).toLocaleDateString('en-GB') : ''}
          </span>
          <Btn sm tone="accent" onClick={() => onBlock(s)} disabled={busy}>
            <Ban size={12} /> Block
          </Btn>
          <Btn sm onClick={() => onKeep(s)} disabled={busy} title="keep it on air — hidden until a newer dislike">
            <Check size={12} /> Keep
          </Btn>
        </div>
      ))}
    </>
  );
}

export function DislikesCard() {
  const { adminFetch, ready, restampBlockMarks } = useLibrary();
  const { auth, hydrated } = useAdminAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: libraryKeys.dislikes(),
    enabled: ready && hydrated && !!auth,
    // Normalised inside the queryFn (web/CLAUDE.md, rule 3): the cache holds
    // exactly what renders — suggestions minus whatever the blocklist catches.
    queryFn: async (): Promise<Suggestions> => {
      const all = parseSuggestions(await roomAdmin('/dislikes', auth));
      const tracks = checkRows(all);
      if (!tracks.length) return all;
      const r = await adminFetch('/library/blocklist/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tracks }),
      });
      if (!r.ok) throw new Error(`blocklist check failed (${r.status})`);
      const j = await r.json() as { blocked?: Record<string, unknown> };
      return withoutBlocked(all, j.blocked ?? {});
    },
  });

  const decide = (s: Suggestion, action: 'keep' | 'blocked') =>
    roomAdmin('/dislikes/decide', auth, { kind: s.kind, key: s.key, action });

  const block = async (s: Suggestion) => {
    setBusy(true);
    try {
      const r = await adminFetch('/library/blocklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: s.kind, trackId: s.songId }),
      });
      // 409 = already on the list: for the operator that is the same success.
      if (!r.ok && r.status !== 409) {
        const j = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(j.error || `block failed (${r.status})`);
      }
      notify.ok(`“${s.kind === 'artist' ? s.artist : s.title}” will never air`);
      // The block stands even if the room can't record the decision: the
      // blocklist filter still hides the row; it would only come back after an
      // unblock, which is what this toast warns about.
      try {
        await decide(s, 'blocked');
      } catch (err) {
        notify.err(`blocked, but the room didn't record the decision: ${errorMessage(err)}`);
      }
      void qc.invalidateQueries({ queryKey: libraryKeys.blocked() });
      await restampBlockMarks();
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
      void q.refetch();
    }
  };

  const keep = async (s: Suggestion) => {
    setBusy(true);
    try {
      await decide(s, 'keep');
    } catch (err) {
      notify.err(errorMessage(err));
    } finally {
      setBusy(false);
      void q.refetch();
    }
  };

  const data = q.data;
  const total = data ? data.artists.length + data.tracks.length : 0;

  return (
    <Card
      title="Dislikes"
      sub={data && total ? `${total} to review — a dislike never blocks by itself` : ''}
      right={
        <Btn sm onClick={() => { void q.refetch(); }} disabled={q.isFetching}>
          <RefreshCw size={11} /> {q.isFetching ? 'Loading…' : 'Refresh'}
        </Btn>
      }
      bodyClass="!p-0"
    >
      {q.isError ? (
        <div className="m-4">
          <ErrorState
            title="Can't load dislikes"
            error={errorMessage(q.error)}
            onRetry={() => { void q.refetch(); }}
            retrying={q.isFetching}
          >
            <p>Suggestions come from the chat room service; the rest of this tab works without it.</p>
          </ErrorState>
        </div>
      ) : !data ? (
        <SkeletonRows rows={3} className="m-4" />
      ) : total === 0 ? (
        <EmptyState
          compact
          title="No dislikes to review"
          description="Listeners mark tracks and artists with 👎 in the player."
        />
      ) : (
        <div className={cn(q.isFetching && 'opacity-60 transition-opacity')}>
          <Group label="Artists" items={data.artists} busy={busy}
            onBlock={s => { void block(s); }} onKeep={s => { void keep(s); }} />
          <Group label="Tracks" items={data.tracks} busy={busy}
            onBlock={s => { void block(s); }} onKeep={s => { void keep(s); }} />
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 7: Карточка — первой на вкладке**

В `<tmp>/sw-dislikes/web/components/admin/library/tabs/BlockedTabContainer.tsx`:
- после `import { BlockedTab } from '../BlockedTab';` добавить `import { DislikesCard } from '../DislikesCard';`;
- в `return (` сразу после открывающего `<>` вставить:

```tsx
      {/* Dislike suggestions first: they are the inbox — decisions waiting for
          the operator. A Block there re-stamps and refreshes like any block. */}
      <DislikesCard />
```

- [ ] **Step 8: Типы и линтер**

```bash
npm --prefix <tmp>/sw-dislikes/web run typecheck
```

Expected: только старая ошибка `lib/roomPush.test.ts(43,…)`.

```powershell
Push-Location <tmp>\sw-dislikes\web; try { npx eslint lib/dislikeSuggestions.ts lib/dislikeSuggestions.test.ts components/admin/library/DislikesCard.tsx components/admin/library/queries.ts components/admin/library/tabs/BlockedTabContainer.tsx } finally { Pop-Location }
```

Expected: без ошибок.

- [ ] **Step 9: README l10n**

В `station/docs/web-changes.md` после раздела `## Вкладка Blocked: папки деревом и жанры папок` (перед `## Сборка`) вставить:

```markdown
## Вкладка Blocked: карточка Dislikes

Добавлена 2026-09-24 вместе с кнопкой 👎 (раздел «Дизлайки» выше). Карточка стоит
на вкладке **первой**: это входящие решения — песни и исполнители, которые
слушатели отметили «не нравится». Отметка сама ничего не блокирует; **Block** —
блок через тот же `POST /library/blocklist {type, trackId}`, что у строки
библиотеки, **Keep** — оставить в эфире, строка скроется до нового дизлайка.

| Где | Что |
|---|---|
| `lib/dislikeSuggestions.ts` + тест | разбор ответа комнаты, строки для `POST /library/blocklist/check`, отсев заблокированного, строка причины |
| `components/admin/library/DislikesCard.tsx` | карточка: предложения из `/room/admin/dislikes`, Block и Keep |
| `components/admin/library/queries.ts` | ключ `libraryKeys.dislikes()` |
| `components/admin/library/tabs/BlockedTabContainer.tsx` | карточка встаёт первой |

**Два бэкенда нарочно.** Предложения и решения — комната (отметки живут там), с тем
же Basic-токеном, что у `adminFetch`: пароль комната сверяет руками контроллера.
Блокировка и отсев — контроллер. Комната недоступна — ошибка в карточке, остальная
вкладка работает.

**Исполнитель проверяется в `check` одним именем** (`{id: "artist:<ключ>",
artist}`). С настоящим `songId` ответ «заблокирован» про одну песню — записью
трека или правилом по жанру и папке — выдал бы себя за блок всего исполнителя, и
предложение пропало бы незаслуженно. Трек проверяется со всеми полями (`title`,
`artist`, `album`): иначе треки заблокированных альбомов и правила по названию
остались бы в предложениях.

Тест — `npx --yes tsx web/lib/dislikeSuggestions.test.ts`.
```

- [ ] **Step 10: Пересобрать патч и проверить на чистом клоне**

```bash
W=<tmp>/sw-dislikes
git -C "$W" status --short
git -C "$W" add -A && git -C "$W" diff --cached HEAD > <repo>/station/docs/web-changes.md
grep -c "^diff --git" <repo>/station/docs/web-changes.md
rm -rf <tmp>/sw-check && git -c core.autocrlf=false clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git <tmp>/sw-check
git -C <tmp>/sw-check apply --check <repo>/station/docs/web-changes.md && echo APPLY_OK
```

Expected: в статусе — только файлы этой задачи сверх Task 5; счёт — `58`; `APPLY_OK`. Число в README l10n («Всего в патче … файлов.») — на фактическое (`58`).

- [ ] **Step 11: Коммит**

Сообщение:

```
Blocked: карточка Dislikes — предложения блокировки

Первой на вкладке: песни и исполнители, которые слушатели отметили «не
нравится». Block — тот же POST /library/blocklist, Keep — скрыть до нового
дизлайка. Заблокированное отсеивается через check; исполнитель — одним
именем, чтобы блок одной песни не выдал себя за блок всего исполнителя.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
P="station/docs/web-changes.md station/docs/web-changes.md"
git -C <repo> add $P
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- $P
```

---

### Task 7: Выкатка — Apache, комната, веб

Выполняет основная сессия. Порядок обязателен: Apache первым (`/room/admin` ни минуты не смотрит в интернет без второго рубежа), комната раньше веба (иначе новый плеер спрашивает несуществующие запросы).

**Files:**
- Modify: `station/deploy/apache-fm.conf.example`

**Interfaces:**
- Consumes: коммиты Tasks 1–6.
- Produces: живые `/room/dislikes`, `/room/admin/dislikes*`; образы `subwave-room:1`, `subwave-web:1.8.0-ru`; прежние — под тегами `subwave-room:1-pre-dislikes`, `subwave-web:1.8.0-ru-pre-dislikes`.

- [ ] **Step 1: Правило Apache**

В `station/deploy/apache-fm.conf.example` строку `<LocationMatch "^/(admin|api/(settings|system|debug|doctor|backup|mcp))">` и комментарий над ней привести к виду:

```apache
    # /room/admin — предложения блокировки по дизлайкам слушателей (deploy/room).
    # Пароль там проверяет контроллер; это правило — второй рубеж, как у /admin.
    <LocationMatch "^/(admin|room/admin|api/(settings|system|debug|doctor|backup|mcp))">
```

Коммит, сообщение:

```
Apache: /room/admin — только из приватных сетей

Предложения блокировки по дизлайкам — второй рубеж поверх пароля, который
комната проверяет руками контроллера, как у /admin.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git -C <repo> add station/deploy/apache-fm.conf.example
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- station/deploy/apache-fm.conf.example
```

- [ ] **Step 2: Выкатить Apache**

```bash
scp -P <ssh-port> -i <ssh-key> <repo>/station/deploy/apache-fm.conf.example <ssh-user>@<station-host>:/tmp/apache-fm.conf
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'sudo cp <deploy-dir>/deploy/apache-fm.conf <deploy-dir>/deploy/apache-fm.conf.bak-$(date +%Y%m%d-%H%M%S) && sudo cp /tmp/apache-fm.conf <deploy-dir>/deploy/apache-fm.conf && sudo apache2ctl configtest && sudo apache2ctl graceful && echo APACHE_OK'
```

Expected: `Syntax OK` и `APACHE_OK`. Откат — вернуть `.bak-*` и `graceful`.

- [ ] **Step 3: Выкатить комнату**

```bash
tar --force-local --exclude=__pycache__ -czf /tmp/room-src.tar.gz -C <repo> deploy/room music/normalize.py
scp -P <ssh-port> -i <ssh-key> /tmp/room-src.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'sudo docker tag subwave-room:1 subwave-room:1-pre-dislikes && rm -rf /tmp/room-build && mkdir -p /tmp/room-build && tar -xzf /tmp/room-src.tar.gz -C /tmp/room-build && cd /tmp/room-build && sudo docker build -q -f station/room/Dockerfile -t subwave-room:1 . && cd <deploy-dir>/subwave && sudo docker compose up -d room && curl -s --retry 10 --retry-delay 1 http://127.0.0.1:7700/room/health && curl -s -H "X-Listener-Id: probe" http://127.0.0.1:7700/room/dislikes && curl -s -o /dev/null -w " admin=%{http_code}\n" http://127.0.0.1:7700/room/admin/dislikes'
```

Expected: `{"ok": true}` (пока контейнер встаёт, Caddy отвечает 502, и `--retry` ждёт), `{"marks": {}}` у пробного id, `admin=401`. Откат — `sudo docker tag subwave-room:1-pre-dislikes subwave-room:1 && sudo docker compose up -d room`.

- [ ] **Step 4: Выкатить веб — из чистого клона и патча репозитория**

```bash
rm -rf <tmp>/sw-build && git -c core.autocrlf=false clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git <tmp>/sw-build
git -C <tmp>/sw-build apply <repo>/station/docs/web-changes.md && echo APPLY_OK
tar --force-local -czf /tmp/web-ru.tar.gz -C <tmp>/sw-build web
scp -P <ssh-port> -i <ssh-key> /tmp/web-ru.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'sudo docker tag subwave-web:1.8.0-ru subwave-web:1.8.0-ru-pre-dislikes && rm -rf /tmp/subwave-ru && mkdir -p /tmp/subwave-ru && tar -xzf /tmp/web-ru.tar.gz -C /tmp/subwave-ru && cd /tmp/subwave-ru && sudo docker build -q -f web/Dockerfile -t subwave-web:1.8.0-ru --build-arg SUBWAVE_BUILD_VERSION=1.8.0-ru . && cd <deploy-dir>/subwave && sudo docker compose up -d web && echo WEB_OK'
```

Expected: `APPLY_OK`, затем `WEB_OK` (сборка — около двух минут). Упала на `Turbopack is not supported … swc-linux-x64-musl` — повторить `docker build` с `--no-cache` (README l10n). Откат — `sudo docker tag subwave-web:1.8.0-ru-pre-dislikes subwave-web:1.8.0-ru && sudo docker compose up -d web`.

- [ ] **Step 5: Контейнеры живы**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <deploy-dir>/subwave && sudo docker compose ps --format "{{.Name}} {{.Status}}" && sudo docker logs sub-wave-room --tail 3'
```

Expected: все `sub-wave-*` — `Up`; в логе комнаты строка старта `room: :8080 → …`.

---

### Task 8: Живая приёмка и документация состояния

Выполняет основная сессия.

**Files:**
- Create (вне репозитория): `<tmp>/dislikes-accept.py`
- Modify: `station/docs/deploy.md` (таблица состояния), `AGENTS.md` (строка про закрытые пути), `CLAUDE.md` (грабли, число тестов), `station/room/README.md` (факт приёмки)

**Interfaces:**
- Consumes: живую станцию после Task 7; `ADMIN_USER`/`ADMIN_PASS` из `<deploy-dir>/subwave/.env` на Debian (в vault их нет).
- Produces: протокол приёмки (вывод скрипта) и документацию.

- [ ] **Step 1: Скрипт приёмки**

Создать `<tmp>/dislikes-accept.py`:

```python
"""Живая приёмка дизлайков — на Debian: python3 /tmp/dislikes-accept.py

Пробные слушатели ставят и снимают отметки на песнях окна станции, владелец
(пароль — из .env станции, не печатается) смотрит предложения и решает. Всё
пробное в конце снимается, пробный блок — тоже. OK/FAIL по пунктам §5 спеки,
код выхода 1 при любом FAIL.
"""
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:7700"
ENV = "<deploy-dir>/subwave/.env"
A = {"X-Listener-Id": "probe-dislikes-a", "X-Listener-Name": urllib.parse.quote("Проверка А")}
B = {"X-Listener-Id": "probe-dislikes-b", "X-Listener-Name": urllib.parse.quote("Проверка Б")}
failed: list[str] = []
undo: list[tuple[dict, str, str]] = []      # (слушатель, songId, kind) — снять в конце


def env(key: str) -> str:
    with open(ENV, encoding="utf-8") as f:
        for line in f:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"')
    sys.exit(f"{key} нет в {ENV}")


OWNER = {"Authorization": "Basic " + base64.b64encode(
    f"{env('ADMIN_USER')}:{env('ADMIN_PASS')}".encode()).decode()}


def call(path, body=None, headers=None, method=None):
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data,
                                 method=method or ("POST" if data is not None else "GET"),
                                 headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, r.headers, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, e.headers, json.loads(raw)
        except ValueError:
            return e.code, e.headers, raw.decode("utf-8", "replace")


def check(name, ok, detail=""):
    print(("OK   " if ok else "FAIL ") + name + ("" if ok else f" — {detail}"))
    if not ok:
        failed.append(name)


def dislike(who, song, kind, on=True):
    if on:
        undo.append((who, song, kind))
    return call("/room/dislikes", {"songId": song, "kind": kind, "on": on}, who)


def suggestions():
    code, _, body = call("/room/admin/dislikes", headers=OWNER)
    if code != 200:
        sys.exit(f"предложения не пришли: {code} {body}")
    return body


def row(rows, key):
    return next((r for r in rows if r["key"] == key), None)


_, _, state = call("/api/state")
cur = (state.get("current") or {}).get("subsonic_id")
if not cur:
    sys.exit("станция молчит: current пуст — приёмку отложить")
history = [h for h in state.get("history") or [] if h.get("subsonic_id") and h.get("artist")]

try:
    # 1. дизлайк текущей песни → отметка → строка у владельца с именем
    code, _, body = dislike(A, cur, "track")
    check("дизлайк текущей песни", code == 200 and body.get("track") is True, f"{code} {body}")
    _, _, marks = call("/room/dislikes", headers=A)
    check("отметка видна плееру", marks["marks"].get(cur, {}).get("track") is True, marks)
    r = row(suggestions()["tracks"], cur)
    check("строка у владельца с именем",
          bool(r) and any(x["name"] == "Проверка А" for x in r["listeners"]), r)

    # 2. две песни одного исполнителя → предложение исполнителя
    by_artist: dict[str, list[str]] = {}
    for h in history:
        by_artist.setdefault(h["artist"].strip().lower(), []).append(h["subsonic_id"])
    # история повторяет песни — пара берётся из РАЗНЫХ id
    pair = next((list(dict.fromkeys(ids))[:2] for ids in by_artist.values()
                 if len(set(ids)) >= 2), None)
    if pair:
        for sid in pair:
            dislike(A, sid, "track")
        artists = suggestions()["artists"]
        check("две песни → исполнитель", any(a["songs"] >= 2 for a in artists), artists)
    else:
        print("SKIP две песни → исполнитель: в окне нет исполнителя с двумя песнями")

    # 3. Keep прячет; новый дизлайк другого слушателя возвращает
    call("/room/admin/dislikes/decide", {"kind": "track", "key": cur, "action": "keep"}, OWNER)
    check("Keep прячет", row(suggestions()["tracks"], cur) is None)
    dislike(B, cur, "track")
    r = row(suggestions()["tracks"], cur)
    check("новый дизлайк возвращает", bool(r) and len(r["listeners"]) == 2, r)

    # 4. снятие отметки уменьшает счёт
    dislike(A, cur, "track", on=False)
    r = row(suggestions()["tracks"], cur)
    check("снятие уменьшает счёт", bool(r) and len(r["listeners"]) == 1, r)

    # 5. Block (как кнопка карточки) → Never play → строка ушла и не вернулась после разблокировки
    victim = next((h["subsonic_id"] for h in history
                   if h["subsonic_id"] != cur and h["subsonic_id"] not in (pair or [])), None)
    if victim:
        dislike(A, victim, "track")
        code, _, _ = call("/api/library/blocklist", {"type": "track", "trackId": victim}, OWNER)
        we_blocked = code == 201
        check("блок принят", code in (201, 409), code)
        call("/room/admin/dislikes/decide", {"kind": "track", "key": victim, "action": "blocked"}, OWNER)
        _, _, bl = call("/api/library/blocklist", headers=OWNER)
        check("запись в Never play",
              any(e["type"] == "track" and e["id"] == victim for e in bl["entries"]))
        check("строка ушла после блока", row(suggestions()["tracks"], victim) is None)
        if we_blocked:
            code, _, _ = call(f"/api/library/blocklist/track/{urllib.parse.quote(victim)}",
                              headers=OWNER, method="DELETE")
            check("разблокировано", code == 204, code)
            check("после разблокировки не вернулась", row(suggestions()["tracks"], victim) is None)
    else:
        print("SKIP Block: в окне нет подходящей прозвучавшей песни")

    # 6. без пароля — 401 без окна браузера
    code, headers, _ = call("/room/admin/dislikes")
    check("без пароля 401 без WWW-Authenticate",
          code == 401 and headers.get("WWW-Authenticate") is None, code)
finally:
    for who, sid, kind in undo:
        call("/room/dislikes", {"songId": sid, "kind": kind, "on": False}, who)
    # По отметкам, а не по предложениям: строку, скрытую решением владельца,
    # предложения не покажут, даже если пробная отметка осталась.
    left = {who["X-Listener-Id"]: call("/room/dislikes", headers=who)[2].get("marks")
            for who in (A, B)}
    check("пробные отметки сняты", all(m == {} for m in left.values()), left)

sys.exit(1 if failed else 0)
```

Решения владельца по пробным целям остаются в `dislike_decisions` — это безвредно: вернуть строку может только дизлайк новее решения, то есть настоящий.

- [ ] **Step 2: Прогнать приёмку**

```bash
scp -P <ssh-port> -i <ssh-key> <tmp>/dislikes-accept.py <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'python3 /tmp/dislikes-accept.py; echo EXIT=$?'
```

Expected: все строки `OK` (допустимы `SKIP` с причиной), `EXIT=0`. Любой `FAIL` — стоп и разбор через superpowers:systematic-debugging, не правка наугад. Если `FAIL` именно на «пробные отметки сняты» (песня успела уехать из окна и снятие получило 403), строки `probe-dislikes-*` удаляются из `<deploy-dir>/subwave/room/room.db` руками — скриптом-файлом, запущенным через `docker exec sub-wave-room python /data/<файл>`.

- [ ] **Step 3: Снаружи `/room/admin` закрыт**

Запрос из интернета — инструментом WebFetch (он ходит с внешних адресов) на `https://<station-domain>/room/admin/dislikes`. Expected: **403** от Apache. Если внешней точки нет — приём первой настройки: временно заменить в `Require ip` сети на заведомо чужую (`203.0.113.0/24`), `graceful`, из LAN по имени `https://<station-domain>/room/admin/dislikes` → 403, вернуть файл из репозитория и `graceful` снова.

- [ ] **Step 4: Глазами — плеер и админка**

Снимок плеера без звука headless-Edge:

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new --disable-gpu --window-size=1280,900 --virtual-time-budget=15000 --screenshot=<tmp>/dislikes-player.png https://<station-domain>/
```

Открыть `<tmp>/dislikes-player.png` (Read) и найти значок 👎 между сердцем и стрелкой скачивания в строке исполнителя. Если карточку закрыл оверлей «включить эфир» — снимок не довод ни в какую сторону, остаётся проверка владельцем. Меню, строку «Уже прозвучало» на телефоне и карточку Dislikes в админке (`http://<station-host>:7700/admin/library`, вкладка Blocked) снимком не проверить — попросить владельца посмотреть: меню открывается и на телефоне, галочки ставятся и снимаются, тост говорит «Решение за владельцем станции», карточка первая на вкладке, Block и Keep работают.

- [ ] **Step 5: Документация состояния**

1. `station/docs/deploy.md` — заголовок `## Состояние на 2026-09-23` → `## Состояние на 2026-09-24`; в таблицу после строки `| Чат | … |` добавить:

```markdown
| Дизлайки | кнопка 👎 в плеере (песня / исполнитель) — только сигнал, эфир не меняется; хранит комната (`room.db`, [`station/room/`](../../room/README.md)), предложения — карточка **Dislikes** первой на Admin → Library → Blocked (Block / Keep); снаружи `/room/admin` закрыт Apache, пароль проверяет контроллер |
```

2. `AGENTS.md` — в строке про станцию наружу `` `/admin` и правящие `/api/*` закрыты по адресу источника. `` → `` `/admin`, `/room/admin` и правящие `/api/*` закрыты по адресу источника. ``

3. `CLAUDE.md` — в раздел «Грабли» сразу после пункта «**Комната зависит от `cryptography`**» дописать:

```markdown
- **Пароль владельца в комнате проверяет контроллер.** `/room/admin/*` пересылает
  `Authorization` в `GET /settings` контроллера; своей копии пароля у комнаты нет.
  401 оттуда приходит **без** `WWW-Authenticate` намеренно: с ним браузер поднимает
  поверх админки своё окно входа. Дизлайки — только сигнал: эфир не меняется,
  блокирует владелец в карточке Dislikes.
- **Заблокирован ли исполнитель, спрашивать `check` строкой с одним именем**
  (`{id: "artist:<ключ>", artist}`). С настоящим `songId` ответ описывает песню:
  запись трека или правило по жанру и папке выдали бы себя за блок всего исполнителя.
```

   и в разделе «Тесты» обновить число и время быстрого набора — по прогону `python -m pytest -q -p no:cacheprovider` из корня (записать фактические).

4. `station/room/README.md` — в конец раздела «Дизлайки» дописать строку с датой и итогом приёмки (например: «Проверено на живой станции 2026-09-24: отметка, предложение исполнителя по двум песням, Keep/новый дизлайк, Block/разблокировка, 401 без пароля, 403 снаружи.» — только пункты, которые на деле прошли `OK`).

- [ ] **Step 6: Коммит документации**

Сообщение:

```
Дизлайки на станции: приёмка и документация

Выкачены комната, веб и правило Apache; живая приёмка прошла. README
станции, AGENTS.md и грабли в CLAUDE.md — про пароль через контроллер и
проверку исполнителя в check одним именем.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
P="station/docs/deploy.md AGENTS.md CLAUDE.md station/room/README.md"
git -C <repo> add $P
git -C <repo> commit -F <tmp>/dislikes-commit.txt -- $P
```

- [ ] **Step 7: Отправить в origin**

```bash
git -C <repo> push origin main
```

Expected: коммиты плана уехали на `git.<domain-2>`; зеркало на Gitea подтянет само.
