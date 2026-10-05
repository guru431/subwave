# Заказ по `songId` — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Слушатель заказывает трек, сверенный с коллекцией: плеер подсказывает, что есть, а чего нет, и отправляет идентификатор выбранного трека — так что в эфир уходит именно он, а не то, что угадал LLM-каскад.

**Architecture:** Две половины. Клиентская — ящик заказа спрашивает `/room/resolve` (комната из предыдущего плана уже умеет сверять) и шлёт `songId` вместе с текстом. Серверная — поле `songId` в общей схеме заказа и ветка в `routes/request.ts`, которая при заполненном поле берёт трек из Subsonic по идентификатору и ставит его в очередь, минуя сопоставление. Обе едут патчами: `l10n/ru-web.patch` и `controller/controller-ru.patch`, оба уже существуют.

**Tech Stack:** TypeScript (контроллер и плеер subwave v1.8.0), zod, React/Next.js, Docker, Subsonic API.

**Spec:** [`docs/superpowers/specs/2026-09-21-radio-upgrades-design.md`](../specs/2026-09-21-radio-upgrades-design.md) — §6.1 (`songId` в заказе), §5.1 (`/resolve`), §8 (правки плеера).

**Предыдущий план:** [`2026-09-22-room-and-chat.md`](2026-09-22-room-and-chat.md) — комната с `/resolve` и личность слушателя должны быть подняты до начала этого.

## Состояние на 2026-09-22 — исполнено

| Задача | Состояние | Коммит |
|---|---|---|
| 1. `songId` в схеме + зеркало | **готово**, линтер апстрима чист | `e99c8a8` |
| 2. Ветка точного заказа | **готово**, проверено на живой станции | `e99c8a8` |
| 3. Плеер: подсказка в ящике | **готово**, код в бандле; глазами — за владельцем | `932db0e` |
| 4. Документация | **готово** | `4b0fb8f` |

Проверка на эфире: заказ с `songId` поставил **ровно тот** трек
(`queuePosition: 2`, подводка с именем заказчика), свободный текст
(«что-нибудь бодрое из восьмидесятых» → Bon Jovi) по-прежнему разбирается
каскадом.

**Что выяснилось при исполнении:**

1. **Клон апстрима нельзя переносить архивом с Windows.** Приезжает с CRLF, и три
   shell-теста апстрима (`aio-log-link`, `instructions`, `state-bootstrap`) падают ни за
   что — выглядит как регрессия правки. Клонировать надо на Debian, а патчи переносить,
   сняв `\r`. Эталон «что падает и без нас» снимается прогоном на чистом клоне: там
   полтора десятка падений по таймингам, и судить надо по разнице.
2. **Зеркало схемы пришлось переносить, а не генерировать на месте.** `npm run gen:schemas`
   на Debian переписал файл целиком с LF, дав дифф на 3931 строку при 15 содержательных.
   Генератор отработал, а в патч ушли только его 15 строк — с сохранением переносов.
3. **Сборка плеера упала на `Turbopack is not supported`** после обновления базового
   образа node: битый слой `deps` в кэше docker. Из чистого контекста с `--no-cache`
   собирается; платформа тут ни при чём.
4. **Ящик заказа отдаёт `songId` через скин.** `onSubmit` у апстрима без аргументов, а
   текст и имя живут в `ClassicSkin`, поэтому третий аргумент прошёл по всей цепочке
   `RequestDrawer → ClassicSkin → PlayerCore → stationClient` — везде необязательным,
   чтобы остальные пять скинов продолжали работать без правок.

## Global Constraints

- **`controller/src/schemas/request.ts` может импортировать ТОЛЬКО `zod`.** Файл копируется в бандл плеера дословно, правило проверяется линтером апстрима (`controller/eslint.config.mjs` и `scripts/gen-schemas.ts`). Нарушение валит сборку.
- **Зеркало схемы генерируется, а не правится руками:** `web/lib/schemas.generated.ts` собирается `npm run gen:schemas` из контроллера. Правка руками разойдётся с источником при первой же регенерации.
- **Патч контроллера пересобирается `git diff HEAD -- controller/`**, патч плеера — **только** `git add -A && git diff --cached HEAD`: у `web` в патче есть новые файлы, а `git diff HEAD` их не видит и молча укорачивает патч.
- **Тег образа обязан совпадать с версией апстрима:** `subwave-controller:1.8.0-ru`, `subwave-web:1.8.0-ru`.
- **SSH на Debian:** `ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host>`.
- **Пересборка контроллера рвёт эфир на несколько секунд** — `broadcast` продолжает играть из `dj_queue`, но очередь и сессия перечитываются из `state/`. Делать не в час, когда слушают.
- **Кириллицу отправлять только телом из Python/файла**, не `curl -d "…"` из Git Bash.

## Структура файлов

| Файл | Ответственность |
|---|---|
| В клоне: `controller/src/schemas/request.ts` | поле `songId` в общей схеме заказа |
| В клоне: `web/lib/schemas.generated.ts` | зеркало схемы — **регенерируется**, не правится |
| В клоне: `controller/src/routes/request.ts` | ветка «пришёл `songId`» в `resolveRequest` |
| В клоне: `web/lib/stationClient.ts` | `submitRequest(text, name, songId?)` |
| В клоне: `web/components/player/PlayerCore.tsx` | проброс `songId` через действие плеера |
| В клоне: `web/components/skins/classic/drawers/RequestDrawer.tsx` | подсказка от `/room/resolve`, выбор альтернативы |
| `station/docs/controller-changes.md` (правка) | пересобранный патч контроллера |
| `station/docs/web-changes.md` (правка) | пересобранный патч плеера |
| `station/docs/controller-changes.md` (правка) | что теперь в патче, кроме приоритета заказа |

---

### Task 1: `songId` в общей схеме заказа

**Files:**
- Modify (в клоне): `controller/src/schemas/request.ts`
- Regenerate (в клоне): `web/lib/schemas.generated.ts`

**Interfaces:**
- Produces: `listenerRequestSchema` получает необязательное поле `songId: string | undefined` (до 64 символов, пусто → `undefined`).

Поле необязательное: заказ свободным текстом никуда не девается — он остаётся тем, чем был, и на нём по-прежнему работает весь каскад. `songId` лишь снимает догадку там, где слушатель уже выбрал трек из подсказки.

- [x] **Шаг 1: Подготовить клон с уже наложенными патчами**

```bash
M=/c/AI/projects/music
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/sw-req
cd /tmp/sw-req
git apply $M/station/docs/controller-changes.md
git apply $M/station/docs/web-changes.md
git status --short | wc -l
```

Expected: патчи накладываются без отказов, изменённых файлов — 31 и больше (30 у `web`, 1 у контроллера).

- [x] **Шаг 2: Добавить поле**

В `/tmp/sw-req/controller/src/schemas/request.ts`, внутрь `listenerRequestSchema`, после поля `name`:

```ts
  // Точный заказ: слушатель выбрал трек из подсказки плеера, и его
  // идентификатор в коллекции уже сверен (комната, GET /room/resolve). Поле
  // необязательное — заказ свободным текстом остаётся полноправным путём, а
  // этот снимает догадку там, где догадываться уже не о чем.
  //
  // Длина ограничена не потому, что у Navidrome id длиннее не бывает, а
  // потому, что поле уезжает в запрос к Subsonic: без потолка сюда влезает
  // что угодно.
  songId: z.preprocess(
    requestNullToUndefined,
    z
      .string({ error: 'Track id must be plain text.' })
      .trim()
      .max(64, 'Track id is too long.')
      .optional(),
  ),
```

- [x] **Шаг 3: Перегенерировать зеркало и проверить линтером**

```bash
cd /tmp/sw-req
docker run --rm -v /tmp/sw-req:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npm run gen:schemas && npm run lint" 2>&1 | tail -20
```

Expected: `gen:schemas` переписал `web/lib/schemas.generated.ts`, `lint` (eslint + `tsc --noEmit`) прошёл. Ошибка вида «module may import only zod» означает, что в схему заехал посторонний импорт — чинить в схеме, а не в линтере.

Если docker на work-ai недоступен, то же самое делается на Debian:

```bash
tar -czf /tmp/sw-req.tar.gz -C /tmp sw-req
scp -P <ssh-port> -i <ssh-key> /tmp/sw-req.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  cd /tmp && rm -rf sw-req && tar -xzf sw-req.tar.gz
  sudo docker run --rm -v /tmp/sw-req:/app -w /app/controller node:22-alpine \
    sh -c "npm ci --silent && npm run gen:schemas && npm run lint"
'
```
и результат забирается обратно `scp`.

- [x] **Шаг 4: Убедиться, что зеркало действительно изменилось**

```bash
cd /tmp/sw-req && git diff --stat web/lib/schemas.generated.ts
```

Expected: файл в списке изменённых, в диффе видно `songId`. Пустой дифф означает, что генератор не запускался — без зеркала плеер не соберётся с новым полем.

- [x] **Шаг 5: Коммит патча (промежуточный)**

```bash
M=/c/AI/projects/music
cd /tmp/sw-req && git diff HEAD -- controller/ > $M/station/docs/controller-changes.md
cd $M && git add station/docs/controller-changes.md
git commit -m "Схема заказа: необязательный songId для точного заказа"
```

---

### Task 2: Ветка точного заказа в `routes/request.ts`

**Files:**
- Modify (в клоне): `controller/src/routes/request.ts`

**Interfaces:**
- Consumes: `listenerRequestSchema.songId` (задача 1), `subsonic.getSong(id)` из `controller/src/music/subsonic.ts`.
- Produces: поле `entry.songId`; ветка `0a` в `resolveRequest`, отвечающая `resolved({ack, track, queuePosition})` или `failed(...)`.

Каскад сопоставления (поиск по Subsonic, разбор намерения LLM, выбор из кандидатов) при заполненном `songId` пропускается целиком. Подводка **остаётся**: заказ с именем слушателя — это то, ради чего станция и поднималась, и терять его ради экономии одного вызова незачем. Экономится сопоставление, а не голос.

- [x] **Шаг 1: Принять поле в маршруте**

В `/tmp/sw-req/controller/src/routes/request.ts`, в обработчике `router.post('/request', …)`, заменить разбор тела:

```ts
  const { text: rawText, name: rawName } = req.body as { text: string; name: string };
```

на

```ts
  const { text: rawText, name: rawName, songId } = req.body as
    { text: string; name: string; songId?: string };
```

и добавить поле в создаваемую запись — в объект `const entry: any = { … }`, следом за `injection: stripped.injection,`:

```ts
    // Точный заказ из подсказки плеера: трек уже сверен с коллекцией, угадывать
    // нечего. Пустая строка — это «не выбирали», а не «выбрали ничто».
    songId: songId || null,
```

- [x] **Шаг 2: Ветка в `resolveRequest`**

В том же файле, в `resolveRequest`, **перед** блоком `// 0. "more like this"`, вставить:

```ts
  // 0a. Точный заказ. Слушатель выбрал трек из подсказки, и его id сверен с
  // коллекцией ещё до отправки — сопоставлять нечего, поэтому весь каскад
  // (поиск, разбор намерения, выбор из кандидатов) пропускается. Подводка при
  // этом остаётся: заказ, объявленный по имени, — то, ради чего станция и
  // заводилась, и экономить надо на догадках, а не на голосе.
  if (entry.songId) {
    entry.path = 'song-id';
    entry.pickSource = 'song-id';
    const pick = await subsonic.getSong(entry.songId).catch(() => null);
    if (!pick) {
      // Id пришёл, а трека по нему нет: коллекция переиндексирована, или id
      // чужой. Отвечаем тем же отказом, что и на ненайденный запрос, — не
      // подсказывая, что именно не совпало.
      queue.log('request', `song-id ${entry.songId} не найден в коллекции`);
      return failed(sorryNoMatch(requester));
    }
    let introScript = await dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      artistMiss: null,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }).catch(() => null);
    const guarded = await guardIntro(introScript, text, () => dj.generateIntro({
      track: pick,
      context: ctx,
      requestedBy: requester,
      artistMiss: null,
      recap: queue.getDjRecap(),
      recentTracks: queue.getRecentTracks(),
      recentOpeners: queue.getRecentOpeners(),
    }));
    if (guarded.guard) {
      flagGuard(entry, guarded.guard);
      queue.log('request-guard', `intro echoed request text — ${guarded.guard}`);
    }
    introScript = guarded.script;
    const pos = await queue.push({
      track: pick,
      requestedBy: requester,
      intent: 'song',
      introScript,
      introKind: 'dj-speak',
      introPersona: session.onAirPersona(),
    });
    entry.pick = pick;
    if (pos === -2) {
      entry.pickSource = 'song-id:blocked';
      return failed(sorryNoMatch(requester));
    }
    if (pos === -1) {
      const dupAck = queue.dedupAck(pick.id);
      entry.pickSource = 'song-id:already-queued';
      entry.refused = true;
      session.appendTurn({ role: 'dj', kind: 'request', text: dupAck,
                           meta: { trackId: pick.id, requester } });
      return resolved({ ack: dupAck, track: { title: pick.title, artist: pick.artist },
                        queuePosition: null });
    }
    session.appendTurn({
      role: 'dj', kind: 'request',
      text: introScript || `Queued "${pick.title}".`,
      meta: { trackId: pick.id, requester },
    });
    entry.introScript = introScript || null;
    return resolved({
      ack: introScript || `Queued "${pick.title}" by ${pick.artist}.`,
      track: { title: pick.title, artist: pick.artist },
      queuePosition: pos,
    });
  }
```

**`queuePosition: pos`**, а не `queue.upcoming.length`, как в основном пути: `push()` после нашей правки приоритета возвращает позицию **этого** элемента, и с глубиной очереди хвост — уже чужой (см. `station/docs/controller-changes.md`).

- [x] **Шаг 3: Убедиться, что `subsonic` в файле уже импортирован**

```bash
grep -n "^import.*subsonic" /tmp/sw-req/controller/src/routes/request.ts
```

Expected: строка импорта есть (маршрут уже ходит в Subsonic за кандидатами). Если нет — добавить `import * as subsonic from '../music/subsonic.js';` по образцу соседних импортов файла (расширение `.js` обязательно: у контроллера ESM).

- [x] **Шаг 4: Проверить типы и линтер**

```bash
docker run --rm -v /tmp/sw-req:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npm run lint" 2>&1 | tail -20
```

Expected: чисто. `tsc` здесь — главный судья: `resolveRequest` не типизирован строго (`entry` — `any`), поэтому опечатка в имени поля вылезет только в рантайме, а неверная сигнатура `queue.push` — здесь.

- [x] **Шаг 5: Прогнать тесты апстрима**

```bash
docker run --rm -v /tmp/sw-req:/app -w /app/controller node:22-alpine \
  sh -c "npm ci --silent && npm test" 2>&1 | tail -25
```

Expected: набор проходит. Падение в `request-*` тестах означает, что правка задела общий путь — разбирать, а не объявлять тест устаревшим.

- [x] **Шаг 6: Собрать образ контроллера и поднять**

```bash
cd /tmp/sw-req && tar -czf /tmp/ctrl-ru.tar.gz controller docker package.json package-lock.json
scp -P <ssh-port> -i <ssh-key> /tmp/ctrl-ru.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf /tmp/ctrl-build && mkdir -p /tmp/ctrl-build
  tar -xzf /tmp/ctrl-ru.tar.gz -C /tmp/ctrl-build && cd /tmp/ctrl-build
  sudo docker build -f docker/Dockerfile.controller -t subwave-controller:1.8.0-ru . 2>&1 | tail -5
  cd <deploy-dir>/subwave && sudo docker compose up -d controller
  sleep 10 && sudo docker compose ps controller
'
```

Expected: образ собран, контейнер `Up`. Если `Dockerfile.controller` требует файлов вне упакованных — распаковать весь клон (`tar -czf /tmp/ctrl-ru.tar.gz .` из корня клона) и собрать из него.

- [x] **Шаг 7: Проверить точный заказ на живой станции**

```bash
set -a && . /c/AI/projects/_boss/secrets/vault.env && set +a
# взять настоящий id трека через комнату
curl -s -G http://<station-host>:7700/room/resolve \
  --data-urlencode 'q=Depeche Mode — Enjoy the Silence' | python -m json.tool | head -20
```

Затем отправить заказ с этим id (тело — из Python, чтобы кириллица не поехала):

```bash
python - <<'PY'
import json, urllib.parse, urllib.request
# id берётся тем же запросом, что и на прошлом шаге, — чтобы между «посмотрел»
# и «заказал» не вклинилась ручная подстановка и опечатка в ней
q = urllib.parse.quote("Depeche Mode — Enjoy the Silence")
found = json.load(urllib.request.urlopen(
    f"http://<station-host>:7700/room/resolve?q={q}", timeout=15))
pick = found["exact"] or (found["alternatives"] or [None])[0]
assert pick, "сверка ничего не нашла — точный заказ проверять не на чем"
print("заказываю:", pick["artist"], "—", pick["title"], pick["id"])

body = json.dumps({"text": f"{pick['artist']} — {pick['title']}", "name": "Тест",
                   "songId": pick["id"]}).encode()
req = urllib.request.Request("http://<station-host>:7700/api/request", data=body,
                             headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=30).read().decode())
PY
```

Expected: `202` с `requestId`. Через 5–20 с опросить `GET /api/request/<id>`: `status: resolved`, `track` — ровно тот трек, что заказан. В логе контроллера — `pickSource: song-id`:

```bash
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> \
  'cd <deploy-dir>/subwave && sudo docker compose logs --tail=80 controller | grep -i "request"'
```

- [x] **Шаг 8: Проверить, что свободный текст не сломался**

Тот же запрос без `songId`.
Expected: `status: resolved`, трек найден каскадом. Это регрессионная проверка: ветка не должна была задеть общий путь.

- [x] **Шаг 9: Пересобрать патч и закоммитить**

```bash
M=/c/AI/projects/music
cd /tmp/sw-req && git diff HEAD -- controller/ > $M/station/docs/controller-changes.md
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/check-ctrl
cd /tmp/check-ctrl && git apply --check $M/station/docs/controller-changes.md && echo PATCH_OK
cd $M && git add station/docs/controller-changes.md
git commit -m "Точный заказ: songId минует каскад сопоставления"
```

Expected: `PATCH_OK`.

---

### Task 3: Плеер — подсказка в ящике заказа

**Files:**
- Modify (в клоне): `web/lib/stationClient.ts`, `web/components/player/PlayerCore.tsx`, `web/components/skins/classic/drawers/RequestDrawer.tsx`
- Modify: `station/docs/web-changes.md`

**Interfaces:**
- Consumes: `GET /room/resolve?q=` (комната), `submitRequest` из `PlayerCore`.
- Produces: `submitRequest(text: string, name: string, songId?: string) => Promise<RequestResult>` — третий аргумент необязательный, существующие вызовы из пяти остальных скинов продолжают работать без правок.

- [x] **Шаг 1: Провести `songId` через клиент станции**

В `/tmp/sw-req/web/lib/stationClient.ts` — в интерфейсе:

```ts
  submitRequest(text: string, name: string, songId?: string): Promise<RequestResult>;
```

и в реализации:

```ts
    submitRequest: async (text, name, songId) => {
      const r = await fetch(`${api}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // songId уходит только когда он есть: `undefined` JSON.stringify
        // выбрасывает сам, и тело остаётся прежним для всех скинов, которые
        // о точном заказе не знают.
        body: JSON.stringify({ text, name, songId }),
      });
      return json<RequestResult>(r);
    },
```

- [x] **Шаг 2: Провести через действие плеера**

В `/tmp/sw-req/web/components/player/PlayerCore.tsx` — в типе `PlayerActions`:

```ts
  submitRequest: (text: string, name: string, songId?: string) => Promise<RequestResult>;
```

и в самом действии:

```ts
      submitRequest: (text, name, songId) => {
        const parsed = listenerRequestSchema.safeParse({ text, name, songId });
        if (!parsed.success) {
          return Promise.resolve({
            success: false,
            message: parsed.error.issues[0]?.message,
          });
        }
        return client.submitRequest(parsed.data.text, parsed.data.name, parsed.data.songId);
      },
```

Предполётная проверка схемой остаётся единственной точкой, через которую проходят ящики всех скинов, — и теперь она же проверяет `songId`.

- [x] **Шаг 3: Подсказка в ящике заказа**

В `/tmp/sw-req/web/components/skins/classic/drawers/RequestDrawer.tsx` добавить сверку по мере ввода. Вставить рядом с существующим состоянием формы:

```tsx
  // Сверка с коллекцией идёт в комнате: у контроллера весь поиск по библиотеке
  // закрыт requireAdmin, а слушателю нужен публичный ответ «есть или нет».
  const [resolved, setResolved] = useState<ResolveResult | null>(null);
  const [songId, setSongId] = useState<string | null>(null);

  useEffect(() => {
    const query = text.trim();
    setSongId(null);
    if (query.length < 3) {
      setResolved(null);
      return;
    }
    // Пауза после последнего нажатия: без неё каждая буква — запрос в
    // Navidrome, а печатают тут с телефона.
    const timer = setTimeout(async () => {
      try {
        const r = await fetch(`/room/resolve?q=${encodeURIComponent(query)}`);
        if (!r.ok) return;
        const body = (await r.json()) as ResolveResult;
        setResolved(body);
        if (body.exact) setSongId(body.exact.id);
      } catch {
        // Комната недоступна — заказ всё равно можно отправить текстом,
        // каскад станции его разберёт. Подсказка не обязательна для отправки.
        setResolved(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [text]);
```

Рядом с определениями типов файла:

```tsx
interface ResolveCandidate {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  year: number | null;
  duration: number | null;
}

interface ResolveResult {
  exact: ResolveCandidate | null;
  alternatives: ResolveCandidate[];
}
```

Под полем ввода, перед кнопкой отправки, — вывод подсказки:

```tsx
      {resolved?.exact && (
        <div className="text-xs text-muted">
          Нашёл: <span className="text-ink">{resolved.exact.artist} — {resolved.exact.title}</span>
        </div>
      )}
      {resolved && !resolved.exact && resolved.alternatives.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="text-xs text-muted">Точного совпадения нет. Может быть, это:</div>
          {resolved.alternatives.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setSongId(c.id);
                setText(`${c.artist} — ${c.title}`);
              }}
              className={cn(
                'rounded border px-2 py-1 text-left text-xs',
                songId === c.id ? 'border-vermilion text-ink' : 'border-separator-soft text-muted',
              )}
            >
              {c.artist} — {c.title}
            </button>
          ))}
        </div>
      )}
      {resolved && !resolved.exact && resolved.alternatives.length === 0 && (
        <div className="text-xs text-muted">
          В коллекции этого нет. Можно всё равно отправить — ведущий поищет сам.
        </div>
      )}
```

И в вызов отправки добавить третий аргумент — найти в файле `submitRequest(` и дописать `songId ?? undefined`:

```tsx
    const result = await submitRequest(text.trim(), name.trim(), songId ?? undefined);
```

`cn` в файле уже импортирован; если нет — `import { cn } from '@/lib/cn';`.

- [x] **Шаг 4: Собрать образ плеера**

```bash
cd /tmp/sw-req && tar -czf /tmp/web-ru.tar.gz web
scp -P <ssh-port> -i <ssh-key> /tmp/web-ru.tar.gz <ssh-user>@<station-host>:/tmp/
ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> '
  rm -rf /tmp/subwave-ru && mkdir -p /tmp/subwave-ru
  tar -xzf /tmp/web-ru.tar.gz -C /tmp/subwave-ru && cd /tmp/subwave-ru
  sudo docker build -f web/Dockerfile -t subwave-web:1.8.0-ru \
    --build-arg SUBWAVE_BUILD_VERSION=1.8.0-ru . 2>&1 | tail -5
  cd <deploy-dir>/subwave && sudo docker compose up -d web
'
```

Expected: сборка проходит, контейнер поднят.

- [x] **Шаг 5: Проверить глазами**

Открыть `https://<station-domain>`, ящик заказа (клавиша `3`):

1. Набрать «Depeche Mode — Enjoy the Silence» → под полем «Нашёл: …», отправка ставит **именно этот** трек (сверить с `GET /api/state`).
2. Набрать «Звезда» → список альтернатив, выбор подставляет название в поле и подсвечивает кнопку.
3. Набрать заведомо отсутствующее («Пупкин — Ничего») → «В коллекции этого нет», отправка по-прежнему возможна.

- [x] **Шаг 6: Пересобрать патч плеера и проверить на чистом клоне**

```bash
M=/c/AI/projects/music
cd /tmp/sw-req && git add -A && git diff --cached HEAD -- web/ > $M/station/docs/web-changes.md
git clone --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git /tmp/check-web2
cd /tmp/check-web2 && git apply --check $M/station/docs/web-changes.md && echo PATCH_OK
```

Expected: `PATCH_OK`. **`git add -A` обязателен** — иначе новые файлы (`ChatDrawer.tsx`, `listener.ts` из прошлого плана) молча выпадут из патча.

- [x] **Шаг 7: Коммит**

```bash
cd /c/AI/projects/music
git add station/docs/web-changes.md
git commit -m "Ящик заказа: сверка с коллекцией до отправки и выбор альтернативы"
```

---

### Task 4: Документация

**Files:**
- Modify: `station/docs/controller-changes.md`
- Modify: `station/docs/web-changes.md`
- Modify: `station/docs/deploy.md`

- [x] **Шаг 1: README контроллера**

Заголовок файла сейчас — «Свой образ контроллера: приоритет заказа в очереди». В патче теперь две правки, значит:

- переименовать раздел в «Свой образ контроллера: приоритет заказа и точный заказ»;
- добавить раздел про `songId`: что поле необязательное, что ветка пропускает сопоставление и **сохраняет** подводку, что `queuePosition` берётся из возврата `push()`, а не из длины очереди;
- отметить, что схема заказа копируется в бандл плеера и потому правится вместе с регенерацией `web/lib/schemas.generated.ts`.

- [x] **Шаг 2: README плеера**

В `station/docs/web-changes.md` — раздел про ящик заказа: откуда берётся подсказка (комната, а не контроллер — у того поиск под `requireAdmin`), почему пауза 400 мс, и что отправка без `songId` остаётся рабочей.

- [x] **Шаг 3: Станционный README**

В таблицу «Состояние» — строка «Заказ»: точный по `songId` из подсказки, свободным текстом — по-прежнему через каскад.

- [x] **Шаг 4: Коммит**

```bash
git add station/docs/controller-changes.md station/docs/web-changes.md station/docs/deploy.md
git commit -m "Точный заказ: документация патчей контроллера и плеера"
```

---

## Что этот план не делает

- **Не заводит поиск в контроллере.** Публичного `/search` не появляется: сверка живёт в комнате, у которой для этого есть читающая учётка Navidrome.
- **Не трогает глубину очереди** — это следующий план ([2026-09-22-queue-lookahead.md](2026-09-22-queue-lookahead.md)).
- **Не переводит админку.** Ящик заказа — плеерная страница; `/admin` остаётся английским, как и прежде.
