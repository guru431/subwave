"""Full-level transition publication checks; needs NumPy, no audio/model stack."""

import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np


spec = importlib.util.spec_from_file_location("transition_worker", Path(__file__).with_name("analyze_worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class TransitionPublicationTests(unittest.TestCase):
    def test_failed_write_or_rename_preserves_previous_clip_and_removes_temp(self):
        for failure in ("write", "rename", None):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                for window, name in (("tail", "outgoing"), ("head", "incoming")):
                    stems = root / name
                    stems.mkdir()
                    for stem in ("drums", "bass", "other", "vocals"):
                        (stems / f"{window}-{stem}.flac").touch()
                (root / "outgoing" / "tail-meta.json").write_text(json.dumps({
                    "tail_start_sec": 80, "duration_sec": 100,
                }), encoding="utf-8")
                target = root / "transition.wav"
                target.write_bytes(b"previous complete clip")

                def read_stem(*_args, **_kwargs):
                    return np.full((4_000, 2), 0.01, dtype=np.float32), 100

                def write_clip(path, *_args, **_kwargs):
                    Path(path).write_bytes(b"new clip")
                    if failure == "write":
                        raise OSError("fixture write failed")

                real_replace = os.replace

                def replace_clip(source, destination):
                    if failure == "rename":
                        raise OSError("fixture rename failed")
                    real_replace(source, destination)

                request = {
                    "out_dir": directory,
                    "out": {"stems_dir": str(root / "outgoing"),
                            "outro": {"bars": [81_000, 83_000, 85_000], "start_ms": 90_000}},
                    "in": {"stems_dir": str(root / "incoming"), "bars": list(range(0, 7_000, 1_000))},
                }
                soundfile = types.SimpleNamespace(read=read_stem, write=write_clip)
                with patch.dict(sys.modules, {"soundfile": soundfile}), patch.object(worker, "DEMUCS_SR", 100), patch.object(worker.os, "replace", replace_clip):
                    if failure:
                        with self.assertRaisesRegex(OSError, f"fixture {failure} failed"):
                            worker.render_transition(request)
                        self.assertEqual(target.read_bytes(), b"previous complete clip")
                    else:
                        result = worker.render_transition(request)
                        self.assertTrue(result["ok"], result)
                        self.assertEqual(target.read_bytes(), b"new clip")
                self.assertFalse(Path(str(target) + ".tmp").exists())


if __name__ == "__main__":
    unittest.main()
