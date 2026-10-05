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
# DEL (0x7F) — сверх repair.py намеренно: управляющий символ недопустим в значении
# HTTP-заголовка, и Go-стек Caddy может отвергнуть такой ответ целиком.
_BAD_CHARS = set('<>:"/\\|?*') | {chr(c) for c in range(32)} | {chr(127)}

DEFAULT_STEM = "track"
# В коллекции самое длинное «артист — название» — 111 символов, так что порог
# не режет ничего. Он стоит ради Safari, который обрезает длинный заголовок.
STEM_MAX = 120

_SPACES = re.compile(r"\s+")
# Расширение выбирает, чем файл откроется у слушателя, поэтому проверяется
# тип, а не набор символов: `hta`, `exe` и `bat` тоже алфавитно-цифровые.
_AUDIO_EXT = {"mp3", "flac", "m4a", "aac", "ogg", "oga", "opus", "wav", "wma",
              "ape", "aiff", "aif", "wv", "mpc"}

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

    Белый список аудиорасширений обязателен. Navidrome кладёт в кавычки
    название из тега без экранирования, и тег вида `Song.hta"; x="` даёт
    заголовок `filename="Song.hta"; x=".mp3"` — разбор честно вернёт `hta`.
    Проверка набора символов такое пропускает, поэтому всё, что не аудио,
    заменяется дефолтом. `cgi.parse_header` для разбора непригоден — модуль
    удалён в Python 3.13, а образ комнаты на нём и стоит.
    """
    msg = Message()
    msg["Content-Disposition"] = value or ""
    ext = posixpath.splitext(msg.get_filename() or "")[1].lstrip(".").lower()
    return ext if ext in _AUDIO_EXT else default
