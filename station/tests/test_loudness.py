"""Нормализатор громкости: замер коллекции и запись замеров в базу станции.

До него станция не выравнивала громкость вовсе: механизм контроллера включён,
но `loudness_lufs` пуст у всех 4631 треков и ReplayGain в тегах нет — каждый
трек шёл с усилением 1 (сверка library.db 2026-09-23).
"""
import importlib.util
import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


measure = _load("loudness_measure", ROOT / "loudness" / "measure.py")
apply = _load("loudness_apply", ROOT / "loudness" / "apply.py")
run_mod = _load("loudness_run", ROOT / "loudness" / "run.py")

# хвост настоящего вывода ffmpeg 9.0.1 на GPU-хосте (2026-09-23)
FFMPEG_TAIL = """\
[Parsed_ebur128_0 @ 000001] t: 179.3  TARGET:-23 LUFS    M: -18.1 S: -17.9     I: -16.5 LUFS       LRA:  13.4 LU
[Parsed_ebur128_0 @ 0000020011e89800] Summary:

  Integrated loudness:
    I:         -16.5 LUFS
    Threshold: -27.2 LUFS

  Loudness range:
    LRA:        13.4 LU
    Threshold: -37.2 LUFS
    LRA low:   -26.0 LUFS
    LRA high:  -12.6 LUFS

  True peak:
    Peak:       -1.3 dBFS
[out#0/null @ 0000020011584340] video:0KiB audio:30904KiB subtitle:0KiB
"""


def quiet(*_a, **_k):
    pass


def test_summary_is_read_from_the_final_block_not_the_frame_log():
    assert measure.parse_summary(FFMPEG_TAIL) == (-16.5, -1.3)


def test_silence_is_a_measurement_not_an_error():
    silence = FFMPEG_TAIL.replace("-16.5 LUFS\n    Threshold", "-70.0 LUFS\n    Threshold")
    silence = silence.replace("Peak:       -1.3 dBFS", "Peak:       -inf dBFS")
    assert measure.parse_summary(silence) == (-70.0, None)


def test_output_without_summary_is_refused():
    with pytest.raises(ValueError):
        measure.parse_summary("Invalid data found when processing input")


def _collection(root: Path) -> None:
    (root / "A").mkdir(parents=True)
    (root / "A" / "one.mp3").write_bytes(b"1")
    (root / "A" / "Two.MP3").write_bytes(b"22")       # регистр расширения
    (root / "A" / "cover.jpg").write_bytes(b"x")
    (root / ".stversions").mkdir()
    (root / ".stversions" / "old.mp3").write_bytes(b"old")


def fake_measure(values: dict):
    calls = []

    def run(path: Path):
        calls.append(path.name)
        return values.get(path.name, (-10.0, -0.5))
    run.calls = calls
    return run


def test_first_run_measures_every_mp3_and_skips_service_folders(tmp_path):
    root, cache = tmp_path / "Music", tmp_path / "cache" / "loudness.json"
    _collection(root)
    m = fake_measure({"one.mp3": (-8.2, 0.3)})
    stats = measure.run(root, cache, workers=2, measure=m, log=quiet)
    assert sorted(m.calls) == ["Two.MP3", "one.mp3"]
    assert stats["measured"] == 2 and stats["errors"] == 0
    tracks = json.loads(cache.read_text(encoding="utf-8"))["tracks"]
    assert set(tracks) == {"A/one.mp3", "A/Two.MP3"}           # ключ — posix-путь
    assert tracks["A/one.mp3"]["lufs"] == -8.2
    assert tracks["A/one.mp3"]["true_peak_db"] == 0.3


def test_second_run_measures_only_what_changed(tmp_path):
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)
    measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    (root / "A" / "one.mp3").write_bytes(b"changed")
    (root / "A" / "new.mp3").write_bytes(b"n")
    m = fake_measure({})
    stats = measure.run(root, cache, workers=1, measure=m, log=quiet)
    assert sorted(m.calls) == ["new.mp3", "one.mp3"]
    assert stats["cached"] == 3


def test_removed_file_leaves_the_cache(tmp_path):
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)
    measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    (root / "A" / "one.mp3").unlink()
    stats = measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    assert stats["removed"] == 1
    assert "A/one.mp3" not in json.loads(cache.read_text(encoding="utf-8"))["tracks"]


def test_unreadable_branch_does_not_erase_measurements(tmp_path, monkeypatch):
    # частично видимый диск неотличим от удалённых файлов: чистить кэш по такому
    # обходу значит завтра мерить заново то, что никуда не девалось
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)
    measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    real_walk = measure.walk_mp3

    def broken_walk(r, on_error):
        on_error(OSError("ветвь недоступна"))
        return [p for p in real_walk(r, on_error) if p.name != "one.mp3"]
    monkeypatch.setattr(measure, "walk_mp3", broken_walk)
    stats = measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    assert stats["walk_errors"] == 1 and stats["removed"] == 0
    assert "A/one.mp3" in json.loads(cache.read_text(encoding="utf-8"))["tracks"]


def test_file_vanishing_mid_walk_does_not_stop_the_rest(tmp_path, monkeypatch):
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)
    real_walk = measure.walk_mp3
    monkeypatch.setattr(measure, "walk_mp3",
                        lambda r, on_error: real_walk(r, on_error) + [r / "A" / "gone.mp3"])
    m = fake_measure({})
    stats = measure.run(root, cache, workers=1, measure=m, log=quiet)
    assert sorted(m.calls) == ["Two.MP3", "one.mp3"] and stats["walk_errors"] == 1


def test_empty_root_with_filled_cache_is_refused(tmp_path):
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)
    measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    before = cache.read_bytes()
    for p in root.rglob("*.mp3"):
        p.unlink()
    with pytest.raises(SystemExit):
        measure.run(root, cache, workers=1, measure=fake_measure({}), log=quiet)
    assert cache.read_bytes() == before


def test_failed_measurement_is_kept_as_error_and_not_retried_nightly(tmp_path):
    root, cache = tmp_path / "Music", tmp_path / "loudness.json"
    _collection(root)

    def broken(path):
        if path.name == "one.mp3":
            raise RuntimeError("ffmpeg завершился с кодом 1")
        return (-9.0, -0.1)
    stats = measure.run(root, cache, workers=1, measure=broken, log=quiet)
    assert stats["errors"] == 1
    entry = json.loads(cache.read_text(encoding="utf-8"))["tracks"]["A/one.mp3"]
    assert entry["lufs"] is None and "ffmpeg" in entry["error"]
    m = fake_measure({})
    measure.run(root, cache, workers=1, measure=m, log=quiet)
    assert m.calls == []
    measure.run(root, cache, workers=1, measure=m, retry_errors=True, log=quiet)
    assert m.calls == ["one.mp3"]


# --- запись в базу станции -------------------------------------------------

def _station(tmp_path: Path, cache_tracks: dict, nd_rows, lib_rows):
    cache = tmp_path / "loudness.json"
    cache.write_text(json.dumps({"version": 1, "tracks": cache_tracks}), encoding="utf-8")
    nd = tmp_path / "navidrome.db"
    c = sqlite3.connect(nd)
    c.execute("CREATE TABLE media_file (id TEXT PRIMARY KEY, path TEXT)")
    c.executemany("INSERT INTO media_file VALUES (?, ?)", nd_rows)
    c.commit()
    c.close()
    lib = tmp_path / "library.db"
    c = sqlite3.connect(lib)
    c.execute("CREATE TABLE tracks (id TEXT PRIMARY KEY, title TEXT, "
              "loudness_lufs REAL, peak_db REAL)")
    c.executemany("INSERT INTO tracks VALUES (?, ?, ?, ?)", lib_rows)
    c.commit()
    c.close()
    return cache, nd, lib


def _loudness(lib: Path) -> dict:
    c = sqlite3.connect(lib)
    try:
        return {r[0]: (r[1], r[2]) for r in c.execute(
            "SELECT id, loudness_lufs, peak_db FROM tracks")}
    finally:
        c.close()


def _measured(lufs, peak, error=None):
    return {"size": 1, "mtime_ns": 1, "lufs": lufs, "true_peak_db": peak, "error": error}


def test_measurements_reach_station_tracks_by_navidrome_path(tmp_path):
    cache, nd, lib = _station(
        tmp_path,
        {"Rock/Кино/01.mp3": _measured(-8.5, 0.2), "Rock/b.mp3": _measured(-15.0, -3.0)},
        [("id1", "Rock/Кино/01.mp3"), ("id2", "Rock/b.mp3")],
        [("id1", "Группа крови", None, None), ("id2", "B", None, None)])
    stats = apply.run(cache, nd, lib)
    assert stats["updated"] == 2
    assert _loudness(lib) == {"id1": (-8.5, 0.2), "id2": (-15.0, -3.0)}


def test_second_apply_changes_nothing(tmp_path):
    cache, nd, lib = _station(tmp_path, {"a.mp3": _measured(-9.0, -0.5)},
                              [("id1", "a.mp3")], [("id1", "A", None, None)])
    apply.run(cache, nd, lib)
    stats = apply.run(cache, nd, lib)
    assert stats["updated"] == 0 and stats["unchanged"] == 1


def test_window_measurement_of_the_analyzer_is_replaced(tmp_path):
    # анализатор станции меряет только начало трека; его цифра уступает замеру
    # по файлу целиком при следующем прогоне
    cache, nd, lib = _station(tmp_path, {"a.mp3": _measured(-9.0, -0.5)},
                              [("id1", "a.mp3")], [("id1", "A", -19.3, -6.0)])
    assert apply.run(cache, nd, lib)["updated"] == 1
    assert _loudness(lib)["id1"] == (-9.0, -0.5)


def test_dry_run_writes_nothing(tmp_path):
    cache, nd, lib = _station(tmp_path, {"a.mp3": _measured(-9.0, -0.5)},
                              [("id1", "a.mp3")], [("id1", "A", None, None)])
    stats = apply.run(cache, nd, lib, dry_run=True)
    assert stats["updated"] == 1 and stats["dry_run"] is True
    assert _loudness(lib)["id1"] == (None, None)


def test_failed_measurement_does_not_overwrite(tmp_path):
    cache, nd, lib = _station(
        tmp_path, {"a.mp3": _measured(None, None, "RuntimeError: ffmpeg"),
                   "b.mp3": _measured(-9.0, -0.5)},
        [("id1", "a.mp3"), ("id2", "b.mp3")],
        [("id1", "A", -12.0, -1.0), ("id2", "B", None, None)])
    stats = apply.run(cache, nd, lib)
    assert stats["no_measurement"] == 1
    assert _loudness(lib)["id1"] == (-12.0, -1.0)


def test_mismatched_paths_refuse_to_write(tmp_path):
    # так выглядит сменившаяся схема путей Navidrome или кэш другой коллекции:
    # «замера нет у всех» — это не пополнение, а сломанное сопоставление
    cache, nd, lib = _station(
        tmp_path, {"/mnt/music/a.mp3": _measured(-9.0, -0.5),
                   "c.mp3": _measured(-9.0, -0.5)},
        [("id1", "a.mp3"), ("id2", "b.mp3"), ("id3", "c.mp3")],
        [("id1", "A", None, None), ("id2", "B", None, None), ("id3", "C", None, None)])
    with pytest.raises(SystemExit):
        apply.run(cache, nd, lib)
    assert _loudness(lib)["id3"] == (None, None)


# --- оркестратор ------------------------------------------------------------

CFG = {"GPU_SSH": "gpu@10.0.0.5", "STATION_SSH": "op@10.0.0.10", "SSH_PORT": "2222",
       "SSH_KEY": "~/.ssh/test_key",
       "LOUDNESS_MEASURE_REMOTE": r"D:\data\loudness\measure.py",
       "LOUDNESS_GPU_MUSIC_ROOT": r"D:\Music",
       "LOUDNESS_GPU_CACHE": r"D:\data\loudness\loudness.json",
       "LOUDNESS_APPLY_DIR": "/srv/radio/loudness",
       "LOUDNESS_STATION_CACHE": "/mnt/data/loudness/loudness.json",
       "LOUDNESS_LIBRARY_DB": "/srv/radio/state/library.db"}


def test_orchestrator_measures_first_and_applies_second():
    seen = []

    def runner(cmd, timeout=None):
        seen.append(cmd)
        if "measure.py --root" in cmd[-1]:
            return 'ход замера\n{"files": 3, "measured": 1}\n'
        if "apply.py" in cmd[-1] and Path(cmd[0]).stem.lower() == "ssh":
            return '{"tracks": 3, "updated": 1, "dry_run": true}\n'
        return ""
    measured, applied = run_mod.run(CFG, dry_run=True, workers=4, runner=runner)
    assert measured == {"files": 3, "measured": 1}
    assert applied["dry_run"] is True
    # имя программы — без пути: ночная задача получает полный путь к OpenSSH
    kinds = [(Path(c[0]).stem.lower(), c[-1]) for c in seen]
    assert kinds[0] == ("scp", "gpu@10.0.0.5:D:/data/loudness/measure.py")
    assert kinds[1] == ("ssh", r"python D:\data\loudness\measure.py --root D:\Music "
                               r"--cache D:\data\loudness\loudness.json --workers 4")
    assert kinds[2] == ("ssh", "sudo install -d -o op /srv/radio/loudness")
    assert kinds[3] == ("scp", "op@10.0.0.10:/srv/radio/loudness/apply.py")
    assert kinds[4] == ("ssh", "sudo python3 /srv/radio/loudness/apply.py "
                               "--cache /mnt/data/loudness/loudness.json "
                               "--library-db /srv/radio/state/library.db --dry-run")
    assert seen[1][1:3] == ["-p", "2222"]


def test_config_from_env_file_with_environment_on_top(tmp_path):
    env_file = tmp_path / ".env"
    lines = [f"{k}={v}" for k, v in CFG.items() if k != "SSH_PORT"]
    env_file.write_text("# комментарий\n" + "\n".join(lines) + "\nSSH_PORT='2200'\n",
                        encoding="utf-8")
    assert run_mod.load_config(environ={"SSH_PORT": "2222"}, env_file=env_file) == CFG


def test_missing_config_names_every_key(tmp_path):
    with pytest.raises(SystemExit) as e:
        run_mod.load_config(environ={}, env_file=tmp_path / "absent.env")
    assert "GPU_SSH" in str(e.value) and "LOUDNESS_LIBRARY_DB" in str(e.value)


def test_ssh_works_where_openssh_is_not_on_path(monkeypatch):
    # session 0 ночной задачи: PATH без OpenSSH, голое «ssh» не нашлось бы.
    # Свежая загрузка под другим именем: importlib.reload не находит модуль,
    # загруженный по пути, а run_mod остальных тестов трогать незачем
    monkeypatch.setattr("shutil.which", lambda name: None)
    monkeypatch.delitem(sys.modules, "loudness_run_no_path", raising=False)
    fresh = _load("loudness_run_no_path", ROOT / "loudness" / "run.py")
    assert fresh.SSH.lower().endswith(r"openssh\ssh.exe")
    assert fresh.SCP.lower().endswith(r"openssh\scp.exe")


def test_main_passes_flags_and_prints_summary(monkeypatch, capsys):
    got = {}
    monkeypatch.setattr(run_mod, "load_config", lambda: CFG)

    def fake_run(cfg, dry_run, workers):
        got.update(cfg=cfg, dry_run=dry_run, workers=workers)
        return ({"files": 1, "measured": 0, "errors": 0, "cached": 1, "seconds": 0.1},
                {"tracks": 1, "updated": 0, "unchanged": 1, "no_measurement": 0,
                 "unknown_id": 0, "dry_run": True})
    monkeypatch.setattr(run_mod, "run", fake_run)
    assert run_mod.main(["--dry-run", "--workers", "2"]) == 0
    assert got == {"cfg": CFG, "dry_run": True, "workers": 2}
    assert "холостой прогон" in capsys.readouterr().out


def test_scripts_have_no_installation_defaults():
    with pytest.raises(SystemExit):
        measure.main(["--workers", "1"])       # без --root/--cache
    with pytest.raises(SystemExit):
        apply.main(["--dry-run"])              # без --cache/--library-db
