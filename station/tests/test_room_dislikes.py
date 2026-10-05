"""dislikes.py: цель отметки, отметки плеера и сводка в предложения.

Функции чистые — ни базы, ни сети; время приходит готовыми строками в том же
формате, в котором его пишет store.py (ISO с миллисекундами, UTC).
"""
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    path = ROOT / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"room_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


dislikes = _load("dislikes")


def T(minute: int) -> str:
    """Время вклада: T(5) — 12:05 того же дня, в формате store.py."""
    return f"2026-09-24T12:{minute:02d}:00.000+00:00"


def row(listener, kind, song_id, artist="Кино", at=None, name="", title="Звезда"):
    """Строка таблицы dislikes — как её отдаёт Store.all_dislikes()."""
    key = dislikes.artist_key(artist)
    return {"listener_id": listener, "name": name, "kind": kind,
            "target": song_id if kind == "track" else key, "artist_key": key,
            "song_id": song_id, "title": title, "artist": artist,
            "album": "Звезда по имени Солнце", "at": at or T(0)}


def test_track_target_is_the_song_id():
    assert dislikes.target_of("track", "s1", "Кино") == "s1"


def test_artist_target_is_the_normalised_name():
    assert dislikes.target_of("artist", "s1", "Агата Кристи") == "агата кристи"


def test_nameless_track_has_no_artist_target():
    assert dislikes.target_of("artist", "s1", "") is None
    assert dislikes.target_of("artist", "s1", None) is None
    assert dislikes.target_of("track", "s1", None) == "s1"


def test_spelling_variants_are_one_artist():
    # Review Focus 1: регистр, ё/е и пунктуация не делят исполнителя надвое
    assert dislikes.artist_key("Ёлка") == dislikes.artist_key("елка")
    assert dislikes.artist_key("AC/DC") == dislikes.artist_key("ac dc")
    got = dislikes.suggestions([row("l1", "track", "s1", artist="Ёлка"),
                                row("l2", "track", "s2", artist="Елка")], {})
    assert [(a["key"], a["songs"]) for a in got["artists"]] == [("елка", 2)]


def test_marks_cover_the_song_and_every_song_of_the_artist():
    window = {"s1": {"artist": "Кино"}, "s2": {"artist": "КИНО"},
              "s3": {"artist": "Ария"}}
    mine = [{"kind": "track", "target": "s1"}, {"kind": "artist", "target": "кино"}]
    assert dislikes.marks_for(window, mine) == {
        "s1": {"track": True, "artist": True},
        "s2": {"track": False, "artist": True},
    }


def test_nameless_song_is_never_marked_by_an_artist_dislike():
    assert dislikes.marks_for({"s1": {"artist": ""}},
                              [{"kind": "artist", "target": ""}]) == {}


def test_track_is_suggested_from_the_first_dislike():
    got = dislikes.suggestions([row("l1-abcdef", "track", "s1", name="Маша")], {})
    assert [t["key"] for t in got["tracks"]] == ["s1"]
    assert got["tracks"][0]["listeners"] == [{"name": "Маша", "tag": "l1-a"}]
    assert got["artists"] == []


def test_two_songs_make_an_artist_suggestion():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l2", "track", "s2")], {})
    artist = got["artists"][0]
    assert (artist["key"], artist["songs"], artist["explicit"]) == ("кино", 2, 0)
    assert len(artist["listeners"]) == 2


def test_one_song_twice_is_still_one_song():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l2", "track", "s1")], {})
    assert got["artists"] == []


def test_explicit_artist_dislike_is_enough():
    got = dislikes.suggestions([row("l1", "artist", "s1")], {})
    artist = got["artists"][0]
    assert (artist["explicit"], artist["songs"]) == (1, 0)
    assert got["tracks"] == []


def test_same_listener_counts_once():
    got = dislikes.suggestions([row("l1", "track", "s1"), row("l1", "track", "s2")], {})
    assert len(got["artists"][0]["listeners"]) == 1


def test_latest_contribution_is_the_representative():
    got = dislikes.suggestions([row("l1", "track", "s1", at=T(1), title="Звезда"),
                                row("l2", "track", "s2", at=T(5), title="Кукушка")], {})
    artist = got["artists"][0]
    assert (artist["songId"], artist["title"], artist["lastAt"]) == ("s2", "Кукушка", T(5))


def test_names_follow_the_first_contribution():
    got = dislikes.suggestions([row("l1", "track", "s1", at=T(2), name="Маша"),
                                row("l2", "track", "s1", at=T(1), name="Дима")], {})
    assert [x["name"] for x in got["tracks"][0]["listeners"]] == ["Дима", "Маша"]


def test_decision_hides_until_a_strictly_newer_dislike():
    # Review Focus 3: решение в ту же миллисекунду, что последний дизлайк, прячет
    rows = [row("l1", "track", "s1", at=T(5))]
    assert dislikes.suggestions(rows, {("track", "s1"): T(5)})["tracks"] == []
    assert dislikes.suggestions(rows, {("track", "s1"): T(6)})["tracks"] == []
    assert len(dislikes.suggestions(rows, {("track", "s1"): T(4)})["tracks"]) == 1


def test_new_song_dislike_reopens_a_kept_artist():
    decided = {("artist", "кино"): T(5)}
    rows = [row("l1", "track", "s1", at=T(1)), row("l2", "track", "s2", at=T(2))]
    assert dislikes.suggestions(rows, decided)["artists"] == []
    rows.append(row("l3", "track", "s3", at=T(6)))
    assert len(dislikes.suggestions(rows, decided)["artists"]) == 1


def test_decision_on_the_artist_leaves_its_songs_alone():
    rows = [row("l1", "track", "s1"), row("l2", "track", "s2")]
    got = dislikes.suggestions(rows, {("artist", "кино"): T(9)})
    assert got["artists"] == [] and len(got["tracks"]) == 2


def test_more_listeners_first_then_fresher():
    rows = [row("a", "track", "s1", at=T(1)), row("b", "track", "s1", at=T(1)),
            row("c", "track", "s2", at=T(9)), row("d", "track", "s3", at=T(5))]
    assert [t["key"] for t in dislikes.suggestions(rows, {})["tracks"]] == ["s1", "s2", "s3"]


def test_limit_applies_to_each_group():
    rows = [row(f"l{i}", "track", f"s{i}", artist=f"Группа {i}") for i in range(5)]
    assert len(dislikes.suggestions(rows, {}, limit=2)["tracks"]) == 2


def test_nameless_songs_never_become_an_artist_suggestion():
    # Review Focus 2: два трека без исполнителя — не «исполнитель с пустым именем»
    got = dislikes.suggestions([row("l1", "track", "s1", artist=""),
                                row("l2", "track", "s2", artist="")], {})
    assert got["artists"] == [] and len(got["tracks"]) == 2
