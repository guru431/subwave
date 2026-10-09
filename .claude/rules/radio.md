# radio — форк SUB/WAVE: наша часть

Репозиторий — форк апстрима (`upstream` = perminder-klair/subwave). `CLAUDE.md`,
`AGENTS.md`, `.claude/skills/` в корне — апстрима, их не правим. Исключение — настоящая
ошибка, на которой встаёт CI-гейт публикации: `.claude/skills/subwave-llm-bench/scripts/assess-models.sh`
(SC2259 — heredoc перебивал pipe, раздел failure reasons был всегда пуст; 2026-10-06).
При слиянии апстрима: исправил сам — берём его версию. Наше — `station/`,
этот файл и блок в конце `.gitignore`. Конкретика установки (хосты, SSH, пути,
голоса) — `CLAUDE.local.md` (вне git); хуки обезличивания — в `.git/hooks`.

## Публичность
- Публикация — только `bash <_boss>/cron/github-push.sh radio <ветка>`. Обезличен
  каждый коммит, не только дерево: реальные значения — плейсхолдерами
  (`python station/tools/sanitize.py`, карта `.sanitize-map.json` вне git).
  Хук pre-commit сверяет с `.sanitize-patterns`; `--no-verify` не применять.
- Эталоны голосов (`*.wav`, транскрипты) в git не попадают.
- Рабочее дерево не оставлять грязным между сессиями: ночной auto-commit
  закоммитит необезличенное, и публикация встанет до переписывания истории.

## Ветки и апстрим
- `main` — апстрим + `station/` + наши фичи коммитами `feat|fix(controller|web): …`,
  у каждой — раздел в `station/docs/controller-changes.md` / `web-changes.md`.
- `ru-1.8.0` — эталон нарезки, не меняется.
- Новая версия апстрима — `git merge vX.Y.Z` в `main` (не rebase: ветка опубликована),
  вердикты по фичам — `station/docs/port-X.Y.md`, эталон `KNOWN` в
  `station/run-tests.sh` снимается заново на чистом теге, `UPSTREAM_BASE` там же.

## Тесты
- `cd station && python -m pytest` — быстрый набор станции (~бюджет 60 с).
- `bash station/run-tests.sh --patch` — тесты наших фич контроллера в образе на хосте
  станции; без флага — весь набор; `--src /home/<user>/radio` после `station/tools/push-to-station.sh`.
- `npx tsx --test web/lib/*.test.ts` — тесты наших фич веба (W01–W03, W09, W11–W13), на
  рабочей машине. Не циклом `for … || break`: он обрывает остальные файлы и выходит с 0.
- Линтер и typecheck — на рабочей машине, не на хосте станции
  (`station/docs/controller-changes.md`, «Сборка»).

## Станция — грабли

Перед правкой `station/deploy`, `station/room`, `station/tts-*`, `station/loudness` — прочитать
раздел про эту часть в [station/docs/station-pitfalls.md](../../station/docs/station-pitfalls.md).

**Настройки контроллера**
- `POST /api/settings` патчит верхнеуровневые ключи, но `personas` — массивом целиком:
  одну персону правит только `onboard.py --persona ID --from FILE`.
- 200 ≠ «применено»: незнакомый вложенный ключ отбрасывается молча, число вне границ
  зажимается; `onboard.py --patch` сверяет чтением обратно.
- `POST` плоский, `GET` завёрнут в `values`, а в корне ответа — **чужие** `llm`/`tts` с теми же
  именами. Разворачивать `_settings_values()`.
- `persona.soul` и `djHouseRules` молча режутся до 2000 символов (видно только в `GET /api/dj`).
- Ручки `humour`/`warmth`/`localColour` действуют только при `≤3` и `≥7`; 4–6 — директивы нет.
- Новая настройка — в пяти местах: схема, `settings/patch-registry.ts`, дефолт в
  `settings/defaults.ts`, нормализация в `settings.ts`, выдача в `routes/settings/core.ts`
  (+ список в `settings-patch-schema.test.ts`). Пропуск любого молчалив.
- `llm.reasoning` включён **намеренно** (модель thinking-only) — не «чинить».
- Операторский навык приходит `enabled: false`: `POST /api/dj/skill-toggle {"name","on"}`;
  ручной прогон `POST /api/dj/skill {"name"}` минует гейты.
- Навык `curiosity` — наш; «сбросить навык» в админке вернёт апстримный, с выдумками.

**Голос**
- Chatterbox — один синтез за раз: только через мостик `:4124` (`MAX_CONCURRENT=1`,
  занятость ждёт очереди). Прямой `:4123` сталкивается с эфиром; повтор с паузой это маскирует.
- `tts.fallback.enabled = false` в апстриме декоративен — настоящим его делает наш
  `rescueForbidden` (две правки: `resolveEngine` и `fallbackChain`). Пока TTS недоступен, ведущая молчит.
- `tts.gainDb` доходит до эфира вчетверо слабее (компрессор `mic_chain`); подбирать по
  `station/loudness/voice_chain.py`. **Правило владельца: голос громче музыки** (~−12 LUFS при
  музыке −14). F5 стоит `+5` по слову владельца — не поднимать по расчёту и не «сохранять
  прежний баланс». Клипы для подбора — сперва `station/tts-f5/tools/check_speech.py`.
- Жалоба на ударение — сначала разметка (`station/tts-f5/tools/stress_audit.py`, таблицы
  `f5_accent`), потом F5. Без `ruaccent/dictionary/accents.sqlite` служба не стартует.

**Эфир**
- «Ведущий молчит» после пересборки — счётчик подводок: он сбрасывается при рестарте контроллера.
- Повтор артиста настройкой не лечится: окно держит страж в `pickViaAgent`, заказы вне окна.
- Пустые `moods`/`energy`/векторы в `library.db` сужают пул сильнее окна повторов.
- Ловушки кода — очередь и подводки (придержанный слив, `writeSeamLink`, `linkClockAt`, окна
  повторов), сверка заказов (`strip_command`, усечение падежа, `exact`, 6 заходов,
  `requestPath`), комната (percent-encoded `X-Listener-Name`, тело до отказа, `check` по
  имени) — в [station/docs/station-pitfalls.md](../../station/docs/station-pitfalls.md), читать перед правкой.

**Комната, доступ, сеть**
- `vapid.pem` на томе комнаты не пересоздавать: новый ключ обесценивает все подписки браузеров.
- Пароль владельца проверяет контроллер; 401 — без `WWW-Authenticate` намеренно. Дизлайки — только сигнал.
- `https://<station-domain>` → Apache на хосте станции → Caddy. Конфиг `station/deploy/apache-fm.conf.example`
  подключён в **общий** `<apache-dir>/apache2.conf`: перед правкой бэкап, после —
  `apache2ctl configtest`, `graceful` и удаление бэкапа. Правило по пути — только `(?i)`; проверять сужением сетей в правиле
  и вариантами регистра.
- Погода и MusicBrainz ходят через VPN (правило роутера по имени); «тормозит админка» —
  `duration` в `docker logs sub-wave-caddy`. MusicBrainz чаще раза в секунду отвечает 503.
- Громкость эфира — `tracks.loudness_lufs` в `library.db` (`python station/loudness/run.py`), не
  теги: коллекцию раздаёт Syncthing, правка тегов ушла бы на все устройства.

**Сборка**
- Тег образа контроллера один, рабочих копий апстрима бывает несколько: перед выкаткой — дифф
  живого контейнера с клоном ([station/docs/controller-changes.md](../../station/docs/controller-changes.md), «Сборка»).
- Клон на хосте станции — `~/radio`; его обновляет только
  `station/tools/push-to-station.sh` (git bundle, LF), руками не править.
- Хост станции не захламлять: клон (~1 ГБ — вся история апстрима), промежуточные теги
  образов (`*-prev`), тестовые образы апстрима и временные файлы — удалить, как только
  сборка, тесты и выкатка закончены. Клон `push-to-station.sh` создаёт заново.
- На хосте станции не запускать `tsc` и `npm ci` — хост уходит в глобальный OOM. Тесты
  контроллера — в образе (`station/run-tests.sh`), линтер — на рабочей машине.
- Русский интерфейс — свой образ `subwave-web:<версия>-ru` (`station/docs/web-changes.md`): после
  обновления апстрима пересобрать, иначе `compose pull` вернёт английский.
- `<link rel="manifest">` и `og:image` в `<head>` — руками (страница `force-dynamic`);
  установимость проверять браузером по CDP.
