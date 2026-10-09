#!/bin/bash
# Бэкап данных станции вне её хоста. Ценное лежит на одном диске хоста станции и
# нигде не копировалось: room.db (дизлайки, решения владельца, подписки),
# vapid.pem (новый ключ обесценивает все подписки браузеров), blocklist.json,
# folder-genres.json, recent-plays.json, разметка в library.db. Встроенный бэкап
# апстрима пишет в тот же state/, не берёт blocklist.json и folder-genres.json, а
# комната целиком лежит вне state/.
#
#   на хосте станции:   sudo BACKUP_STACK_DIR=<stack-dir> \
#                         BACKUP_DEST_DIR=<share>/radio/backup bash backup.sh
#   с рабочей машины:   bash station/tools/backup.sh --remote
#     скрипт уезжает на хост станции по ssh (stdin → временный файл) и
#     выполняется там под sudo; хост, SSH и BACKUP_* — из station/.env.
#     Копии на хосте нет — разойтись с репозиторием ей не с чем.
#
# Переменные:
#   BACKUP_STACK_DIR  каталог стека: .env, state/, room/
#   BACKUP_DEST_DIR   каталог архивов — приватная часть шары; должен уже быть:
#                     не смонтированная шара не подменяется локальным диском
#   BACKUP_KEEP       сколько последних архивов хранить (14 — при ежедневном
#                     запуске две недели)
#   BACKUP_PYTHON     python3 по умолчанию — снимок SQLite и проверка целостности
#
# Архив — station-backup-YYYYMMDD-HHMMSS.tar.gz, пути внутри — от каталога стека
# (./.env, ./state/…, ./room/…). Код выхода: 0 — готово; 1 — нового архива нет,
# прежние не тронуты; 2 — архив сделан, но ротация или уборка после него сорвались.
set -eu

if [ "${1:-}" = "--remote" ]; then
  HERE=$(cd "$(dirname "$0")/.." && pwd)
  set -a; . "$HERE/.env"; set +a
  for v in STATION_SSH SSH_PORT SSH_KEY BACKUP_STACK_DIR BACKUP_DEST_DIR; do
    [ -n "${!v:-}" ] || { echo "backup: не задан $v в $HERE/.env" >&2; exit 1; }
  done
  vars="BACKUP_STACK_DIR=$(printf %q "$BACKUP_STACK_DIR")"
  vars="$vars BACKUP_DEST_DIR=$(printf %q "$BACKUP_DEST_DIR")"
  vars="$vars BACKUP_KEEP=$(printf %q "${BACKUP_KEEP:-14}")"
  if [ -n "${BACKUP_PYTHON:-}" ]; then
    vars="$vars BACKUP_PYTHON=$(printf %q "$BACKUP_PYTHON")"
  fi
  # тело скрипта — целиком в файл, и только потом bash: дочерний процесс,
  # читающий stdin, иначе съел бы недочитанный хвост скрипта
  exec ssh -o BatchMode=yes -o LogLevel=ERROR -o StrictHostKeyChecking=accept-new \
    -o ConnectTimeout=10 -p "$SSH_PORT" -i "$SSH_KEY" "$STATION_SSH" \
    "f=\$(mktemp) && cat > \"\$f\" && sudo env $vars bash \"\$f\"; rc=\$?; rm -f \"\$f\"; exit \$rc" \
    < "$0"
fi

umask 077
log() { printf '%s backup: %s\n' "$(date '+%F %T')" "$*"; }
die() { log "ОШИБКА: $*" >&2; exit 1; }

STACK=${BACKUP_STACK_DIR:-}
DEST=${BACKUP_DEST_DIR:-}
KEEP=${BACKUP_KEEP:-14}
PY=${BACKUP_PYTHON:-python3}
[ -n "$STACK" ] || die "не задан BACKUP_STACK_DIR (каталог стека: .env, state/, room/)"
[ -n "$DEST" ] || die "не задан BACKUP_DEST_DIR (каталог архивов на шаре)"
case "$KEEP" in ''|*[!0-9]*) die "BACKUP_KEEP=$KEEP — нужно целое ≥ 1" ;; esac
KEEP=$((10#$KEEP))   # «014» иначе прочлось бы восьмеричным
[ "$KEEP" -ge 1 ] || die "BACKUP_KEEP=$KEEP — нужно целое ≥ 1"

# отметка до первого обращения к шаре: зависший CIFS иначе неотличим от
# прогона, который не стартовал вовсе
log "старт: $STACK → $DEST"
REQUIRED=(./.env ./state/library.db ./room/room.db ./room/vapid.pem)
for m in "${REQUIRED[@]}"; do
  [ -f "$STACK/${m#./}" ] || die "нет $STACK/${m#./} — не тот каталог стека?"
done
# абсолютный путь без обратных слешей: GNU tar раскрывает «\1» в -C как
# восьмеричный код, а путь C:\… в Git Bash (тесты на Windows) ими полон
STACK=$(cd "$STACK" && pwd)
[ -d "$DEST" ] || die "нет каталога $DEST — шара не смонтирована? (создаётся один раз руками)"

# Снимок SQLite через backup API, а не копия файла: база живая, в WAL-режиме, и
# копия файла посреди записи — битая база. Владелец и права — как у исходника:
# снимок пишет root, а распакованная база должна открываться службой.
PY_SNAPSHOT='
import os, sqlite3, sys
from pathlib import Path
src_path, dst_path = sys.argv[1], sys.argv[2]
src = sqlite3.connect(Path(src_path).resolve().as_uri() + "?mode=rw", uri=True, timeout=30)
dst = sqlite3.connect(dst_path)
src.backup(dst)
dst.close()
src.close()
st = os.stat(src_path)
os.chmod(dst_path, st.st_mode & 0o7777)
if hasattr(os, "chown") and os.geteuid() == 0:
    os.chown(dst_path, st.st_uid, st.st_gid)
'
PY_CHECK='
import sqlite3, sys
bad = 0
for path in sys.argv[1:]:
    conn = sqlite3.connect(path)
    rows = conn.execute("PRAGMA integrity_check").fetchall()
    conn.close()
    if rows != [("ok",)]:
        bad += 1
        print(f"{path}: integrity_check — {rows[:5]}", file=sys.stderr)
sys.exit(1 if bad else 0)
'

STAMP=$(date '+%Y%m%d-%H%M%S')
NAME="station-backup-$STAMP.tar.gz"
PART="$DEST/.$NAME.$$.tmp"
WORK=""
DONE=""
cleanup() {
  rc=$?
  if [ -n "$WORK" ]; then rm -rf "$WORK"; fi
  rm -f "$PART"
  [ "$rc" -ne 0 ] || return 0
  if [ -n "$DONE" ]; then
    # архив уже лежит — сбой случился в ротации или уборке после него
    log "архив сделан ($DONE), но после него сбой (код $rc) — ротация или уборка не закончены" >&2
    exit 2
  fi
  log "архив не сделан (код $rc), прежние архивы не тронуты" >&2
  exit 1
}
trap cleanup EXIT

# Временное — в каталоге стека, а не в /tmp: на хосте станции /tmp — tmpfs, и
# снимки баз ели бы ОЗУ; на шаре же SQLite писать нельзя (CIFS и блокировки).
# Каталоги убитых прогонов (trap не успел) убираются по якорному имени, свежий
# может принадлежать соседнему прогону.
for d in "$STACK"/.station-backup-work.*; do
  [[ "${d##*/}" =~ ^\.station-backup-work\.[A-Za-z0-9]{6}$ ]] || continue
  [ -d "$d" ] || continue
  [ -n "$(find "$d" -maxdepth 0 -mmin +60)" ] || continue
  rm -rf -- "$d"
  log "удалён временный каталог убитого прогона: ${d##*/}"
done
WORK=$(mktemp -d "$STACK/.station-backup-work.XXXXXX")

SNAP="$WORK/snap"
mkdir -p "$SNAP/state" "$SNAP/room"
"$PY" -c "$PY_SNAPSHOT" "$STACK/state/library.db" "$SNAP/state/library.db"
"$PY" -c "$PY_SNAPSHOT" "$STACK/room/room.db" "$SNAP/room/room.db"
cp -p "$STACK/.env" "$SNAP/.env"
cp -p "$STACK/room/vapid.pem" "$SNAP/room/vapid.pem"
# в архив — только файлы: запись каталога унесла бы режим временного каталога
# (700, root), и распаковка поверх стека переписала бы права state/ и самого стека
FILES=("${REQUIRED[@]}")
n=0
for f in "$STACK"/state/*.json "$STACK"/state/*.env; do
  [ -f "$f" ] || continue
  case "${f##*/}" in
    # маркеры эфира (тот же перечень, что апстрим чистит при смене станции):
    # восстановленные, они выдали бы вчерашний трек за текущий
    *-playing.json|pause-talk-*.json|music-starved.json) continue ;;
  esac
  cp -p "$f" "$SNAP/state/"
  FILES+=("./state/${f##*/}")
  n=$((n + 1))
done

# --force-local: путь вида C:\… GNU tar иначе принимает за host:path
tar --force-local -czf "$PART" -C "$SNAP" --no-recursion "${FILES[@]}"

# проверка распаковки: список читается целиком (битый gzip падает здесь), базы
# распаковываются отдельно и проходят integrity_check на копии
LIST=$(tar --force-local -tzf "$PART")
for m in "${REQUIRED[@]}"; do
  case "
$LIST
" in
    *"
$m
"*) ;;
    *) die "в архиве нет $m" ;;
  esac
done
mkdir "$WORK/check"
tar --force-local -xzf "$PART" -C "$WORK/check" ./state/library.db ./room/room.db
"$PY" -c "$PY_CHECK" "$WORK/check/state/library.db" "$WORK/check/room/room.db" \
  || die "снимок базы не прошёл integrity_check"

# на CIFS права задаёт монтирование, chmod там бывает пустым или запрещён —
# доступ к архиву тогда держит приватность самой шары
chmod 600 "$PART" 2>/dev/null || log "chmod 600 не применился — доступ к архиву определяют права шары"
mv -f "$PART" "$DEST/$NAME"
DONE="$DEST/$NAME"
log "архив: $DEST/$NAME ($(wc -c < "$DEST/$NAME") байт; state: $n файлов + library.db)"

# Ротация — только своих архивов, по якорному имени: в каталоге могут лежать
# чужие файлы, и удалять можно лишь то, что записал сам. Имя несёт время, поэтому
# порядок glob — хронологический; новый архив последний и под удаление не попадает.
own=()
for f in "$DEST"/station-backup-*.tar.gz; do
  [[ "${f##*/}" =~ ^station-backup-[0-9]{8}-[0-9]{6}\.tar\.gz$ ]] && own+=("$f")
done
excess=$((${#own[@]} - KEEP))
for ((i = 0; i < excess; i++)); do
  rm -f -- "${own[$i]}"
  log "удалён старый: ${own[$i]##*/}"
done
# недописанные архивы прогонов, убитых до trap; свежий может писать соседний прогон
for f in "$DEST"/.station-backup-*.tmp; do
  [[ "${f##*/}" =~ ^\.station-backup-[0-9]{8}-[0-9]{6}\.tar\.gz\.[0-9]+\.tmp$ ]] || continue
  [ -n "$(find "$f" -maxdepth 0 -mmin +60)" ] || continue
  rm -f -- "$f"
  log "удалён недописанный: ${f##*/}"
done
log "готово, хранится архивов: $((${#own[@]} < KEEP ? ${#own[@]} : KEEP))"
