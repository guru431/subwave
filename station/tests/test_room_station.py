"""station.py: окно станции — что сейчас звучит и что уже прозвучало.

Контроллер подделан на уровне urlopen: своей сети тест не трогает.
"""
import importlib.util
import json
import sys
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    path = ROOT / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"room_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


station = _load("station")


class FakeResponse:
    def __init__(self, payload):
        self._body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    def read(self):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def _state(current=None, history=(), upcoming=()):
    return {"current": current, "history": list(history), "upcoming": list(upcoming)}


def _track(sid, artist="A", title="T"):
    return {"subsonic_id": sid, "artist": artist, "title": title}


@pytest.fixture
def asked(monkeypatch):
    urls = []
    payload = {"value": _state()}

    def fake_urlopen(url, timeout=None):
        urls.append(url if isinstance(url, str) else url.full_url)
        return FakeResponse(payload["value"])

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return urls, payload


def test_window_holds_current_and_all_history(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur"),
                              history=[_track(f"h{i}") for i in range(50)])
    win = station.window("http://controller:7701")
    assert set(win) == {"cur"} | {f"h{i}" for i in range(50)}


def test_window_carries_artist_and_title_for_the_filename(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur", "Ария", "Улица Роз"))
    assert station.window("http://controller:7701")["cur"] == {
        "artist": "Ария", "title": "Улица Роз", "album": None}


def test_window_carries_the_album(asked):
    # альбом нужен дизлайкам: по нему админка отсеивает заблокированные альбомы
    _, payload = asked
    payload["value"] = _state(current={**_track("cur"), "album": "Опиум"})
    assert station.window("http://controller:7701")["cur"]["album"] == "Опиум"


def test_upcoming_is_not_in_the_window(asked):
    # Трек, который ещё не звучал, не «прозвучавший». Слить три списка одним
    # проходом по snapshot — самая естественная ошибка здесь.
    _, payload = asked
    payload["value"] = _state(current=_track("cur"), upcoming=[_track("next")])
    assert "next" not in station.window("http://controller:7701")


def test_short_history_is_not_a_failure(asked):
    # После рестарта контроллера история короткая — это не отказ.
    _, payload = asked
    payload["value"] = _state(current=_track("cur"), history=[_track("h0")])
    assert set(station.window("http://controller:7701")) == {"cur", "h0"}


def test_silent_station_gives_an_empty_window_not_a_crash(asked):
    # current == null бывает на свежем старте (streamIdle).
    _, payload = asked
    payload["value"] = _state(current=None, history=[])
    assert station.window("http://controller:7701") == {}


def test_entries_without_an_id_are_skipped(asked):
    _, payload = asked
    payload["value"] = _state(current=_track("cur"),
                              history=[{"artist": "X", "title": "Y"}])
    assert set(station.window("http://controller:7701")) == {"cur"}


def test_newest_wins_when_a_track_repeats(asked):
    _, payload = asked
    payload["value"] = _state(current=None,
                              history=[_track("same", "новое", "новое"),
                                       _track("same", "старое", "старое")])
    assert station.window("http://controller:7701")["same"]["artist"] == "новое"


def test_url_has_no_api_prefix(asked):
    # Внутри сети стека контроллер отвечает на /state: префикс /api снимает
    # handle_path в Caddy, и снаружи его добавляет тоже он.
    urls, _ = asked
    station.window("http://controller:7701/")
    assert urls == ["http://controller:7701/state"]


def test_empty_address_is_a_configuration_error(asked):
    with pytest.raises(RuntimeError):
        station.window("")


def test_garbage_answer_is_an_error_not_an_empty_window(asked, monkeypatch):
    # Пустое окно означает «скачивать нечего», а неразобранный ответ —
    # «спросить не удалось». Это разные ответы слушателю (403 против 502).
    class Garbage:
        def read(self):
            return b"<html>gateway</html>"

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    monkeypatch.setattr(urllib.request, "urlopen", lambda url, timeout=None: Garbage())
    with pytest.raises(ValueError):
        station.window("http://controller:7701")
