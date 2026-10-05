# Глубина очереди — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Станция выбирает треки на несколько шагов вперёд, а не по одному в последний момент: админка видит, что заиграет дальше, и может исключить лишнее, а заказ слушателя получает кого обгонять.

**Architecture:** Настройка `queue.lookahead` (по умолчанию `1` — сегодняшнее поведение, на станции `5`) и добор очереди в `runPickCycle`: после удачного пика цикл повторяется, пока в `upcoming` меньше N треков. Добранные треки кладутся **без подводки** — она рождается на стыке штатным путём. Вторая половина работы не в пикере, а в сливе: апстрим отдаёт Liquidsoap всё, у чего появился преемник, поэтому без ограничения глубина очереди немедленно утекла бы в `dj_queue`, где её уже не переставить и не отменить.

**Tech Stack:** TypeScript (контроллер subwave v1.8.0), zod, Docker.

**Spec:** [`docs/superpowers/specs/2026-09-21-radio-upgrades-design.md`](../specs/2026-09-21-radio-upgrades-design.md) — §6.3 (глубина очереди), §6.4 (админка — писать нечего), §9 (что признаётся заранее).

**Предыдущие планы:** [`2026-09-22-room-and-chat.md`](2026-09-22-room-and-chat.md), [`2026-09-22-request-by-song-id.md`](2026-09-22-request-by-song-id.md) — этот план от них не зависит, но патч контроллера общий, поэтому исполняется после них.

## Состояние на 2026-09-22 — исполнено

| Задача | Состояние | Коммит |
|---|---|---|
| 1. Настройка `queue.lookahead` | **готово**, четыре места вместо трёх (см. ниже) | `4ba7139` |
| 2. `topUpDepth()` + тест | **готово**, 6 тестов | `4ba7139` |
| 3. Добор, слив, линк на стыке | **готово**, набор апстрима без новых падений | `4ba7139` |
| 4. Сборка, применение, эфир | **готово**, проверено вживую | `c59bde8` |
| 5. Документация | **готово** | `c59bde8` |

Замеры на живой станции: очередь **5**, отдан в Liquidsoap **1**, заказ встал
**вторым** (обогнал три авто-пика), исключение из админки работает, подводка
называет трек, который следом и заиграл.

**Что выяснилось при исполнении и меняет план:**

1. **Настройка живёт в ЧЕТЫРЁХ местах, а не в трёх.** План перечислял схему, реестр и
   дефолт; не хватало `routes/settings/core.ts` — без него `GET /settings` не отдаёт
   блок, и `onboard.py --patch` честно сообщает «станция приняла не всё» о применённой
   настройке. Ровно тот случай, ради которого сверка чтением обратно и делается.
2. **Подводка на стыке потребовала своего пути.** План рассчитывал, что она «рождается
   штатным путём» — такого пути у апстрима нет: линк пишется только вместе с пиком, а
   при глубокой очереди пика на стыке не случается. Добавлен
   `djAgent.writeSeamLink` — та же `dj.generateLink`, вызванная для первого несданного
   элемента. Без этого глубина очереди откатила бы уже сделанный пункт «ведущий
   говорит чаще».
3. **Инвариант апстрима правится намеренно.** `scripts/settings-patch-schema.test.ts`
   перечисляет ключи настроек со схемами; `queue` в список добавлен. Тест не устарел —
   он для того и написан, чтобы новый ключ заметили.
4. **Счётчик подводок сбрасывается при каждом рестарте контроллера** и стартует с
   интервала по умолчанию (1–9), а не с `chatty` (1–5): поле инициализируется до
   загрузки настроек. При частых пересборках это выглядит как «ведущий замолчал» —
   ушло больше часа, прежде чем счётчик дожил до нуля и линк написался.
5. **Проверять глубину надо при живом эфире.** `llm.pauseWhenEmpty: true` гасит
   автономные вызовы при нуле слушателей, и очередь не добирается вовсе.

## Global Constraints

- **Один пик = один вызов LLM-агента** (`runPickCycle` защищён `pickerBusy` и другого устройства не имеет). Глубина 5 стоит до пяти вызовов по 15–25 с при каждом опустошении очереди.
- **Отданное в Liquidsoap не отзывается бесплатно.** `removeUpcoming` умеет снять и сданный трек (через `removeFromDjQueue`), но **вставить** перед сданным нельзя: наш приоритет заказа вставляет перед первым **несданным** авто-пиком. Поэтому слив ограничивается — см. задачу 2.
- **Подводка живёт только на голове очереди.** `linkPrev` («это был X») и `linkClockAt` (час, под который написана реплика) верны лишь для ближайшего стыка. Добранному треку подводка не пишется вовсе.
- **Граница шоу режет глубину.** Пик под нынешний час, выходящий в эфир в следующем шоу, — это выбор не по тем правилам. У апстрима для родственной задачи уже есть `PICK_SHOW_LOOKAHEAD_SEC = 120`.
- **Патч контроллера теперь создаёт новый файл** (тест) — пересобирать **только** `git add -A && git diff --cached HEAD -- controller/`. `git diff HEAD` новых файлов не видит и молча укоротит патч.
- **Тег образа:** `subwave-controller:1.8.0-ru`.
- **SSH на Debian:** `ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host>`.
- **`llm.pauseWhenEmpty: true` на станции** — при нуле слушателей авто-пик не идёт вовсе, и очередь не добирается. Это не сбой: проверять глубину надо при включённом эфире.

## Структура файлов

| Файл | Ответственность |
|---|---|
| В клоне: `controller/src/schemas/settings.ts` | `queuePatchSchema` с полем `lookahead` |
| В клоне: `controller/src/settings/patch-registry.ts` | регистрация блока `queue` |
| В клоне: `controller/src/settings.ts` | дефолт `queue.lookahead = 1`, границы 1–10, нормализация |
| В клоне: `controller/src/broadcast/queue/pure.ts` | `topUpDepth()` — чистая функция «сколько ещё добирать» |
| В клоне: `controller/src/broadcast/queue.ts` | добор в `runPickCycle`, ограничение слива в `drainToLiquidsoap` |
| В клоне: `controller/scripts/queue-lookahead.test.ts` | тест на `topUpDepth` |
| `station/docs/controller-changes.md` (правка) | пересобранный патч |
| `station/docs/controller-changes.md` (правка) | что делает глубина и чем она ограничена |
| `station/onboard/patches/2026-09-22-queue-lookahead.json` (создать) | применённая настройка под версионированием |
| `IDEAS.md` (правка) | удалить реализованную запись про глубину очереди |

---

### Task 1: Настройка `queue.lookahead`

**Files:**
- Modify (в клоне): `controller/src/schemas/settings.ts`, `controller/src/settings/patch-registry.ts`, `controller/src/settings.ts`

**Interfaces:**
- Produces: `settings.get().queue.lookahead` — целое 1–10, по умолчанию `1`.

Настройка заводится полноценно, а не читается из переменной окружения: `POST /api/settings` **молча отбрасывает незнакомые вложенные ключи**, поэтому ключ, которого нет в схеме, не сохранится и никак об этом не сообщит.

- [x] **Шаг 1: Подготовить клон с наложенным патчем**

```bash
M=/c/AI/projects/music
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/sw-queue
cd /tmp/sw-queue && git apply $M/station/docs/controller-changes.md
git status --short
```

Expected: патч накладывается; в статусе — изменённые файлы контроллера из прошлых планов.

- [x] **Шаг 2: Схема блока**

В `/tmp/sw-queue/controller/src/schemas/settings.ts`, рядом с `LOUDNESS_*_BOUNDS`, добавить границы:

```ts
// Глубина очереди: сколько треков контроллер выбирает вперёд. 1 — поведение
// апстрима (пик в последний момент). Потолок 10 — не техническое ограничение,
// а честное: каждый добранный трек стоит отдельного вызова агента, а выбран он
// под НЫНЕШНИЙ час, и на десятом шаге этот час уже посторонний.
export const QUEUE_LOOKAHEAD_BOUNDS: SettingsNumericBound = { min: 1, max: 10 };
```

и, рядом с `loudnessPatchSchema`, сам блок:

```ts
export const queuePatchSchema = settingsBlockOf({
  lookahead: settingsIntLike(
    QUEUE_LOOKAHEAD_BOUNDS,
    `queue.lookahead must be integer in [${QUEUE_LOOKAHEAD_BOUNDS.min}, ${QUEUE_LOOKAHEAD_BOUNDS.max}]`,
  ),
});
```

- [x] **Шаг 3: Регистрация блока**

В `/tmp/sw-queue/controller/src/settings/patch-registry.ts`: добавить `queuePatchSchema` в список импортов (там же, где `loudnessPatchSchema`) и строку в карту блоков рядом с `loudness: loudnessPatchSchema,`:

```ts
  queue: queuePatchSchema,
```

- [x] **Шаг 4: Дефолт и нормализация**

В `/tmp/sw-queue/controller/src/settings.ts`:

- в объект `DEFAULTS` — `queue: { lookahead: 1 },`;
- в объект `BOUNDS` — `queueLookahead: { min: 1, max: 10 },`;
- в нормализацию хранимых настроек, рядом с блоком `loudness: { … }`, — тот же приём:

```ts
    queue: {
      lookahead:
        typeof stored.queue?.lookahead === 'number' &&
        stored.queue.lookahead >= BOUNDS.queueLookahead.min &&
        stored.queue.lookahead <= BOUNDS.queueLookahead.max
          ? Math.round(stored.queue.lookahead)
          : DEFAULTS.queue.lookahead,
    },
```

- [x] **Шаг 5: Проверить, что настройка жива**

```bash
docker run --rm -v /tmp/sw-queue:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npm run lint" 2>&1 | tail -15
```

Expected: чисто. `tsc` здесь поймает и опечатку в `BOUNDS`, и забытый импорт схемы.

---

### Task 2: `topUpDepth()` — сколько ещё добирать

**Files:**
- Modify (в клоне): `controller/src/broadcast/queue/pure.ts`
- Create (в клоне): `controller/scripts/queue-lookahead.test.ts`

**Interfaces:**
- Produces: `topUpDepth(opts: { lookahead: number; queued: number; sameShow: boolean }): number` — сколько треков ещё не хватает; `0` означает «не добирать».

Решение выносится в `pure.ts` намеренно: `queue.ts` — файл на 2478 строк, завязанный на сессию, персоны и Liquidsoap, и правило «добирать или хватит» в нём нельзя ни прочитать, ни проверить. В `pure.ts` у апстрима уже живут `pickLinkInterval`, `pickLeadSec` и `PICK_SHOW_LOOKAHEAD_SEC` — соседство ровно по теме.

- [x] **Шаг 1: Написать падающий тест**

Создать `/tmp/sw-queue/controller/scripts/queue-lookahead.test.ts` по образцу соседних тестов апстрима (`node:test` + `node:assert/strict`, запускается через `scripts/run-tests.ts`):

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { topUpDepth } from '../src/broadcast/queue/pure.js';

test('a station at the default depth never tops up', () => {
  // lookahead 1 is upstream's behaviour: the pick happens when the queue drains
  assert.equal(topUpDepth({ lookahead: 1, queued: 1, sameShow: true }), 0);
  assert.equal(topUpDepth({ lookahead: 1, queued: 0, sameShow: true }), 1);
});

test('tops up to the configured depth', () => {
  assert.equal(topUpDepth({ lookahead: 5, queued: 0, sameShow: true }), 5);
  assert.equal(topUpDepth({ lookahead: 5, queued: 3, sameShow: true }), 2);
  assert.equal(topUpDepth({ lookahead: 5, queued: 5, sameShow: true }), 0);
});

test('an over-full queue is not a negative top-up', () => {
  // a listener request can push the queue past the depth; that is not a cue to
  // remove anything, just to stop picking
  assert.equal(topUpDepth({ lookahead: 5, queued: 7, sameShow: true }), 0);
});

test('a show boundary stops the top-up where it stands', () => {
  // the pick would air under the NEXT show's rules while being chosen under
  // this one's — the queue simply stays shorter until the show changes
  assert.equal(topUpDepth({ lookahead: 5, queued: 2, sameShow: false }), 0);
});

test('the boundary never blocks the first track', () => {
  // an empty queue at a boundary still needs the one track that plays next,
  // otherwise the station falls through to the auto playlist
  assert.equal(topUpDepth({ lookahead: 5, queued: 0, sameShow: false }), 1);
});

test('a nonsense depth degrades to upstream behaviour', () => {
  assert.equal(topUpDepth({ lookahead: 0, queued: 0, sameShow: true }), 1);
  assert.equal(topUpDepth({ lookahead: Number.NaN, queued: 0, sameShow: true }), 1);
});
```

- [x] **Шаг 2: Запустить и убедиться, что падает**

```bash
docker run --rm -v /tmp/sw-queue:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npx tsx scripts/queue-lookahead.test.ts" 2>&1 | tail -15
```

Expected: FAIL — `topUpDepth` не экспортируется из `pure.js`.

- [x] **Шаг 3: Реализовать**

В `/tmp/sw-queue/controller/src/broadcast/queue/pure.ts`, рядом с `pickLeadSec`, добавить:

```ts
// Сколько треков ещё добрать в `upcoming`, чтобы очередь была глубиной
// `lookahead`. Чистая функция: `queue.ts` слишком велик, чтобы правило
// «добирать или хватит» читалось в нём, а проверить его там нельзя без живой
// сессии, персоны и Liquidsoap.
//
// Три правила, и каждое стоит за сбоем, который иначе пришлось бы ловить в
// эфире:
//  - очередь глубже цели (заказ вклинился) — добирать нечего, но и убирать
//    ничего не надо: отрицательная глубина не бывает;
//  - за границей шоу добор останавливается, потому что трек, выбранный под
//    нынешний час, играл бы уже в следующем шоу и по чужим правилам;
//  - ПЕРВЫЙ трек добирается всегда, даже у самой границы: пустая очередь —
//    это провал на авто-плейлист, а не пауза «до смены шоу».
export function topUpDepth(opts: { lookahead: number; queued: number; sameShow: boolean }): number {
  const depth = Number.isFinite(opts.lookahead) && opts.lookahead >= 1
    ? Math.floor(opts.lookahead)
    : 1;
  const missing = depth - Math.max(0, opts.queued);
  if (missing <= 0) return 0;
  if (!opts.sameShow) return opts.queued === 0 ? 1 : 0;
  return missing;
}
```

- [x] **Шаг 4: Запустить тест**

```bash
docker run --rm -v /tmp/sw-queue:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npx tsx scripts/queue-lookahead.test.ts" 2>&1 | tail -10
```

Expected: PASS, 6 тестов.

---

### Task 3: Добор очереди в `runPickCycle`

**Files:**
- Modify (в клоне): `controller/src/broadcast/queue.ts`

**Interfaces:**
- Consumes: `topUpDepth` (задача 2), `settings.get().queue.lookahead` (задача 1), `settings.resolveActiveShow(date)`.
- Produces: поведение — после удачного пика цикл повторяется, пока очередь мельче цели.

Три условия, без которых добор превращается в поломку:

1. **Подводка только на голове.** `runPickCycle` пишет `wantLink` в начале; для добора он принудительно `false`.
2. **Остановка при неудаче.** Если после цикла очередь не выросла (LLM недоступен, пул пуст), повтор не запускается — иначе сбой превращается в бесконечный цикл вызовов.
3. **Граница шоу.** Считается по тому же `showAt`, что уже вычисляется в цикле.

- [x] **Шаг 1: Импорт**

В `/tmp/sw-queue/controller/src/broadcast/queue.ts` добавить `topUpDepth` в существующий импорт из `./queue/pure.js` (рядом с `pickLeadSec`).

- [x] **Шаг 2: Условие запуска цикла в `onTrackStarted`**

Заменить (файл ~строка 1857):

```ts
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this.runPickCycle({ isAutonomous });
    }
```

на

```ts
    // Пустая очередь по-прежнему повод выбрать трек немедленно; при
    // lookahead > 1 добор глубины идёт следом, в хвосте самого цикла.
    if (this.autoPick && this.upcoming.length === 0 && !this.pickerBusy && djCallsAllowed()) {
      this.runPickCycle({ isAutonomous });
    } else if (this.autoPick && !this.pickerBusy && djCallsAllowed()
               && this.wantsTopUp()) {
      // Очередь не пуста, но мельче заданной глубины — например, после того
      // как трек ушёл в эфир. Это единственное место, где добор начинается
      // сам по себе, без предшествующего пика.
      this.runPickCycle({ isAutonomous, topUp: true });
    }
```

- [x] **Шаг 3: Метод `wantsTopUp`**

Рядом с `pairDrainActive()` (файл ~строка 963) добавить:

```ts
  // Нужен ли добор прямо сейчас. Граница шоу считается по МОМЕНТУ ВЫХОДА
  // добираемого трека в эфир: очередь впереди играет целиком, поэтому её
  // длительности складываются с остатком текущего трека.
  wantsTopUp(): boolean {
    return this.topUpWanted() > 0;
  }

  topUpWanted(): number {
    const lookahead = Number((settings.get() as any)?.queue?.lookahead) || 1;
    if (lookahead <= 1) return 0;                  // поведение апстрима
    const queuedSec = this.upcoming.reduce(
      (sum, i) => sum + (knownDurationSec(i.track) || 0), 0);
    const leadSec = pickLeadSec(this.remainingSecOnAir(), queuedSec || null);
    let sameShow = true;
    if (leadSec != null) {
      const airsAt = new Date(Date.now() + (leadSec + PICK_SHOW_LOOKAHEAD_SEC) * 1000);
      // `resolveActiveShow` — тот же источник, по которому шоу определяет
      // контекст пика: два разных способа ответить на вопрос «какое сейчас
      // шоу» однажды уже разошлись между live-часами и cron (#1205).
      sameShow = (settings.resolveActiveShow(airsAt) as any)?.id
        === (settings.resolveActiveShow(new Date()) as any)?.id;
    }
    return topUpDepth({ lookahead, queued: this.upcoming.length, sameShow });
  }
```

- [x] **Шаг 4: Добор в хвосте цикла**

В `runPickCycle` изменить сигнатуру и хвост. Сигнатура (файл ~строка 1869):

```ts
  runPickCycle({ isAutonomous, predecessorItem = null, topUp = false }:
    { isAutonomous: boolean; predecessorItem?: QueueItem | null; topUp?: boolean }) {
```

Сразу за ней, в расчёте `wantLink`, добавить условие `!topUp`:

```ts
    let wantLink = false;
    // Подводка рождается на СТЫКЕ и несёт `linkPrev` («это был X») и
    // `linkClockAt` (час, под который написана). Для трека, добранного на
    // четыре шага вперёд, оба поля были бы ложью к моменту выхода в эфир —
    // поэтому добор идёт молча, а реплика пишется штатным путём, когда этот
    // трек станет головой очереди.
    if (this.autoLink && isAutonomous && !topUp && this.history[0]) {
```

При доборе пик должен следовать за **хвостом очереди**, а не за тем, что играет. В том же месте, перед `this.pickerBusy = true;`:

```ts
    // Добираемый трек следует за последним в очереди — именно он будет его
    // предшественником в эфире. Без этого контекст пика («после чего играет»)
    // описывал бы стык, которого не будет.
    if (topUp && !predecessorItem && this.upcoming.length) {
      predecessorItem = this.upcoming[this.upcoming.length - 1];
    }
```

И в блоке `finally` — продолжение добора:

```ts
      } finally {
        this.pickerBusy = false;
        // Добор идёт по одному: `runPickCycle` — это один вызов агента, и
        // другого способа выбрать трек у станции нет. Повтор запускается
        // ТОЛЬКО если очередь выросла: неудачный пик (LLM недоступен, пул
        // пуст) иначе превратился бы в бесконечную череду вызовов.
        const grew = this.upcoming.length > queuedBefore;
        if (grew && this.autoPick && djCallsAllowed() && this.topUpWanted() > 0) {
          this.runPickCycle({ isAutonomous, topUp: true });
        }
      }
```

где `queuedBefore` снимается в самом начале асинхронного блока, первой строкой после `(async () => {`:

```ts
      const queuedBefore = this.upcoming.length;
```

- [x] **Шаг 5: Ограничить слив в Liquidsoap**

Без этого шага глубина бессмысленна: `drainAction` отдаёт элемент, как только у него появился преемник, поэтому четыре трека из пяти немедленно уехали бы в `dj_queue` — где заказ их уже не обгонит (вставка идёт перед первым **несданным**), а исключение из админки превращается в отзыв из Liquidsoap.

В `drainToLiquidsoap`, внутри `while (true)`, сразу после `if (!item) break;`:

```ts
        // Дальше одного несыгранного вперёд Liquidsoap кормить нельзя. Очередь
        // может быть глубокой — она наша и переставляется, — а `dj_queue` уже
        // отдана: вклинить в неё заказ невозможно (push() вставляет перед
        // первым НЕсданным), а отмена превращается в отзыв по rid. Один
        // сданный трек — ровно то, что станция держала до глубины очереди, и
        // этого достаточно, чтобы стык не остался без следующего файла.
        if (!force && this.upcoming.filter(i => i.sent).length >= DRAIN_AHEAD) break;
```

и рядом с прочими константами файла:

```ts
// Сколько выбранных треков разрешено держать в dj_queue Liquidsoap. Единица —
// поведение станции до глубины очереди: играет один, следующий отдан.
const DRAIN_AHEAD = 1;
```

- [x] **Шаг 6: Проверить типы, линтер и весь набор апстрима**

```bash
docker run --rm -v /tmp/sw-queue:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npm run lint && npm test" 2>&1 | tail -30
```

Expected: линтер чист, набор проходит. Особое внимание к `drain-policy.test.ts` и `airing.test.ts`: они пиннят поведение слива, и если падают — правка задела не то.

- [x] **Шаг 7: Коммит патча**

```bash
M=/c/AI/projects/music
cd /tmp/sw-queue && git add -A && git diff --cached HEAD -- controller/ > $M/station/docs/controller-changes.md
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/check-queue
cd /tmp/check-queue && git apply --check $M/station/docs/controller-changes.md && echo PATCH_OK
cd $M && git add station/docs/controller-changes.md
git commit -m "Глубина очереди: добор без подводки и придержанный слив"
```

Expected: `PATCH_OK`. **`git add -A` обязателен** — в патче теперь есть новый файл (`scripts/queue-lookahead.test.ts`).

---

### Task 4: Сборка, применение и проверка в эфире

**Files:**
- Create: `station/onboard/patches/2026-09-22-queue-lookahead.json`

- [x] **Шаг 1: Собрать образ и поднять**

```bash
cd /tmp/sw-queue && tar -czf /tmp/ctrl-queue.tar.gz .
scp -P <ssh-port> -i <ssh-key> /tmp/ctrl-queue.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf /tmp/ctrl-q && mkdir -p /tmp/ctrl-q
  tar -xzf /tmp/ctrl-queue.tar.gz -C /tmp/ctrl-q && cd /tmp/ctrl-q
  sudo docker build -f docker/Dockerfile.controller -t subwave-controller:1.8.0-ru . 2>&1 | tail -5
  cd <deploy-dir>/subwave && sudo docker compose up -d controller
  sleep 15 && sudo docker compose ps controller
'
```

Expected: образ собран, контейнер `Up`.

- [x] **Шаг 2: Убедиться, что поведение по умолчанию не изменилось**

До применения настройки станция работает с `lookahead = 1`.

```bash
set -a && . /c/AI/projects/_boss/secrets/vault.env && set +a
curl -s -u "$SUBWAVE_ADMIN_USER:$SUBWAVE_ADMIN_PASS" http://<station-host>:7700/api/state \
  | python -c "import json,sys; d=json.load(sys.stdin); print('в очереди:', len(d.get('upcoming', [])))"
```

Expected: 0 или 1 — как и раньше. Это контрольный замер «до»: без него нечем будет доказать, что глубина появилась от настройки, а не сама.

- [x] **Шаг 3: Применить настройку**

Создать `station/onboard/patches/2026-09-22-queue-lookahead.json`:

```json
{
  "queue": {
    "lookahead": 5
  }
}
```

```bash
cd /c/AI/projects/music
python station/onboard/onboard.py --patch station/onboard/patches/2026-09-22-queue-lookahead.json --dry-run
python station/onboard/onboard.py --patch station/onboard/patches/2026-09-22-queue-lookahead.json
```

Expected: «применено и сверено». Расхождение здесь означает, что блок не зарегистрирован в `patch-registry.ts` — контроллер молча отбросил незнакомый ключ, ровно та ловушка, ради которой сверка и делается.

- [x] **Шаг 4: Дождаться глубины и замерить**

Очередь наполняется по одному треку на вызов агента, поэтому пяти треков ждать несколько минут — и только при живом слушателе (`llm.pauseWhenEmpty`). Включить эфир в браузере и через 5–10 минут:

```bash
curl -s -u "$SUBWAVE_ADMIN_USER:$SUBWAVE_ADMIN_PASS" http://<station-host>:7700/api/state \
  | python -c "
import json,sys
d = json.load(sys.stdin)
up = d.get('upcoming', [])
print('в очереди:', len(up))
for i, t in enumerate(up, 1):
    print(f\"  {i}. {t.get('artist')} — {t.get('title')} · sent={t.get('sent')} · intro={bool(t.get('introScript'))}\")
"
```

Expected: до пяти строк; **`sent=True` не больше чем у одной**; `intro=True` — максимум у головы. Если сданных больше одной — не сработало ограничение слива (задача 3, шаг 5).

- [x] **Шаг 5: Проверить админку**

Открыть `http://<station-host>:7700/admin` → Dash. Expected: список Up next из пяти строк, у каждой кнопка удаления. Нажать её на третьей строке: трек исчезает, а через минуту-другую очередь снова добирается до пяти.

- [x] **Шаг 6: Проверить, что заказ обгоняет очередь**

Сделать заказ из плеера (или `POST /api/request`) и сразу посмотреть `/api/state`.
Expected: заказанный трек стоит **перед** несданными авто-пиками — первым или вторым, а не шестым. Это и есть та проверка, ради которой писался патч приоритета в сентябре: до глубины очереди обгонять было некого.

- [x] **Шаг 7: Послушать стык**

Полчаса эфира подряд. Expected: подводки звучат как прежде — на стыках, с верным «это был …»; ведущий не объявляет треки, которые ещё не играют. Если в эфире появилась подводка к треку, стоящему четвёртым, — значит `wantLink` при доборе не выключился.

- [x] **Шаг 8: Коммит**

```bash
git add station/onboard/patches/2026-09-22-queue-lookahead.json
git commit -m "Глубина очереди 5 на станции: настройка под версионированием"
```

---

### Task 5: Документация

**Files:**
- Modify: `station/docs/controller-changes.md`
- Modify: `station/docs/deploy.md`
- Modify: `CLAUDE.md`
- Modify: `IDEAS.md`

- [x] **Шаг 1: README контроллера**

Добавить раздел про глубину: что делает `queue.lookahead`, почему добор идёт по одному (один пик = один вызов агента), почему добранный трек без подводки, чем ограничена глубина (граница шоу), и — главное — **зачем придержан слив**: `dj_queue` отдана Liquidsoap, в ней не переставить заказ и не отменить трек иначе как отзывом по rid.

Снять из раздела «Чего этот патч НЕ даёт сегодня» утверждение, что приоритет заказа ни на что не влияет: теперь влияет.

- [x] **Шаг 2: Станционный README**

В таблицу «Состояние» — строка «Глубина очереди»: `queue.lookahead = 5`, в Liquidsoap отдаётся не больше одного трека вперёд.

- [x] **Шаг 3: Грабли проекта**

В `CLAUDE.md`, раздел «Грабли», добавить:
- глубина очереди без придержанного слива бессмысленна: апстрим отдаёт Liquidsoap всё, у чего есть преемник, а отданное не переставить;
- добранный трек кладётся без `introScript` — иначе `linkPrev` и `linkClockAt` врут системно;
- `POST /api/settings` молча отбрасывает незнакомый ключ, поэтому новая настройка контроллера требует и схемы, и записи в `patch-registry.ts`, и дефолта в `settings.ts` — трёх мест, а не одного.

- [x] **Шаг 4: Закрыть идею**

Из `IDEAS.md` удалить запись «2026-09-22 · Глубина очереди: пункт 10 заказчика и смысл уже сделанного приоритета» — реализованная идея удаляется, след остаётся в `git log` (правило проекта).

- [x] **Шаг 5: Прогнать быстрый набор проекта**

Run: `pytest --durations=5`
Expected: PASS, бюджет 60 с соблюдён. Этот план не добавляет тестов в `tests/` — его тест живёт в патче контроллера и гоняется `npm test`.

- [x] **Шаг 6: Коммит**

```bash
git add station/docs/controller-changes.md station/docs/deploy.md CLAUDE.md IDEAS.md
git commit -m "Глубина очереди: документация и закрытая идея"
```

---

## Что этот план не делает

- **Не пишет `GET /dj/upcoming`.** Админка берёт очередь из `GET /api/state` и уже рисует её с кнопкой удаления — эндпоинт из §6.4 спеки оказался лишним (разведка 2026-09-22).
- **Не правит показ в админке.** `upcoming.slice(0, 8)` вмещает пять. Понадобится больше восьми — правится одна цифра в патче `web`.
- **Не планирует подводки вперёд.** Реплика по-прежнему рождается на стыке; добор её не касается.
- **Не трогает `maybeDeadlinePick`.** Дедлайн-пик работает как прежде: он нужен, когда очередь пуста или в ней один held-элемент, а при глубине 5 эти условия просто не выполняются.
