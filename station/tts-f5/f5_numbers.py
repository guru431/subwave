"""Числа — русскими словами, до RUAccent: числительным тоже нужны ударения.

Цифры ESpeech читает как придётся. Контроллер v1.17 (#1734) при пустом
persona.language переписывает годы английскими словами («В nineteen sixty-nine
году»), а `%` и `°` — «percent» и «degrees»; с выставленным языком он отдаёт их
цифрами и знаками — и прочесть их по-русски остаётся службе.

Склоняет num2words (падеж, род и число у ru — с 0.5.13). Морфологии нет: падеж
берётся из того, что написано рядом с числом.
- Год со словом «год»: падеж — у самого слова («в 1969 году» — предложный,
  «1969 года» — родительный), «к 1991 году» — дательный.
- Порядковое с дефисом — по окончанию: «1960-х», «80-е», «1969-го», «3-й».
- Число с месяцем — порядковое среднего рода: «9 октября» — «девятое», «с 1 по 5
  октября» — «с первого по пятое».
- «№ 1» — «номер один»; «100%-ный» — «стопроцентный» (числа 1–100).
- Год без слова «год» — по предлогу перед ним: «в 1988» — «восьмом».
- Проценты и градусы — с согласованием: «1 процент, 2 процента, 5 процентов».
- Прочее — количественное: род 1 и 2 — по окончанию следующего слова («1 песня»
  — «одна», «2 минуты» — «две»), падеж — по предлогу («около 2000» — «двух тысяч»).

Число рядом с латинским словом не трогается: «Maroon 5», «2 Minutes to Midnight»
— часть имени, её читает словарь коллекции (f5_text.cyrillize).
"""
import re
from decimal import Decimal

from num2words import num2words

_CYR = "А-Яа-яЁё"
_LETTER = f"A-Za-z{_CYR}"
# «300 000» — одно число: разряды через пробел, неразрывный или узкий неразрывный. Длиннее
# 15 цифр — не число, а мусор: его оставляет как есть и предел int() на 4300 цифр не роняет.
# Дробь — только через запятую: точка между цифрами — время, дата или версия (_DOT_CHAIN)
_NUM = r"\d{1,3}(?:[ \N{NO-BREAK SPACE}\N{NARROW NO-BREAK SPACE}]\d{3}){1,4}(?!\d)|\d{1,15}(?:,\d{1,3})?(?!\d)"
# «19.00», «15.10.2026», «1.2.3»: время в однозначном окружении («в 19.00», «7.15 утра»)
# читается как время, прочее уходит в F5 цифрами, как до f5_numbers
_DOT_CHAIN = re.compile(r"(?<![\w.,])\d+(?:\.\d+)+(?!\w)")
_DOT_TIME = re.compile(r"([01]?\d|2[0-3])\.([0-5]\d)")
_TIME_PREPS = {"в", "во", "к", "ко", "до", "с", "со", "после", "около"}
_DAYPART = re.compile(r"\s+(?:утра|дня|вечера|ночи)(?!\w)")
# Спрятанный фрагмент — знак из дополнительной области частного использования: его
# не тронет ни одна регулярка, а после проходов он возвращается как был
_HIDDEN = 0xF0000
_HIDDEN_RE = re.compile("[\U000F0000-\U000FFFFD]")
_SIGN = {"+": "плюс", "-": "минус", "−": "минус"}
# знак — только приклеенный к числу и после пробела или начала: «−3°», не «3-5%»
_SIGNED = r"(?:(?<![^\s(«„\"])([+\-−]))?"

PERCENT = ("процент", "процента", "процентов")
DEGREE = ("градус", "градуса", "градусов")
DOLLAR = ("доллар", "доллара", "долларов")
MILE = ("миля", "мили", "миль")
KILOMETRE = ("километр", "километра", "километров")
# «$5 млн» — сокращение или слово → формы и род числительного перед ним
_MAGNITUDES = {"тыс": (("тысяча", "тысячи", "тысяч"), "f"),
               "млн": (("миллион", "миллиона", "миллионов"), "m"),
               "млрд": (("миллиард", "миллиарда", "миллиардов"), "m")}
_SPEEDS = {"mph": (MILE, "f"), "km/h": (KILOMETRE, "m"), "км/ч": (KILOMETRE, "m")}
# «N%-ный» — первая часть сложного прилагательного: родительный падеж числа
# («пятипроцентный», «двадцатипятипроцентный»), кроме «одно», «сорока»,
# «девяносто» и «сто». Таблица — только на 1–100: дальше вариантов больше одного.
_ADJ_UNITS = ["", "одно", "двух", "трёх", "четырёх", "пяти", "шести", "семи", "восьми",
              "девяти", "десяти", "одиннадцати", "двенадцати", "тринадцати", "четырнадцати",
              "пятнадцати", "шестнадцати", "семнадцати", "восемнадцати", "девятнадцати"]
_ADJ_TENS = ["", "", "двадцати", "тридцати", "сорока", "пятидесяти", "шестидесяти",
             "семидесяти", "восьмидесяти", "девяносто"]

_MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
           "сентября", "октября", "ноября", "декабря")
_GOD = {"год": "n", "года": "g", "году": "p", "годом": "i", "годе": "p",
        "годы": "n", "годов": "g", "годам": "d", "годами": "i", "годах": "p"}
# год без слова «год» — падеж по слову перед ним; «по» — винительный, он как именительный
_YEAR_CASE = {
    "в": "p", "во": "p", "о": "p", "об": "p", "к": "d", "ко": "d",
    **dict.fromkeys(("с", "со", "до", "от", "после", "около", "из", "начала", "конца",
                     "середины", "начале", "конце", "середине", "летом", "весной",
                     "осенью", "зимой", *_MONTHS), "g"),
}
# после этих слов число — год, что бы за ним ни шло: «в 1988 вышла», «в 1985 Dire Straits»
_YEAR_FIRM = {"в", "во", "к", "ко", "после", "начала", "конца", "середины", "начале",
              "конце", "середине", "летом", "весной", "осенью", "зимой", *_MONTHS}
# слова, после которых год остаётся годом: «с 1969 по 1972», «1969 и 1970»
_LINKS = {"и", "или", "а", "но", "по", "до"}
_COUNT_CASE = {
    **dict.fromkeys(("около", "до", "от", "из", "без", "более", "менее", "свыше", "больше",
                     "меньше", "для", "кроме", "после"), "g"),
    "к": "d", "ко": "d", "о": "p", "об": "p", "при": "p",
}
# окончание после дефиса → падеж, род, множественное
_ENDINGS = {
    "й": ("n", "m", False), "ый": ("n", "m", False), "ий": ("n", "m", False),
    "го": ("g", "m", False), "ого": ("g", "m", False),
    "му": ("d", "m", False), "ому": ("d", "m", False),
    "м": ("p", "m", False), "ом": ("p", "m", False), "ым": ("i", "m", False),
    "я": ("n", "f", False), "ая": ("n", "f", False),
    "ю": ("a", "f", False), "ую": ("a", "f", False), "ой": ("g", "f", False),
    "е": ("n", "n", False), "ое": ("n", "n", False), "ые": ("n", "m", True),
    "х": ("p", "m", True), "ых": ("p", "m", True),
    "ми": ("i", "m", True), "ыми": ("i", "m", True),
}

_MEASURE = re.compile(rf"{_SIGNED}(?<![\w.,])({_NUM})\s*(?:(%)|°\s*(?:([CС])|([FФ]))?"
                      rf"(?![{_LETTER}]))")
# «№ 1» — «номер один»: число после «№» — метка, не количество, род не согласуется
_NUMERO = re.compile(rf"№\s?({_NUM})")
_PERCENT_ADJ = re.compile(r"(?<![\w.,])(\d{1,3})\s?%-(н[а-яё]{1,3})(?![\w])")
# «с 1 по 5 октября» — первое число тоже дата: «с первого по пятое октября»
_DATE_RANGE = re.compile(rf"(?<![\w.,])(3[01]|[12]?\d)(?=\s*(?:[–—-]\s*|\s(?:по|до)\s+)"
                         rf"(?:3[01]|[12]?\d)\s+(?:{'|'.join(_MONTHS)})(?!\w))", re.IGNORECASE)
# «$» — только вплотную к числу: «Ke$ha» и «A$AP» без цифры не трогаются
_MONEY = re.compile(rf"\$\s?({_NUM})(?:\s?(тыс\.|млн|млрд|тысяч[аи]?|миллион(?:а|ов)?"
                    rf"|миллиард(?:а|ов)?)(?![{_LETTER}]))?|(?<![\w.,])({_NUM})\s?\$")
_SPEED = re.compile(rf"(?<![\w.,])({_NUM})\s*(mph|km/h|км/ч)(?![{_LETTER}])", re.IGNORECASE)
_YEAR_WORD = re.compile(r"(?<![\w.,])(\d{1,4})(?:\s*[–—-]\s*(\d{1,4}))?"
                        r"(?:\s+(год(?:ами|ах|ам|ов|ом|у|а|е|ы)?)(?!\w)|\s*(гг?\.))",
                        re.IGNORECASE)
# «в 1969 г.» — слово «год» в падеже предлога; «гг.» — во множественном
_GOD_FORMS = {False: {"n": "год", "g": "года", "d": "году", "p": "году", "i": "годом"},
              True: {"n": "годы", "g": "годов", "d": "годам", "p": "годах", "i": "годами"}}
_SENTENCE_NEXT = re.compile(r"\s*$|\s+[A-ZА-ЯЁ«\"]")
_SUFFIX = re.compile(r"(?<![\w.,])(\d{1,15})-(" + "|".join(sorted(_ENDINGS, key=len, reverse=True))
                     + r"|ти)(?!\w)")
_DATE = re.compile(rf"(?<![\w.,])(3[01]|[12]?\d)(\s+(?:{'|'.join(_MONTHS)}))(?!\w)",
                   re.IGNORECASE)
_BARE_YEAR = re.compile(r"(?<![\w.,])(1[89]\d\d|20\d\d)(?:\s*[–—-]\s*(1[89]\d\d|20\d\d))?"
                        r"(?![.,]?\d)(?!\w)")
_CLOCK = re.compile(r"(?<![\w.,:])([01]?\d|2[0-3]):([0-5]\d)(?![\w:])")
_COUNT = re.compile(rf"(?:(?<![^\s(«„\"])([+−]))?(?<![\w.,])({_NUM})(?![\w])")

_LATIN_BEFORE = re.compile(r"[A-Za-z][\w'’&]*[ \-/]*$")
_LATIN_AFTER = re.compile(r"^[ \-/]*[A-Za-z]")
_WORD_BEFORE = re.compile(rf"([{_CYR}]+)\s+$")
_WORD_AFTER = re.compile(rf"^\s*([{_LETTER}]+)")


def _ordinal(n: int, case="n", gender="m", plural=False) -> str:
    # animate=False: винительный года — «за 1969 год», а не «за … девятого»
    return num2words(n, lang="ru", to="ordinal", case=case, gender=gender,
                     plural=plural, animate=False)


def _cardinal(text: str, case="n", gender="m") -> str:
    """«1 000» и «2,5» — тоже. «Одна тысяча девятьсот» — «тысяча девятьсот», как вслух."""
    s = re.sub(r"\s", "", text).replace(",", ".")
    words = num2words(Decimal(s) if "." in s else int(s), lang="ru", case=case, gender=gender)
    return re.sub(r"^одн(?:а|ой|у) (?=тысяч)", "", words)


def _form(text: str, forms) -> str:
    """forms — для 1, для 2–4 и для 5: «процент», «процента», «процентов»; дробь — как 2."""
    if re.search(r"[.,]", text):
        return forms[1]
    n = int(re.sub(r"\D", "", text))
    if 11 <= n % 100 <= 14 or not 1 <= n % 10 <= 4:
        return forms[2]
    return forms[0] if n % 10 == 1 else forms[1]


def _before(m) -> str:
    return m.string[max(0, m.start() - 64):m.start()]


def _after(m) -> str:
    return m.string[m.end():m.end() + 64]


def _word_before(m) -> str:
    w = _WORD_BEFORE.search(_before(m))
    return w.group(1).lower() if w else ""


def _latin_before(m) -> bool:
    return bool(_LATIN_BEFORE.search(_before(m)))


def _count_case(m) -> str:
    """Падеж количества с единицей: «до 5%» — родительный, иначе именительный."""
    return "g" if _COUNT_CASE.get(_word_before(m)) == "g" else "n"


def _quantity(num: str, forms, case="n", gender="m") -> str:
    """Число с существительным: «5 процентов»; в родительном — «до одного процента»,
    «до пяти процентов». Дробь — с родительным единственного: «2,5 процента»."""
    noun = _form(num, forms)
    if case == "g" and not re.search(r"[.,]", num):
        n = int(re.sub(r"\D", "", num))
        noun = forms[1] if n % 10 == 1 and n % 100 != 11 else forms[2]
    return f"{_cardinal(num, case, gender)} {noun}"


def _measure(m) -> str:
    sign, num, percent, celsius, fahrenheit = m.groups()
    said = _quantity(num, PERCENT if percent else DEGREE, _count_case(m))
    if sign:
        said = f"{_SIGN[sign]} {said}"
    scale = " по Цельсию" if celsius else " по Фаренгейту" if fahrenheit else ""
    return said + scale


def _money(m) -> str:
    num, magnitude, num_after = m.groups()
    case = _count_case(m)
    if num is None:
        return _quantity(num_after, DOLLAR, case)       # «5$»
    if magnitude is None:
        return _quantity(num, DOLLAR, case)
    key = "тыс" if magnitude.startswith("тыс") else "млн" if magnitude.startswith(("млн", "милл")) \
        else "млрд"
    forms, gender = _MAGNITUDES[key]
    # точка «тыс.» бывает и концом предложения — тогда она нужна нарезке
    end = "." if magnitude.endswith(".") and _SENTENCE_NEXT.match(_after(m)) else ""
    return f"{_quantity(num, forms, case, gender)} долларов{end}"


def _numero(m) -> str:
    return f"номер {_cardinal(m.group(1))}"


def _percent_adj(m) -> str:
    """«100%-ный» — «стопроцентный», «25%-ная» — «двадцатипятипроцентная»; вне 1–100
    остаётся как есть и читается дальше как проценты."""
    n, ending = int(m.group(1)), m.group(2)
    if not 1 <= n <= 100:
        return m.group()
    if n == 100:
        stem = "сто"
    elif n < 20:
        stem = _ADJ_UNITS[n]
    else:
        stem = _ADJ_TENS[n // 10] + _ADJ_UNITS[n % 10]
    return f"{stem}процент{ending}"


def _date_range(m) -> str:
    return _ordinal(int(m.group(1)), _YEAR_CASE.get(_word_before(m), "n"), "n")


def _speed(m) -> str:
    num, unit = m.groups()
    forms, gender = _SPEEDS[unit.lower()]
    return f"{_quantity(num, forms, _count_case(m), gender)} в час"


def _range_end(start: int, end: str) -> int:
    """«1969–72» — 1972; «1999–02» — 2002."""
    if len(end) >= len(str(start)):
        return int(end)
    step = 10 ** len(end)
    e = start - start % step + int(end)
    return e if e > start else e + step


def _year_word(m) -> str:
    start, end, word, abbr = m.groups()
    if word:
        key = word.lower()
        if end is None and key in ("год", "года") and int(start) < 1000:
            return m.group()        # «21 год», «через 2 года» — сколько, а не какой
        case = _GOD[key]
        if key == "году" and _word_before(m) in ("к", "ко", "по"):
            case = "d"
        plural = key in ("годы", "годов", "годам", "годами", "годах")
    else:
        if end is None and int(start) < 1000:
            return m.group()        # «2 г.» — скорее граммы
        case = _YEAR_CASE.get(_word_before(m), "n")
        plural = abbr.lower() == "гг."
        # точка сокращения бывает и концом предложения — тогда она нужна нарезке
        word = _GOD_FORMS[plural][case] + ("." if _SENTENCE_NEXT.match(_after(m)) else "")
    if end is None:
        # «в 90 годах» — десятилетие: порядковое тоже во множественном
        return f"{_ordinal(int(start), case, plural=plural)} {word}"
    return (f"{_ordinal(int(start), case)} — {_ordinal(_range_end(int(start), end), case)}"
            f" {word}")


def _suffix(m) -> str:
    num, ending = m.groups()
    n = int(num)
    decade = n >= 10 and n % 10 == 0
    if ending == "ти" or (ending in ("х", "ми") and not decade):
        return _cardinal(num, "g")                       # «из 3-х частей» — «трёх»
    case, gender, plural = _ENDINGS[ending]
    if decade and ending == "е":
        plural = True                                    # «90-е» — «девяностые»
    if decade and ending == "м" and _word_before(m) in ("к", "ко", "по"):
        case, plural = "d", True                         # «к 70-м» — «семидесятым»
    return _ordinal(n, case, gender, plural)


def _date(m) -> str:
    # «9 октября» — «девятое», «с 9 октября» — «девятого», «к 9 октября» — «девятому»
    return _ordinal(int(m.group(1)), _YEAR_CASE.get(_word_before(m), "n"), "n") + m.group(2)


def _bare_year(m) -> str:
    if _latin_before(m):
        return m.group()
    prep = _word_before(m)
    if prep not in _YEAR_FIRM:
        nxt = _WORD_AFTER.match(_after(m))
        if nxt and nxt.group(1).lower() not in _LINKS:
            return m.group()     # «2000 копий» — количество; «1979 Remix» — имя
    case = _YEAR_CASE.get(prep, "n")
    start, end = m.groups()
    if end is None:
        return _ordinal(int(start), case)
    return f"{_ordinal(int(start), case)} — {_ordinal(int(end), case)}"


def _clock(m) -> str:
    hours, minutes = m.groups()
    if minutes == "00":
        said = "ноль ноль"
    elif minutes[0] == "0":
        said = f"ноль {_cardinal(minutes[1])}"
    else:
        said = _cardinal(minutes)
    return f"{_cardinal(hours)} {said}"


def _dot_chain(m, hide) -> str:
    time = _DOT_TIME.fullmatch(m.group())
    if time and (_word_before(m) in _TIME_PREPS or _DAYPART.match(_after(m))):
        return _clock(time)
    return hide(m)


def _gender(num: str, case: str, after: str) -> str:
    """Род количественного 1 и 2 — по окончанию следующего слова: «1 песня», «2 минуты»."""
    if not num.isdigit():
        return "m"
    n = int(num)
    word = _WORD_AFTER.match(after)
    if not word or 11 <= n % 100 <= 14 or word.group(1).lower() in _LINKS:
        return "m"
    end = word.group(1).lower()[-1]
    if n % 10 == 1 and case == "n":
        return "f" if end in "ая" else "n" if end in "оеё" else "m"
    if (n % 10 == 1 and case == "g") or (n % 10 == 2 and case == "n"):
        return "f" if end in "ыи" else "m"
    return "m"


def _count(m) -> str:
    sign, num = m.groups()
    if _latin_before(m) or _LATIN_AFTER.match(_after(m)):
        return m.group()
    case = _COUNT_CASE.get(_word_before(m), "n")
    words = _cardinal(num, case, _gender(num, case, _after(m)))
    return f"{_SIGN[sign]} {words}" if sign else words


def normalize(text: str, keep: re.Pattern | None = None) -> str:
    """Цифры, `%`, `°`, `$`, mph и км/ч — словами. Порядок проходов — от узкого к
    общему: единицы и годы со словом «год» уносят свои числа раньше, чем их прочтут
    количественными. keep — фрагменты, которые числа не трогают: имена из словаря
    коллекции («Links 2 3 4», «Song #1») читает он, а соседнее слово этого не видит."""
    if not re.search(r"\d", text):
        return text
    hidden = []

    def hide(m):
        hidden.append(m.group())
        return chr(_HIDDEN + len(hidden) - 1)

    if keep is not None:
        text = keep.sub(lambda m: hide(m) if re.search(r"\d", m.group()) else m.group(), text)
    text = _DOT_CHAIN.sub(lambda m: _dot_chain(m, hide), text)
    for pattern, fn in ((_NUMERO, _numero), (_PERCENT_ADJ, _percent_adj),
                        (_MEASURE, _measure), (_MONEY, _money), (_SPEED, _speed),
                        (_YEAR_WORD, _year_word), (_SUFFIX, _suffix), (_DATE_RANGE, _date_range),
                        (_DATE, _date), (_BARE_YEAR, _bare_year), (_CLOCK, _clock),
                        (_COUNT, _count)):
        text = pattern.sub(fn, text)
    return _HIDDEN_RE.sub(lambda m: hidden[ord(m.group()) - _HIDDEN], text)
