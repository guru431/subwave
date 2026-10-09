#!/usr/bin/env python3
"""Первичная настройка subwave через API вместо браузерного мастера.

Мастер на /onboarding и этот скрипт пишут одно и то же: Navidrome — в
state/setup-config.json, LLM/TTS/персона — в state/settings.json. Скрипт нужен
потому, что настройка должна быть воспроизводимой и лежать в git, а не
оставаться серией кликов, которую никто потом не повторит.

Python, а не shell: тело собирается `json.dumps`, а не `printf '%s'` внутрь
шаблона — кавычка, обратный слеш или перевод строки в пароле иначе ломают
запрос либо меняют значение. HTTP-код проверяется на каждом шаге: `curl -sS`
молчит на 401 и 500, и настройки сохранялись после неудавшейся пробы.

Значения берутся из окружения — секреты в репозиторий не попадают, список —
в .env.example рядом:

    SUBWAVE_URL=http://<station-host>:7700 \\
    SUBWAVE_ADMIN_USER=admin SUBWAVE_ADMIN_PASS=... \\
    NAVIDROME_URL=http://<station-host>:4533 \\
    NAVIDROME_USER=subwave NAVIDROME_PASS=... \\
    LLM_BASE_URL=http://<station-host>:4000/v1 LLM_MODEL=dj \\
    LLM_API_KEY=... ./onboard.py

LLM — через шлюз, ролью `dj`, ключ GATEWAY_KEY_MUSIC_SUBWAVE (так настроена живая
станция с 2026-09-19). Прямой OpenCode Go, стоявший здесь раньше, с 12.09 отвечает
«missing x-opencode-session»: этот заголовок ставит шлюз, а клиент станции — нет.

Снять текущие настройки с живой станции (секреты маскируются):

    ./onboard.py --export settings-snapshot.json

Применить снятый ранее снимок вместе с onboarding (TTS, персона, шоу):

    SUBWAVE_SETTINGS_FILE=settings-snapshot.json ./onboard.py
"""
import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.request

# доступ к самой станции нужен всегда; настройки Navidrome и LLM — только при
# записи. Снятие снимка (--export) ходит под админом subwave в /settings, и
# требовать ради него ключ LLM значит запретить снимок там, где ключа нет
SUBWAVE_REQUIRED = ("SUBWAVE_URL", "SUBWAVE_ADMIN_USER", "SUBWAVE_ADMIN_PASS")
REQUIRED = SUBWAVE_REQUIRED + (
    "NAVIDROME_URL", "NAVIDROME_USER", "NAVIDROME_PASS",
    "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY")
SECRET_KEYS = ("pass", "password", "apikey", "token", "secret")
TIMEOUT = 30

# Ключи, которые принимает `POST /settings`: копия SETTINGS_PATCH_KEYS из
# controller/src/settings/patch-registry.ts, сверку с исходником держит
# test_onboard.py. Маршрут отвергает весь патч (400 `unknown settings keys`),
# если в нём есть хоть один ключ не из списка, а `GET /settings` отдаёт в
# `values` и производные — `minTrackSeconds`, `boundaryFadeMinTrackSeconds`, —
# записать которые нельзя. Снимок пишется только из этих ключей.
SETTINGS_PATCH_KEYS = (
    "jingleRatio", "jingleRotate", "crossfadeDuration", "ducking", "handover",
    "maxTrackSeconds", "maxTrackMinutes", "archive", "backups", "stream",
    "loudness", "weather", "station", "stationDescription", "timezone", "locale",
    "theme", "moods", "moodSchedule", "weatherMoods", "festivals", "djPrompts",
    "activeDjPromptId", "djPrompt", "djHouseRules", "djBehaviour", "djSpeakClock",
    "djTalkOnlyBetweenTracks", "pauseTalkMinSeconds", "fadeAtShowEnd", "personas",
    "shows", "schedule", "scheduleOverride", "activePersonaId", "tts", "llm",
    "picker", "search", "embedding", "skills", "audio", "transitions", "sfx",
    "beds", "silenceTrim", "ui", "privacy", "requests", "webhooks",
    "webhooksPolicy", "scrobble", "likes", "queue",
)


def env(required: tuple[str, ...] = REQUIRED) -> dict[str, str]:
    missing = [k for k in required if not os.environ.get(k)]
    if missing:
        raise SystemExit("не заданы переменные окружения: " + ", ".join(missing))
    return {k: os.environ[k] for k in required}


def mask(value):
    """Прячет секреты в выводе и в экспортируемом снимке.

    Число, флаг и null секретом не бывают: `llm.dailyTokenCap` и
    `llm.maxOutputTokens` попадают под «token» по имени, и звёздочки на их месте
    делали любой снимок живой станции «замаскированным» — применить его было
    нельзя.
    """
    if isinstance(value, dict):
        return {k: ("***" if not isinstance(v, (int, float, type(None)))
                    and any(s in k.lower() for s in SECRET_KEYS) else mask(v))
                for k, v in value.items()}
    if isinstance(value, list):
        return [mask(v) for v in value]
    return value


def call(base: str, path: str, user: str, password: str, payload=None,
         method: str | None = None) -> tuple[int, object]:
    """Один вызов API. Возвращает (HTTP-код, разобранное тело)."""
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        f"{base.rstrip('/')}/api{path}", data=data,
        method=method or ("POST" if data is not None else "GET"),
        headers={"Authorization": f"Basic {token}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = r.read().decode("utf-8", "replace")
            code = r.status
    except urllib.error.HTTPError as e:
        body, code = e.read().decode("utf-8", "replace"), e.code
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        raise SystemExit(f"{path}: станция недоступна — {type(e).__name__}: {e}") from None
    try:
        return code, json.loads(body)
    except ValueError:
        return code, body


def step_ok(code: int, body) -> str | None:
    """Причина отказа шага либо None.

    Проверяются и код, и тело: у subwave пробы отвечают 200 с полем `ok`,
    а незнакомый формат не объявляется отказом — но и не выдаётся за успех
    молча, его печатает вызывающий.
    """
    if not 200 <= code < 300:
        return f"HTTP {code}: {json.dumps(mask(body), ensure_ascii=False)[:300]}"
    if isinstance(body, dict):
        for key in ("ok", "success", "valid"):
            if key in body and not body[key]:
                return json.dumps(mask(body), ensure_ascii=False)[:300]
        if body.get("error"):
            return json.dumps(mask(body), ensure_ascii=False)[:300]
    return None


def _load_snapshot(path: str):
    """Снимок настроек из файла либо None, если применять его нельзя.

    Проверяется до первого запроса: отказ `POST /settings` пришёл бы уже после
    /onboarding/save, и станция осталась бы настроенной наполовину.
    """
    with open(path, encoding="utf-8") as fh:
        extra = json.load(fh)
    if not isinstance(extra, dict):
        print(f"{path}: снимок должен быть объектом JSON", file=sys.stderr)
        return None
    unknown = [k for k in extra if k not in SETTINGS_PATCH_KEYS]
    if unknown:
        print("в снимке ключи, которых POST /settings не принимает: "
              + ", ".join(unknown) + " — станция отвергла бы снимок целиком"
              + ("; это ответ GET целиком (старый --export) — снимите заново"
                 if "values" in extra else ""), file=sys.stderr)
        return None
    placeholders = [k for k, v in _flatten(extra) if v == "***"]
    if placeholders:
        print("в снимке остались замаскированные значения: "
              + ", ".join(placeholders)
              + " — подставьте секреты перед применением", file=sys.stderr)
        return None
    return extra


def run(e: dict[str, str], settings_file: str | None = None) -> int:
    base, user, password = e["SUBWAVE_URL"], e["SUBWAVE_ADMIN_USER"], e["SUBWAVE_ADMIN_PASS"]
    extra = None
    if settings_file:
        extra = _load_snapshot(settings_file)
        if extra is None:
            return 1
    # адрес Navidrome — LAN-адрес хоста, НЕ 127.0.0.1: контроллер живёт
    # в контейнере, и петлевой адрес указывал бы внутрь него
    navidrome = {"url": e["NAVIDROME_URL"], "user": e["NAVIDROME_USER"],
                 "pass": e["NAVIDROME_PASS"]}
    llm = {"provider": "openai-compatible", "model": e["LLM_MODEL"],
           "baseUrl": e["LLM_BASE_URL"], "apiKey": e["LLM_API_KEY"]}

    for title, path, payload in (
            ("проба Navidrome", "/onboarding/test-navidrome", navidrome),
            ("проба LLM", "/onboarding/test-llm", llm)):
        print(f"\n== {title}")
        code, body = call(base, path, user, password, payload)
        problem = step_ok(code, body)
        print(json.dumps(mask(body), ensure_ascii=False)[:500])
        if problem:
            # сохранять настройки после неудавшейся пробы нельзя: станция
            # получит заведомо нерабочую конфигурацию и молча встанет
            print(f"проба не прошла — {problem}; сохранение не выполняется",
                  file=sys.stderr)
            return 1

    print("\n== сохранение настроек")
    code, body = call(base, "/onboarding/save", user, password, {
        "navidrome": navidrome, "llm": llm,
        "station": "AI радио", "timezone": "Europe/Moscow"})
    problem = step_ok(code, body)
    print(json.dumps(mask(body), ensure_ascii=False)[:500])
    if problem:
        print(f"настройки не сохранены — {problem}", file=sys.stderr)
        return 1

    if extra is not None:
        # TTS, персона и шоу задаются той же формой настроек: снимок с живой
        # станции переносится целиком, чтобы их не приходилось кликать заново
        print(f"\n== применение настроек из {settings_file}")
        code, body = call(base, "/settings", user, password, extra)
        problem = step_ok(code, body)
        print(json.dumps(mask(body), ensure_ascii=False)[:500])
        if problem:
            print(f"настройки из файла не применены — {problem}", file=sys.stderr)
            return 1

    print("\n== статус")
    code, body = call(base, "/onboarding/status", user, password)
    print(json.dumps(mask(body), ensure_ascii=False)[:500])
    return 0 if step_ok(code, body) is None else 1


def _flatten(value, prefix=""):
    if isinstance(value, dict):
        for k, v in value.items():
            yield from _flatten(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(value, list):
        for i, v in enumerate(value):
            yield from _flatten(v, f"{prefix}[{i}]")
    else:
        yield prefix, value


def export_settings(e: dict[str, str], path: str) -> int:
    code, body = call(e["SUBWAVE_URL"], "/settings", e["SUBWAVE_ADMIN_USER"],
                      e["SUBWAVE_ADMIN_PASS"])
    problem = step_ok(code, body)
    if problem:
        print(f"настройки не прочитаны — {problem}", file=sys.stderr)
        return 1
    # снимок — то, что примет POST: `values` без обёртки и без производных.
    # Ответ GET целиком (с `defaults`, `navidrome`, перечнями движков) станция
    # отвергает 400 `unknown settings keys`
    values = _settings_values(body)
    if not isinstance(values, dict):
        print("в ответе /settings нет настроек", file=sys.stderr)
        return 1
    snapshot = {k: v for k, v in values.items() if k in SETTINGS_PATCH_KEYS}
    with open(path, "w", encoding="utf-8") as out:
        json.dump(mask(snapshot), out, ensure_ascii=False, indent=2)
        out.write("\n")
    print(f"записано (секреты заменены на ***): {path}")
    dropped = [k for k in values if k not in SETTINGS_PATCH_KEYS]
    if dropped:
        print("не вошли — POST /settings их не принимает: " + ", ".join(dropped))
    return 0


def _show(path: str, value) -> str:
    """Значение для вывода: секрет по имени последнего сегмента — звёздочками."""
    leaf = path.rsplit(".", 1)[-1].lower()
    if any(s in leaf for s in SECRET_KEYS):
        return "***"
    return json.dumps(value, ensure_ascii=False)


def _settings_values(body):
    """Настройки из ответа `GET /settings`.

    Запись и чтение несимметричны: `POST` принимает патч плоским
    (`{"llm": {"reasoning": true}}`), а `GET` отдаёт те же ключи завёрнутыми в
    `values` — рядом с `defaults`, `env` и метаданными. Сверять надо с
    `values`: в корне ответа лежит **другой** `llm` (перечень провайдеров и
    активная связка), и сверка с ним объявила бы неприменённым всё подряд.
    Обёртки может не быть — тогда ответ и есть настройки.
    """
    if isinstance(body, dict) and isinstance(body.get("values"), dict):
        return body["values"]
    return body


def _subset_problems(want, got, prefix=""):
    """Пути, по которым станция не приняла запрошенное значение.

    Сравнение одностороннее — патч частичный, и всё, чего в нём нет, станцию
    не касается. Словари сверяются вглубь, списки (`personas`, `shows`) —
    целиком: они и передаются целиком.
    """
    for key, want_value in want.items():
        path = f"{prefix}.{key}" if prefix else key
        if not isinstance(got, dict) or key not in got:
            yield path, want_value, None
        elif isinstance(want_value, dict) and isinstance(got[key], dict):
            yield from _subset_problems(want_value, got[key], path)
        elif got[key] != want_value:
            yield path, want_value, got[key]


def apply_patch(e: dict[str, str], path: str, dry_run: bool = False) -> int:
    """Применить патч настроек и проверить, что он лёг.

    `POST /settings` отвечает 200 и на патч, часть которого отброшена:
    незнакомый вложенный ключ контроллер игнорирует молча, а число вне границ
    зажимает до ближайшего допустимого (`tts.gainDb` — ±12 dB). Поэтому после
    записи настройки читаются обратно и сверяются с тем, что просили.
    """
    base, user, password = (e["SUBWAVE_URL"], e["SUBWAVE_ADMIN_USER"],
                            e["SUBWAVE_ADMIN_PASS"])
    with open(path, encoding="utf-8") as fh:
        patch = json.load(fh)
    if not isinstance(patch, dict):
        print(f"{path}: патч должен быть объектом JSON", file=sys.stderr)
        return 1
    masked = [k for k, v in _flatten(patch) if v == "***"]
    if masked:
        print("в патче остались замаскированные значения: " + ", ".join(masked)
              + " — подставьте секреты перед применением", file=sys.stderr)
        return 1

    print(json.dumps(mask(patch), ensure_ascii=False, indent=2))
    if dry_run:
        print("холостой прогон: ничего не отправлено")
        return 0

    code, body = call(base, "/settings", user, password, patch)
    problem = step_ok(code, body)
    if problem:
        print(f"патч не применён — {problem}", file=sys.stderr)
        return 1

    code, after = call(base, "/settings", user, password)
    problem = step_ok(code, after)
    if problem:
        print(f"настройки не прочитаны обратно — {problem}", file=sys.stderr)
        return 1

    mismatches = list(_subset_problems(patch, _settings_values(after)))
    for p, want_value, got_value in mismatches:
        print(f"  {p}: просили {_show(p, want_value)}, "
              f"на станции {_show(p, got_value)}", file=sys.stderr)
    if mismatches:
        print(f"станция приняла не всё ({len(mismatches)} расхождений)",
              file=sys.stderr)
        return 1
    print("применено и сверено")
    return 0


# Границы контроллера, воспроизведённые здесь намеренно: и soul, и частоту он
# принимает молча — первый обрезается до предела, вторая откатывается к
# значению по умолчанию. Тихая порча персоны хуже отказа.
PERSONA_SOUL_MAX = 2000
PERSONA_FREQUENCIES = ("silent", "quiet", "moderate", "chatty", "aggressive")


def patch_persona(e: dict[str, str], persona_id: str, changes: dict,
                  dry_run: bool = False) -> int:
    """Правка одной персоны из живого состава.

    `settings.personas` — массив целиком, а не словарь по id: патч собирается
    из прочитанного состава с заменой одного элемента. Отправить только
    изменённую персону значит стереть остальных.
    """
    base, user, password = (e["SUBWAVE_URL"], e["SUBWAVE_ADMIN_USER"],
                            e["SUBWAVE_ADMIN_PASS"])
    # границы проверяются до чтения состава: незачем ходить на станцию за
    # данными, которые всё равно не будут записаны
    if "soul" in changes and len(changes["soul"]) > PERSONA_SOUL_MAX:
        print(f"soul длиной {len(changes['soul'])} символов — предел "
              f"{PERSONA_SOUL_MAX}, станция обрежет его молча", file=sys.stderr)
        return 1
    if "frequency" in changes and changes["frequency"] not in PERSONA_FREQUENCIES:
        print(f"frequency={changes['frequency']!r} — допустимы: "
              + ", ".join(PERSONA_FREQUENCIES), file=sys.stderr)
        return 1

    code, body = call(base, "/settings", user, password)
    problem = step_ok(code, body)
    if problem:
        print(f"состав персон не прочитан — {problem}", file=sys.stderr)
        return 1
    values = _settings_values(body)
    roster = values.get("personas") if isinstance(values, dict) else None
    if not isinstance(roster, list):
        print("в настройках нет массива personas", file=sys.stderr)
        return 1
    if not any(p.get("id") == persona_id for p in roster):
        print(f"персоны {persona_id!r} нет; есть: "
              + ", ".join(repr(p.get("id")) for p in roster), file=sys.stderr)
        return 1

    updated = [{**p, **changes} if p.get("id") == persona_id else p for p in roster]
    for key, value in changes.items():
        print(f"  {persona_id}.{key}: {_show(key, value)}")
    if dry_run:
        print("холостой прогон: ничего не отправлено")
        return 0

    code, body = call(base, "/settings", user, password, {"personas": updated})
    problem = step_ok(code, body)
    if problem:
        print(f"персона не сохранена — {problem}", file=sys.stderr)
        return 1
    print("применено")
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="первичная настройка subwave")
    p.add_argument("--export", metavar="FILE",
                   help="снять текущие настройки станции в файл и выйти")
    p.add_argument("--patch", metavar="FILE",
                   help="применить патч настроек из файла и выйти")
    p.add_argument("--dry-run", action="store_true",
                   help="с --patch и --persona: показать и ничего не отправлять")
    p.add_argument("--persona", metavar="ID",
                   help="правка одной персоны; поля — из --from")
    p.add_argument("--from", dest="changes", metavar="FILE",
                   help="с --persona: JSON с изменяемыми полями")
    args = p.parse_args(argv)
    if args.export:
        return export_settings(env(SUBWAVE_REQUIRED), args.export)
    if args.patch:
        return apply_patch(env(SUBWAVE_REQUIRED), args.patch, args.dry_run)
    if args.persona:
        if not args.changes:
            p.error("--persona требует --from FILE")
        with open(args.changes, encoding="utf-8") as fh:
            return patch_persona(env(SUBWAVE_REQUIRED), args.persona,
                                 json.load(fh), args.dry_run)
    return run(env(), os.environ.get("SUBWAVE_SETTINGS_FILE"))


if __name__ == "__main__":
    sys.exit(main())
