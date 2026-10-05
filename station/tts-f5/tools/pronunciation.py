r"""Словарь произношения латиницы коллекции для F5 (f5_text.cyrillize).

    pronunciation.py export --db data/catalog.db --out DIR [--parts 4]
    pronunciation.py build --dir DIR [--out deploy/tts-f5/pronunciation.json]

export выгружает латинских исполнителей и названия песен (с исполнителем как
подсказкой языка) в DIR/in-*.json. Транскрипцию делает LLM: на каждый in-K.json —
DIR/out-K.json вида [{"id", "ru"}], русскими буквами с «+» перед ударной гласной
(28.09 это делали четыре субагента Claude, правила — в README службы). build
проверяет ответы, выводит из пар «фраза → транскрипция» словарь слов и пишет
pronunciation.json; запись, не прошедшая проверку, в словарь не попадает.

Новые исполнители в коллекции — повторить оба шага: словарь пересобирается целиком.
"""
import argparse
import json
import re
import sqlite3
import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from f5_text import VOWELS, dictionary_key  # noqa: E402

LATIN = re.compile(r"[A-Za-z]")
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
# Знаки по краям слова, которые словарь слов не хранит: «(Live)» → «Live»
EDGE = "()[]{}«»\"'’.,!?:;"


def export(db: Path, out: Path, parts: int) -> int:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    rows = conn.execute("select artist, title from tracks order by artist, title").fetchall()
    items, seen = [], set()
    for artist, _ in rows:
        if artist and LATIN.search(artist) and dictionary_key(artist) not in seen:
            seen.add(dictionary_key(artist))
            items.append({"src": artist.strip(), "ctx": "исполнитель"})
    for artist, title in rows:
        if title and LATIN.search(title) and dictionary_key(title) not in seen:
            seen.add(dictionary_key(title))
            items.append({"src": title.strip(), "ctx": f"песня исполнителя {artist or '?'}"})
    for i, item in enumerate(items):
        item["id"] = i
    out.mkdir(parents=True, exist_ok=True)
    size = -(-len(items) // parts)
    for k in range(parts):
        (out / f"in-{k + 1}.json").write_text(
            json.dumps(items[k * size:(k + 1) * size], ensure_ascii=False, indent=0),
            encoding="utf-8")
    return len(items)


def tidy(ru: str) -> str:
    """Механические огрехи ответов LLM, которые правятся без догадок (28.09):
    «+» перед мягким знаком («М+ьюзик» → «Мь+юзик») и слова, слипшиеся через
    запятую («Т+айлер,П+эрри»)."""
    ru = re.sub(f"\\+([ьъЬЪ])([{VOWELS}])", r"\1+\2", ru)
    return re.sub(r",(?=[^\s\d])", ", ", ru)


def problem(ru: str) -> str | None:
    """Почему транскрипция не годится; None — годится."""
    if not ru or not ru.strip():
        return "пусто"
    if LATIN.search(ru):
        return "осталась латиница"
    if re.search(f"\\+(?![{VOWELS}])", ru):
        return "«+» не перед гласной"
    if any(w.count("+") > 1 for w in ru.split()):
        return "два «+» в одном слове"
    return None


def _strip(word: str) -> str:
    return word.strip(EDGE)


def derive_words(pairs) -> dict[str, str]:
    """Словарь слов из пар «фраза → транскрипция»: слово к слову, когда их поровну.

    Слово бывает в разных фразах по-разному («Come» у англичан и итальянцев) —
    берётся самое частое прочтение. Слова с кириллицей не берутся: кириллицу
    RUAccent уже разметила, и совпасть после неё они не смогут."""
    votes: dict[str, Counter] = defaultdict(Counter)
    for src, ru in pairs:
        src_words, ru_words = src.split(), ru.split()
        if len(src_words) != len(ru_words):
            continue
        for s, r in zip(src_words, ru_words):
            s, r = _strip(s), _strip(r)
            if s and r and LATIN.search(s) and not CYRILLIC.search(s):
                votes[dictionary_key(s)][r] += 1
    return {k: c.most_common(1)[0][0] for k, c in votes.items()}


EXTRA = Path(__file__).with_name("pronunciation-extra.json")


def load_extra(path: Path) -> dict[str, str]:
    """Ручные записи: жалобы владельца и имена вне коллекции. Ошибка в них — отказ
    сборки: их пишут руками, и пропустить молча значит потерять жалобу."""
    extra = {k: v for k, v in json.loads(path.read_text(encoding="utf-8")).items()
             if k != "_"}
    bad = [f"{k!r}: {problem(v)}" for k, v in extra.items() if problem(v)]
    if bad:
        raise SystemExit("ручной словарь с ошибками:\n  " + "\n  ".join(bad))
    return {dictionary_key(k): v for k, v in extra.items()}


def build(src_dir: Path, extra: Path = EXTRA) -> tuple[dict, list[str]]:
    items = {}
    for f in sorted(src_dir.glob("in-*.json")):
        for item in json.loads(f.read_text(encoding="utf-8")):
            items[item["id"]] = item
    answers = {}
    for f in sorted(src_dir.glob("out-*.json")):
        for a in json.loads(f.read_text(encoding="utf-8")):
            answers[a["id"]] = a["ru"]
    report, pairs = [], []
    for i, item in items.items():
        ru = answers.get(i)
        ru = None if ru is None else tidy(ru)
        why = "нет ответа" if ru is None else problem(ru)
        if why:
            report.append(f"{item['src']!r}: {why} ({ru!r})")
            continue
        pairs.append((item["src"], ru.strip()))
    phrases = {dictionary_key(s): r for s, r in pairs if not CYRILLIC.search(s)}
    phrases.update(load_extra(extra))                   # ручное важнее LLM
    return {"phrases": phrases, "words": derive_words(pairs)}, report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export")
    e.add_argument("--db", type=Path, required=True)
    e.add_argument("--out", type=Path, required=True)
    e.add_argument("--parts", type=int, default=4)
    b = sub.add_parser("build")
    b.add_argument("--dir", type=Path, required=True)
    b.add_argument("--out", type=Path,
                   default=Path(__file__).resolve().parent.parent / "pronunciation.json")
    args = ap.parse_args()
    if args.cmd == "export":
        print(f"фраз: {export(args.db, args.out, args.parts)} → {args.out}")
        return 0
    data, report = build(args.dir)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=1, sort_keys=True) + "\n",
                        encoding="utf-8")
    print(f"фраз: {len(data['phrases'])}, слов: {len(data['words'])}, "
          f"отброшено: {len(report)} → {args.out}")
    for line in report:
        print("  " + line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
