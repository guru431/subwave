"""Exercise verifier failure paths without a browser or a running station."""
import ast
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, call


SCRIPT = Path(__file__).resolve().parents[2] / "web/scripts/verify-forms.py"
TREE = ast.parse(SCRIPT.read_text(encoding="utf-8"), filename=str(SCRIPT))


def source_function(name, **namespace):
    """Load the real function without importing the Playwright entry point."""
    node = copy.deepcopy(next(
        node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == name
    ))
    node.decorator_list = []
    module = ast.Module(body=[node], type_ignores=[])
    exec(compile(module, str(SCRIPT), "exec"), namespace)
    return namespace[name]


class ReadinessTests(unittest.TestCase):
    def test_server_errors_are_retried_until_success(self):
        run = Mock(side_effect=[
            SimpleNamespace(stdout="500", returncode=0),
            SimpleNamespace(stdout="200", returncode=7),
            SimpleNamespace(stdout="200", returncode=0),
        ])
        clock = SimpleNamespace(time=Mock(return_value=0), sleep=Mock())
        wait = source_function("_wait_http", subprocess=SimpleNamespace(run=run), time=clock)
        wait("http://fixture")
        self.assertEqual(run.call_count, 3)
        self.assertEqual(clock.sleep.call_count, 2)

    def test_timeout_reports_the_last_http_failure(self):
        run = Mock(return_value=SimpleNamespace(stdout="503", returncode=0))
        clock = SimpleNamespace(time=Mock(side_effect=[0, 0, 1, 2]), sleep=Mock())
        wait = source_function("_wait_http", subprocess=SimpleNamespace(run=run), time=clock)
        with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
            wait("http://fixture", timeout=2)


class TakeoverCleanupTests(unittest.TestCase):
    def test_failed_check_cancels_takeover_and_removes_its_show(self):
        for cancel_fails in (False, True):
            with self.subTest(cancel_fails=cancel_fails):
                def write(method, path, *args, **kwargs):
                    if method == "POST":
                        return json.dumps({"show": {"id": "fixture-show"}})
                    if path == "/schedule/override" and cancel_fails:
                        raise RuntimeError("cancel failed")
                    return ""

                api_write = Mock(side_effect=write)
                page = SimpleNamespace(clock=SimpleNamespace(install=Mock(
                    side_effect=RuntimeError("check failed"),
                )))
                takeover = source_function(
                    "takeover", json=json, find_show=lambda name: None,
                    TAKEOVER_SHOW_NAME="Fixture", api_write=api_write,
                    api=lambda path: json.dumps({"values": {"personas": [{"id": "dj"}]}}),
                )
                expected_error = "cancel failed" if cancel_fails else "check failed"
                with self.assertRaisesRegex(RuntimeError, expected_error):
                    takeover(page)
                self.assertEqual(api_write.call_args_list[-2:], [
                    call("DELETE", "/schedule/override", ok_statuses=(200, 204, 404)),
                    call("DELETE", "/shows/fixture-show", ok_statuses=(200, 404)),
                ])


if __name__ == "__main__":
    unittest.main()
