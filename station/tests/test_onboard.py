"""onboard.py: тело собирается сериализатором, а отказ шага останавливает настройку.

Прежний shell-вариант подставлял пароль в шаблон через `printf '%s'` (кавычка
ломала JSON) и не смотрел на HTTP-код: настройки сохранялись после неудавшейся
пробы подключения.
"""
import importlib.util
import io
import json
import re
import sys
import urllib.error
from pathlib import Path

import pytest

ONBOARD = Path(__file__).resolve().parent.parent / "onboard" / "onboard.py"
_spec = importlib.util.spec_from_file_location("subwave_onboard", ONBOARD)
onboard = importlib.util.module_from_spec(_spec)
sys.modules["subwave_onboard"] = onboard
_spec.loader.exec_module(onboard)

ENV = {"SUBWAVE_URL": "http://station:7700", "SUBWAVE_ADMIN_USER": "admin",
       "SUBWAVE_ADMIN_PASS": 'p"a\\ss', "NAVIDROME_URL": "http://nd:4533",
       "NAVIDROME_USER": "subwave", "NAVIDROME_PASS": 'секрет"с\\кавычкой',
       "LLM_BASE_URL": "https://llm/v1", "LLM_MODEL": "glm-5.3-flash",
       "LLM_API_KEY": "key\nwith\nnewlines"}


class FakeResponse(io.BytesIO):
    def __init__(self, body: bytes, status: int = 200):
        super().__init__(body)
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def api(monkeypatch):
    """Подменённый сервер: пишет запросы и отдаёт заготовленные ответы."""
    calls = []
    answers = {}

    def fake_urlopen(req, timeout=None):
        body = req.data.decode("utf-8") if req.data else None
        path = req.full_url.split("/api")[-1]
        method = req.get_method()
        calls.append({"url": req.full_url, "method": method,
                      "payload": json.loads(body) if body else None})
        # ключ-пара нужен там, где один путь отвечает по-разному на чтение и на
        # запись (/settings); одиночный путь остаётся запасным, поэтому тесты,
        # которым метод безразличен, задают ответ как задавали
        code, payload = answers.get((method, path)) or answers.get(path, (200, {"ok": True}))
        if code >= 400:
            raise urllib.error.HTTPError(req.full_url, code, "err", {},
                                         io.BytesIO(json.dumps(payload).encode()))
        return FakeResponse(json.dumps(payload).encode(), code)

    monkeypatch.setattr(onboard.urllib.request, "urlopen", fake_urlopen)
    return calls, answers


def test_secrets_with_quotes_survive_as_values(api):
    calls, _ = api
    assert onboard.run(ENV) == 0
    navidrome = calls[0]["payload"]
    assert navidrome["pass"] == 'секрет"с\\кавычкой'
    assert calls[1]["payload"]["apiKey"] == "key\nwith\nnewlines"


def test_http_error_on_probe_stops_before_saving(api):
    calls, answers = api
    answers["/onboarding/test-navidrome"] = (401, {"error": "unauthorized"})
    assert onboard.run(ENV) == 1
    assert [c["url"].split("/api")[-1] for c in calls] == ["/onboarding/test-navidrome"]


def test_failed_contract_on_probe_stops_before_saving(api):
    # subsonic-подобные API отвечают 200 и на отказ: смотреть надо и в тело
    calls, answers = api
    answers["/onboarding/test-llm"] = (200, {"ok": False, "error": "no such model"})
    assert onboard.run(ENV) == 1
    assert "/onboarding/save" not in [c["url"].split("/api")[-1] for c in calls]


def test_extra_settings_are_applied_after_save(api, tmp_path):
    calls, _ = api
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"tts": {"engine": "remote"}}), encoding="utf-8")
    assert onboard.run(ENV, str(settings)) == 0
    paths = [c["url"].split("/api")[-1] for c in calls]
    assert paths.index("/settings") > paths.index("/onboarding/save")


def test_masked_snapshot_is_not_applied_silently(api, tmp_path):
    # экспортированный снимок хранит секреты как ***; применить его как есть
    # значит записать станции заведомо неверный ключ. Отказ — до сохранения
    # onboarding: иначе станция осталась бы настроенной наполовину
    calls, _ = api
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"llm": {"apiKey": "***"}}), encoding="utf-8")
    assert onboard.run(ENV, str(settings)) == 1
    assert calls == []


def test_export_masks_secrets(api, tmp_path):
    _, answers = api
    answers["/settings"] = (200, {"llm": {"apiKey": "sk-real", "model": "glm"},
                                  "privacy": {"password": "hunter2"}})
    out = tmp_path / "snapshot.json"
    assert onboard.export_settings(ENV, str(out)) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert data["llm"]["apiKey"] == "***" and data["privacy"]["password"] == "***"
    assert data["llm"]["model"] == "glm"


def test_export_does_not_require_llm_and_navidrome(api, tmp_path, monkeypatch):
    # снимок ходит только в /settings под админом subwave: требовать ради него
    # ключ LLM значит запретить экспорт там, где ключа нет
    _, answers = api
    answers["/settings"] = (200, {"tts": {"engine": "remote"}})
    for key in ENV:
        monkeypatch.delenv(key, raising=False)
    for key in onboard.SUBWAVE_REQUIRED:
        monkeypatch.setenv(key, ENV[key])
    out = tmp_path / "snapshot.json"
    assert onboard.main(["--export", str(out)]) == 0
    assert json.loads(out.read_text(encoding="utf-8"))["tts"]["engine"] == "remote"


# ── снимок: GET /settings → файл → POST /settings ────────────────────────────
#
# `POST /settings` отвергает ВЕСЬ патч (400 `unknown settings keys`), если в нём
# есть хоть один ключ не из SETTINGS_PATCH_KEYS. А снимок раньше писал ответ
# GET целиком: обёртку `values`, `defaults`, `navidrome`, перечни движков — и
# производные `minTrackSeconds`/`boundaryFadeMinTrackSeconds` внутри `values`.
# Применить такой снимок было нельзя ни разу, причём отказ приходил уже после
# /onboarding/save.

PATCH_REGISTRY = (Path(__file__).resolve().parents[2] / "controller" / "src"
                  / "settings" / "patch-registry.ts")


def _live_settings_response() -> dict:
    """Ответ `GET /settings` той формы, что отдаёт routes/settings/core.ts."""
    values = {
        "jingleRatio": 4, "crossfadeDuration": 6,
        "minTrackSeconds": 12,                       # производное
        "boundaryFadeMinTrackSeconds": 45,           # производное
        "station": "AI радио",
        "llm": {"provider": "openai-compatible", "model": "dj", "apiKey": "set",
                "keys": {"openai-compatible": "set"}, "dailyTokenCap": 0,
                "maxOutputTokens": 0, "reasoning": True},
        "tts": {"defaultEngine": "remote", "cloud": {"apiKey": "", "compatApiKey": ""}},
        "privacy": {"privatePlayer": False, "password": "set"},
        "personas": [{"id": "p_ru", "name": "Ведущая"}],
    }
    return {"autoPick": True, "streamOnAir": True,
            "navidrome": {"url": "http://nd:4533", "user": "subwave", "passSet": True},
            "values": values,
            "defaults": {"llm": {}, "tts": {}},
            "tts": {"engines": ["piper", "remote"]},
            "llm": {"providers": ["ollama"], "active": "openai-compatible:dj"},
            "env": {"OPENAI_API_KEY": False}}


def test_patch_keys_match_the_controller_registry():
    # копия списка — чтобы снимок не зависел от node; сверка с исходником
    # контроллера ловит дрейф после слияния апстрима сразу, а не на станции
    text = PATCH_REGISTRY.read_text(encoding="utf-8")
    m = re.search(r"export const SETTINGS_PATCH_KEYS = \[(.*?)\] as const;", text, re.S)
    assert m, "SETTINGS_PATCH_KEYS не найден в patch-registry.ts"
    body = re.sub(r"//[^\n]*", "", m.group(1))
    upstream = re.findall(r"'([^']+)'", body)
    assert upstream, "список ключей пуст — разбор сломался"
    assert sorted(onboard.SETTINGS_PATCH_KEYS) == sorted(upstream)


def test_export_writes_only_postable_keys_from_values(api, tmp_path):
    _, answers = api
    answers["/settings"] = (200, _live_settings_response())
    out = tmp_path / "snapshot.json"
    assert onboard.export_settings(ENV, str(out)) == 0
    data = json.loads(out.read_text(encoding="utf-8"))
    assert set(data) <= set(onboard.SETTINGS_PATCH_KEYS)
    assert "minTrackSeconds" not in data and "boundaryFadeMinTrackSeconds" not in data
    # llm — из values, а не одноимённый перечень провайдеров из корня ответа
    assert data["llm"]["model"] == "dj" and "providers" not in data["llm"]
    assert data["station"] == "AI радио"


def test_numbers_under_token_names_are_not_masked(api, tmp_path):
    # «token» в имени dailyTokenCap/maxOutputTokens — не секрет; звёздочки на
    # месте числа делали любой снимок «замаскированным», и run() его не брал
    _, answers = api
    answers["/settings"] = (200, _live_settings_response())
    out = tmp_path / "snapshot.json"
    assert onboard.export_settings(ENV, str(out)) == 0
    llm = json.loads(out.read_text(encoding="utf-8"))["llm"]
    assert llm["dailyTokenCap"] == 0 and llm["maxOutputTokens"] == 0
    assert llm["apiKey"] == "***"


def test_exported_snapshot_applies_after_secrets_are_filled(api, tmp_path):
    calls, answers = api
    answers[("GET", "/settings")] = (200, _live_settings_response())
    out = tmp_path / "snapshot.json"
    assert onboard.export_settings(ENV, str(out)) == 0
    # оператор подставляет секреты вместо ***
    filled = out.read_text(encoding="utf-8").replace('"***"', '"secret-value"')
    out.write_text(filled, encoding="utf-8")
    calls.clear()
    assert onboard.run(ENV, str(out)) == 0
    posted = [c for c in calls if c["method"] == "POST"
              and c["url"].endswith("/api/settings")]
    assert len(posted) == 1
    assert set(posted[0]["payload"]) <= set(onboard.SETTINGS_PATCH_KEYS)


def test_unknown_keys_are_named_before_anything_is_sent(api, tmp_path, capsys):
    # снимок старого формата (ответ GET целиком): контроллер отверг бы его
    # 400, но уже после /onboarding/save — половина настройки легла бы
    calls, _ = api
    settings = tmp_path / "settings.json"
    settings.write_text(json.dumps({"values": {}, "minTrackSeconds": 12,
                                    "tts": {"engine": "remote"}}), encoding="utf-8")
    assert onboard.run(ENV, str(settings)) == 1
    assert calls == []
    err = capsys.readouterr().err
    assert "minTrackSeconds" in err and "values" in err


def test_missing_environment_is_named(monkeypatch):
    monkeypatch.delenv("SUBWAVE_URL", raising=False)
    for key, value in ENV.items():
        monkeypatch.setenv(key, value)
    monkeypatch.delenv("LLM_API_KEY")
    with pytest.raises(SystemExit) as e:
        onboard.env()
    assert "LLM_API_KEY" in str(e.value)


# ── --patch: применение патча настроек ───────────────────────────────────────

PATCH_ENV = {"SUBWAVE_URL": "http://station:7700",
             "SUBWAVE_ADMIN_USER": "admin", "SUBWAVE_ADMIN_PASS": "p"}


def test_patch_is_verified_by_reading_settings_back(api, tmp_path):
    # POST /settings отвечает 200 и тогда, когда значение отброшено или зажато;
    # «применено» означает «прочитано обратно и совпало», а не код ответа
    calls, answers = api
    answers[("GET", "/settings")] = (200, {"tts": {"gainDb": {"remote": 6}}})
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"tts": {"gainDb": {"remote": 6}}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 0
    assert [c["method"] for c in calls] == ["POST", "GET"]


def test_patch_that_did_not_stick_is_a_failure(api, tmp_path):
    calls, answers = api
    # просили +12, станция зажала до +6 — молчаливое расхождение, ради которого
    # чтение обратно и делается
    answers[("GET", "/settings")] = (200, {"tts": {"gainDb": {"remote": 6}}})
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"tts": {"gainDb": {"remote": 12}}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 1


def test_patch_keeps_cyrillic_intact(api, tmp_path):
    # curl -d из Git Bash приводит русский текст к ?????; тело собирает Python
    calls, answers = api
    text = "Ведущий с тонким чувством юмора"
    answers[("GET", "/settings")] = (200, {"djHouseRules": text})
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"djHouseRules": text}, ensure_ascii=False),
                     encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 0
    assert calls[0]["payload"]["djHouseRules"] == text


def test_masked_patch_is_refused(api, tmp_path):
    # патч, снятый через --export, хранит секреты как ***; применить его как
    # есть значит записать станции заведомо неверный ключ
    calls, _ = api
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"llm": {"apiKey": "***"}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 1
    assert calls == []


def test_dry_run_sends_nothing(api, tmp_path):
    calls, _ = api
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"djSpeakClock": False}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch), dry_run=True) == 0
    assert calls == []


# ── --persona: правка одной персоны в составе ────────────────────────────────

ROSTER = {"personas": [
    {"id": "p_ru", "name": "Ведущий", "frequency": "moderate", "soul": "старое"},
    {"id": "p_en", "name": "Host", "frequency": "quiet", "soul": "keep me"},
]}


def test_persona_patch_keeps_the_rest_of_the_roster(api):
    # personas — массив целиком: отправить один элемент значит стереть остальных
    calls, answers = api
    answers[("GET", "/settings")] = (200, ROSTER)
    assert onboard.patch_persona(PATCH_ENV, "p_ru", {"frequency": "chatty"}) == 0
    sent = [c for c in calls if c["method"] == "POST"][0]["payload"]["personas"]
    assert [p["id"] for p in sent] == ["p_ru", "p_en"]
    assert sent[0]["frequency"] == "chatty"
    assert sent[1] == ROSTER["personas"][1]


def test_persona_patch_preserves_untouched_fields(api):
    calls, answers = api
    answers[("GET", "/settings")] = (200, ROSTER)
    onboard.patch_persona(PATCH_ENV, "p_ru", {"frequency": "chatty"})
    sent = [c for c in calls if c["method"] == "POST"][0]["payload"]["personas"]
    assert sent[0]["name"] == "Ведущий" and sent[0]["soul"] == "старое"


def test_unknown_persona_is_refused_before_writing(api):
    calls, answers = api
    answers[("GET", "/settings")] = (200, ROSTER)
    assert onboard.patch_persona(PATCH_ENV, "p_nope", {"frequency": "chatty"}) == 1
    assert [c["method"] for c in calls] == ["GET"]


def test_soul_over_the_cap_is_refused_not_truncated(api):
    # контроллер режет soul до 2000 молча; отказ лучше тихой обрезки персоны
    calls, answers = api
    answers[("GET", "/settings")] = (200, ROSTER)
    assert onboard.patch_persona(PATCH_ENV, "p_ru", {"soul": "я" * 2001}) == 1
    assert calls == []


def test_bad_frequency_is_refused(api):
    calls, answers = api
    answers[("GET", "/settings")] = (200, ROSTER)
    assert onboard.patch_persona(PATCH_ENV, "p_ru", {"frequency": "loud"}) == 1
    assert calls == []


# ── форма ответа живой станции: запись плоская, чтение завёрнуто ─────────────
#
# Снимок с <station-host>:7700 от 2026-09-21: `GET /settings` отдаёт настройки не
# в корне, а в `values`, рядом с `defaults`, `env` и метаданными. В корне при
# этом лежит СВОЙ `llm` — перечень провайдеров и активная связка, — поэтому
# наивная сверка с корнем не просто не находит ключей, а сверяется с чужими.
# `POST` остаётся плоским: рабочие примеры в README — `{"llm":{"reasoning":true}}`.


def _wrapped(values: dict) -> dict:
    return {"values": values,
            "defaults": {"llm": {}, "tts": {}},
            "env": {"OPENAI_API_KEY": ""},
            "llm": {"providers": ["ollama", "openai-compatible"],
                    "active": "openai-compatible:chat"}}


def test_patch_is_verified_against_values_not_the_envelope(api, tmp_path):
    calls, answers = api
    answers[("GET", "/settings")] = (200, _wrapped({"tts": {"gainDb": {"remote": 6}}}))
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"tts": {"gainDb": {"remote": 6}}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 0


def test_patch_that_did_not_stick_is_caught_inside_values(api, tmp_path):
    # просили +12, станция зажала до +6 — расхождение должно находиться и
    # тогда, когда настройки лежат под обёрткой
    calls, answers = api
    answers[("GET", "/settings")] = (200, _wrapped({"tts": {"gainDb": {"remote": 6}}}))
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"tts": {"gainDb": {"remote": 12}}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 1


def test_llm_patch_is_not_compared_with_the_provider_list(api, tmp_path):
    # в корне ответа `llm` — это {providers, active}; сверка с ним объявила бы
    # неприменённой любую правку llm, включая успешную
    calls, answers = api
    answers[("GET", "/settings")] = (200, _wrapped({"llm": {"reasoning": True}}))
    patch = tmp_path / "p.json"
    patch.write_text(json.dumps({"llm": {"reasoning": True}}), encoding="utf-8")
    assert onboard.apply_patch(PATCH_ENV, str(patch)) == 0


def test_persona_roster_is_read_from_values(api):
    calls, answers = api
    answers[("GET", "/settings")] = (200, _wrapped(ROSTER))
    assert onboard.patch_persona(PATCH_ENV, "p_ru", {"frequency": "chatty"}) == 0
    sent = [c for c in calls if c["method"] == "POST"][0]["payload"]["personas"]
    assert [p["id"] for p in sent] == ["p_ru", "p_en"]
    assert sent[0]["frequency"] == "chatty"
