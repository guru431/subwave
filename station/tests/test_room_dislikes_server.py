"""Запросы дизлайков на поднятом в тесте сервере: /dislikes и /admin/dislikes*.

Контроллер подделан на уровне urlopen, как в test_room_download.py: окно
станции — `/state`, проверка пароля — `/settings`. До своего подопытного
сервера тест ходит настоящим urlopen (адрес 127.0.0.1).
"""
import importlib.util
import json
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from email.message import Message
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
# server.py импортирует соседей как `import guard` — так они лежат в образе.
sys.path.insert(0, str(ROOT / "room"))


def _load(name: str):
    path = ROOT / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"ds_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"ds_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


server_mod = _load("server")
store_mod = _load("store")

OWNER = "Basic b3duZXI6cGFzcw=="          # owner:pass — подделка знает только его
ME = {"X-Listener-Id": "l1", "X-Listener-Name": urllib.parse.quote("Аня")}
NAMELESS = {"X-Listener-Id": "l1"}


class _Body:
    status = 200

    def __init__(self, body: bytes):
        self._body = body

    def read(self, *args):
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class Controller:
    """Фиктивный контроллер: окно станции и проверка пароля."""

    def __init__(self):
        self.state = {
            "current": {"subsonic_id": "cur", "artist": "Кино", "title": "Звезда",
                        "album": "Звезда по имени Солнце"},
            "history": [{"subsonic_id": "old", "artist": "Кино",
                         "title": "Пачка сигарет", "album": "Звезда по имени Солнце"},
                        {"subsonic_id": "anon", "artist": "", "title": "Джингл",
                         "album": ""}],
            "upcoming": [{"subsonic_id": "soon", "artist": "Ария", "title": "Улица Роз"}],
        }
        self.auth = "check"        # "check" — сверка с OWNER; 429; "down"
        self.asked = []

    def urlopen(self, req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        self.asked.append(url)
        if url.endswith("/state"):
            return _Body(json.dumps(self.state, ensure_ascii=False).encode("utf-8"))
        if url.endswith("/settings"):
            if self.auth == "down":
                raise OSError("controller unreachable")
            if self.auth == 429:
                headers = Message()
                headers["Retry-After"] = "900"
                raise urllib.error.HTTPError(url, 429, "locked", headers, None)
            if req.get_header("Authorization") != OWNER:
                raise urllib.error.HTTPError(url, 401, "no", Message(), None)
            return _Body(b"{}")
        raise AssertionError(f"неожиданный адрес {url}")


@pytest.fixture
def room(tmp_path, monkeypatch):
    store = store_mod.Store(str(tmp_path / "room.db"))
    config = server_mod.Config(controller_url="http://controller:7701", dislikes_max=5)
    ctl = Controller()
    real_urlopen = urllib.request.urlopen

    def fake_urlopen(req, timeout=None):
        url = req.full_url if hasattr(req, "full_url") else req
        if url.startswith("http://127.0.0.1:"):
            return real_urlopen(req, timeout=timeout)
        return ctl.urlopen(req, timeout)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server_mod.build_handler(store, config))
    thread = threading.Thread(target=lambda: srv.serve_forever(poll_interval=0.02),
                              daemon=True)
    thread.start()
    yield {"base": f"http://127.0.0.1:{srv.server_address[1]}", "store": store,
           "ctl": ctl}
    srv.shutdown()
    srv.server_close()
    store.close()


def call(base, path, body=None, headers=None):
    """(код, заголовки, json). С телом — POST, без — GET."""
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data,
                                 method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json",
                                          **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, r.headers, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, e.headers, json.loads(e.read().decode("utf-8"))


def dislike(room, song, kind, on=True, headers=ME):
    return call(room["base"], "/dislikes", {"songId": song, "kind": kind, "on": on},
                headers)


def owner(room, path, body=None):
    return call(room["base"], path, body, {"Authorization": OWNER})


def test_dislike_of_the_current_song_is_marked(room):
    code, _, body = dislike(room, "cur", "track")
    assert code == 200 and body == {"songId": "cur", "track": True, "artist": False}
    code, _, body = call(room["base"], "/dislikes", headers=ME)
    assert code == 200 and body == {"marks": {"cur": {"track": True, "artist": False}}}


def test_artist_dislike_marks_every_song_of_the_artist(room):
    dislike(room, "cur", "artist")
    _, _, body = call(room["base"], "/dislikes", headers=ME)
    assert body["marks"] == {"cur": {"track": False, "artist": True},
                             "old": {"track": False, "artist": True}}


def test_song_outside_the_window_is_403(room):
    assert dislike(room, "soon", "track")[0] == 403      # ещё не звучала
    assert dislike(room, "nosuch", "track")[0] == 403
    assert room["store"].all_dislikes() == []


def test_artist_dislike_of_a_nameless_track_is_400(room):
    # Review Focus 2
    assert dislike(room, "anon", "artist")[0] == 400
    assert dislike(room, "anon", "track")[0] == 200


def test_on_must_be_a_real_boolean(room):
    # Review Focus 5: «true» строкой и единица — не «поставить»
    for on in ("true", 1, None):
        assert dislike(room, "cur", "track", on=on)[0] == 400
    assert call(room["base"], "/dislikes", {"songId": "cur", "kind": "track"}, ME)[0] == 400
    assert room["store"].all_dislikes() == []


def test_bad_kind_or_missing_song_is_400(room):
    assert dislike(room, "cur", "album")[0] == 400
    assert dislike(room, "", "track")[0] == 400
    assert call(room["base"], "/dislikes", {"kind": "track", "on": True}, ME)[0] == 400


def test_oversized_body_is_413(room):
    # Ruling 1: спека §5 числит 413 среди проверок запроса, тест на него в
    # брифе отсутствовал. Смоделировано на test_room_server.py:183-186,
    # но код здесь проверяется точно — 413, а не «400 или 413».
    code, _, _ = call(room["base"], "/dislikes",
                      {"songId": "cur", "kind": "track", "on": True,
                       "pad": "я" * 20000}, ME)
    assert code == 413
    assert room["store"].all_dislikes() == []


def test_listener_id_is_required(room):
    assert dislike(room, "cur", "track", headers={})[0] == 400
    assert call(room["base"], "/dislikes")[0] == 400


def test_undo_removes_the_mark(room):
    dislike(room, "cur", "track")
    code, _, body = dislike(room, "cur", "track", on=False)
    assert code == 200 and body["track"] is False
    assert call(room["base"], "/dislikes", headers=ME)[2] == {"marks": {}}


def test_repeat_does_not_add_a_row(room):
    dislike(room, "cur", "track")
    dislike(room, "cur", "track")
    assert len(room["store"].all_dislikes()) == 1


def test_cap_refuses_new_marks_but_undo_still_works(room):
    for i in range(5):                                   # dislikes_max=5 в фикстуре
        assert dislike(room, "cur", "track", headers={"X-Listener-Id": f"l{i}"})[0] == 200
    assert dislike(room, "cur", "track", headers={"X-Listener-Id": "l9"})[0] == 429
    assert dislike(room, "cur", "track", on=False, headers={"X-Listener-Id": "l0"})[0] == 200
    assert dislike(room, "cur", "track", headers={"X-Listener-Id": "l9"})[0] == 200


def test_name_is_sanitised_cut_and_never_crashes(room):
    # Review Focus 4
    loud = {"X-Listener-Id": "l1", "X-Listener-Name": urllib.parse.quote("<b>" + "я" * 60)}
    assert dislike(room, "cur", "track", headers=loud)[0] == 200
    assert room["store"].all_dislikes()[0]["name"] == "я" * 40
    broken = {"X-Listener-Id": "l2", "X-Listener-Name": "%E0%A4%A"}
    assert dislike(room, "cur", "track", headers=broken)[0] == 200


def test_later_name_reaches_old_rows(room):
    dislike(room, "cur", "track", headers=NAMELESS)
    dislike(room, "old", "track", headers=ME)
    assert {r["name"] for r in room["store"].all_dislikes()} == {"Аня"}


def test_dead_station_is_502(room):
    room["ctl"].state = None                             # /state отвечает «null»
    assert dislike(room, "cur", "track")[0] == 502
    code, _, body = call(room["base"], "/dislikes", headers=ME)
    # Текст исключения несёт адрес контроллера — наружу только фиксированная фраза
    assert code == 502 and body == {"error": "станция не ответила"}


def test_suggestions_need_the_owner_password(room):
    code, headers, _ = call(room["base"], "/admin/dislikes")
    assert code == 401 and headers.get("WWW-Authenticate") is None
    assert not [u for u in room["ctl"].asked if u.endswith("/settings")]


def test_wrong_password_is_401_without_the_browser_dialog(room):
    code, headers, _ = call(room["base"], "/admin/dislikes",
                            headers={"Authorization": "Basic bad"})
    assert code == 401 and headers.get("WWW-Authenticate") is None


def test_owner_sees_suggestions(room):
    dislike(room, "cur", "track")
    dislike(room, "old", "track")
    code, _, body = owner(room, "/admin/dislikes")
    assert code == 200
    assert {t["songId"] for t in body["tracks"]} == {"cur", "old"}
    assert body["tracks"][0]["listeners"] == [{"name": "Аня", "tag": "l1"}]
    assert [(a["key"], a["songs"]) for a in body["artists"]] == [("кино", 2)]


def test_lockout_is_passed_through(room):
    room["ctl"].auth = 429
    code, headers, _ = owner(room, "/admin/dislikes")
    assert code == 429 and headers.get("Retry-After") == "900"


def test_unreachable_controller_on_admin_is_502(room):
    room["ctl"].auth = "down"
    assert owner(room, "/admin/dislikes")[0] == 502


def test_keep_hides_the_suggestion(room):
    dislike(room, "cur", "track")
    code, _, body = owner(room, "/admin/dislikes/decide",
                          {"kind": "track", "key": "cur", "action": "keep"})
    assert code == 200 and body == {"ok": True}
    assert owner(room, "/admin/dislikes")[2]["tracks"] == []


def test_block_decision_hides_the_artist(room):
    dislike(room, "cur", "artist")
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "artist", "key": "кино", "action": "blocked"})[0] == 200
    assert owner(room, "/admin/dislikes")[2]["artists"] == []


def test_decide_needs_a_target_with_dislikes(room):
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "track", "key": "nosuch", "action": "keep"})[0] == 404


def test_decide_validates_fields(room):
    dislike(room, "cur", "track")
    assert owner(room, "/admin/dislikes/decide",
                 {"kind": "track", "key": "cur", "action": "delete"})[0] == 400
    assert owner(room, "/admin/dislikes/decide",
                 {"key": "cur", "action": "keep"})[0] == 400


def test_decide_without_password_is_401(room):
    dislike(room, "cur", "track")
    code, _, _ = call(room["base"], "/admin/dislikes/decide",
                      {"kind": "track", "key": "cur", "action": "keep"})
    assert code == 401
    assert owner(room, "/admin/dislikes")[2]["tracks"] != []


def test_unknown_admin_path_is_404(room):
    assert owner(room, "/admin/nope")[0] == 404
