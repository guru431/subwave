#!/usr/bin/env python3
"""Замеры громкости → `library.db` станции subwave.

Контроллер subwave выравнивает громкость сам: на каждый трек ставит Liquidsoap
`liq_amplify` до цели `loudness.targetLufs`. Источник цифры — ReplayGain из
тегов (через Navidrome), иначе `tracks.loudness_lufs` в `library.db`. Тегов в
коллекции нет, а анализатор станции колонку не заполнял, поэтому до этого
скрипта все треки играли с усилением 1.

Сюда пишется замер `measure.py` по файлу целиком. Id трека станции — это id
Navidrome, а замер знает путь; мост между ними — `media_file.path` в базе
Navidrome (путь относительно корня коллекции, с прямыми слешами).

Если анализатор станции когда-нибудь запустят, он перепишет колонку своим
замером по началу трека. Следующий прогон этого скрипта вернёт замер по
файлу целиком: значения расходятся, и строка обновится.

Без внешних зависимостей: на Debian системный python3.
"""
import argparse
import json
import sqlite3
import sys
from collections import Counter
from pathlib import Path

NAVIDROME_DB = "/var/lib/navidrome/navidrome.db"
# доля треков станции без замера, при которой запись отменяется: так выглядит
# не «пара новых треков», а разошедшаяся схема путей или чужой кэш
MAX_UNMATCHED_SHARE = 0.5


def load_measurements(path: Path) -> dict[str, tuple[float, float | None]]:
    """Путь → (LUFS, true peak). Упавшие замеры в запись не идут."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out = {}
    for key, entry in data.get("tracks", {}).items():
        lufs = entry.get("lufs")
        if entry.get("error") is None and isinstance(lufs, (int, float)):
            out[key] = (float(lufs), entry.get("true_peak_db"))
    return out


def navidrome_paths(path: Path) -> dict[str, str]:
    # только чтение: база принадлежит работающей службе
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        return dict(conn.execute("SELECT id, path FROM media_file"))
    finally:
        conn.close()


def plan_updates(rows, id_to_path: dict[str, str],
                 measurements: dict[str, tuple[float, float | None]]):
    """Какие строки `tracks` переписать. `rows` — (id, loudness_lufs, peak_db)."""
    updates, stats = [], Counter()
    for track_id, cur_lufs, cur_peak in rows:
        rel = id_to_path.get(track_id)
        if rel is None:
            stats["unknown_id"] += 1
            continue
        found = measurements.get(rel)
        if found is None:
            stats["no_measurement"] += 1
            continue
        if (cur_lufs, cur_peak) == found:
            stats["unchanged"] += 1
            continue
        updates.append((found[0], found[1], track_id))
        stats["updated"] += 1
    return updates, stats


def run(cache: Path, navidrome_db: Path, library_db: Path, dry_run: bool = False) -> dict:
    measurements = load_measurements(cache)
    id_to_path = navidrome_paths(navidrome_db)
    # таймаут — ожидание блокировки: контроллер пишет в ту же базу сам
    conn = sqlite3.connect(library_db, timeout=15)
    try:
        rows = conn.execute("SELECT id, loudness_lufs, peak_db FROM tracks").fetchall()
        updates, stats = plan_updates(rows, id_to_path, measurements)
        unmatched = stats["unknown_id"] + stats["no_measurement"]
        if rows and unmatched / len(rows) > MAX_UNMATCHED_SHARE:
            raise SystemExit(
                f"замера нет у {unmatched} из {len(rows)} треков станции — это не "
                "пополнение коллекции, а разошедшиеся пути или чужой кэш; "
                "в базу ничего не записано")
        if updates and not dry_run:
            with conn:
                conn.executemany(
                    "UPDATE tracks SET loudness_lufs = ?, peak_db = ? WHERE id = ?", updates)
    finally:
        conn.close()
    return {"tracks": len(rows), "measurements": len(measurements),
            "updated": stats["updated"], "unchanged": stats["unchanged"],
            "no_measurement": stats["no_measurement"], "unknown_id": stats["unknown_id"],
            "dry_run": dry_run}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="замеры громкости → library.db станции")
    ap.add_argument("--cache", required=True, help="кэш замеров с шары")
    ap.add_argument("--navidrome-db", default=NAVIDROME_DB)
    ap.add_argument("--library-db", required=True, help="library.db станции")
    ap.add_argument("--dry-run", action="store_true", help="посчитать, но не писать")
    args = ap.parse_args(argv)
    stats = run(Path(args.cache), Path(args.navidrome_db), Path(args.library_db),
                args.dry_run)
    print(json.dumps(stats, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
