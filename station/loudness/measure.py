#!/usr/bin/env python3
"""Замер громкости коллекции: EBU R128 по каждому файлу целиком.

Запускается на gpu-host, где коллекция лежит на локальном диске: 41.7 ГБ по SMB
читать незачем, а ffmpeg в сети живёт только там. Результат — кэш JSON рядом
с данными проекта на шаре; его читает `apply.py` на Debian и кладёт в
`library.db` станции.

Замер идёт по файлу целиком, а не по окну: анализатор subwave меряет только
начало трека (`ANALYZE_SECONDS`), и тихое вступление громкой песни дало бы ей
лишний подъём. Пиковое значение — true peak (`peak=true`): оно не меньше
выборочного, поэтому потолок подъёма получается осторожнее, а не смелее.

Повторный запуск меряет только новые и изменившиеся файлы (размер и
mtime_ns), поэтому ежедневный прогон на неизменной коллекции стоит обхода
каталога и ничего больше. Без внешних зависимостей: на gpu-host чистый Python.
"""
import argparse
import json
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

CACHE_VERSION = 1
# те же служебные ветви, что обрезает `music scan`: внутри .stversions лежит
# история версий Syncthing, и замер удвоил бы работу на копиях
SKIP_DIRS = {".stfolder", ".stversions", ".sync"}
FFMPEG_TIMEOUT_SEC = 600      # час звука меряется за ~25 с; больше — зависание
CHECKPOINT_EVERY = 200        # первый прогон идёт ~15 минут, обрыв не должен
                              # стоить всей сделанной работы
# фоновый приоритет: на gpu-host рядом живут сервисы с GPU и эфирный TTS
BELOW_NORMAL = getattr(subprocess, "BELOW_NORMAL_PRIORITY_CLASS", 0)
# Обход неполный, но замер честный: что видно — измерено и записано, чистка кэша
# пропущена, итог с `walk_errors` — в JSON. Отдельный код, а не 1: на 1 (упавший
# замер) run.py итогу не верит, а этот итог годен для записи в базу станции.
# Копия числа — в run.py (MEASURE_PARTIAL_EXIT); не 2 — его занимает argparse.
PARTIAL_EXIT = 3

_I_RE = re.compile(r"^\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", re.M)
_PEAK_RE = re.compile(r"^\s*Peak:\s+(-?(?:\d+(?:\.\d+)?|inf))\s+dBFS", re.M)


def parse_summary(stderr: str) -> tuple[float, float | None]:
    """Интегральная громкость и true peak из итоговой сводки `ebur128`.

    Покадровый журнал фильтра тоже содержит `I:`, поэтому разбирается только
    хвост после `Summary:`. Тишина даёт `-70.0 LUFS` и пик `-inf` — это честный
    замер, а не ошибка: подъём такому треку всё равно ограничит `maxBoostDb`.
    """
    _, sep, summary = stderr.rpartition("Summary:")
    if not sep:
        raise ValueError("в выводе ffmpeg нет сводки ebur128")
    loudness = _I_RE.search(summary)
    if not loudness:
        raise ValueError("в сводке ebur128 нет интегральной громкости")
    peak = _PEAK_RE.search(summary)
    peak_db = None
    if peak and peak.group(1) != "-inf":
        peak_db = float(peak.group(1))
    return float(loudness.group(1)), peak_db


def ffmpeg_measure(path: Path) -> tuple[float, float | None]:
    cmd = ["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", str(path),
           "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet",
           "-f", "null", "-"]
    p = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True,
                       timeout=FFMPEG_TIMEOUT_SEC, creationflags=BELOW_NORMAL)
    err = p.stderr.decode("utf-8", "replace")
    if p.returncode != 0:
        tail = " | ".join(err.strip().splitlines()[-2:])
        raise RuntimeError(f"ffmpeg завершился с кодом {p.returncode}: {tail}")
    return parse_summary(err)


def walk_mp3(root: Path, on_error) -> list[Path]:
    """Все mp3 коллекции; служебные ветви обрезаются до входа в них.

    `onerror` обязателен: по умолчанию os.walk молча пропускает недоступную
    ветвь, и частично видимый диск выглядел бы коллекцией, из которой исчезли
    файлы, — а за этим последовало бы удаление их замеров из кэша.
    """
    found = []
    for dirpath, dirnames, filenames in os.walk(root, onerror=on_error):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        found.extend(Path(dirpath) / fn for fn in filenames if fn.lower().endswith(".mp3"))
    return found


def rel_key(path: Path, root: Path) -> str:
    # ключ — относительный путь с прямыми слешами: именно так путь трека
    # хранит Navidrome, и `apply.py` сопоставляет по нему без перевода
    return path.relative_to(root).as_posix()


def load_cache(path: Path) -> dict:
    if not path.exists():
        return {"version": CACHE_VERSION, "tracks": {}}
    data = json.loads(path.read_text(encoding="utf-8"))
    if data.get("version") != CACHE_VERSION or not isinstance(data.get("tracks"), dict):
        raise SystemExit(f"{path}: незнакомый формат кэша — удалите его, если замер "
                         "нужно начать заново")
    return data


def save_cache(path: Path, cache: dict) -> None:
    # через временный файл: оборванная запись иначе оставит обрубок JSON, и
    # следующий прогон начнёт с нуля, потеряв весь сделанный замер
    path.parent.mkdir(parents=True, exist_ok=True)
    cache["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(cache, ensure_ascii=False, indent=0), encoding="utf-8")
    os.replace(tmp, path)


def plan(files: dict[str, tuple[int, int]], cached: dict, retry_errors: bool = False
         ) -> tuple[list[str], list[str]]:
    """Что мерить заново и что убрать из кэша.

    `files` — ключ → (размер, mtime_ns) по текущему обходу. Файл без изменений
    не перемеряется, даже если прошлый замер упал: ошибка на неизменном файле
    повторится, и каждую ночь тратить на неё ffmpeg незачем (`retry_errors`).
    """
    todo = []
    for key, (size, mtime_ns) in files.items():
        entry = cached.get(key)
        if (entry and entry.get("size") == size and entry.get("mtime_ns") == mtime_ns
                and (entry.get("error") is None or not retry_errors)):
            continue
        todo.append(key)
    removed = [key for key in cached if key not in files]
    return sorted(todo), sorted(removed)


def run(root: Path, cache_path: Path, workers: int, limit: int | None = None,
        retry_errors: bool = False, measure=ffmpeg_measure, log=print) -> dict:
    started = time.monotonic()
    walk_errors = []
    paths = walk_mp3(root, walk_errors.append)
    cache = load_cache(cache_path)
    tracks = cache["tracks"]
    if not paths and tracks:
        raise SystemExit(f"в {root} не найдено ни одного mp3, а в кэше {len(tracks)} "
                         "замеров — похоже, диск не виден; кэш не тронут")
    files = {}
    for p in paths:
        try:
            st = p.stat()
        except OSError as e:
            # файл исчез между обходом и stat — это не повод бросать замер
            # остальных, но и чистить кэш по такому обходу нельзя (см. ниже)
            walk_errors.append(e)
            continue
        files[rel_key(p, root)] = (st.st_size, st.st_mtime_ns)
    todo, removed = plan(files, tracks, retry_errors)
    if walk_errors:
        # недоступная ветвь неотличима от удалённой: чистить кэш по такому
        # обходу значит потерять замеры, которые завтра снова понадобятся
        removed = []
        for e in walk_errors:
            log(f"недоступно при обходе: {e}", file=sys.stderr)
    for key in removed:
        del tracks[key]
    if limit is not None:
        todo = todo[:limit]
    log(f"файлов: {len(files)}, мерить: {len(todo)}, убрать из кэша: {len(removed)}",
        file=sys.stderr)

    measured = errors = 0

    def one(key):
        size, mtime_ns = files[key]
        entry = {"size": size, "mtime_ns": mtime_ns,
                 "measured_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                 "lufs": None, "true_peak_db": None, "error": None}
        try:
            entry["lufs"], entry["true_peak_db"] = measure(root / key)
        except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as e:
            entry["error"] = f"{type(e).__name__}: {e}"[:300]
        return key, entry

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for n, fut in enumerate(as_completed([pool.submit(one, k) for k in todo]), 1):
            key, entry = fut.result()
            tracks[key] = entry
            measured += 1
            errors += entry["error"] is not None
            if n % CHECKPOINT_EVERY == 0:
                save_cache(cache_path, cache)
                log(f"  {n}/{len(todo)}", file=sys.stderr)
    cache["root"] = str(root)
    save_cache(cache_path, cache)
    return {"files": len(files), "measured": measured, "errors": errors,
            "removed": len(removed), "walk_errors": len(walk_errors),
            "cached": len(tracks), "seconds": round(time.monotonic() - started, 1)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="замер громкости коллекции (EBU R128)")
    ap.add_argument("--root", required=True, help="корень коллекции на этом хосте")
    ap.add_argument("--cache", required=True, help="кэш замеров (JSON) на шаре")
    ap.add_argument("--workers", type=int, default=6)
    ap.add_argument("--limit", type=int, default=None, help="мерить не больше N файлов")
    ap.add_argument("--retry-errors", action="store_true",
                    help="перемерить и неизменные файлы, замер которых упал")
    args = ap.parse_args(argv)
    try:
        # консоль Windows по SSH пишет в cp866/cp1251: кириллица в путях иначе
        # роняет печать, а не замер
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, OSError):
        pass
    stats = run(Path(args.root), Path(args.cache), args.workers, args.limit,
                args.retry_errors)
    print(json.dumps(stats, ensure_ascii=False))
    return PARTIAL_EXIT if stats["walk_errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
