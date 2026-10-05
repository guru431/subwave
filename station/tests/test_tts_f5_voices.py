"""f5_accent и f5_voices: ударения RUAccent и голоса станции.

Голос по умолчанию отвечает на пустое, OpenAI-имя и опечатку: отказ 4xx на
опечатке означал бы молчание эфира — мостик 4xx не повторяет, отката нет.
"""
import gzip
import json
import re
import sys
import types
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
import f5_accent  # noqa: E402
import f5_audio as A  # noqa: E402
import f5_voices as V  # noqa: E402


def tone(seconds, db=-20.0, sr=24000):
    t = np.arange(int(sr * seconds)) / sr
    return (10 ** (db / 20) * np.sqrt(2) * np.sin(2 * np.pi * 220 * t)).astype(np.float32)


# Белый список RUAccent 1.5.8.3 (ruaccent.py:24): всё вне него process_all_internal
# молча удаляет. Подделка повторяет и это, и разбиение по skip_regex (ruaccent.py:253-284).
RUACCENT_NORMALIZE = re.compile(r"[^a-zA-Z0-9\sа-яА-ЯёЁ—.,!?:;'(){}\[\]«»„“”-]")


class FakeSession:
    """ONNX-сессия, как в onnxruntime: без обязательного входа run падает."""

    def __init__(self, inputs):
        self._inputs = inputs
        self.feeds = []

    def get_inputs(self):
        return [types.SimpleNamespace(name=n) for n in self._inputs]

    def run(self, output_names, feed):
        missing = [n for n in self._inputs if n not in feed]
        if missing:
            raise ValueError(f"Required inputs ({missing}) are missing from input feed ({list(feed)}).")
        self.feeds.append(feed)
        return [np.zeros((1, 1))]


class FakeRuleEngine:
    """RuleEngine RUAccent: морфология koziev + forms.json, 0.87 ГБ при загрузке."""
    created = 0

    def __init__(self):
        FakeRuleEngine.created += 1

    def load(self, path):
        pass


class FakeYoModel:
    """Модель ё-омографов RUAccent: служба её не грузит."""
    loaded = 0

    def load(self, path, device="CPU"):
        FakeYoModel.loaded += 1


class FakeOmographModel:
    """OmographModel RUAccent: softmax по всей матрице сразу (omograph_model.py:16-18)."""

    def __init__(self):
        self.session = FakeSession(["input_ids", "attention_mask"])
        self.calls = []

    def load(self, path, device="CPU"):
        pass

    def softmax(self, x):
        e = np.exp(x - np.max(x))
        return e / e.sum()

    def classify(self, texts, hypotheses, num_hypotheses):
        """Выбирает первый вариант каждого омографа — порядок и число ответов как у RUAccent."""
        self.calls.append((texts, hypotheses, num_hypotheses))
        out, pos = [], 0
        for n in num_hypotheses:
            out.append(hypotheses[pos])
            pos += n
        return out


class FakeRUAccent:
    loads = []
    seen = []
    fail = None

    def __init__(self):
        # как ruaccent.py:18-41: модели создаются в конструкторе, грузит их load()
        self.omograph_model = FakeOmographModel()
        self.yo_homograph_model = FakeYoModel()
        self.letters_accent = {"о": "+о", "О": "+О"}

    def load(self, **kw):
        FakeRUAccent.loads.append(kw)
        # как ruaccent.py:89-124: модели с ONNX-сессиями и RuleEngine, взятый из
        # модуля в момент загрузки; токенизатор под transformers 5 token_type_ids не даёт
        self.custom_dict = kw["custom_dict"]
        self.omographs = {"руки": ["р+уки", "рук+и"], **kw["custom_homographs"]}
        self.omograph_model.load("nn/nn_omograph/" + kw["omograph_model_size"])
        self.yo_homograph_model.load("nn/nn_yo_homograph_resolver")
        self.accent_model = types.SimpleNamespace(
            session=FakeSession(["input_ids", "attention_mask", "token_type_ids"]))
        from ruaccent.rule_accent_engine import RuleEngine
        self.rule_accent = RuleEngine()
        self.rule_accent.load("dictionary/rule_engine")
        self.stress_usage_predictor = types.SimpleNamespace(
            predict_stress_usage=FakeRUAccent.usage_tokens)
        self.yo_homographs = {"самое": "самоё", "все": "всё"}
        self.yo_words = {}
        # use_dictionary=False: вместо полного словаря — малый accents_nn
        self.accents = {"молоко": "молок+о", **self.custom_dict, **self.letters_accent}

    @staticmethod
    def delete_spaces_before_punc(text):
        return re.sub(r" +(?=[,.!?:;])", "", text)

    @staticmethod
    def usage_tokens(sentence):
        """Как StressUsagePredictorModel: свои токены со смещениями, «»,» — два токена."""
        out = []
        for m in re.finditer(r"\w+|[^\w\s]", sentence):
            word = m.group()
            entity = "PUNCT" if not word[0].isalnum() else (
                "NO_STRESS" if word.lower() in {"по", "и", "на"} else "STRESS")
            out.append({"entity": entity, "word": word, "start": m.start(), "end": m.end()})
        return out

    def _internal(self, text):
        if FakeRUAccent.fail:
            raise FakeRUAccent.fail
        FakeRUAccent.seen.append(text)
        text = RUACCENT_NORMALIZE.sub("", text)
        if not text.strip():              # razdel не находит предложения в одних пробелах
            return ""
        if "Бурдыкляндия" in text:         # нет в словаре — идёт в accent_model
            self.accent_model.session.run(None, {"input_ids": np.array([[2, 5, 3]]),
                                                 "attention_mask": np.array([[1, 1, 1]])})
            text = text.replace("Бурдыкляндия", "Бурдыкл+яндия")
        return text.replace("молоко", "молок+о").replace("замок", "з+амок")

    def process_all(self, text, skip_regex=None):
        if not skip_regex:
            return self._internal(text)
        out, pos = [], 0
        for m in re.finditer(skip_regex, text):
            seg = text[pos:m.start()]
            out += [self._internal(seg) if seg else seg, m.group()]
            pos = m.end()
        seg = text[pos:]
        return "".join(out + [self._internal(seg) if seg else seg])


def write_dictionary(workdir, accents):
    """accents.json.gz, как у RUAccent, и база из него — как tools/accents_db.py на хосте."""
    d = workdir / "dictionary"
    d.mkdir(exist_ok=True)
    with gzip.open(d / "accents.json.gz", "wt", encoding="utf-8") as f:
        json.dump(accents, f, ensure_ascii=False)
    return f5_accent.build_dictionary_db(workdir)


@pytest.fixture
def ruaccent(monkeypatch, tmp_path):
    FakeRUAccent.loads = []
    FakeRUAccent.seen = []
    FakeRUAccent.fail = None
    FakeRuleEngine.created = 0
    FakeYoModel.loaded = 0
    mod = types.ModuleType("ruaccent")
    mod.RUAccent = FakeRUAccent
    engine = types.ModuleType("ruaccent.rule_accent_engine")
    engine.RuleEngine = FakeRuleEngine
    mod.rule_accent_engine = engine
    monkeypatch.setitem(sys.modules, "ruaccent", mod)
    monkeypatch.setitem(sys.modules, "ruaccent.rule_accent_engine", engine)
    write_dictionary(tmp_path, {"молоко": "молок+о", "глушите": "гл+ушите"})
    return FakeRUAccent


def write_voice(d, name, x, text="Эталонная фраза"):
    (d / f"{name}.wav").write_bytes(A.encode_wav(x, 24000))
    if text is not None:
        (d / f"{name}.txt").write_text(text, encoding="utf-8")


def test_accentizer_marks_plain_text(ruaccent, tmp_path):
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("Купи молоко") == "Купи молок+о"
    kw = ruaccent.loads[0]
    assert kw["device"] == "CPU" and kw["workdir"] == str(tmp_path)


def test_homograph_model_is_turbo(ruaccent, tmp_path):
    """tiny2.1 выбирала прочтение омографа почти наугад — вероятности около 0.5: «на
    связ+и» ×8, «рук+и так и не дошли», «ни облак+а» на корпусе 269 реплик ведущей
    23.09. turbo3.1 — модель из примера ESpeech."""
    f5_accent.Accentizer(tmp_path).load()
    assert ruaccent.loads[0]["omograph_model_size"] == "turbo3.1"


def test_usage_follows_ruaccent_words_not_model_tokens():
    """RUAccent режет «»,» в одно слово, а модель «нужно ли ударение» — в два токена;
    без выравнивания её пометки съезжают до конца предложения, и «восемьдесят»
    получало пометку запятой — без ударения, F5 ставил его сам и не туда."""
    s = "«Звезда», восемьдесят девятый год."
    labels = [x["entity"] for x in f5_accent.usage_by_words(FakeRUAccent.usage_tokens, s)]
    # слова RUAccent: « Звезда », восемьдесят девятый год .
    assert labels[3:6] == ["STRESS", "STRESS", "STRESS"]
    assert len(labels) == 7


def test_loaded_model_uses_aligned_usage(ruaccent, tmp_path):
    acc = f5_accent.Accentizer(tmp_path)
    acc.load()
    s = "«Звезда», восемьдесят год."
    got = acc._model.stress_usage_predictor.predict_stress_usage(s)
    assert [x["entity"] for x in got][3] == "STRESS"


def test_known_dictionary_errors_are_overridden(ruaccent, tmp_path):
    """Словарь RUAccent ставит «гл+ушите»; по норме — «глуш+ите»."""
    f5_accent.Accentizer(tmp_path).load()
    assert ruaccent.loads[0]["custom_dict"]["глушите"] == "глуш+ите"
    assert ruaccent.loads[0]["custom_dict"]["металлика"] == "мет+аллика"


def test_homographs_with_one_reading_on_air_are_pinned(ruaccent, tmp_path):
    """У этих омографов в речи ведущей одно прочтение, а модель выбирала другое:
    «посл+е полудня» (падеж от «посол»), «Жен+я Барс»; у «пробил» среди вариантов
    несуществующее «пр+обил», и turbo3.1 выбрала его с вероятностью 0.97; «вторник
    н+ачался» — просторечие в объявлениях времени."""
    f5_accent.Accentizer(tmp_path).load()
    pinned = ruaccent.loads[0]["custom_homographs"]
    for word, stressed in (("после", "п+осле"), ("женя", "ж+еня"),
                           ("пробил", "проб+ил"), ("пробило", "проб+ило"),
                           ("пробили", "проб+или"), ("пробила", "проб+ила"),
                           ("начался", "началс+я"), ("началась", "начал+ась"),
                           ("началось", "начал+ось")):
        assert pinned[word] == [stressed]


def test_capitalized_homograph_goes_to_the_model(ruaccent, tmp_path):
    """RUAccent ищет омограф как написан, и слово с заглавной — в начале фразы, в имени —
    шло мимо модели в словарь с одним прочтением на все случаи: «Сектор+а Газа»,
    «К+ому-то из нас», «Тон+и Брэкстон». Модель получает слово в нижнем регистре,
    выбранному варианту регистр возвращается."""
    acc = f5_accent.Accentizer(tmp_path)
    acc.load()
    words = ["Руки", "так", "и", "не", "дошли", "."]
    assert acc._model._process_omographs(words) == ["Р+уки", "так", "и", "не", "дошли", "."]
    texts, hypotheses, counts = acc._model.omograph_model.calls[-1]
    assert [t.split() for t in texts] == [["<w>руки</w>", "так", "и", "не", "дошли."]] * 2
    assert hypotheses == ["р+уки", "рук+и"] and counts == [2]


def test_homograph_hypotheses_compared_by_row_probability(ruaccent, tmp_path):
    """OmographModel.classify RUAccent нормирует выход пакета целиком, а не по строке, и
    гипотезы сравнивались по сырому логиту «верно» без логита «неверно». Так в эфир
    23.09 ушло «у кого-то дорог+а из офиса»; по вероятности — «дор+ога»."""
    acc = f5_accent.Accentizer(tmp_path)
    acc.load()
    logits = np.array([[3.0, 1.0],       # логит «верно» выше, вероятность 0.12
                       [-1.0, 0.5]])     # логит ниже, вероятность 0.82
    p = acc._model.omograph_model.softmax(logits)
    assert np.allclose(p.sum(axis=1), 1.0)
    assert p[1, 1] > p[0, 1]


def test_yo_homographs_keep_the_authors_letter(ruaccent, tmp_path):
    """Модель ё-омографов ставила ё, где его нет: «на н+ёбе» (0.98), «Вс+ё пришли»,
    «ещё дал+ёко» ×2 в эфире, «само+ё время» ×3. LLM ведущей пишет ё сама, так что
    буква автора надёжнее модели; сама модель не грузится вовсе."""
    acc = f5_accent.Accentizer(tmp_path)
    acc.load()
    assert FakeYoModel.loaded == 0
    assert acc._model.yo_homographs == {}
    assert acc._model.yo_homograph_model.predict_yo_homographs("на небе ни облака") == []


def test_phrase_with_known_reading_bypasses_ruaccent(ruaccent, tmp_path):
    """turbo3.1 читает «руки вверх» как «рук+и» с вероятностью 0.75 — и оборот, и группу
    «Руки Вверх», которую станция играет. У сочетания одно прочтение, и RUAccent его не
    видит вовсе."""
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("Руки Вверх!, «18 мне уже» и молоко") == "Р+уки Вв+ерх!, «18 мне уже» и молок+о"
    assert acc.apply("поднимите руки вверх") == "поднимите р+уки вв+ерх"
    assert not any("руки" in s.lower() for s in ruaccent.seen)


def test_dictionary_is_read_from_sqlite_not_memory(ruaccent, tmp_path):
    """Словарь RUAccent — 3.2 млн словоформ, в dict Python это 661 МБ из 0.9 ГБ всей
    RUAccent (замер 23.09). Без них в лимит контейнера 3 ГБ помещается turbo3.1:
    RUAccent грузится без полного словаря, слово ищется в SQLite, поправки — поверх."""
    acc = f5_accent.Accentizer(tmp_path)
    acc.load()
    assert ruaccent.loads[0]["use_dictionary"] is False
    accents = acc._model.accents
    assert accents.get("молоко") == "молок+о"             # из базы
    assert accents.get("глушите") == "глуш+ите"           # поправка поверх базы
    assert accents.get("о") == "+о"                       # буквы RUAccent — как у неё
    assert accents.get("бурдыкляндия", "бурдыкляндия") == "бурдыкляндия"
    assert "молоко" in accents and "бурдыкляндия" not in accents


def test_service_refuses_to_start_without_dictionary_db(ruaccent, tmp_path):
    """Без базы словарь пришлось бы держать в памяти, а рядом с turbo3.1 он в лимит не
    влезает: пусть служба не стартует с понятной причиной, а не падает по OOM."""
    (tmp_path / "dictionary" / "accents.sqlite").unlink()
    with pytest.raises(FileNotFoundError, match="accents_db"):
        f5_accent.Accentizer(tmp_path).load()


def test_dictionary_db_rebuild_replaces_old(tmp_path):
    db = write_dictionary(tmp_path, {"молоко": "м+олоко"})
    write_dictionary(tmp_path, {"молоко": "молок+о"})
    assert f5_accent.DictionaryDb(db, {}).get("молоко") == "молок+о"
    assert list((tmp_path / "dictionary").glob("*.tmp")) == []


def test_accentizer_keeps_author_marks(ruaccent, tmp_path):
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("з+амок и молоко") == "з+амок и молоко"
    assert ruaccent.loads == []                   # размеченный текст модель не будит


def test_accentizer_keeps_what_ruaccent_would_drop(ruaccent, tmp_path):
    """RUAccent молча удаляет всё вне своего белого списка: «Hélène» стала бы «Hlne»,
    «AC/DC» — «ACDC», «50%» — «50», «…» и пауза при нём пропали бы. Спека: латиница
    проходит как есть."""
    text = 'Hélène Ségara & AC/DC – 50% «Соловій» №5 "Кино"… и молоко 🙂'
    assert f5_accent.Accentizer(tmp_path).apply(text) == text.replace("молоко", "молок+о")


def test_accentizer_keeps_spaces_between_skipped_symbols(ruaccent, tmp_path):
    """Отрезок из одних пробелов между двумя пропусками RUAccent вернула бы пустым."""
    assert f5_accent.Accentizer(tmp_path).apply("AC/DC & / Queen") == "AC/DC & / Queen"


def test_accentizer_does_not_split_a_word_at_combining_accent(ruaccent, tmp_path):
    """U+0301 внутри русского слова снимает сама RUAccent, как и прежде: пропуск его
    разрезал бы слово, и ударение ставилось бы кускам."""
    assert f5_accent.Accentizer(tmp_path).apply("Старый за́мок") == "Старый з+амок"


def test_accentizer_failure_leaves_text_unaccented(ruaccent, tmp_path):
    """Предложение длиннее 2048 токенов роняет ONNX-модель «нужно ли ударение» RUAccent
    (токенизатор без truncation): реплика без ударений лучше, чем 500 вместо звука."""
    ruaccent.fail = RuntimeError("[ONNXRuntimeError] broadcast 512 by 590")
    logged = []
    acc = f5_accent.Accentizer(tmp_path, log=logged.append)
    assert acc.apply("Купи молоко… и хлеб") == "Купи молоко… и хлеб"
    assert len(logged) == 1 and "ONNXRuntimeError" in logged[0]


def test_accentizer_does_not_load_unused_rule_engine(ruaccent, tmp_path):
    """RuleEngine RUAccent грузит, но process_all его не вызывает; это 0.87 ГБ из 1.77
    ГБ загрузки, на которых служба 23.09 не влезла в 3 ГБ — место Chatterbox."""
    f5_accent.Accentizer(tmp_path).load()
    assert FakeRuleEngine.created == 0


def test_unknown_word_gets_accent_under_transformers5(ruaccent, tmp_path):
    """Слово вне словаря идёт в ONNX-модель ударений, а та требует token_type_ids,
    которых токенизатор под transformers 5 не отдаёт. Раньше падение гасило
    ударения всей реплики — в подводке с редким именем артиста это обычное дело."""
    acc = f5_accent.Accentizer(tmp_path)
    assert acc.apply("Играет Бурдыкляндия") == "Играет Бурдыкл+яндия"
    (feed,) = acc._model.accent_model.session.feeds
    assert feed["token_type_ids"].tolist() == [[0, 0, 0]]
    assert acc._model.omograph_model.session.run.__func__ is FakeSession.run


def test_accentizer_skip_scan_is_linear(ruaccent, tmp_path):
    """Текст до 20000 символов без пробелов: квадратичный перебор начал слова
    держал бы замок RUAccent секундами."""
    text = "молоко " + "а" * 19000
    assert f5_accent.Accentizer(tmp_path).apply(text) == "молок+о " + "а" * 19000


def test_voice_is_capped_and_has_transcript(tmp_path):
    write_voice(tmp_path, "ru-host", tone(18.0))
    v = V.load_voices(tmp_path)["ru-host"]
    assert len(v.samples) / v.sr <= 12.06
    assert v.ref_text == "Эталонная фраза. "
    assert v.max_chars >= 20


def test_voice_without_transcript_refuses(tmp_path):
    write_voice(tmp_path, "ru-host", tone(3.0), text=None)
    with pytest.raises(ValueError, match="транскрипт"):
        V.load_voices(tmp_path)


def test_empty_voice_dir_refuses(tmp_path):
    with pytest.raises(ValueError):
        V.load_voices(tmp_path)


def test_silent_reference_refuses():
    with pytest.raises(ValueError, match="секунд"):
        V.voice_from_audio("clone", np.zeros(48000, np.float32), 24000, "текст")


def test_resolve_default_and_fallback(tmp_path):
    write_voice(tmp_path, "ru-host", tone(3.0))
    write_voice(tmp_path, "ru-voice-4", tone(3.0))
    voices = V.load_voices(tmp_path)
    assert V.resolve(voices, "", "ru-host")[1:] == (False, None)
    assert V.resolve(voices, None, "ru-host")[0].name == "ru-host"
    assert V.resolve(voices, "Alloy", "ru-host")[1:] == (False, None)
    assert V.resolve(voices, "ru-voice-4", "ru-host")[0].name == "ru-voice-4"
    voice, fell_back, reason = V.resolve(voices, "ru-rajt", "ru-host")
    assert voice.name == "ru-host" and fell_back and reason == 'unknown voice "ru-rajt"'


@pytest.mark.parametrize("junk", [5, ["ru-host"], {"name": "x"}], ids=["int", "list", "dict"])
def test_non_string_voice_falls_back(tmp_path, junk):
    """voice приходит из JSON клиента и может оказаться не строкой — это неизвестное
    имя, а не 500 до синтеза."""
    write_voice(tmp_path, "ru-host", tone(3.0))
    voice, fell_back, reason = V.resolve(V.load_voices(tmp_path), junk, "ru-host")
    assert voice.name == "ru-host" and fell_back
    assert reason.isascii() and reason.isprintable()


# ids обязательны: CR/LF в имени теста pytest отвергает
@pytest.mark.parametrize("typo", ["ru-rаit", "кг-кфше", "ru-ra\r\nit"],
                         ids=["homoglyph", "wrong-layout", "crlf"])
def test_fallback_reason_is_header_safe(tmp_path, typo):
    """Причина подмены едет в заголовке X-TTS-Fell-Back-Reason, а Starlette кодирует
    заголовки в latin-1: кириллица из чужой раскладки дала бы 500 вместо голоса по
    умолчанию — то самое молчание эфира, от которого подмена и заведена."""
    write_voice(tmp_path, "ru-host", tone(3.0))
    voice, fell_back, reason = V.resolve(V.load_voices(tmp_path), typo, "ru-host")
    assert voice.name == "ru-host" and fell_back
    assert reason.isascii() and reason.isprintable()


def test_voice_name_must_be_ascii(tmp_path):
    """Имя голоса едет в заголовке X-TTS-Voice-Used: голос с кириллицей в имени ронял
    бы в 500 каждый свой ответ — пусть лучше служба не стартует с понятной причиной."""
    write_voice(tmp_path, "ru-host", tone(3.0))
    write_voice(tmp_path, "Ведущая", tone(3.0))
    with pytest.raises(ValueError, match="Ведущая"):
        V.load_voices(tmp_path)
