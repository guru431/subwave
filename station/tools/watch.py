#!/usr/bin/env python3
"""Сторож эфира: оповещение владельцу, когда ведущая молчит или эфир сломан.

    python station/tools/watch.py

О молчащем голосе, аварийной петле или упавшей комнате владелец узнавал на слух,
от слушателей или из баннера в плеере. Данные для проверки станция уже отдаёт по
HTTP — сторож опрашивает их из задачи планировщика раз в 5 минут:

| Проверка | Адрес | Сбой |
|---|---|---|
| мостик TTS | `TTS_BRIDGE_URL/health` | не `200 {"ok": true}` дольше 15 минут подряд — ведущая молчит |
| эфир | `WATCH_STATION_URL/api/state` | `musicStarved: true` (аварийная петля) или нет ответа |
| поток | `WATCH_STATION_URL/api/now-playing` | `streamOnline` не true, нет трека или трек идёт дольше длины + 5 мин (без длины — 20 мин) — микшер стоит |
| комната | `WATCH_STATION_URL/room/health` | не 200 |
| контроллер | `WATCH_STATION_URL/api/health` | не 200 |

Мостик получает 15 минут: F5 на хосте GPU поднимается не мгновенно, а без Docker до
логона там нет и мостика — короткий провал не повод будить владельца. Поток — со
второго запуска подряд (перезапуск контроллера). Остальное — сразу: аварийная петля
и упавший контроллер слышны слушателям уже сейчас.

Поток проверяется отдельно, потому что упавший микшер не виден ни в одной другой
проверке: `music-starved.json` перестаёт обновляться, через 60 с контроллер отвечает
«не голодает», `/api/health` — константа, комната жива.

Сообщение — одно на переходе в сбой и одно о восстановлении, без повторов каждые
5 минут; состояние между запусками — в `WATCH_STATE_FILE`. Недоставленное
сообщение повторяется в следующий запуск. Канал — `WATCH_NOTIFY_CMD` (текст на
stdin; у нас — `telegram-send.sh` бандла). Без него сообщения печатаются в
stdout, и при сбое код выхода 1.

Адреса — из окружения или `station/.env` (шаблон — `station/.env.example`).
Только стандартная библиотека: задача идёт в session 0 планировщика.
"""
import argparse
import http.client
import json
import os
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"
KEYS = ("TTS_BRIDGE_URL", "WATCH_STATION_URL", "WATCH_NOTIFY_CMD", "WATCH_STATE_FILE")
REQUIRED = ("TTS_BRIDGE_URL", "WATCH_STATION_URL")
# мостик сам ждёт /health F5 до 10 с — запас сверху
TIMEOUT = 15
# telegram-send.sh повторяет недоставленное с паузами 30 и 90 с
NOTIFY_TIMEOUT = 300
# сколько секунд сбой должен длиться, прежде чем о нём сообщить. Поток — со
# второго запуска подряд: после перезапуска контроллера статус Icecast до 15 с
# не опрошен, и streamOnline в это время false
GRACE = {"bridge": 15 * 60, "stream": 4 * 60}
LABELS = {"bridge": "мостик TTS (ведущая молчит)", "air": "эфир",
          "stream": "поток (эфир стоит)", "room": "комната (чат)", "api": "контроллер"}
# Трек «стоит», если с его начала прошло больше длины + запас: стык, джингл,
# пауза ведущей между песнями идут без нового now-playing. Без длины — порог
# по возрасту начала.
STALE_MARGIN = 5 * 60
STALE_NO_DURATION = 20 * 60


def _unquote(value: str) -> str:
    # кавычки снимаются, только если ими обёрнуто всё значение: в команде
    # оповещения свои кавычки — "C:\Program Files\…\bash.exe" скрипт
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"" \
            and value[0] not in value[1:-1]:
        return value[1:-1]
    return value


def load_config(environ=os.environ, env_file: Path = ENV_FILE) -> dict[str, str]:
    """Значения — из окружения, недостающие — из `station/.env`."""
    values = {}
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = _unquote(value.strip())
    values.update({k: environ[k] for k in KEYS if environ.get(k)})
    missing = [k for k in REQUIRED if not values.get(k)]
    if missing:
        raise SystemExit(f"не заданы {', '.join(missing)}: окружение или {env_file} "
                         f"(шаблон — station/.env.example)")
    cfg = {k: values.get(k, "") for k in KEYS}
    if not cfg["WATCH_STATE_FILE"]:
        base = environ.get("LOCALAPPDATA") or str(Path.home() / ".cache")
        cfg["WATCH_STATE_FILE"] = str(Path(base) / "subwave-watch.json")
    return cfg


def fetch(url: str, timeout: float = TIMEOUT) -> tuple[int | None, object, str]:
    """(HTTP-код, тело JSON или None, ошибка соединения или "")."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError) as e:
        return None, None, f"{type(e).__name__}: {e}"
    try:
        return code, json.loads(raw.decode("utf-8", "replace")), ""
    except ValueError:
        return code, None, ""


def _http_problem(code, body) -> str:
    tail = f" {json.dumps(body, ensure_ascii=False)[:120]}" if body is not None else ""
    return f"HTTP {code}{tail}"


def _stream_problem(code, body, err, now: float) -> str | None:
    """Эфир по самому потоку, а не по флагам микшера.

    Упавший broadcast не виден ни в одной другой проверке: music-starved.json
    перестаёт обновляться, и через 60 с контроллер отвечает «не голодает»,
    /api/health — константа, комната жива. Видно две вещи: Icecast без
    источника (`streamOnline`) и трек, который «играет» дольше своей длины —
    `nowPlaying.timestamp` пишет radio.liq в начале каждого трека.
    """
    if err:
        return f"/api/now-playing не отвечает ({err})"
    if code != 200 or not isinstance(body, dict):
        return "/api/now-playing: " + _http_problem(code, body)
    if body.get("streamOnline") is not True:
        return "Icecast без источника — микшер не вещает"
    track = body.get("nowPlaying")
    started = track.get("timestamp") if isinstance(track, dict) else None
    if not isinstance(started, (int, float)):
        return "нет текущего трека — микшер не пишет now-playing"
    duration = track.get("duration")
    known = isinstance(duration, (int, float)) and duration > 0
    age = now - started
    if age <= (duration + STALE_MARGIN if known else STALE_NO_DURATION):
        return None
    name = " — ".join(str(track[k]) for k in ("artist", "title") if track.get(k))
    return (f"трек «{name}» начался {round(age / 60)} мин назад"
            + (f" при длине {round(duration / 60)} мин" if known else "")
            + " — микшер стоит")


def check(cfg: dict[str, str], now: float, get=fetch) -> dict[str, str | None]:
    """Имя проверки → None (в порядке) или текст сбоя."""
    station = cfg["WATCH_STATION_URL"].rstrip("/")
    out = {}

    code, body, err = get(cfg["TTS_BRIDGE_URL"].rstrip("/") + "/health")
    out["bridge"] = (f"нет ответа ({err})" if err
                     else None if code == 200 and isinstance(body, dict) and body.get("ok") is True
                     else _http_problem(code, body))

    code, body, err = get(station + "/api/state")
    if err:
        out["air"] = f"/api/state не отвечает ({err})"
    elif code != 200 or not isinstance(body, dict):
        out["air"] = "/api/state: " + _http_problem(code, body)
    elif body.get("musicStarved") is True:
        since = body.get("musicStarvedSince")
        out["air"] = "музыка на аварийной петле" + (
            f" с {datetime.fromtimestamp(since / 1000):%H:%M}"
            if isinstance(since, (int, float)) else "")
    else:
        out["air"] = None

    out["stream"] = _stream_problem(*get(station + "/api/now-playing"), now)

    for name, path in (("room", "/room/health"), ("api", "/api/health")):
        code, body, err = get(station + path)
        out[name] = (f"нет ответа ({err})" if err
                     else None if code == 200 else _http_problem(code, body))
    return out


def step(results: dict, state: dict, now: float):
    """Переход состояния за один запуск.

    `state` — имя → {"since", "alerted", "problem"}; нет записи — в порядке.
    Возвращает (новое состояние, алерты, восстановления). В новом состоянии
    алерты ещё не помечены отправленными — это делает `settle` после доставки.
    """
    new, alerts, recovered = {}, [], []
    for name, problem in results.items():
        prev = state.get(name)
        if problem is None:
            if prev and prev.get("alerted"):
                recovered.append((name, now - prev["since"]))
            continue
        since = prev["since"] if prev else now
        alerted = bool(prev and prev.get("alerted"))
        new[name] = {"since": since, "alerted": alerted, "problem": problem}
        if not alerted and now - since >= GRACE.get(name, 0):
            alerts.append((name, problem, now - since))
    return new, alerts, recovered


def settle(new: dict, old: dict, alerts, recovered, delivered: bool) -> dict:
    """Состояние после попытки доставки: недоставленное повторится."""
    if delivered:
        for name, *_ in alerts:
            new[name]["alerted"] = True
    else:
        # о восстановлении не сообщено — запись остаётся «оповещённой», и
        # следующий запуск в порядке попробует сообщить снова
        for name, _ in recovered:
            new[name] = old[name]
    return new


def _minutes(seconds: float) -> int:
    return max(1, round(seconds / 60))


def render(alerts, recovered) -> str:
    lines = []
    for name, problem, lasted in alerts:
        lines.append(f"СБОЙ {LABELS[name]}: {problem}"
                     + (f" — уже {_minutes(lasted)} мин" if GRACE.get(name) else ""))
    for name, lasted in recovered:
        lines.append(f"В ПОРЯДКЕ {LABELS[name]} — сбой длился ~{_minutes(lasted)} мин")
    return "radio, сторож эфира:\n" + "\n".join(lines) if lines else ""


def notify(cmd: str, text: str) -> bool:
    """Отправить текст командой оповещения (на stdin). True — доставлено."""
    if not cmd:
        return True
    # Windows разбирает строку команды сам (CreateProcess): обратные слеши путей
    # там не экранирование, и shlex их съел бы
    argv = cmd if os.name == "nt" else shlex.split(cmd)
    try:
        p = subprocess.run(argv, input=text.encode("utf-8"), capture_output=True,
                           timeout=NOTIFY_TIMEOUT)
    except (OSError, subprocess.TimeoutExpired) as e:
        print(f"оповещение не отправлено: {type(e).__name__}: {e}", file=sys.stderr)
        return False
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace").strip()[-300:]
        print(f"оповещение не отправлено (код {p.returncode}): {err}", file=sys.stderr)
        return False
    return True


def load_state(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        # испорченное состояние стоит в худшем случае повторного сообщения,
        # а не молчащего сторожа
        print(f"{path}: состояние не прочитано ({e}) — начинаю с чистого",
              file=sys.stderr)
        return {}
    return data if isinstance(data, dict) else {}


def save_state(path: Path, state: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def main(argv=None, now=time.time, get=fetch, environ=os.environ,
         env_file: Path = ENV_FILE) -> int:
    argparse.ArgumentParser(description="сторож эфира станции").parse_args(argv)
    try:
        # консоль задачи планировщика — не UTF-8: кириллица иначе роняет печать
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    cfg = load_config(environ, env_file)
    state_path = Path(cfg["WATCH_STATE_FILE"])
    old = load_state(state_path)
    t = now()
    results = check(cfg, t, get)
    new, alerts, recovered = step(results, old, t)
    text = render(alerts, recovered)
    delivered = True
    if text:
        print(text)
        delivered = notify(cfg["WATCH_NOTIFY_CMD"], text)
    save_state(state_path, settle(new, old, alerts, recovered, delivered))

    for name, problem in results.items():
        entry = new.get(name)
        status = "ok" if problem is None else (
            f"{problem} (сбой {_minutes(t - entry['since'])} мин)")
        print(f"{name}: {status}")
    if not delivered:
        return 1
    if not cfg["WATCH_NOTIFY_CMD"]:
        # без канала код выхода — единственный сигнал: сбой, дошедший до порога
        if any(t - e["since"] >= GRACE.get(n, 0) for n, e in new.items()):
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
