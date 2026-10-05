"""naming.py: имя скачиваемого файла и заголовок Content-Disposition.

Чистый модуль, сети нет — тест быстрый по построению.
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


naming = _load("naming")


def test_plain_name_is_artist_dash_title():
    assert naming.filename("Ария", "Улица Роз") == "Ария — Улица Роз.mp3"


def test_slash_in_artist_becomes_a_space():
    # В коллекции 45 таких треков: AC/DC. Слеш — разделитель пути на всех
    # трёх системах, подставлять его в имя нельзя.
    assert naming.filename("AC/DC", "Highway To Hell") == "AC DC — Highway To Hell.mp3"


def test_question_mark_and_quote_are_dropped():
    # 22 трека с «?» и столько же с «:» — запреты Windows, которые ловятся
    # только на чужой машине, если их не снять здесь.
    assert (naming.filename("Enrique Iglesias", 'Do You Know? "The Ping Pong Song"')
            == "Enrique Iglesias — Do You Know The Ping Pong Song.mp3")


def test_missing_artist_leaves_just_the_title():
    # 57 треков коллекции имеют пустой artist или title.
    assert naming.filename(None, "Антошка") == "Антошка.mp3"


def test_name_without_letters_or_digits_falls_back():
    # «★ — ★» после чистки даёт «- », формально непустое и бессмысленное:
    # поэтому проверяется наличие alnum, а не непустота.
    assert naming.filename("★", "★") == "track.mp3"
    assert naming.filename(None, None) == "track.mp3"


def test_trailing_dot_is_cut_from_the_stem_not_the_name():
    # 27 названий кончаются точкой. Чистить надо основу: по полному имени
    # rstrip(" .") не сработает никогда — там уже .mp3.
    assert naming.filename("Система", "B.Y.O.B.") == "Система — B.Y.O.B.mp3"


def test_windows_reserved_name_is_defused():
    assert naming.filename("CON", None) == "CON_.mp3"


def test_long_name_is_truncated_by_the_stem():
    long_title = "а" * 300
    name = naming.filename("Кто-то", long_title)
    assert name.endswith(".mp3")
    assert len(name) - len(".mp3") <= naming.STEM_MAX


def test_extension_comes_from_the_caller():
    assert naming.filename("X", "Y", "flac") == "X — Y.flac"


def test_disposition_carries_both_rfc6266_forms():
    value = naming.disposition("Ария — Улица Роз.mp3")
    assert 'filename="Ariya - Ulitsa Roz.mp3"' in value
    assert ("filename*=UTF-8''%D0%90%D1%80%D0%B8%D1%8F%20%E2%80%94"
            "%20%D0%A3%D0%BB%D0%B8%D1%86%D0%B0%20%D0%A0%D0%BE%D0%B7.mp3") in value
    assert value.startswith("attachment; ")


def test_disposition_is_latin1_encodable():
    # send_header кодирует значение latin-1 strict: кириллица роняет
    # обработчик ДО записи в сокет, то есть обрывом, а не кракозябрами.
    naming.disposition("Ария — Улица Роз.mp3").encode("latin-1")
    naming.disposition("трек уже не в эфире.txt").encode("latin-1")


def test_control_characters_from_the_tag_do_not_reach_the_header():
    # send_header пишет значение как есть: CR/LF из тега разбили бы ответ, а
    # DEL — управляющий символ, недопустимый в значении заголовка.
    for title in ("Song\r\nSet-Cookie: x=1", "A\x7fB"):
        value = naming.disposition(naming.filename("Artist", title))
        assert not {"\r", "\n", "\x7f"} & set(value)


def test_ascii_fallback_never_carries_percent_signs():
    # Safari percent-escapes в простом filename не декодирует и показывает
    # их буквально — поэтому запаска обязана быть чистой.
    value = naming.disposition("Ария — Улица Роз.mp3")
    ascii_part = value.split('filename="')[1].split('"')[0]
    assert "%" not in ascii_part


def test_extension_is_read_from_navidrome_header():
    assert naming.ext_from_disposition('attachment; filename="Ich Will.mp3"') == "mp3"
    assert naming.ext_from_disposition('attachment; filename="track.flac"') == "flac"


def test_extension_survives_navidrome_mojibake():
    # Для кириллицы Navidrome шлёт сырые UTF-8 байты в latin-1-заголовке.
    mojibake = 'attachment; filename="Ð£Ð»Ð¸Ñ†Ð° Ñ€Ð¾Ð·.mp3"'
    assert naming.ext_from_disposition(mojibake) == "mp3"


def test_extension_falls_back_when_absent_or_implausible():
    assert naming.ext_from_disposition(None) == "mp3"
    assert naming.ext_from_disposition("attachment") == "mp3"
    assert naming.ext_from_disposition('attachment; filename="no-extension"') == "mp3"
    assert naming.ext_from_disposition('attachment; filename="x.verylongext"') == "mp3"


def test_extension_must_be_audio_not_just_alphanumeric():
    # Navidrome не экранирует кавычку из тега: название `Song.hta"; x="`
    # подсовывает разбору расширение `hta`, и имя уехало бы исполняемым.
    assert naming.ext_from_disposition('attachment; filename="Song.hta"; x=".mp3"') == "mp3"
    assert naming.ext_from_disposition("attachment; filename*=UTF-8''b.bat") == "mp3"
    assert naming.ext_from_disposition('attachment; filename="track.flac"') == "flac"
    assert naming.ext_from_disposition('attachment; filename="TRACK.FLAC"') == "flac"
