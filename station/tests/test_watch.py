"""watch.py: сторож эфира — сообщает о сбое один раз и один раз о восстановлении.

О молчащей ведущей, аварийной петле и упавшей комнате владелец узнавал на слух
или от слушателей. Здесь — пороги, отсутствие повторов каждые 5 минут и то, что
недоставленное сообщение не теряется.
"""
import importlib.util
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

WATCH = Path(__file__).resolve().parent.parent / "tools" / "watch.py"
_spec = importlib.util.spec_from_file_location("subwave_watch", WATCH)
watch = importlib.util.module_from_spec(_spec)
sys.modules["subwave_watch"] = watch
_spec.loader.exec_module(watch)

T0 = 1_791_000_000.0
MIN = 60
OK = {"bridge": None, "air": None, "stream": None, "room": None, "api": None}


def run(results: dict, state: dict, now: float):
    """Один запуск сторожа над готовыми результатами проверок, доставка успешна."""
    new, alerts, recovered = watch.step(results, state, now)
    text = watch.render(alerts, recovered)
    return watch.settle(new, state, alerts, recovered, True), text


def test_bridge_alerts_only_after_15_minutes_and_once():
    bad = {**OK, "bridge": "HTTP 503"}
    state, text = run(bad, {}, T0)
    assert text == ""                                  # провал только начался
    state, text = run(bad, state, T0 + 10 * MIN)
    assert text == ""
    state, text = run(bad, state, T0 + 15 * MIN)
    assert "мостик TTS" in text and "15 мин" in text
    state, text = run(bad, state, T0 + 20 * MIN)
    assert text == ""                                  # без повторов


def test_short_bridge_blip_says_nothing_at_all():
    state, _ = run({**OK, "bridge": "HTTP 503"}, {}, T0)
    state, text = run(OK, state, T0 + 5 * MIN)
    assert text == "" and state == {}


def test_starved_music_alerts_at_once_and_recovers_once():
    starved = {**OK, "air": "музыка на аварийной петле с 03:10"}
    state, text = run(starved, {}, T0)
    assert "аварийной петле" in text
    state, text = run(starved, state, T0 + 5 * MIN)
    assert text == ""
    state, text = run(OK, state, T0 + 10 * MIN)
    assert "В ПОРЯДКЕ эфир" in text and "10 мин" in text
    state, text = run(OK, state, T0 + 15 * MIN)
    assert text == "" and state == {}


@pytest.mark.parametrize("name", ["room", "api"])
def test_room_and_controller_alert_at_once(name):
    state, text = run({**OK, name: "HTTP 502"}, {}, T0)
    assert f"СБОЙ {watch.LABELS[name]}: HTTP 502" in text
    assert state[name]["alerted"] is True


def test_several_failures_go_in_one_message():
    _, text = run({**OK, "air": "/api/state не отвечает", "room": "HTTP 502",
                   "api": "HTTP 502"}, {}, T0)
    assert text.count("СБОЙ") == 3


def test_undelivered_alert_is_retried_next_run():
    bad = {**OK, "room": "HTTP 502"}
    new, alerts, recovered = watch.step(bad, {}, T0)
    state = watch.settle(new, {}, alerts, recovered, delivered=False)
    _, text = run(bad, state, T0 + 5 * MIN)
    assert "комната" in text


def test_undelivered_recovery_is_retried_next_run():
    state, _ = run({**OK, "room": "HTTP 502"}, {}, T0)
    new, alerts, recovered = watch.step(OK, state, T0 + 5 * MIN)
    state = watch.settle(new, state, alerts, recovered, delivered=False)
    _, text = run(OK, state, T0 + 10 * MIN)
    assert "В ПОРЯДКЕ комната" in text


# ── проверки по HTTP: настоящий сервер, без подмены urllib ───────────────────

class _Station(BaseHTTPRequestHandler):
    routes: dict = {}

    def do_GET(self):
        code, body = self.routes.get(self.path, (404, {"error": "not found"}))
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, *a):
        pass


def _now_playing(started: float, duration=None, online=True) -> dict:
    """Форма GET /api/now-playing: timestamp пишет radio.liq (unix-секунды
    начала трека), duration добавляет контроллер, если знает длину."""
    track = {"title": "Группа крови", "artist": "Кино", "timestamp": int(started)}
    if duration is not None:
        track["duration"] = duration
    return {"nowPlaying": track, "streamOnline": online, "listeners": {"current": 1}}


@pytest.fixture
def station():
    routes = {"/b/health": (200, {"ok": True}),
              "/api/state": (200, {"musicStarved": False, "musicStarvedSince": None}),
              # без длины: порог 20 минут, запуски тестов main укладываются
              "/api/now-playing": (200, _now_playing(T0 - MIN)),
              "/room/health": (200, {"ok": True}),
              "/api/health": (200, {"status": "on-air"})}
    handler = type("Station", (_Station,), {"routes": routes})
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    # опрос остановки — 0.05 с, а не 0.5 по умолчанию: иначе полсекунды на тест
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05},
                              daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_address[1]}"
    yield {"TTS_BRIDGE_URL": base + "/b/", "WATCH_STATION_URL": base + "/",
           "WATCH_NOTIFY_CMD": "", "WATCH_STATE_FILE": ""}, routes
    server.shutdown()
    server.server_close()


def test_checks_read_the_real_fields(station):
    cfg, routes = station
    assert watch.check(cfg, T0) == OK
    routes["/b/health"] = (503, {"ok": False})
    routes["/api/state"] = (200, {"musicStarved": True, "musicStarvedSince": None})
    routes["/room/health"] = (502, {})
    got = watch.check(cfg, T0)
    assert got["bridge"].startswith("HTTP 503")
    assert got["air"] == "музыка на аварийной петле"
    assert got["room"].startswith("HTTP 502") and got["api"] is None


def test_bridge_answering_200_without_ok_is_not_healthy(station):
    # здоровье — по полю ok, а не по коду: сам Chatterbox отвечает 200 и пока
    # грузит веса, и адрес мимо мостика иначе выглядел бы здоровым
    cfg, routes = station
    routes["/b/health"] = (200, {"ok": False})
    assert watch.check(cfg, T0)["bridge"] is not None


# ── мёртвый микшер: всё остальное зелёное при полной тишине ──────────────────
#
# Упал broadcast — music-starved.json перестаёт обновляться, и через 60 с
# контроллер отвечает «не голодает» (music-starve-pure.ts); /api/health —
# константа on-air; комната жива. Тишину видно только по самому эфиру.

def test_stream_without_source_is_a_failure(station):
    cfg, routes = station
    routes["/api/now-playing"] = (200, _now_playing(T0 - MIN, online=False))
    assert "Icecast" in watch.check(cfg, T0)["stream"]


def test_track_far_past_its_end_means_the_mixer_stopped(station):
    cfg, routes = station
    routes["/api/now-playing"] = (200, _now_playing(T0 - 4 * MIN, duration=240))
    assert watch.check(cfg, T0)["stream"] is None
    # длина + 5 минут запаса (стык, джингл, пауза ведущей)
    assert watch.check(cfg, T0 + 4 * MIN + 1)["stream"] is None
    got = watch.check(cfg, T0 + 6 * MIN)["stream"]
    assert got and "Кино — Группа крови" in got


def test_track_without_duration_gets_20_minutes(station):
    cfg, routes = station
    routes["/api/now-playing"] = (200, _now_playing(T0))
    assert watch.check(cfg, T0 + 19 * MIN)["stream"] is None
    assert watch.check(cfg, T0 + 21 * MIN)["stream"] is not None


def test_nothing_playing_is_a_failure(station):
    # stream_down в radio.liq удаляет now-playing.json — nowPlaying: null
    cfg, routes = station
    routes["/api/now-playing"] = (200, {"nowPlaying": None, "streamOnline": True})
    assert watch.check(cfg, T0)["stream"] is not None


def test_stalled_stream_alerts_on_the_second_run_and_once():
    # перезапуск контроллера даёт до 15 с streamOnline=false — один запуск не повод
    bad = {**OK, "stream": "Icecast без источника — микшер не вещает"}
    state, text = run(bad, {}, T0)
    assert text == ""
    state, text = run(bad, state, T0 + 5 * MIN)
    assert "СБОЙ поток" in text
    state, text = run(bad, state, T0 + 10 * MIN)
    assert text == ""
    state, text = run(OK, state, T0 + 15 * MIN)
    assert "В ПОРЯДКЕ поток" in text


def test_unreachable_station_is_a_failure(monkeypatch):
    # закрытый порт на Windows отвечает отказом только через ~2 с повторов SYN —
    # отказ соединения подменяется на уровне urlopen
    def refused(url, timeout=None):
        raise watch.urllib.error.URLError(ConnectionRefusedError(10061, "refused"))
    monkeypatch.setattr(watch.urllib.request, "urlopen", refused)
    base = "http://station:7700"
    got = watch.check({"TTS_BRIDGE_URL": base, "WATCH_STATION_URL": base}, T0)
    assert got["air"].startswith("/api/state не отвечает (URLError")
    assert all(got[n].startswith("нет ответа (URLError") for n in ("bridge", "room", "api"))


# ── main: канал, код выхода, состояние между запусками ───────────────────────

def _env(cfg: dict, tmp_path: Path, notify: str = "") -> dict:
    return {**cfg, "WATCH_NOTIFY_CMD": notify,
            "WATCH_STATE_FILE": str(tmp_path / "state.json")}


def test_without_channel_prints_and_fails(station, tmp_path, capsys):
    cfg, routes = station
    routes["/api/health"] = (502, {})
    env = _env(cfg, tmp_path)
    absent = tmp_path / "absent.env"
    assert watch.main([], now=lambda: T0, environ=env, env_file=absent) == 1
    assert "СБОЙ контроллер" in capsys.readouterr().out
    routes["/api/health"] = (200, {"status": "on-air"})
    assert watch.main([], now=lambda: T0 + 5 * MIN, environ=env, env_file=absent) == 0
    assert "В ПОРЯДКЕ контроллер" in capsys.readouterr().out


def test_notify_command_gets_the_text_once(station, tmp_path):
    cfg, routes = station
    routes["/api/state"] = (200, {"musicStarved": True})
    sink = tmp_path / "sent.txt"
    script = tmp_path / "send.py"
    script.write_text("import sys\nopen(sys.argv[1], 'a', encoding='utf-8')"
                      ".write(sys.stdin.buffer.read().decode('utf-8') + '\\n---\\n')\n",
                      encoding="utf-8")
    env = _env(cfg, tmp_path, f'"{sys.executable}" "{script}" "{sink}"')
    absent = tmp_path / "absent.env"
    for minute in (0, 5, 10):
        assert watch.main([], now=lambda: T0 + minute * MIN, environ=env,
                          env_file=absent) == 0
    sent = sink.read_text(encoding="utf-8")
    assert sent.count("---") == 1 and "аварийной петле" in sent


def test_failed_notify_is_an_error_and_is_retried(station, tmp_path):
    cfg, routes = station
    routes["/room/health"] = (502, {})
    env = _env(cfg, tmp_path, f'"{sys.executable}" -c "raise SystemExit(3)"')
    absent = tmp_path / "absent.env"
    assert watch.main([], now=lambda: T0, environ=env, env_file=absent) == 1
    state = json.loads((tmp_path / "state.json").read_text(encoding="utf-8"))
    assert state["room"]["alerted"] is False


# ── настройки ────────────────────────────────────────────────────────────────

def test_notify_command_keeps_its_own_quotes(tmp_path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "TTS_BRIDGE_URL=http://gpu-host:4124\n"
        "WATCH_STATION_URL='https://station-domain'\n"
        "WATCH_NOTIFY_CMD='\"C:\\Program Files\\Git\\bin\\bash.exe\" C:\\boss\\telegram-send.sh'\n",
        encoding="utf-8")
    cfg = watch.load_config(environ={"LOCALAPPDATA": str(tmp_path)}, env_file=env_file)
    assert cfg["WATCH_STATION_URL"] == "https://station-domain"
    assert cfg["WATCH_NOTIFY_CMD"] == '"C:\\Program Files\\Git\\bin\\bash.exe" C:\\boss\\telegram-send.sh'
    assert cfg["WATCH_STATE_FILE"] == str(tmp_path / "subwave-watch.json")


def test_missing_addresses_are_named(tmp_path):
    with pytest.raises(SystemExit) as e:
        watch.load_config(environ={}, env_file=tmp_path / "absent.env")
    assert "TTS_BRIDGE_URL" in str(e.value) and "WATCH_STATION_URL" in str(e.value)
