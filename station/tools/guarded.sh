#!/bin/bash
# Команда на хосте станции под сторожем памяти. Хост делит ОЗУ с чужими
# службами, и память кончается у него раньше, чем у cgroup контейнера
# (tsc однажды пять раз подряд уронил хост в глобальный OOM).
#   bash station/tools/guarded.sh <команда> [аргументы…]
# MemAvailable ниже MIN_AVAIL МБ (по умолчанию 500) — команда снимается, код 3:
# SIGTERM её группе процессов, через GRACE с (по умолчанию 10) — SIGKILL. Не дошёл
# ни один сигнал — код самой команды и строка «снять не удалось».
#
# Команда идёт в своей группе (setsid): sudo не пересылает команде сигнал от
# процесса из своей группы, а без setsid сторож в ней и был — `sudo docker
# build` сигнал «снятия» просто проглатывал. Процессы под sudo принадлежат root:
# сигнал группе идёт через `sudo -n kill`, а нет такого права — своими правами;
# жива ли команда, видно по /proc, а не по `kill -0` (процессу root он отвечает
# «нет прав», то есть «мёртв»).
set -u
MIN_AVAIL=${MIN_AVAIL:-500}
GRACE=${GRACE:-10}
# Скрипт не интерактивный: фоновый процесс не лидер группы, и setsid делает
# группой его самого, без лишнего fork, — $! и есть номер группы.
setsid "$@" &
pid=$!
signal() {   # $1 — сигнал всей группе команды; код 0 — доставлен
  if sudo -n kill -"$1" -- -"$pid" 2>/dev/null || kill -"$1" -- -"$pid" 2>/dev/null; then
    return 0
  fi
  echo "GUARD не удалось послать SIG$1 группе $pid — нет прав"
  return 1
}
# Ctrl+C и прочие сигналы сторожу — команде: она в другой группе и сама их
# больше не получает, а без этого пережила бы сторожа.
trap 'echo "GUARD прерван — останавливаю: $*"; signal TERM' INT TERM HUP
mem() { awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo; }
stopped=      # память кончилась, снятие начато
delivered=    # сигнал снятия дошёл до команды
hard=
low=$(mem)
sleep 0.5   # первая проверка — когда команда уже запущена, а не до её exec
while [ -e "/proc/$pid" ]; do
  avail=$(mem)
  [ "$avail" -lt "$low" ] && low=$avail
  if [ -z "$stopped" ] && [ "$avail" -lt "$MIN_AVAIL" ]; then
    echo "GUARD MemAvailable ${avail} МБ — снимаю: $*"
    stopped=$SECONDS
    signal TERM && delivered=1
  elif [ -n "$stopped" ] && [ -z "$hard" ] && [ $((SECONDS - stopped)) -ge "$GRACE" ]; then
    echo "GUARD за ${GRACE} с команда не завершилась — SIGKILL"
    hard=1
    signal KILL && delivered=1
  fi
  sleep 0.5
done
wait "$pid"; rc=$?
echo "GUARD минимум MemAvailable за прогон: ${low} МБ"
# Код 3 — только команде, которую действительно сняли: сигнал не дошёл —
# она доработала сама, и код у неё свой.
if [ -n "$delivered" ]; then echo "GUARD снято: $*"; exit 3; fi
[ -n "$stopped" ] && echo "GUARD снять не удалось — команда доработала сама, код $rc"
exit "$rc"
