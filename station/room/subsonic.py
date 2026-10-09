"""Сверка того, что слушатель набрал, с коллекцией — через Subsonic API Navidrome.

Контроллер в этом пути не участвует: у него весь поиск по библиотеке закрыт
`requireAdmin`, а плееру нужен публичный ответ «есть ли такой трек». Поэтому
комната ходит в Navidrome сама — учёткой контроллера (`NAVIDROME_USER`; почему
не своей — README комнаты, «Сверка с коллекцией»).

Нормализация — `norm()` из `normalize.py` рядом: своя копия комнаты, снятая с
каталога коллекции, которым станция пользовалась до выделения в форк. Заодно
наследуется нужное поведение: скобочный
суффикс `norm()` не снимает, поэтому `Song (Live)` и `Song` остаются разными
записями — как того и требует правило проекта.

Список альтернатив не переупорядочивается и не фильтруется: что нашёл поиск
Navidrome, то и показывается. Релевантность — его работа, а не наша.
"""
import hashlib
import json
import re
import secrets
import sys
import urllib.parse
import urllib.request
from pathlib import Path

try:                                   # в образе модуль лежит рядом
    from normalize import norm
except ImportError:                    # в тестах модуль грузится по пути, каталог не в sys.path
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from normalize import norm

ALTERNATIVES_MAX = 5
SEARCH_COUNT = 20
TIMEOUT = 15
FIELDS = ("id", "title", "artist", "album", "year", "duration")

# Слушатель пишет не «Артист — Название», а «Включи Агата Кристи - На войне».
# Navidrome ищет по всем словам запроса сразу, поэтому одно служебное слово
# обнуляет выдачу целиком — и сверка честно отвечает «в коллекции такого нет»
# про песню, которая в коллекции есть. Срезается только начало строки: те же
# слова дальше по тексту — уже часть названия.
_COMMANDS = frozenset("""
    включи включите включай включайте поставь поставьте ставь ставьте
    врубай врубайте сыграй сыграйте заряди запусти дай давай хочу хочется
    play put on queue
""".split())
# Служебные слова между командой и названием: «включи ПЕСНЮ …», «поставь ГРУППУ …»
_FILLERS = frozenset("""
    песню песня песни трек трека треком композицию композиция
    группу группа группы исполнителя альбом что нибудь
    пожалуйста плиз song track band please
""".split())
_BRACKET_SUFFIX = re.compile(r"\s*[\(\[][^()\[\]]*[\)\]]\s*$")


def strip_command(query: str) -> str:
    """Снять командное начало: «Включи группу Ленинград» → «Ленинград».

    Режется по исходным токенам, а не по нормализованным: в остатке должен
    уцелеть разделитель, который набрал слушатель («Агата Кристи - На войне»).
    Запрос, который весь состоит из служебных слов, возвращается нетронутым —
    пустой запрос в Navidrome бессмыслен, а «Поставь» честнее не найти.
    """
    tokens = (query or "").split()
    cut = 0
    while cut < len(tokens):
        word = norm(tokens[cut])
        if word and (word in _COMMANDS or word in _FILLERS):
            cut += 1
            continue
        break
    if cut == 0 or cut == len(tokens):
        return query
    return " ".join(tokens[cut:])


def tail_after_command(query: str) -> str | None:
    """Хвост после последней команды внутри строки, если он там есть.

    «Передай привет Диме Ефимову, поставь песню Прыгну со скалы» — заказ с
    приветом впереди: команда стоит в середине, и срезанием начала её не
    достать. Берётся **последнее** вхождение: у «включи, а лучше поставь X»
    искомое идёт за последней из них.

    Возвращает `None`, когда команды в середине нет — тогда и второй попытки
    быть не должно.
    """
    tokens = (query or "").split()
    last = -1
    for i, tok in enumerate(tokens):
        if norm(tok) in _COMMANDS:
            last = i
    if last < 1:                       # команды нет, либо она в самом начале
        return None
    rest = tokens[last + 1:]
    while rest and norm(rest[0]) in _FILLERS:
        rest = rest[1:]
    return " ".join(rest) or None


MIN_WORD = 3
# Сколько запросов к Navidrome стоит одна сверка в худшем случае. Ящик заказа
# спрашивает её на каждой паузе в наборе, а комната однопоточна: перебор всех
# префиксов длинной фразы (до восьми походов) складывался в секунды и ронял
# сверку в 502 при череде заказов подряд.
MAX_ATTEMPTS = 6
# Длина слова, начиная с которой отсечение окончания осмысленно: «Кино» после
# него превратилось бы в «Ки».
MIN_STEM = 4
# Префиксы, которыми обрывается приписка вроде «… и передай привет Диме».
# Не «все длины подряд»: название редко длиннее трёх слов, а лишние заходы
# стоят дороже, чем найденная ими разница.
PREFIX_WORDS = (3, 2, 1)
# Слова, которые сами по себе запросом не бывают: артикли, предлоги, союзы.
# Порогом длины их не отсечь — «the» и «для» ровно на границе, а «Кар-Мэн» и
# «Ума» из трёх букв отсекать нельзя.
_STOPWORDS = frozenset("""
    the a an of and or for in on at to my me
    и в на из от под про для или что это как бы же
""".split())


def _has_meaning(text: str) -> bool:
    """Есть ли в строке слово, по которому вообще стоит искать.

    «The» найдёт половину коллекции и выдаст мусор за подсказку, поэтому
    сокращать запрос до одних служебных слов бессмысленно.
    """
    for word in norm(text).split():
        if len(word) < MIN_WORD:
            continue
        if word in _COMMANDS or word in _FILLERS or word in _STOPWORDS:
            continue
        return True
    return False


def _stemmed(text: str) -> str:
    """Снять по одной букве с длинных кириллических слов.

    «Поставь чичерину», «включи агату кристи» — винительный падеж, и такого
    слова в коллекции нет вовсе. Navidrome ищет **по началу слова**, поэтому
    «чичерин» находит «Чичерину», а «агат крист» — «Агату Кристи». Словарь и
    морфология для этого не нужны: достаточно не искать по окончанию.

    Латиница не трогается — падежей у неё нет, а усечение даёт мусор.
    """
    out = []
    for word in text.split():
        core = word.rstrip(".,!?;:»«\"'")
        if len(core) >= MIN_STEM and any("а" <= ch.lower() <= "я" or ch in "ёЁ"
                                         for ch in core):
            out.append(core[:-1])
        else:
            out.append(core or word)
    return " ".join(out)


def search_attempts(query: str):
    """Пары «запрос, вправе ли он дать точный ответ» — от точного к отчаянному.

    Заказ приходит не голым названием: «поставь rammstein и передай привет
    Дмитрию Ефимову» — половина строки к музыке отношения не имеет, а
    Navidrome ищет по всем словам сразу и отвечает нулём. Поэтому после
    точного запроса пробуются хвост после команды в середине и затем строка,
    укорачиваемая с конца по слову: приписка отваливается, название остаётся.

    Второе значение пары важнее первого. Снятие команды и взятие хвоста
    **ничего из заказанного не теряют** — по ним точный ответ законен. А
    укорачивание с конца выбрасывает часть заказа: «Сектор Газа Гуляй мужик»
    сокращается до «Сектор Газа», единственный трек группы — «Демобилизация»,
    и назвать её точным совпадением значит отправить в эфир чужую песню с
    видом уверенности. Обрезанный запрос даёт подсказку, а не ответ.
    """
    seen: set[str] = set()

    def offer(text: str | None):
        if text and text not in seen and _has_meaning(text):
            seen.add(text)
            return text
        return None

    head = strip_command(query)
    first = offer(head)
    if first:
        yield first, True
    tail = offer(tail_after_command(query))
    if tail:
        yield tail, True
    stem = offer(_stemmed(head))
    if stem:
        # Усечённое слово — уже не то, что набрал слушатель: подсказка, не ответ
        yield stem, False
    words = head.split()
    for end in PREFIX_WORDS:
        if end >= len(words):
            continue
        shorter = offer(" ".join(words[:end]))
        if shorter:
            yield shorter, False


def candidates(payload: dict) -> list[dict]:
    """Разобрать конверт Subsonic в плоский список кандидатов."""
    body = (payload or {}).get("subsonic-response") or {}
    songs = (body.get("searchResult3") or {}).get("song") or []
    return [{k: s.get(k) for k in FIELDS} for s in songs]


def _key(song: dict) -> str:
    return norm(f"{song.get('artist') or ''} {song.get('title') or ''}")


def _key_without_suffix(song: dict) -> str:
    """Тот же ключ, но со снятым скобочным суффиксом названия."""
    title = _BRACKET_SUFFIX.sub("", song.get("title") or "")
    return norm(f"{song.get('artist') or ''} {title}")


def match(query: str, songs: list[dict]) -> dict:
    """`{"exact": …|None, "alternatives": [...]}` — всегда одной формы.

    `exact` заполняется, только когда нормализованный запрос совпал с
    «артист — название» целиком. Разделитель слушатель наберёт как угодно —
    тире, дефис, минус; `norm()` превращает любой из них в пробел, поэтому
    сравнение идёт по нормализованной строке целиком, а не по половинам.

    Совпадение по одному названию точным не считается: «Звезда» — это и
    отдельный трек, и часть другого названия, и угадывать за слушателя тут
    нечего, на то и показываются альтернативы.

    Название слушатель помнит неточно — «Агата Кристи — На войне» про трек
    «Как на войне». Поэтому единственный кандидат, в котором нашлись **все**
    слова запроса, тоже считается точным: выбирать не из чего, а показывать
    «точного совпадения нет» там, где совпадение ровно одно, — это тот же
    отказ найти имеющееся. Несколько кандидатов остаются выбором слушателя.

    Единственность не отменяет правила про версии: если кандидат отличается от
    запроса только скобочным суффиксом, это `Song (Live)` против `Song` —
    разные записи, и подставлять одну вместо другой нельзя.
    """
    wanted = norm(query)
    exact = next((s for s in songs if _key(s) == wanted), None)
    if exact:
        return {"exact": exact, "alternatives": []}
    if len(songs) == 1 and wanted:
        lone = songs[0]
        words = set(_key(lone).split())
        covered = all(w in words for w in wanted.split())
        if covered and _key_without_suffix(lone) != wanted:
            return {"exact": lone, "alternatives": []}
    return {"exact": None, "alternatives": songs[:ALTERNATIVES_MAX]}


def resolve(query: str, base: str, user: str, password: str,
            limit: int = SEARCH_COUNT) -> dict:
    """Спросить Navidrome и сверить ответ. Сетевые сбои наружу не прячутся.

    В Navidrome уходит запрос без командного начала, и сверяется ответ с ним
    же: искать «Включи Агата Кристи» бессмысленно, а сверять найденное с
    командой — тем более.

    Пустая выдача — повод попробовать следующий заход `search_attempts()`:
    хвост после команды в середине строки, потом строку, укороченную с конца.
    Следующий запрос уходит только при промахе предыдущего — когда трек
    нашёлся, догадываться не о чем.
    """
    if not base:
        # Без адреса urllib уронил бы ValueError «unknown url type» с полным
        # URL запроса в тексте — токеном и солью Subsonic внутри.
        raise ValueError("Navidrome не настроен")

    def ask(text: str) -> list[dict]:
        salt = secrets.token_hex(8)
        token = hashlib.md5((password + salt).encode("utf-8")).hexdigest()
        params = urllib.parse.urlencode({
            "query": text, "songCount": limit, "artistCount": 0, "albumCount": 0,
            "u": user, "t": token, "s": salt, "v": "1.16.1", "c": "subwave-room",
            "f": "json"})
        url = f"{base.rstrip('/')}/rest/search3?{params}"
        with urllib.request.urlopen(url, timeout=TIMEOUT) as r:
            return candidates(json.loads(r.read().decode("utf-8", "replace")))

    asked, songs, exactable = strip_command(query), [], True
    for attempt, may_be_exact in search_attempts(query):
        asked, songs, exactable = attempt, ask(attempt), may_be_exact
        if songs:
            break
    found = match(asked, songs)
    if found["exact"] and not exactable:
        # Найдено по обрезанному запросу: это подсказка, а не ответ
        return {"exact": None, "alternatives": [found["exact"]]}
    return found
