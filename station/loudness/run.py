#!/usr/bin/env python3
"""Нормализатор громкости эфира: замер на GPU-хосте → `library.db` станции.

    python station/loudness/run.py [--dry-run] [--workers N]

Три хоста, два шага, оба скрипта — из этого каталога:

1. `measure.py` на GPU-хосте: коллекция там на локальном диске, и ffmpeg в сети
   живёт только там. Меряет новые и изменившиеся файлы, кэш — на шаре.
2. `apply.py` на хосте станции: сопоставляет пути с id станции и пишет замеры в
   `library.db`. Ни шары, ни базы Navidrome у хоста станции нет, поэтому оба
   входа везёт этот скрипт: кэш — с GPU-хоста, соответствие id → путь — снимком
   базы с хоста Navidrome (`sqlite3 -json`, только чтение).

Скрипты копируются на хосты перед каждым запуском: разошедшейся копии,
которую пришлось бы сверять с репозиторием, не бывает вовсе.

Адреса, пути и SSH — из окружения или `station/.env` (шаблон —
`station/.env.example`): у публичного кода нет умолчаний конкретной установки.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Полный путь — запасной: ночная задача (LogonType=Password) стартует в
# session 0, где OpenSSH в PATH нет, и голое `ssh` там не находится
OPENSSH = Path(r"C:\Windows\System32\OpenSSH")
SSH = shutil.which("ssh") or str(OPENSSH / "ssh.exe")
SCP = shutil.which("scp") or str(OPENSSH / "scp.exe")
HERE = Path(__file__).resolve().parent
ENV_FILE = HERE.parent / ".env"
# первый прогон по всей коллекции идёт ~15 минут, ежедневный — секунды
MEASURE_TIMEOUT_SEC = 3 * 3600
STEP_TIMEOUT_SEC = 120
# measure.py PARTIAL_EXIT: обход неполный, но итог годен — запись в базу станции
# идёт, а ошибка сообщается после неё. Копия: скрипты едут на хосты поодиночке
MEASURE_PARTIAL_EXIT = 3
KEYS = (
    "GPU_SSH",                  # user@host GPU-хоста: там коллекция и ffmpeg
    "STATION_SSH",              # user@host хоста станции
    "NAVIDROME_SSH",            # user@host хоста Navidrome (бывает им же)
    "SSH_PORT",
    "SSH_KEY",
    "LOUDNESS_MEASURE_REMOTE",  # путь measure.py на GPU-хосте
    "LOUDNESS_GPU_MUSIC_ROOT",  # корень коллекции на GPU-хосте
    "LOUDNESS_GPU_CACHE",       # кэш замеров, как его видит GPU-хост
    "LOUDNESS_NAVIDROME_DB",    # navidrome.db на хосте Navidrome
    "LOUDNESS_APPLY_DIR",       # каталог apply.py и его входов на хосте станции
    "LOUDNESS_LIBRARY_DB",      # library.db станции
)

# LogLevel=ERROR глушит предупреждение OpenSSH о постквантовом обмене ключами,
# которое GPU-хост печатает на каждое соединение; accept-new — чтобы первый
# запуск от имени ночной задачи не упал на ещё незнакомом ключе хоста в LAN
SSH_OPTS = ["-o", "BatchMode=yes", "-o", "LogLevel=ERROR",
            "-o", "StrictHostKeyChecking=accept-new"]


def load_config(environ=os.environ, env_file: Path = ENV_FILE) -> dict[str, str]:
    """Значения — из окружения, недостающие — из `station/.env`."""
    values = {}
    if env_file.is_file():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("'\"")
    values.update({k: environ[k] for k in KEYS if environ.get(k)})
    missing = [k for k in KEYS if not values.get(k)]
    if missing:
        raise SystemExit(f"не заданы {', '.join(missing)}: окружение или {env_file} "
                         f"(шаблон — station/.env.example)")
    return {k: values[k] for k in KEYS}


def _ssh(cfg: dict, host: str, remote: str) -> list[str]:
    return [SSH, "-p", cfg["SSH_PORT"], "-i", str(Path(cfg["SSH_KEY"]).expanduser()),
            *SSH_OPTS, host, remote]


def _scp(cfg: dict, local: Path, host: str, remote: str, fetch: bool = False) -> list[str]:
    ends = [str(local), f"{host}:{remote}"]
    return [SCP, "-P", cfg["SSH_PORT"], "-i", str(Path(cfg["SSH_KEY"]).expanduser()),
            *SSH_OPTS, *(ends[::-1] if fetch else ends)]


def _run(cmd: list[str], timeout: int = STEP_TIMEOUT_SEC, ok_codes=(0,)) -> str:
    """Шаг на удалённом хосте. Ход замера идёт в stderr и виден сразу."""
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, text=True, encoding="utf-8",
                           errors="replace", timeout=timeout)
    except subprocess.TimeoutExpired:
        raise SystemExit(f"{' '.join(cmd[:2])} … не завершился за {timeout} с")
    if p.returncode not in ok_codes:
        raise SystemExit(f"{cmd[0]} {cmd[-1]!r} завершился с кодом {p.returncode}: "
                         f"{p.stdout.strip()[-500:]}")
    return p.stdout


def _last_json(out: str) -> dict:
    lines = [ln for ln in out.splitlines() if ln.strip().startswith("{")]
    if not lines:
        raise SystemExit(f"скрипт не вернул итог: {out.strip()[-300:]}")
    return json.loads(lines[-1])


def run(cfg: dict, dry_run: bool = False, workers: int = 8, runner=_run) -> tuple[dict, dict]:
    gpu, station = cfg["GPU_SSH"], cfg["STATION_SSH"]
    measure_remote = cfg["LOUDNESS_MEASURE_REMOTE"]
    runner(_scp(cfg, HERE / "measure.py", gpu, measure_remote.replace("\\", "/")))
    # неполный обход — не повод не писать то, что измерено: одна недоступная
    # ветвь иначе навсегда выключала бы запись громкости новых треков
    measured = _last_json(runner(
        _ssh(cfg, gpu, f"python {measure_remote} --root {cfg['LOUDNESS_GPU_MUSIC_ROOT']} "
                       f"--cache {cfg['LOUDNESS_GPU_CACHE']} --workers {workers}"),
        timeout=MEASURE_TIMEOUT_SEC, ok_codes=(0, MEASURE_PARTIAL_EXIT)))
    apply_dir = cfg["LOUDNESS_APPLY_DIR"]
    with tempfile.TemporaryDirectory() as tmp:
        cache, paths = Path(tmp) / "loudness.json", Path(tmp) / "navidrome-paths.json"
        runner(_scp(cfg, cache, gpu, cfg["LOUDNESS_GPU_CACHE"].replace("\\", "/"), fetch=True))
        # база принадлежит работающей службе и root: только чтение, через sudo
        rows = runner(_ssh(cfg, cfg["NAVIDROME_SSH"],
                           f"sudo sqlite3 -readonly -json {cfg['LOUDNESS_NAVIDROME_DB']} "
                           "'SELECT id, path FROM media_file'"))
        paths.write_text(json.dumps({r["id"]: r["path"] for r in json.loads(rows or "[]")},
                                    ensure_ascii=False), encoding="utf-8")
        # каталог на хосте станции принадлежит root: заводится через sudo, но на
        # пользователя ssh — иначе scp следующей строкой не сможет в него писать
        runner(_ssh(cfg, station, f"sudo install -d -o {station.split('@')[0]} {apply_dir}"))
        for local in (HERE / "apply.py", cache, paths):
            runner(_scp(cfg, local, station, f"{apply_dir}/{local.name}"))
    applied = _last_json(runner(_ssh(
        cfg, station,
        f"sudo python3 {apply_dir}/apply.py --cache {apply_dir}/{cache.name} "
        f"--navidrome-paths {apply_dir}/{paths.name} "
        f"--library-db {cfg['LOUDNESS_LIBRARY_DB']}" + (" --dry-run" if dry_run else ""))))
    return measured, applied


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="нормализатор громкости эфира")
    ap.add_argument("--dry-run", action="store_true",
                    help="замерить, но в базу станции не писать")
    ap.add_argument("--workers", type=int, default=8, help="параллельных ffmpeg на GPU-хосте")
    args = ap.parse_args(argv)
    measured, applied = run(load_config(), dry_run=args.dry_run, workers=args.workers)
    print(f"замер: файлов {measured['files']}, измерено сейчас {measured['measured']} "
          f"(ошибок {measured['errors']}), в кэше {measured['cached']}, "
          f"{measured['seconds']} с")
    print(f"станция: треков {applied['tracks']}, записано {applied['updated']}, "
          f"без изменений {applied['unchanged']}, без замера {applied['no_measurement']}, "
          f"неизвестных id {applied['unknown_id']}"
          + (" [холостой прогон, база не тронута]" if applied["dry_run"] else ""))
    if measured.get("walk_errors"):
        # после записи, а не вместо неё: ночная задача должна упасть, но
        # измеренное уже в базе станции
        print(f"обход коллекции неполный: {measured['walk_errors']} ошибок "
              "(недоступная ветвь или файл, исчезнувший во время обхода) — "
              "замеры записаны, чистка кэша пропущена; подробности — в выводе "
              "measure.py выше", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
