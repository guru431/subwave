# Блокировка эфира по жанрам и папкам — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** на вкладке станции Admin → Library → Blocked правило Genre понимает кириллицу и жанр папки у треков без тега, появляется правило Folder с выбором папки деревом и карточка «Folder genres»; `Сборки` сняты с эфира.

**Architecture:** правка апстрима subwave v1.8.0 двумя нашими патчами. Контроллер (`controller-ru.patch`): Unicode в сравнении жанров, колонка `tracks.path` из настоящего пути Navidrome, модуль `music/folder-genres.ts` (таблица «папка → жанры» в `state/folder-genres.json`), запасной жанр папки в `trackGenres`, поле правила `folder`, три маршрута. Веб (`ru-web.patch`): чистый модуль дерева, компонент дерева, поле Folder в редакторе правила, карточка жанров папок. Путь к файлу даёт флаг Report Real Path у плеера станции в Navidrome.

**Tech Stack:** TypeScript, Node 22 (тесты в одноразовом контейнере `node:22-bookworm-slim` на Debian), zod 4, better-sqlite3, Express; Next.js/React/Tailwind/lucide-react в веб-части; Navidrome 0.63.2 (native API + Subsonic); Docker Compose на Debian `<station-host>`.

**Spec:** [`docs/superpowers/specs/2026-09-23-station-genre-folder-blocking-design.md`](../specs/2026-09-23-station-genre-folder-blocking-design.md)

## Global Constraints

- **Апстрим — ровно `v1.8.0`**, образы `subwave-controller:1.8.0-ru` и `subwave-web:1.8.0-ru`: тег образа обязан совпадать с версией апстрима.
- **Тесты и линт — только в `node:22-bookworm-slim` на Debian.** На <workstation> Node 26, и нативные `better-sqlite3`/`sqlite-vec` под ним не проверены.
- **Судить о наборе тестов — по разнице с эталоном** (`sw.sh baseline`), а не по нулю: часть тестов апстрима краснеет и на чистом клоне.
- **`controller/src/schemas/*.ts` импортируют только `zod`.** Зеркало `web/lib/schemas.generated.ts` генерируется `npm run gen:schemas` и руками не правится; все модули схем лежат в нём в одной области видимости — новые имена верхнего уровня должны быть уникальны.
- **Пределы:** имя правила и значение для всех полей, кроме `folder`, — 64 символа (`RULE_TEXT_MAX`); путь в правиле Folder — до 512 (`RULE_PATH_MAX`); до 12 значений в правиле. Жанры папок: до 12 на папку, до 64 символов на жанр, до 200 папок в таблице.
- **Пути — абсолютные**, как их отдаёт Navidrome 0.63.2 с Report Real Path (`<music-mount>/…`); хранятся без завершающего `/` и **без обрезки пробелов**.
- **Подписи в админке — по-английски**, как вся админка (она не переводилась). Комментарии в коде контроллера — по-английски, как в апстриме и в `controller-ru.patch`.
- **`show-filter.ts` править только точечно (Edit):** `grep` считает его двоичным, файл целиком не переписывать.
- **Чужие незакоммиченные файлы в `<repo>` не трогать.** На 2026-09-23 это `CLAUDE.md`, `FINDINGS.md`, `station/loudness/README.md`, `station/docs/deploy.md`, `station/tts-f5/*`, `docs/superpowers/specs/2026-09-23-tts-f5-migration-design.md`, `tests/test_tts_f5_voices.py`, `station/onboard/patches/2026-09-23-voice-gain-5.json`. Перед коммитом — `git status --short`; коммит — только с явными путями (`git commit -F <файл> -- <пути>`), многострочное сообщение — файлом, в конце `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Если сессия идёт после `EnterWorktree`:** heredoc, `printf` с длинным текстом, `git -C` на чужой путь и `ssh` с `git` внутри обвязка отвергает. Всё удалённое — через скрипты-файлы ниже (`sw-remote.sh <команда>`).

## Review Focus

1. **Папка — префикс соседней** (`…/Сборки` и `…/Сборки 2`): правило Folder и жанр папки не должны перетекать в соседку — граница по `/`. Тесты — задача 4 (`pathInFolder`), задача 5 (`ruleMatches`).
2. **Navidrome перестал отдавать настоящий путь** (новая строка плеера — флаг выключен): следующая сверка не должна стереть сохранённые пути. Тест — задача 3.
3. **Трек с тегом в папке с назначенным жанром** (в том числе мусорный тег вроде `Äðóãîå`): тег побеждает, жанр папки не подмешивается. Тест — задача 5.
4. **Длинный реальный путь** (> 64 символов) в правиле Folder принимается, а имена по-прежнему ограничены 64. Тест — задача 5.
5. **Назначение для исчезнувшей папки** (переименовали на диске) видно в дереве и снимается. Тесты — задача 4 (`aggregateFolders`), задача 7 (`filterTree`).

## Рабочее место — одним абзацем

Код правится в **локальном зеркале** `<tmp>\sw-genre` (обычные файлы, без git), тестируется и собирается в **клоне на Debian** `/tmp/sw-genre` (v1.8.0 + оба текущих патча, закоммичены как `genre-base`; чистый апстрим помечен тегом `genre-v180`). `push.sh` переносит изменённые `.ts/.tsx` зеркала в клон, `sw-remote.sh <команда>` запускает там `sw.sh`. «Коммит» задач 1–9 — `sw-remote.sh checkpoint "…"` в клоне на Debian; в репозиторий `music` правки уезжают патчами в задаче 10.

---

### Task 1: Рабочее место и эталон тестов

**Files:**
- Create: `<tmp>\sw-genre-tools\sw.sh`, `summary.py`, `bootstrap.sh`, `push.sh`, `sw-remote.sh`
- Не в репозитории: инструменты плана.

**Interfaces:**
- Consumes: `station/docs/controller-changes.md`, `station/docs/web-changes.md` из репозитория.
- Produces: клон `/tmp/sw-genre` с тегами `genre-v180` и `genre-base`; зеркало `<tmp>\sw-genre\{controller/src,controller/scripts,web/components/admin,web/lib}`; эталон `/tmp/sw-genre-tools/base.log`; команды `sw-remote.sh setup|mirror|baseline|apply|test|suite|lint|gen-schemas|wtest|wlint|checkpoint|ourdiff|mkpatch|livediff|build-controller|build-web|build-web-nocache|health|persona|api|reconcile|folders|rules|backup-state|aired`.

- [ ] **Step 1: Создать `<tmp>\sw-genre-tools\sw.sh`**

```bash
#!/bin/bash
# Workbench for the genre/folder blocking plan on Debian. One script, many
# subcommands, so every call from Windows is a plain
# `ssh ... bash /tmp/sw-genre-tools/sw.sh <cmd>` (the worktree guard refuses
# heredocs and ssh-with-git one-liners).
set -uo pipefail
W=/tmp/sw-genre                      # v1.8.0 + both station patches + this plan
T=/tmp/sw-genre-tools
ENV=<deploy-dir>/subwave/.env
LIB=<deploy-dir>/subwave/state/library.db
STATE=<deploy-dir>/subwave/state
NODE=(sudo docker run --rm -v "$W:/app" node:22-bookworm-slim)
GITID=(-c user.name=genre-plan -c user.email=genre-plan@localhost)

die() { echo "ERROR: $*" >&2; exit 1; }

api() {  # api METHOD PATH [JSON_FILE]; admin creds from the station .env, never printed
  local u p
  u=$(grep -m1 '^ADMIN_USER=' "$ENV" | cut -d= -f2- | sed 's/^"//; s/"$//')
  p=$(grep -m1 '^ADMIN_PASS=' "$ENV" | cut -d= -f2- | sed 's/^"//; s/"$//')
  if [ -n "${3:-}" ]; then
    curl -sS -u "$u:$p" -X "$1" -H 'Content-Type: application/json' --data-binary @"$3" "http://127.0.0.1:7700/api$2"
  else
    curl -sS -u "$u:$p" -X "$1" "http://127.0.0.1:7700/api$2"
  fi
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  setup)
    sudo rm -rf "$W"
    git clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git "$W" || die clone
    cd "$W" || die cd
    git tag genre-v180
    tr -d '\r' < "$T/controller-ru.patch" > "$T/c.patch"
    tr -d '\r' < "$T/ru-web.patch" > "$T/w.patch"
    git apply "$T/c.patch" && git apply "$T/w.patch" || die "patch apply"
    git add -A && git "${GITID[@]}" commit -qm "station patches (repo state)" || die commit
    git tag genre-base
    "${NODE[@]}" sh -c "cd /app/controller && npm ci --silent" || die "npm ci"
    echo SETUP_OK ;;
  mirror)
    (cd "$W" && tar -czf /tmp/sw-genre-mirror.tgz controller/src controller/scripts web/components/admin web/lib) || die tar
    echo MIRROR_OK ;;
  baseline)
    "${NODE[@]}" sh -c "cd /app/controller && npm test" > "$T/base.full" 2>&1
    grep '^✖' "$T/base.full" | sed 's/ ([0-9.]*ms)//' | sort -u > "$T/base.log"
    echo "baseline failing: $(wc -l < "$T/base.log")"
    if "${NODE[@]}" sh -c "cd /app/controller && npm run lint" > "$T/base.lint" 2>&1; then echo LINT_BASE_OK; else echo "LINT_BASE_FAIL: $T/base.lint"; fi ;;
  apply)
    S=/tmp/sw-genre-stage
    rm -rf "$S" && mkdir -p "$S"
    tar -xzf /tmp/sw-genre-push.tgz -C "$S" || die untar
    find "$S" -type f \( -name '*.ts' -o -name '*.tsx' \) -exec sed -i 's/\r$//' {} +
    cp -r --no-preserve=all "$S"/. "$W"/ || die copy
    echo "applied $(find "$S" -type f | wc -l) files" ;;
  test)
    [ -n "${1:-}" ] || die "usage: test <name>.test.ts"
    "${NODE[@]}" sh -c "cd /app/controller && npx tsx scripts/$1" ;;
  suite)
    "${NODE[@]}" sh -c "cd /app/controller && npm test" > "$T/ours.full" 2>&1
    grep '^✖' "$T/ours.full" | sed 's/ ([0-9.]*ms)//' | sort -u > "$T/ours.log"
    echo "failing now: $(wc -l < "$T/ours.log"); new against baseline:"
    comm -13 "$T/base.log" "$T/ours.log"
    echo SUITE_DONE ;;
  lint)
    "${NODE[@]}" sh -c "cd /app/controller && npm run lint" && echo LINT_OK ;;
  gen-schemas)
    "${NODE[@]}" sh -c "cd /app/controller && npm run gen:schemas" && echo GEN_OK ;;
  wtest)
    [ -n "${1:-}" ] || die "usage: wtest <name>.test.ts"
    "${NODE[@]}" sh -c "cd /app && npx --yes tsx web/lib/$1" ;;
  wlint)
    "${NODE[@]}" sh -c "cd /app/web && npm ci --silent && npm run lint" && echo WLINT_OK ;;
  checkpoint)
    cd "$W" || die cd
    git add -A && git "${GITID[@]}" commit -qm "${*:-checkpoint}" && git log --oneline -1 ;;
  ourdiff)
    cd "$W" || die cd
    git add -A && git diff --cached --stat genre-base ;;
  mkpatch)
    cd "$W" || die cd
    git add -A
    git diff --cached --name-status genre-base
    git diff --cached genre-v180 -- controller/ > "$T/out-controller.patch"
    git diff --cached genre-v180 -- web/ > "$T/out-web.patch"
    echo "controller files: $(grep -c '^diff --git' "$T/out-controller.patch")"
    echo "web files: $(grep -c '^diff --git' "$T/out-web.patch")"
    C=/tmp/sw-genre-check
    sudo rm -rf "$C"
    git clone -q --depth 1 -b v1.8.0 https://github.com/perminder-klair/subwave.git "$C" || die clone
    (cd "$C" && git apply --check "$T/out-controller.patch" && git apply --check "$T/out-web.patch") || die "patch check"
    echo PATCH_CHECK_OK ;;
  livediff)
    cid=$(sudo docker create "$(sudo docker inspect -f '{{.Image}}' sub-wave-controller)") || die "docker create"
    sudo rm -rf /tmp/sw-genre-live
    sudo docker cp "$cid":/app/src /tmp/sw-genre-live >/dev/null
    sudo docker rm "$cid" >/dev/null
    diff -rq /tmp/sw-genre-live "$W/controller/src" | sed "s|/tmp/sw-genre-live|LIVE|; s|$W/controller/src|CLONE|g"
    echo LIVEDIFF_DONE ;;
  build-controller)
    sudo docker image inspect subwave-controller:1.8.0-ru-pre-genre >/dev/null 2>&1 \
      || sudo docker tag subwave-controller:1.8.0-ru subwave-controller:1.8.0-ru-pre-genre
    (cd "$W" && sudo docker build -q -f docker/Dockerfile.controller -t subwave-controller:1.8.0-ru .) || die build
    (cd <deploy-dir>/subwave && sudo docker compose up -d controller) || die up
    echo CONTROLLER_UP ;;
  build-web|build-web-nocache)
    sudo docker image inspect subwave-web:1.8.0-ru-pre-genre >/dev/null 2>&1 \
      || sudo docker tag subwave-web:1.8.0-ru subwave-web:1.8.0-ru-pre-genre
    X=/tmp/sw-genre-webctx
    sudo rm -rf "$X" && mkdir -p "$X"
    tar -C "$W" --exclude=web/node_modules --exclude=web/.next -cf - web | tar -C "$X" -xf -
    NC=(); [ "$cmd" = build-web-nocache ] && NC=(--no-cache)
    (cd "$X" && sudo docker build -q "${NC[@]}" -f web/Dockerfile -t subwave-web:1.8.0-ru --build-arg SUBWAVE_BUILD_VERSION=1.8.0-ru .) || die build
    (cd <deploy-dir>/subwave && sudo docker compose up -d web) || die up
    echo WEB_UP ;;
  health)
    sudo docker ps --filter name=sub-wave --format '{{.Names}}  {{.Status}}'
    echo "--- errors in the last 5 minutes:"
    sudo docker logs --since 5m sub-wave-controller 2>&1 | grep -iE 'error|exception|unhandled' | tail -20
    echo HEALTH_DONE ;;
  persona)
    api GET /settings | python3 "$T/summary.py" persona ;;
  api)
    api "$@"; echo ;;
  reconcile)
    api POST /library/reconcile > /dev/null
    for _ in $(seq 1 120); do
      sleep 5
      if api GET /library/tagger | grep -q '"running":false'; then echo RECONCILE_DONE; exit 0; fi
    done
    die "reconcile still running after 10 minutes" ;;
  folders)
    api GET /library/folders | python3 "$T/summary.py" folders ;;
  rules)
    api GET /library/blocklist | python3 "$T/summary.py" rules ;;
  backup-state)
    for f in blocklist.json folder-genres.json; do
      if sudo test -f "$STATE/$f"; then sudo cp -n "$STATE/$f" "$STATE/$f.pre-genre" && echo "backed up $f"; else echo "no $f yet"; fi
    done ;;
  aired)
    [ -n "${1:-}" ] || die "usage: aired <ISO-UTC since>"
    sudo sqlite3 -readonly "$LIB" \
      "SELECT COUNT(*) AS plays,
              COALESCE(SUM(t.path LIKE '<music-mount>/Сборки/%'), 0) AS from_sborki,
              COALESCE(SUM(t.path IS NULL), 0) AS no_path
         FROM plays p LEFT JOIN tracks t ON t.id = p.track_id
        WHERE p.played_at >= '$1';" ;;
  *) die "unknown command: $cmd" ;;
esac
```

- [ ] **Step 2: Создать `<tmp>\sw-genre-tools\summary.py`**

```python
"""Короткие сводки ответов API станции для приёмки (sw.sh folders|rules|persona)."""
import json
import sys

WATCH = ("/Сборки", "/!Помойка русская", "/!Помойка Русский Рок", "/!Помойка зарубежная",
         "/Classic", "/СЛОТ - ОркестрА", "/Юля Кошкина")

data = json.load(sys.stdin)
mode = sys.argv[1]
if mode == "folders":
    print("withoutPath:", data["withoutPath"], " folders:", len(data["folders"]))
    for f in data["folders"]:
        if f["path"].endswith(WATCH):
            print(f"  {f['path']}: total={f['total']} untagged={f['untagged']} genres={f['genres']}")
elif mode == "rules":
    for r in data.get("rules", []):
        print(f"  {r['id']}  {r['label']!r} {r['field']}={r['values']} "
              f"matchCount={r['matchCount']} active={r['active']}")
elif mode == "persona":
    v = data["values"]
    p = [x for x in v["personas"] if x["id"] == "p_ru"][0]
    print(p["name"], p["tts"]["voice"], v["tts"]["gainDb"]["remote"])
```

- [ ] **Step 3: Создать `<tmp>\sw-genre-tools\bootstrap.sh`, `push.sh`, `sw-remote.sh`**

`bootstrap.sh`:

```bash
#!/bin/bash
# First run: tools and the repo's current station patches go to Debian, which
# builds a fresh v1.8.0 clone with them applied; the files to edit come back
# here as a plain mirror.
set -euo pipefail
KEY=<ssh-key>
H=<ssh-user>@<station-host>
TOOLS=<tmp>/sw-genre-tools
REPO=<repo>/deploy/subwave
ssh -p <ssh-port> -i $KEY $H 'mkdir -p /tmp/sw-genre-tools'
scp -q -P <ssh-port> -i $KEY $TOOLS/sw.sh $TOOLS/summary.py \
  $REPO/controller/controller-ru.patch $REPO/l10n/ru-web.patch $H:/tmp/sw-genre-tools/
ssh -p <ssh-port> -i $KEY $H "sed -i 's/\r\$//' /tmp/sw-genre-tools/sw.sh /tmp/sw-genre-tools/summary.py && bash /tmp/sw-genre-tools/sw.sh setup && bash /tmp/sw-genre-tools/sw.sh mirror"
rm -rf <tmp>/sw-genre && mkdir -p <tmp>/sw-genre
scp -q -P <ssh-port> -i $KEY $H:/tmp/sw-genre-mirror.tgz <tmp>/sw-genre-mirror.tgz
tar -xzf <tmp>/sw-genre-mirror.tgz -C <tmp>/sw-genre
echo "BOOTSTRAP_OK: $(find <tmp>/sw-genre -type f | wc -l) files mirrored"
```

`push.sh`:

```bash
#!/bin/bash
# Mirror -> Debian clone. Only .ts/.tsx travel, so modes and every other file
# of the clone stay as they are; the schema mirror never travels — Debian
# regenerates it (sw.sh gen-schemas). Tools are refreshed on the way.
set -euo pipefail
KEY=<ssh-key>
H=<ssh-user>@<station-host>
cd <tmp>/sw-genre
find controller web -type f \( -name '*.ts' -o -name '*.tsx' \) ! -path 'web/lib/schemas.generated.ts' \
  > <tmp>/sw-genre-push.list
tar -czf <tmp>/sw-genre-push.tgz -T <tmp>/sw-genre-push.list
scp -q -P <ssh-port> -i $KEY <tmp>/sw-genre-push.tgz $H:/tmp/sw-genre-push.tgz
scp -q -P <ssh-port> -i $KEY <tmp>/sw-genre-tools/sw.sh <tmp>/sw-genre-tools/summary.py $H:/tmp/sw-genre-tools/
ssh -p <ssh-port> -i $KEY $H "sed -i 's/\r\$//' /tmp/sw-genre-tools/sw.sh /tmp/sw-genre-tools/summary.py && bash /tmp/sw-genre-tools/sw.sh apply"
```

`sw-remote.sh`:

```bash
#!/bin/bash
# sw-remote.sh <cmd> [args] — sw.sh on Debian in one line.
exec ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> bash /tmp/sw-genre-tools/sw.sh "$@"
```

Если любой из этих скриптов падает с `$'\r': command not found` — снять CR: `sed -i 's/\r$//' <tmp>/sw-genre-tools/*.sh`.

- [ ] **Step 4: Поднять клон и зеркало**

Run: `bash <tmp>/sw-genre-tools/bootstrap.sh`
Expected: `SETUP_OK`, `MIRROR_OK`, `BOOTSTRAP_OK: <N> files mirrored` (N — сотни).

- [ ] **Step 5: Снять эталон тестов и линта** (несколько минут — можно в фоне)

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh baseline`
Expected: `baseline failing: <K>` и `LINT_BASE_OK`. Если `LINT_BASE_FAIL` — не исправлять: сохранить `/tmp/sw-genre-tools/base.lint` как эталон и дальше сравнивать ошибки линта с ним.

- [ ] **Step 6: Проверить конвейер пустым проходом**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test blocklist-rules.test.ts`
Expected: `applied <N> files`, затем `blocklist-rules.test.ts: all assertions passed`. И `bash <tmp>/sw-genre-tools/sw-remote.sh ourdiff` — пустой вывод (зеркало совпадает с клоном).

---

### Task 2: Жанр с кириллицей

**Files:**
- Test: `<tmp>\sw-genre\controller\scripts\genre-cyrillic.test.ts` (Create)
- Modify: `<tmp>\sw-genre\controller\src\music\show-filter.ts` (≈ строки 41–45 и 70)
- Modify: `<tmp>\sw-genre\controller\src\music\subsonic.ts` (строка 8 и ≈ 366–369)

**Interfaces:**
- Consumes: ничего.
- Produces: `normGenre(s: unknown): string` — буквы и цифры любого письма; `subsonic.resolveGenreName` нормализует тем же `normGenre`.

- [ ] **Step 1: Написать падающий тест** — создать `controller/scripts/genre-cyrillic.test.ts`:

```ts
// Cyrillic genres (music/show-filter.ts): normGenre and the word-boundary walk
// kept only a-z0-9, so "Рок" normalised to "" — a Genre rule or a genre show
// with a Cyrillic name matched nothing, silently. Latin behaviour must not move.
// Pure: tracks carry their genres inline. Run: `tsx scripts/genre-cyrillic.test.ts`.

import assert from 'node:assert/strict';
import { genreMatches, normGenre } from '../src/music/show-filter.js';

assert.equal(normGenre('Рок'), 'рок', 'Cyrillic letters survive');
assert.equal(normGenre('Шансон'), 'шансон');
assert.equal(normGenre('Rock (Hard)'), 'rockhard', 'Latin unchanged');
assert.equal(normGenre('Hip-Hop'), 'hiphop', 'Latin unchanged');
assert.equal(normGenre('Música'), 'música', 'accented Latin keeps its letter');

const t = (genres: string[]) => ({ genres });
assert.equal(genreMatches(t(['Рок']), [normGenre('Рок')]), true, 'exact Cyrillic genre');
assert.equal(genreMatches(t(['Поп-рок']), [normGenre('Поп')]), true, 'refines on a word boundary');
assert.equal(genreMatches(t(['Попса']), [normGenre('Поп')]), false, 'no match inside a word');
assert.equal(genreMatches(t(['Рок']), [normGenre('Rock')]), false, 'Рок and Rock stay different genres');
assert.equal(genreMatches(t(['Rock (Hard)']), [normGenre('Rock')]), true, 'Latin refine unchanged');

console.log('genre-cyrillic.test.ts: all assertions passed');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test genre-cyrillic.test.ts`
Expected: FAIL — `AssertionError … Cyrillic letters survive` (`'' !== 'рок'`).

- [ ] **Step 3: `show-filter.ts` — нормализация** (Edit; сначала Read файла)

Заменить:

```ts
// Normalised genre token for fuzzy comparison — mirrors subsonic.resolveGenreName
// so the show's resolved tag and a track's tag compare the same way.
export function normGenre(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
```

на:

```ts
// Normalised genre token for fuzzy comparison — shared with
// subsonic.resolveGenreName so the show's resolved tag and a track's tag compare
// the same way. Letters and digits of ANY script survive: an a-z0-9 filter
// turned a Cyrillic "Рок" into "", and an empty target silently matched nothing.
export function normGenre(s: unknown): string {
  return String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// One letter or digit of any script — the unit genreBoundaries walks.
const GENRE_ALNUM = /[\p{L}\p{N}]/u;
```

И в `genreBoundaries` заменить строку

```ts
    const alnum = (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9');
```

на

```ts
    const alnum = GENRE_ALNUM.test(ch);
```

- [ ] **Step 4: `subsonic.ts` — тот же нормализатор**

После строки `import * as blocklist from './blocklist.js';` добавить:

```ts
import { normGenre } from './show-filter.js';
```

(Цикла импортов это не добавляет: `subsonic` уже тянет `show-filter` через `blocklist` → `blocklist-rules`.)

В `resolveGenreName` заменить:

```ts
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
```

на:

```ts
  // show-filter's normaliser, not a local copy: the two were kept in step by
  // hand, and both dropped every non a-z letter.
  const norm = normGenre;
```

- [ ] **Step 5: Тест проходит, латинские тесты апстрима не сдвинулись**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test genre-cyrillic.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test show-filter.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test blocklist-rules.test.ts`
Expected: `genre-cyrillic.test.ts: all assertions passed`, `show-filter.test.ts` без ✗, `blocklist-rules.test.ts: all assertions passed`.

- [ ] **Step 6: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "Genre matching: letters of any script"`

---

### Task 3: Путь к файлу в `library.db`

**Files:**
- Test: `controller/scripts/library-path.test.ts` (Create)
- Modify: `controller/src/music/library-db/schema.ts` (после блока `userVersion < 20`, ≈ 404)
- Modify: `controller/src/music/library-db/types.ts` (≈ 28–31, 130–133, 168–169)
- Modify: `controller/src/music/library-db/rows.ts` (≈ 24)
- Modify: `controller/src/music/library-db/tracks.ts` (≈ 90–122)
- Modify: `controller/src/music/library-db/queries.ts` (≈ 16–41)
- Modify: `controller/src/music/library.ts` (`get()` ≈ 105–107, `set()` ≈ 187, `slimTrack` ≈ 321–323)
- Modify: `controller/src/music/tag-library/flags.ts` (≈ 120–122), `controller/src/music/analyze-library.ts` (≈ 135–137)
- Modify: `controller/src/routes/library.ts` (`LibrarySong` ≈ 45–47, retag ≈ 744–750, manual-tag ≈ 913–920)

(Все пути — внутри `<tmp>\sw-genre\`.)

**Interfaces:**
- Consumes: ничего.
- Produces:
  - колонка `tracks.path TEXT` (миграция 21);
  - `TrackRecord.path?: string | null`, `TrackRow.path?: string | null`, `TrackMeta.path?: string | null`;
  - `upsertTrackMeta` пишет `path`, только если он абсолютный; `NULL`/относительный сохранённое не затирают;
  - `db.ruleMatchRows()` → строки с `path: string | null`;
  - `db.folderRows(): Array<{ path: string | null; tagged: boolean }>`;
  - `library.get(id).path`, строки `slimTrack` с `path`.

- [ ] **Step 1: Написать падающий тест** — `controller/scripts/library-path.test.ts`:

```ts
// The track path column (library-db migration 21): upsertTrackMeta stores only
// an ABSOLUTE path, and a walk without one — Navidrome's fake "Artist/Album/…"
// path when Report Real Path is off, or no path at all — never erases a stored
// one. The path rides getTrack and the rule-match / folder-tree projections.
// Runs a REAL better-sqlite3 DB against a temp STATE_DIR (set before the
// dynamic import), like scripts/airing.test.ts.
// Run: `tsx scripts/library-path.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-path-'));
const db = await import('../src/music/library-db.js');
await db.open({ embeddingDim: 768, adoptStoredDim: true });

const REAL = '/mnt/music/Unsorted/!Помойка русская/Song.mp3';

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A', path: REAL });
assert.equal(db.getTrack('t1')?.path, REAL, 'an absolute path is stored');

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A', path: 'A/Album/Song.mp3' });
assert.equal(db.getTrack('t1')?.path, REAL, 'a fake relative path never overwrites a real one');

db.upsertTrackMeta('t1', { title: 'Song', artist: 'A' });
assert.equal(db.getTrack('t1')?.path, REAL, 'a walk without a path keeps the stored one');

db.upsertTrackMeta('t2', { title: 'Other', artist: 'B', path: 'B/Album/Other.mp3', genres: ['Рок'] });
assert.equal(db.getTrack('t2')?.path ?? null, null, 'a fake path is not stored at all');

assert.equal(db.ruleMatchRows().find((r) => r.id === 't1')?.path, REAL, 'rule-match rows carry the path');

const rows = db.folderRows().map((r) => `${r.path}|${r.tagged}`).sort();
assert.deepEqual(rows, [`${REAL}|false`, 'null|true'], 'folder rows: path + whether a genre tag exists');

console.log('library-path.test.ts: all assertions passed');
process.exit(0);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test library-path.test.ts`
Expected: FAIL — `an absolute path is stored` (`undefined !== '/mnt/music/…'`).

- [ ] **Step 3: Миграция 21** — в `schema.ts` заменить

```ts
    d.pragma('user_version = 20');
  }
```

на

```ts
    d.pragma('user_version = 20');
  }

  if (userVersion < 21) {
    // Absolute file path, as Navidrome reports it to a player with Report Real
    // Path on — the input of the Blocked tab's Folder rules and folder genres
    // (music/folder-genres.ts). NULL = never reported: the flag was off, or the
    // row predates it. Walks only ever fill it, never blank it (upsertTrackMeta).
    runDdl(d, `ALTER TABLE tracks ADD COLUMN path TEXT;`);
    d.pragma('user_version = 21');
  }
```

- [ ] **Step 4: Типы** — в `types.ts`:

В `TrackRecord` заменить

```ts
  genre: string | null;
  durationSec: number | null;
  lastfmTags: string[] | null;
```

на

```ts
  genre: string | null;
  durationSec: number | null;
  // Absolute file path (Report Real Path on the station's Navidrome player);
  // null when never reported. Optional so record literals built elsewhere stay
  // valid without it.
  path?: string | null;
  lastfmTags: string[] | null;
```

В `TrackRow` заменить

```ts
  duration_sec: number | null;
  lastfm_tags: string | null;
```

на

```ts
  duration_sec: number | null;
  path?: string | null;
  lastfm_tags: string | null;
```

В `TrackMeta` заменить

```ts
  genres?: string[] | null;
  duration?: number | null;
```

на

```ts
  genres?: string[] | null;
  duration?: number | null;
  // A Subsonic child's `path` — stored only when absolute (see upsertTrackMeta).
  path?: string | null;
```

- [ ] **Step 5: `rows.ts`** — заменить `    durationSec: row.duration_sec,` на

```ts
    durationSec: row.duration_sec,
    path: row.path ?? null,
```

- [ ] **Step 6: `tracks.ts` — запись пути** (три замены в `upsertTrackMeta`)

```ts
      INSERT INTO tracks (id, title, artist, album, year, original_year, original_year_source, is_compilation, genres, duration_sec)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

→

```ts
      INSERT INTO tracks (id, title, artist, album, year, original_year, original_year_source, is_compilation, genres, duration_sec, path)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
```

```ts
        duration_sec = COALESCE(excluded.duration_sec, tracks.duration_sec)
    `,
```

→

```ts
        duration_sec = COALESCE(excluded.duration_sec, tracks.duration_sec),
        -- Only an absolute path is ever passed (below): a walk with Report Real
        -- Path off keeps the path an earlier walk recorded.
        path         = COALESCE(excluded.path, tracks.path)
    `,
```

```ts
      Number.isFinite(meta.duration as number) ? (meta.duration as number) : null,
    );
```

→

```ts
      Number.isFinite(meta.duration as number) ? (meta.duration as number) : null,
      typeof meta.path === 'string' && meta.path.length > 1 && meta.path.startsWith('/') ? meta.path : null,
    );
```

- [ ] **Step 7: `queries.ts`** — в `ruleMatchRows` добавить путь и завести `folderRows`. Заменить

```ts
  lastfmTags: string[] | null;
}> {
  const rows = requireDb()
    .prepare(`SELECT id, title, artist, album, genres, genre, moods, audio_moods, lastfm_tags FROM tracks`)
```

на

```ts
  lastfmTags: string[] | null;
  path: string | null;
}> {
  const rows = requireDb()
    .prepare(`SELECT id, title, artist, album, genres, genre, moods, audio_moods, lastfm_tags, path FROM tracks`)
```

затем заменить

```ts
    lastfmTags: r.lastfm_tags ? safeParseArray(r.lastfm_tags) : null,
  }));
}
```

на

```ts
    lastfmTags: r.lastfm_tags ? safeParseArray(r.lastfm_tags) : null,
    path: r.path ?? null,
  }));
}

// Every row's real path and whether it carries a genre tag — the input of the
// Blocked tab's folder tree (music/folder-genres.aggregateFolders).
export function folderRows(): Array<{ path: string | null; tagged: boolean }> {
  const rows = requireDb()
    .prepare(`SELECT path, genres FROM tracks`)
    .all() as Array<{ path: string | null; genres: string | null }>;
  return rows.map((r) => ({
    path: r.path ?? null,
    tagged: !!r.genres && safeParseArray(r.genres).length > 0,
  }));
}
```

(Если в файле строка `lastfmTags: r.lastfm_tags …` встречается больше одного раза — брать ту, что внутри `ruleMatchRows`, расширив контекст замены.)

- [ ] **Step 8: `library.ts` — проекции и `set()`**

В `get()` заменить

```ts
    genres: t.genres,
    genre: t.genre,
    moods: t.moods,
```

на

```ts
    genres: t.genres,
    genre: t.genre,
    // Absolute file path — folder genres and Folder rules resolve through this
    // projection for rows that carry no path of their own (queue items).
    path: t.path ?? null,
    moods: t.moods,
```

В `slimTrack` заменить

```ts
    genres: r.genres,
    genre: r.genre,
    moods: r.moods,
```

на

```ts
    genres: r.genres,
    genre: r.genre,
    path: r.path ?? null,
    moods: r.moods,
```

В `set()` заменить

```ts
    duration: data.duration ?? null,
  });
```

на

```ts
    duration: data.duration ?? null,
    path: data.path ?? null,
  });
```

- [ ] **Step 9: Путь из обходов Navidrome и из маршрутов**

`tag-library/flags.ts` (`walkNavidrome`) — заменить

```ts
      genres: subsonic.songGenres(song),
      duration: song.duration,
    });
```

на

```ts
      genres: subsonic.songGenres(song),
      duration: song.duration,
      path: song.path,
    });
```

`analyze-library.ts` — заменить

```ts
        genres: subsonic.songGenres(song),
        duration: song.duration,
      });
```

на

```ts
        genres: subsonic.songGenres(song),
        duration: song.duration,
        path: song.path,
      });
```

`routes/library.ts` — в `interface LibrarySong` заменить

```ts
  genre?: string | null;
  duration?: number | null;
}
```

на

```ts
  genre?: string | null;
  duration?: number | null;
  path?: string | null;
}
```

в `/library/retag` заменить

```ts
      year: song.year ?? null,
      genres: subsonic.songGenres(song),
    });
```

на

```ts
      year: song.year ?? null,
      genres: subsonic.songGenres(song),
      path: song.path ?? null,
    });
```

в `/library/manual-tag` заменить

```ts
          genres: subsonic.songGenres(t),
          duration: t.duration ?? null,
        });
```

на

```ts
          genres: subsonic.songGenres(t),
          duration: t.duration ?? null,
          path: t.path ?? null,
        });
```

- [ ] **Step 10: Тест проходит, соседние тесты БД целы**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test library-path.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test airing.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test embedding-dim-migrate.test.ts`
Expected: `library-path.test.ts: all assertions passed`; `airing.test.ts` и `embedding-dim-migrate.test.ts` без ✗.

- [ ] **Step 11: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "library-db: absolute track path (migration 21)"`

---

### Task 4: Модуль `folder-genres`

**Files:**
- Create: `controller/src/music/folder-genres.ts`
- Test: `controller/scripts/folder-genres.test.ts` (Create)

**Interfaces:**
- Consumes: `config.stateDir` (`../config.js`), `writeFileAtomic(path, contents)` (`../util/atomic-file.js`).
- Produces (всё экспортируется из `music/folder-genres.ts`):
  - константы `FOLDER_GENRES_MAX = 200`, `FOLDER_GENRE_VALUES_MAX = 12`, `FOLDER_GENRE_TEXT_MAX = 64`;
  - типы `FolderGenresEntry { folder: string; genres: string[] }`, `FolderStat { path: string; total: number; untagged: number; genres: string[] }`;
  - `absolutePath(p: unknown): string | null`, `normFolder(raw: unknown): string | null`, `parentDir(p: string): string | null`, `pathInFolder(folder: string, path: string | null | undefined): boolean`;
  - `lookupFolderGenres(map: ReadonlyMap<string, string[]>, path: string | null | undefined): string[]`;
  - `validateFolderGenres(raw: unknown): Map<string, string[]>` (бросает `Error`);
  - `aggregateFolders(rows: Array<{ path: string | null; tagged: boolean }>, assigned: ReadonlyMap<string, string[]>): { folders: FolderStat[]; withoutPath: number }`;
  - состояние: `list(): FolderGenresEntry[]`, `assigned(): ReadonlyMap<string, string[]>`, `setAll(next: ReadonlyMap<string, string[]>): void`, `genresForPath(path: string | null | undefined): string[]`, `load(): Promise<void>`, `save(raw: unknown): Promise<FolderGenresEntry[]>`.

- [ ] **Step 1: Написать падающий тест** — `controller/scripts/folder-genres.test.ts`:

```ts
// Folder genres (music/folder-genres.ts): path helpers, the nearest-assigned-
// ancestor lookup, table validation, the folder-tree aggregation and the
// load/save contract (never throws on load; a refused save changes nothing).
// Run: `tsx scripts/folder-genres.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stateDir = mkdtempSync(join(tmpdir(), 'subwave-folder-genres-'));
process.env.STATE_DIR = stateDir;
const fg = await import('../src/music/folder-genres.js');

// ── path helpers ────────────────────────────────────────────────────────────
assert.equal(fg.absolutePath('/a/b.mp3'), '/a/b.mp3');
assert.equal(fg.absolutePath('A/B/b.mp3'), null, 'a fake relative path is no path');
assert.equal(fg.absolutePath('/'), null);
assert.equal(fg.absolutePath(null), null);
assert.equal(fg.normFolder('/a/b/'), '/a/b', 'trailing slash dropped');
assert.equal(fg.normFolder('/a/b //'), '/a/b ', 'not trimmed: a folder name may end in a space');
assert.equal(fg.normFolder('a/b'), null);
assert.equal(fg.normFolder('/'), null);
assert.equal(fg.normFolder(42), null);
assert.equal(fg.parentDir('/a/b/c.mp3'), '/a/b');
assert.equal(fg.parentDir('/a'), null, 'no folder row above the top');
assert.equal(fg.pathInFolder('/m/Сборки', '/m/Сборки/x.mp3'), true);
assert.equal(fg.pathInFolder('/m/Сборки', '/m/Сборки 2/x.mp3'), false, '"/" boundary');
assert.equal(fg.pathInFolder('/m/Сборки', null), false);

// ── lookup ──────────────────────────────────────────────────────────────────
const table = new Map([['/m/U', ['Разное']], ['/m/U/Поп', ['Поп']]]);
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/Поп/a.mp3'), ['Поп'], 'own folder first');
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/Поп/deep/a.mp3'), ['Поп'], 'nearest assigned ancestor');
assert.deepEqual(fg.lookupFolderGenres(table, '/m/U/b.mp3'), ['Разное']);
assert.deepEqual(fg.lookupFolderGenres(table, '/m/S/c.mp3'), []);
assert.deepEqual(fg.lookupFolderGenres(table, 'U/Поп/a.mp3'), [], 'relative path → nothing');
assert.deepEqual(fg.lookupFolderGenres(new Map(), '/m/U/a.mp3'), []);

// ── validation ──────────────────────────────────────────────────────────────
const v = fg.validateFolderGenres({ entries: [
  { folder: '/m/U/', genres: [' Pop ', 'pop', '', 'Rock'] },
  { folder: '/m/Empty', genres: [] },
] });
assert.deepEqual([...v], [['/m/U', ['Pop', 'Rock']]], 'trimmed, deduped case-insensitively, empties dropped');
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: 'm/U', genres: ['x'] }] }), /absolute/);
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: ['x'.repeat(65)] }] }), /64/);
assert.throws(
  () => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: Array.from({ length: 13 }, (_, i) => `g${i}`) }] }),
  /12/,
);
assert.throws(() => fg.validateFolderGenres({ entries: 'nope' }), /entries/);
assert.throws(() => fg.validateFolderGenres({ entries: [{ folder: '/m/U', genres: [42] }] }), /strings/);

// ── folder tree aggregation ─────────────────────────────────────────────────
const agg = fg.aggregateFolders([
  { path: '/m/U/Поп/a.mp3', tagged: false },
  { path: '/m/U/Поп/b.mp3', tagged: true },
  { path: '/m/S/c.mp3', tagged: true },
  { path: 'Fake/Album/d.mp3', tagged: false },
  { path: null, tagged: true },
], new Map([['/m/U/Поп', ['Поп']], ['/m/Gone', ['Рок']]]));
const by = new Map(agg.folders.map((f) => [f.path, f]));
assert.equal(agg.withoutPath, 2, 'rows without an absolute path are counted, not placed');
assert.deepEqual(by.get('/m'), { path: '/m', total: 3, untagged: 1, genres: [] }, 'ancestors carry cumulative counts');
assert.deepEqual(by.get('/m/U/Поп'), { path: '/m/U/Поп', total: 2, untagged: 1, genres: ['Поп'] });
assert.deepEqual(by.get('/m/Gone'), { path: '/m/Gone', total: 0, untagged: 0, genres: ['Рок'] }, 'a stale assignment still shows');
assert.equal(by.has('/'), false, 'the filesystem root is not a folder row');

// ── state + persistence ─────────────────────────────────────────────────────
await fg.load();
assert.deepEqual(fg.list(), [], 'no file → empty, no throw');
const saved = await fg.save({ entries: [{ folder: '/m/U/Поп', genres: ['Поп'] }] });
assert.deepEqual(saved, [{ folder: '/m/U/Поп', genres: ['Поп'] }]);
assert.deepEqual(fg.genresForPath('/m/U/Поп/a.mp3'), ['Поп']);
assert.deepEqual(
  JSON.parse(readFileSync(join(stateDir, 'folder-genres.json'), 'utf8')),
  { entries: [{ folder: '/m/U/Поп', genres: ['Поп'] }] },
);
await assert.rejects(() => fg.save({ entries: [{ folder: 'rel', genres: ['x'] }] }), /absolute/);
assert.deepEqual(fg.list(), saved, 'a refused save changes nothing');
writeFileSync(join(stateDir, 'folder-genres.json'), '{ not json');
await fg.load();
assert.deepEqual(fg.list(), [], 'a corrupt file starts empty instead of throwing');

console.log('folder-genres.test.ts: all assertions passed');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test folder-genres.test.ts`
Expected: FAIL — `Cannot find module '…/src/music/folder-genres.js'`.

- [ ] **Step 3: Создать `controller/src/music/folder-genres.ts`**

```ts
// Folder genres — what a track WITHOUT a genre tag reads as its genre: the
// genres the operator assigned to its folder, or to the nearest assigned
// ancestor. show-filter.trackGenres falls back to it, so Genre and Any-tag
// block rules and genre shows all see it; a genre tag always wins.
//
// Persisted to <stateDir>/folder-genres.json, next to blocklist.json and for
// the same reason: NOT in library.db, so Library → Reset/Reconcile can't wipe
// it. Paths are ABSOLUTE — the real paths Navidrome reports to the station's
// player with Report Real Path on; a fake "Artist/Album/Track" path (the flag
// off) is never a path here.
//
// The path helpers are shared with the Folder block rule (blocklist-rules.ts)
// and the folder-tree route (routes/library.ts).
// Pinned by scripts/folder-genres.test.ts.

import { readFile } from 'node:fs/promises';
import { config } from '../config.js';
import { writeFileAtomic } from '../util/atomic-file.js';

export const FOLDER_GENRES_MAX = 200;       // folders in the table
export const FOLDER_GENRE_VALUES_MAX = 12;  // genres per folder — as block-rule values
export const FOLDER_GENRE_TEXT_MAX = 64;    // chars per genre — as block-rule values

export interface FolderGenresEntry {
  folder: string;
  genres: string[];
}

export interface FolderStat {
  path: string;
  total: number;     // tracks beneath, subfolders included
  untagged: number;  // of those, tracks without a genre tag
  genres: string[];  // genres assigned to exactly this folder
}

const FILE_PATH = `${config.stateDir}/folder-genres.json`;

let table = new Map<string, string[]>();

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ── Path helpers (pure) ─────────────────────────────────────────────────────

// An absolute path, or null — a fake relative path is no path at all.
export function absolutePath(p: unknown): string | null {
  return typeof p === 'string' && p.length > 1 && p.startsWith('/') ? p : null;
}

// A folder as stored: absolute, trailing slashes dropped, "/" itself refused.
// Deliberately NOT trimmed — a real folder name may end in a space.
export function normFolder(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  return absolutePath(raw.replace(/\/+$/, ''));
}

// The folder holding a path, or null at the top ("/a" has no folder row).
export function parentDir(p: string): string | null {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : null;
}

// Does `path` lie under `folder`? "/" boundary: .../Hits never covers .../Hits 2.
export function pathInFolder(folder: string, path: string | null | undefined): boolean {
  const p = absolutePath(path);
  return !!p && (p === folder || p.startsWith(`${folder}/`));
}

// The genres of a FILE path's own folder, or of its nearest assigned ancestor.
export function lookupFolderGenres(
  map: ReadonlyMap<string, string[]>,
  path: string | null | undefined,
): string[] {
  if (!map.size) return [];
  const p = absolutePath(path);
  if (!p) return [];
  for (let dir = parentDir(p); dir; dir = parentDir(dir)) {
    const genres = map.get(dir);
    if (genres?.length) return genres;
  }
  return [];
}

// ── Validation (pure) ───────────────────────────────────────────────────────

// PUT /library/folder-genres body → the table. Throws with a message naming the
// folder; an entry left with no genres means "unassigned" and is dropped.
export function validateFolderGenres(raw: unknown): Map<string, string[]> {
  const entries = (raw as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new Error('entries must be an array');
  if (entries.length > FOLDER_GENRES_MAX) throw new Error(`at most ${FOLDER_GENRES_MAX} folders`);
  const out = new Map<string, string[]>();
  for (const entry of entries as Array<{ folder?: unknown; genres?: unknown } | null>) {
    const folder = normFolder(entry?.folder);
    if (!folder) throw new Error('entries[].folder must be an absolute folder path');
    if (!Array.isArray(entry?.genres)) throw new Error(`genres must be an array (${folder})`);
    const genres: string[] = [];
    const seen = new Set<string>();
    for (const g of entry.genres) {
      if (typeof g !== 'string') throw new Error(`genres must be strings (${folder})`);
      const name = g.trim();
      if (!name) continue;
      if (name.length > FOLDER_GENRE_TEXT_MAX) {
        throw new Error(`a genre is longer than ${FOLDER_GENRE_TEXT_MAX} chars (${folder})`);
      }
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      genres.push(name);
    }
    if (genres.length > FOLDER_GENRE_VALUES_MAX) {
      throw new Error(`at most ${FOLDER_GENRE_VALUES_MAX} genres per folder (${folder})`);
    }
    if (genres.length) out.set(folder, genres);
  }
  return out;
}

// ── Folder tree (pure) ──────────────────────────────────────────────────────

// Cumulative counts for the Blocked tab's tree: every folder holding a track
// and all its ancestors below "/", with how many tracks lie beneath and how
// many of those carry no genre tag. An assigned folder with no tracks any more
// (renamed, moved) is listed with zeros, so a stale entry stays visible and
// can be cleared. Rows without an absolute path are counted, not placed.
export function aggregateFolders(
  rows: Array<{ path: string | null; tagged: boolean }>,
  assigned: ReadonlyMap<string, string[]>,
): { folders: FolderStat[]; withoutPath: number } {
  const stats = new Map<string, FolderStat>();
  const statOf = (dir: string): FolderStat => {
    let s = stats.get(dir);
    if (!s) {
      s = { path: dir, total: 0, untagged: 0, genres: [...(assigned.get(dir) ?? [])] };
      stats.set(dir, s);
    }
    return s;
  };
  let withoutPath = 0;
  for (const row of rows) {
    const p = absolutePath(row.path);
    if (!p) {
      withoutPath += 1;
      continue;
    }
    for (let dir = parentDir(p); dir; dir = parentDir(dir)) {
      const s = statOf(dir);
      s.total += 1;
      if (!row.tagged) s.untagged += 1;
    }
  }
  for (const folder of assigned.keys()) {
    for (let dir: string | null = folder; dir; dir = parentDir(dir)) statOf(dir);
  }
  const folders = [...stats.values()].sort((a, b) => byString(a.path, b.path));
  return { folders, withoutPath };
}

// ── State ───────────────────────────────────────────────────────────────────

export function list(): FolderGenresEntry[] {
  return [...table]
    .map(([folder, genres]) => ({ folder, genres: [...genres] }))
    .sort((a, b) => byString(a.folder, b.folder));
}

export function assigned(): ReadonlyMap<string, string[]> {
  return table;
}

// In-memory swap with no persistence — for load()/save() and the tests.
export function setAll(next: ReadonlyMap<string, string[]>): void {
  table = new Map(next);
}

// The hot-path read behind show-filter.trackGenres: an empty table costs nothing.
export function genresForPath(path: string | null | undefined): string[] {
  return lookupFolderGenres(table, path);
}

// Never throws: a missing file is the normal first boot, a corrupt one starts
// empty (loudly) — the station keeps playing either way, as with blocklist.json.
export async function load(): Promise<void> {
  try {
    table = validateFolderGenres(JSON.parse(await readFile(FILE_PATH, 'utf8')));
    if (table.size) console.log(`[folder-genres] loaded ${table.size} folder(s)`);
  } catch (err: any) {
    if (err?.code !== 'ENOENT') console.error('[folder-genres] load failed, starting empty:', err?.message);
    table = new Map();
  }
}

// Replace the whole table. Validates first and writes before swapping, so a
// refused body or a failed write leaves both the file and memory as they were.
export async function save(raw: unknown): Promise<FolderGenresEntry[]> {
  const next = validateFolderGenres(raw);
  const entries = [...next].map(([folder, genres]) => ({ folder, genres }));
  await writeFileAtomic(FILE_PATH, JSON.stringify({ entries }, null, 2));
  table = next;
  return list();
}
```

- [ ] **Step 4: Тест проходит**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test folder-genres.test.ts`
Expected: `folder-genres.test.ts: all assertions passed`.

- [ ] **Step 5: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "folder-genres: table, path helpers, folder tree"`

---

### Task 5: Жанр папки в `trackGenres` и правило Folder

**Files:**
- Test: `controller/scripts/folder-rules.test.ts` (Create)
- Modify: `controller/src/music/show-filter.ts` (импорт строка 12, `FilterTrack` ≈ 35–37, `trackGenres` ≈ 47–57)
- Modify: `controller/src/schemas/blocklist.ts` (`RULE_FIELDS` ≈ 24–32, константы ≈ 38, проверка длины ≈ 134–140, конец `blockRuleSchema` ≈ 172–177)
- Modify: `controller/src/music/blocklist-rules.ts` (импорты ≈ 12–18, `validateRulePatch` ≈ 66–71, `CompiledRule`/`compileRules` ≈ 109–121, комментарий семантики и `ruleMatches` ≈ 131–175)
- Modify: `controller/src/server.ts` (импорт строка 10, загрузка ≈ 245)
- Regenerate: `web/lib/schemas.generated.ts` (на Debian, `sw.sh gen-schemas`)

**Interfaces:**
- Consumes: задача 3 — `library.get(id).path`; задача 4 — `absolutePath`, `normFolder`, `pathInFolder`, `genresForPath`, `setAll`, `load`.
- Produces:
  - `FilterTrack.path?: string | null`;
  - `trackGenres(t)` — теги, иначе жанры папки; `trackPath(t: FilterTrack | null | undefined): string | null`;
  - `RULE_FIELDS` c `'folder'`, `RULE_PATH_MAX = 512`;
  - `CompiledRule.folderTargets: string[]`; `ruleMatches` для `folder`; `validateRulePatch` требует абсолютных путей у `folder` и срезает завершающий `/`;
  - `folderGenres.load()` при старте контроллера.

- [ ] **Step 1: Написать падающий тест** — `controller/scripts/folder-rules.test.ts`:

```ts
// Folder genres and Folder rules (music/show-filter.ts + music/blocklist-rules.ts
// + schemas/blocklist.ts): a track WITHOUT a genre tag reads the genre of its
// folder (nearest assigned ancestor), a tag always wins, fake relative paths
// are ignored, a Folder rule blocks everything under the folder on a "/"
// boundary, and real paths may run past the 64-char cap names keep.
// Pure: tracks carry genres/path inline, library-db is never opened.
// Run: `tsx scripts/folder-rules.test.ts`.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.STATE_DIR = mkdtempSync(join(tmpdir(), 'subwave-folder-rules-'));
const folderGenres = await import('../src/music/folder-genres.js');
const { trackGenres, trackPath, genreMatches, normGenre } = await import('../src/music/show-filter.js');
const { compileRules, ruleMatches, validateRulePatch } = await import('../src/music/blocklist-rules.js');
const { blockRuleSchema, RULE_TEXT_MAX } = await import('../src/schemas/blocklist.js');

const ROOT = '/mnt/music';
folderGenres.setAll(new Map([
  [`${ROOT}/Unsorted/!Помойка русская`, ['Поп']],
  [`${ROOT}/Unsorted`, ['Разное']],
]));

// ── genre fallback ──────────────────────────────────────────────────────────
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Unsorted/!Помойка русская/a.mp3` }), ['Поп'], 'own folder');
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Unsorted/Юля Кошкина/b.mp3` }), ['Разное'], 'nearest assigned ancestor');
assert.deepEqual(
  trackGenres({ genres: ['Äðóãîå'], path: `${ROOT}/Unsorted/!Помойка русская/c.mp3` }),
  ['Äðóãîå'],
  'a tag always wins, even a junk one',
);
assert.deepEqual(trackGenres({ genres: [], path: 'Artist/Album/d.mp3' }), [], 'a fake relative path gives no folder genre');
assert.deepEqual(trackGenres({ genres: [], path: `${ROOT}/Sorted/e.mp3` }), [], 'unassigned folder → no genre');
assert.equal(
  genreMatches({ genres: [], path: `${ROOT}/Unsorted/!Помойка русская/a.mp3` }, [normGenre('Поп')]),
  true,
  'Genre rules and genre shows see the folder genre',
);

// ── trackPath ───────────────────────────────────────────────────────────────
assert.equal(trackPath({ path: `${ROOT}/x.mp3` }), `${ROOT}/x.mp3`);
assert.equal(trackPath({ path: 'A/B/x.mp3' }), null, 'a fake path is no path');
assert.equal(trackPath({}), null);

// ── Folder rule matching ────────────────────────────────────────────────────
const folderRule = (values: string[]) => compileRules([{
  id: 'r', label: 'x', field: 'folder', values, season: null, showIds: [], addedAt: '2026-01-01T00:00:00.000Z',
}])[0]!;
const sborki = folderRule([`${ROOT}/Сборки`]);
assert.equal(ruleMatches(sborki, { path: `${ROOT}/Сборки/Europa Plus/a.mp3` }, null), true, 'subfolders included');
assert.equal(ruleMatches(sborki, { path: `${ROOT}/Сборки 2/a.mp3` }, null), false, 'boundary is "/"');
assert.equal(ruleMatches(sborki, { path: 'Сборки/a.mp3' }, null), false, 'a fake path never matches');
assert.equal(ruleMatches(sborki, {}, null), false, 'no path, no match');
assert.equal(ruleMatches(folderRule([`${ROOT}/Сборки/`]), { path: `${ROOT}/Сборки/a.mp3` }, null), true, 'trailing slash normalised');

// ── validation ──────────────────────────────────────────────────────────────
const long = `${ROOT}/Sorted (mp3_320)/Рок зарубежный/Metallica/1991 - Metallica (Remastered)`;
assert.ok(long.length > RULE_TEXT_MAX);
assert.deepEqual(
  validateRulePatch({ label: 'x', field: 'folder', values: [`${long}/`] }).values,
  [long],
  'a long real path is accepted, trailing slash stripped',
);
assert.throws(() => validateRulePatch({ label: 'x', field: 'folder', values: ['Сборки'] }), /absolute/, 'relative folder refused');
assert.equal(
  blockRuleSchema.safeParse({ label: 'x', field: 'genre', values: ['x'.repeat(RULE_TEXT_MAX + 1)] }).success,
  false,
  'names keep the 64-char cap',
);

console.log('folder-rules.test.ts: all assertions passed');
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test folder-rules.test.ts`
Expected: FAIL — `own folder` (`[]` вместо `['Поп']`).

- [ ] **Step 3: `show-filter.ts`** (Edit, точечно)

Заменить `import * as library from './library.js';` на

```ts
import * as library from './library.js';
import * as folderGenres from './folder-genres.js';
```

В `FilterTrack` заменить

```ts
  // Last.fm enrichment tags — part of trackAllTags' any-namespace union.
  lastfmTags?: string[] | null;
}
```

на

```ts
  // Last.fm enrichment tags — part of trackAllTags' any-namespace union.
  lastfmTags?: string[] | null;
  // Absolute file path, as Navidrome reports it to a player with Report Real
  // Path on (a fake "Artist/Album/Track" path otherwise — ignored). Drives
  // folder genres and Folder rules; library rows carry it from the reconcile.
  path?: string | null;
}
```

Заменить комментарий и тело `trackGenres`:

```ts
// Per-track genre tags — every tag the track carries, from the track itself
// (Subsonic children and slimTrack library rows both carry `genres`; older
// callers may carry only the scalar `genre`) or a library lookup. Empty when
// the track has no genre tag.
export function trackGenres(t: FilterTrack | null | undefined): string[] {
  if (Array.isArray(t?.genres) && t.genres.length) return t.genres;
  if (t?.genre) return [t.genre];
  const rec = t?.id ? library.get(t.id) : null;
  if (Array.isArray(rec?.genres) && rec.genres.length) return rec.genres;
  return rec?.genre ? [rec.genre] : [];
}
```

на

```ts
// Per-track genre tags — every tag the track carries, from the track itself
// (Subsonic children and slimTrack library rows both carry `genres`; older
// callers may carry only the scalar `genre`) or a library lookup, falling back
// to the genres assigned to its folder. Empty when neither exists.
export function trackGenres(t: FilterTrack | null | undefined): string[] {
  if (Array.isArray(t?.genres) && t.genres.length) return t.genres;
  if (t?.genre) return [t.genre];
  const rec = t?.id ? library.get(t.id) : null;
  if (Array.isArray(rec?.genres) && rec.genres.length) return rec.genres;
  if (rec?.genre) return [rec.genre];
  // No genre tag anywhere: the genres the operator assigned to the track's
  // folder (nearest assigned ancestor). A tag always wins, even a junk one.
  return folderGenres.genresForPath(folderGenres.absolutePath(t?.path) ?? rec?.path ?? null);
}

// A track's absolute file path — inline (Subsonic children, library rows) or
// from its library row. null when Navidrome never reported a real one.
export function trackPath(t: FilterTrack | null | undefined): string | null {
  const inline = folderGenres.absolutePath(t?.path);
  if (inline) return inline;
  const rec = t?.id ? library.get(t.id) : null;
  return folderGenres.absolutePath(rec?.path);
}
```

- [ ] **Step 4: `schemas/blocklist.ts`** (файл импортирует только `zod` — так и остаётся)

`RULE_FIELDS`: заменить

```ts
  'title',
  'playlist',
] as const;
```

на

```ts
  'title',
  'playlist',
  // An absolute folder path (Navidrome's real path with Report Real Path on):
  // blocks every track under it, subfolders included.
  'folder',
] as const;
```

Константа: заменить `export const RULE_TEXT_MAX = 64;` на

```ts
export const RULE_TEXT_MAX = 64;
// A folder rule's value is a path, not a name — real library paths run well
// past RULE_TEXT_MAX (".../Sorted (mp3_320)/<genre>/<artist>/<year> - <album>").
export const RULE_PATH_MAX = 512;
```

Проверка длины значения: заменить

```ts
        if (t.length > RULE_TEXT_MAX) {
          ctx.addIssue({
            code: 'custom',
            message: `rule.values entries must be at most ${RULE_TEXT_MAX} chars`,
          });
          return z.NEVER;
        }
```

на

```ts
        // The outer cap is the path one; names get RULE_TEXT_MAX back in the
        // object-level check below, the only place that knows the field.
        if (t.length > RULE_PATH_MAX) {
          ctx.addIssue({
            code: 'custom',
            message: `rule.values entries must be at most ${RULE_PATH_MAX} chars`,
          });
          return z.NEVER;
        }
```

Конец схемы: заменить

```ts
      .default([]),
  ),
});

export type BlockRulePatch = z.output<typeof blockRuleSchema>;
```

на

```ts
      .default([]),
  ),
}).superRefine((rule, ctx) => {
  if (rule.field === 'folder') return;
  if (rule.values.some((v) => v.length > RULE_TEXT_MAX)) {
    ctx.addIssue({
      code: 'custom',
      path: ['values'],
      message: `rule.values entries must be at most ${RULE_TEXT_MAX} chars`,
    });
  }
});

export type BlockRulePatch = z.output<typeof blockRuleSchema>;
```

(Сообщение прежнее дословно: `scripts/library-schema.test.ts` сверяет, что маршрут и хранилище называют одну и ту же ошибку.)

- [ ] **Step 5: `blocklist-rules.ts`**

Импорты: заменить

```ts
import {
  normGenre,
  genreMatches,
  trackAllTags,
  trackMoods,
  type FilterTrack,
} from './show-filter.js';
```

на

```ts
import {
  normGenre,
  genreMatches,
  trackAllTags,
  trackMoods,
  trackPath,
  type FilterTrack,
} from './show-filter.js';
import { normFolder, pathInFolder } from './folder-genres.js';
```

`validateRulePatch`: заменить

```ts
  const parsed = blockRuleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid rule');
  return parsed.data;
}
```

на

```ts
  const parsed = blockRuleSchema.safeParse(raw);
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message || 'invalid rule');
  if (parsed.data.field !== 'folder') return parsed.data;
  // Folder values are matched as absolute paths on a "/" boundary. The shared
  // schema can't say so (upstream's schema test parses every field with a plain
  // name), so the store checks it and drops trailing slashes.
  const folders = parsed.data.values.map(normFolder);
  if (folders.some((f) => f === null)) {
    throw new Error('rule.values for a folder rule must be absolute folder paths');
  }
  return { ...parsed.data, values: [...new Set(folders as string[])] };
}
```

`CompiledRule` и `compileRules`: заменить

```ts
  genreTargets: string[];  // field=genre — normGenre'd, for genreMatches
  valueSet: Set<string>;   // every other field — normText'd exact match
}

export function compileRules(rules: BlockRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    rule,
    genreTargets: rule.field === 'genre' ? rule.values.map(normGenre).filter(Boolean) : [],
    valueSet: new Set(rule.values.map(normText).filter(Boolean)),
  }));
}
```

на

```ts
  genreTargets: string[];  // field=genre — normGenre'd, for genreMatches
  folderTargets: string[]; // field=folder — normFolder'd absolute paths, case kept
  valueSet: Set<string>;   // every other field — normText'd exact match
}

export function compileRules(rules: BlockRule[]): CompiledRule[] {
  return rules.map((rule) => ({
    rule,
    genreTargets: rule.field === 'genre' ? rule.values.map(normGenre).filter(Boolean) : [],
    folderTargets: rule.field === 'folder'
      ? rule.values.map(normFolder).filter((f): f is string => f !== null)
      : [],
    valueSet: new Set(rule.values.map(normText).filter(Boolean)),
  }));
}
```

Комментарий семантики: заменить

```ts
//   playlist — track id ∈ the pre-resolved member set for any listed playlist
//            id; an unresolved playlist contributes nothing (stale ids inert).
```

на

```ts
//   playlist — track id ∈ the pre-resolved member set for any listed playlist
//            id; an unresolved playlist contributes nothing (stale ids inert).
//   folder — the track's absolute path lies under a listed folder, "/"
//            boundary (blocking .../Hits keeps .../Hits 2); a track without a
//            real path matches nothing.
```

`ruleMatches`: заменить

```ts
      return false;
    }
    default:
      return false;
```

на

```ts
      return false;
    }
    case 'folder': {
      const path = trackPath(track);
      return !!path && cr.folderTargets.some((folder) => pathInFolder(folder, path));
    }
    default:
      return false;
```

- [ ] **Step 6: `server.ts` — загрузка таблицы при старте**

Заменить `import * as blocklist from './music/blocklist.js';` на

```ts
import * as blocklist from './music/blocklist.js';
import * as folderGenres from './music/folder-genres.js';
```

Заменить `  await blocklist.load();` на

```ts
  await blocklist.load();

  // Folder genres — what a track without a genre tag reads as its genre (Genre
  // rules, genre shows). Same contract as the blocklist: in memory before the
  // first pick, never throws.
  await folderGenres.load();
```

- [ ] **Step 7: Тесты — новый и соседние**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh test folder-rules.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test blocklist-rules.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test blocklist.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test library-schema.test.ts && bash <tmp>/sw-genre-tools/sw-remote.sh test show-filter.test.ts`
Expected: `folder-rules.test.ts: all assertions passed`; в остальных — ни одного ✗.

- [ ] **Step 8: Перегенерировать зеркало схем**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh gen-schemas`
Expected: `GEN_OK`. Затем `bash <tmp>/sw-genre-tools/sw-remote.sh ourdiff` — в списке есть `web/lib/schemas.generated.ts`.

- [ ] **Step 9: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "Folder rule and folder-genre fallback"`

---

### Task 6: Маршруты API и полная проверка контроллера

**Files:**
- Modify: `controller/src/routes/library.ts` (импорт строка 8; новые маршруты — перед блоком `Never-play blocklist`, ≈ 959)

**Interfaces:**
- Consumes: задача 3 — `library.load()`, `db.folderRows()`; задача 4 — `aggregateFolders`, `assigned`, `list`, `save`; `queue.purgeBlocked()`, `refreshAutoPlaylist()` (уже импортированы в файле).
- Produces (HTTP, под `requireAdmin`):
  - `GET /library/folders` → `{ folders: FolderStat[]; withoutPath: number }`;
  - `GET /library/folder-genres` → `{ entries: FolderGenresEntry[] }`;
  - `PUT /library/folder-genres`, тело `{ entries: Array<{ folder: string; genres: string[] }> }` → `{ entries, purged }`; при отказе валидации — `400 { error }`.

- [ ] **Step 1: Маршруты**

Заменить `import * as blocklist from '../music/blocklist.js';` на

```ts
import * as blocklist from '../music/blocklist.js';
import * as folderGenres from '../music/folder-genres.js';
```

Перед строками

```ts
// ---------------------------------------------------------------------------
// Never-play blocklist — station-level "never let this air" entries at
```

вставить:

```ts
// ---------------------------------------------------------------------------
// Folder tree + folder genres (Blocked tab). GET /library/folders lists every
// folder holding tracks, and its ancestors, with cumulative counts; the
// folder-genre table is what a track WITHOUT a genre tag reads as its genre
// (music/folder-genres.ts). Paths are the absolute ones Navidrome reports to
// the station's player with Report Real Path on; tracks without one are
// counted in `withoutPath`, so the card can say why a folder is missing.
// ---------------------------------------------------------------------------

router.get('/library/folders', requireAdmin, async (_req, res) => {
  try {
    await library.load();
    res.json(folderGenres.aggregateFolders(db.folderRows(), folderGenres.assigned()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/library/folder-genres', requireAdmin, (_req, res) => {
  res.json({ entries: folderGenres.list() });
});

router.put('/library/folder-genres', requireAdmin, async (req, res) => {
  try {
    const entries = await folderGenres.save(req.body);
    queue.log('blocked', `folder genres updated (${entries.length} folder${entries.length === 1 ? '' : 's'})`);
    // A folder genre can bring tracks under an existing Genre rule — drop them
    // from upcoming and rebuild auto.m3u, exactly as a rule change does.
    const purged = queue.purgeBlocked();
    refreshAutoPlaylist().catch((err: any) => queue.log('error', `folder-genres auto-playlist refresh failed: ${err.message}`));
    res.json({ entries, purged });
  } catch (err) {
    // Validation errors are the operator's input, not a server fault.
    res.status(400).json({ error: err.message });
  }
});

```

- [ ] **Step 2: Линт (eslint + tsc)**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh lint`
Expected: `LINT_OK` (либо ровно те ошибки, что в `base.lint`). Ошибки типов в правленых файлах — чинить здесь же.

- [ ] **Step 3: Полный набор против эталона**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh suite`
Expected: после строки `new against baseline:` — пусто, затем `SUITE_DONE`. Любая новая строка `✖` — разобрать до следующей задачи.

- [ ] **Step 4: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "Routes: folder tree and folder genres"`

---

### Task 7: Веб — модуль дерева папок

**Files:**
- Create: `<tmp>\sw-genre\web\lib\folderTree.ts`
- Test: `<tmp>\sw-genre\web\lib\folderTree.test.ts` (Create)

**Interfaces:**
- Consumes: формат ответа `GET /library/folders` (задача 6).
- Produces: `FolderStat`, `FolderNode` (= `FolderStat` + `name: string; children: FolderNode[]`), `buildFolderTree(stats: readonly FolderStat[]): FolderNode | null`, `filterTree(root: FolderNode, query: string, keep?: (n: FolderNode) => boolean): FolderNode | null`, `displayPath(root: FolderNode, path: string): string`.

- [ ] **Step 1: Написать падающий тест** — `web/lib/folderTree.test.ts`:

```ts
// Дерево папок вкладки Blocked (lib/folderTree.ts). Приём тот же, что у
// web/lib/roomRules.test.ts (assert + ✓/✗ + ненулевой выход).
// Запуск из корня клона:  npx tsx web/lib/folderTree.test.ts

import assert from 'node:assert/strict';
import { buildFolderTree, displayPath, filterTree, type FolderNode, type FolderStat } from './folderTree';

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

const st = (path: string, total: number, untagged = 0, genres: string[] = []): FolderStat =>
  ({ path, total, untagged, genres });
const M = '<music-mount>';
const LIB: FolderStat[] = [
  st('/mnt', 10, 6), st('<share-mount-root>', 10, 6), st('<share-mount-root>/Public', 10, 6), st(M, 10, 6),
  st(`${M}/Sorted`, 4, 0), st(`${M}/Sorted/Рок русский`, 4, 0),
  st(`${M}/Unsorted`, 6, 6), st(`${M}/Unsorted/!Помойка русская`, 4, 4, ['Поп']),
  st(`${M}/Unsorted/Юля Кошкина`, 2, 2),
];
const names = (n: FolderNode | null | undefined): string[] => (n ? n.children.map((c) => c.name) : []);

// assert.ok сужает тип, поэтому ниже обходимся без восклицательных знаков:
// правило линтера на них в вебе не проверено, а падать тест должен внятно.
function tree(stats: FolderStat[]): FolderNode {
  const t = buildFolderTree(stats);
  assert.ok(t, 'дерево построено');
  return t;
}

function filtered(root: FolderNode, q: string, keep?: (n: FolderNode) => boolean): FolderNode {
  const t = filterTree(root, q, keep);
  assert.ok(t, 'фильтр что-то оставил');
  return t;
}

console.log('buildFolderTree');

test('цепочка папок-одиночек от /mnt сворачивается в корень библиотеки', () => {
  const root = tree(LIB);
  assert.equal(root.path, M);
  assert.equal(root.name, M);
  assert.deepEqual(names(root), ['Sorted', 'Unsorted']);
});

test('папка со своими треками останавливает свёртку', () => {
  const root = tree([st('/a', 10), st('/a/b', 10), st('/a/b/c', 7)]);
  assert.equal(root.path, '/a/b');
  assert.deepEqual(names(root), ['c']);
});

test('дети отсортированы по имени', () => {
  const unsorted = tree(LIB).children.find((c) => c.name === 'Unsorted');
  assert.deepEqual(names(unsorted), ['!Помойка русская', 'Юля Кошкина']);
});

test('пустой список — нет дерева', () => {
  assert.equal(buildFolderTree([]), null);
});

console.log('filterTree');

test('поиск оставляет совпавшие папки и путь к ним, без учёта регистра и на кириллице', () => {
  const out = filtered(tree(LIB), 'помойка');
  assert.deepEqual(names(out), ['Unsorted']);
  assert.deepEqual(names(out.children[0]), ['!Помойка русская']);
});

test('длинный путь корня совпадением не считается', () => {
  assert.equal(filterTree(tree(LIB), 'mnt'), null);
});

test('keep убирает полностью размеченные ветви, но оставляет предков', () => {
  const out = filtered(tree(LIB), '', (n) => n.untagged > 0);
  assert.deepEqual(names(out), ['Unsorted']);
});

test('назначение для исчезнувшей папки остаётся видимым', () => {
  const stale = [...LIB, st(`${M}/Sorted/Переименовано`, 0, 0, ['Рок'])];
  const keep = (n: FolderNode) => n.untagged > 0 || n.genres.length > 0;
  const out = filtered(tree(stale), '', keep);
  assert.deepEqual(names(out), ['Sorted', 'Unsorted']);
  assert.deepEqual(names(out.children[0]), ['Переименовано']);
});

test('без запроса и без keep — всё дерево', () => {
  assert.deepEqual(names(filtered(tree(LIB), '')), ['Sorted', 'Unsorted']);
});

console.log('displayPath');

test('путь внутри корня показывается от корня', () => {
  assert.equal(displayPath(tree(LIB), `${M}/Сборки`), 'Сборки');
});

test('путь вне корня показывается целиком', () => {
  assert.equal(displayPath(tree(LIB), '/elsewhere/x'), '/elsewhere/x');
});

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
```

- [ ] **Step 2: Убедиться, что тест падает**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh wtest folderTree.test.ts`
Expected: FAIL — `Cannot find module './folderTree'`.

- [ ] **Step 3: Создать `web/lib/folderTree.ts`**

```ts
// The library's folders as a tree for the Blocked tab, built from the flat
// GET /library/folders list (every folder holding tracks plus its ancestors,
// counts cumulative). Pure and React-free — pinned by folderTree.test.ts.

export interface FolderStat {
  path: string;      // absolute, as Navidrome reports it to the station
  total: number;     // tracks beneath, subfolders included
  untagged: number;  // of those, tracks without a genre tag
  genres: string[];  // genres assigned to exactly this folder
}

export interface FolderNode extends FolderStat {
  name: string;
  children: FolderNode[];
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const parentPath = (p: string) => p.slice(0, Math.max(0, p.lastIndexOf('/')));

function sortTree(n: FolderNode): void {
  n.children.sort((a, b) => a.name.localeCompare(b.name));
  n.children.forEach(sortTree);
}

// The chain of single-child folders from the top down to the library root
// (/mnt → <share-mount-root> → … → Music) collapses into ONE root node named by its
// full path: nobody browses four empty levels to reach the music. A folder
// holding tracks of its own stops the collapse.
export function buildFolderTree(stats: readonly FolderStat[]): FolderNode | null {
  if (!stats.length) return null;
  const byPath = new Map<string, FolderNode>();
  for (const s of stats) {
    byPath.set(s.path, { ...s, genres: [...(s.genres ?? [])], name: baseName(s.path), children: [] });
  }
  const tops: FolderNode[] = [];
  for (const node of byPath.values()) {
    const parent = byPath.get(parentPath(node.path));
    if (parent) parent.children.push(node);
    else tops.push(node);
  }
  const [firstTop, ...otherTops] = tops;
  let root: FolderNode = firstTop && !otherTops.length
    ? firstTop
    : {
        path: '',
        name: '/',
        genres: [],
        children: tops,
        total: tops.reduce((n, t) => n + t.total, 0),
        untagged: tops.reduce((n, t) => n + t.untagged, 0),
      };
  for (;;) {
    const [only, ...rest] = root.children;
    if (!only || rest.length || only.total !== root.total) break;
    root = only;
  }
  sortTree(root);
  return { ...root, name: root.path || '/' };
}

// The tree narrowed for display. `keep` drops a node unless it or a descendant
// passes, so the path to a kept folder always shows. A search keeps every
// folder whose NAME contains the query (case-insensitive) with its kept subtree
// and the path to it; the root's own long path never counts as a hit, or every
// search would match everything.
export function filterTree(
  root: FolderNode,
  query: string,
  keep?: (n: FolderNode) => boolean,
): FolderNode | null {
  const q = query.trim().toLocaleLowerCase();
  const passes = keep ?? (() => true);
  const prune = (n: FolderNode): FolderNode | null => {
    const children = n.children.map(prune).filter((c): c is FolderNode => c !== null);
    return passes(n) || children.length ? { ...n, children } : null;
  };
  if (!q) return prune(root);
  const search = (n: FolderNode): FolderNode | null => {
    if (n.name.toLocaleLowerCase().includes(q)) return prune(n);
    const children = n.children.map(search).filter((c): c is FolderNode => c !== null);
    return children.length ? { ...n, children } : null;
  };
  const children = root.children.map(search).filter((c): c is FolderNode => c !== null);
  return children.length ? { ...root, children } : null;
}

// A folder path as a rule row shows it: relative to the collapsed root.
export function displayPath(root: FolderNode, path: string): string {
  return root.path && path.startsWith(`${root.path}/`) ? path.slice(root.path.length + 1) : path;
}
```

- [ ] **Step 4: Тест проходит**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh wtest folderTree.test.ts`
Expected: все строки `✓`, в конце `all passed`.

- [ ] **Step 5: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "web: folder tree module"`

---

### Task 8: Веб — дерево в редакторе правила

**Files:**
- Create: `<tmp>\sw-genre\web\components\admin\library\FolderTree.tsx`
- Modify: `<tmp>\sw-genre\web\components\admin\library\BlockRulesCard.tsx` (импорты ≈ 10–33, `FIELD_OPTIONS` ≈ 47–55, `ValuesInput` ≈ 89, состояние ≈ 157–160, загрузка словарей ≈ 185–208, строка правила ≈ 355, ветка значений ≈ 468)

**Interfaces:**
- Consumes: задача 6 — `GET /library/folders`; задача 7 — `buildFolderTree`, `filterTree`, `displayPath`, `FolderNode`, `FolderStat`; `RuleField` с `'folder'` из перегенерированного зеркала (задача 5).
- Produces: компонент `FolderTree({ root, query?, keep?, checked?, onToggle?, renderMeta? })`; `ValuesInput` экспортирован из `BlockRulesCard.tsx`.

- [ ] **Step 1: Создать `web/components/admin/library/FolderTree.tsx`**

```tsx
'use client';

// The library's folders as a collapsible tree — the Blocked tab's folder picker
// (Folder rules) and the folder-genre editor share it. Tree building and
// filtering live in lib/folderTree (pure, tested); this only renders.

import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { filterTree, type FolderNode } from '@/lib/folderTree';

export function FolderTree({ root, query = '', keep, checked, onToggle, renderMeta }: {
  root: FolderNode;
  query?: string;
  keep?: (n: FolderNode) => boolean;
  // Selectable mode when both are given. The root never gets a checkbox:
  // blocking the whole library would silence the station.
  checked?: string[];
  onToggle?: (path: string) => void;
  renderMeta?: (n: FolderNode) => ReactNode;
}) {
  // Expanded folders, by path. The root starts open; while searching, every
  // branch leading to a hit is open, so a match is never buried.
  const [open, setOpen] = useState<Set<string>>(() => new Set([root.path]));
  const shown = filterTree(root, query, keep);
  const searching = query.trim().length > 0;
  if (!shown) return <div className="field-hint">No folders match.</div>;

  const toggle = (path: string) => setOpen(prev => {
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });

  const renderNode = (n: FolderNode, depth: number): ReactNode => {
    const hasKids = n.children.length > 0;
    const expanded = hasKids && (searching || open.has(n.path));
    const selectable = !!checked && !!onToggle && depth > 0;
    return (
      <div key={n.path || '/'} role="treeitem" aria-expanded={hasKids ? expanded : undefined}>
        <div className="flex items-center gap-1.5 py-0.5 text-[12px]" style={{ paddingLeft: depth * 14 }}>
          {hasKids ? (
            <button
              type="button"
              onClick={() => toggle(n.path)}
              disabled={searching}
              aria-label={`${expanded ? 'collapse' : 'expand'} ${n.name}`}
              className="cursor-pointer border-0 bg-transparent p-0 leading-none text-muted hover:text-ink"
            >
              {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            </button>
          ) : (
            <span className="inline-block w-3" aria-hidden />
          )}
          {selectable && (
            <input
              type="checkbox"
              checked={checked?.includes(n.path) ?? false}
              onChange={() => onToggle?.(n.path)}
              aria-label={`select ${n.name}`}
            />
          )}
          <span className="min-w-0 flex-1 truncate" title={n.path}>{n.name}</span>
          {renderMeta?.(n)}
        </div>
        {expanded && n.children.map(c => renderNode(c, depth + 1))}
      </div>
    );
  };

  return <div role="tree" className="grid max-h-72 overflow-auto">{renderNode(shown, 0)}</div>;
}
```

- [ ] **Step 2: `BlockRulesCard.tsx` — импорты, поле, экспорт `ValuesInput`**

После `import type { BlockRuleStat, RuleField, SeasonWindow } from './types';` добавить:

```tsx
import { FolderTree } from './FolderTree';
import { buildFolderTree, displayPath, type FolderNode, type FolderStat } from '@/lib/folderTree';
```

В `FIELD_OPTIONS` после строки опции `playlist` добавить:

```tsx
  { value: 'folder', label: 'Folder', hint: 'blocks every track inside the chosen folders, subfolders included' },
```

Заменить `function ValuesInput({ id, values, onChange, placeholder, suggestions }: {` на `export function ValuesInput({ id, values, onChange, placeholder, suggestions }: {`.

- [ ] **Step 3: Состояние и загрузка дерева**

После строки `const [playlists, setPlaylists] = useState<Array<{ id: string; name: string; songCount: number | null }>>([]);` добавить:

```tsx
  // Folder picker vocab — the library's folder tree (GET /library/folders) and
  // how many tracks Navidrome gave no real path, so the picker can say why a
  // folder is missing.
  const [folders, setFolders] = useState<{ root: FolderNode | null; withoutPath: number }>({ root: null, withoutPath: 0 });
  const [folderQuery, setFolderQuery] = useState('');
```

Заменить

```tsx
      try {
        const r = await adminFetch('/dj/playlists');
        if (r.ok) {
          const j = await r.json() as { results?: Array<{ id: string; name: string; songCount: number | null }> };
          setPlaylists(j.results || []);
        }
      } catch {}
    })();
```

на

```tsx
      try {
        const r = await adminFetch('/dj/playlists');
        if (r.ok) {
          const j = await r.json() as { results?: Array<{ id: string; name: string; songCount: number | null }> };
          setPlaylists(j.results || []);
        }
      } catch {}
      try {
        const r = await adminFetch('/library/folders');
        if (r.ok) {
          const j = await r.json() as { folders?: FolderStat[]; withoutPath?: number };
          const list = j.folders || [];
          setFolders({ root: buildFolderTree(list), withoutPath: j.withoutPath || 0 });
          // Genres assigned to folders are genres too — offer them beside the tags.
          const assigned = list.flatMap(f => f.genres || []);
          if (assigned.length) setGenres(prev => [...new Set([...prev, ...assigned])]);
        }
      } catch {}
    })();
```

- [ ] **Step 4: Строка правила показывает папки от корня**

Заменить

```tsx
                  {rule.field === 'playlist' ? rule.values.map(playlistNameOf).join(', ') : rule.values.join(', ')}
```

на

```tsx
                  {rule.field === 'playlist'
                    ? rule.values.map(playlistNameOf).join(', ')
                    : rule.field === 'folder'
                      ? rule.values.map(v => (folders.root ? displayPath(folders.root, v) : v)).join(', ')
                      : rule.values.join(', ')}
```

- [ ] **Step 5: Ветка значений для Folder**

Перед строкой `                if (fieldWatch === 'playlist') {` вставить:

```tsx
                if (fieldWatch === 'folder') {
                  const selected = field.value;
                  return (
                    <div className="field">
                      <Label {...aria.labelledByProps}>Folders</Label>
                      {folders.root === null ? (
                        <div className="field-hint">No folders yet — they appear after Reconcile with Navidrome, once Navidrome reports real paths to the station.</div>
                      ) : (
                        <div {...aria.groupProps} className="grid gap-2">
                          <Input
                            value={folderQuery}
                            onChange={e => setFolderQuery(e.target.value)}
                            placeholder="find a folder…"
                            aria-label="find a folder"
                          />
                          <FolderTree
                            root={folders.root}
                            query={folderQuery}
                            checked={selected}
                            onToggle={path => field.onChange(
                              selected.includes(path) ? selected.filter(v => v !== path) : [...selected, path],
                            )}
                            renderMeta={n => <span className="mono-num text-[10px] text-muted">{n.total}</span>}
                          />
                        </div>
                      )}
                      {folders.withoutPath > 0 && (
                        <div className="field-hint mt-1">
                          {folders.withoutPath} track{folders.withoutPath === 1 ? '' : 's'} have no real path — folder rules and folder genres cannot see them.
                        </div>
                      )}
                      {fieldState.error && <FieldError {...aria.errorProps} errors={[fieldState.error]} />}
                    </div>
                  );
                }
```

- [ ] **Step 6: Перенести и зафиксировать** (линт веба — в конце задачи 9, одним прогоном)

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "web: Folder rule with a folder tree"`
Expected: `applied <N> files`, строка коммита.

---

### Task 9: Веб — карточка «Folder genres»

**Files:**
- Create: `<tmp>\sw-genre\web\components\admin\library\FolderGenresCard.tsx`
- Modify: `<tmp>\sw-genre\web\components\admin\library\tabs\BlockedTabContainer.tsx` (импорт ≈ 6, разметка ≈ 61)

**Interfaces:**
- Consumes: задача 6 — `GET /library/folders`, `PUT /library/folder-genres`; `GET /library/genres` (апстрим); задача 7 — `buildFolderTree`, `FolderNode`, `FolderStat`; задача 8 — `FolderTree`, `ValuesInput`.
- Produces: `FolderGenresCard({ onChanged }: { onChanged?: () => void })`.

- [ ] **Step 1: Создать `web/components/admin/library/FolderGenresCard.tsx`**

```tsx
'use client';

// Folder genres (Blocked tab): the genre a track WITHOUT a genre tag takes from
// its folder, or from the nearest parent folder that has one. Genre and
// Any-tag rules and genre shows read it. The tree shows only branches holding
// untagged tracks by default; the table is saved whole (PUT /library/folder-genres).

import { useCallback, useEffect, useState } from 'react';
import { useAdminAuth } from '../../../lib/adminAuth';
import { notify, errorMessage } from '../../../lib/notify';
import { Card, Btn } from '../ui';
import { Input } from '../../ui/input';
import { SkeletonRows } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { buildFolderTree, type FolderNode, type FolderStat } from '@/lib/folderTree';
import { FolderTree } from './FolderTree';
import { ValuesInput } from './BlockRulesCard';

type Table = Record<string, string[]>;

// Order-insensitive fingerprint of the assigned (non-empty) entries — what
// "is there anything to save" compares.
const fingerprint = (t: Table) =>
  JSON.stringify(Object.entries(t).filter(([, g]) => g.length).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

export function FolderGenresCard({ onChanged }: { onChanged?: () => void }) {
  const { adminFetch, needsAuth, hydrated } = useAdminAuth();
  const [root, setRoot] = useState<FolderNode | null | undefined>(undefined); // undefined = loading
  const [withoutPath, setWithoutPath] = useState(0);
  const [draft, setDraft] = useState<Table>({});
  const [saved, setSaved] = useState<Table>({});
  const [genres, setGenres] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [untaggedOnly, setUntaggedOnly] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await adminFetch('/library/folders');
      if (!r.ok) throw new Error(`folders load failed (${r.status})`);
      const j = await r.json() as { folders?: FolderStat[]; withoutPath?: number };
      const list = j.folders || [];
      const table: Table = {};
      for (const f of list) if (f.genres?.length) table[f.path] = [...f.genres];
      setRoot(buildFolderTree(list));
      setWithoutPath(j.withoutPath || 0);
      setDraft(table);
      setSaved(table);
    } catch (e) {
      notify.err(errorMessage(e));
      setRoot(prev => prev ?? null);
    }
  }, [adminFetch]);

  useEffect(() => {
    if (!hydrated || needsAuth) return;
    void load();
    void (async () => {
      try {
        const r = await adminFetch('/library/genres');
        if (r.ok) {
          const j = await r.json() as { genres?: Array<{ value: string }> };
          setGenres((j.genres || []).map(g => g.value).filter(Boolean));
        }
      } catch {}
    })();
  }, [hydrated, needsAuth, load, adminFetch]);

  const save = async () => {
    setBusy(true);
    try {
      const entries = Object.entries(draft)
        .filter(([, g]) => g.length)
        .map(([folder, g]) => ({ folder, genres: g }));
      const r = await adminFetch('/library/folder-genres', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entries }),
      });
      const j = await r.json().catch(() => ({})) as { purged?: number; error?: string };
      if (!r.ok) throw new Error(j.error || `failed (${r.status})`);
      notify.ok(`Folder genres saved${j.purged ? ` — ${j.purged} queued track${j.purged === 1 ? '' : 's'} dropped` : ''}`);
      setEditing(null);
      await load();
      onChanged?.();
    } catch (e) {
      notify.err(`Save failed: ${errorMessage(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!hydrated || needsAuth) return null;

  const dirty = fingerprint(draft) !== fingerprint(saved);
  const keep = untaggedOnly
    ? (n: FolderNode) => n.untagged > 0 || (draft[n.path]?.length ?? 0) > 0
    : undefined;
  const suggestions = [...new Set([...genres, ...Object.values(draft).flat()])];

  return (
    <Card
      title="Folder genres"
      sub="A track without a genre tag takes the genre of its folder, or of the nearest parent folder that has one. Genre and Any-tag rules and genre shows read it."
      right={
        <Btn sm tone="accent" onClick={() => { void save(); }} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save'}
        </Btn>
      }
    >
      {root === undefined ? (
        <SkeletonRows rows={3} />
      ) : root === null ? (
        <EmptyState
          compact
          title="No folders yet"
          description={<>Folders appear after Reconcile with Navidrome, once Navidrome reports real paths to the station.</>}
        />
      ) : (
        <div className="grid gap-3">
          {withoutPath > 0 && (
            <div className="field-hint">
              {withoutPath} track{withoutPath === 1 ? '' : 's'} have no real path — folder rules and folder genres cannot see them.
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <Input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="find a folder…"
              aria-label="find a folder"
              className="max-w-xs"
            />
            <label className="flex cursor-pointer items-center gap-2 text-[12px]">
              <input type="checkbox" checked={untaggedOnly} onChange={() => setUntaggedOnly(v => !v)} />
              <span>Only folders with untagged tracks</span>
            </label>
          </div>
          <FolderTree
            root={root}
            query={query}
            keep={keep}
            renderMeta={n => {
              const assigned = draft[n.path] ?? [];
              return (
                <span className="flex items-center gap-2">
                  {n.untagged > 0 && (
                    <span className="mono-num text-[10px] text-muted" title="tracks without a genre tag, subfolders included">
                      {n.untagged} untagged
                    </span>
                  )}
                  {editing === n.path ? (
                    <span className="w-56">
                      <ValuesInput
                        id={`fg-${encodeURIComponent(n.path)}`}
                        values={assigned}
                        onChange={v => setDraft(d => ({ ...d, [n.path]: v }))}
                        placeholder="genre, Enter to add"
                        suggestions={suggestions}
                      />
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setEditing(n.path)}
                      className="cursor-pointer border-0 bg-transparent p-0 text-[11px] text-muted hover:text-ink hover:underline"
                    >
                      {assigned.length ? assigned.join(', ') : 'set genre'}
                    </button>
                  )}
                </span>
              );
            }}
          />
        </div>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Смонтировать карточку** — в `tabs/BlockedTabContainer.tsx`

После `import { BlockRulesCard } from '../BlockRulesCard';` добавить `import { FolderGenresCard } from '../FolderGenresCard';`.

Заменить

```tsx
      <BlockRulesCard onChanged={() => { void restampBlockMarks(); }} />
```

на

```tsx
      <BlockRulesCard onChanged={() => { void restampBlockMarks(); }} />
      {/* Folder genres change what Genre rules match, so a save re-stamps the
          row marks exactly as a rule change does. */}
      <FolderGenresCard onChanged={() => { void restampBlockMarks(); }} />
```

- [ ] **Step 3: Линт веба (eslint + tsc) и тест дерева**

Run: `bash <tmp>/sw-genre-tools/push.sh && bash <tmp>/sw-genre-tools/sw-remote.sh wlint && bash <tmp>/sw-genre-tools/sw-remote.sh wtest folderTree.test.ts`
Expected: `WLINT_OK` и `all passed`. Первый `wlint` ставит зависимости веба — несколько минут. Ошибки линта в новых или правленых файлах — исправить в зеркале, `push.sh`, повторить.

- [ ] **Step 4: Checkpoint**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh checkpoint "web: Folder genres card"`

---

### Task 10: Патчи и документация — в репозиторий

**Files:**
- Modify: `station/docs/controller-changes.md` (перегенерирован)
- Modify: `station/docs/web-changes.md` (перегенерирован)
- Modify: `station/docs/controller-changes.md` (число файлов; новый раздел перед «## Чего этот патч НЕ даёт сегодня»)
- Modify: `station/docs/web-changes.md` (число файлов; новый раздел перед «## Сборка»)
- Create: `station/deploy/blocking/rule-sborki.json`, `station/deploy/blocking/folder-genres.json`

**Interfaces:**
- Consumes: клон `/tmp/sw-genre` после задач 2–9.
- Produces: патчи, накладывающиеся на чистый v1.8.0; стартовые JSON для задачи 12.

- [ ] **Step 1: Собрать патчи и проверить наложение на чистый клон**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh mkpatch`
Expected: список путей против `genre-base` — ровно файлы этого плана: 15 файлов `controller/src/…` (из них `A` — `music/folder-genres.ts`), 4 теста `controller/scripts/…` (`A`), `web/lib/folderTree.ts` и `.test.ts` (`A`), `web/components/admin/library/FolderTree.tsx` и `FolderGenresCard.tsx` (`A`), `BlockRulesCard.tsx`, `tabs/BlockedTabContainer.tsx`, `web/lib/schemas.generated.ts` (`M`); затем `controller files: <N>`, `web files: <M>`, `PATCH_CHECK_OK`. Лишний путь (кэш, лог, `node_modules`) — стоп: убрать его в клоне и повторить.

- [ ] **Step 2: Забрать патчи в репозиторий**

Run: `scp -P <ssh-port> -i <ssh-key> <ssh-user>@<station-host>:/tmp/sw-genre-tools/out-controller.patch <repo>/station/docs/controller-changes.md && scp -P <ssh-port> -i <ssh-key> <ssh-user>@<station-host>:/tmp/sw-genre-tools/out-web.patch <repo>/station/docs/web-changes.md && grep -c "^diff --git" <repo>/station/docs/controller-changes.md <repo>/station/docs/web-changes.md`
Expected: числа совпадают с `controller files` / `web files` из шага 1.

- [ ] **Step 3: Стартовые JSON**

`station/deploy/blocking/rule-sborki.json`:

```json
{
  "label": "Сборки — дубли",
  "field": "folder",
  "values": ["<music-mount>/Сборки"]
}
```

`station/deploy/blocking/folder-genres.json`:

```json
{
  "entries": [
    { "folder": "<music-mount>/Unsorted/!Помойка русская", "genres": ["Поп"] },
    { "folder": "<music-mount>/Unsorted/!Помойка Русский Рок", "genres": ["Рок"] },
    { "folder": "<music-mount>/Unsorted/!Помойка зарубежная", "genres": ["Pop", "Rock"] },
    { "folder": "<music-mount>/Unsorted/Classic", "genres": ["Classical"] },
    { "folder": "<music-mount>/Unsorted/СЛОТ - ОркестрА", "genres": ["Рок"] }
  ]
}
```

- [ ] **Step 4: README контроллера**

В строке «Начинался с одного файла в 20 строк, на 2026-09-23 в нём 27 файлов» заменить дату и число на текущие (число — из шага 2). Перед заголовком `## Чего этот патч НЕ даёт сегодня` вставить:

```markdown
## Блокировка по жанру папки и правило Folder

Девятая правка патча (спека —
[блокировка по жанрам и папкам](../specs/2026-09-23-station-genre-folder-blocking-design.md)).
Вкладка **Admin → Library → Blocked** умела запрещать жанр, но только латинский:
`normGenre` выбрасывал всё, кроме `a-z0-9`, «Рок» становился пустой строкой, и
правило «Genre: Рок» не блокировало ничего — со счётчиком 0 и без ошибки. Тем же
страдали жанровые передачи. Треки без жанра (1297 из 4631 для станции) под жанровые
правила не попадали вовсе, а запретить папку было нечем.

| Где | Что |
|---|---|
| `music/show-filter.ts` | `normGenre` и граница слова — буквы и цифры любого письма (`\p{L}\p{N}`); `trackGenres` без тега берёт жанр папки; `trackPath` |
| `music/subsonic.ts` | `resolveGenreName` берёт тот же `normGenre`, а не свою латинскую копию |
| `music/folder-genres.ts` (новый) | таблица «папка → жанры» в `state/folder-genres.json`, помощники путей, агрегат дерева папок |
| `schemas/blocklist.ts`, `music/blocklist-rules.ts` | поле правила `folder`; значения — абсолютные пути до 512 символов (имена по-прежнему до 64) |
| `music/library-db/*` | колонка `tracks.path` (миграция 21): пишется только абсолютный путь и поддельным не затирается |
| `tag-library/flags.ts`, `analyze-library.ts`, `library.ts`, `routes/library.ts` | путь передаётся при записи строки и отдаётся в проекциях |
| `routes/library.ts` | `GET /library/folders`, `GET`/`PUT /library/folder-genres` |
| `server.ts` | `folderGenres.load()` рядом с `blocklist.load()` |

**Путь даёт флаг плеера Navidrome.** Без Report Real Path у плеера `sub-wave [node]`
Navidrome отдаёт станции поддельный путь `Артист/Альбом/Трек`, и ни правила Folder,
ни жанры папок ничего не видят. Флаг живёт в базе Navidrome, а не в конфиге: заведёт
Navidrome новую строку плеера (другой User-Agent, переустановка) — флаг будет
выключен, и на вкладке Blocked появится «N tracks have no real path». Сохранённые
пути при этом не пропадут: поддельный путь колонку не затирает. Включается в
Navidrome: аватар → Players → `sub-wave [node]` → Report Real Path.

**Путь абсолютный** (`<music-mount>/…`): Navidrome 0.63.2 отдаёт
`filepath.Join(LibraryPath, Path)`. Смена точки монтирования обнулит правила Folder
и жанры папок — видно по счётчикам.

**Сверка не выкидывает заблокированные треки, и это держится на одной детали.**
`iterateAllSongs` пропускает песни через фильтр блокировки, но дочерний процесс
сверки блок-лист не загружает (`blocklist.load()` вызывается только в `server.ts`) и
видит все треки. Загрузить блок-лист в дочернем процессе — значит заставить сверку
удалить строки заблокированных треков из `library.db`.

**`Other` — не жанр для станции.** Navidrome тег `Other` жанром не считает, поэтому
для станции без жанра на 4 трека больше, чем в тегах файлов.

Тесты: `scripts/genre-cyrillic.test.ts`, `scripts/library-path.test.ts`,
`scripts/folder-genres.test.ts`, `scripts/folder-rules.test.ts`.
```

- [ ] **Step 5: README веб-патча**

Фразу «Всего в патче 44 файла» заменить числом из шага 2. Перед заголовком `## Сборка` вставить:

```markdown
## Вкладка Blocked: папки деревом и жанры папок

Добавлено вместе с девятой правкой патча контроллера ([README
контроллера](../controller-changes.md), раздел «Блокировка по жанру папки»). Админка
по-прежнему не переводится — новые подписи английские, как всё вокруг.

| Где | Что |
|---|---|
| `lib/folderTree.ts` + тест | дерево из плоского списка `GET /library/folders`: цепочка `/mnt → … → Music` сворачивается в один корень, поиск оставляет совпавшие папки с путём к ним, фильтр «только с треками без тега» |
| `components/admin/library/FolderTree.tsx` | отрисовка дерева; у корня нет флажка — блок корня заглушил бы эфир |
| `components/admin/library/BlockRulesCard.tsx` | поле **Folder** с деревом вместо ввода текста; подсказки жанров — теги плюс жанры папок; `ValuesInput` экспортируется |
| `components/admin/library/FolderGenresCard.tsx` | карточка **Folder genres** — таблица «папка → жанры», сохраняется целиком |
| `components/admin/library/tabs/BlockedTabContainer.tsx` | карточка встаёт между правилами и списком блоков |
| `lib/schemas.generated.ts` | перегенерировано (`npm run gen:schemas`): поле `folder` и `RULE_PATH_MAX` |

Тест дерева — `npx tsx web/lib/folderTree.test.ts`, тем же контейнером, что тесты
чата.
```

- [ ] **Step 6: Коммит только своих путей**

Run: `git -C <repo> status --short`
Expected: среди изменённых — ровно четыре своих файла и новый каталог `station/deploy/blocking/`; чужие грязные файлы (см. Global Constraints) не трогались.

Сообщение — файлом `<tmp>\sw-genre-tools\commit-patches.txt`:

```text
Станция: блокировка по жанру папки и правило Folder — патчи

Контроллер: жанр сравнивается буквами любого письма, у трека без тега —
жанр его папки (state/folder-genres.json), новое поле правила folder,
колонка tracks.path, маршруты /library/folders и /library/folder-genres.
Веб: дерево папок в редакторе правила и карточка Folder genres.
Стартовое наполнение — station/deploy/blocking/.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
```

Run: `git -C <repo> add -- station/docs/controller-changes.md station/docs/web-changes.md station/docs/controller-changes.md station/docs/web-changes.md station/deploy/blocking`
Run: `git -C <repo> commit -F <tmp>/sw-genre-tools/commit-patches.txt -- station/docs/controller-changes.md station/docs/web-changes.md station/docs/controller-changes.md station/docs/web-changes.md station/deploy/blocking`
Expected: один коммит, `git show --stat HEAD` — только эти пути.

---

### Task 11: Navidrome, контроллер, сверка

**Files:**
- Create: `<tmp>\sw-genre-tools\navidrome_real_path.py` (одноразовый, не в репозитории)

**Interfaces:**
- Consumes: задача 10 (патчи в репозитории = клон на Debian), `NAVIDROME_ADMIN_PASS` из `<_boss>/secrets/vault.env`.
- Produces: флаг Report Real Path у плеера `sub-wave [node]`; живой контроллер с правкой; `withoutPath = 0`.

- [ ] **Step 1: Скрипт флага Navidrome** — `<tmp>\sw-genre-tools\navidrome_real_path.py`:

```python
"""Report Real Path для плеера станции в Navidrome (sub-wave [node]).

Берёт пароль из vault _boss, входит в native API Navidrome, включает флаг у
плеера, которым ходит контроллер, читает его обратно — и спрашивает у Subsonic
одну песню ОТ ИМЕНИ этого плеера (c=sub-wave, User-Agent node), печатая путь.
"""
import hashlib
import json
import secrets
import sys
import urllib.parse
import urllib.request

BASE = "http://<station-host>:4533"
PLAYER = "sub-wave [node]"
VAULT = r"<_boss>\secrets\vault.env"


def vault(key, default=None):
    with open(VAULT, encoding="utf-8") as f:
        for line in f:
            if line.startswith(key + "="):
                return line.split("=", 1)[1].strip().strip('"')
    if default is not None:
        return default
    sys.exit(f"{key} нет в vault")


def call(method, path, token=None, body=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["X-ND-Authorization"] = f"Bearer {token}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, method=method, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


user = vault("NAVIDROME_ADMIN_USER", "<admin-user>")
password = vault("NAVIDROME_ADMIN_PASS")
token = call("POST", "/auth/login", body={"username": user, "password": password})["token"]
players = call("GET", "/api/player?_start=0&_end=200", token)
match = [p for p in players if p.get("name") == PLAYER]
if len(match) != 1:
    sys.exit(f"ожидался один плеер {PLAYER!r}, есть: {[p.get('name') for p in players]}")
player = match[0]
if not player.get("reportRealPath"):
    player["reportRealPath"] = True
    call("PUT", f"/api/player/{player['id']}", token, player)
print("reportRealPath:", call("GET", f"/api/player/{player['id']}", token).get("reportRealPath"))

salt = secrets.token_hex(6)
query = urllib.parse.urlencode({
    "u": user, "t": hashlib.md5((password + salt).encode()).hexdigest(), "s": salt,
    "v": "1.16.1", "c": "sub-wave", "f": "json", "size": 1,
})
req = urllib.request.Request(f"{BASE}/rest/getRandomSongs?{query}", headers={"User-Agent": "node"})
with urllib.request.urlopen(req, timeout=20) as r:
    song = json.loads(r.read())["subsonic-response"]["randomSongs"]["song"][0]
print("path as the station sees it:", song.get("path"))
```

- [ ] **Step 2: Включить флаг и проверить путь**

Run (PowerShell): `$env:PYTHONIOENCODING='utf-8'; & 'C:\Program Files\Python314\python.exe' <tmp>\sw-genre-tools\navidrome_real_path.py`
Expected: `reportRealPath: True` и `path as the station sees it: <music-mount>/…`. Путь не абсолютный — стоп: флаг не применился к нужному плееру; включить руками (аватар → Players → `sub-wave [node]` → Report Real Path) и повторить скрипт. Старому контроллеру абсолютный путь безвреден: `MUSIC_LIBRARY_PATH` не задан, воспроизведение идёт потоком.

- [ ] **Step 3: Сверить живой контроллер с клоном**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh livediff`
Expected: отличаются **только** файлы этого плана: `music/show-filter.ts`, `music/subsonic.ts`, `music/blocklist-rules.ts`, `schemas/blocklist.ts`, `music/library-db/{schema,types,rows,tracks,queries}.ts`, `music/library.ts`, `music/analyze-library.ts`, `music/tag-library/flags.ts`, `routes/library.ts`, `server.ts` и `Only in CLONE…: folder-genres.ts`; затем `LIVEDIFF_DONE`. Любой другой файл — стоп: на проде правка, которой нет в клоне; сборка её откатит (случай 22.09 в README контроллера).

- [ ] **Step 4: Собрать и поднять контроллер**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh build-controller`
Expected: хэш образа и `CONTROLLER_UP`. Прежний образ остался под тегом `subwave-controller:1.8.0-ru-pre-genre`.

- [ ] **Step 5: Здоровье и настройки**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh health && bash <tmp>/sw-genre-tools/sw-remote.sh persona`
Expected: контейнеры `sub-wave*` в `Up`, ошибок за 5 минут нет; строка персоны та же, что до выкатки (имя, голос, `gainDb.remote`).

- [ ] **Step 6: Сверка с Navidrome — заполнить пути**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh reconcile && bash <tmp>/sw-genre-tools/sw-remote.sh folders`
Expected: `RECONCILE_DONE`, затем `withoutPath: 0` и строки:
- `…/Music/Сборки: total=866`;
- `…/Unsorted/!Помойка русская: total=242 untagged=237`;
- `…/Unsorted/!Помойка Русский Рок: total=252 untagged=6`;
- `…/Unsorted/!Помойка зарубежная: total=463 untagged=463`;
- `…/Unsorted/Classic: total=14 untagged=3`;
- `…/Unsorted/СЛОТ - ОркестрА: total=7 untagged=7`;
- `…/Unsorted/Юля Кошкина: total=26 untagged=26`.

Расхождение с этими числами (сняты с базы Navidrome 2026-09-23) — остановиться и выяснить до наполнения: либо коллекция изменилась, либо путь в JSON задачи 10 разошёлся с настоящим.

**Откат, если понадобится:** `ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'sudo docker tag subwave-controller:1.8.0-ru-pre-genre subwave-controller:1.8.0-ru && cd <deploy-dir>/subwave && sudo docker compose up -d controller'`. Лишняя колонка `path` прежнему коду не мешает.

---

### Task 12: Веб, стартовое наполнение, приёмка

**Files:**
- Create: `<tmp>\sw-genre-tools\tmp-chanson.json`, `tmp-pop.json` (одноразовые)
- Modify (только если свободны): `station/docs/deploy.md`, `CLAUDE.md`, `FINDINGS.md`

**Interfaces:**
- Consumes: задачи 10–11; `station/deploy/blocking/*.json`.
- Produces: правило «Сборки — дубли», таблица жанров папок, подтверждённые счётчики и эфир без `Сборок`.

- [ ] **Step 1: Собрать и поднять веб**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh build-web`
Expected: хэш образа и `WEB_UP`. Падение на `Turbopack is not supported … swc-linux-x64-musl` — битый кэш слоя (README веб-патча): `bash <tmp>/sw-genre-tools/sw-remote.sh build-web-nocache`.

- [ ] **Step 2: Копия состояния перед наполнением**

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh backup-state`
Expected: `backed up …` или `no … yet` для `blocklist.json` и `folder-genres.json`.

- [ ] **Step 3: Наполнение**

Run: `scp -P <ssh-port> -i <ssh-key> <repo>/station/deploy/blocking/rule-sborki.json <repo>/station/deploy/blocking/folder-genres.json <ssh-user>@<station-host>:/tmp/sw-genre-tools/`
Run: `bash <tmp>/sw-genre-tools/sw-remote.sh api POST /library/blocklist/rules /tmp/sw-genre-tools/rule-sborki.json`
Expected: JSON с `rule` (`field: "folder"`) и `purged` — сколько треков `Сборок` снято из очереди.
Run: `bash <tmp>/sw-genre-tools/sw-remote.sh api PUT /library/folder-genres /tmp/sw-genre-tools/folder-genres.json`
Expected: `entries` из пяти папок.

- [ ] **Step 4: Засечь время выкатки**

Run: `ssh -p <ssh-port> -i <ssh-key> <ssh-user>@<station-host> 'date -u +%Y-%m-%dT%H:%M:%SZ'`
Записать значение `T0` в отчёт задачи.

- [ ] **Step 5: Счётчики правил**

`<tmp>\sw-genre-tools\tmp-chanson.json` — правило-щуп, привязанное к несуществующей передаче: счётчик `matchCount` считается, а эфир оно не трогает (`active: false`, в очереди ничего не снимается):

```json
{ "label": "tmp Шансон", "field": "genre", "values": ["Шансон"], "showIds": ["__acceptance__"] }
```

`<tmp>\sw-genre-tools\tmp-pop.json`:

```json
{ "label": "tmp Поп", "field": "genre", "values": ["Поп"], "showIds": ["__acceptance__"] }
```

Run: `scp -P <ssh-port> -i <ssh-key> <tmp>/sw-genre-tools/tmp-chanson.json <tmp>/sw-genre-tools/tmp-pop.json <ssh-user>@<station-host>:/tmp/sw-genre-tools/`
Run: `bash <tmp>/sw-genre-tools/sw-remote.sh api POST /library/blocklist/rules /tmp/sw-genre-tools/tmp-chanson.json && bash <tmp>/sw-genre-tools/sw-remote.sh api POST /library/blocklist/rules /tmp/sw-genre-tools/tmp-pop.json && bash <tmp>/sw-genre-tools/sw-remote.sh rules`
Expected:
- `'Сборки — дубли' folder=['<music-mount>/Сборки'] matchCount=866 active=True`;
- `'tmp Шансон' genre=['Шансон'] matchCount=42 active=False`;
- `'tmp Поп' genre=['Поп'] matchCount=748 active=False` (511 по тегу + 237 по жанру папки).

Удалить оба щупа по их `id` из вывода:
Run: `bash <tmp>/sw-genre-tools/sw-remote.sh api DELETE /library/blocklist/rules/<id-tmp-Шансон> && bash <tmp>/sw-genre-tools/sw-remote.sh api DELETE /library/blocklist/rules/<id-tmp-Поп> && bash <tmp>/sw-genre-tools/sw-remote.sh rules`
Expected: осталось одно правило — «Сборки — дубли».

- [ ] **Step 6: Глазами — владелец**

Попросить владельца открыть админку станции → Library → **Blocked** и проверить: правило «Сборки — дубли» с числом 866; в «Add rule» есть **Folder**, дерево открывается корнем `<music-mount>`, поиск «помойка» находит три папки; карточка **Folder genres** показывает пять назначений и `Юля Кошкина` с `set genre`.

- [ ] **Step 7: Эфир без `Сборок`** (не раньше чем через 3 часа после `T0`)

Run: `bash <tmp>/sw-genre-tools/sw-remote.sh aired <T0>`
Expected: `plays` > 0, `from_sborki` = 0, `no_path` = 0.

- [ ] **Step 8: Документация в занятых файлах**

Run: `git -C <repo> status --short -- station/docs/deploy.md CLAUDE.md FINDINGS.md`

Если файл **свободен** (нет в выводе) — внести правку и закоммитить его отдельным коммитом с явным путём; если **занят** — не трогать, а текст ниже отдать владельцу в итоговом отчёте.

`station/docs/deploy.md` — раздел:

```markdown
## Блокировка по жанрам и папкам

Admin → Library → **Blocked**. Правило **Genre** понимает кириллицу; у трека без тега
жанром считается жанр его папки из карточки **Folder genres** (ближайшая папка с
назначением). Правило **Folder** снимает с эфира папку целиком, выбор — деревом.
Обе вещи видят файл только по настоящему пути, а его Navidrome отдаёт станции лишь
с флагом Report Real Path у плеера `sub-wave [node]` (аватар → Players); без флага на
вкладке висит «N tracks have no real path». После включения флага — Reconcile with
Navidrome. Стартовое наполнение — [`blocking/`](../../deploy/blocking/): правило «Сборки — дубли»
(866 треков, из них 798 — дубли треков из других папок) и жанры пяти папок.
Подробности — [README патча контроллера](../controller-changes.md).
```

`CLAUDE.md` — два пункта в «Грабли»:

```markdown
- **Жанр станции сравнивался только латиницей.** До девятой правки патча контроллера `normGenre`
  выбрасывал всё, кроме `a-z0-9`: «Рок» становился пустой строкой, правило «Genre: Рок»
  и жанровая передача «Рок» молча не делали ничего. Теперь буквы любого письма; у
  трека без тега жанр берётся из папки (Blocked → Folder genres).
- **Путь к файлу станции даёт флаг плеера Navidrome, а не конфиг.** Report Real Path
  у `sub-wave [node]` живёт в базе Navidrome; новая строка плеера придёт с выключенным
  флагом, и правила Folder с жанрами папок ослепнут — вкладка Blocked скажет «N tracks
  have no real path». Сохранённые пути поддельным не затираются.
```

`FINDINGS.md` — запись сверху (находка из этой же сессии, к задаче не относится):

```markdown
## 2026-09-23 · Передача «Любимое» не выходит в эфир [P3]
**Context:** разбор жанровых возможностей станции, `state/schedule.json` и `GET /api/schedule`.
**What:** передача `favorite_hour` («Любимое», плейлист `Favorite`, `playlistStrict: true`) заведена, но в недельной сетке у неё 0 слотов из 168 и override нет — в эфир она не выходит ни разу.
**Proposal:** решить с владельцем, в какие часы её ставить (`PUT /api/schedule`), либо удалить передачу.
**Status:** open
```

Сообщение коммита — файлом, по образцу задачи 10, с явными путями только свободных файлов.
