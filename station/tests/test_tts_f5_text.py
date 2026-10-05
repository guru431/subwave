"""f5_text: ударения, транскрипт эталона и нарезка по пределу F5.

Нарезка повторяет chunk_text из f5-tts 1.1.22 — ожидаемые ответы UPSTREAM сняты
с настоящей функции 2026-09-23 на тех же входах. Отличие одно и проверено отдельно:
отрезок длиннее предела дорезается по словам — штатная функция отдаёт его целиком,
и F5 на таком куске комкает окончание.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
import f5_text as T  # noqa: E402

PODVODKA = ("Добрый вечер. Это AI радио, и рядом со мной та самая коллекция, "
            "которую собирали годами. Только что отзвучали Dire Straits — "
            "«Brothers in Arms». Дальше поставлю Кино, «Звезда по имени Солнце», "
            "восемьдесят девятый год. А потом будет потише, обещаю.")

UPSTREAM = [
    (PODVODKA, 180, [
        "Добрый вечер. Это AI радио, и рядом со мной та самая коллекция, "
        "которую собирали годами.",
        "Только что отзвучали Dire Straits — «Brothers in Arms». Дальше поставлю "
        "Кино, «Звезда по имени Солнце»,",
        "восемьдесят девятый год. А потом будет потише, обещаю.",
    ]),
    ("Раз. Два. Три. Четыре!", 100, ["Раз. Два. Три. Четыре!"]),
]


@pytest.mark.parametrize("text,limit,expected", UPSTREAM, ids=["podvodka", "short"])
def test_chunks_match_upstream_chunk_text(text, limit, expected):
    assert T.chunk(text, limit) == expected


def test_overlong_sentence_is_split_by_words_keeping_marks():
    """Штатный chunk_text на этом входе отдал третьим куском все 66 байт при пределе
    60 (замер 2026-09-23). Здесь отрезок дорезается по словам, знаки '+' целы."""
    text = "Д+обрый в+ечер. +Это дом+ашнее р+адио, и р+ядом со мн+ой та с+амая колл+екция."
    assert T.chunk(text, 60) == [
        "Д+обрый в+ечер.",
        "+Это дом+ашнее р+адио,",
        "и р+ядом со мн+ой та с+амая",
        "колл+екция.",
    ]


def test_run_without_punctuation_is_split_by_words():
    text = " ".join(["слово"] * 40)
    chunks = T.chunk(text, 60)
    assert len(chunks) > 1
    assert all(len(c.encode("utf-8")) <= 60 for c in chunks)
    assert " ".join(chunks).split() == text.split()


def test_word_pieces_are_not_glued():
    """Штатный chunk_text не ставит пробел за кириллической буквой: у него так
    кончается только последний кусок. Дорезанные по словам куски кончаются буквой
    всегда, и при склейке без пробела вышло бы «словотри» (54 + 6 = ровно 60)."""
    assert T.chunk("слово слово слово слово слово три", 60) == [
        "слово слово слово слово слово", "три"]


def test_stress_marks_are_plus_before_a_vowel():
    assert T.has_stress_marks("м+олоко") and T.has_stress_marks("+Это")
    assert not T.has_stress_marks("C++ и A+B")
    assert not T.has_stress_marks("молоко")


def test_ref_text_ends_with_period_and_space():
    assert T.normalize_ref_text("  текст ") == "текст. "
    assert T.normalize_ref_text("текст.") == "текст. "


def test_max_chars_formula_and_bounds():
    ref = "а" * 75                                 # 150 байт UTF-8
    assert T.max_chars(ref, 10.0) == int(150 / 10 * 12)
    assert T.max_chars("а", 11.9) == T.MIN_MAX_CHARS
    with pytest.raises(ValueError):
        T.max_chars(ref, 22.0)


def test_ai_is_read_the_russian_way():
    """ESpeech прочла «AI» как «ААЭ» (whisper на образце 2026-09-23); по-русски — «эй ай».
    А это имя станции: ведущая говорит его постоянно."""
    assert T.respell("Это «AI радио».") == "Это «эй ай радио»."
    assert T.respell("AI-радио, AI.") == "эй ай-радио, эй ай."


def test_metallica_is_respelled_for_the_stress_dictionary():
    """Латиница идёт к F5 без знака ударения; «Metallica» в начале куска F5 читал
    с ударением не туда. Кириллицей она попадает в поправки ударений f5_accent."""
    assert T.respell("а есть Metallica.") == "а есть Металлика."


def test_units_split_sentences_and_strong_clauses_not_commas():
    """F5 сам решает, где дышать внутри куска, и запятые выходили от 40 до 330 мс,
    двоеточие — 50 (эфир 2026-09-23). Поэтому единицы — предложения и части по
    двоеточию и тире; запятые не режутся, иначе рубленая интонация."""
    text = ("Три часа дня — у кого-то рабочий отрезок на спаде, у кого-то дорога. "
            "Глушите уведомления и слушаем.")
    assert T.units(text) == [
        ("Три часа дня", T.PAUSE_CLAUSE_MS),
        ("— у кого-то рабочий отрезок на спаде, у кого-то дорога.", T.PAUSE_SENTENCE_MS),
        ("Глушите уведомления и слушаем.", 0),
    ]


def test_short_clause_sticks_to_its_neighbour():
    """«в ритм.» отдельно F5 скомкал бы: короткие фразы теряют окончания."""
    assert T.units("куда её девать: в ритм. Дальше.") == [
        ("куда её девать: в ритм.", T.PAUSE_SENTENCE_MS),
        ("Дальше.", 0),
    ]


def test_sentence_end_after_closing_quote():
    assert [u for u, _ in T.units("Поставлю «Кино». Слушаем!")] == ["Поставлю «Кино».", "Слушаем!"]
    assert [u for u, _ in T.units("Он сказал: «Привет.» Дальше тишина.")] == [
        "Он сказал: «Привет.»", "Дальше тишина."]


def test_long_unit_is_cut_by_the_f5_limit_with_a_comma_pause():
    text = "Раз, два, три, четыре, пять, шесть, семь."
    got = T.pieces(text, 20)
    assert len(got) > 1 and all(len(p.encode("utf-8")) <= 20 for p, _ in got)
    assert got[0][1] == T.PAUSE_COMMA_MS and got[-1][1] == 0


def test_respell_touches_only_whole_words():
    text = "RAID, MAIN и AIDS, Thai, ai"
    assert T.respell(text) == text


@pytest.fixture
def dictionary(monkeypatch):
    """Малый словарь вместо собранного: проверяется подстановка, а не данные."""
    d = {"dire": "д+айр", "dire straits": "Д+айр Стр+ейтс", "straits": "стр+ейтс",
         "don't stop me now": "Д+онт Стоп Ми Н+ау", "ac/dc": "эй-си-ди-с+и",
         "live": "лайв", "sting": "Стинг"}
    monkeypatch.setattr(T, "DICTIONARY", d)
    monkeypatch.setattr(T, "_DICTIONARY", T._dictionary_pattern(d))
    return d


def test_phrase_wins_over_its_words(dictionary):
    assert T.cyrillize("Только что отзвучали Dire Straits.") == \
        "Только что отзвучали Д+айр Стр+ейтс."


def test_case_apostrophe_and_spaces_do_not_matter(dictionary):
    assert T.cyrillize("«DON’T  stop me NOW»") == "«Д+онт Стоп Ми Н+ау»"


def test_word_outside_a_known_phrase_comes_from_the_word_dictionary(dictionary):
    assert T.cyrillize("Straits, (Live)") == "стр+ейтс, (лайв)"


def test_only_whole_latin_words_are_replaced(dictionary):
    # «Sting» внутри «Stingray» и «live» внутри «Oliver» — не они
    text = "Stingray, Oliver, AC/DC5"
    assert T.cyrillize(text) == text
    assert T.cyrillize("это AC/DC") == "это эй-си-ди-с+и"


def test_text_without_latin_is_untouched(dictionary):
    assert T.cyrillize("Кино, «Звезда по имени Солнце»") == "Кино, «Звезда по имени Солнце»"


def test_empty_dictionary_changes_nothing(monkeypatch):
    # пустая альтернатива в regex совпала бы с каждой позицией строки
    monkeypatch.setattr(T, "DICTIONARY", {})
    monkeypatch.setattr(T, "_DICTIONARY", T._dictionary_pattern({}))
    assert T.cyrillize("Dire Straits") == "Dire Straits"


def test_shipped_dictionary_covers_the_complaints_and_is_well_formed():
    # жалобы 23.09: «Востинг Майхэд» и «Даррис Тредс»
    import importlib.util
    tool = Path(__file__).resolve().parent.parent / "tts-f5" / "tools" / "pronunciation.py"
    spec = importlib.util.spec_from_file_location("f5_pronunciation", tool)
    P = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(P)
    d = T.load_dictionary(T.DICTIONARY_FILE)
    assert "dire straits" in d and "wasting my hate" in d
    assert [k for k, v in d.items() if P.problem(v)] == []
    assert not any(ch.isupper() for k in d for ch in k)          # ключи — dictionary_key
