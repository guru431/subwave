"""station/tools/backup.sh: снимок данных станции вне её хоста.

Скрипт гоняется настоящим bash на временном «стеке»: снимок SQLite, состав
архива, проверка распаковки и ротация — это и есть то, что может подвести ночью.
На Windows нужен bash из Git (не WSL): без него тесты пропускаются.

Полный прогон скрипта на Windows — 2–5 с (bash, tar и python на каждый шаг),
поэтому он `integration`: `python -m pytest -m integration tests/test_backup.py`.
В быстром наборе — отказы, которые обрываются до снимка.
"""
import os
import shutil
import sqlite3
import subprocess
import sys
import tarfile
import time
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "backup.sh"


def _bash():
    if os.name != "nt":
        return shutil.which("bash")
    # на Windows bash из PATH может оказаться WSL — ему не прочесть пути C:\…
    git = shutil.which("git")
    if git:
        for cand in (Path(git).parents[1] / "bin" / "bash.exe",
                     Path(git).parents[1] / "usr" / "bin" / "bash.exe"):
            if cand.is_file():
                return str(cand)
    found = shutil.which("bash")
    return found if found and "system32" not in found.lower() else None


BASH = _bash()
pytestmark = pytest.mark.skipif(BASH is None, reason="нет bash (на Windows — Git Bash)")

OWN_OLD = ["station-backup-20000101-000000.tar.gz",
           "station-backup-20000102-000000.tar.gz",
           "station-backup-20000103-000000.tar.gz"]
FOREIGN = ["notes.txt", "station-backup-manual.tar.gz",
           "subwave-auto-backup-2026-01-01-000000.zip", "subwave-backup-2026-01-01.zip"]
STALE_PART = ".station-backup-20000101-000000.tar.gz.123.tmp"
FRESH_PART = ".station-backup-20000102-000000.tar.gz.456.tmp"


def _db(path: Path, rows: list[str]):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE t (v TEXT)")
    conn.executemany("INSERT INTO t VALUES (?)", [(r,) for r in rows])
    conn.commit()
    return conn


@pytest.fixture
def stack(tmp_path):
    root = tmp_path / "subwave"
    (root / "state").mkdir(parents=True)
    (root / "room").mkdir()
    (root / ".env").write_text("ADMIN_PASS=secret\n", encoding="utf-8")
    _db(root / "room" / "room.db", ["дизлайк"]).close()
    (root / "room" / "vapid.pem").write_text("-----BEGIN KEY-----\n", encoding="utf-8")
    for name in ("settings.json", "blocklist.json", "folder-genres.json",
                 "recent-plays.json", "secrets.env",
                 # маркеры эфира — в архив не идут
                 "now-playing.json", "voice-playing.json",
                 "pause-talk-voice-accepted.json", "music-starved.json"):
        (root / "state" / name).write_text("{}", encoding="utf-8")
    # живая база в WAL: последняя запись ещё только в журнале, копия файла её
    # потеряла бы — снимок обязан её содержать
    lib = _db(root / "state" / "library.db", ["размечено"])
    lib.execute("PRAGMA journal_mode=WAL")
    lib.execute("PRAGMA wal_autocheckpoint=0")
    lib.execute("INSERT INTO t VALUES ('только в WAL')")
    lib.commit()
    dest = tmp_path / "backup"
    dest.mkdir()
    for name in OWN_OLD + FOREIGN + [STALE_PART, FRESH_PART]:
        (dest / name).write_bytes(b"old")
    two_hours_ago = time.time() - 7200
    os.utime(dest / STALE_PART, (two_hours_ago, two_hours_ago))
    yield root, dest
    lib.close()


def _env(root: Path, dest: Path, **extra) -> dict:
    return {**os.environ, "BACKUP_STACK_DIR": str(root), "BACKUP_DEST_DIR": str(dest),
            "BACKUP_PYTHON": sys.executable, **extra}


def _run(args, env):
    return subprocess.run([BASH, *args], env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=60)


def _new_archives(dest: Path) -> list[Path]:
    return [p for p in dest.iterdir()
            if p.name.startswith("station-backup-2") and p.name not in OWN_OLD]


@pytest.mark.integration
def test_backup_archives_the_station_and_rotates_only_its_own(stack, tmp_path):
    root, dest = stack
    r = _run([str(SCRIPT)], _env(root, dest, BACKUP_KEEP="2"))
    assert r.returncode == 0, r.stdout + r.stderr
    new = _new_archives(dest)
    assert len(new) == 1
    with tarfile.open(new[0]) as tar:
        names = set(tar.getnames())
        # только файлы: запись каталога при распаковке поверх стека переписала
        # бы права state/ и самого стека правами временного каталога
        assert all(m.isfile() for m in tar.getmembers())
        assert {"./.env", "./state/library.db", "./state/blocklist.json",
                "./state/folder-genres.json", "./state/recent-plays.json",
                "./state/settings.json", "./state/secrets.env",
                "./room/room.db", "./room/vapid.pem"} <= names
        for marker in ("now-playing.json", "voice-playing.json",
                       "pause-talk-voice-accepted.json", "music-starved.json"):
            assert f"./state/{marker}" not in names
        tar.extract("./state/library.db", tmp_path / "out", filter="data")
    conn = sqlite3.connect(tmp_path / "out" / "state" / "library.db")
    try:
        assert {v for (v,) in conn.execute("SELECT v FROM t")} == {"размечено", "только в WAL"}
    finally:
        conn.close()
    left = {p.name for p in dest.iterdir()}
    # своих хранится KEEP=2: новый и самый свежий из старых
    assert OWN_OLD[2] in left and OWN_OLD[0] not in left and OWN_OLD[1] not in left
    # чужое не тронуто — удалять можно только записанное самим
    assert set(FOREIGN) <= left
    # недописанный архив убитого прогона убран, свежий (соседний прогон) — нет
    assert STALE_PART not in left and FRESH_PART in left
    assert not [n for n in left if n.endswith(".tmp") and n != FRESH_PART]


@pytest.mark.integration
def test_temporary_copies_stay_off_tmp(stack, tmp_path):
    # /tmp на хосте станции — tmpfs: снимки баз там едят ОЗУ. Временный каталог
    # — в каталоге стека (тот же диск, что базы), и после прогона его нет
    root, dest = stack
    stale = root / ".station-backup-work.Old123"         # убитый прогон
    stale.mkdir()
    (stale / "library.db").write_bytes(b"x")
    two_hours_ago = time.time() - 7200
    os.utime(stale, (two_hours_ago, two_hours_ago))
    fresh = root / ".station-backup-work.New456"         # соседний прогон
    fresh.mkdir()
    foreign = root / ".station-backup-work-keep"
    foreign.mkdir()
    os.utime(foreign, (two_hours_ago, two_hours_ago))
    r = _run([str(SCRIPT)], _env(root, dest, TMPDIR=str(tmp_path / "no-such-tmp")))
    assert r.returncode == 0, r.stdout + r.stderr
    left = {p.name for p in root.iterdir() if p.name.startswith(".station-backup")}
    assert left == {fresh.name, foreign.name}


@pytest.mark.integration
def test_failure_after_the_archive_says_the_archive_exists(stack):
    # сбой ротации после mv: архив уже лежит — «архив не сделан» было бы ложью
    root, dest = stack
    blocker = dest / "station-backup-19990101-000000.tar.gz"   # свой по имени,
    blocker.mkdir()                                            # но каталог: rm -f падает
    (blocker / "x").write_bytes(b"x")
    r = _run([str(SCRIPT)], _env(root, dest, BACKUP_KEEP="1"))
    assert r.returncode == 2, r.stdout + r.stderr
    assert "архив сделан" in r.stderr and "не сделан" not in r.stderr
    assert len(_new_archives(dest)) == 1


def test_missing_data_fails_without_touching_old_archives(stack):
    root, dest = stack
    (root / "room" / "vapid.pem").unlink()
    before = sorted(p.name for p in dest.iterdir())
    r = _run([str(SCRIPT)], _env(root, dest, BACKUP_KEEP="1"))
    assert r.returncode != 0
    assert "vapid.pem" in r.stderr
    assert sorted(p.name for p in dest.iterdir()) == before


def test_unmounted_share_is_not_replaced_by_local_disk(stack, tmp_path):
    root, _ = stack
    absent = tmp_path / "share-not-mounted" / "backup"
    r = _run([str(SCRIPT)], _env(root, absent))
    assert r.returncode != 0
    assert not absent.exists()


@pytest.mark.integration
def test_remote_mode_runs_the_script_on_the_station_host(stack, tmp_path):
    # с рабочей машины: скрипт едет по ssh в stdin, на хосте — sudo; ssh и
    # sudo подменены, «удалённая» сторона — тот же bash
    root, dest = stack
    station = tmp_path / "repo" / "station"
    (station / "tools").mkdir(parents=True)
    shutil.copy(SCRIPT, station / "tools" / "backup.sh")
    (station / ".env").write_bytes(
        ("STATION_SSH=op@station-host\nSSH_PORT=2222\nSSH_KEY='key'\n"
         f"BACKUP_STACK_DIR='{root}'\nBACKUP_DEST_DIR='{dest}'\nBACKUP_KEEP=10\n"
         f"BACKUP_PYTHON='{sys.executable}'\n").encode())
    fakebin = tmp_path / "bin"
    fakebin.mkdir()
    (fakebin / "ssh").write_bytes(
        b'#!/bin/bash\nprintf \'%s\\n\' "$@" > "$FAKE_SSH_LOG"\nexec bash -c "${@: -1}"\n')
    (fakebin / "sudo").write_bytes(b'#!/bin/bash\nexec "$@"\n')
    for f in fakebin.iterdir():
        f.chmod(0o755)
    log = tmp_path / "ssh-args.txt"
    env = {k: v for k, v in os.environ.items() if not k.startswith("BACKUP_")}
    env.update(PATH=str(fakebin) + os.pathsep + os.environ["PATH"], FAKE_SSH_LOG=str(log))
    r = _run([str(station / "tools" / "backup.sh"), "--remote"], env)
    assert r.returncode == 0, r.stdout + r.stderr
    assert len(_new_archives(dest)) == 1
    args = log.read_text(encoding="utf-8").splitlines()
    assert args[args.index("-p") + 1] == "2222" and "op@station-host" in args
    assert "sudo env BACKUP_STACK_DIR=" in args[-1]
