# Уведомления чата — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Слушатель узнаёт о новом в чате, не держа ящик открытым: счётчик непрочитанного на точке «Чат», тост и системное уведомление на важное (ответ ведущего, упоминание имени), реплики ведущего и смена трека — строками в ленте чата.

**Architecture:** Вся работа — в плеере, комната и контроллер не меняются. Опрос комнаты поднимается из `ChatDrawer` в `ClassicSkin` новым хуком `useRoomFeed`; ящик становится представлением. «Что важно» и «как склеить ленту» вынесены в чистый модуль `lib/roomRules.ts` без React — только он и покрыт тестами, потому что тест-раннера для React у апстрима нет. Реплика ведущего опознаётся точно, по `turn.kind === 'chat'` в ленте сессии, которую `useStationFeed` уже отфильтровал по слышимости.

**Tech Stack:** TypeScript, React 19 / Next.js (апстрим subwave v1.8.0), sonner (тосты), Notification API, тестовый приём апстрима (`assert` + `✓/✗` + ненулевой выход, запуск `npx tsx`), Docker на Debian.

**Spec:** [`docs/superpowers/specs/2026-09-22-chat-notifications-design.md`](../specs/2026-09-22-chat-notifications-design.md)

## Global Constraints

- **Работа идёт в клоне апстрима на Debian, а не в этом репозитории.** Артефакт репозитория — [`station/docs/web-changes.md`](../web-changes.md); исходники живут в клоне и пересобираются в патч после каждой задачи.
- **Клон делать на Debian, не переносить архивом с Windows.** CRLF ломает shell-тесты апстрима — правило проекта. SSH: `ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host>`; порт 22 закрыт, это не отказ машины.
- **`.ts`/`.tsx` — UTF-8 без BOM, переводы строк LF.** После каждой отправки файла в клон проверять: `grep -lU $'\r' <файл>` должен молчать.
- **Патч пересобирать только через `git add -A`:** `cd <home>/sw-ru && git add -A && git diff --cached HEAD > <репо>/station/docs/web-changes.md`. `git diff HEAD` **молча портит патч** — не видит новых файлов, и патч выходит короче на столько файлов, сколько создано (проверено 2026-09-22: 28 против 30).
- **Правится один скин из шести** — `classic`. Остальные пять остаются апстримными; причина — в [`l10n/README.md`](../web-changes.md).
- **Комната (`station/room/`) и контроллер не меняются вовсе** — ни схемы, ни маршрутов, ни образов.
- **Клон держать на настоящем диске, а не в `/tmp`.** На этом Debian `/tmp` — tmpfs, то есть оперативная память (5.9 ГБ на машине с 12 ГБ, половина из которых занята постоянно). `npm ci` распаковывает туда сотни мегабайт и валит хост в OOM, а тот убивает соседей — при первой попытке досталось `syncthing` и `dbus-daemon`. Рабочий клон живёт в `<home>/sw-ru`.
- **Ни `node`, ни `npx` на хосте нет вовсе** — у проекта node живёт только внутри `web/Dockerfile`. Всё, что их требует, идёт одной обёрткой:
  ```bash
  sudo docker run --rm --user $(id -u):$(id -g) \
    -e HOME=/tmp -e npm_config_cache=/npm-cache -v <home>/.npm-cache:/npm-cache \
    -v <home>/sw-ru:/work -w /work/web --memory=3g \
    node:22-bookworm-slim npm ci --no-update-notifier
  ```
  Три части обязательны, и каждая куплена отдельной поломкой. `--user` — чтобы npm не оставил в клоне файлов от root; но с ним же `HOME` становится `/`, кэш уезжает в нечитаемый `/.npm`, и установка тонет в тысячах `TAR_ENTRY_ERROR ENOENT` — поэтому `HOME` и `npm_config_cache` задаются явно, а кэш монтируется **вне клона** (внутри он не попал бы в `.gitignore` и уехал бы в патч). `--memory` — чтобы при нехватке памяти умирал контейнер, а не радиостанция: на этом хосте живут эфир, git-сервер и шлюз LiteLLM, которым пользуются другие проекты.
- **Тег образа обязан совпадать с версией апстрима**: `subwave-web:1.8.0-ru`.
- **Громко звучат ровно два события:** реплика ведущего с `kind === 'chat'` и упоминание имени слушателя в чужом сообщении. Переключателя уровня шума в интерфейсе нет — это отклонено заказчиком.
- **История не шумит.** На первом удачном опросе комнаты и на первой пришедшей ленте сессии множество «виденного» засевается целиком.
- **Длина сообщения — 280 символов, имени — 40** (`TEXT_MAX`, `LISTENER_NAME_MAX`): те же цифры, что у заказа и в комнате.

## Структура файлов

| Файл | Ответственность |
|---|---|
| `web/lib/roomRules.ts` (создать) | чистые правила: непрочитанное, упоминание, отбор реплик ведущего, склейка ленты |
| `web/lib/roomRules.test.ts` (создать) | тест правил приёмом апстрима |
| `web/lib/roomNotify.ts` (создать) | системное уведомление: состояние разрешения, запрос, показ |
| `web/lib/roomNotify.test.ts` (создать) | тест решения о состоянии переключателя |
| `web/hooks/useRoomFeed.ts` (создать) | опрос комнаты, два курсора, отправка |
| `web/lib/listener.ts` (правка) | докуда дочитано и согласие на уведомления |
| `web/lib/notify.ts` (правка) | тост с кнопкой «Открыть» |
| `web/lib/platform.ts` (правка) | `isStandalone()` — вынести из `useInstallPrompt` |
| `web/hooks/useInstallPrompt.ts` (правка) | пользоваться вынесенным `isStandalone()` |
| `web/components/skins/classic/drawers/ChatDrawer.tsx` (правка) | представление ленты, форма, переключатель уведомлений |
| `web/components/skins/classic/ClassicSkin.tsx` (правка) | хук, `counts.chat`, громкие события, склейка ленты |
| `station/docs/web-changes.md` (правка) | раздел про уведомления и их границу |
| `IDEAS.md` (правка) | Web Push отдельным ярусом |

Отличие от таблицы §6 спеки: добавились `roomNotify.test.ts` и правка пары `platform.ts` / `useInstallPrompt.ts`. Второе — чтобы определение «приложение установлено» осталось в одном месте: `roomNotify` нужна та же проверка, что уже стоит внутри `useInstallPrompt`, и копировать её значило бы завести две правды о том, что такое standalone.

---

### Task 1: `roomRules.ts` — чистые правила и клон для работы

**Files:**
- Create: `web/lib/roomRules.ts` (в клоне)
- Test: `web/lib/roomRules.test.ts` (в клоне)
- Modify: `station/docs/web-changes.md` (пересборка)

**Interfaces:**
- Consumes: `SessionTurn` из `web/lib/types.ts` (апстрим: `{ t?, role?, kind?, text?, meta? }`).
- Produces: `RoomMessage { id: number; at: string; name: string; text: string }`; `FeedItem` (размеченное объединение `msg` / `dj` / `track`); `CHAT_SKILL = 'chat'`; `unreadCount(messages: RoomMessage[], lastSeenId: number): number`; `isMention(text: string, myName: string): boolean`; `turnKey(turn: SessionTurn): string`; `djChatReplies(turns: SessionTurn[], seen: ReadonlySet<string>): SessionTurn[]`; `mergeFeed(messages: RoomMessage[], events: FeedItem[], limit: number): FeedItem[]`.

- [x] **Шаг 1: Завести рабочий клон на Debian**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf <home>/sw-ru &&
  git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git <home>/sw-ru'
scp -P <ssh-port> -i <ssh-key> \
  <repo>/station/docs/web-changes.md <ssh-user>@<station-host>:/tmp/ru-web.patch
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd <home>/sw-ru && git apply /tmp/ru-web.patch && git status --porcelain | wc -l'
```

Expected: `git apply` молчит, `git status --porcelain` показывает **30** файлов. Другое число означает, что в репозитории лежит не тот патч, — разбирать до продолжения, не чинить наложением руками.

- [x] **Шаг 2: Написать падающий тест**

Записать локально и отправить в клон как `<home>/sw-ru/web/lib/roomRules.test.ts`:

```ts
// Правила уведомлений чата. Приём тот же, что у web/lib/audienceStats.test.ts
// апстрима (assert + ✓/✗ + ненулевой выход) — другого раннера у веб-части нет.
// Запуск из корня клона:  npx tsx web/lib/roomRules.test.ts

import assert from 'node:assert/strict';
import {
  unreadCount,
  isMention,
  turnKey,
  djChatReplies,
  mergeFeed,
  type RoomMessage,
  type FeedItem,
} from './roomRules';
import type { SessionTurn } from './types';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

function msg(id: number, text: string, name = 'Аня', at = '2026-09-22T12:00:00+00:00'): RoomMessage {
  return { id, at, name, text };
}

console.log('unreadCount');

test('считает только то, что новее курсора', () => {
  assert.equal(unreadCount([msg(1, 'раз'), msg(2, 'два'), msg(3, 'три')], 1), 2);
});

test('нулевой курсор означает, что не прочитано ничего', () => {
  assert.equal(unreadCount([msg(1, 'раз'), msg(2, 'два')], 0), 2);
});

test('курсор впереди ленты не даёт отрицательных', () => {
  assert.equal(unreadCount([msg(1, 'раз')], 99), 0);
});

console.log('isMention');

test('имя находится независимо от регистра', () => {
  assert.equal(isMention('Привет, АНЯ!', 'аня'), true);
});

test('имя внутри длинного слова упоминанием не считается', () => {
  // иначе слушатель по имени Ян получал бы тост на каждое «январь»
  assert.equal(isMention('в январе поставьте что-нибудь тёплое', 'Ян'), false);
});

test('имя на границе знаков препинания считается', () => {
  assert.equal(isMention('ян, слышишь?', 'Ян'), true);
});

test('ё и е — одна буква', () => {
  assert.equal(isMention('Алёна, привет', 'Алена'), true);
});

test('пустое имя не упоминается ничем', () => {
  assert.equal(isMention('кто-нибудь тут есть', ''), false);
});

test('однобуквенное имя не упоминается ничем', () => {
  // одна буква нашлась бы почти в любой фразе, и тост звучал бы постоянно
  assert.equal(isMention('а поставьте Кино', 'Я'), false);
});

console.log('djChatReplies');

function turn(kind: string, text: string, airedAt: string): SessionTurn {
  return { role: 'segment', kind, text, meta: { airedAt } };
}

test('отбирает реплики навыка chat', () => {
  const turns = [
    turn('link', 'а это была Кино', '2026-09-22T12:00:00.000Z'),
    turn('chat', 'Аня спрашивает про Кино — ставлю', '2026-09-22T12:01:00.000Z'),
  ];
  assert.deepEqual(djChatReplies(turns, new Set()).map(t => t.text), ['Аня спрашивает про Кино — ставлю']);
});

test('уже виденное не возвращается', () => {
  const t = turn('chat', 'привет, Аня', '2026-09-22T12:01:00.000Z');
  assert.deepEqual(djChatReplies([t], new Set([turnKey(t)])), []);
});

test('реплика без текста пропускается', () => {
  assert.deepEqual(djChatReplies([turn('chat', '', '2026-09-22T12:01:00.000Z')], new Set()), []);
});

test('ключ различает одинаковый текст в разное время', () => {
  // ведущий повторяется; по одному тексту вторая реплика сочлась бы виденной
  const a = turn('chat', 'привет', '2026-09-22T12:01:00.000Z');
  const b = turn('chat', 'привет', '2026-09-22T12:40:00.000Z');
  assert.notEqual(turnKey(a), turnKey(b));
});

console.log('mergeFeed');

const EV: FeedItem = { kind: 'track', key: 't1', at: Date.parse('2026-09-22T12:00:30Z'), text: 'сейчас играет Кино — Звезда' };

test('строки идут по времени, а не по источнику', () => {
  const out = mergeFeed(
    [msg(1, 'раз', 'Аня', '2026-09-22T12:00:00+00:00'), msg(2, 'два', 'Аня', '2026-09-22T12:01:00+00:00')],
    [EV],
    10,
  );
  assert.deepEqual(out.map(i => i.kind), ['msg', 'track', 'msg']);
});

test('лимит режет старое, а не свежее', () => {
  const many = [1, 2, 3, 4, 5].map(i => msg(i, `сообщение ${i}`, 'Аня', `2026-09-22T12:0${i}:00+00:00`));
  assert.deepEqual(mergeFeed(many, [], 2).map(i => (i.kind === 'msg' ? i.text : '')), ['сообщение 4', 'сообщение 5']);
});

test('пустая лента даёт пустой список, а не падение', () => {
  assert.deepEqual(mergeFeed([], [], 10), []);
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
```

Отправка в клон:

```bash
scp -P <ssh-port> -i <ssh-key> <локальный файл> <ssh-user>@<station-host>:<home>/sw-ru/web/lib/roomRules.test.ts
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'grep -lU $'"'"'\r'"'"' <home>/sw-ru/web/lib/roomRules.test.ts'
```

Expected: вторая команда ничего не печатает (CR в файле нет).

- [x] **Шаг 3: Запустить и убедиться, что падает**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && npx --yes tsx web/lib/roomRules.test.ts'
```

Expected: FAIL — `Cannot find module './roomRules'`.

- [x] **Шаг 4: Реализовать**

Записать и отправить как `<home>/sw-ru/web/lib/roomRules.ts`:

```ts
// Чистые правила чата: что считать непрочитанным, что — важным и в каком
// порядке показывать разнородные строки ленты.
//
// Без React и без сети, и это не вкусовщина. У веб-части апстрима нет
// тест-раннера, поэтому проверить можно только то, что не тянет за собой ни
// DOM, ни хуки; всё решающее вынесено сюда, а в хуке и разметке остаётся
// проводка (см. roomRules.test.ts).

import type { SessionTurn } from './types';

/** Сообщение комнаты — ровно то, что отдаёт `GET /room/messages`. */
export interface RoomMessage {
  id: number;
  at: string;
  name: string;
  text: string;
}

/** Строка ленты чата. `at` — миллисекунды, чтобы три разных источника
 *  сравнивались одним числом. */
export type FeedItem =
  | { kind: 'msg'; key: string; at: number; name: string; text: string }
  | { kind: 'dj'; key: string; at: number; text: string }
  | { kind: 'track'; key: string; at: number; text: string };

// Слаг навыка, чьи реплики считаются ответом на чат. Контроллер кладёт его в
// turn.kind, когда реплика произнесена (broadcast/queue.ts::onSpoken), а слаг
// равен имени каталога навыка в state/skills/.
export const CHAT_SKILL = 'chat';

export function unreadCount(messages: RoomMessage[], lastSeenId: number): number {
  return messages.reduce((n, m) => (m.id > lastSeenId ? n + 1 : n), 0);
}

// Сравнение идёт по свёрнутой форме: регистр не важен, ё и е — одна буква,
// латинская диакритика снимается. Кириллица под NFD тоже распадается (й → и +
// бревис), но обе стороны сворачиваются одинаково, поэтому на совпадение это
// не влияет.
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim();
}

const WORDISH = /[\p{L}\p{N}]/u;

/** Назвали ли слушателя по имени. Совпадение внутри длинного слова не в счёт:
 *  иначе «Ян» срабатывал бы на «январь». */
export function isMention(text: string, myName: string): boolean {
  const name = fold(myName);
  // Одна буква нашлась бы почти в любой фразе — такое имя упоминанием не
  // считается вовсе, иначе тост звучал бы постоянно.
  if (name.length < 2) return false;
  const hay = fold(text);
  let from = 0;
  for (;;) {
    const at = hay.indexOf(name, from);
    if (at < 0) return false;
    const before = at === 0 ? '' : (hay[at - 1] ?? '');
    const after = hay[at + name.length] ?? '';
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true;
    from = at + 1;
  }
}

/** Опознание реплики: время выхода в эфир плюс начало текста. Одного текста
 *  мало — ведущий повторяется, и вторая такая же реплика сошла бы за виденную. */
export function turnKey(turn: SessionTurn): string {
  const aired = turn.meta?.airedAt;
  const stamp = typeof aired === 'string' ? aired : String(turn.t ?? '');
  return `${stamp}|${(turn.text || '').slice(0, 64)}`;
}

/** Реплики ведущего, сказанные по навыку chat и ещё не показанные. */
export function djChatReplies(turns: SessionTurn[], seen: ReadonlySet<string>): SessionTurn[] {
  return turns.filter(t => t.kind === CHAT_SKILL && !!t.text && !seen.has(turnKey(t)));
}

export function mergeFeed(messages: RoomMessage[], events: FeedItem[], limit: number): FeedItem[] {
  const fromRoom: FeedItem[] = messages.map(m => ({
    kind: 'msg',
    key: `m${m.id}`,
    // Неразобранная метка времени уводит строку в начало ленты, а не роняет
    // склейку: комната отдаёт ISO-8601, но лента важнее одной кривой записи.
    at: Date.parse(m.at) || 0,
    name: m.name,
    text: m.text,
  }));
  return [...fromRoom, ...events]
    .sort((a, b) => a.at - b.at || a.key.localeCompare(b.key))
    .slice(-limit);
}
```

- [x] **Шаг 5: Запустить тест**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && npx --yes tsx web/lib/roomRules.test.ts'
```

Expected: PASS, 16 проверок, `all passed`.

- [x] **Шаг 6: Пересобрать патч и закоммитить**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && git add -A && git diff --cached HEAD' \
  > <repo>/station/docs/web-changes.md
cd <repo>
git add station/docs/web-changes.md
git commit -m "Правила уведомлений чата: что непрочитано, что важно, как склеить ленту"
```

---

### Task 2: локальное состояние слушателя, тост с кнопкой, `isStandalone`

**Files:**
- Modify: `web/lib/listener.ts` (в клоне)
- Modify: `web/lib/notify.ts` (в клоне)
- Modify: `web/lib/platform.ts` (в клоне)
- Modify: `web/hooks/useInstallPrompt.ts` (в клоне)
- Modify: `station/docs/web-changes.md`

**Interfaces:**
- Consumes: ничего из задачи 1.
- Produces: `Listener { id: string; name: string; lastSeenId: number; notify: boolean }`; `setLastSeenId(id: number): void`; `setNotifyEnabled(on: boolean): void`; `notify.chat(title: string, body: string, onOpen: () => void): void`; `isStandalone(): boolean`.

Тестов нет намеренно: это обёртки над `localStorage` и над `toast`, у которых нет решения внутри. Проверка — `tsc --noEmit` в шаге 5 и живой плеер в задаче 6.

- [x] **Шаг 1: Переписать `web/lib/listener.ts` целиком**

```ts
// Кто это пишет в чат и что он уже видел. Ни паролей, ни учётных записей:
// станция закрыта общим паролем, аудитория — семья, а подмена имени в
// localStorage даёт ровно то, что и так доступно — написать под чужим именем.
//
// `id` нужен не для доверия, а для частотного лимита комнаты: снаружи все
// слушатели приходят в стек ОДНИМ адресом (Caddy переписывает X-Forwarded-*
// для пиров вне trusted_proxies), поэтому лимит по IP считал бы семью за
// одного человека.
//
// Здесь же — «докуда дочитан чат» и согласие на системные уведомления. Это тот
// же локальный слепок слушателя, и второй ключ хранилища ради двух полей завёл
// бы два места, где живёт одно.
const KEY = 'subwave.listener';

export interface Listener {
  id: string;
  name: string;
  /** id последнего сообщения комнаты, которое человек видел своими глазами. */
  lastSeenId: number;
  /** Согласен ли слушатель на системные уведомления браузера. */
  notify: boolean;
}

// Та же цифра, что у имени в заказе (REQUEST_NAME_MAX) и в комнате: одно поле
// на двух формах одного плеера не должно жить по двум правилам.
export const LISTENER_NAME_MAX = 40;

function randomId(): string {
  // crypto.randomUUID есть не везде (http-контекст, старые webview) —
  // запасной путь важнее красоты: без id комната откажет в записи.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `l-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

const EMPTY: Listener = { id: '', name: '', lastSeenId: 0, notify: false };

export function listener(): Listener {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<Listener>;
      if (parsed && typeof parsed.id === 'string' && parsed.id) {
        return {
          id: parsed.id,
          name: typeof parsed.name === 'string' ? parsed.name : '',
          // Слепок, записанный до появления уведомлений, полей не имеет:
          // читать его надо как «ничего не прочитано, согласия нет», а не
          // ронять чат на NaN.
          lastSeenId: typeof parsed.lastSeenId === 'number' ? parsed.lastSeenId : 0,
          notify: parsed.notify === true,
        };
      }
    }
    const fresh = { ...EMPTY, id: randomId() };
    window.localStorage.setItem(KEY, JSON.stringify(fresh));
    return fresh;
  } catch {
    // Приватное окно и запрет на хранилище — не повод ломать плеер: чат в этой
    // вкладке будет работать до перезагрузки, под случайным id.
    return { ...EMPTY, id: randomId() };
  }
}

function patch(fields: Partial<Listener>): void {
  if (typeof window === 'undefined') return;
  const current = listener();
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...current, ...fields }));
  } catch {
    /* см. listener(): хранилище может быть запрещено */
  }
}

export function setListenerName(name: string): void {
  patch({ name: name.trim().slice(0, LISTENER_NAME_MAX) });
}

/** Курсор двигается только вперёд: «прочитано до N» нельзя отменить назад
 *  опоздавшим ответом комнаты. */
export function setLastSeenId(id: number): void {
  if (!Number.isFinite(id)) return;
  const current = listener();
  if (id <= current.lastSeenId) return;
  patch({ lastSeenId: id });
}

export function setNotifyEnabled(on: boolean): void {
  patch({ notify: on });
}
```

- [x] **Шаг 2: Добавить метод в `web/lib/notify.ts`**

В объект `notify`, после `undo`, вставить:

```ts
  // Тост о важном в чате. Отдельный метод, а не `info` с опциями: уведомление о
  // чате бесполезно, если из него нельзя попасть в чат, и форма у всех таких
  // тостов должна быть одна.
  chat: (title: string, body: string, onOpen: () => void) =>
    toast(title, {
      description: body,
      duration: 8000,
      action: { label: 'Открыть', onClick: onOpen },
    }),
```

- [x] **Шаг 3: Вынести `isStandalone()` в `web/lib/platform.ts`**

Дописать в конец файла:

```ts
// Станция открыта как установленное приложение, а не как вкладка. Проверку
// спрашивают двое — кнопка установки (ей нечего предлагать установленному) и
// системные уведомления (на iOS они работают только отсюда), поэтому она живёт
// здесь, а не внутри одного из них.
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    window.matchMedia?.('(display-mode: window-controls-overlay)').matches === true ||
    // Флаг самой Safari — у iOS нет media query на этот случай.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}
```

- [x] **Шаг 4: Позвать её из `web/hooks/useInstallPrompt.ts`**

Заменить импорт и четыре строки вычисления в эффекте:

```ts
import { isIOSDevice, isStandalone } from '@/lib/platform';
```

```ts
  useEffect(() => {
    setInstalled(isStandalone());
    setIos(isIOSDevice());
    setDeferred(window.__subwaveInstallPrompt ?? null);
```

(Локальная константа `standalone` вместе с её тремя проверками удаляется — она переехала в `platform.ts` без изменений.)

- [x] **Шаг 5: Проверить типы и линт**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru/web && npm ci --silent && npm run lint'
```

Expected: PASS. `npm ci` нужен один раз на клон; в следующих задачах хватит `npm run lint`.

- [x] **Шаг 6: Пересобрать патч и закоммитить**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && git add -A && git diff --cached HEAD' \
  > <repo>/station/docs/web-changes.md
cd <repo>
git add station/docs/web-changes.md
git commit -m "Слушатель помнит, докуда дочитал; тост обзавёлся кнопкой «Открыть»"
```

---

### Task 3: `useRoomFeed` — опрос, два курсора, отправка

**Files:**
- Create: `web/hooks/useRoomFeed.ts` (в клоне)
- Modify: `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `unreadCount`, `RoomMessage` (задача 1); `listener`, `setListenerName`, `setLastSeenId` (задача 2); `pollWhileVisible(fn, intervalMs, hiddenIntervalMs?)` из `@/lib/poll` — третий аргумент уже добавлен нашим патчем и возвращает интервал для скрытой вкладки либо `null`.
- Produces: `UseRoomFeedOptions { open: boolean; keepAliveWhenHidden?: RefObject<boolean>; onArrive?: (fresh: RoomMessage[], firstLoad: boolean) => void }`; `RoomFeed { messages: RoomMessage[]; unread: number; sending: boolean; send: (text: string, name: string) => Promise<string | null> }`; `useRoomFeed(options: UseRoomFeedOptions): RoomFeed`. `send` возвращает `null` при успехе и причину отказа строкой при неудаче.

Юнит-теста нет: React-раннера у апстрима не существует, и заводить его ради одного хука — это devDependency в патче и другая сборка. Решающая часть вынесена в задачу 1 именно поэтому; здесь остаётся проводка, и проверяется она типами (шаг 3) и живой станцией (задача 6).

- [x] **Шаг 1: Написать хук**

Записать и отправить как `<home>/sw-ru/web/hooks/useRoomFeed.ts`:

```ts
'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { pollWhileVisible } from '@/lib/poll';
import { listener, setLastSeenId, setListenerName } from '@/lib/listener';
import { unreadCount, type RoomMessage } from '@/lib/roomRules';

// Открытый ящик — как было до уведомлений. Закрытый опрашивается втрое реже:
// счётчику на точке секунды не важны, а это телефон в кармане.
const OPEN_POLL_MS = 5_000;
const CLOSED_POLL_MS = 30_000;
// Сколько сообщений держим в памяти вкладки; лента комнаты длиннее.
const KEEP_MESSAGES = 100;

export interface UseRoomFeedOptions {
  /** Открыт ли ящик чата: от этого зависит и частота опроса, и то, считается
   *  ли пришедшее прочитанным. */
  open: boolean;
  /** Скрытая вкладка опрашивает комнату, только пока играет эфир: страница при
   *  этом и так жива и ходит за /now-playing. Ref, а не значение, — чтобы
   *  включение эфира не пересобирало подписку (тот же приём, что у
   *  useStationFeed). */
  keepAliveWhenHidden?: RefObject<boolean>;
  /** Зовётся на каждой непустой пачке. `firstLoad` — пачка первого удачного
   *  опроса: по ней ничего не должно звучать, это история, а не новое. */
  onArrive?: (fresh: RoomMessage[], firstLoad: boolean) => void;
}

export interface RoomFeed {
  messages: RoomMessage[];
  unread: number;
  sending: boolean;
  /** `null` — отправлено; строка — причина отказа для показа человеку. */
  send: (text: string, name: string) => Promise<string | null>;
}

export function useRoomFeed({ open, keepAliveWhenHidden, onArrive }: UseRoomFeedOptions): RoomFeed {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [unread, setUnread] = useState(0);
  const [sending, setSending] = useState(false);
  // Докуда СКАЧАНО из комнаты. Не путать с lastSeenRef: докуда ПРОЧИТАНО
  // человеком. Скачать можно при закрытом ящике, прочитать — нет.
  const sinceRef = useRef(0);
  const lastSeenRef = useRef(0);
  const firstLoadRef = useRef(true);
  const openRef = useRef(open);
  const arriveRef = useRef(onArrive);

  useEffect(() => { arriveRef.current = onArrive; }, [onArrive]);
  useEffect(() => { openRef.current = open; }, [open]);
  // Первым эффектом, до опроса: listener() трогает localStorage, и делать это
  // в теле рендера нельзя. Порядок эффектов в React — порядок объявления.
  useEffect(() => { lastSeenRef.current = listener().lastSeenId; }, []);

  const markRead = useCallback((upTo: number) => {
    if (upTo > lastSeenRef.current) {
      lastSeenRef.current = upTo;
      setLastSeenId(upTo);
    }
    setUnread(0);
  }, []);

  const poll = useCallback(async () => {
    try {
      const r = await fetch(`/room/messages?since=${sinceRef.current}`);
      if (!r.ok) return;
      const body = (await r.json()) as { messages: RoomMessage[]; last: number };
      const fresh = body.messages || [];
      const wasFirst = firstLoadRef.current;
      firstLoadRef.current = false;
      if (!fresh.length) return;
      sinceRef.current = body.last;
      setMessages(prev => [...prev, ...fresh].slice(-KEEP_MESSAGES));
      if (openRef.current) markRead(body.last);
      else setUnread(n => n + unreadCount(fresh, lastSeenRef.current));
      arriveRef.current?.(fresh, wasFirst);
    } catch {
      /* комната недоступна — лента просто не пополняется */
    }
  }, [markRead]);

  // Ящик открыли — всё, что в нём видно, прочитано. pollWhileVisible на
  // переднем плане стреляет сразу, поэтому свежее подтянется тем же движением.
  useEffect(() => { if (open) markRead(sinceRef.current); }, [open, markRead]);

  useEffect(() => pollWhileVisible(
    () => { void poll(); },
    open ? OPEN_POLL_MS : CLOSED_POLL_MS,
    () => (keepAliveWhenHidden?.current ? CLOSED_POLL_MS : null),
  ), [open, poll, keepAliveWhenHidden]);

  const send = useCallback(async (text: string, name: string): Promise<string | null> => {
    const body = text.trim();
    if (!body) return 'Пустое сообщение';
    const who = name.trim();
    if (!who) return 'Как вас зовут? Ведущий обращается по имени.';
    setSending(true);
    try {
      setListenerName(who);
      const me = listener();
      const r = await fetch('/room/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Listener-Id': me.id,
          // Заголовки по RFC 7230 — latin-1, кириллица в них иначе не проходит.
          'X-Listener-Name': encodeURIComponent(who),
        },
        body: JSON.stringify({ text: body }),
      });
      const payload = (await r.json().catch(() => null)) as { id?: number; error?: string } | null;
      if (!r.ok) return payload?.error || 'Сообщение не отправлено';
      // Курсор двигается по ответу комнаты, а не по приходу своего сообщения
      // следующим опросом: иначе закрытый сразу после отправки ящик посчитал бы
      // собственную реплику непрочитанной.
      if (typeof payload?.id === 'number') markRead(payload.id);
      void poll();
      return null;
    } catch {
      return 'Комната недоступна';
    } finally {
      setSending(false);
    }
  }, [markRead, poll]);

  return { messages, unread, sending, send };
}
```

- [x] **Шаг 2: Отправить в клон и проверить переводы строк**

```bash
scp -P <ssh-port> -i <ssh-key> <локальный файл> <ssh-user>@<station-host>:<home>/sw-ru/web/hooks/useRoomFeed.ts
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'grep -lU $'"'"'\r'"'"' <home>/sw-ru/web/hooks/useRoomFeed.ts'
```

Expected: вторая команда молчит.

- [x] **Шаг 3: Проверить типы и линт**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru/web && npm run lint'
```

Expected: PASS. Хук пока никем не вызывается — это ожидаемо и ошибкой не является.

- [x] **Шаг 4: Пересобрать патч и закоммитить**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && git add -A && git diff --cached HEAD' \
  > <repo>/station/docs/web-changes.md
cd <repo>
git add station/docs/web-changes.md
git commit -m "Опрос комнаты живёт выше ящика: два курсора и частота по состоянию"
```

---

### Task 4: `roomNotify` — системное уведомление и его гейт

**Files:**
- Create: `web/lib/roomNotify.ts` (в клоне)
- Test: `web/lib/roomNotify.test.ts` (в клоне)
- Modify: `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `isIOSDevice`, `isStandalone` из `@/lib/platform` (задача 2).
- Produces: `NotifyState = 'ready' | 'ask' | 'denied' | 'ios-install' | 'unsupported'`; `NotifyEnv { supported: boolean; permission: 'default' | 'granted' | 'denied'; ios: boolean; standalone: boolean }`; `notifyState(env: NotifyEnv): NotifyState`; `readEnv(): NotifyEnv`; `askPermission(): Promise<NotifyState>`; `showHidden(title: string, body: string, onClick: () => void): void`.

- [x] **Шаг 1: Написать падающий тест**

Записать и отправить как `<home>/sw-ru/web/lib/roomNotify.test.ts`:

```ts
// Решение о том, что показывать вместо переключателя уведомлений. Приём — как
// в roomRules.test.ts. Запуск:  npx tsx web/lib/roomNotify.test.ts

import assert from 'node:assert/strict';
import { notifyState, type NotifyEnv } from './roomNotify';

let failures = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.error(`  ✗ ${name}\n      ${(err as Error)?.message || err}`);
  }
}

const BASE: NotifyEnv = { supported: true, permission: 'default', ios: false, standalone: false };

test('разрешение дано — переключатель обычный', () => {
  assert.equal(notifyState({ ...BASE, permission: 'granted' }), 'ready');
});

test('разрешение не спрашивали — предлагаем спросить', () => {
  assert.equal(notifyState(BASE), 'ask');
});

test('запрет браузера назван запретом, а не поломкой', () => {
  assert.equal(notifyState({ ...BASE, permission: 'denied' }), 'denied');
});

test('iOS во вкладке отправляет ставить приложение', () => {
  // в обычной вкладке Safari уведомлений нет вовсе: показать там переключатель
  // значит показать кнопку, которая молча ничего не делает
  assert.equal(notifyState({ ...BASE, ios: true, standalone: false }), 'ios-install');
});

test('iOS в установленном приложении работает как все', () => {
  assert.equal(notifyState({ ...BASE, ios: true, standalone: true, permission: 'granted' }), 'ready');
});

test('браузер без Notification честно говорит, что не умеет', () => {
  assert.equal(notifyState({ ...BASE, supported: false }), 'unsupported');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
```

- [x] **Шаг 2: Запустить и убедиться, что падает**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && npx --yes tsx web/lib/roomNotify.test.ts'
```

Expected: FAIL — `Cannot find module './roomNotify'`.

- [x] **Шаг 3: Реализовать**

Записать и отправить как `<home>/sw-ru/web/lib/roomNotify.ts`:

```ts
'use client';

// Системное уведомление браузера о важном в чате.
//
// Показывается ТОЛЬКО при скрытой вкладке: на открытой своё дело делает тост, а
// два уведомления об одном — это шум, а не забота.
//
// Разрешение браузер даёт лишь по жесту человека, поэтому спрашивает его
// askPermission() из переключателя в ящике, а не страница при загрузке.

import { isIOSDevice, isStandalone } from './platform';

export type NotifyState = 'ready' | 'ask' | 'denied' | 'ios-install' | 'unsupported';

export interface NotifyEnv {
  supported: boolean;
  permission: 'default' | 'granted' | 'denied';
  ios: boolean;
  standalone: boolean;
}

/** Чистое решение: что показывать вместо переключателя. Вынесено из readEnv,
 *  потому что проверить можно только то, у чего нет окружения. */
export function notifyState(env: NotifyEnv): NotifyState {
  // Порядок проверок важен: на iOS вне установленного приложения объекта
  // Notification либо нет, либо запрос молча не срабатывает, и сказать про
  // «Поделиться → На экран „Домой"» полезнее, чем про «браузер не умеет».
  if (env.ios && !env.standalone) return 'ios-install';
  if (!env.supported) return 'unsupported';
  if (env.permission === 'denied') return 'denied';
  if (env.permission === 'granted') return 'ready';
  return 'ask';
}

export function readEnv(): NotifyEnv {
  if (typeof window === 'undefined') {
    return { supported: false, permission: 'default', ios: false, standalone: false };
  }
  const supported = 'Notification' in window;
  return {
    supported,
    permission: supported ? Notification.permission : 'default',
    ios: isIOSDevice(),
    standalone: isStandalone(),
  };
}

/** Спросить разрешение. Зовётся только из обработчика нажатия: без жеста
 *  браузеры запрос игнорируют. */
export async function askPermission(): Promise<NotifyState> {
  const env = readEnv();
  const state = notifyState(env);
  if (state !== 'ask') return state;
  try {
    const answer = await Notification.requestPermission();
    return notifyState({ ...env, permission: answer });
  } catch {
    return 'unsupported';
  }
}

export function showHidden(title: string, body: string, onClick: () => void): void {
  if (typeof document === 'undefined' || !document.hidden) return;
  if (notifyState(readEnv()) !== 'ready') return;
  try {
    // Один tag на весь чат: пока слушатель не вернулся, три сообщения подряд
    // должны сменять друг друга в шторке, а не выстроиться в стопку.
    const n = new Notification(title, { body, tag: 'subwave-chat', icon: '/icons/192' });
    n.onclick = () => {
      window.focus();
      n.close();
      onClick();
    };
  } catch {
    /* браузер вправе отказать и с granted (например, в фоновом окне) */
  }
}
```

- [x] **Шаг 4: Запустить тест и линт**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd <home>/sw-ru && npx --yes tsx web/lib/roomNotify.test.ts && cd web && npm run lint'
```

Expected: PASS, 6 проверок, затем чистый линт.

- [x] **Шаг 5: Пересобрать патч и закоммитить**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && git add -A && git diff --cached HEAD' \
  > <repo>/station/docs/web-changes.md
cd <repo>
git add station/docs/web-changes.md
git commit -m "Системное уведомление: гейт разрешения и честный ответ на каждом отказе"
```

---

### Task 5: ящик становится представлением, скин — источником

**Files:**
- Modify: `web/components/skins/classic/drawers/ChatDrawer.tsx` (в клоне, переписывается целиком)
- Modify: `web/components/skins/classic/ClassicSkin.tsx` (в клоне)
- Modify: `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `useRoomFeed` (задача 3); `mergeFeed`, `djChatReplies`, `turnKey`, `isMention`, `type FeedItem` (задача 1); `notify.chat` (задача 2); `askPermission`, `readEnv`, `notifyState`, `showHidden` (задача 4); `listener`, `setNotifyEnabled`, `LISTENER_NAME_MAX` (задача 2).
- Produces: `ChatDrawerProps { items: FeedItem[]; send: (text: string, name: string) => Promise<string | null>; sending: boolean }`.

Обе правки идут одним коммитом намеренно: ящик после переписывания требует пропсов, и без правки скина сборка не соберётся.

- [x] **Шаг 1: Переписать `ChatDrawer.tsx` целиком**

```tsx
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { listener, setNotifyEnabled, LISTENER_NAME_MAX } from '@/lib/listener';
import { askPermission, notifyState, readEnv, type NotifyState } from '@/lib/roomNotify';
import type { FeedItem } from '@/lib/roomRules';

const TEXT_MAX = 280;        // та же цифра, что у заказа (REQUEST_TEXT_MAX)

// Что написано вместо переключателя, когда включать нечего. Молчать нельзя:
// невидимая причина читается как поломка.
const NOTIFY_EXPLAIN: Partial<Record<NotifyState, string>> = {
  denied: 'Уведомления запрещены в настройках браузера',
  'ios-install': 'Уведомления на iPhone — только из установленного приложения',
  unsupported: 'Этот браузер не умеет системные уведомления',
};

export interface ChatDrawerProps {
  /** Лента целиком: сообщения комнаты вперемешку со строками станции. Склейку
   *  делает скин — у него одного есть и комната, и эфир. */
  items: FeedItem[];
  send: (text: string, name: string) => Promise<string | null>;
  sending: boolean;
}

export default function ChatDrawer({ items, send, sending }: ChatDrawerProps) {
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notifyOn, setNotifyOn] = useState(false);
  const [state, setState] = useState<NotifyState>('ask');
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const me = listener();
    setName(me.name);
    setNotifyOn(me.notify);
    setState(notifyState(readEnv()));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items]);

  const toggleNotify = useCallback(async () => {
    if (notifyOn) {
      setNotifyOn(false);
      setNotifyEnabled(false);
      return;
    }
    const next = await askPermission();
    setState(next);
    const on = next === 'ready';
    setNotifyOn(on);
    setNotifyEnabled(on);
  }, [notifyOn]);

  const submit = useCallback(async () => {
    if (sending) return;
    const problemText = await send(text, name);
    setProblem(problemText);
    if (!problemText) setText('');
  }, [send, text, name, sending]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {items.length === 0 ? (
          <div className="text-[13px] leading-relaxed text-muted">
            Пока тихо. Напишите — ведущий читает чат и отвечает в эфире.
          </div>
        ) : (
          items.map(item =>
            item.kind === 'msg' ? (
              <div key={item.key} className="border-b border-separator-soft py-[10px]">
                <div className="text-[9px] tracking-[0.3em] text-muted uppercase">{item.name}</div>
                <div className="mt-0.5 text-sm text-ink">{item.text}</div>
              </div>
            ) : item.kind === 'dj' ? (
              <div key={item.key} className="border-b border-separator-soft py-[10px]">
                <div className="text-[9px] tracking-[0.3em] text-vermilion uppercase">Ведущий</div>
                <div className="mt-0.5 text-sm text-ink">{item.text}</div>
              </div>
            ) : (
              <div key={item.key} className="py-[10px] text-[11px] text-muted">
                ♪ {item.text}
              </div>
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div className="flex flex-col gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={LISTENER_NAME_MAX}
          placeholder="Ваше имя"
          aria-label="Ваше имя"
          className="w-full rounded border border-separator-strong bg-transparent px-2 py-1 text-sm"
        />
        <textarea
          value={text}
          onChange={e => setText(e.target.value.slice(0, TEXT_MAX))}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={2}
          placeholder="Сообщение ведущему"
          aria-label="Сообщение ведущему"
          className="w-full resize-none rounded border border-separator-strong bg-transparent px-2 py-1 text-sm"
        />
        {problem && <div className="text-xs text-vermilion">{problem}</div>}
        <div className="flex items-center justify-between gap-2">
          {state === 'ask' || state === 'ready' ? (
            <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
              <input type="checkbox" checked={notifyOn} onChange={() => void toggleNotify()} />
              Уведомлять о важном
            </label>
          ) : (
            <span className="text-[11px] text-muted">{NOTIFY_EXPLAIN[state]}</span>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={sending || !text.trim()}
            className="self-end rounded bg-vermilion px-3 py-1 text-xs tracking-eyebrow uppercase disabled:opacity-40"
          >
            {sending ? 'Отправляю…' : 'Отправить'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [x] **Шаг 2: Подключить в `ClassicSkin.tsx`**

Импорты. `lucide-react` в файле **уже импортируется** строкой `import { CalendarClock, History, Mic } from 'lucide-react';` — `MessageSquare` дописывается в неё, отдельным импортом из того же модуля нельзя (дубль, eslint ругается). Хуки React (`useCallback`, `useEffect`, `useMemo`, `useRef`, `useState`) тоже уже все импортированы. Остальное — новыми строками:

```tsx
// в существующую строку lucide-react: { CalendarClock, History, MessageSquare, Mic }
import { useRoomFeed } from '@/hooks/useRoomFeed';
import { notify } from '@/lib/notify';
import { listener } from '@/lib/listener';
import { showHidden } from '@/lib/roomNotify';
import { djChatReplies, isMention, mergeFeed, turnKey, type FeedItem, type RoomMessage } from '@/lib/roomRules';
```

Рядом с `TIMELINE_ICON` / `BOOTH_ICON` / `SCHEDULE_ICON` — четвёртая вынесенная константа (иначе `React.memo` на `DotRail` перестанет держать):

```tsx
const CHAT_ICON = <MessageSquare size={18} strokeWidth={1.5} />;
// Сколько строк держим в ящике: сообщения комнаты плюс строки станции.
const CHAT_FEED_MAX = 100;
```

Внутри компонента, после существующих хуков:

```tsx
  const chatOpen = drawer === 'chat';
  // Своя копия «эфир играет» ссылкой: такая же есть в PlayerCore для ленты
  // станции, но она не выставлена наружу, а расширять контекст ради одного
  // потребителя — дороже, чем две строки здесь.
  const tunedInRef = useRef(false);
  useEffect(() => { tunedInRef.current = tunedIn; }, [tunedIn]);

  const [chatEvents, setChatEvents] = useState<FeedItem[]>([]);
  const openChat = useCallback(() => setDrawer('chat'), []);

  // Громкое на сообщения комнаты: только упоминание имени. Первая пачка — это
  // история, и звучать она не должна.
  const onArrive = useCallback((fresh: RoomMessage[], firstLoad: boolean) => {
    if (firstLoad) return;
    const me = listener().name;
    for (const m of fresh) {
      if (!isMention(m.text, me)) continue;
      if (!chatOpen) notify.chat(m.name, m.text, openChat);
      showHidden(m.name, m.text, openChat);
    }
  }, [chatOpen, openChat]);

  const room = useRoomFeed({ open: chatOpen, keepAliveWhenHidden: tunedInRef, onArrive });
```

Реплики ведущего — отдельным эффектом по ленте студии:

```tsx
  // Лента студии уже отфильтрована по слышимости (useStationFeed →
  // splitAudibleTurns), поэтому реплика попадает в чат ровно тогда, когда
  // слушатель её слышит, а не когда контроллер её сочинил.
  const seenTurnsRef = useRef<Set<string>>(new Set());
  const boothSeededRef = useRef(false);
  useEffect(() => {
    if (!boothFeed.length) return;
    const replies = djChatReplies(boothFeed, seenTurnsRef.current);
    for (const t of replies) seenTurnsRef.current.add(turnKey(t));
    if (!replies.length) return;
    setChatEvents(prev => [
      ...prev,
      ...replies.map(t => ({
        kind: 'dj' as const,
        key: turnKey(t),
        at: Date.parse(String(t.meta?.airedAt ?? '')) || Date.now(),
        text: t.text || '',
      })),
    ].slice(-CHAT_FEED_MAX));
    // Первая пришедшая лента — окно истории. Она должна быть ВИДНА: лента
    // комнаты после перезагрузки возвращается целиком, и ответы ведущего не
    // могут при этом пропадать — иначе в чате остаются люди, говорящие в
    // пустоту. Молчать она обязана: иначе перезагрузка выстреливала бы тостами
    // по всему, что ведущий успел сказать за последние полчаса. Поэтому
    // добавление в ленту стоит ВЫШЕ этой проверки, а гасится только громкое.
    if (!boothSeededRef.current) {
      boothSeededRef.current = true;
      return;
    }
    // `at(-1)`, а не индекс: при включённом `noUncheckedIndexedAccess` доступ
    // по вычисленному индексу не сужается проверкой `.length`, и пришлось бы
    // ставить `!`. Эта форма даёт и сужение типа, и охрану пустоты.
    const last = replies.at(-1);
    if (!last) return;
    if (!chatOpen) notify.chat('Ведущий ответил', last.text || '', openChat);
    showHidden('Ведущий ответил', last.text || '', openChat);
  }, [boothFeed, chatOpen, openChat]);
```

Смена трека — строкой в ленте, без тоста и без уведомления:

```tsx
  // Смена трека в ленте чата — контекст разговора, а не повод дёргать человека:
  // ни тоста, ни системного уведомления она не даёт.
  const trackLineRef = useRef<string | null>(null);
  useEffect(() => {
    const title = nowPlaying?.title?.trim();
    if (!title) return;
    const line = `${nowPlaying?.artist?.trim() || 'неизвестный исполнитель'} — ${title}`;
    if (trackLineRef.current === line) return;
    const first = trackLineRef.current === null;
    trackLineRef.current = line;
    if (first) return;   // то, что играло при открытии страницы, новостью не является
    setChatEvents(prev => [
      ...prev,
      { kind: 'track' as const, key: `t${Date.now()}`, at: Date.now(), text: `сейчас играет ${line}` },
    ].slice(-CHAT_FEED_MAX));
  }, [nowPlaying?.title, nowPlaying?.artist]);

  const chatItems = useMemo(
    () => mergeFeed(room.messages, chatEvents, CHAT_FEED_MAX),
    [room.messages, chatEvents],
  );
```

Счётчик на рейке — в существующий `dotRailCounts`:

```tsx
  const dotRailCounts = useMemo(
    () => ({
      timeline: upcomingCount || TIMELINE_ICON,
      booth: BOOTH_ICON,
      schedule: SCHEDULE_ICON,
      // Без этой строки на точке «Чат» висел бы вечный 0: DotRail подставляет
      // `counts?.[k] ?? 0`, а пятую точку добавил наш патч.
      chat: room.unread || CHAT_ICON,
    }),
    [upcomingCount, room.unread],
  );
```

И отрисовка ящика:

```tsx
        {drawer === 'chat'     && <ChatDrawer items={chatItems} send={room.send} sending={room.sending} />}
```

- [x] **Шаг 3: Проверить типы и линт**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru/web && npm run lint'
```

Expected: PASS. Если `tsc` ругается на `useRef`/`useMemo`/`useCallback` — их нет в списке импортов `react` у `ClassicSkin.tsx`, дописать недостающие.

- [x] **Шаг 4: Пересобрать патч и закоммитить**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd <home>/sw-ru && git add -A && git diff --cached HEAD' \
  > <repo>/station/docs/web-changes.md
cd <repo>
git add station/docs/web-changes.md
git commit -m "Ящик чата — представление, скин — источник: счётчик, тосты, лента со станцией"
```

---

### Task 6: сборка, приёмка на живой станции, документация

**Files:**
- Modify: `station/docs/web-changes.md`
- Modify: `IDEAS.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: патч из задач 1–5.
- Produces: образ `subwave-web:1.8.0-ru` на Debian, поднятый контейнер `web`.

- [x] **Шаг 1: Проверить, что патч ложится на чистый клон**

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf /tmp/check && git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/check >/dev/null 2>&1'
scp -P <ssh-port> -i <ssh-key> \
  <repo>/station/docs/web-changes.md <ssh-user>@<station-host>:/tmp/ru-web.patch
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'cd /tmp/check && git apply --check /tmp/ru-web.patch && echo APPLIES'
```

Expected: `APPLIES`. Проверять надо на **чистом** клоне, а не на том, где работали, — это правило `l10n/README.md`.

- [ ] **Шаг 2: Собрать образ** — за владельцем

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd <home>/sw-ru && sudo docker build -f web/Dockerfile -t subwave-web:1.8.0-ru \
    --build-arg SUBWAVE_BUILD_VERSION=1.8.0-ru . 2>&1 | tail -5'
```

Expected: успешная сборка, около двух минут. Падение на `Turbopack is not supported ... swc-linux-x64-musl` — это битый слой `deps` в кэше docker, а не платформа: повторить с `--no-cache`.

- [ ] **Шаг 3: Поднять** — за владельцем

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd <deploy-dir>/subwave && sudo docker compose up -d web && sleep 5 && sudo docker ps --filter name=sub-wave-web --format "{{.Status}}"'
```

Expected: `Up …`.

- [ ] **Шаг 4: Приёмка глазами — восемь критериев спеки** — за владельцем: нужны два устройства, живой эфир и уши

Открыть `https://<station-domain>` и проверить по порядку. Нужны два устройства (или две вкладки под разными именами — id слушателя живёт в `localStorage` вкладки).

| # | Что сделать | Что должно быть |
|---|---|---|
| 1 | Открыть плеер, не открывая чат | на точке «Чат» значок, а не `0` |
| 2 | Написать со второго устройства | точка показывает `1`, затем растёт |
| 3 | Открыть ящик, закрыть, перезагрузить страницу | счётчик ноль и после перезагрузки |
| 4 | Со второго устройства написать с вашим именем | тост с кнопкой «Открыть», кнопка открывает чат |
| 5 | Написать ведущему и дождаться ответа в эфире | реплика появляется в ленте чата в момент, когда слышна |
| 6 | Включить «Уведомлять о важном», свернуть вкладку при играющем эфире, написать со второго устройства с упоминанием | системное уведомление в шторке |
| 7 | Выключить эфир, свернуть вкладку, написать | уведомления нет — это граница, а не поломка |
| 8 | Перезагрузить страницу при непустой ленте | ни одного тоста |

Каждый несошедшийся пункт — стоп: разбирать до продолжения, а не записывать в находки.

- [x] **Шаг 5: Дописать раздел в `station/docs/web-changes.md`**

После раздела «Пятый ящик — чат» вставить:

```markdown
## Уведомления чата

Добавлены 2026-09-22. Опрос комнаты поднят из ящика в скин
(`hooks/useRoomFeed.ts`): закрытый ящик теперь тоже опрашивает, но вшестеро реже
(30 с против 5). Непрочитанное показывает **рейка точек** — у апстрима она уже
умеет счётчик (`counts`), и до этой правки на точке «Чат» висел вечный `0`.

Громко звучат ровно два события: реплика ведущего с `kind === 'chat'` и
упоминание имени слушателя. Всё прочее — счётчик. Правила лежат в
`lib/roomRules.ts` без React и покрыты тестом (`npx tsx web/lib/roomRules.test.ts`);
это единственная часть патча, у которой есть автоматическая проверка.

**«Ведущий ответил» опознаётся точно, а не по тексту.** Контроллер кладёт в
каждую произнесённую реплику слаг навыка (`broadcast/queue.ts::onSpoken`), а
`useStationFeed` отдаёт ленту уже отфильтрованной по слышимости — поэтому
реплика попадает в чат ровно тогда, когда её слышно здесь.

**Граница, о которой надо знать:** при **выключенном эфире и свёрнутой вкладке
уведомлений не будет**. Браузер замораживает скрытую вкладку, и опрос
продолжается только пока играет звук (страница и так жива и ходит за
`/now-playing`). Пробить это может лишь настоящий Web Push — VAPID, service
worker и хранение подписок; он вынесен в `IDEAS.md`.

**Служебные строки ленты живут в памяти вкладки.** «Сейчас играет» и реплики
ведущего в комнату не пишутся и перезагрузку страницы не переживают — в отличие
от сообщений слушателей. Писать их в комнату нельзя: навык `chat` читает
`/unread` и получил бы на вход собственные реплики, то есть зачитал бы их в
эфире как сообщения слушателей.
```

- [x] **Шаг 6: Завести идею про Web Push в `IDEAS.md`**

Дописать **в начало** файла, после шапки:

```markdown
## 2026-09-22 · Web Push: уведомления чата при закрытой вкладке [P3]
**Context:** спека [2026-09-22-chat-notifications-design.md](../specs/2026-09-22-chat-notifications-design.md) §4.5,
граница описана в [l10n/README.md](../web-changes.md).
**What:** системные уведомления сделаны через `Notification API` из живой
страницы, поэтому работают, только пока вкладка открыта, а при свёрнутой — лишь
пока играет эфир (иначе браузер её замораживает). При закрытой вкладке
уведомлений нет вовсе.
**Proposal:** Web Push: VAPID-ключи, обработчик `push` в service worker
апстрима, хранение подписок в комнате (`station/room/`) и отправка из неё при
появлении важного. Отдельный ярус: трогает и комнату, и service worker, и
добавляет серверу исходящие запросы к push-сервисам Google и Apple.
**Status:** proposed
```

- [ ] **Шаг 7: Дописать грабли в `CLAUDE.md`** — не сделано: файл занят незакоммиченной правкой соседней сессии, свой коммит утащил бы чужую работу

В раздел «Грабли», рядом с прочими строками про subwave:

```markdown
- **Точка рейки без переданного `counts` показывает `0`, а не пустоту.** `DotRail`
  подставляет `counts?.[k] ?? 0`, поэтому добавленная точка выглядит как счётчик,
  застрявший на нуле, пока ей не начали передавать значение.
- **Реплику, сказанную по навыку, опознаёт `turn.kind`** — это слаг навыка
  (`broadcast/queue.ts::onSpoken`). Угадывать «ведущий ответил на чат» по тексту не нужно.
- **Своих реплик ведущего в комнате быть не должно.** Навык `chat` читает `/unread`:
  всё, что туда записано, он считает сообщением слушателя и зачитает в эфире.
```

- [x] **Шаг 8: Отметить план исполненным и закоммитить**

```bash
cd <repo>
git add station/docs/web-changes.md IDEAS.md CLAUDE.md docs/superpowers/plans/2026-09-22-chat-notifications.md
git commit -m "Уведомления чата в эфире: приёмка, документация и отложенный Web Push"
```

---

## Порядок и зависимости

Задачи строго последовательны: 2 опирается на 1 только по файлу патча, 3 — на 1 и 2 по именам, 4 — на 2, 5 — на все, 6 — на 5. Параллелить нечего: все правки идут в один клон и один патч, и два одновременных `git add -A` в нём дали бы патч из половины чужой работы.
