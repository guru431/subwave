"""Ударения — RUAccent внутри службы, общий слой для всех клиентов.

Нотация — '+' перед ударной гласной, на ней обучен ESpeech. В U+0301 не
переводить (в отличие от плана radio-upgrades, писавшегося под Chatterbox).
Текст с уже стоящими '+' не трогается: ручная правка автора сохраняется.

RUAccent 1.5.8.3 поправлена здесь, а не в пакете: модель омографов turbo3.1, их
сравнение по вероятности и без учёта регистра, без модели ё-омографов, словарь в
SQLite. Каждая правка — по ошибкам на корпусе 269 реплик ведущей (2026-09-23);
проверка на настоящих моделях — tools/stress_audit.py.
"""
import gzip
import json
import os
import re
import sqlite3
import threading
from pathlib import Path

import numpy as np

from f5_text import has_stress_marks

# Белый список RUAccent 1.5.8.3 (ruaccent.py:24): всё вне него process_all молча
# удаляет — «Hélène» стала бы «Hlne», «AC/DC» — «ACDC», «50%» — «50», а «…» и
# пауза при нём пропали бы. Спека: латиница проходит как есть. Такие места
# отдаются RUAccent через skip_regex и возвращаются нетронутыми.
_KEEP = r"a-zA-Z0-9\sа-яА-ЯёЁ—.,!?:;'(){}\[\]«»„“”\-"
# Комбинируемые диакритики (U+0301 и соседи) по-прежнему снимает RUAccent: пропуск
# разрезал бы русское слово, и ударение ставилось бы его кускам.
_MARKS = "̀-ͯ"
# \b обязателен: без него на слове в 19000 букв перебор начал шёл 26 с.
_UNIT = (rf"\b\w*(?:(?![{_KEEP}])[^\W\d_])[\w{_MARKS}]*"   # слово с буквой вне списка — целиком
         rf"|(?:[^\w{_KEEP}{_MARKS}]|_)+")                   # знаки вне списка: … – % / & № "
# Соседние места склеиваются вместе с пробелами между ними: отрезок из одних
# пробелов RUAccent вернула бы пустым (razdel не находит в нём предложения).
SKIP_REGEX = rf"(?:{_UNIT})(?:\s*(?:{_UNIT}))*"


# Модель омографов. tiny2.1 выбирала прочтение почти наугад — вероятности около 0.5:
# «на связ+и» ×8, «рук+и так и не дошли», «ни облак+а». turbo3.1 — модель из примера
# ESpeech: на том же корпусе исправила 11 мест, испортила одно («пр+обил», закреплено
# ниже). Весит 403 МБ против 55 — место под неё освободил словарь в SQLite.
OMOGRAPH_MODEL = "turbo3.1"

# Поправки к словарю RUAccent: слово в нижнем регистре → с «+». Словарь одно слово на
# все формы и без части речи, и ошибается; ESpeech верит знаку, так что неверный знак
# хуже никакого. Пополнять по слуху владельца.
STRESS_OVERRIDES = {
    "глушите": "глуш+ите",        # словарь: «гл+ушите»; по норме глуши́те (2026-09-23)
    "металлика": "мет+аллика",    # Metallica → f5_text.PRONUNCIATION; мета́ллика (2026-09-23)
}

# Омографы с одним прочтением в речи ведущей: единственный вариант вместо выбора модели.
HOMOGRAPH_OVERRIDES = {
    "после": ["п+осле"],          # «посл+е» — падеж от «посол»; «После полудня»
    "женя": ["ж+еня"],            # «Жен+я Барс»
    # среди вариантов RUAccent — несуществующее «пр+обил», и turbo3.1 выбрала его с
    # вероятностью 0.97 («только что пробил час ночи»); «пробило» — в каждом часе
    "пробил": ["проб+ил"], "пробило": ["проб+ило"],
    "пробили": ["проб+или"], "пробила": ["проб+ила"],
    # просторечное «н+ачался» стоит в вариантах наравне с нормой, и модель выбирала
    # его в объявлениях времени («вторник н+ачался»)
    "начался": ["началс+я"], "началась": ["начал+ась"], "началось": ["начал+ось"],
}

# Сочетания с одним прочтением, в которых модель омографов ошибается и на turbo3.1:
# имя группы, оборот. RUAccent их не видит — на их месте символ из Private Use Area, а
# его SKIP_REGEX пропускает мимо неё нетронутым; поэтому знак нужен каждому слову из
# двух и больше гласных. Все — ошибки на репликах эфира 23.09.
PHRASE_STRESS = {
    "руки вверх": "р+уки вв+ерх",               # и группа, и оборот: «рук+и» с 0.75
    "руки не дошли": "р+уки не дошл+и",
    "руки так и не дошли": "р+уки так и не дошл+и",
    "ни облака": "ни +облака",                  # «ни тени, ни облак+а»
    "половина утра": "полов+ина +утра",         # «вторая половина утр+а»
}
_PHRASE = re.compile(
    r"(?<!\w)(?:" + "|".join(map(re.escape, sorted(PHRASE_STRESS, key=len, reverse=True)))
    + r")(?!\w)", re.IGNORECASE)
_PHRASE_SLOT = 0xE000

DICTIONARY_DB = Path("dictionary") / "accents.sqlite"

# Слова в разбивке RUAccent 1.5.8.3 (text_preprocessor.split_by_words): «»,» — одно слово.
_RUACCENT_WORD = re.compile(r"\w*(?:\+\w+)*|[^\w\s]+")


def usage_by_words(predict, sentence):
    """Пометки «нужно ли ударение» — по словам RUAccent, а не по токенам модели.

    process_all ставит ударение i-му слову по i-й пометке модели. Но модель режет
    «»,» на два токена, а RUAccent держит одним словом — с этого места пометки
    съезжают до конца предложения: «восемьдесят» после «Солнце»,» получало пометку
    запятой, без ударения, и F5 ставил его сам и не туда (эфир 2026-09-23). Здесь
    слово получает STRESS, если его перекрывает хоть один помеченный токен модели."""
    tokens = predict(sentence)
    out = []
    for m in _RUACCENT_WORD.finditer(sentence.replace(" - ", " ~ ").lower()):
        if not m.group():
            continue
        start, end = m.span()
        hit = [t["entity"] for t in tokens
               if t.get("start") is not None and t["start"] < end and t["end"] > start]
        out.append({"entity": "STRESS" if "STRESS" in hit else (hit[0] if hit else "NO_STRESS")})
    return out


class _NoRuleEngine:
    """RuleEngine RUAccent 1.5.8.3 (морфология koziev + forms.json) грузится в load(),
    но process_all его не вызывает (ruaccent.py:119-124 против 234-251). Это 0.87 ГБ
    из 1.77 ГБ загрузки при тех же ударениях (замер на gpu-host 2026-09-23): на них
    служба не влезла в 3 ГБ — место Chatterbox в ВМ Docker."""

    def load(self, *args, **kwargs):
        pass


class _NoYoModel:
    """Модель ё-омографов RUAccent не грузится: она ставила ё, где его нет, — «на н+ёбе»
    (0.98), «Вс+ё пришли», «ещё дал+ёко» ×2 и «само+ё время» ×3 в эфире 23.09. LLM
    ведущей пишет ё сама («всё», «ещё», «тёплого»), так что буква автора надёжнее.
    Словарь однозначных слов (yo_words: «звездный» → «звёздный») работает как прежде."""

    def load(self, *args, **kwargs):
        pass

    def predict_yo_homographs(self, text):
        return []


def _restore_case(src: str, marked: str) -> str:
    """Регистр букв src — на вариант с «+» из словаря в нижнем регистре."""
    out, i = [], 0
    for ch in marked:
        if ch != "+":
            ch = ch.upper() if i < len(src) and src[i].isupper() else ch
            i += 1
        out.append(ch)
    return "".join(out)


def _row_softmax(x):
    """softmax по строкам. OmographModel.classify RUAccent 1.5.8.3 нормирует выход пакета
    целиком (omograph_model.py:16-18, 95), и гипотезы сравнивались по сырому логиту
    «верно» без логита «неверно»: так в эфир 23.09 ушло «у кого-то дорог+а из офиса»."""
    x = np.asarray(x, dtype=np.float64)
    e = np.exp(x - x.max(axis=-1, keepdims=True))
    return e / e.sum(axis=-1, keepdims=True)


def _homographs_any_case(acc):
    """_process_omographs RUAccent 1.5.8.3 (ruaccent.py:167-199), но без учёта регистра.

    Там омограф ищется как написан, и слово с заглавной — в начале фразы, в имени —
    шло мимо модели в словарь с одним прочтением на все случаи: «Сектор+а Газа»,
    «К+ому-то из нас», «Тон+и Брэкстон». Модели слово отдаётся в нижнем регистре, как
    она видела все прочие омографы, а выбранному варианту регистр возвращается."""
    def process(words):
        found = [(i, w, acc.omographs[w.lower()]) for i, w in enumerate(words)
                 if w.lower() in acc.omographs]
        if not found:
            return words
        texts, hypotheses, counts = [], [], []
        for i, w, variants in found:
            context = list(words)
            context[i] = " <w>" + w.lower() + "</w> "
            texts += [acc.delete_spaces_before_punc(" ".join(context))] * len(variants)
            hypotheses += variants
            counts.append(len(variants))
        for (i, w, _), variant in zip(found, acc.omograph_model.classify(texts, hypotheses, counts)):
            words[i] = _restore_case(w, variant)
        return words
    return process


class DictionaryDb:
    """Словарь ударений RUAccent из SQLite вместо dict. 3.2 млн словоформ в памяти
    Python — 661 МБ из 0.9 ГБ RUAccent (замер на gpu-host 2026-09-23); без них в лимит
    3 ГБ помещается turbo3.1. RUAccent зовёт только get (ruaccent.py:210); поправки
    лежат поверх словаря, как у неё (ruaccent.py:115-116)."""

    def __init__(self, path, overrides):
        # immutable: база только читается — ни журнала, ни блокировок на файле, которых
        # на каталоге, смонтированном с Windows, может и не быть
        uri = Path(path).resolve().as_uri() + "?mode=ro&immutable=1"
        self._db = sqlite3.connect(uri, uri=True, check_same_thread=False)
        self._overrides = dict(overrides)

    def get(self, word, default=None):
        if word in self._overrides:
            return self._overrides[word]
        row = self._db.execute("SELECT stressed FROM accents WHERE word = ?", (word,)).fetchone()
        return row[0] if row else default

    def __contains__(self, word):
        return self.get(word) is not None


def build_dictionary_db(workdir) -> Path:
    """accents.json.gz RUAccent → dictionary/accents.sqlite рядом. Запускать на хосте
    (tools/accents_db.py): в контейнере разбор json занял бы те же 661 МБ."""
    workdir = Path(workdir)
    dst = workdir / DICTIONARY_DB
    tmp = dst.with_name(dst.name + ".tmp")
    tmp.unlink(missing_ok=True)
    with gzip.open(workdir / "dictionary" / "accents.json.gz", "rt", encoding="utf-8") as f:
        accents = json.load(f)
    con = sqlite3.connect(tmp)
    try:
        con.execute("CREATE TABLE accents (word TEXT PRIMARY KEY, stressed TEXT NOT NULL)"
                    " WITHOUT ROWID")
        con.executemany("INSERT INTO accents VALUES (?, ?)", sorted(accents.items()))
        con.commit()
    finally:
        con.close()
    os.replace(tmp, dst)
    return dst


def _hide_phrases(text):
    """Сочетания из PHRASE_STRESS → по символу Private Use Area; размеченные — в список."""
    marked = []

    def hide(m):
        marked.append(_restore_case(m.group(), PHRASE_STRESS[m.group().lower()]))
        return chr(_PHRASE_SLOT + len(marked) - 1)

    return _PHRASE.sub(hide, text), marked


def _show_phrases(text, marked):
    for i, phrase in enumerate(marked):
        text = text.replace(chr(_PHRASE_SLOT + i), phrase)
    return text


def _feed_token_type_ids(session) -> None:
    """Модели ударений RUAccent требуют token_type_ids, а её токенизатор под
    transformers 5 их больше не отдаёт: слово вне словаря («Бурдыкляндия», редкая
    фамилия) роняло process_all, и реплика уходила без единого ударения. Нули — ровно
    то, что отдавал старый токенизатор (create_token_type_ids_from_sequences)."""
    if not hasattr(session, "get_inputs"):
        return
    if "token_type_ids" not in {i.name for i in session.get_inputs()}:
        return
    run = session.run

    def run_with_token_types(output_names, feed, *args, **kwargs):
        if "token_type_ids" not in feed and "input_ids" in feed:
            feed = {**feed, "token_type_ids": np.zeros_like(feed["input_ids"])}
        return run(output_names, feed, *args, **kwargs)

    session.run = run_with_token_types


class Accentizer:
    def __init__(self, workdir: Path, log=print):
        self.workdir = Path(workdir)
        self.log = log
        self._model = None
        self._lock = threading.Lock()     # эфир и /clone зовут из разных потоков

    def load(self) -> None:
        """Грузить при старте службы: первая реплика эфира не должна ждать модель."""
        import ruaccent.rule_accent_engine as rule_engine
        from ruaccent import RUAccent
        db = self.workdir / DICTIONARY_DB
        if not db.exists():
            raise FileNotFoundError(f"нет {db}: собрать tools/accents_db.py до запуска службы")
        rule_engine.RuleEngine = _NoRuleEngine        # load() берёт класс из модуля
        acc = RUAccent()
        acc.yo_homograph_model = _NoYoModel()         # load() зовёт её load() — пустышка
        # use_dictionary=False: вместо полного словаря RUAccent грузит малый accents_nn,
        # и его тут же сменяет база
        acc.load(omograph_model_size=OMOGRAPH_MODEL, use_dictionary=False, device="CPU",
                 workdir=str(self.workdir), custom_dict=STRESS_OVERRIDES,
                 custom_homographs=HOMOGRAPH_OVERRIDES)
        acc.accents = DictionaryDb(db, {**acc.custom_dict, **acc.letters_accent})
        acc.yo_homographs = {}
        acc.omograph_model.softmax = _row_softmax
        acc._process_omographs = _homographs_any_case(acc)
        for part in vars(acc).values():
            _feed_token_type_ids(getattr(part, "session", None))
        predict = acc.stress_usage_predictor.predict_stress_usage
        acc.stress_usage_predictor.predict_stress_usage = lambda s: usage_by_words(predict, s)
        self._model = acc

    def apply(self, text: str) -> str:
        if has_stress_marks(text):
            return text
        with self._lock:
            if self._model is None:
                self.load()
            hidden, phrases = _hide_phrases(text)
            try:
                marked = self._model.process_all(hidden, skip_regex=SKIP_REGEX)
            except Exception as e:             # noqa: BLE001 — реплика важнее ударений
                # Токенизаторы моделей RUAccent без truncation: предложение длиннее
                # 2048 токенов роняет модель «нужно ли ударение» (до 23.09 на 512
                # падала раньше модель ё-омографов). Лучше звук без ударений, чем 500.
                self.log(f"accent failed, text left unaccented: {type(e).__name__}: {e}")
                return text
            return _show_phrases(marked, phrases)
