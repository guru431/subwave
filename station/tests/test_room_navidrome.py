"""navidrome.download(): открыть поток к Navidrome, не читая тело.

Файл 8–14 МБ, и прочитать его в память значит отдать столько же тому, кто
попросил, — поэтому функция возвращает открытый ответ, а не байты.
"""
import importlib.util
import sys
import urllib.parse
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


navidrome = _load("navidrome")


class FakeUpstream:
    def __init__(self, body=b"", headers=None, status=200):
        self._body, self._pos, self.status = body, 0, status
        self.headers = Message()
        for k, v in (headers or {}).items():
            self.headers[k] = v

    def read(self, size=-1):
        chunk = self._body[self._pos:] if size in (-1, None) \
            else self._body[self._pos:self._pos + size]
        self._pos += len(chunk)
        return chunk

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


@pytest.fixture
def captured(monkeypatch):
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url if hasattr(req, "full_url") else req
        seen["headers"] = dict(getattr(req, "headers", {}))
        seen["timeout"] = timeout
        return FakeUpstream(b"ID3data", {"Content-Type": "audio/mpeg"})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return seen


def test_download_hits_the_download_endpoint_with_json_envelope(captured):
    navidrome.download("abc", "http://nav", "u", "p")
    url = urllib.parse.urlparse(captured["url"])
    q = urllib.parse.parse_qs(url.query)
    assert url.path == "/rest/download"
    assert q["id"] == ["abc"]
    # f=json обязателен: без него конверт ошибки приедет XML и разобрать его
    # будет нечем.
    assert q["f"] == ["json"]
    assert q["c"] == ["subwave-room"] and q["u"] == ["u"]
    assert q["t"] and q["s"]          # salt и token, а не пароль в адресе
    assert "p" not in q


def test_password_never_appears_in_the_url(captured):
    navidrome.download("abc", "http://nav", "user", "s3cret")
    assert "s3cret" not in captured["url"]


def test_range_is_passed_through_to_navidrome(captured):
    navidrome.download("abc", "http://nav", "u", "p", rng="bytes=0-1023")
    # urllib нормализует имя заголовка через .capitalize()
    assert captured["headers"].get("Range") == "bytes=0-1023"


def test_if_range_is_passed_through_to_navidrome(captured):
    # Докачка несёт условие «если файл не менялся с этой даты»: без него
    # Navidrome отдал бы кусок нового файла, и докачка склеила бы два разных.
    date = "Wed, 21 Oct 2015 07:28:00 GMT"
    navidrome.download("abc", "http://nav", "u", "p", rng="bytes=100-", if_range=date)
    assert captured["headers"].get("Range") == "bytes=100-"
    assert captured["headers"].get("If-range") == date     # имя после .capitalize()


def test_no_range_means_no_header(captured):
    navidrome.download("abc", "http://nav", "u", "p")
    assert "Range" not in captured["headers"]
    assert "If-range" not in captured["headers"]


def test_body_is_not_read_by_download(captured):
    resp = navidrome.download("abc", "http://nav", "u", "p")
    assert resp.read(4) == b"ID3d"      # поток не тронут до вызывающего


def test_download_uses_its_own_timeout(captured):
    navidrome.download("abc", "http://nav", "u", "p")
    assert captured["timeout"] == navidrome.DOWNLOAD_TIMEOUT


def test_envelope_code_reads_the_subsonic_failure():
    # Ошибки Navidrome приезжают с HTTP 200 и вот таким телом — исключения
    # не будет, и except HTTPError их не поймает.
    body = (b'{"subsonic-response":{"status":"failed",'
            b'"error":{"code":70,"message":"not found"}}}')
    assert navidrome.envelope_code(body) == 70


def test_envelope_code_of_something_else_is_none():
    assert navidrome.envelope_code(b"ID3\x03\x00\x00") is None
    assert navidrome.envelope_code(b'{"subsonic-response":{"status":"ok"}}') is None
    assert navidrome.envelope_code(b"") is None
