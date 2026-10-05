#!/usr/bin/env python3
"""Обезличивание текстов перед коммитом в публичный форк.

    python station/tools/sanitize.py FILE...            # заменить на месте
    python station/tools/sanitize.py --check FILE...    # только показать остатки

Карта — `.sanitize-map.json` в корне репозитория (вне git): {"реальное": "плейсхолдер"}.
Замена без учёта регистра, длинные ключи первыми; ключ, начинающийся или
кончающийся цифрой, не ловится внутри другого числа (`10.0.0.1` ≠ `10.0.0.10`).
Остаток — ключ карты или строка `.sanitize-patterns` (ERE, без учёта регистра),
найденные после замены. Их правят руками: склонения фамилий, значения в коде,
которым нужна переменная окружения, а не плейсхолдер.
Код выхода: 0 — остатков нет, 1 — есть, 2 — нет карты.
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BOM = b"\xef\xbb\xbf"


def compile_map(pairs: dict[str, str]) -> list[tuple[re.Pattern, str]]:
    rules = []
    for real in sorted(pairs, key=len, reverse=True):
        pattern = re.escape(real)
        if real[:1].isdigit():
            pattern = r"(?<![0-9])" + pattern
        if real[-1:].isdigit():
            pattern += r"(?![0-9])"
        rules.append((re.compile(pattern, re.IGNORECASE), pairs[real]))
    return rules


def load_patterns(path: Path) -> list[re.Pattern]:
    if not path.is_file():
        return []
    lines = (s.strip() for s in path.read_text(encoding="utf-8").splitlines())
    return [re.compile(s, re.IGNORECASE) for s in lines if s and not s.startswith("#")]


def sanitize_text(text: str, rules) -> str:
    for pattern, placeholder in rules:
        text = pattern.sub(lambda _m, p=placeholder: p, text)
    return text


def residuals(text: str, rules, patterns) -> list[tuple[int, str]]:
    checks = [p for p, _ in rules] + list(patterns)
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        for pattern in checks:
            m = pattern.search(line)
            if m:
                found.append((n, m.group(0)))
    return found


def process(path: Path, rules, patterns, check: bool) -> list[str]:
    raw = path.read_bytes()
    if b"\0" in raw:
        return []          # двоичный файл: такие в git не идут вовсе (.github-push-deny)
    bom = raw.startswith(BOM)
    text = raw[len(BOM):].decode("utf-8") if bom else raw.decode("utf-8")
    new = text if check else sanitize_text(text, rules)
    if new != text:
        path.write_bytes((BOM if bom else b"") + new.encode("utf-8"))
    return [f"{path}:{n}: {hit}" for n, hit in residuals(new, rules, patterns)]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="обезличивание текстов для публичного форка")
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--check", action="store_true", help="не менять, только показать остатки")
    ap.add_argument("--map", type=Path, default=ROOT / ".sanitize-map.json")
    ap.add_argument("--patterns", type=Path, default=ROOT / ".sanitize-patterns")
    args = ap.parse_args(argv)
    if not args.map.is_file():
        print(f"нет карты {args.map}", file=sys.stderr)
        return 2
    rules = compile_map(json.loads(args.map.read_text(encoding="utf-8")))
    patterns = load_patterns(args.patterns)
    hits = []
    for f in args.files:
        hits += process(f, rules, patterns, args.check)
    for h in hits:
        print(h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
