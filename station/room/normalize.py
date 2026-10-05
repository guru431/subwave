import re
import unicodedata

_PARENS_SUFFIX = re.compile(r"\s*[\(\[][^()\[\]]*[\)\]]\s*$")
_NON_WORD = re.compile(r"[^\w\s]", re.UNICODE)
_SPACES = re.compile(r"\s+")


def _strip_latin_diacritics(s: str) -> str:
    """Снимает диакритику с латиницы, кириллицу и прочие письменности не трогает.

    Отбрасывать все combining-символы подряд нельзя: после NFKD `й` — это `и` с
    U+0306, а `ї` — `і` с U+0308, и общее правило склеивает «май» с «маи», а
    украинское `ї` с `і`, создавая ложные точные совпадения. Признак латиницы —
    базовый символ в ASCII: разложение любой латинской буквы с диакритикой даёт
    именно его (é → e, Å → A), а `ø`, `đ`, `ł` не раскладываются вовсе.
    """
    out: list[str] = []
    base_is_latin = False
    for ch in unicodedata.normalize("NFKD", s):
        if unicodedata.combining(ch):
            if not base_is_latin:
                out.append(ch)
            continue
        base_is_latin = ch.isascii() and ch.isalpha()
        out.append(ch)
    return unicodedata.normalize("NFC", "".join(out))


def norm(s: str | None) -> str:
    """Приводит строку к виду, пригодному для сравнения артистов и названий."""
    if not s:
        return ""
    # NFC до замены: в разложенном виде `ё` — это `е` + U+0308, и замена по
    # символу прошла бы мимо
    s = unicodedata.normalize("NFC", s)
    s = s.replace("ё", "е").replace("Ё", "Е").lower()
    s = _strip_latin_diacritics(s)
    s = _NON_WORD.sub(" ", s)
    return _SPACES.sub(" ", s).strip()


def strip_parens(s: str) -> str:
    """Убирает завершающий скобочный суффикс: (Live), (feat. X), (Bonus Tracks)."""
    return _PARENS_SUFFIX.sub("", s).strip() or s
