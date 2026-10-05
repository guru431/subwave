# Перенос фич форка с v1.8.0 на v1.17.0

Ветка `ru-1.8.0` — апстрим v1.8.0 и наши фичи, по коммиту на фичу (нарезка
патч-файлов `controller-ru.patch` и `ru-web.patch`). Каждая фича переносится на
`main` (= v1.17.0) отдельным `git cherry-pick -x`; вердикт и проверка — в таблице
ниже.

## Эталон

- Дерево `ru-1.8.0` по хэшу равно дереву «v1.8.0 + оба патча целиком» (`SAME-TREE`).
- `controller/src` ветки совпадает с исходниками живого контейнера контроллера
  (`docker create` + `docker cp`, `diff -rq` — `SAME-LIVE`) и с клоном сборки на
  хосте станции.
- Веб: в живом образе только собранный бандл Next (`content`, `node_modules`,
  `public`, `server.js`), исходников нет — сверка веба заканчивается на `SAME-TREE`.
- В тексте веб-патча до нарезки реальный путь точки монтирования коллекции в
  тестовых данных дерева папок заменён нейтральным (`/mnt/nas/…`): три строки,
  на поведение не влияют.

## Что сменилось у апстрима v1.9–v1.17

Сводка из `CHANGELOG.md` v1.9.0…v1.17.0 (241 коммит) — то, что задевает наши фичи
или выкатку.

**Миграции `library.db`.** v1.8.0 заканчивался на `user_version = 20`; v1.17.0
добавил 21–27:

| № | Что |
|---|---|
| 21 | `tracks.era_untrusted` + чистка эхо-лет альбомных тегов |
| 22 | `tracks.text_vector_dirty` |
| 23 | `tracks.album_id`, `tracks.artist_id` + индексы |
| 24 | `tracks.lead_silence_ms`, `tracks.tail_silence_ms` |
| 25 | `tracks.tail_start_ms` |
| 26 | таблица `id_rotation_journal` (ротация id Navidrome 0.64) |
| 27 | индекс энергии, таблица `track_moods` и триггеры к ней |

Наша колонка `tracks.path` на v1.8.0 заняла номер 21 — у апстрима этот номер
другой. Перенос: миграция пути — идемпотентная проверка `PRAGMA table_info(tracks)`
после цепочки апстрима, без своего номера; на выкатке база станции получает
`PRAGMA user_version = 20` до первого старта нового образа, чтобы миграции 21–27
апстрима прошли.

**Затрагивает наши фичи напрямую:**

- v1.9.0 — `space artists out on the agent path, and fold name variants`
  (#1406/#1433, `dcff53b1`): у апстрима появился свой
  `broadcast/dj-agent/artist-guard.ts` — сверка с нашим окном артиста (C08).
- v1.9.0 — `picker: stop claiming new artist regardless of play history` (#1456).
- v1.15.0 — `clarify pair-drain transition ownership` (#1652, `3a50d152`): слив
  очереди парами — вставка заказа (C01) и придержанный слив (C03).
- v1.15.0/v1.16.0 — boundary handoffs, `pause-and-talk breaks`, verified link
  pipeline: подводки и стык (C04, C09).
- v1.12.0 — `one arbitrated talk-slot scheduler for every spoken segment` (#1505):
  все реплики через один планировщик слотов.
- v1.11.0 — `first-class station credentials` (#1484): маршруты слушателя под
  `requireStationAuth` — заказ (C02) и комната.
- v1.16.0/v1.17.0 — ротация id Navidrome 0.64 (#1255, #1703): `library-db` и
  сверка библиотеки (C12).
- v1.17.0 — `show-filter: flatten OpenSubsonic genre objects in trackGenres`
  (#1744): жанры трека (C12).
- v1.17.0 — `tts: native Gemini engine + per-persona voiceStyle` (#1718),
  `llm: fail over on permanent model failures` (#1737): TTS и LLM (C05).
- v1.16.0 — `tts: apply speech rate to remote audio` (#1677).
- v1.14.0 — `requests: stop operator queue presses shutting the listener request
  line` (#1631): маршрут заказа (C02, C11).

**Новые настройки и переменные окружения:** `STEMS_DIR` (кэш стемов, по умолчанию
`<STATE_DIR>/stems`), `ANALYZER_REPLICAS` (0 — без контейнера анализатора),
`ANALYZE_CONCURRENCY`, `SUBWAVE_DJ_BRAIN_ENABLED` (по умолчанию `false`),
`GEOIP_DB_PATH`, `*_IDLE_UNLOAD_S` и `CHATTERBOX_REFERENCE_WAV` для `tts-heavy`.
Обязательных новых нет. Настройки станции: «Max listeners» и «Listener country»
переехали в admin → Danger zone; `fadeAtShowEnd`, длительность мин. трека,
настраиваемый anti-repeat recap. `queue.*` у апстрима не появился.

**Новые маршруты** (все под `requireAdmin`, кроме `GET /similar-tracks` —
`requireStationAuth`): `/admin-auth`, `/backup/file/:name`,
`/debug/llm-calls/export`, `/dj/queue/block/:blockId`, `/doctor/llm`,
`/jingles/:filename/play`, `/library/scenes*`, `/library/coverage*`,
`/personas/:id/export`, `/shows/candidates`, `/schedule/next-change`.

## Вердикты по фичам

| Фича | Вердикт | Что изменилось при переносе | Чем проверено |
|---|---|---|---|
| C01 заказ встаёт перед несданными авто-пиками | перенесена | конфликт в `push()`: вставка перед первым несданным авто-пиком слита с тихим логом членов блока (#1622) и `warnIfSwallowedByCrossfade` (#1594); блоки студии (`requestedBy: 'studio'`) встают так же, в своём порядке; в лог `queued` добавлена `position` | run-tests --src: queue*, request*, pair-drain-interleaving — 125/125 |
| C02 точный заказ по songId | перенесена | ветка 0a переписана на общий путь подводки заказа v1.17.0 (`generateQueuedRequestIntro`: выключенный голос, `introHostSpeech`) вместо `dj.generateIntro` + `guardIntro`; ответ — через `withWaitNotice`; апстримный `request-host-speech.test.ts` считает вызовы шва — 2 → 3 (наша ветка — третий каскад); зеркало схемы в вебе — W09 | run-tests --src: request*, *schema* — 373/373 (1 известное) |
| C03 глубина очереди queue.lookahead | перенесена | `runPickCycle`: апстрим переименовал `predecessorItem` → `pickAnchorItem` и добавил `runArmedBoundaryHandoff` — у добавки (`topUp`) якорь пика — последний элемент очереди; `queue` в выдаче `GET /settings` рядом с новыми `silenceTrim`/`fadeAtShowEnd`; список ключей в `settings-patch-schema.test.ts` — плюс `queue`; `queue.*` у апстрима не появился | run-tests --src: queue*, settings*, *drain* — 182/182 |
| C04 подводка на стыке при глубокой очереди | перенесена | `writeSeamLink` — через общий шов линка v1.17 `generatePickLink` (автор на вызове модели, отмена при смене эпохи ведущего), `speechClockContext` вместо `linkAirContext`, `lastLink`; элементу ставятся те же поля, что `push()` ставит линку (`introHostSpeech`, `introSessionKey`, `introLabelChecked`); **исправлено**: `linkPrev` писался строкой id, и сторож устаревшего линка для стыка не работал — теперь объект, как у пика; `maybeWriteSeamLink` молчит, пока ждёт передача микрофона (`session.pendingHandoff()`) — правило v1.17 «стык смены шоу принадлежит передаче»; функция стоит перед комментарием `runTrackEvent`, а не внутри него | run-tests --src: queue*, *link*, *host-speech*, *handoff*, *boundary* — 175/175 |
| C05 запрет подмены движка TTS | перенесена | апстрим сам выключатель не сделал: лестница спасения по-прежнему зашита (теперь с провайдерами облака и Gemini); `rescueForbidden` встал в оба места — `resolveEngine` и `fallbackChain`; новых путей подмены в v1.17 нет; функция вынесена перед комментарием `configuredSlot` (в v1.8-патче врезалась между комментарием и функцией) | run-tests --src: tts* — 70/70 |
| C06 потолок окна повторов 2000, журнал 6000 | перенесена | апстрим сохранил потолки 1000/2500 и ужал комментарии — комментарии переписаны в его стиле с пометкой форка; других ограничений `noRepeatWindow` (схема, админка) в v1.17 нет | run-tests --src: *repeat*, *vocab*, *recent*, settings* — 123/123 |
| C07 заказ ищет по всей полке (requestPath) | перенесена | `collect()` у апстрима получил `minTrackSec` и снятие потолка артиста для строгого плейлиста (`playlistLock ? Infinity : 3`) — заказ (`requestPath`) встал первым в этой цепочке; вызов агента заказа получил `persona` — `requestPath: true` рядом с ним | run-tests --src: picker*, request*, *search*, *scope* — 72/72 |
| C08 окно артиста в агентном пути | апстрим сделал частично; недостающее перенесено поверх его модуля | v1.9 (#1406/#1433, `dcff53b1`) дал агентному пути окно по слотам (`llm.artistVarietyWindow`, 5 последних + очередь) и сделал разнесение мягким (не хватило свежих — пик остаётся); окна по часам библиотеки (`recencyWindowsForLibrary`, 3 ч на 3k+) не было. Наши `artistGuardTrigger`/`guardRepickSet` не переносились: в `runArtistGuard` апстрима — необязательные `windowRoots`/`windowHours`, причина `window` (жёсткая, как на v1.8: перевыбор вне окна и якоря, иначе спасение пулом), `artistWindowRoots` — ключи окна; без этих полей поведение апстрима неизменно. Диагностический тест апстрима `pair-drain-interleaving` переписан на строку окна (тот же повтор, но сначала спасение пулом) | run-tests --src: artist-guard*, picker*, pair-drain*, album*, request* — 130/130; 5 новых тестов окна в `artist-guard-run.test.ts` (RED → GREEN), `artistWindowRoots` в `artist-guard.test.ts` |
| C09 стык — прогноз часов и голос заранее | перенесена | прогноз часов (`seamLinkShowAt`) — как был; «голос заранее» — апстрим в v1.13–v1.17 сделал свой учтённый предрендер со сроком (`startIntroRender`, #1409, снимок личности реплики), поэтому наш общий `prerenderIntro` и правка слива не перенесены, а `writeSeamLink` зовёт `queue.startIntroRender(item)` | run-tests --src: link-clock, *link*, *intro*, queue* — 111/112, единственное падение — флейк апстримного queue-block-wiring (1 мс, FINDINGS), повтор зелёный |
| C10 окно агента заказа без чужих заказов | перенесена | апстрим ужал комментарий `windowMessages` — абзац про `omitRequests` дописан к его версии; вызов агента заказа на месте | run-tests --src: request-window, request*, *session*, *window* — 75/75 |
| C11 готовые ответы на заказ по-русски | перенесена | ответ «more like this» — на месте нового общего пути подводки v1.17; **дописано**: новая в v1.14 фраза ожидания за блоком (`requestWaitClause`/`formatWait`, #1622) — по-русски, с согласованием числительного («через 1 минуту / 2 минуты / 5 минут», «1 час / 2 часа»); апстримные проверки фразы в `queue-block-wiring.test.ts` правятся вместе со строками (+3 случая форм) | run-tests --src: request-dedup, requester-name, request*, queue-block* — 98/98; фраза ожидания — RED → GREEN |
| C12 кириллица в жанрах, жанры папок, правило Folder | перенесена | **миграция**: блок `userVersion < 21` не перенесён — апстрим занял 21–27; колонка `tracks.path` добавляется идемпотентной проверкой `PRAGMA table_info(tracks)` после цепочки апстрима, `user_version` не трогает; `INSERT` в `upsertTrackMeta` слит с новыми `album_id`/`artist_id`/`era_untrusted`; `path` классифицирован в `id-adoption.ts` (перенос id Navidrome 0.64) как COALESCE; `normGenre` (Юникод) объединён с расплющиванием объектов жанров апстрима (#1744); из `slimTrack` убран `path` — v1.17 строит её из урезанной проекции пула без пути, папка берётся через `library.get(id)`; маршруты папок встали рядом с новым `/library/original-year`; `folderGenres.load()` — после восстановления ротации id; `show-filter.ts` у git двоичный (NUL-байт в ключе кэша) — слит вручную | run-tests --src: library-path (+тест повторной миграции: RED без проверки колонки → GREEN), genre-cyrillic, folder*, blocklist*, show-filter*, library*, subsonic*, *genre*, id-adoption*, id-rotation* — 158/158 |
| C13 погода помнит неудачу 10 минут | перенесена | апстрим перевёл погоду на живые настройки (`weatherConfig()`, ключ конфигурации в кэше — правка места через onboarding и restore теперь видна сразу); память о неудаче встала поверх: `fetchWeather` в `singleFlight`, неудача помнится для того же ключа места (другое место — новая попытка), `invalidateWeatherCache` сбрасывает и её | run-tests --src: weather*, *context* — 6/6 |
| W01 русский интерфейс плеера | перенесена | лёг без конфликтов; новых английских строк апстрима в компонентах классического скина одна пара — «More/Less» раскрытия темы шоу (v1.14) → «Ещё/Свернуть»; **дописано** пропущенное в v1.8: расписание («Сейчас · до …», «· с …», «без ведущего», два пояснения), шаблонный ответ ящика заказа «Принято — передаём в студию», строка мета в эфире студии («заказ:», «источник:»). Подсказки-заказы («more like this» и др.) не переводятся — это текст заказа, который разбирает контроллер | линтер и typecheck веба (Task 21), эфир (Task 25) |
| W02 ящик чата | перенесена | лёг без конфликтов; клавиша `5` у апстрима свободна; маршрут `/room/*` — в Caddyfile (Task 24) | `npx tsx web/lib/roomRules.test.ts` (Task 21), typecheck веба, эфир (Task 25) |
| W03 уведомления чата (Web Push) | перенесена | лёг без конфликтов; `sw.js` апстрима принял обработчики `push`/`notificationclick` без правок | `npx tsx web/lib/roomNotify.test.ts`, `roomPush.test.ts` (Task 21), эфир — Web Push (Task 25) |
| W04 имя приложения и иконка станции | перенесена | конфликт только в `lib/discMark.js`: апстрим лишь ужал комментарии старого диска — файл целиком наш знак; имя в `layout.tsx`/`manifest.ts`/шапке легло без конфликтов, новых мест с `SUB/WAVE` на странице плеера в v1.17 нет (картинка шер-карточки `og/route.js` осталась апстримной, как и в v1.8) | эфир: `curl https://<station-domain>/ | grep -c SUB/WAVE` → 0, иконка 512 глазами (Task 25) |
| W05 ползунок громкости | перенесена | конфликт только в комментарии `toggleMute` (апстрим ужал свой); **исправлено**: `style={{ accentColor }}` ползунка — одна из трёх старых ошибок линтера v1.8 (`react/forbid-dom-props`) — заменён утилитой `accent-[var(--accent)]` | линтер и typecheck веба (Task 21), эфир (Task 25) |
| W06 установка как приложение | перенесена | лёг без конфликтов; апстрим в v1.17 ни ссылку на манифест в `<head>`, ни кнопку установки (`beforeinstallprompt`) не добавил — дубля нет | эфир: установимость по CDP с контролем на стороннем PWA (Task 25) |
| W07 экран блокировки и динамический остров | | | |
| W08 фон на Android | | | |
| W09 сверка заказа с коллекцией | | | |
| W10 скачивание трека | | | |
| W11 дизлайки | | | |
| W12 Blocked — папки деревом и жанры папок | | | |
| W13 Blocked — карточка Dislikes | | | |
| W14 сердечко спрашивает /api/like только за свой трек | | | |
