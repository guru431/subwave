"""admin.py: пароль владельца проверяет контроллер, а не комната.

Контроллер подделан на уровне urlopen: своей сети тест не трогает.
"""
import http.client
import importlib.util
import sys
import urllib.error
import urllib.request
from email.message import Message
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _load(name: str):
    path = ROOT / "room" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"room_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[f"room_{name}"] = mod
    spec.loader.exec_module(mod)
    return mod


admin = _load("admin")
URL = "http://controller:7701"


class Ok:
    status = 200

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def controller(monkeypatch):
    """Ответ контроллера на GET /settings: "ok", код ошибки или "down"."""
    seen = []
    mode = {"answer": "ok"}

    def fake(req, timeout=None):
        seen.append((req.full_url, req.get_header("Authorization")))
        answer = mode["answer"]
        if answer == "ok":
            return Ok()
        if answer == "down":
            raise OSError("connection refused")
        if answer == "garbled":
            raise http.client.BadStatusLine("garbage")
        headers = Message()
        if answer == 429:
            headers["Retry-After"] = "900"
        raise urllib.error.HTTPError(req.full_url, answer, "refused", headers, None)

    monkeypatch.setattr(urllib.request, "urlopen", fake)
    return seen, mode


def test_owner_is_recognised_and_the_header_travels(controller):
    seen, _ = controller
    assert admin.verify("Basic b3duZXI6cGFzcw==", URL) == (200, None)
    assert seen == [(URL + "/settings", "Basic b3duZXI6cGFzcw==")]


def test_wrong_password_is_401(controller):
    _, mode = controller
    mode["answer"] = 401
    assert admin.verify("Basic bad", URL) == (401, None)


def test_no_header_does_not_ask_the_controller(controller):
    seen, _ = controller
    assert admin.verify(None, URL) == (401, None)
    assert admin.verify("", URL) == (401, None)
    assert seen == []


def test_lockout_passes_retry_after(controller):
    _, mode = controller
    mode["answer"] = 429
    assert admin.verify("Basic bad", URL) == (429, "900")


def test_unreachable_controller_is_502(controller):
    _, mode = controller
    mode["answer"] = "down"
    assert admin.verify("Basic x", URL) == (502, None)


def test_other_controller_errors_are_502(controller):
    _, mode = controller
    mode["answer"] = 500
    assert admin.verify("Basic x", URL) == (502, None)


def test_trailing_slash_in_the_address(controller):
    seen, _ = controller
    admin.verify("Basic x", URL + "/")
    assert seen[0][0] == URL + "/settings"


def test_empty_controller_address_is_502(controller):
    seen, _ = controller
    assert admin.verify("Basic x", "") == (502, None)
    assert seen == []


def test_address_without_scheme_is_502(controller):
    seen, _ = controller
    assert admin.verify("Basic x", "controller") == (502, None)
    assert seen == []


def test_malformed_controller_answer_is_502(controller):
    _, mode = controller
    mode["answer"] = "garbled"
    assert admin.verify("Basic x", URL) == (502, None)
