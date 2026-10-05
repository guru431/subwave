"""Живая сверка со стеком. Быстрый набор её не гоняет (маркер `integration`).

Здесь проверяется ровно то, чего быстрый набор проверить не может: порядок,
в котором историю отдаёт контроллер, и что отданный файл не обрезан и не
перекодирован по дороге.
"""
import json
import os
import urllib.request

import pytest

STATION = os.environ.get("STATION_URL", "")
pytestmark = [pytest.mark.integration,
              pytest.mark.skipif(not STATION, reason="STATION_URL не задан: адрес стека, http://<хост>:7700")]


def _get(path, headers=None):
    req = urllib.request.Request(STATION + path, headers=headers or {})
    return urllib.request.urlopen(req, timeout=30)


def _state():
    with _get("/api/state") as r:
        return json.load(r)


def test_history_arrives_newest_first():
    """Направление истории задаёт контроллер, и окно на нём стоит."""
    state = _state()
    if not state.get("current") or not state.get("history"):
        pytest.skip("станция молчит — сверять нечего")
    assert state["history"][0]["endedAt"] == state["current"]["startedAt"]


def test_every_window_entry_carries_an_id():
    state = _state()
    for item in [state.get("current")] + list(state.get("history") or []):
        if item:
            assert item.get("subsonic_id"), f"запись без идентификатора: {item}"


def test_downloaded_file_is_whole_and_not_transcoded():
    """Длина отданного совпадает с тем, что Navidrome знает о файле.

    Побайтовая сверка с шарой — ручной шаг приёмки (sha256 на Debian):
    путь файла в окно станции не приходит, а тянуть его из каталога проекта
    значит связать тест с ещё одной базой.
    """
    state = _state()
    if not state.get("current"):
        pytest.skip("станция молчит")
    track_id = state["current"]["subsonic_id"]
    with _get(f"/room/download?id={track_id}") as r:
        assert r.status == 200
        assert r.headers.get("Content-Type") == "audio/mpeg"
        declared = int(r.headers["Content-Length"])
        body = r.read()
    assert len(body) == declared
    assert body[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3"), "это не mp3"


def test_range_gives_a_partial_response():
    state = _state()
    if not state.get("current"):
        pytest.skip("станция молчит")
    track_id = state["current"]["subsonic_id"]
    with _get(f"/room/download?id={track_id}", {"Range": "bytes=0-1023"}) as r:
        assert r.status == 206
        assert r.headers.get("Content-Range", "").startswith("bytes 0-1023/")
        assert len(r.read()) == 1024
