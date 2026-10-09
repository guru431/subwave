#!/bin/bash
# Тесты контроллера subwave — в собранном образе, без `npm ci` на каждый прогон.
#
# Образ subwave-controller уже несёт node_modules (`npm ci --omit=dev` в
# Dockerfile.controller), а раннеру тестов (tsx + `node --test`) devDependencies
# не нужны. Прежний способ — `npm ci` в свежем node:22 на каждый прогон — стоил
# до 8–12 минут и на хосте станции, где памяти впритык, задевал соседние службы.
#
# Запуск — с рабочей машины (Git Bash), тесты идут на хосте станции по ssh:
#   run-tests.sh                        весь набор в образе (~130 с)
#   run-tests.sh --patch                тесты, тронутые нашими коммитами поверх UPSTREAM_BASE
#   run-tests.sh request-window         файлы, в имени которых есть подстрока
#   run-tests.sh --src /home/<user>/radio  клон на хосте поверх образа (после push-to-station.sh)
#   run-tests.sh --image subwave-controller:1.17.0   другой тег
#
# Падения из KNOWN (с --src — из KNOWN_SRC) ниже — среда образа и апстрим, к нашим
# коммитам отношения не имеют (эталон — чистый v1.17.0). Код 1 — есть падения вне
# списка. Итог печатается строкой TESTS_RESULT для ClaudeTestSweep.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)          # station/
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
# Хост станции и SSH — из station/.env (шаблон — station/.env.example).
if [ ! -f "$HERE/.env" ]; then echo "TESTS_ENV нет $HERE/.env (шаблон — .env.example)"; exit 2; fi
set -a; . "$HERE/.env"; set +a
# Версия апстрима под main: --patch берёт тесты, тронутые нашими коммитами
# поверх неё. Меняется вместе с переходом на новую версию апстрима.
UPSTREAM_BASE=v1.17.0
IMAGE=subwave-controller:1.17.0-ru
SRC=-
FILTERS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --patch)
      mapfile -t patch_tests < <(git -C "$REPO" diff --name-only "$UPSTREAM_BASE"...HEAD \
        -- 'controller/scripts/*.test.ts' | sed 's#.*/##' | sort -u)
      if [ ${#patch_tests[@]} -eq 0 ]; then
        echo "TESTS_ENV наши коммиты не трогают controller/scripts поверх $UPSTREAM_BASE"; exit 2
      fi
      FILTERS+=("${patch_tests[@]}"); shift ;;
    --src) SRC=$2; shift 2 ;;
    --image) IMAGE=$2; shift 2 ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) FILTERS+=("$1"); shift ;;
  esac
done

# Падение — «файл» (тест-скрипт или модуль упал целиком) или «файл :: тест»
# (node:test); шаблоны сопоставляются как в `case`. «файл :: *» — только для
# файла, где падает КАЖДЫЙ тест: в файле, где падает часть, остальные гоняют код
# форка (queue.ts, artist-guard.ts, routes/settings/core.ts), и «:: *» засчитал бы
# известной и их регрессию.
#
# KNOWN_SRC — падения и с --src: зависимостей нет в самом образе, а node_modules
# клон берёт из него же.
KNOWN_SRC=(
  # Нужен typescript — devDependency, в образ (`--omit=dev`) не входит.
  "gen-schemas.test.ts"
  # vocal_gate_test.py требует python-зависимостей анализатора, которых в образе
  # контроллера нет.
  "analyzer-python.test.ts"
)
KNOWN=(
  # Без --src: KNOWN_SRC плюс среда образа. В образе нет каталогов репозитория
  # (web/, docker/, liquidsoap/, scripts/*.sh, docker-compose*.yml), а тесты
  # читают их или импортируют модули web/; с --src они проходят.
  #
  # Эталон — чистый v1.17.0: файлы сняты прогоном в образе 2026-10-05, точные
  # имена вместо «:: *» — 2026-10-09 эмуляцией образа на рабочей машине (только
  # то, что копирует Dockerfile.controller) и чтением самих тестов: падают ровно
  # те test(), что читают названные каталоги. settings-talk-placement-route на
  # Windows падает ещё и целиком (EBUSY при удалении library.db) — в образе
  # Linux этого нет, имена сняты по коду.
  #
  # Файл целиком: падает код модуля на верхнем уровне (импорт web/, чтение
  # docker/ или radio.liq). test(), объявленные до места падения, идут и
  # сверяются по именам (max-listeners, trusted-proxies — по шесть,
  # jingle-play — три); объявленные после в образе не регистрируются вовсе, их
  # проверяет только --src (jingle-play — семь, все про ротацию джинглов в
  # queue.ts).
  "aio-analyzer-heavy.test.ts"
  "aio-analyzer-replicas.test.ts"
  "aio-log-link.test.ts"
  "jingle-play.test.ts"
  "max-listeners.test.ts"
  "observatory-genres.test.ts"
  "playlists-cap.test.ts"
  "show-filter-cap.test.ts"
  "state-bootstrap.test.ts"
  "station-clock-format.test.ts"
  "trusted-proxies.test.ts"
  # Каждый тест файла читает отсутствующее — «:: *» допустим.
  "analyzer-replicas-compose.test.ts :: *"
  "dissolve-wash-shape.test.ts :: *"
  "show-candidate-display.test.ts :: *"
  "stream-buffer-renderers.test.ts :: *"
  # Падает часть файла — только эти тесты.
  "gemini-tts-settings.test.ts :: the web field ceiling agrees with the engine and the save path"
  "gemini-tts.test.ts :: gemini is offered as a Cloud provider, not as a peer engine card"
  "gemini-tts.test.ts :: the engine <-> provider mapping is exact in both directions"
  "gemini-tts.test.ts :: gemini's badge reads the engine flag, not cloudByProvider"
  "gemini-tts.test.ts :: Gemini is offered as a provider card, not as its own engine card"
  "gemini-tts.test.ts :: a persona on Gemini gets ONE voice field, shaped like the cloud one"
  "gemini-tts.test.ts :: a Gemini persona is never labelled piper"
  "gemini-tts.test.ts :: the Gemini voice list lives beside the cloud ones, once"
  "gemini-tts.test.ts :: the station Voice panel offers model, voice and pronunciation"
  "gemini-tts.test.ts :: the cloud-only panel content is gated on the selection, not removed"
  "gemini-tts.test.ts :: both panels derive the Gemini selection from the one stored engine id"
  "settings-talk-placement-route.test.ts :: DJ behaviour segmented controls expose their visible labels and help text"
  "settings-talk-placement-route.test.ts :: DJ recap controls hydrate, save and display nested validation errors"
  "show-boundary-drain.test.ts :: a boundary cut is a plain crossfade — every gesture stands down"
  "skill-schema.test.ts :: the mirror carries the skill schema to the browser"
  "transition-effects.test.ts :: the admin form names the same six gestures the controller does"
  "${KNOWN_SRC[@]}"
)
# Клон монтируется целиком — среды образа в падениях нет.
[ "$SRC" = "-" ] || KNOWN=("${KNOWN_SRC[@]}")
# Не запускаются вовсе: нагрузочный тест сеет 200 тыс. треков в базу на 820 МБ
# и идёт дольше двух минут — хосту станции такой прогон не по карману.
SKIP_FILES="observatory-scale.test.ts"

# Удалённая часть: docker run со сторожем памяти и потолком времени.
# $1 — образ, $2 — клон или «-», $3 — SKIP_FILES, дальше — подстроки имён файлов.
read -r -d '' REMOTE <<'EOF'
set -u
IMAGE=$1; SRC=$2; SKIP=$3; shift 3
LIMIT=900          # потолок прогона целиком, с
MIN_AVAIL=500      # МБ MemAvailable хоста, ниже — прогон снимается
if ! sudo docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "TESTS_ENV на хосте станции нет образа $IMAGE"; exit 2
fi
if [ "$SRC" = "-" ]; then
  MOUNT=(); ENV=(); WD=/app
else
  if [ ! -d "$SRC/controller/scripts" ]; then echo "TESTS_ENV на хосте станции нет клона $SRC"; exit 2; fi
  # Зависимости клона — из образа: ссылка висит на хосте и оживает в контейнере.
  [ -e "$SRC/controller/node_modules" ] || [ -L "$SRC/controller/node_modules" ] \
    || ln -s /app/node_modules "$SRC/controller/node_modules"
  # Клон — только для чтения, а состояние по умолчанию ложится в <репо>/state.
  MOUNT=(-v "$SRC:/sw:ro"); ENV=(-e STATE_DIR=/tmp/state); WD=/sw/controller
fi
name=ctl-tests-$$
# client-ip запускает `tsx` из PATH, как это делает `npm test`.
sudo docker run --rm --name "$name" --memory 1500m --memory-swap 1500m \
  -e "PATH=$WD/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  "${MOUNT[@]}" "${ENV[@]}" -w "$WD" "$IMAGE" sh -c '
    skip=$1; shift
    files=""
    for f in scripts/*.test.ts; do
      n=${f#scripts/}
      case " $skip " in *" $n "*) continue ;; esac
      if [ $# -eq 0 ]; then files="$files $f"; continue; fi
      for p in "$@"; do case "$n" in *"$p"*) files="$files $f"; break ;; esac; done
    done
    [ -n "$files" ] || { echo "TESTS_ENV ни один файл не подходит под: $*"; exit 2; }
    exec node --import tsx --test --test-concurrency=1 --test-reporter=spec \
      --test-timeout=120000 $files' sh "$SKIP" "$@" </dev/null &
pid=$!
start=$SECONDS
killed=
# Жив ли прогон — по /proc, а не `kill -0`: $pid — процесс sudo, он принадлежит
# root, и `kill -0` отвечает «нет прав» — цикл кончался с первой же проверки, а
# сторож памяти и потолок времени не работали вовсе (как в tools/guarded.sh).
while [ -e "/proc/$pid" ]; do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  if [ -z "$killed" ] && [ "$avail" -lt "$MIN_AVAIL" ]; then
    echo "TESTS_ENV на хосте станции MemAvailable ${avail} МБ — прогон снят сторожем"
    sudo docker kill "$name" >/dev/null 2>&1; killed=1
  fi
  if [ -z "$killed" ] && [ $((SECONDS - start)) -gt "$LIMIT" ]; then
    echo "TESTS_TIMEOUT controller: прогон дольше ${LIMIT} с after=${LIMIT}s"
    sudo docker kill "$name" >/dev/null 2>&1; killed=1
  fi
  sleep 0.5
done
wait "$pid"
EOF

out=$(mktemp)
trap 'rm -f "$out"' EXIT
# Кавычки вокруг SKIP_FILES — для удалённой оболочки: ssh склеивает аргументы в
# одну строку, и без них $3 там — только первое имя (проверено 2026-10-04).
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$SSH_PORT" -i "$SSH_KEY" "$STATION_SSH" \
  bash -s -- "$IMAGE" "$SRC" "'$SKIP_FILES'" "${FILTERS[@]}" <<<"$REMOTE" | tee "$out"
rc=${PIPESTATUS[0]}

grep -qE '^TESTS_(ENV|TIMEOUT) ' "$out" && exit "$rc"
if ! grep -q '^ℹ tests ' "$out"; then
  exit $(( rc == 0 ? 1 : rc ))    # сводки нет — прогон не дошёл до конца
fi

# Ключи падений из сводки `failing tests:`; с аргументом timeout — только
# снятые по --test-timeout.
failures() {
  awk -v mode="$1" '
    /^✖ failing tests:/ { on = 1; next }
    !on { next }
    /^test at / { f = $3; sub(/:[0-9]+:[0-9]+$/, "", f); sub(/.*\//, "", f); next }
    /^✖ / {
      t = $0; sub(/^✖ /, "", t); sub(/ \([0-9.]+ms\)$/, "", t)
      b = t; sub(/.*\//, "", b)
      key = (b == f) ? f : f " :: " t
      if (mode == "timeout") last = key; else print key
      next
    }
    mode == "timeout" && /test timed out after/ && last != "" { print last; last = "" }
  ' "$out" | LC_ALL=C sort -u
}
is_known() {
  local p
  # Пункты KNOWN — шаблоны case (`файл :: *`): раскрытие без кавычек намеренное.
  # shellcheck disable=SC2254
  for p in "${KNOWN[@]}"; do case "$1" in $p) return 0 ;; esac; done
  return 1
}
count() { grep -m1 "^ℹ $1 " "$out" | awk '{print $3} END {if (NR == 0) print 0}'; }

new=(); known=0
while IFS= read -r key; do
  [ -n "$key" ] || continue
  if is_known "$key"; then known=$((known + 1)); else new+=("$key"); fi
done < <(failures all)

echo
[ "$known" -gt 0 ] && echo "Известных падений (среда образа, апстрим): $known"
if [ ${#new[@]} -gt 0 ]; then
  echo "НОВЫЕ падения (${#new[@]}):"
  printf '  %s\n' "${new[@]}"
fi
while IFS= read -r key; do
  [ -n "$key" ] && echo "TESTS_TIMEOUT $key after=120s"
done < <(failures timeout)
echo "TESTS_RESULT pass=$(count pass) fail=${#new[@]} skip=$(( $(count skipped) + $(count todo) + known ))"
[ ${#new[@]} -eq 0 ]
