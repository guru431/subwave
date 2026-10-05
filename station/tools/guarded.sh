#!/bin/bash
# Команда на хосте станции под сторожем памяти. Хост делит ОЗУ с чужими
# службами, и память кончается у него раньше, чем у cgroup контейнера
# (tsc однажды пять раз подряд уронил хост в глобальный OOM).
#   bash station/tools/guarded.sh <команда> [аргументы…]
# MemAvailable ниже MIN_AVAIL МБ (по умолчанию 500) — команда снимается, код 3.
set -u
MIN_AVAIL=${MIN_AVAIL:-500}
"$@" &
pid=$!
killed=
low=999999
while kill -0 "$pid" 2>/dev/null; do
  avail=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
  [ "$avail" -lt "$low" ] && low=$avail
  if [ -z "$killed" ] && [ "$avail" -lt "$MIN_AVAIL" ]; then
    echo "GUARD MemAvailable ${avail} МБ — снято: $*"
    kill "$pid"; killed=1
  fi
  sleep 0.5
done
wait "$pid"; rc=$?
echo "GUARD минимум MemAvailable за прогон: ${low} МБ"
[ -n "$killed" ] && exit 3
exit "$rc"
