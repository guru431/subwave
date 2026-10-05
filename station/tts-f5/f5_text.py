"""Текст для F5: знаки ударения, транскрипт эталона, нарезка на куски.

Нарезка повторяет алгоритм chunk_text из f5-tts 1.1.22
(f5_tts/infer/utils_infer.py:73-102) — перенесён сюда, чтобы модуль грузился в
тестах music без torch; совпадение сверяет tests/test_tts_f5_text.py. Отличие
одно: отрезок между знаками препинания длиннее предела дорезается по словам —
штатный chunk_text такой кусок не делит, а F5 на куске длиннее предела комкает
окончание.
"""
import json
import re
from pathlib import Path

VOWELS = "аеёиоуыэюяАЕЁИОУЫЭЮЯ"
MIN_MAX_CHARS = 20
_STRESS = re.compile(f"\\+[{VOWELS}]")
_CJK_PUNCT = "；：，。！？"
_SENTENCE = re.compile(r"(?<=[;:,.!?])\s+|(?<=[；：，。！？])")

# Латинские слова, которые русская модель коверкает, — как их произносят по-русски.
# «AI» ESpeech прочла как «ААЭ» (whisper на образце 2026-09-23), а это имя станции.
# Замена идёт до RUAccent: латиницу он пропускает мимо себя (f5_accent.SKIP_REGEX).
PRONUNCIATION = {
    "AI": "эй ай",
    # ударение ставят поправки f5_accent.STRESS_OVERRIDES («мет+аллика»): без знака F5
    # в начале куска читал «Metallica» с ударением не туда (2026-09-23)
    "Metallica": "Металлика",
}
_PRONUNCIATION = re.compile(r"\b(" + "|".join(map(re.escape, PRONUNCIATION)) + r")\b")

# Словарь коллекции: латинские исполнители и названия песен русскими буквами, с
# ударением (собирает tools/pronunciation.py). «Wasting My Hate» ESpeech читала
# «Востинг Майхэд», «Dire Straits» — «Даррис Тредс» (эфир 23.09). Применяется ПОСЛЕ
# RUAccent (cyrillize): «+» из словаря, попав к ней, выключил бы разметку всей
# реплики (Accentizer.apply), а латиницу она оставляет как есть.
DICTIONARY_FILE = Path(__file__).with_name("pronunciation.json")


def dictionary_key(s: str) -> str:
    """Ключ словаря: регистр, вид апострофа и пробелы не различаются."""
    return re.sub(r"\s+", " ", s.replace("’", "'")).strip().lower()


def _dictionary_pattern(keys) -> re.Pattern | None:
    # Длинные ключи первыми: фраза «Dire Straits» раньше слова «Dire». Граница —
    # буква или цифра латиницы: «(Live)» и «AC/DC» начинаются и кончаются знаком.
    parts = [r"\s+".join(re.escape(w).replace("'", "['’]") for w in k.split())
             for k in sorted(keys, key=len, reverse=True) if k]
    if not parts:
        return None                     # пустая альтернатива совпала бы везде
    return re.compile(r"(?<![A-Za-z0-9])(?:" + "|".join(parts) + r")(?![A-Za-z0-9])",
                      re.IGNORECASE)


def load_dictionary(path: Path) -> dict[str, str]:
    """Слова и фразы одним словарём; фраза важнее своих слов. Нет файла — пусто:
    без него собирается сам словарь (tools/pronunciation.py), а в образ файл
    кладёт Dockerfile — это сверяет tests/test_tts_f5_dockerfile.py."""
    if not path.exists():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    return {**data["words"], **data["phrases"]}


DICTIONARY = load_dictionary(DICTIONARY_FILE)
_DICTIONARY = _dictionary_pattern(DICTIONARY)
_LATIN = re.compile(r"[A-Za-z]")


# Паузы на стыках единиц синтеза, мс. Внутри одного куска F5 сам решает, где дышать, и
# на знак препинания у него почти нет времени: запятые выходили от 40 до 330 мс,
# двоеточие в «девать: в ритм» — 50 (эфир 2026-09-23). Поэтому реплика режется на
# единицы — предложения и части по двоеточию, точке с запятой и тире, — а паузы между
# ними ставятся явно. По запятым не режется: каждая часть звучала бы отдельной фразой
# с падающей интонацией. Длины прослушаны владельцем: «с паузами стало лучше».
PAUSE_SENTENCE_MS = 450
PAUSE_CLAUSE_MS = 250
PAUSE_COMMA_MS = 150      # стык внутри длинной единицы, дорезанной chunk() по запятой
PAUSE_OTHER_MS = 80       # стык без знака (дорезка по словам)
MIN_CLAUSE_WORDS = 3      # короче — клеится к соседу: F5 комкает окончания коротких фраз

_SENTENCE_END = re.compile(r"(?:(?<=[.!?…])|(?<=[.!?…][»\"”)]))\s+")
_CLAUSE_BREAK = re.compile(r"(?<=[:;])\s+|\s+(?=[—–-]\s)")


def _words(s: str) -> list[str]:
    return [w for w in s.split() if any(ch.isalnum() for ch in w)]


def units(text: str) -> list[tuple[str, int]]:
    """Реплика → единицы синтеза с паузой после каждой; у последней пауза 0.

    Части по двоеточию и тире короче MIN_CLAUSE_WORDS клеятся к соседней части
    того же предложения; предложения не клеятся никогда."""
    out = []
    for sentence in _SENTENCE_END.split(text.strip()):
        parts = [p.strip() for p in _CLAUSE_BREAK.split(sentence) if p.strip()]
        for i, part in enumerate(parts):
            pause = PAUSE_SENTENCE_MS if i == len(parts) - 1 else PAUSE_CLAUSE_MS
            if out and out[-1][1] == PAUSE_CLAUSE_MS and min(
                    len(_words(part)), len(_words(out[-1][0]))) < MIN_CLAUSE_WORDS:
                out[-1] = (f"{out[-1][0]} {part}", pause)
            else:
                out.append((part, pause))
    if out:
        out[-1] = (out[-1][0], 0)
    return out


def pieces(text: str, limit: int) -> list[tuple[str, int]]:
    """Единицы, дорезанные по пределу F5 (chunk), с паузой после каждого куска."""
    res = []
    for unit, pause in units(text):
        parts = chunk(unit, limit)
        for i, part in enumerate(parts):
            if i < len(parts) - 1:
                res.append((part, PAUSE_COMMA_MS if part[-1] in ",;:" else PAUSE_OTHER_MS))
            else:
                res.append((part, pause))
    return res


def respell(text: str) -> str:
    """Слова из PRONUNCIATION — русскими буквами; только целые слова, регистр важен."""
    return _PRONUNCIATION.sub(lambda m: PRONUNCIATION[m.group(1)], text)


def cyrillize(text: str) -> str:
    """Латиница из словаря коллекции — русскими буквами с ударением, прочее как есть."""
    if _DICTIONARY is None or not _LATIN.search(text):
        return text
    return _DICTIONARY.sub(lambda m: DICTIONARY[dictionary_key(m.group(0))], text)


def has_stress_marks(text: str) -> bool:
    """Есть ли ударения в нотации RUAccent: '+' прямо перед гласной."""
    return bool(_STRESS.search(text))


def normalize_ref_text(ref_text: str) -> str:
    """Транскрипт эталона кончается на '. ' — как в preprocess_ref_audio_text
    (utils_infer.py:369-374): F5 склеивает его с текстом синтеза в одну строку."""
    ref = ref_text.strip()
    if ref.endswith("。"):
        return ref
    return ref + " " if ref.endswith(".") else ref + ". "


def max_chars(ref_text: str, ref_seconds: float, speed: float = 1.0) -> int:
    """Предел куска в байтах UTF-8 — формула infer_process (utils_infer.py:404).
    F5 генерирует эталон и текст одним окном около 22 с: чем длиннее эталон,
    тем меньше места под новый текст."""
    if not 0 < ref_seconds < 22:
        raise ValueError(f"длина эталона {ref_seconds:.1f} с вне (0, 22)")
    n = int(len(ref_text.encode("utf-8")) / ref_seconds * (22 - ref_seconds) * speed)
    return max(MIN_MAX_CHARS, n)


def _bytes(s: str) -> int:
    return len(s.encode("utf-8"))


def _split_words(piece: str, limit: int) -> list[str]:
    """Отрезок длиннее предела — по словам; слово длиннее предела (URL, мусор) — по буквам."""
    out, cur = [], ""
    for word in piece.split():
        while _bytes(word) > limit:
            head = ""
            for ch in word:
                if head and _bytes(head + ch) > limit:
                    break
                head += ch
            if cur:
                out.append(cur)
                cur = ""
            out.append(head)
            word = word[len(head):]
        if not word:
            continue
        joined = f"{cur} {word}" if cur else word
        if _bytes(joined) <= limit:
            cur = joined
        else:
            out.append(cur)
            cur = word
    if cur:
        out.append(cur)
    return out


def chunk(text: str, limit: int) -> list[str]:
    pieces = []
    for s in _SENTENCE.split(text.strip()):
        if not s:
            continue
        pieces.extend([s] if _bytes(s) <= limit else _split_words(s, limit))
    chunks, cur = [], ""
    for s in pieces:
        # Штатный chunk_text ставит пробел, только если последний символ однобайтный.
        # Его куски, кроме последнего, кончаются знаком препинания, так что правило
        # «пробел везде, кроме китайской пунктуации» даёт на них тот же ответ, — а
        # дорезанные по словам куски кончаются буквой, и без пробела слова слиплись бы.
        tail = s if s[-1] in _CJK_PUNCT else s + " "
        if _bytes(cur) + _bytes(s) <= limit:
            cur += tail
        else:
            if cur:
                chunks.append(cur.strip())
            cur = tail
    if cur:
        chunks.append(cur.strip())
    return chunks
