# Скачивание прозвучавшего — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** кнопка в плеере кладёт в загрузки файл коллекции — текущий трек и всё, что уже прозвучало.

**Architecture:** новая ручка `GET /room/download?id=` в контейнере комнаты. Она спрашивает у контроллера живое окно (`current` + вся `history`), сверяет с ним идентификатор, берёт файл из Navidrome читающей учёткой и переливает его слушателю кусками, переписав имя. Плеер получает ссылку и кнопку; секретов ему не достаётся, патч контроллера не трогается.

**Tech Stack:** Python 3.13 (только стандартная библиотека + `sqlite3`), `http.server`, Subsonic API Navidrome, Docker Compose, патч к Next.js-плееру subwave v1.8.0 (React, TypeScript, Tailwind, lucide-react).

**Spec:** [`docs/superpowers/specs/2026-09-22-track-download-design.md`](../specs/2026-09-22-track-download-design.md)

## Global Constraints

- **Зависимостей не добавлять.** Комната — стандартная библиотека и `sqlite3`, как `station/tts-bridge/bridge.py`. Никаких `requests`, `flask`, `aiohttp`.
- **Python в образе — 3.13** (`station/room/Dockerfile:6`, `FROM python:3.13-alpine`). Модуль `cgi` удалён в 3.13 — не использовать.
- **`music/repair.py` импортировать нельзя:** он тянет `music.db`, `music.m3u`, `music.itunes_export`, `mutagen`, а в образ копируется только `music/normalize.py`. Две строки констант дублируются осознанно.
- **Комментарии и докстринги — по-русски**, как во всех файлах `station/room/`. Объясняют **почему**, а не что.
- **Быстрый набор: бюджет 60 с на всё, порог 1 с на тест.** Сейчас 273 теста / 33 с, запаса нет (`FINDINGS.md`, P2, прогон 59.9 с под нагрузкой). Новый файл тестов обязан уложиться примерно в секунду.
- **Никакого реального времени в тестах.** Ни `sleep`, ни утверждений о `time.monotonic()`. Таймауты допустимы только как предохранитель от зависания набора.
- **Адрес контроллера:** `http://controller:7701/state` — без префикса `/api`, его снимает `handle_path /api/*` в Caddy.
- **`DOWNLOAD_SLOTS = 4`**, `CHUNK = 64 * 1024`, `DOWNLOAD_SOCKET_TIMEOUT = 300`, `DOWNLOAD_TIMEOUT = 30`, `ENVELOPE_CAP = 64 * 1024`, `STEM_MAX = 120`, `DEFAULT_STEM = "track"`.
- **Белый список заголовков наружу:** `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `Last-Modified`. Ничего больше — Navidrome шлёт `Set-Cookie` со своей сессией.
- **Иконка в плеере — `ArrowDownToLine`**, не `Download`: последний занят кнопкой установки PWA.
- **Патч плеера пересобирается только через `git add -A && git diff --cached HEAD > ru-web.patch`.** `git diff HEAD` не видит новых файлов и молча соберёт патч без кнопки.
- Правится **один скин из шести** — `classic`.

---

### Task 1: `naming.py` — имя файла и заголовок

**Files:**
- Create: `station/room/naming.py`
- Test: `tests/test_room_naming.py`

**Interfaces:**
- Consumes: ничего.
- Produces:
  - `filename(artist: str | None, title: str | None, ext: str = "mp3") -> str`
  - `disposition(name: str) -> str` — готовое значение заголовка `Content-Disposition`
  - `ext_from_disposition(value: str | None, default: str = "mp3") -> str`
  - `translit(s: str) -> str`
  - константы `DEFAULT_STEM = "track"`, `STEM_MAX = 120`

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_naming.py`:

```python
"""naming.py: имя скачиваемого файла и заголовок Content-Disposition.

Чистый модуль, сети нет — тест быстрый по построению.
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


naming = _load("naming")


def test_plain_name_is_artist_dash_title():
    assert naming.filename("Ария", "Улица Роз") == "Ария — Улица Роз.mp3"


def test_slash_in_artist_becomes_a_space():
    # В коллекции 45 таких треков: AC/DC. Слеш — разделитель пути на всех
    # трёх системах, подставлять его в имя нельзя.
    assert naming.filename("AC/DC", "Highway To Hell") == "AC DC — Highway To Hell.mp3"


def test_question_mark_and_quote_are_dropped():
    # 22 трека с «?» и столько же с «:» — запреты Windows, которые ловятся
    # только на чужой машине, если их не снять здесь.
    assert (naming.filename("Enrique Iglesias", 'Do You Know? "The Ping Pong Song"')
            == "Enrique Iglesias — Do You Know The Ping Pong Song.mp3")


def test_missing_artist_leaves_just_the_title():
    # 57 треков коллекции имеют пустой artist или title.
    assert naming.filename(None, "Антошка") == "Антошка.mp3"


def test_name_without_letters_or_digits_falls_back():
    # «★ — ★» после чистки даёт «- », формально непустое и бессмысленное:
    # поэтому проверяется наличие alnum, а не непустота.
    assert naming.filename("★", "★") == "track.mp3"
    assert naming.filename(None, None) == "track.mp3"


def test_trailing_dot_is_cut_from_the_stem_not_the_name():
    # 27 названий кончаются точкой. Чистить надо основу: по полному имени
    # rstrip(" .") не сработает никогда — там уже .mp3.
    assert naming.filename("Система", "B.Y.O.B.") == "Система — B.Y.O.B.mp3"


def test_windows_reserved_name_is_defused():
    assert naming.filename("CON", None) == "CON_.mp3"


def test_long_name_is_truncated_by_the_stem():
    long_title = "а" * 300
    name = naming.filename("Кто-то", long_title)
    assert name.endswith(".mp3")
    assert len(name) - len(".mp3") <= naming.STEM_MAX


def test_extension_comes_from_the_caller():
    assert naming.filename("X", "Y", "flac") == "X — Y.flac"


def test_disposition_carries_both_rfc6266_forms():
    value = naming.disposition("Ария — Улица Роз.mp3")
    assert 'filename="Ariya - Ulitsa Roz.mp3"' in value
    assert ("filename*=UTF-8''%D0%90%D1%80%D0%B8%D1%8F%20%E2%80%94"
            "%20%D0%A3%D0%BB%D0%B8%D1%86%D0%B0%20%D0%A0%D0%BE%D0%B7.mp3") in value
    assert value.startswith("attachment; ")


def test_disposition_is_latin1_encodable():
    # send_header кодирует значение latin-1 strict: кириллица роняет
    # обработчик ДО записи в сокет, то есть обрывом, а не кракозябрами.
    naming.disposition("Ария — Улица Роз.mp3").encode("latin-1")
    naming.disposition("трек уже не в эфире.txt").encode("latin-1")


def test_ascii_fallback_never_carries_percent_signs():
    # Safari percent-escapes в простом filename не декодирует и показывает
    # их буквально — поэтому запаска обязана быть чистой.
    value = naming.disposition("Ария — Улица Роз.mp3")
    ascii_part = value.split('filename="')[1].split('"')[0]
    assert "%" not in ascii_part


def test_extension_is_read_from_navidrome_header():
    assert naming.ext_from_disposition('attachment; filename="Ich Will.mp3"') == "mp3"
    assert naming.ext_from_disposition('attachment; filename="track.flac"') == "flac"


def test_extension_survives_navidrome_mojibake():
    # Для кириллицы Navidrome шлёт сырые UTF-8 байты в latin-1-заголовке.
    mojibake = 'attachment; filename="Ð£Ð»Ð¸Ñ†Ð° Ñ€Ð¾Ð·.mp3"'
    assert naming.ext_from_disposition(mojibake) == "mp3"


def test_extension_falls_back_when_absent_or_implausible():
    assert naming.ext_from_disposition(None) == "mp3"
    assert naming.ext_from_disposition("attachment") == "mp3"
    assert naming.ext_from_disposition('attachment; filename="no-extension"') == "mp3"
    assert naming.ext_from_disposition('attachment; filename="x.verylongext"') == "mp3"
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_naming.py -v`
Expected: FAIL — `FileNotFoundError` на `station/room/naming.py` при загрузке модуля.

- [ ] **Step 3: Написать модуль**

Создать `station/room/naming.py`:

```python
"""Имя скачиваемого файла и заголовок `Content-Disposition`.

Функция **чинящая, а не отказная**, и этим отличается от
`music/repair.py::filename_problem`: тот отменяет экспорт плейлиста, а здесь
имя приходит из ID3-тега чужого файла, и «не могу назвать файл» — не ответ
слушателю. Плохие символы заменяются, вырожденное имя получает дефолт.

Сам `music/repair.py` импортировать нельзя: он тянет `music.db`, `music.m3u`,
`music.itunes_export` и `mutagen`, а в образ копируется только
`music/normalize.py`. Поэтому две строки констант продублированы — это
дубль данных, а не второй реализации.

`music/normalize.py::norm()` для имени файла не годится: она опускает регистр,
выбрасывает пунктуацию и кириллицу не транслитерирует.
"""
import posixpath
import re
import unicodedata
import urllib.parse
from email.message import Message

# Те же, что в music/repair.py:16-18. Пересечение запретов Windows, macOS и
# ext4 совпадает с набором Windows — он и берётся.
_RESERVED = ({"CON", "PRN", "AUX", "NUL"}
             | {f"COM{i}" for i in range(1, 10)} | {f"LPT{i}" for i in range(1, 10)})
_BAD_CHARS = set('<>:"/\\|?*') | {chr(c) for c in range(32)}

DEFAULT_STEM = "track"
# В коллекции самое длинное «артист — название» — 111 символов, так что порог
# не режет ничего. Он стоит ради Safari, который обрезает длинный заголовок.
STEM_MAX = 120

_SPACES = re.compile(r"\s+")
_EXT_OK = re.compile(r"^[A-Za-z0-9]{1,5}$")

# NFKD кириллицу не раскладывает, а стирает: «Ария — Улица Роз» превращается в
# три пробела. Кириллица есть у 2255 треков из 4631, поэтому таблица
# обязательна, а NFKD идёт после неё — добирать обычную диакритику.
_CYR = {
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e",
    "ж": "zh", "з": "z", "и": "i", "й": "y", "к": "k", "л": "l", "м": "m",
    "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u",
    "ф": "f", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "і": "i", "ї": "yi", "є": "ye", "ґ": "g",
}
# Латинские лигатуры и типографика, которые NFKD тоже не раскладывает.
_EXTRA = {"æ": "ae", "ø": "o", "đ": "d", "ł": "l", "ß": "ss", "þ": "th",
          "ð": "d", "œ": "oe", "№": "No", "—": "-", "–": "-",
          "«": "'", "»": "'", "…": "..."}


def translit(s: str) -> str:
    """ASCII-приближение строки: таблица, затем NFKD хвостом."""
    out = []
    for ch in s:
        rep = _CYR.get(ch.lower())
        if rep is None:
            rep = _EXTRA.get(ch.lower())
        if rep is None:
            out.append(ch)
            continue
        out.append(rep.capitalize() if ch.isupper() and rep[:1].isalpha() else rep)
    folded = unicodedata.normalize("NFKD", "".join(out))
    return folded.encode("ascii", "ignore").decode()


def _has_alnum(s: str) -> bool:
    """Есть ли в строке хоть одна буква или цифра.

    Проверять непустоту недостаточно: «★ — ★» после чистки даёт «- ».
    """
    return any(c.isalnum() for c in s)


def _clean(text: str) -> str:
    text = "".join(" " if ch in _BAD_CHARS else ch for ch in text)
    return _SPACES.sub(" ", text).strip(" .")


def filename(artist: str | None, title: str | None, ext: str = "mp3") -> str:
    """«Артист — Название.mp3», пригодное для файловой системы.

    Хвостовые точки и пробелы снимаются у **основы**, до приклеивания
    расширения: по готовому имени `strip(" .")` не сработает никогда.
    """
    parts = [p.strip() for p in (artist or "", title or "") if p and p.strip()]
    stem = _clean(" — ".join(parts))
    if not _has_alnum(stem):
        stem = DEFAULT_STEM
    if stem.split(".")[0].upper() in _RESERVED:
        stem += "_"
    stem = stem[:STEM_MAX].strip(" .")
    return f"{stem}.{ext}"


def disposition(name: str) -> str:
    """Значение `Content-Disposition` с обеими формами RFC 6266.

    Обе обязательны. Только `filename*=` — и клиент, который её не понял,
    увидит `attachment` без имени и назовёт файл по последнему сегменту пути,
    то есть `download` без расширения. Только `filename=` — и кириллица
    теряется у всех. Percent-escapes в простом `filename` Safari не
    декодирует, поэтому запаска держится чистым ASCII.

    Имя ожидается уже вычищенным (`filename()` либо литерал отказа).
    """
    fallback = _clean(translit(name))
    if not _has_alnum(fallback):
        fallback = DEFAULT_STEM
    # Кавычку и обратный слеш проще не пускать в quoted-string вовсе:
    # quoted-pair браузеры разбирают неодинаково, а в имени файла эти символы
    # всё равно запрещены.
    quoted = fallback.replace("\\", "_").replace('"', "'")
    star = urllib.parse.quote(name, safe="", encoding="utf-8")
    return f"attachment; filename=\"{quoted}\"; filename*=UTF-8''{star}"


def ext_from_disposition(value: str | None, default: str = "mp3") -> str:
    """Расширение из заголовка Navidrome.

    В окне станции ни `suffix`, ни `path` нет, поэтому расширение берётся
    отсюда. `rest/stream` заголовка не шлёт вовсе — только `rest/download`.

    Белый список обязателен: без него «расширение» из чужого заголовка
    попало бы в наше имя как есть. `cgi.parse_header` для разбора непригоден —
    модуль удалён в Python 3.13, а образ комнаты на нём и стоит.
    """
    msg = Message()
    msg["Content-Disposition"] = value or ""
    ext = posixpath.splitext(msg.get_filename() or "")[1].lstrip(".")
    return ext.lower() if _EXT_OK.match(ext) else default
```

- [ ] **Step 4: Прогнать тесты**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_naming.py -v`
Expected: PASS, 14 тестов.

- [ ] **Step 5: Коммит**

```bash
git add station/room/naming.py tests/test_room_naming.py
git commit -m "Имя скачиваемого файла: транслитерация таблицей, обе формы RFC 6266"
```

---

### Task 2: `station.py` — живое окно

**Files:**
- Create: `station/room/station.py`
- Test: `tests/test_room_station.py`

**Interfaces:**
- Consumes: ничего.
- Produces: `window(base: str, timeout: float = TIMEOUT) -> dict[str, dict]` — отображение `subsonic_id → {"artist": …, "title": …}`; константа `TIMEOUT = 10`.
- Бросает `RuntimeError` при пустом `base`, `ValueError` при неразобранном ответе, сетевые исключения наружу как есть — вызывающий превращает их в `502`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_station.py`:

```python
"""station.py: окно станции — что сейчас звучит и что уже прозвучало.

Контроллер подделан на уровне urlopen: своей сети тест не трогает.
"""
import importlib.util
import json
import sys
import urllib.request
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


station = _load("station")


class FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _state(current=None, history=(), upcoming=()):
    return {"current": current, "history": list(history), "upcoming": list(upcoming)}


def _track(sid, artist="A", title="T"):
    return {"subsonic_id": sid, "artist": artist, "title": title}


@pytest.fixture
def asked(monkeypatch):
    urls = []
    payload = {"value": _state()}

    def fake_urlopen(url, timeout=None):
        urls.append(url if isinstance(url, str) else url.full_url)
        return FakeResponse(payload["value"])

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return urls, payload


def test_window_holds_current_and_all_history(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur"),
                              history=[_track(f"h{i}") for i in range(50)])
    win = station.window("http://controller:7701")
    assert set(win) == {"cur"} | {f"h{i}" for i in range(50)}


def test_window_carries_artist_and_title_for_the_filename(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur", "Ария", "Улица Роз"))
    assert station.window("http://controller:7701")["cur"] == {
        "artist": "Ария", "title": "Улица Роз"}


def test_upcoming_is_not_in_the_window(asked):
    # Трек, который ещё не звучал, не «прозвучавший». Слить три списка одним
    # проходом по snapshot — самая естественная ошибка здесь.
    _, payload = asked
    payload["value"] = _state(current=_track("cur"), upcoming=[_track("next")])
    assert "next" not in station.window("http://controller:7701")


def test_short_history_is_not_a_failure(asked):
    # После рестарта контроллера история короткая — это не отказ.
    _, payload = asked
    payload["value"] = _state(current=_track("cur"), history=[_track("h0")])
    assert set(station.window("http://controller:7701")) == {"cur", "h0"}


def test_silent_station_gives_an_empty_window_not_a_crash(asked):
    # current == null бывает на свежем старте (streamIdle).
    _, payload = asked
    payload["value"] = _state(current=None, history=[])
    assert station.window("http://controller:7701") == {}


def test_entries_without_an_id_are_skipped(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur"),
                              history=[{"artist": "X", "title": "Y"}])
    assert set(station.window("http://controller:7701")) == {"cur"}


def test_newest_wins_when_a_track_repeats(asked):
    _, payload = asked
    payload["value"] = _state(current=None,
                              history=[_track("same", "новое", "новое"),
                                       _track("same", "старое", "старое")])
    assert station.window("http://controller:7701")["same"]["artist"] == "новое"


def test_url_has_no_api_prefix(asked):
    # Внутри сети стека контроллер отвечает на /state: префикс /api снимает
    # handle_path в Caddy, и снаружи его добавляет тоже он.
    urls, _ = asked
    station.window("http://controller:7701/")
    assert urls == ["http://controller:7701/state"]


def test_empty_address_is_a_configuration_error(asked):
    with pytest.raises(RuntimeError):
        station.window("")


def test_garbage_answer_is_an_error_not_an_empty_window(asked, monkeypatch):
    # Пустое окно означает «скачивать нечего», а неразобранный ответ —
    # «спросить не удалось». Это разные ответы слушателю (403 против 502).
    class Garbage:
        def read(self):
            return b"<html>gateway</html>"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout=None: Garbage())
    with pytest.raises(ValueError):
        station.window("http://controller:7701")
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_station.py -v`
Expected: FAIL — модуля `station/room/station.py` нет.

- [ ] **Step 3: Написать модуль**

Создать `station/room/station.py`:

```python
"""Живое окно станции: что звучит сейчас и что уже прозвучало.

Комната спрашивает контроллер на **каждый** запрос скачивания и ответ не
кэширует. Окно живёт минутами, а кэш сделал бы отказ для уехавшего трека
недостижимым — то есть ровно ту границу, ради которой ручка и заведена.

Внутри сети стека у контроллера нет префикса `/api`: его снимает
`handle_path /api/*` в Caddy, поэтому запрашивается `/state`.

Отдаётся **отображение**, а не множество идентификаторов: из этих же данных
собирается имя файла (`artist`, `title`), и множество их потеряло бы.
"""
import json
import urllib.request

TIMEOUT = 10


def window(base: str, timeout: float = TIMEOUT) -> dict[str, dict]:
    """`subsonic_id → {"artist", "title"}` для текущего трека и всей истории.

    `upcoming` не входит: трек, который ещё не звучал, не «прозвучавший».

    Пустое окно (молчащая станция, `current == null`) — законный ответ,
    означающий «скачивать нечего». Неразобранный ответ — исключение:
    «нельзя» и «не смог спросить» разные вещи, и вызывающий отвечает на них
    по-разному.
    """
    if not base:
        raise RuntimeError("адрес контроллера не задан (CONTROLLER_URL)")
    url = base.rstrip("/") + "/state"
    with urllib.request.urlopen(url, timeout=timeout) as r:
        raw = r.read()
    try:
        state = json.loads(raw.decode("utf-8", "replace"))
    except ValueError as e:
        raise ValueError(f"состояние станции не разобралось: {e}") from e
    if not isinstance(state, dict):
        raise ValueError("состояние станции — не объект JSON")

    out: dict[str, dict] = {}
    items = [state.get("current")] + list(state.get("history") or [])
    for item in items:
        if not isinstance(item, dict):
            continue
        sid = item.get("subsonic_id")
        if not sid:
            continue
        # История идёт новейшим вперёд, поэтому при повторе трека выигрывает
        # свежая запись — та, чьё имя слушатель и видит на экране.
        out.setdefault(sid, {"artist": item.get("artist"), "title": item.get("title")})
    return out
```

- [ ] **Step 4: Прогнать тесты**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_station.py -v`
Expected: PASS, 10 тестов.

- [ ] **Step 5: Коммит**

```bash
git add station/room/station.py tests/test_room_station.py
git commit -m "Окно станции: текущий трек и вся история, отображением а не множеством"
```

---

### Task 3: `subsonic.download()` — поток к Navidrome

**Files:**
- Modify: `station/room/subsonic.py`
- Test: `tests/test_room_subsonic_download.py`

**Interfaces:**
- Consumes: ничего из предыдущих задач.
- Produces:
  - `download(track_id, base, user, password, rng=None, timeout=DOWNLOAD_TIMEOUT)` — возвращает объект `urlopen` **не прочитанным**: `.status`, `.headers` (`email.message.Message`, регистронезависимый `.get()`), `.read(size)`, контекстный менеджер.
  - `envelope_code(body: bytes) -> int | None` — код ошибки из конверта Subsonic.
  - `DOWNLOAD_TIMEOUT = 30`
  - `_auth_params(user, password) -> dict` — общий рецепт авторизации.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_subsonic_download.py`:

```python
"""subsonic.download(): открыть поток к Navidrome, не читая тело.

Файл 8–14 МБ, и прочитать его в память значит отдать столько же тому, кто
попросил, — поэтому функция возвращает открытый ответ, а не байты.
"""
import importlib.util
import sys
import urllib.parse
import urllib.request
from email.message import Message
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "deploy" / "room"))


def _load(name: str):
    path = ROOT / "deploy" / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"dl_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"dl_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


subsonic = _load("subsonic")


class FakeUpstream:
    def __init__(self, body=b"", headers=None, status=200):
        self._body, self._pos, self.status = body, 0, status
        self.headers = Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self, size=-1):
        chunk = self._body[self._pos:] if size in (-1, None) \
            else self._body[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def captured(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url if hasattr(req, "full_url") else req
        seen["headers"] = dict(getattr(req, "headers", {}))
        seen["timeout"] = timeout
        return FakeUpstream(b"ID3data", {"Content-Type": "audio/mpeg"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_download_hits_the_download_endpoint_with_json_envelope(captured):
    subsonic.download("abc", "http://nav", "u", "p")
    url = urllib.parse.urlparse(captured["url"])
    q = urllib.parse.parse_qs(url.query)
    assert url.path == "/rest/download"
    assert q["id"] == ["abc"]
    # f=json обязателен: без него конверт ошибки приедет XML и разобрать его
    # будет нечем.
    assert q["f"] == ["json"]
    assert q["c"] == ["subwave-room"] and q["u"] == ["u"]
    assert q["t"] and q["s"]          # salt и token, а не пароль в адресе
    assert "p" not in url.query


def test_password_never_appears_in_the_url(captured):
    subsonic.download("abc", "http://nav", "user", "s3cret")
    assert "s3cret" not in captured["url"]


def test_range_is_passed_through_to_navidrome(captured):
    subsonic.download("abc", "http://nav", "u", "p", rng="bytes=0-1023")
    # urllib нормализует имя заголовка через .capitalize()
    assert captured["headers"].get("Range") == "bytes=0-1023"


def test_no_range_means_no_header(captured):
    subsonic.download("abc", "http://nav", "u", "p")
    assert "Range" not in captured["headers"]


def test_body_is_not_read_by_download(captured):
    resp = subsonic.download("abc", "http://nav", "u", "p")
    assert resp.read(4) == b"ID3d"      # поток не тронут до вызывающего


def test_timeout_is_its_own_not_the_search_one(captured):
    subsonic.download("abc", "http://nav", "u", "p")
    assert captured["timeout"] == subsonic.DOWNLOAD_TIMEOUT
    assert subsonic.DOWNLOAD_TIMEOUT != subsonic.TIMEOUT


def test_envelope_code_reads_the_subsonic_failure():
    # Ошибки Navidrome приезжают с HTTP 200 и вот таким телом — исключения
    # не будет, и except HTTPError их не поймает.
    body = (b'{"subsonic-response":{"status":"failed",'
            b'"error":{"code":70,"message":"not found"}}}')
    assert subsonic.envelope_code(body) == 70


def test_envelope_code_of_something_else_is_none():
    assert subsonic.envelope_code(b"ID3\x03\x00\x00") is None
    assert subsonic.envelope_code(b'{"subsonic-response":{"status":"ok"}}') is None
    assert subsonic.envelope_code(b"") is None
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_subsonic_download.py -v`
Expected: FAIL — `AttributeError: module has no attribute 'download'`.

- [ ] **Step 3: Дописать модуль**

В `station/room/subsonic.py`. Сперва вынести рецепт авторизации: он уже есть внутри `resolve()::ask()` — те строки, где считается `salt`, `token` и собираются `urlencode`-параметры. Заменить их обращением к новой функции, чтобы рецепт остался один.

Добавить рядом с `TIMEOUT`:

```python
# Поиск и скачивание живут в разном времени: поиск — один короткий запрос,
# скачивание — перелив 8-14 МБ, и таймаут там стоит на каждой порции чтения.
DOWNLOAD_TIMEOUT = 30
```

Добавить функции:

```python
def _auth_params(user: str, password: str) -> dict:
    """Общий для всех вызовов рецепт Subsonic: соль и `md5(pass + salt)`.

    Пароль в адрес не попадает никогда.
    """
    salt = secrets.token_hex(8)
    return {"u": user,
            "t": hashlib.md5((password + salt).encode("utf-8")).hexdigest(),
            "s": salt, "v": "1.16.1", "c": "subwave-room", "f": "json"}


def download(track_id: str, base: str, user: str, password: str,
             rng: str | None = None, timeout: float = DOWNLOAD_TIMEOUT):
    """Открыть поток к файлу. Тело **не читается** — его переливает вызывающий.

    `rest/download` отдаёт файл как есть, без перекодирования, и в отличие от
    `rest/stream` шлёт `Content-Disposition` — единственный источник, из
    которого берётся расширение.

    `Range` пробрасывается как есть: Navidrome отвечает честным `206`, и
    `urlopen` в исключение его не превращает.
    """
    params = urllib.parse.urlencode({"id": track_id, **_auth_params(user, password)})
    url = f"{base.rstrip('/')}/rest/download?{params}"
    req = urllib.request.Request(url, headers={"Range": rng} if rng else {})
    return urllib.request.urlopen(req, timeout=timeout)


def envelope_code(body: bytes) -> int | None:
    """Код ошибки из конверта Subsonic, если тело — конверт, а не файл.

    Navidrome отвечает на несуществующий идентификатор **кодом 200** и телом
    `{"subsonic-response":{"status":"failed","error":{"code":70}}}`, а на
    негодную учётку — тем же с кодом 40. Исключения не будет, поэтому
    различать приходится по телу.
    """
    try:
        payload = json.loads(body.decode("utf-8", "replace"))
    except (ValueError, AttributeError):
        return None
    if not isinstance(payload, dict):
        return None
    error = ((payload.get("subsonic-response") or {}).get("error") or {})
    code = error.get("code")
    return code if isinstance(code, int) else None
```

- [ ] **Step 4: Прогнать тесты — новый файл и старый, чтобы вынос рецепта ничего не сломал**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_subsonic_download.py tests/test_room_resolve.py -v`
Expected: PASS — 9 новых плюс весь существующий набор `resolve` без изменений.

- [ ] **Step 5: Коммит**

```bash
git add station/room/subsonic.py tests/test_room_subsonic_download.py
git commit -m "subsonic.download: поток к файлу, конверт ошибки с кодом 200, общий рецепт авторизации"
```

---

### Task 4: ручка `/download` — окно, отказ файлом, потоковая отдача

**Files:**
- Modify: `station/room/server.py`
- Test: `tests/test_room_download.py`

**Interfaces:**
- Consumes: `naming.filename`, `naming.disposition`, `naming.ext_from_disposition` (Task 1); `station.window` (Task 2); `subsonic.download`, `subsonic.envelope_code` (Task 3).
- Produces: маршрут `GET /download?id=`; поля `Config.controller_url: str = ""` и `Config.download_slots: int = 4`; константы `CHUNK`, `DOWNLOAD_SOCKET_TIMEOUT`, `ENVELOPE_CAP`, `PASS_HEADERS`; методы `Handler._refuse(code, name, text)` и `Handler._download(query)`.

- [ ] **Step 1: Написать падающий тест**

Создать `tests/test_room_download.py`:

```python
"""Ручка /download на поднятом в тесте сервере.

Фикстура своя, а не расширение `room` из test_room_server.py: ту распаковывают
тремя элементами четырнадцать тестов. Клиентский хелпер тоже свой — `call()`
оттуда всегда делает json.loads и на файле бросил бы JSONDecodeError.

Navidrome и контроллер подделаны на уровне `urllib.request.urlopen`, а не
подменой `subsonic.download`: только так проверка «Navidrome не спрошен вовсе»
ловит любой путь в сеть, а не один конкретный.
"""
import importlib.util
import json
import sys
import threading
import urllib.error
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
    spec = importlib.util.spec_from_file_location(f"dl_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"dl_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


server_mod = _load("server")
store_mod = _load("store")

AUDIO = b"ID3" + b"\x00" * 4093          # 4096 байт, два куска по 2 КБ не наберут


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


@pytest.fixture
def room(tmp_path, monkeypatch):
    store = store_mod.Store(str(tmp_path / "room.db"))
    config = server_mod.Config(
        navidrome=("http://navidrome", "u", "p"),
        controller_url="http://controller:7701",
        download_slots=2)
    station = Station()
    upstreams = []
    net = []

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        net.append(url)
        if "/state" in url:
            return station.response()
        up = upstreams.pop(0) if upstreams else FakeUpstream()
        up.request_headers = dict(getattr(req, "headers", {}))
        return up

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(store, config))
    # poll_interval по умолчанию 0.5 с, и столько же ждёт shutdown() в каждом
    # teardown — четверть бюджета быстрого набора ни на что.
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "station": station,
           "upstreams": upstreams, "net": net, "config": config}
    srv.shutdown()
    srv.server_close()
    store.close()


def fetch(base, path, headers=None):
    """(код, заголовки, тело). Отказы тоже несут тело — их и проверяем."""
    req = urllib.request.Request(base + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


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
    _, headers, _ = fetch(room["base"], "/download?id=old")
    assert "AC DC" in headers.get("Content-Disposition")
    assert "AC/DC" not in headers.get("Content-Disposition")


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
    # Трек, который ещё не звучал, не «прозвучавший».
    code, _, _ = fetch(room["base"], "/download?id=soon")
    assert code == 403


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
    def boom(req, timeout=None):
        raise OSError("controller unreachable")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    code, headers, _ = fetch(room["base"], "/download?id=cur")
    assert code == 502
    assert "attachment" in headers.get("Content-Disposition")


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


def test_body_is_streamed_in_bounded_chunks(room):
    up = FakeUpstream()
    room["upstreams"].append(up)
    fetch(room["base"], "/download?id=cur")
    # Равенство 65536 проверять нельзя: важно, что кусок ограничен, а не что
    # он ровно такой. Сам факт «не читалось целиком» пиннит assert в FakeUpstream.
    assert up.reads and max(up.reads) <= 64 * 1024
```

- [ ] **Step 2: Прогнать и убедиться, что падает**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_download.py -v`
Expected: FAIL — `TypeError: Config.__init__() got an unexpected keyword argument 'controller_url'`.

- [ ] **Step 3: Дописать `server.py`**

К импортам добавить `import threading`, `import naming`, `import station`.

Рядом с `DISCARD_CAP` добавить:

```python
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
```

В `Config` добавить два поля:

```python
    controller_url: str = ""
    download_slots: int = 4
```

В `build_handler`, до `class Handler`:

```python
    # Счётчик живёт на сервере, а не модульной глобалью: тесты поднимают
    # несколько серверов в одном процессе, и общий счётчик протёк бы между ними.
    slots = threading.BoundedSemaphore(config.download_slots)
```

В `Handler` добавить два метода:

```python
        def _refuse(self, code: int, name: str, text: str) -> None:
            """Отказ приезжает файлом с говорящим именем.

            Ссылка `<a href download>` того же origin скачивает тело ЛЮБОГО
            ответа, поэтому без этого в «Загрузках» оказался бы json-конверт
            под именем песни. Тост потребовал бы предварительной пробы —
            второго запроса и состояния в компоненте под `memo`.
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
                self._refuse(502, "станция недоступна.txt",
                             f"Не удалось спросить станцию, что сейчас в эфире: {e}\n")
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
            try:
                upstream = subsonic.download(track_id, base, user, password,
                                             rng=self.headers.get("Range"))
            except Exception as e:                       # noqa: BLE001
                self._refuse(502, "не удалось получить файл.txt",
                             f"Navidrome не ответил: {e}\n")
                return
            with upstream:
                # Ошибки Navidrome приходят с кодом 200 и конвертом, а не
                # исключением, поэтому «файл или отказ» решается по типу — и
                # решается ДО первого send_response: после него передумать нельзя.
                ctype = (upstream.headers.get("Content-Type") or "").lower()
                if not ctype.startswith("audio/"):
                    code = subsonic.envelope_code(upstream.read(ENVELOPE_CAP))
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
            except OSError:
                # Слушатель отменил закачку. handle_one_request ловит только
                # TimeoutError, поэтому без этого трейсбек уехал бы в stderr
                # контейнера на каждую отмену.
                self.close_connection = True
                return
            try:
                if declared is not None and sent != int(declared):
                    self.close_connection = True
            except ValueError:
                self.close_connection = True
```

В `do_GET` добавить ветку перед `else`:

```python
            elif path == "/download":
                self._download(query)
```

В `main()` дописать чтение переменных:

```python
        controller_url=os.environ.get("CONTROLLER_URL", ""),
        download_slots=int(os.environ.get("DOWNLOAD_SLOTS", "4")),
```

и строку старта заменить на такую, чтобы ненастроенная зависимость была видна сразу:

```python
    print(f"room: :{port} → {config.navidrome[0] or 'без Navidrome'}"
          f", станция {config.controller_url or 'НЕ ЗАДАНА'}", flush=True)
```

- [ ] **Step 4: Прогнать тесты**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_download.py tests/test_room_server.py -v`
Expected: PASS — 14 новых плюс существующий набор сервера без изменений.

- [ ] **Step 5: Коммит**

```bash
git add station/room/server.py tests/test_room_download.py
git commit -m "Ручка /download: окно раньше слота, отказ файлом, перелив кусками"
```

---

### Task 5: слоты, порядок отказов и живая сверка

**Files:**
- Modify: `tests/test_room_download.py`
- Create: `tests/test_room_download_live.py` (под маркером `integration`)
- Modify: `station/room/server.py` (только если тесты найдут дефект)

**Interfaces:**
- Consumes: всё из Task 4.
- Produces: для других задач ничего — это приёмка поведения слотов, порядка отказов и сверка с живым стеком.

- [ ] **Step 1: Дописать тесты в `tests/test_room_download.py`**

Добавить в конец файла:

```python
def _hold(room, count):
    """Занять `count` слотов заблокированными отдачами. Без часов.

    Занятость моделируется воротами, которые отпускает сам тест: `sleep` и
    утверждения о прошедшем времени краснеют от чужой нагрузки — этим уже
    отличился test_tts_bridge.py::test_busy_engine_waits_for_its_turn.
    """
    gate = threading.Event()
    started = threading.Semaphore(0)
    for _ in range(count):
        room["upstreams"].append(FakeUpstream(gate=gate, started=started))
    threads = [threading.Thread(target=lambda: fetch(room["base"], "/download?id=cur"),
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
        assert fetch(room["base"], "/download?id=cur")[0] == 404
    # Если бы release стоял не в finally, слоты кончились бы здесь.
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_a_slot_comes_back_after_the_listener_cancels(room):
    """Оборванная закачка не должна съедать слот навсегда.

    Четыре отменённые закачки иначе кладут ручку для всех, а в stderr
    контейнера уезжает трейсбек на каждую отмену.
    """
    import socket
    import urllib.parse

    parts = urllib.parse.urlparse(room["base"])
    for _ in range(room["config"].download_slots):
        s = socket.create_connection((parts.hostname, parts.port), timeout=5)
        s.sendall(b"GET /download?id=cur HTTP/1.1\r\n"
                  b"Host: localhost\r\nConnection: close\r\n\r\n")
        s.recv(64)
        s.close()
    assert fetch(room["base"], "/download?id=cur")[0] == 200


def test_unknown_id_is_refused_even_when_all_slots_are_busy(room):
    """Окно проверяется раньше слота, и этот порядок — решение, а не случайность.

    Слот ограничивает трафик, а запрос, который ничего не передаст, занимать
    его не должен. Обратный порядок отвечал бы `429` на чужой идентификатор и
    прятал бы настоящую причину за временной.
    """
    gate, threads = _hold(room, room["config"].download_slots)
    try:
        assert fetch(room["base"], "/download?id=nosuch")[0] == 403
        assert [u for u in room["net"] if "/rest/" in u] == []
    finally:
        gate.set()
        for t in threads:
            t.join(timeout=5)
```

- [ ] **Step 2: Прогнать — часть тестов должна упасть, если `release` не в `finally`**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_download.py -v`
Expected: PASS, если Task 4 сделан как написано. Если красный — чинить `server.py`, а не тест: `slots.release()` обязан стоять в `finally`, а `OSError` в `_pump` — перехватываться.

- [ ] **Step 3: Замерить время файла**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_download.py --durations=5`
Expected: весь файл — порядка секунды; ни один тест не дольше 1 с. Если дольше — искать `poll_interval` в фикстуре и таймауты-предохранители, а не поднимать бюджет.

- [ ] **Step 4: Написать живую сверку под маркером `integration`**

Быстрые тесты пиннят **наше** нарезание окна, но не то, в каком порядке историю отдаёт контроллер. Смени апстрим направление — быстрый набор останется зелёным, а окно начнёт выдавать старейшее из полусотни. Ловится это только на живом стеке.

Создать `tests/test_room_download_live.py`:

```python
"""Живая сверка со стеком. Быстрый набор её не гоняет (маркер `integration`).

Здесь проверяется ровно то, чего быстрый набор проверить не может: порядок,
в котором историю отдаёт контроллер, и что отданный файл не обрезан и не
перекодирован по дороге.
"""
import json
import os
import urllib.request

import pytest

pytestmark = pytest.mark.integration

STATION = os.environ.get("STATION_URL", "http://<station-host>:7700")


def _get(path, headers=None):
    req = urllib.request.Request(STATION + path, headers=headers or {})
    return urllib.request.urlopen(req, timeout=30)


def _state():
    with _get("/api/state") as r:
        return json.load(r)


def test_history_arrives_newest_first():
    """Направление истории задаёт контроллер, и окно на нём стоит."""
    state = _state()
    if not state.get("current") or not state.get("history"):
        pytest.skip("станция молчит — сверять нечего")
    assert state["history"][0]["endedAt"] == state["current"]["startedAt"]


def test_every_window_entry_carries_an_id():
    state = _state()
    for item in [state.get("current")] + list(state.get("history") or []):
        if item:
            assert item.get("subsonic_id"), f"запись без идентификатора: {item}"


def test_downloaded_file_is_whole_and_not_transcoded():
    """Длина отданного совпадает с тем, что Navidrome знает о файле.

    Побайтовая сверка с шарой — ручной шаг приёмки (sha256 на Debian):
    путь файла в окно станции не приходит, а тянуть его из каталога проекта
    значит связать тест с ещё одной базой.
    """
    state = _state()
    if not state.get("current"):
        pytest.skip("станция молчит")
    track_id = state["current"]["subsonic_id"]
    with _get(f"/room/download?id={track_id}") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "audio/mpeg"
        declared = int(r.headers["Content-Length"])
        body = r.read()
    assert len(body) == declared
    assert body[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3"), "это не mp3"


def test_range_gives_a_partial_response():
    state = _state()
    if not state.get("current"):
        pytest.skip("станция молчит")
    track_id = state["current"]["subsonic_id"]
    with _get(f"/room/download?id={track_id}", {"Range": "bytes=0-1023"}) as r:
        assert r.status == 206
        assert r.headers.get("Content-Range", "").startswith("bytes 0-1023/")
        assert len(r.read()) == 1024
```

Run: `& "C:\Program Files\Python314\python.exe" -m pytest tests/test_room_download_live.py -m integration -v`
Expected: PASS на живой станции. Прогонять **после** Task 8 шаг 1, пока ручки в проде нет — три теста упадут на 404, и это правильно.

- [ ] **Step 5: Прогнать весь быстрый набор и сверить с бюджетом**

Run: `& "C:\Program Files\Python314\python.exe" -m pytest`
Expected: PASS; `integration`-файл не собирается (исключён через `addopts`). Время прогона записать — оно понадобится в Task 6 для правки устаревших чисел в документации.

- [ ] **Step 6: Коммит**

```bash
git add tests/test_room_download.py tests/test_room_download_live.py
git commit -m "Слоты и порядок отказов без часов; живая сверка направления истории"
```

---

### Task 6: образ, стек и документация комнаты

**Files:**
- Modify: `station/room/Dockerfile:9`
- Modify: `station/deploy/docker-compose.override.yml` (блок `room`, между `NAVIDROME_PASS` и `volumes:`)
- Modify: `station/room/README.md`
- Modify: `CLAUDE.md` (секция «Тесты» — устаревшие числа)

**Interfaces:**
- Consumes: имена модулей `naming.py`, `station.py` (Tasks 1–2), переменные `CONTROLLER_URL` и `DOWNLOAD_SLOTS` (Task 4).
- Produces: рабочий образ.

- [ ] **Step 1: Дописать модули в `COPY`**

`station/room/Dockerfile`, строка 9 — сейчас:

```dockerfile
COPY station/room/guard.py station/room/store.py station/room/subsonic.py station/room/server.py ./
```

Заменить на:

```dockerfile
COPY station/room/guard.py station/room/store.py station/room/subsonic.py \
     station/room/naming.py station/room/station.py station/room/server.py ./
```

Это не формальность: `COPY` перечисляет файлы поимённо, в tar новые модули попадут, а в образ — нет, и отказ вылезет не на сборке, а рестарт-петлёй контейнера с `ModuleNotFoundError`.

- [ ] **Step 2: Проверить, что образ собирается и стартует**

```bash
cd /c/AI/projects/music && docker build -f station/room/Dockerfile -t subwave-room:test .
docker run --rm -e CONTROLLER_URL=http://controller:7701 subwave-room:test \
  python -c "import naming, station, server; print('модули на месте')"
```

Expected: `модули на месте`. Если `ModuleNotFoundError` — шаг 1 сделан неполно.

- [ ] **Step 3: Добавить переменную в compose**

`station/deploy/docker-compose.override.yml`, в блок `room`, сразу после строки `NAVIDROME_PASS: ${NAVIDROME_PASS}`:

```yaml
      # Адрес контроллера внутри сети стека. Литералом, а не ${...}: у room нет
      # `env_file`, поэтому запись только в .env до контейнера не доедет вовсе,
      # а `${CONTROLLER_URL}` без дефолта при незаданной переменной даёт пустую
      # строку и одно предупреждение compose. Путь без /api — его снимает Caddy.
      CONTROLLER_URL: http://controller:7701
```

- [ ] **Step 4: Обновить `station/room/README.md`**

Четыре правки:

1. В таблицу поверхности (раздел «Поверхность») добавить строку:

```
| `GET /download?id=` | файл прозвучавшего трека; окно — текущий и вся история |
```

2. Добавить раздел после «Сверка с коллекцией»:

```markdown
## Скачивание

`GET /download?id=<subsonic_id>` отдаёт файл коллекции байт в байт. Окно —
текущий трек станции и **вся** её история (50 записей): комната спрашивает
контроллер на каждый запрос (`http://controller:7701/state`, без префикса
`/api` — его снимает Caddy) и ответ не кэширует.

**Окно — порог, а не замок.** Оно закрывает перебор: идентификаторы наружу не
перечисляются, и скриптом выкачать 4631 файл нельзя. Но заказ открыт всем, и
любой трек выводится в эфир заказом, а через несколько минут оказывается в
истории и качается оттуда. Это сознательная граница, и опираться на неё как на
запрет доступа к коллекции нельзя.

Отказ приезжает **файлом** с говорящим именем (`трек уже не в эфире.txt`) и
честным кодом: ссылка `<a download>` того же origin скачивает тело любого
ответа, и json-конверт лёг бы в «Загрузки» под именем песни.

Заголовки Navidrome отдаются белым списком — он шлёт `Set-Cookie` со своей
сессией. `Content-Type` ставится явно: `/room/download` попадает под
`encode gzip zstd` в Caddy, и от сжатия спасает только тип.

Одновременных отдач не больше `DOWNLOAD_SLOTS` (4); сверх того — `429`. Лимит
по числу отдач, а не по слушателю: `X-Listener-Id` подделывается тривиально, и
лимит по нему создавал бы видимость границы.
```

3. Исправить ложную однопоточность. В README комнаты (и в комментарии
   `station/room/subsonic.py`, где то же самое) фраза «комната однопоточна» —
   неправда: `server.py` поднимает `ThreadingHTTPServer`. Заменить на
   утверждение о том, что ограничение попыток стоит ради самого Navidrome, а не
   из-за однопоточности. Заодно `MAX_ATTEMPTS` в коде не используется ни разу —
   упомянуть это как факт, а не удалять (чужой мёртвый код правилами проекта не
   чистится).

4. Исправить число тестов: «42 штуки, весь набор укладывается в полторы
   секунды» — на фактическое, замеренное в Task 5 шаг 4.

- [ ] **Step 5: Обновить `CLAUDE.md`**

В секции «Тесты» строка «200 тестов, 20–24 с при бюджете 60, самый долгий тест ~0.4 с» устарела. Подставить числа из замера Task 5 шаг 4 и добавить новые файлы в перечень.

- [ ] **Step 6: Коммит**

```bash
git add station/room/Dockerfile station/deploy/docker-compose.override.yml \
        station/room/README.md station/room/subsonic.py CLAUDE.md
git commit -m "Комната знает про станцию: модули в образ, CONTROLLER_URL в стек, README про окно"
```

---

### Task 7: плеер — кнопка, ссылка, service worker

**Files:**
- Modify: `station/docs/web-changes.md` (пересобирается из клона, не правится руками)
- Modify: `station/docs/web-changes.md`
- В клоне апстрима: create `web/lib/download.ts`; modify `web/components/skins/classic/CenterStage.tsx`, `web/components/skins/classic/drawers/TimelineDrawer.tsx`, `web/public/sw.js`

**Interfaces:**
- Consumes: путь ручки `/room/download?id=` (Task 4).
- Produces: пересобранный патч и число файлов в нём.

- [ ] **Step 1: Взять клон апстрима и наложить текущий патч**

На Debian, где стоит стек (клонировать надо там: CRLF с Windows ломает тесты апстрима):

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host>
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/sw-dl
cd /tmp/sw-dl && tr -d '\r' < /tmp/ru-web.patch > /tmp/w.patch && git apply /tmp/w.patch
grep -c '^diff --git' /tmp/ru-web.patch      # запомнить: сейчас 40
```

- [ ] **Step 2: Создать `web/lib/download.ts`**

```ts
// Адрес ручки скачивания. Комната живёт под /room/* того же origin, поэтому
// относительный путь резолвится сам — ни origin, ни CORS не нужны.
//
// Функция, а не общий клиент комнаты: три существующих fetch('/room/…') на неё
// не переводятся. Лишние строки в патче — это конфликты при обновлении
// апстрима, а правило проекта — хирургические правки.
export function downloadUrl(subsonicId: string): string {
  return `/room/download?id=${encodeURIComponent(subsonicId)}`;
}
```

- [ ] **Step 3: Кнопка на карточке текущего трека**

`web/components/skins/classic/CenterStage.tsx`. В импорт lucide (строка 5) добавить `ArrowDownToLine`:

```tsx
import { ArrowDownToLine, Coins, Heart } from 'lucide-react';
```

Добавить импорт рядом с остальными:

```tsx
import { downloadUrl } from '@/lib/download';
```

Рядом с `LikeHeart` (строки 50–71) добавить компонент, следующий тому же канону — «кнопки нет вовсе, а не приглушённая»:

```tsx
// Скачать то, что сейчас звучит. Ссылка, а не кнопка с состоянием:
// CenterStage обёрнут в memo, и хук с сетевым состоянием ломал бы этот расчёт.
// Атрибут download голый, без значения: имя задаёт заголовок сервера, а
// значение создало бы второй источник истины, который всё равно проиграет.
// Иконка ArrowDownToLine, а не Download: последний занят кнопкой установки
// приложения в шапке, и одна иконка на два смысла читается как одно действие.
function DownloadTrack({ subsonicId }: { subsonicId: string | null }) {
  if (!subsonicId) return null;
  const label = 'Скачать эту песню';
  return (
    <a
      href={downloadUrl(subsonicId)}
      download
      aria-label={label}
      title={label}
      className="v3-focus ml-[10px] inline-flex cursor-pointer items-center border-0 bg-transparent p-0 align-middle text-muted transition-colors hover:text-ink"
    >
      <ArrowDownToLine size={15} strokeWidth={1.75} aria-hidden="true" />
    </a>
  );
}
```

И поставить её сразу после `<LikeHeart />` в блоке `live` (строки 271–294), внутри того же `<div>`:

```tsx
                    <LikeHeart />
                    <DownloadTrack subsonicId={subsonicId} />
```

`subsonicId` уже объявлен строкой 106 (`const subsonicId = nowPlaying?.subsonic_id ?? null;`) и используется для обложки. Блок `live` уже гейтит всё «про сейчас» — на off-air карточке кнопки не будет.

- [ ] **Step 4: Кнопка в строке истории**

`web/components/skins/classic/drawers/TimelineDrawer.tsx`. Добавить импорты:

```tsx
import { ArrowDownToLine } from 'lucide-react';
import { downloadUrl } from '@/lib/download';
```

В блоке `hasHistory` (строки 60–80) заменить правую часть строки. Было:

```tsx
              {t.t && (
                <span className="v3-tab-num shrink-0 text-[10px] tracking-eyebrow text-muted uppercase">
                  {relTime(t.t)} ago
                </span>
              )}
```

Стало:

```tsx
              {/* Поля `t` в /state нет ни у одной записи — этот блок не
                  рендерится никогда, и правый край строки свободен. */}
              {t.t && (
                <span className="v3-tab-num shrink-0 text-[10px] tracking-eyebrow text-muted uppercase">
                  {relTime(t.t)} назад
                </span>
              )}
              {t.subsonic_id && (
                <a
                  href={downloadUrl(t.subsonic_id)}
                  download
                  aria-label={`Скачать: ${t.artist} — ${t.title}`}
                  title="Скачать"
                  className="v3-focus inline-flex shrink-0 cursor-pointer items-center border-0 bg-transparent p-0 text-muted transition-colors hover:text-ink"
                >
                  <ArrowDownToLine size={14} strokeWidth={1.75} aria-hidden="true" />
                </a>
              )}
```

Пропсы менять не нужно: `subsonic_id` уже объявлен в `QueueEntry` (`web/lib/types.ts:148`) и доезжает до ящика полным объектом.

- [ ] **Step 5: Убрать `/room/` из-под service worker**

`web/public/sw.js`, рядом с существующими исключениями:

```js
  if (url.pathname === '/stream.mp3' || url.pathname === '/stream.opus') return;
  if (url.pathname.startsWith('/api/')) return;
  // Комната — живые данные и файлы по 8-14 МБ. networkFirst положил бы каждый
  // скачанный трек второй копией в Cache Storage, а отдача пошла бы через
  // respondWith — слой, на котором iOS в standalone ведёт себя непредсказуемо.
  if (url.pathname.startsWith('/room/')) return;
```

- [ ] **Step 6: Пересобрать патч и проверить наложением на чистый клон**

```bash
cd /tmp/sw-dl && git add -A && git diff --cached HEAD > /tmp/ru-web.patch.new
grep -c '^diff --git' /tmp/ru-web.patch.new          # должно стать 42
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/check
cd /tmp/check && git apply --check /tmp/ru-web.patch.new && echo "патч ложится"
```

`git add -A` обязателен: `web/lib/download.ts` — новый untracked-файл, а `git diff HEAD` таких не видит и молча соберёт патч без кнопки. Этот инцидент в проекте уже был.

Забрать патч на машину с репозиторием и положить в `station/docs/web-changes.md`.

- [ ] **Step 7: Обновить `station/docs/web-changes.md`**

Поднять счётчик файлов в шапке — **по факту команды**, а не прибавлением единицы:

```bash
grep -c '^diff --git' station/docs/web-changes.md
```

Добавить раздел:

```markdown
## Кнопка скачивания

Кнопка со стрелкой вниз — на карточке текущего трека (рядом с сердцем) и в
каждой строке раздела «Уже прозвучало». Ведёт на `/room/download?id=…`
([`station/room/README.md`](../../room/README.md)), обычной ссылкой с голым
атрибутом `download`: имя файла задаёт заголовок сервера, а значение атрибута
создало бы второй источник истины, который всё равно проигрывает заголовку.

Иконка — `ArrowDownToLine`, а не `Download`: последний уже занят кнопкой
установки приложения в шапке.

Тем же патчем `/room/` выведен из-под service worker. Апстримный `sw.js`
исключает только `/stream.*` и `/api/*`, а всё прочее кладёт в Cache Storage —
то есть каждый скачанный трек оседал бы второй копией на телефоне.

Отказы ручки приезжают текстовым файлом с говорящим именем: ссылка того же
origin скачивает тело любого ответа, и показать тост можно было бы только
предварительной пробой — вторым запросом и состоянием в компоненте под `memo`.
```

- [ ] **Step 8: Коммит**

```bash
git add station/docs/web-changes.md station/docs/web-changes.md
git commit -m "Плеер: кнопка скачивания на карточке и в ленте, /room/ мимо service worker"
```

---

### Task 8: развёртывание и ручная приёмка

**Files:** изменений в репозитории нет; результаты приёмки дописываются в `station/room/README.md`.

**Interfaces:**
- Consumes: всё предыдущее.
- Produces: работающая станция и записанный результат проверки на iOS.

- [ ] **Step 1: Собрать и поднять комнату**

```bash
cd /c/AI/projects/music
tar -czf /tmp/room-src.tar.gz deploy/room music/normalize.py
scp -P <ssh-port> -i <ssh-key> /tmp/room-src.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf /tmp/room-build && mkdir -p /tmp/room-build
  tar -xzf /tmp/room-src.tar.gz -C /tmp/room-build
  cd /tmp/room-build && sudo docker build -f station/room/Dockerfile -t subwave-room:1 .
  cd <deploy-dir>/subwave && sudo docker compose up -d room
  sudo docker logs --tail 5 sub-wave-room'
```

Expected: в логе `room: :8080 → http://<station-host>:4533, станция http://controller:7701`. Если `станция НЕ ЗАДАНА` — переменная не доехала, вернуться к Task 6 шаг 3.

- [ ] **Step 2: Проверить ручку изнутри LAN**

```bash
ID=$(curl -s http://<station-host>:7700/api/state | python3 -c "import json,sys; print(json.load(sys.stdin)['current']['subsonic_id'])")
curl -s -D - -o /tmp/track.mp3 "http://<station-host>:7700/room/download?id=$ID" | head -12
ls -l /tmp/track.mp3
curl -s -o /dev/null -w '%{http_code}\n' "http://<station-host>:7700/room/download?id=nosuch"
```

Expected: `200`, `Content-Type: audio/mpeg`, `Content-Disposition` с обеими формами, размер файла в мегабайтах; на чужой id — `403`.

- [ ] **Step 3: Проверить, что ответ не сжимается**

```bash
curl -s -H 'Accept-Encoding: gzip' -D - -o /dev/null "http://<station-host>:7700/room/download?id=$ID" | grep -iE 'content-(encoding|length|type)'
curl -s -H 'Accept-Encoding: gzip' -D - -o /dev/null --resolve <station-domain>:<https-port>:127.0.0.1 "https://<station-domain>:<https-port>/room/download?id=$ID" | grep -iE 'content-(encoding|length|type)'
```

Expected: `Content-Encoding` отсутствует в обоих случаях, `Content-Length` совпадает. Если появился `gzip` — `Content-Type` не выставлен, вернуться к Task 4.

- [ ] **Step 4: Сверить файл с коллекцией по хэшу**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> \
  'sha256sum /tmp/track.mp3; find <music-mount> -name "*.mp3" -size $(stat -c%s /tmp/track.mp3)c -exec sha256sum {} +' | sort | uniq -c
```

Expected: два одинаковых хэша — критерий готовности №1.

- [ ] **Step 5: Собрать и поднять web**

```bash
# из клона /tmp/sw-dl, где патч уже наложен
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd /tmp/sw-dl && sudo docker build -f web/Dockerfile -t subwave-web:1.8.0-ru \
    --build-arg SUBWAVE_BUILD_VERSION=1.8.0-ru .
  cd <deploy-dir>/subwave && sudo docker compose up -d web'
```

Если сборка упала на `Turbopack is not supported … swc-linux-x64-musl` — это битый слой `deps` в кэше docker, лечится `--no-cache`.

- [ ] **Step 6: Ручная приёмка в браузере**

Открыть `https://<station-domain>` и проверить по списку:

1. На карточке текущего трека есть стрелка вниз рядом с сердцем; нажатие кладёт файл с именем «Артист — Название.mp3».
2. В ящике «лента» (клавиша `2`) стрелка есть у каждой строки раздела «Уже прозвучало».
3. Chrome и Safari дают одинаково правильное имя, включая кириллицу.
4. DevTools → Application → Cache Storage: скачанного трека там нет.
5. Нажать на строку, которой уже нет в окне (подождать, пока история сменится) — в «Загрузках» появляется `трек уже не в эфире.txt`, а не битый mp3.

- [ ] **Step 7: Проверить с iPhone и записать результат**

Открыть установленное приложение на домашнем экране, нажать кнопку скачивания. Записать в `station/docs/web-changes.md` то, что получилось, **каким бы оно ни было** — надёжного источника про этот случай нет, и наш замер станет единственным. Если не сработает: известные отказы в standalone относятся к `blob:`-пути, значит вариант с `fetch` в Blob не поможет, и честный ответ — «на iOS качать из Safari, не из приложения».

- [ ] **Step 8: Коммит результата приёмки**

```bash
git add station/docs/web-changes.md
git commit -m "Приёмка скачивания: что получилось на iOS"
```

---

## Отклонения от спеки, сделанные осознанно

1. **Тестов три файла, а не один.** Спека §6 называет только `tests/test_room_download.py`. План добавляет `tests/test_room_naming.py`, `tests/test_room_station.py` и `tests/test_room_subsonic_download.py` — это конвенция самой комнаты (`test_room_guard.py`, `test_room_store.py`, `test_room_resolve.py`, `test_room_server.py`: файл на модуль), и она же позволяет закрывать задачи по одной.
2. **Отсутствующий `id` отвечает json-ошибкой, а не файлом.** §4.3 говорит про отказ файлом, но эта ветка недостижима из интерфейса — только самодельным адресом. Прецедент `/resolve` без `q` отвечает `400 {"error": …}`, и разнобой тут был бы хуже единообразия.
3. **`DOWNLOAD_SLOTS` читается из окружения**, хотя §4.1 называет его константой: чтение через `os.environ.get("DOWNLOAD_SLOTS", "4")` стоит одну строку и позволяет поменять число без пересборки образа. В compose переменная не объявляется — дефолта достаточно.
4. **Побайтовая сверка с шарой осталась ручным шагом.** §7 относит sha256 к уровню `integration`, но путь файла в окно станции не приходит, а тянуть его из `data/catalog.db` значит связать тест комнаты со второй базой. Поэтому `integration` проверяет целостность длиной (`Content-Length` против отданного, плюс сигнатура mp3), а побайтовое равенство ловит Task 8 шаг 4 — на Debian, где и шара, и файл под рукой. Критерий готовности №1 закрывается им.

---

## Хвосты на момент слияния (2026-09-23)

Фича в `main` (слияние `1fd4fb6`) и в эфире: образы `subwave-room:1` (`sha256:22cbfac2…`) и
`subwave-web:1.8.0-ru` (`sha256:3444fc9a…`). Скачанный трек сверен с файлом коллекции по
sha256, живая сверка `tests/test_room_download_live.py` — 4 из 4.

Исполнение отошло от плана в двух местах, и оба решения — из-за чужой незакоммиченной
работы в основном каталоге: поток из Navidrome живёт в новом `station/room/navidrome.py`, а
не в `subsonic.py`; правки документации из Task 6 (шаги 4–5) не внесены. Ветка, которая
трогает файл, грязный в рабочем каталоге `main`, не сливается вовсе.

### 1. Отложенная документация — внести, когда владелец закоммитит эти файлы

**`station/room/README.md`**, таблица «Поверхность» — строка:

```
| `GET /download?id=` | файл прозвучавшего трека; окно — текущий и вся история |
```

Новый раздел после «Сверка с коллекцией»:

```markdown
## Скачивание

`GET /download?id=<subsonic_id>` отдаёт файл коллекции байт в байт. Окно —
текущий трек станции и **вся** её история (50 записей): комната спрашивает
контроллер на каждый запрос (`http://controller:7701/state`, без префикса
`/api` — его снимает Caddy) и ответ не кэширует. Сам файл берётся из Navidrome
модулем `navidrome.py` — отдельным от сверки (`subsonic.py`), потому что у
отдачи своя форма ответа (непрочитанный поток), свой таймаут и свой разбор
ошибок: Navidrome отвечает на несуществующий трек кодом 200 и конвертом
`subsonic-response`, а не исключением.

**Окно — порог, а не замок.** Оно закрывает перебор: файл отдаётся только для
трека, который сейчас в окне, и скриптом выкачать 4631 файл нельзя. Секретом
сами идентификаторы не являются — `/resolve` отдаёт id любого трека; барьер —
сверка с окном. Заказ открыт всем, и любой трек выводится в эфир заказом, а
через несколько минут оказывается в истории и качается оттуда. Это сознательная
граница, и опираться на неё как на запрет доступа к коллекции нельзя.

Отказ отвечает **честным кодом** (403/404/429/502) и телом-файлом с говорящим
именем (`трек уже не в эфире.txt`). Что увидит слушатель, зависит от браузера:
Chromium (Chrome, Edge, Chrome на Android) скачивание с кодом ошибки прерывает и
тело не пишет — в «Загрузках» будет «Сбой», без причины, но и без мусорного
файла под именем песни; файл с причиной сохраняют браузеры, которые пишут тело
ошибки. Отсутствующий `id` — это JSON 400, как у `/resolve` без `q`: из
интерфейса туда не попасть. Причину сбоя Navidrome слушатель не видит — она
уходит в stderr контейнера: в тексте исключения `urllib` бывает весь адрес
запроса вместе с токеном и солью.

Заголовки Navidrome отдаются белым списком — он шлёт `Set-Cookie` со своей
сессией. `Content-Type` ставится явно: `/room/download` попадает под
`encode gzip zstd` в Caddy, и от сжатия спасает только тип. Ответ без
`Content-Length` закрывает соединение (`Connection: close`) — иначе клиент ждал
бы конца тела до таймаута сокета.

Одновременных отдач не больше `DOWNLOAD_SLOTS` (4); сверх того — `429`. Лимит
по числу отдач, а не по слушателю: `X-Listener-Id` подделывается тривиально, и
лимит по нему создавал бы видимость границы. Слот освобождается в `finally` —
и после оборванного посреди тела ответа Navidrome тоже.

**Принятый риск:** клиентов лимит не различает, поэтому один клиент может
держать все слоты сколько угодно — медленным чтением (таймаут сокета в 300 с
ограничивает одну запись, а не весь перелив) или циклом загрузок. Общий дедлайн
не помогает (клиент переподключается) и ломает честные медленные загрузки.
Страдает только `/download`; эфир, чат и заказы — нет.

`Range` пробрасывается в Navidrome вместе с `If-Range`: иначе докачка файла,
изменившегося между двумя запросами, склеила бы начало старого и конец нового.

Состав образа закреплён тестом `tests/test_room_dockerfile.py`: `COPY` в
Dockerfile перечисляет модули поимённо, и модуль, импортируемый сервером, но
забытый в `COPY`, иначе проявился бы только рестарт-петлёй контейнера.
```

**«Комната однопоточна»** — неправда везде, где встречается: в этом README, в комментарии
`station/room/subsonic.py` и в записи «Грабли» `CLAUDE.md` про число заходов сверки.
`server.py` поднимает `ThreadingHTTPServer` — поток на соединение. Настоящая причина
потолка заходов: он ограничивает время одного `/resolve` (каждый заход — поход в Navidrome,
а ящик заказа спрашивает сверку на каждой паузе в наборе), а не параллельность. Перед
правкой проверить, используется ли `MAX_ATTEMPTS` в `subsonic.py` сейчас (при разведке —
объявлен, но не использовался), и написать только то, что верно на тот момент.

**Устаревшие числа тестов:** «42 штуки, весь набор укладывается в полторы секунды» в
README комнаты и «200 тестов, 20–24 с…» в разделе «Тесты» `CLAUDE.md` — заменить свежим
замером (после слияния: 335 тестов быстрого набора, 40 с; файлы комнаты — 66 тестов) и
дописать `tests/test_room_download_live.py` (`-m integration`, нужна живая станция).

**`FINDINGS.md`** — побочная находка, в начало файла:

```
## 2026-09-22 · /resolve при пустом NAVIDROME_URL отдаёт слушателю токен Subsonic [P2]
**Context:** ревью задачи 4 скачивания (station/room/server.py, ветка /resolve); тот же класс дефекта исправлен в /download.
**What:** при пустом NAVIDROME_URL `subsonic.resolve` строит адрес `/rest/search3?…&t=…&s=…`, `urllib` падает с ValueError, в тексте которого весь адрес, и `server.py` отвечает `{"error": f"сверка не удалась: {e}"}` любому слушателю. Пара токен+соль для Subsonic API годится для повторного входа. Срабатывает только при ошибке конфигурации.
**Proposal:** как в /download: проверять пустой base до похода в Navidrome, слушателю — фиксированная фраза, текст исключения — в stderr.
**Status:** open
```

### 2. Известные мелочи — слияние не блокировали

| Что | Где | Почему не сейчас |
|---|---|---|
| `If-Range` уходит в Navidrome и без `Range` | `navidrome.py`, `server.py` | безвредно: без `Range` его игнорируют и RFC 9110, и `http.ServeContent`; починка — `if if_range and rng` плюс тест |
| `aria-label` строки ленты «Скачать: undefined — …» у треков без исполнителя | `ru-web.patch`, `TimelineDrawer.tsx` | правка патча требует пересборки на Debian |
| имя кэша service worker не сменено — записи `/room/*`, положенные старым `sw.js`, не вычищаются | `ru-web.patch`, `web/public/sw.js` | там лишь мелкий JSON ленты, отдаваться он больше не будет |
| ESLint для правок плеера не прогонялся | — | в Next 16 `next build` проверяет типы, а линт — нет |
| рецепт авторизации Subsonic продублирован в `navidrome.py` и `subsonic.py` | `navidrome.py:_auth_params` | свести в один, когда `subsonic.py` будет закоммичен |
| таймаут сокета 300 с после отдачи не возвращается к 30 с | `server.py:_pump` | простаивающее соединение раньше закрывает Caddy |
| запрос нескольких диапазонов и ответ 416 превращаются в 502 | `server.py` | браузеры так не качают; 416 — только докачка уже полного файла |
| литеральный `%` в ASCII-имени может прочитаться браузером как экранирование | `naming.py:disposition` | в коллекции таких названий 0 |
| контракт Dockerfile не видит импортов внутри `try`/`if` и не пиннит транзитивность на встроенном образце | `tests/test_room_dockerfile.py` | сейчас таких импортов нет |

### 3. Ручная приёмка

На `https://<station-domain>`:

1. На карточке текущего трека рядом с сердцем есть стрелка вниз; нажатие кладёт файл «Артист — Название.mp3».
2. В ящике «лента» (клавиша `2`) стрелка есть у каждой строки «Уже прозвучало».
3. Имя файла с кириллицей правильное в Chrome и в Safari.
4. DevTools → Application → Cache Storage: после скачивания записей `/room/` нет.
5. Отказ: в Chrome, Edge и Chrome на Android — «Сбой» в «Загрузках» без причины, так задумано (§4.3 спеки). Сохраняют ли Firefox и Safari тело ошибки файлом `трек уже не в эфире.txt` — не проверено, записать увиденное.
6. iPhone, установленное приложение: результат неизвестен и записывается в `station/docs/web-changes.md`, каким бы он ни был. Известные отказы standalone-режима относятся к `blob:`-ссылкам; кнопка — обычная ссылка того же origin, то есть выбор сделан в безопасную сторону, но подтвердить это может только телефон.
