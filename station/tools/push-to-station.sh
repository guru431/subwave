#!/bin/bash
# Ревизия radio — на хост станции без доступа к приватному origin:
# git bundle → scp → fetch в ~/radio; рабочее дерево там — ровно эта ревизия.
# Клон на хосте руками не правится: следующий вызов затрёт правки (checkout -f).
#   station/tools/push-to-station.sh [РЕВИЗИЯ]       по умолчанию HEAD
# Хост и SSH — из station/.env.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
REPO=$(git -C "$HERE" rev-parse --show-toplevel)
set -a; . "$HERE/.env"; set +a
SHA=$(git -C "$REPO" rev-parse "${1:-HEAD}^{commit}")
# Ревизия едет в бандле своим ref-ом: достижимая только из detached HEAD или
# remote-tracking ref в `--branches --tags` не попала бы, и checkout упал бы.
# Имя ref-а и бандла на хосте — своё у каждого запуска (pid и ревизия): два
# параллельных вызова иначе подменяли и удаляли бы их друг у друга. Сам клон
# ~/radio общий — из двух одновременных доставок в нём остаётся последняя.
ID=$$-$(printf %.12s "$SHA")
REF=refs/push-to-station/$ID
BUNDLE=radio-$ID.bundle
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"; git -C "$REPO" update-ref -d "$REF" 2>/dev/null || true' EXIT
git -C "$REPO" update-ref "$REF" "$SHA"
git -C "$REPO" bundle create "$TMP/radio.bundle" --branches --tags "$REF" 2>/dev/null
scp -q -o BatchMode=yes -P "$SSH_PORT" -i "$SSH_KEY" "$TMP/radio.bundle" "$STATION_SSH:$BUNDLE"
# Бандл на хосте удаляется при любом исходе: сбой fetch или checkout оставлял его
# в домашнем каталоге.
ssh -o BatchMode=yes -o ConnectTimeout=10 -p "$SSH_PORT" -i "$SSH_KEY" "$STATION_SSH" "set -e
  trap 'rm -f ~/$BUNDLE' EXIT
  [ -d ~/radio/.git ] || git init -q ~/radio
  cd ~/radio
  git fetch -q --tags ~/$BUNDLE '+refs/heads/*:refs/remotes/bundle/*' '$REF'
  git checkout -q -f --detach $SHA
  git clean -q -fd
  echo \"station: ~/radio @ \$(git rev-parse --short HEAD)\""
