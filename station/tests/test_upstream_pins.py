"""Сверка с апстримом: наш Caddyfile и пины версии не отстали от влитого тега.

Только чтение файлов репозитория. После `git merge vX.Y.Z` тест падает, пока
не перенесены Caddyfile и теги, — это и есть напоминание
(station/docs/controller-changes.md, «Обновление апстрима»).
"""
import json
import re
from pathlib import Path

STATION = Path(__file__).resolve().parent.parent
REPO = STATION.parent


def _upstream_version() -> str:
    return json.loads((REPO / ".release-please-manifest.json").read_text(encoding="utf-8"))["."]


def test_caddyfile_is_upstream_plus_the_room_route():
    up = (REPO / "docker" / "Caddyfile").read_text(encoding="utf-8").splitlines()
    ours = (STATION / "deploy" / "caddy" / "Caddyfile").read_text(encoding="utf-8").splitlines()
    # Шапка форка — комментарии до первой строки файла апстрима.
    start = ours.index(up[0])
    assert all(line.startswith("#") for line in ours[:start]), ours[:start]
    body = ours[start:]
    # Добавка ровно одна: комментарий «# Room — …», блок handle_path /room/* и
    # пустая строка после него.
    head = next(n for n, line in enumerate(body) if line.strip().startswith("# Room — "))
    end = body.index("\t\treverse_proxy room:8080", head) + 1
    assert body[end] == "\t}" and body[end + 1] == "", body[head:end + 2]
    del body[head:end + 2]
    assert body == up


def test_version_pins_follow_the_merged_upstream_tag():
    v = _upstream_version()
    run_tests = (STATION / "run-tests.sh").read_text(encoding="utf-8")
    assert re.findall(r"^UPSTREAM_BASE=(\S+)$", run_tests, re.M) == [f"v{v}"]
    assert re.findall(r"^IMAGE=(\S+)$", run_tests, re.M) == [f"subwave-controller:{v}-ru"]
    override = (STATION / "deploy" / "docker-compose.override.yml").read_text(encoding="utf-8")
    images = re.findall(r"^\s+image:\s*(subwave-(?:controller|web)):(\S+)$", override, re.M)
    assert sorted(images) == [("subwave-controller", f"{v}-ru"), ("subwave-web", f"{v}-ru")]
