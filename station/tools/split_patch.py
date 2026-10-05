#!/usr/bin/env python3
"""Нарезка патча по фичам — инструмент переезда с патч-файлов на коммиты.

    python station/tools/split_patch.py inventory PATCH            > hunks.tsv
    python station/tools/split_patch.py split PATCH ASSIGN.json OUTDIR

`inventory` — строка на hunk: файл, номер hunk'а в файле (с 1), заголовок `@@`,
+строк/-строк, первая изменённая строка. `split` раскладывает hunk'и по фичам:
    {"C01 заказ перед авто-пиками": ["controller/src/broadcast/queue.ts#2", ...], ...}
Порядок ключей — порядок коммитов. Элемент без `#N` — все hunk'и файла; новый
файл — только целиком. Каждый hunk обязан достаться ровно одной фиче, иначе
отказ со списком, и OUTDIR не трогается. Результат — OUTDIR/<фича>.patch.
Hunk'и одного файла не пересекаются в исходнике, поэтому любое их подмножество
накладывается `git apply` со смещением, в любом порядке.
"""
import json
import sys
from pathlib import Path


def read_patch(path: Path) -> str:
    # патч в рабочей копии Windows мог получить CRLF; на клоне его снимали `tr -d '\r'`
    return path.read_bytes().decode("utf-8").replace("\r\n", "\n")


def parse(text: str) -> list[dict]:
    files, cur = [], None
    for line in text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            cur = {"path": line.split(" b/", 1)[1].strip(), "header": [line],
                   "hunks": [], "new": False}
            files.append(cur)
        elif cur is None:
            continue
        elif line.startswith("@@"):
            cur["hunks"].append([line])
        elif cur["hunks"]:
            cur["hunks"][-1].append(line)
        else:
            cur["header"].append(line)
            if line.startswith("new file mode"):
                cur["new"] = True
    return files


def _numbers(f: dict) -> list[int]:
    return list(range(1, len(f["hunks"]) + 1)) or [0]


def inventory(files: list[dict]) -> list[str]:
    rows = []
    for f in files:
        for i in _numbers(f):
            if i == 0:
                rows.append(f"{f['path']}\t#0\t(без hunk'ов)\t+0/-0\t")
                continue
            body = f["hunks"][i - 1][1:]
            plus = sum(1 for ln in body if ln.startswith("+"))
            minus = sum(1 for ln in body if ln.startswith("-"))
            first = next((ln[1:].strip() for ln in body if ln[:1] in "+-" and ln[1:].strip()), "")
            rows.append(f"{f['path']}\t#{i}\t{f['hunks'][i - 1][0].strip()}\t+{plus}/-{minus}\t{first[:80]}")
    return rows


def split(files: list[dict], assign: dict[str, list[str]]) -> dict[str, str]:
    by_path = {f["path"]: f for f in files}
    owner: dict[tuple[str, int], str] = {}
    errors = []
    for feature, items in assign.items():
        for item in items:
            path, _, num = item.partition("#")
            f = by_path.get(path)
            if f is None:
                errors.append(f"{feature}: файла {path} в патче нет")
                continue
            if num and f["new"]:
                errors.append(f"{feature}: новый файл {path} делится только целиком")
                continue
            for i in ([int(num)] if num else _numbers(f)):
                if i not in _numbers(f):
                    errors.append(f"{feature}: в {path} нет hunk'а #{i}")
                    continue
                if (path, i) in owner:
                    errors.append(f"{path}#{i}: и {owner[(path, i)]}, и {feature}")
                owner[(path, i)] = feature
    for f in files:
        for i in _numbers(f):
            if (f["path"], i) not in owner:
                errors.append(f"{f['path']}#{i}: ни одной фиче")
    if errors:
        raise SystemExit("нарезка отвергнута:\n  " + "\n  ".join(errors))
    out = {}
    for feature in assign:
        parts = []
        for f in files:
            mine = [i for i in _numbers(f) if owner[(f["path"], i)] == feature]
            if mine:
                parts += f["header"]
                for i in mine:
                    if i:
                        parts += f["hunks"][i - 1]
        out[feature] = "".join(parts)
    return out


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) == 2 and argv[0] == "inventory":
        print("\n".join(inventory(parse(read_patch(Path(argv[1]))))))
        return 0
    if len(argv) == 4 and argv[0] == "split":
        files = parse(read_patch(Path(argv[1])))
        result = split(files, json.loads(Path(argv[2]).read_text(encoding="utf-8")))
        outdir = Path(argv[3])
        outdir.mkdir(parents=True, exist_ok=True)
        for feature, text in result.items():
            (outdir / f"{feature}.patch").write_text(text, encoding="utf-8", newline="\n")
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
