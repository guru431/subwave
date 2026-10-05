"""tools/pronunciation.py: проверка транскрипций LLM и вывод словаря слов."""
import importlib.util
import json
import sys
from pathlib import Path

F5_DIR = Path(__file__).resolve().parent.parent / "tts-f5"
sys.path.insert(0, str(F5_DIR))
_spec = importlib.util.spec_from_file_location("f5_pronunciation",
                                               F5_DIR / "tools" / "pronunciation.py")
P = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(P)


def test_bad_transcriptions_are_named():
    assert P.problem("Д+айр Стр+ейтс") is None
    assert P.problem("лайв") is None                     # одна гласная — без «+»
    assert P.problem("Dire Стр+ейтс") == "осталась латиница"
    assert P.problem("Д+йр") == "«+» не перед гласной"
    assert P.problem("М+ет+аллика") == "два «+» в одном слове"
    assert P.problem("  ") == "пусто"


def test_mechanical_slips_are_tidied_before_the_check():
    assert P.tidy("Донт Стоп зэ М+ьюзик") == "Донт Стоп зэ Мь+юзик"
    assert P.tidy("Т+айлер,П+эрри") == "Т+айлер, П+эрри"
    assert P.tidy("Ту, 2,5") == "Ту, 2,5"                   # число с запятой не трогать
    assert P.problem(P.tidy("Р+уби Т+ьюздэй")) is None


def test_words_come_from_phrases_with_equal_word_counts():
    words = P.derive_words([("Dire Straits", "Д+айр Стр+ейтс"),
                            ("Sultans (Live)", "С+алтанз (лайв)"),
                            ("AC/DC", "эй-си-ди-с+и")])
    assert words == {"dire": "Д+айр", "straits": "Стр+ейтс", "sultans": "С+алтанз",
                     "live": "лайв", "ac/dc": "эй-си-ди-с+и"}


def test_unequal_word_counts_give_no_words():
    # «Blink-182» → «Блинк в+ан +эйти ту»: пословно не сопоставить
    assert P.derive_words([("Blink-182", "Блинк-в+ан-+эйти-ту фит")]) == {}


def test_most_common_reading_wins():
    words = P.derive_words([("Come Together", "Кам Туг+езер"),
                            ("Come As You Are", "Кам Эз Ю +Ар"),
                            ("Come Prima", "К+оме Пр+има")])
    assert words["come"] == "Кам"


def test_cyrillic_words_and_mixed_phrases_stay_out():
    # кириллицу RUAccent разметит раньше словаря, и совпасть она уже не сможет
    data_words = P.derive_words([("Шрамы (Tracktor Bowling)", "Шрамы (Тр+эктор Б+оулинг)")])
    assert data_words == {"tracktor": "Тр+эктор", "bowling": "Б+оулинг"}


def test_build_drops_what_fails_the_check(tmp_path):
    (tmp_path / "in-1.json").write_text(json.dumps([
        {"id": 0, "src": "Dire Straits", "ctx": "исполнитель"},
        {"id": 1, "src": "Queen", "ctx": "исполнитель"},
        {"id": 2, "src": "Sting", "ctx": "исполнитель"},
        {"id": 3, "src": "Шрамы (Tracktor Bowling)", "ctx": "песня"},
    ], ensure_ascii=False), encoding="utf-8")
    (tmp_path / "out-1.json").write_text(json.dumps([
        {"id": 0, "ru": "Д+айр Стр+ейтс"},
        {"id": 1, "ru": "Queen"},
        {"id": 3, "ru": "Шрамы (Тр+эктор Б+оулинг)"},
    ], ensure_ascii=False), encoding="utf-8")
    extra = tmp_path / "extra.json"
    extra.write_text(json.dumps({"_": "пояснение", "Sting": "Стинг"}, ensure_ascii=False),
                     encoding="utf-8")
    data, report = P.build(tmp_path, extra)
    # смешанная фраза — вне фраз; Sting без ответа LLM, но есть в ручном словаре
    assert data["phrases"] == {"dire straits": "Д+айр Стр+ейтс", "sting": "Стинг"}
    assert "bowling" in data["words"]
    assert len(report) == 2 and any("Queen" in r for r in report) \
        and any("нет ответа" in r for r in report)


def test_hand_entry_wins_over_the_llm(tmp_path):
    (tmp_path / "in-1.json").write_text(json.dumps([{"id": 0, "src": "Dire Straits"}]),
                                        encoding="utf-8")
    (tmp_path / "out-1.json").write_text(json.dumps([{"id": 0, "ru": "Д+ире Стр+аитс"}],
                                                    ensure_ascii=False), encoding="utf-8")
    extra = tmp_path / "extra.json"
    extra.write_text(json.dumps({"Dire Straits": "Дайр Стрейтс"}, ensure_ascii=False),
                     encoding="utf-8")
    assert P.build(tmp_path, extra)[0]["phrases"]["dire straits"] == "Дайр Стрейтс"


def test_broken_hand_entry_stops_the_build(tmp_path):
    # ручную запись пишут по жалобе: отбросить её молча значит потерять жалобу
    extra = tmp_path / "extra.json"
    extra.write_text(json.dumps({"Dire Straits": "Dire Стрейтс"}, ensure_ascii=False),
                     encoding="utf-8")
    import pytest
    with pytest.raises(SystemExit):
        P.build(tmp_path, extra)
