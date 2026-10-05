"""subsonic.py: сверка заказа с коллекцией до того, как он уйдёт ведущему.

Нормализация — `norm()` проекта, не своя: иначе «есть ли такой трек» начнёт
отвечать по-разному в каталоге и в комнате.
"""
import importlib.util
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SUBSONIC = ROOT / "room" / "subsonic.py"
_spec = importlib.util.spec_from_file_location("room_subsonic", SUBSONIC)
sub = importlib.util.module_from_spec(_spec)
sys.modules["room_subsonic"] = sub
_spec.loader.exec_module(sub)

SONGS = [
    {"id": "a1", "title": "Звезда по имени Солнце", "artist": "Кино",
     "album": "Звезда по имени Солнце", "year": 1989, "duration": 224},
    {"id": "a2", "title": "Звезда", "artist": "Кино", "album": "Сборник",
     "year": 1990, "duration": 200},
    {"id": "a3", "title": "Song (Live)", "artist": "Band", "album": "Live",
     "year": 2001, "duration": 300},
]


def test_candidates_read_the_subsonic_envelope():
    payload = {"subsonic-response": {"status": "ok", "searchResult3": {"song": SONGS}}}
    got = sub.candidates(payload)
    assert [c["id"] for c in got] == ["a1", "a2", "a3"]
    assert got[0]["artist"] == "Кино" and got[0]["duration"] == 224


def test_empty_result_is_an_empty_list_not_an_error():
    payload = {"subsonic-response": {"status": "ok", "searchResult3": {}}}
    assert sub.candidates(payload) == []


def test_exact_needs_the_whole_artist_and_title():
    got = sub.match("Кино — Звезда по имени Солнце", SONGS)
    assert got["exact"]["id"] == "a1"


def test_exact_ignores_dash_style_and_case():
    # плеер отдаёт то, что набрал человек: тире, дефис, лишние пробелы
    for q in ("кино - звезда по имени солнце", "КИНО  —  Звезда по имени Солнце"):
        assert sub.match(q, SONGS)["exact"]["id"] == "a1", q


def test_title_only_query_is_not_exact():
    # «Звезда» — это и трек a2, и часть названия a1: угадывать за слушателя нечего
    got = sub.match("Звезда", SONGS)
    assert got["exact"] is None and [c["id"] for c in got["alternatives"]] == ["a1", "a2", "a3"]


def test_live_suffix_is_not_the_same_track():
    # norm() скобочный суффикс не снимает — правило проекта
    assert sub.match("Band — Song", SONGS)["exact"] is None


def test_alternatives_are_capped():
    many = [dict(SONGS[1], id=f"x{i}") for i in range(20)]
    assert len(sub.match("Кино", many)["alternatives"]) == 5


def test_nothing_found_is_an_honest_refusal():
    got = sub.match("Такого Нет", [])
    assert got == {"exact": None, "alternatives": []}


# Слушатель пишет «Включи …», а не «Артист — Название»: 42 заказа из журнала
# станции за 21–22.09 — почти все с командным словом. Navidrome ищет по всем
# словам запроса сразу, поэтому «включи» в строке обнуляет выдачу целиком.

def test_command_word_is_stripped_before_the_search():
    for q, want in (
        ("Включи Агата Кристи - На войне", "Агата Кристи - На войне"),
        ("поставь Колизей ария", "Колизей ария"),
        ("Включи группу Ленинград", "Ленинград"),
        ("включи песню Rammstein Du Hast", "Rammstein Du Hast"),
        ("Поставьте, пожалуйста, Кино", "Кино"),
        ("play Rammstein", "Rammstein"),
    ):
        assert sub.strip_command(q) == want, q


def test_a_bare_request_is_left_alone():
    # «Пой» — название трека, а не команда: срезаем только служебное начало
    for q in ("Кино — Звезда по имени Солнце", "Ленинград", "Пой"):
        assert sub.strip_command(q) == q, q


def test_command_only_query_keeps_its_word():
    # «Поставь» целиком — искать нечего, но и пустой запрос слать в Navidrome
    # незачем: пусть уходит как есть и честно не находится
    assert sub.strip_command("Поставь") == "Поставь"


def test_command_in_the_middle_gives_the_tail():
    # «Передай привет Диме Ефимову, поставь песню Прыгну со скалы» — реальный
    # заказ: команда не в начале, а песня в коллекции есть
    assert sub.tail_after_command(
        "Передай привет Диме Ефимову, поставь песню Прыгну со скалы") == "Прыгну со скалы"
    assert sub.tail_after_command("Димка, включи Кино - Звезда") == "Кино - Звезда"


def test_no_command_in_the_middle_means_no_second_try():
    for q in ("Агата Кристи - Как на войне", "Включи Кино", "Поставь"):
        assert sub.tail_after_command(q) is None, q


def test_resolve_retries_with_the_tail_when_the_first_try_is_empty(monkeypatch):
    asked = []

    class FakeResponse:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    hit = ('{"subsonic-response": {"status": "ok", "searchResult3": {"song": ['
           '{"id": "e1", "title": "Прыгну со скалы", "artist": "Король и Шут"}]}}}')

    def fake_urlopen(url, timeout=None):
        query = sub.urllib.parse.parse_qs(url.split("?", 1)[1])["query"][0]
        asked.append(query)
        empty = '{"subsonic-response": {"status": "ok", "searchResult3": {}}}'
        return FakeResponse((hit if query == "Прыгну со скалы" else empty).encode())

    monkeypatch.setattr(sub.urllib.request, "urlopen", fake_urlopen)
    got = sub.resolve("Передай привет Диме, поставь песню Прыгну со скалы",
                      "http://nav", "u", "p")
    assert asked == ["Передай привет Диме, поставь песню Прыгну со скалы",
                     "Прыгну со скалы"]
    assert got["exact"]["id"] == "e1"


def test_attempts_shed_the_trailing_greeting():
    # «поставь rammstein и передай привет Дмитрию Ефимову» — реальный заказ:
    # название есть, но приписка обнуляет поиск по всем словам сразу
    tries = [q for q, _ in sub.search_attempts("поставь rammstein и передай привет Диме")]
    assert tries[0] == "rammstein и передай привет Диме"
    assert tries[-1] == "rammstein"


def test_attempts_try_the_stem_for_russian_cases():
    # «поставь чичерину» — винительный падеж, и в коллекции такого слова нет;
    # Navidrome ищет по началу слова, поэтому «чичерин» находит «Чичерину»
    tries = [q for q, _ in sub.search_attempts("поставь чичерину")]
    assert "чичерин" in tries
    stems = [q for q, _ in sub.search_attempts("включи агату кристи")]
    assert "агат крист" in stems


def test_the_stem_attempt_is_a_hint_not_an_answer():
    # усечённое слово — уже не то, что набрал слушатель
    for query, exactable in sub.search_attempts("поставь чичерину"):
        if query == "чичерин":
            assert exactable is False
            break
    else:
        raise AssertionError("основа не предлагалась вовсе")


def test_latin_and_short_words_keep_their_endings():
    # у английского падежей нет, а короткое слово усечение превращает в мусор
    words = {w for q, _ in sub.search_attempts("включи Rammstein Du Hast")
             for w in q.split()}
    assert "Rammstei" not in words and "Rammstein" in words
    short = {w for q, _ in sub.search_attempts("включи Кино") for w in q.split()}
    assert "Ки" not in short and "Кино" in short


def test_attempts_are_few_enough_for_a_keystroke():
    # ящик заказа спрашивает сверку на каждой паузе в наборе, и каждый заход —
    # отдельный поход в Navidrome: длинная фраза не должна стоить их десяток
    long_ask = "поставь rammstein и передай привет Дмитрию Ефимову ака Архитектору"
    tries = list(sub.search_attempts(long_ask))
    assert len(tries) <= sub.MAX_ATTEMPTS
    assert tries[-1][0] == "rammstein"


def test_attempts_do_not_shrink_to_a_meaningless_word():
    # «The» нашёл бы половину коллекции и выдал мусор за подсказку
    tries = [q for q, _ in sub.search_attempts("включи The Lonely Shepherd")]
    assert "The" not in tries


def test_attempts_start_with_the_whole_ask():
    # сокращение — запасной путь, а не первый: точный запрос пробуется первым
    tries = [q for q, _ in sub.search_attempts("Включи Агата Кристи - На войне")]
    assert tries[0] == "Агата Кристи - На войне"


def test_resolve_stops_at_the_first_attempt_that_finds_something(monkeypatch):
    asked = []
    hit = ('{"subsonic-response": {"status": "ok", "searchResult3": {"song": ['
           '{"id": "f1", "title": "Engel", "artist": "Rammstein"},'
           '{"id": "f2", "title": "Sonne", "artist": "Rammstein"}]}}}')

    class FakeResponse:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, timeout=None):
        query = sub.urllib.parse.parse_qs(url.split("?", 1)[1])["query"][0]
        asked.append(query)
        empty = '{"subsonic-response": {"status": "ok", "searchResult3": {}}}'
        return FakeResponse((hit if query == "rammstein" else empty).encode())

    monkeypatch.setattr(sub.urllib.request, "urlopen", fake_urlopen)
    got = sub.resolve("поставь rammstein и передай привет Диме", "http://nav", "u", "p")
    assert asked[-1] == "rammstein"
    assert [c["id"] for c in got["alternatives"]] == ["f1", "f2"]


def test_a_shortened_query_never_claims_an_exact_match(monkeypatch):
    # «Включи Сектор Газа Гуляй мужик» сокращается до «Сектор Газа», и
    # единственный трек группы — «Демобилизация», то есть не то, что просили.
    # Объявить это точным совпадением значит отправить в эфир чужую песню с
    # видом уверенности: обрезанный запрос даёт подсказку, а не ответ.
    hit = ('{"subsonic-response": {"status": "ok", "searchResult3": {"song": ['
           '{"id": "g1", "title": "Демобилизация", "artist": "Сектор Газа"}]}}}')

    class FakeResponse:
        def __init__(self, body):
            self._body = body

        def read(self):
            return self._body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, timeout=None):
        query = sub.urllib.parse.parse_qs(url.split("?", 1)[1])["query"][0]
        empty = '{"subsonic-response": {"status": "ok", "searchResult3": {}}}'
        return FakeResponse((hit if query == "Сектор Газа" else empty).encode())

    monkeypatch.setattr(sub.urllib.request, "urlopen", fake_urlopen)
    got = sub.resolve("Включи Сектор Газа Гуляй мужик", "http://nav", "u", "p")
    assert got["exact"] is None
    assert [c["id"] for c in got["alternatives"]] == ["g1"]


def test_attempts_say_which_ones_may_be_exact():
    # снятие команды заказ не урезает — такой заход вправе дать точный ответ;
    # обрезанный с конца — уже догадка
    tries = list(sub.search_attempts("поставь Кино Звезда по имени Солнце"))
    assert tries[0] == ("Кино Звезда по имени Солнце", True)
    assert all(exactable is False for _, exactable in tries[1:])


def test_single_candidate_covering_the_query_is_exact():
    # «На войне» — это «Как на войне», и кандидат ровно один: угадывать нечего
    songs = [{"id": "b1", "title": "Как на войне", "artist": "Агата Кристи",
              "album": "Опиум", "year": 1995, "duration": 240}]
    assert sub.match("Агата Кристи - На войне", songs)["exact"]["id"] == "b1"


def test_partial_title_with_several_candidates_stays_a_choice():
    songs = [
        {"id": "c1", "title": "Вечно молодой", "artist": "Смысловые Галлюцинации",
         "album": "3000", "year": 2000, "duration": 250},
        {"id": "c2", "title": "Вечно молодой (акустика)", "artist": "Смысловые Галлюцинации",
         "album": "Акустика", "year": 2005, "duration": 260},
    ]
    got = sub.match("Смысловые Галлюцинации - молодой", songs)
    assert got["exact"] is None and len(got["alternatives"]) == 2


def test_lone_candidate_differing_only_by_bracket_suffix_is_not_exact():
    # правило проекта: `Song (Live)` и `Song` — разные записи, и единственность
    # кандидата этого не отменяет
    songs = [SONGS[2]]
    assert sub.match("Band — Song", songs)["exact"] is None


def test_lone_candidate_that_does_not_cover_the_query_is_not_exact():
    # поиск отдал единственный трек артиста, а спрашивали про другую песню
    songs = [{"id": "d1", "title": "Демобилизация", "artist": "Сектор Газа",
              "album": "Ночь перед Рождеством", "year": 1991, "duration": 200}]
    got = sub.match("Сектор Газа - Гуляй мужик", songs)
    assert got["exact"] is None and [c["id"] for c in got["alternatives"]] == ["d1"]


def test_resolve_asks_navidrome_without_the_command_word(monkeypatch):
    asked = []

    class FakeResponse:
        def read(self):
            return b'{"subsonic-response": {"status": "ok", "searchResult3": {"song": []}}}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def fake_urlopen(url, timeout=None):
        asked.append(sub.urllib.parse.parse_qs(url.split("?", 1)[1])["query"][0])
        return FakeResponse()

    monkeypatch.setattr(sub.urllib.request, "urlopen", fake_urlopen)
    sub.resolve("Включи Агата Кристи - На войне", "http://nav", "u", "p")
    # первым уходит точный запрос; всё, что после, — запасные заходы по пустой
    # выдаче, и командного слова нет ни в одном
    assert asked[0] == "Агата Кристи - На войне"
    assert not any("Включи" in q for q in asked)


def test_resolve_without_navidrome_does_not_leak_credentials(monkeypatch):
    # Без адреса urllib уронил бы ValueError с полным URL — токеном и солью
    def fake_urlopen(url, timeout=None):
        raise AssertionError("без адреса в сеть не ходят")

    monkeypatch.setattr(sub.urllib.request, "urlopen", fake_urlopen)
    with pytest.raises(ValueError) as err:
        sub.resolve("Кино — Звезда", "", "u", "s3cret")
    assert "t=" not in str(err.value) and "s=" not in str(err.value)


@pytest.mark.integration
def test_resolve_hits_the_live_navidrome():
    base = os.environ.get("NAVIDROME_URL")
    user = os.environ.get("NAVIDROME_ADMIN_USER")
    password = os.environ.get("NAVIDROME_ADMIN_PASS")
    if not (base and user and password):
        pytest.skip("нет адреса или учётки Navidrome в окружении")
    got = sub.resolve("Depeche Mode — It's No Good", base, user, password)
    assert got["exact"] or got["alternatives"]
