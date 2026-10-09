# Станция: проверки и настройки (ярусы 0–1) — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Дать проекту воспроизводимый способ менять настройки живой станции и применить им пять правок эфира (громкость ведущего, частота реплик, юмор, цензура, заказы), предварительно выяснив три факта, без которых часть решений была бы гаданием.

**Architecture:** Никакого нового кода на стороне станции: всё делается через `POST /api/settings` и `GET /api/settings`, которые отвечают по HTTP на `<station-host>:7700`. SSH и пересборка образов **не нужны** — они понадобятся только ярусам 3 и 4. Инструмент — расширение существующего [`station/onboard/onboard.py`](../../../station/onboard/onboard.py), а не второй скрипт рядом.

**Tech Stack:** Python 3 (стандартная библиотека, без зависимостей), pytest, HTTP API subwave v1.8.0.

**Spec:** [`docs/superpowers/specs/2026-09-21-radio-upgrades-design.md`](../specs/2026-09-21-radio-upgrades-design.md) — ярусы 0 и 1 раздела 12.

## Состояние на 2026-09-21

| Задача | Состояние | Коммит |
|---|---|---|
| 1. `onboard.py --patch` | **готово**, плюс исправлен дефект сверки (см. ниже) | `093aff7` |
| 2. `onboard.py --persona` | **готово**, плюс тот же дефект | `093aff7` |
| 3. Ярус 0 — три проверки | **готово**, симптом на Android записан находкой | `cd62154` |
| 4. Пункты 1, 4, 7 | **применено и сверено**; шаги 5–6 — проверка на слух за владельцем | `fd1a73e` |
| 5. Пункт 5 — юмор | **применено и сверено**; шаг 5 — проверка на слух за владельцем | `47bcff8` |
| 6. Пункт 6 — отказы модели | **готово**: правила дома заведены, замер — 0 отказов из 6 | `bb58f3d` |
| 7. Пункт 12 — громкость файлов | **готово**: ветка «разметка», вынесена в `IDEAS.md` | `cc71ac7` |
| 8. Документация | **готово** | `aa66be8` |

Ветка — `main`. Быстрый набор: **200 passed**, время см. ниже.

**Про ветку `station-settings`.** Она существует на `origin` и несёт коммиты `ad6aaa5`,
`363a000`, `5d4361a`, `6837cbc` — задачи 1, 2 и 8 и простановку чекбоксов. В **локальном**
клоне на <workstation> её не было, а та же работа лежала в рабочем дереве незакоммиченной, и
исполнение пошло от неё: задачи 1–8 закоммичены в `main` заново, поверх них лёг фикс
сверки. Содержимое `station-settings` в `main` таким образом вошло целиком (сверено
построчно), но **другими коммитами**. Ветку можно удалять как поглощённую — сливать её в
`main` не нужно, это даст дубли.

## Что выяснилось при исполнении и меняет план

1. **Блокировки не было.** `SUBWAVE_ADMIN_PASS` и `NAVIDROME_ADMIN_PASS` лежат в vault
   `_boss` на рабочей машине. Утверждение «vault на рабочей машине отсутствует» неверно.
2. **Задачи 1 и 2 содержали дефект, который сорвал бы задачу 4.** Запись и чтение у
   станции несимметричны: `POST` принимает патч плоским, `GET` возвращает настройки
   завёрнутыми в `values`, а в корне держит **свои** `llm` и `tts` — перечень
   провайдеров и список движков. `apply_patch` сверял патч с корнем и на живой станции
   объявил бы неприменённым успешно записанное; `patch_persona` по той же причине искал
   состав персон не там и отвечал «в настройках нет массива personas». Тесты этого не
   ловили: моки воспроизводили плоский `GET`, которого у станции нет. Исправлено
   (`_settings_values()`), добавлено 4 теста на реальную форму ответа.
3. **Развилка задачи 6 закрыта третьим исходом.** Станция просит роль `chat`, и шлюз её
   выдаёт: `/api/doctor` — `openai-compatible:chat · reachable`, `0/20 failed`,
   `1/3002 calls errored`. Чинить в шлюзе нечего. Находка об обратном опровергнута и
   уехала в `FINDINGS-archive.md`: она опиралась на `llm_routers/gateway/consumers.yaml`,
   которого на рабочей машине нет.
4. **ReplayGain нет ни у одного трека** (0 из 300) — задача 7 пошла в ветку «разметка».
5. **`djHouseRules` на станции были пусты (0 символов)** — то есть главный рычаг пункта 6
   не был даже тронут, а не «не подействовал».
6. **У `/api/dj/segment` поле называется `type`, а не `kind`.** План предполагал `kind`;
   станция на него отвечает `400` со списком допустимых значений: `station-id`, `hourly`,
   `link`, `banter`, `programme-intro`, `programme-feature`, `programme-outro`.
7. **Отказов воспроизвести не удалось: 6 из 6 подводок успешны.** Замер сделан с
   разрешения владельца, 15.7–23.7 с на генерацию. Числа «до» не существует — правила
   дома были применены раньше, чем появилось разрешение дёргать генерацию, — и все шесть
   пришлись на один трек (`Depeche Mode — It's No Good`), на котором отказу взяться
   неоткуда. Пункт закрыт как «отказов не видно», а не как «отказы устранены».
8. **Симптом на Android оказался не тем, что предполагал ярус 2.** Клиент — **Firefox**
   (не Chrome и не установленное PWA), звук пропадает **спустя несколько минут**, а
   локскрин не показывает плеера **вовсе**. Работа по локскрину в проекте уже делалась
   (`e1af892`), то есть разбирать надо разницу движков, а не заводить задачу с нуля.
   Записано находкой в `FINDINGS.md`.

**Чем разблокируется остаток:** только проверкой на слух — шаги 5–6 задачи 4 (громкость
ведущего, два заказа подряд с одного устройства) и шаг 5 задачи 5 (юмор в подводках).

## Global Constraints

- **Кириллицу отправлять только телом из Python**, никогда `curl -d "…"` из Git Bash: русский текст приводится к `?????`. Правило проекта, уже обожглись на названии шоу.
- **`POST /settings` — частичный патч по верхнеуровневым ключам**, но `personas` — **массив целиком**: отправить один элемент значит стереть остальных.
- **Ответ 200 не значит «применено»**: незнакомый вложенный ключ контроллер отбрасывает молча, число вне границ зажимает. Проверка — только чтением обратно.
- **`persona.soul` — максимум 2000 символов, лишнее обрезается молча** (`PERSONA_SOUL_MAX`). То же у `djHouseRules` (`SETTINGS_DJ_HOUSE_RULES_MAX = 2000`).
- **`tts.gainDb` зажимается в ±12 dB** (`TTS_GAIN_CLAMP_DB = 12`).
- **`persona.frequency` — одно из** `silent`, `quiet`, `moderate`, `chatty`, `aggressive`.
- **Ручки `humour`, `warmth`, `localColour` в v1.8.0 никуда не доезжают.** Они хранятся, валидируются (0–10, нейтраль 5) и показываются в админке, но ни один сборщик промпта их не читает: среди плейсхолдеров есть `{soul}`, `{house}`, `{djName}`, `{language}` — и нет ни одного из дисков. Крутить их бесполезно; юмор задаётся текстом.
- Быстрый набор `pytest` — бюджет 60 с. Всё, что ходит по сети, — под маркером `integration`.
- Секреты в репозиторий не попадают: значения берутся из окружения, как уже устроен `onboard.py`.

## Предусловие, без которого план не стартует

Нужен **пароль админки subwave** (`SUBWAVE_ADMIN_PASS`, vault `_boss`) и, для задачи 3, пароль читающей учётки Navidrome. В `~/.claude/.env` их нет. Задача 1 и 2 пишутся и тестируются без них; задачи 3–7 без пароля выполнить нельзя.

> **Снято 2026-09-21.** Предусловие выполнено: оба пароля лежат в
> `_boss/secrets/vault.env` под именами `SUBWAVE_ADMIN_USER`/`SUBWAVE_ADMIN_PASS` и
> `NAVIDROME_ADMIN_USER`/`NAVIDROME_ADMIN_PASS`. Искать их в `~/.claude/.env` было
> незачем — канонический источник секретов во всех проектах один, это vault `_boss`.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `station/onboard/onboard.py` (правка) | + `--patch FILE` и `--persona ID --from FILE`; существующие режимы не трогаются |
| `tests/test_onboard.py` (правка) | фикстура учится различать метод; тесты на применение патча и правку персоны |
| `station/onboard/patches/2026-09-21-voice-and-requests.json` (создать) | патч настроек под версионированием: что именно было применено и когда |
| `station/onboard/persona-ru.md` (правка) | текст персоны: юмор вместо запрета на шутки |
| `station/docs/deploy.md` (правка) | новый режим инструмента, результаты проверок, состояние станции |
| `FINDINGS.md` (правка) | закрытие находки про роль LLM по результату задачи 3 |

---

### Task 1: `onboard.py --patch` — применение патча с чтением обратно

**Files:**
- Modify: `station/onboard/onboard.py`
- Test: `tests/test_onboard.py`

**Interfaces:**
- Consumes: существующие `call()`, `step_ok()`, `mask()`, `_flatten()`, `env()`, `SUBWAVE_REQUIRED`, `SECRET_KEYS` из `onboard.py`.
- Produces: `_subset_problems(want: dict, got: dict, prefix: str = "") -> Iterator[tuple[str, object, object]]`, `_show(path: str, value) -> str`, `apply_patch(e: dict[str, str], path: str, dry_run: bool = False) -> int`, флаги CLI `--patch FILE` и `--dry-run`.

- [x] **Шаг 1: Научить фикстуру различать метод запроса**

GET и POST на `/settings` сейчас неразличимы — фикстура ключуется только путём, а задаче нужно отдать на POST одно, на GET другое. Ключ становится парой, со старым ключом как запасным, поэтому восемь существующих тестов продолжают работать без правок.

В `tests/test_onboard.py` заменить тело `fake_urlopen` внутри фикстуры `api`:

```python
    def fake_urlopen(req, timeout=None):
        body = req.data.decode("utf-8") if req.data else None
        path = req.full_url.split("/api")[-1]
        method = req.get_method()
        calls.append({"url": req.full_url, "method": method,
                      "payload": json.loads(body) if body else None})
        # ключ-пара нужен там, где один путь отвечает по-разному на чтение и на
        # запись (/settings); одиночный путь остаётся запасным, поэтому старые
        # тесты его и продолжают задавать
        code, payload = answers.get((method, path)) or answers.get(path, (200, {"ok": True}))
        if code >= 400:
            raise urllib.error.HTTPError(req.full_url, code, "err", {},
                                         io.BytesIO(json.dumps(payload).encode()))
        return FakeResponse(json.dumps(payload).encode(), code)
```

- [x] **Шаг 2: Убедиться, что существующие тесты не сломались**

Run: `pytest tests/test_onboard.py -v`
Expected: PASS, 8 тестов. — **получено: 8 passed.**

- [x] **Шаг 3: Написать падающие тесты**

Добавить в конец `tests/test_onboard.py`:

```python
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
```

- [x] **Шаг 4: Запустить и убедиться, что падают**

Run: `pytest tests/test_onboard.py -k patch -v`
Expected: FAIL — `AttributeError: module 'subwave_onboard' has no attribute 'apply_patch'`. — **получено ровно это, 4 failed** (`test_dry_run_sends_nothing` под `-k patch` не попадает).

- [x] **Шаг 5: Реализовать**

В `station/onboard/onboard.py`, после `export_settings`:

```python
def _show(path: str, value) -> str:
    """Значение для вывода: секрет по имени последнего сегмента — звёздочками."""
    leaf = path.rsplit(".", 1)[-1].lower()
    if any(s in leaf for s in SECRET_KEYS):
        return "***"
    return json.dumps(value, ensure_ascii=False)


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

    mismatches = list(_subset_problems(patch, after))
    for p, want_value, got_value in mismatches:
        print(f"  {p}: просили {_show(p, want_value)}, "
              f"на станции {_show(p, got_value)}", file=sys.stderr)
    if mismatches:
        print(f"станция приняла не всё ({len(mismatches)} расхождений)",
              file=sys.stderr)
        return 1
    print("применено и сверено")
    return 0
```

В `main()` заменить разбор аргументов:

```python
def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="первичная настройка subwave")
    p.add_argument("--export", metavar="FILE",
                   help="снять текущие настройки станции в файл и выйти")
    p.add_argument("--patch", metavar="FILE",
                   help="применить патч настроек из файла и выйти")
    p.add_argument("--dry-run", action="store_true",
                   help="с --patch: показать патч и ничего не отправлять")
    args = p.parse_args(argv)
    if args.export:
        return export_settings(env(SUBWAVE_REQUIRED), args.export)
    if args.patch:
        return apply_patch(env(SUBWAVE_REQUIRED), args.patch, args.dry_run)
    return run(env(), os.environ.get("SUBWAVE_SETTINGS_FILE"))
```

- [x] **Шаг 6: Запустить тесты**

Run: `pytest tests/test_onboard.py -v`
Expected: PASS, 13 тестов. — **получено: 13 passed.**

- [x] **Шаг 7: Коммит**

```bash
git add station/onboard/onboard.py tests/test_onboard.py
git commit -m "onboard: режим --patch, где применено значит прочитано обратно"
```

---

### Task 2: `onboard.py --persona` — правка одной персоны в составе

**Files:**
- Modify: `station/onboard/onboard.py`
- Test: `tests/test_onboard.py`

**Interfaces:**
- Consumes: `call()`, `step_ok()`, `env()`, `apply_patch`-соседи из задачи 1.
- Produces: `patch_persona(e: dict[str, str], persona_id: str, changes: dict, dry_run: bool = False) -> int`, флаги CLI `--persona ID` и `--from FILE`.

Отдельный режим нужен потому, что `personas` — массив целиком. Собрать патч руками значит либо переписать весь состав, либо стереть его.

- [x] **Шаг 1: Написать падающие тесты**

Добавить в `tests/test_onboard.py`:

> **Поправка по ходу выполнения.** Два последних теста в черновике плана ожидали
> `[c["method"] for c in calls] == ["GET"]`, но проверки длины `soul` и допустимости
> частоты в реализации идут **до** чтения состава — ходить на станцию за данными,
> которые всё равно не будут записаны, незачем. Верное ожидание — `calls == []`,
> и ниже стоит уже оно.

```python
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
```

- [x] **Шаг 2: Запустить и убедиться, что падают**

Run: `pytest tests/test_onboard.py -k persona -v`
Expected: FAIL — `AttributeError: … has no attribute 'patch_persona'`. — **получено ровно это, 3 failed** (два теста с отказом до запроса под `-k persona` не попадают).

- [x] **Шаг 3: Реализовать**

В `station/onboard/onboard.py` дописать рядом с `apply_patch`:

```python
# Границы контроллера, воспроизведённые здесь намеренно: и soul, и частота
# принимаются им молча — первый обрезается до предела, вторая откатывается
# к значению по умолчанию. Тихая порча персоны хуже отказа.
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
    roster = body.get("personas") if isinstance(body, dict) else None
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
```

В `main()` добавить флаги перед `args = p.parse_args(argv)`:

```python
    p.add_argument("--persona", metavar="ID",
                   help="правка одной персоны; поля — из --from")
    p.add_argument("--from", dest="changes", metavar="FILE",
                   help="с --persona: JSON с изменяемыми полями")
```

и ветку после ветки `--patch`:

```python
    if args.persona:
        if not args.changes:
            p.error("--persona требует --from FILE")
        with open(args.changes, encoding="utf-8") as fh:
            return patch_persona(env(SUBWAVE_REQUIRED), args.persona,
                                 json.load(fh), args.dry_run)
```

- [x] **Шаг 4: Запустить тесты**

Run: `pytest tests/test_onboard.py -v`
Expected: PASS, 18 тестов. — **получено: 18 passed.**

- [x] **Шаг 5: Проверить бюджет быстрого набора**

Run: `pytest`
Expected: PASS, 196 тестов (сейчас собирается 186), укладывается в 60 с. — **получено: 196 passed за 6.81 с, самый долгий тест 0.12 с.**

- [x] **Шаг 6: Коммит**

```bash
git add station/onboard/onboard.py tests/test_onboard.py
git commit -m "onboard: правка одной персоны без затирания состава"
```

---

### Task 3: Ярус 0 — три проверки, ничего не меняющие

**Files:**
- Modify: `FINDINGS.md`
- Modify: `station/docs/deploy.md`

Ни одна из проверок ничего не записывает на станцию. Их результат — входные данные для задач 6 и 7, и до них обе задачи были бы гаданием.

- [x] **Шаг 1: Подготовить окружение**

```bash
export SUBWAVE_URL=http://<station-host>:7700
export SUBWAVE_ADMIN_USER=admin
export SUBWAVE_ADMIN_PASS=<из vault _boss>
```

- [x] **Шаг 2: Снять снимок настроек станции**

```bash
python station/onboard/onboard.py --export /tmp/settings-2026-09-21.json
```

Expected: файл записан, секреты заменены на `***`.

- [x] **Шаг 3: Выяснить, куда станция ходит за LLM (пункт 6)**

```bash
python - <<'PY'
import json
s = json.load(open('/tmp/settings-2026-09-21.json', encoding='utf-8'))
llm = s.get('llm', {})
print('model   :', llm.get('model'))
print('baseUrl :', llm.get('baseUrl'))
print('fallback:', json.dumps(llm.get('fallback'), ensure_ascii=False))
PY
```

Сверить `model` с реестром: в `llm_routers/gateway/consumers.yaml` у потребителя `music-subwave` сейчас `roles: [dj, chat-reserve, embed]`. Три исхода:

- `model` = `dj` — README устарел, находку закрыть правкой документации;
- `model` = `chat` — станция просит роль, которой ей не выдали. Это **поломка**, а не документация: завести отдельную находку P1 и чинить до всего остального;
- `model` — что-то ещё: записать как есть и разбираться.

- [x] **Шаг 4: Выяснить, есть ли ReplayGain в коллекции (пункт 12)**

Через Navidrome, не трогая шару:

```bash
python - <<'PY'
import hashlib, json, os, random, urllib.request
base = 'http://<station-host>:4533'
user, password = os.environ['NAVIDROME_USER'], os.environ['NAVIDROME_PASS']
salt = 'musicplan'
token = hashlib.md5((password + salt).encode()).hexdigest()
auth = f'u={user}&t={token}&s={salt}&v=1.16.1&c=music&f=json'
url = f'{base}/rest/search3?query=&songCount=200&artistCount=0&albumCount=0&{auth}'
songs = json.load(urllib.request.urlopen(url, timeout=30))['subsonic-response']['searchResult3']['song']
with_rg = [s for s in songs if s.get('replayGain', {}).get('trackGain') is not None]
print(f'выборка: {len(songs)}, с ReplayGain: {len(with_rg)}')
for s in random.sample(songs, min(5, len(songs))):
    print(' ', s.get('artist'), '—', s.get('title'), s.get('replayGain'))
PY
```

Три исхода: тег у всех (пункт 12 закрывается рескансом Navidrome), у части (это и есть симптом — нужна разметка, ярус 2), ни у кого (то же, разметка).

- [x] **Шаг 5: Записать симптом пункта 2**

Спросить у заказчика и записать дословно в `FINDINGS.md` как открытую находку P2: обрывается звук сразу при сворачивании или спустя время; что показывает экран блокировки; браузер это или установленное приложение; какая версия Android. Без этих четырёх ответов диагностика яруса 2 начинается с гадания.

- [x] **Шаг 6: Зафиксировать результаты**

Обновить в `station/docs/deploy.md` строку «LLM» таблицы «Состояние» фактическим значением из шага 3. Закрыть или переписать находку про роль `chat` в `FINDINGS.md` по правилу проекта: выполненная — удаляется, отклонённая — переезжает в `FINDINGS-archive.md` через дописывание.

- [x] **Шаг 7: Коммит**

```bash
git add FINDINGS.md station/docs/deploy.md
git commit -m "Ярус 0: куда станция ходит за LLM и есть ли в коллекции ReplayGain"
```

---

### Task 4: Пункты 1, 4, 7 — громкость ведущего, частота реплик, заказы

**Files:**
- Create: `station/onboard/patches/2026-09-21-voice-and-requests.json`
- Modify: `station/docs/deploy.md`

Патч кладётся в репозиторий, а не набирается в консоли: применённое должно быть видно в `git log`, иначе через месяц никто не вспомнит, почему у ведущего +6 dB.

- [x] **Шаг 1: Создать патч**

`station/onboard/patches/2026-09-21-voice-and-requests.json`:

```json
{
  "tts": {
    "gainDb": { "remote": 6, "piper": 6 }
  },
  "requests": {
    "onePendingPerIp": false,
    "perIpHourlyCap": 30,
    "cooldownSec": 15,
    "maxPending": 12
  }
}
```

`piper` поднимается вместе с `remote`: это запасной движок, и при падении мостика ведущий не должен внезапно становиться вдвое тише. Лимиты заказов подняты, а не сняты: `perIpHourlyCap: 0` отключил бы защиту целиком, а снаружи все слушатели приходят одним адресом — потолок нужен, просто семейный, а не одиночный.

- [x] **Шаг 2: Холостой прогон**

```bash
python station/onboard/onboard.py --patch station/onboard/patches/2026-09-21-voice-and-requests.json --dry-run
```

Expected: патч напечатан, «холостой прогон: ничего не отправлено».

- [x] **Шаг 3: Применить**

```bash
python station/onboard/onboard.py --patch station/onboard/patches/2026-09-21-voice-and-requests.json
```

Expected: «применено и сверено». Расхождение по `tts.gainDb` означало бы, что сработал кламп ±12 dB — но 6 в него укладывается.

- [x] **Шаг 4: Поднять частоту реплик**

```bash
echo '{"frequency": "chatty"}' > /tmp/freq.json
python station/onboard/onboard.py --persona p_ru --from /tmp/freq.json
```

Expected: «применено». `chatty` — подводка раз в 1–5 треков вместо 1–9 у `moderate`. `aggressive` (1–3) намеренно не берём: это уже коммерческая FM, от которой персона отталкивается.

- [ ] **Шаг 5: Проверить на слух**

Послушать `https://<station-domain>` два-три перехода. Критерий громкости — ведущий разборчив без прибавления звука; критерий частоты — реплика звучит чаще, чем раз в четыре трека.

Если ведущий всё ещё тих: поднять до +12 тем же патчем. Если и этого мало — рычаг вне досягаемости, он в глубине дакинга `radio.liq` (контейнер `broadcast`, мы его не собираем). Не подгонять, а записать находкой и вынести отдельным решением.

- [ ] **Шаг 6: Проверить заказы**

Сделать два заказа подряд с одного устройства, не дожидаясь, пока первый отыграет. Expected: оба приняты.

- [x] **Шаг 7: Коммит**

```bash
git add station/onboard/patches/2026-09-21-voice-and-requests.json station/docs/deploy.md
git commit -m "Громкость ведущего +6 dB, подводка чаще, заказы больше не по одному на адрес"
```

---

### Task 5: Пункт 5 — ведущий с тонким чувством юмора

**Files:**
- Modify: `station/onboard/persona-ru.md`
- Create: `/tmp/persona.json` (не коммитится)

Ручка `humour` не используется — см. Global Constraints. Работает только текст: `persona.soul` и `settings.djHouseRules`.

- [x] **Шаг 1: Переписать текст персоны**

В `station/onboard/persona-ru.md` заменить абзац «Как говорить» и строку про паузу. Было:

```
Реплика между треками — одна-две
фразы, изредка три. Пауза лучше, чем натянутая шутка.
```

Стало:

```
Реплика между треками — одна-две
фразы, изредка три.

**Юмор.** Сухой и негромкий: ирония, неожиданное сопоставление, короткое
замечание в сторону. Не каламбур, не анекдот, не подмигивание в зал. Шутка —
примерно в каждой третьей реплике, а не в каждой: то, что смешно всегда,
перестаёт быть смешным. Если шутка натянутая — лучше просто объявить трек.
```

Убрать из «Чего не делать» строку, которая теперь противоречит: `Не оценивать вкус слушателя` остаётся, а запрет на шутки уходит.

- [x] **Шаг 2: Проверить длину**

```bash
python - <<'PY'
import re, pathlib
text = pathlib.Path('station/onboard/persona-ru.md').read_text(encoding='utf-8')
soul = text.split('---', 1)[1].strip()
print('символов:', len(soul), '— предел 2000')
assert len(soul) <= 2000, 'станция обрежет молча'
PY
```

Expected: не больше 2000.

- [x] **Шаг 3: Применить**

```bash
python - <<'PY'
import json, pathlib
soul = pathlib.Path('station/onboard/persona-ru.md').read_text(encoding='utf-8').split('---', 1)[1].strip()
pathlib.Path('/tmp/persona.json').write_text(json.dumps({'soul': soul}, ensure_ascii=False), encoding='utf-8')
PY
python station/onboard/onboard.py --persona p_ru --from /tmp/persona.json
```

Expected: «применено».

- [x] **Шаг 4: Проверить, что станция отдаёт новый текст**

```bash
curl -s http://<station-host>:7700/api/dj | python -c "import json,sys; print(json.load(sys.stdin)['soul'])"
```

Expected: новый текст целиком, без обрезки по 2000.

- [ ] **Шаг 5: Послушать**

Три-четыре подводки подряд. Критерий: шутка есть, но не в каждой реплике, и не в формате «вау, какой мощнейший трек». Если модель шутит натужно в каждой — снизить до «примерно в каждой четвёртой» и применить снова.

- [x] **Шаг 6: Коммит**

```bash
git add station/onboard/persona-ru.md
git commit -m "Персона: сухой юмор вместо запрета на шутки"
```

---

### Task 6: Пункт 6 — отказы модели

**Files:**
- Modify: `station/docs/deploy.md`
- Возможно: `station/onboard/patches/2026-09-21-llm-role.json`

Задача целиком зависит от исхода шага 3 задачи 3 и ветвится по нему. Фильтра лексики в subwave нет ни одного — отказы приходят от модели.

- [x] **Шаг 1: Воспроизвести отказ**

```bash
python - <<'PY'
import base64, json, os, urllib.request
token = base64.b64encode(f"{os.environ['SUBWAVE_ADMIN_USER']}:{os.environ['SUBWAVE_ADMIN_PASS']}".encode()).decode()
req = urllib.request.Request(
    f"{os.environ['SUBWAVE_URL']}/api/dj/segment",
    data=json.dumps({'kind': 'link'}).encode(),
    headers={'Authorization': f'Basic {token}', 'Content-Type': 'application/json'})
print(urllib.request.urlopen(req, timeout=120).read().decode('utf-8')[:800])
PY
```

Повторить 5–10 раз, собрать отказы дословно. Без воспроизведения нечего чинить и не по чему проверять, что починилось.

- [x] **Шаг 2: Развилка**

- **Станция просит роль без прав** (исход 2 шага 3 задачи 3) — чинить это, а не модель: либо перевести `llm.model` на `dj`, либо выдать роль в `llm_routers/gateway/consumers.yaml`. Правка шлюза — **отдельное изменение в чужом репозитории**, в этот коммит не входит.
- **Станция на роли `dj`** (`muse-spark-1.3-contributor`), и отказы всё равно есть — пробовать `llm.fallback` на `local-chat` (`gemma4:12b`, локальная, ограничений меньше) и сверять отказы до и после.

- [x] **Шаг 3: Усилить формулировку персоны**

Добавить в `djHouseRules` (предел 2000) строку о том, что аудитория — взрослые дома, а не радиоэфир под надзором регулятора. Это уменьшает осторожность модели, но **не снимает её**: выравнивание провайдера текстом не отключается, и обещать обратное нельзя.

- [x] **Шаг 4: Проверить**

Повторить шаг 1 тем же числом прогонов. Критерий — доля отказов, а не единичный удачный ответ.

- [x] **Шаг 5: Записать честный итог**

В `station/docs/deploy.md` — раздел о том, что именно отказывало, что помогло и что осталось. Если отказы не ушли — так и написать: у пункта 6 есть потолок, заданный провайдером, и он не наш.

- [x] **Шаг 6: Коммит**

```bash
git add station/docs/deploy.md
git commit -m "Пункт 6: откуда берутся отказы ведущего и где у них потолок"
```

---

### Task 7: Пункт 12 — выравнивание громкости файлов

**Files:**
- Modify: `station/docs/deploy.md`
- Modify: `IDEAS.md` (если нужна разметка)

Механизм в станции есть и включён: `loudness.targetLufs = -14`, `maxBoostDb = 6`, `source = replaygain-then-measured`. Задача решает не его, а недостающие данные.

- [x] **Шаг 1: Развилка по результату шага 4 задачи 3**

- **Тег у всех треков** — станции нечего добавить, кроме свежего индекса:
  ```bash
  NAVIDROME_ADMIN_PASS=... python -m music navidrome-scan --user <admin-user>
  ```
  Послушать час, убедиться, что перепады ушли. Пункт закрыт.
- **Тега нет или он у части** — разметка коллекции. Это работа **над коллекцией, а не над станцией**, со своими последствиями, поэтому она выносится в ярус 2 отдельным планом. Здесь — только запись в `IDEAS.md` с готовым порядком:
  1. бэкап тегов всех 4631 файлов;
  2. `rsgain easy -m MAX "<music-share>"`;
  3. `python -m music --db data/catalog.db scan --root "<music-share>" --full` — поколение вырастет, это ожидаемо;
  4. `python -m music --db data/catalog.db m3u-import --root "<music-share>"` — сопоставления привязаны к поколению;
  5. `NAVIDROME_ADMIN_PASS=... python -m music navidrome-scan --user <admin-user>` — inotify на CIFS не работает, рескан только принудительный.

- [x] **Шаг 2: Зафиксировать, что механизм включён**

Дописать в таблицу «Состояние» `station/docs/deploy.md` строку «Выравнивание громкости» с фактическими значениями и с тем, откуда станция берёт громкость трека сейчас.

- [x] **Шаг 3: Коммит**

```bash
git add station/docs/deploy.md IDEAS.md
git commit -m "Пункт 12: механизм выравнивания включён, дело в данных"
```

---

### Task 8: Документация яруса

**Files:**
- Modify: `station/docs/deploy.md`
- Modify: `CLAUDE.md`

- [x] **Шаг 1: Описать инструмент**

В `station/docs/deploy.md`, рядом с описанием `onboard.py`, добавить два режима и **почему чтение обратно обязательно**: `POST /settings` отвечает 200 и на отброшенный ключ, и на зажатое число.

- [x] **Шаг 2: Пополнить грабли проекта**

В `CLAUDE.md`, раздел «Грабли», добавить три строки:

- `POST /api/settings` — частичный патч по верхнеуровневым ключам, но `personas` идёт массивом целиком: отправить один элемент значит стереть остальных.
- `persona.soul` и `djHouseRules` обрезаются до 2000 символов молча.
- Ручки персоны `humour`, `warmth`, `localColour` в subwave 1.8.0 не доезжают ни до одного промпта — крутить их бесполезно, тон задаётся `soul` и `djHouseRules`.

Там же, в разделе «Тесты», поправить число: написано «177 тестов», собирается 186, а после этого плана будет 196.

- [x] **Шаг 3: Прогнать весь быстрый набор**

Run: `pytest --durations=5`
Expected: PASS, 196 тестов, бюджет 60 с соблюдён. `--durations` нужен потому, что правило проекта требует помечать `integration` **по замеру**, а не по имени каталога: новый тест дольше секунды в быстром наборе — ошибка разметки. — **получено: 196 passed за 6.81 с, самый долгий 0.12 с.**

- [x] **Шаг 4: Коммит**

```bash
git add station/docs/deploy.md CLAUDE.md
git commit -m "Грабли настроек станции: патч, массив персон и мёртвые ручки"
```

---

## Что этот план не делает

Ярусы 2, 3 и 4 спеки — отдельные планы и отдельные сессии:

- **Ярус 2** — ударения в `bridge.py` (пункт 3), фоновое воспроизведение на Android (пункт 2), разметка ReplayGain, если задача 7 её потребует;
- **Ярус 3** — комната, личность слушателя и навык `chat` (пункт 8, клиентская половина 9);
- **Ярус 4** — форк контроллера (серверная половина 9, пункты 10 и 11).

Ярусы 3 и 4 требуют SSH на `<ssh-user>@<station-host>`, который с рабочей машины сейчас отказывает. Этот план от SSH не зависит вовсе.
