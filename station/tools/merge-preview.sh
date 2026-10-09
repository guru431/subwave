#!/bin/bash
# Репетиция слияния апстрима — до его релиза: какие файлы дадут конфликт и какие
# коммиты апстрима их тронули. Ничего не меняет: ни рабочего дерева, ни индекса,
# ни ref-ов (`git merge-tree --write-tree` пишет только объекты в базу).
#   bash station/tools/merge-preview.sh [ЦЕЛЬ] [НАША]   по умолчанию upstream/develop и HEAD
# Сеть не трогает: свежесть цели — за `git fetch upstream --tags` перед запуском.
# Код выхода: 0 — конфликтов нет, 1 — есть, 2 — нет цели или сбой git.
set -eu
# Любой упавший git (merge-base без общей базы — 1, неизвестная ревизия — 128)
# выходит кодом 2: код 1 обещан «конфликтам», и сбой не должен за них сойти.
trap 'echo "сбой git (нет ревизии или общей базы) — код 2" >&2; exit 2' ERR
TARGET=${1:-upstream/develop}
OURS=${2:-HEAD}
REPO=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
g() { git -C "$REPO" "$@"; }
if ! g rev-parse -q --verify "$TARGET^{commit}" >/dev/null; then
  echo "нет $TARGET — сначала: git fetch upstream --tags"; exit 2
fi
base=$(g merge-base "$OURS" "$TARGET")
echo "цель: $TARGET @ $(g log -1 --format='%h от %cs' "$TARGET") — свежая ли, решает git fetch upstream --tags"
echo "база: $(g describe --tags --always "$base")"
# --name-only: первая строка — OID дерева, дальше — имена файлов с конфликтом.
rc=0
out=$(g merge-tree --write-tree --name-only --no-messages "$OURS" "$TARGET") || rc=$?
if [ "$rc" -eq 0 ]; then echo "конфликтов нет"; exit 0; fi
if [ "$rc" -ne 1 ]; then printf '%s\n' "$out"; exit 2; fi
mapfile -t files < <(printf '%s\n' "$out" | tail -n +2 | sed '/^$/d' | sort -u)
echo "файлов с конфликтом: ${#files[@]}"
for f in "${files[@]}"; do
  echo
  echo "== $f — коммиты апстрима после базы:"
  g log --format='   %h %cs %s' "$base..$TARGET" -- "$f"
done
exit 1
