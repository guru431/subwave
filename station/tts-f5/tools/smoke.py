"""Дымовая проверка живой F5-службы: /health, /speak с опечаткой в голосе, /clone.

    python smoke.py [--url http://127.0.0.1:14126] [--voices <каталог службы>\\voices]
                    [--out <каталог службы>\\smoke] [--wait 180] [--no-clone]

Только stdlib — запускается хостовым Python gpu-host. Строка на проверку; код
выхода 1, если хоть одна не прошла.
"""
import argparse
import io
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
import wave
from pathlib import Path

TEXT = "Проверка связи."


def call(url, data=None, headers=None, timeout=900):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.headers, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()


def multipart(fields, files):
    boundary = uuid.uuid4().hex
    body = io.BytesIO()
    for name, value in fields.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'
                   .encode() + value.encode("utf-8") + b"\r\n")
    for name, (filename, data) in files.items():
        body.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; '
                   f'filename="{filename}"\r\nContent-Type: application/octet-stream\r\n\r\n'
                   .encode() + data + b"\r\n")
    body.write(f"--{boundary}--\r\n".encode())
    return body.getvalue(), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def wav_info(data):
    with wave.open(io.BytesIO(data)) as w:
        return w.getframerate(), w.getnframes() / w.getframerate()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--url", default="http://127.0.0.1:14126")
    # по умолчанию — voices каталога службы: <каталог службы>\app\tools\smoke.py
    ap.add_argument("--voices", default=str(Path(__file__).resolve().parents[2] / "voices"))
    ap.add_argument("--out", help="куда сложить полученные WAV для прослушивания")
    ap.add_argument("--wait", type=float, default=180, help="сколько ждать /health, с")
    ap.add_argument("--no-clone", action="store_true", help="только /health и /speak")
    a = ap.parse_args(argv)
    out = Path(a.out) if a.out else None
    if out:
        out.mkdir(parents=True, exist_ok=True)
    results = []

    def check(name, ok, detail):
        results.append(ok)
        print(f"{'OK  ' if ok else 'FAIL'} {name}: {detail}", flush=True)

    deadline = time.monotonic() + a.wait
    while True:
        try:
            status, _, body = call(a.url + "/health", timeout=5)
        except OSError:
            status, body = 0, b""
        if status == 200 or time.monotonic() > deadline:
            break
        time.sleep(2)
    check("health", status == 200, body.decode("utf-8", "replace") or f"нет ответа за {a.wait:.0f} с")
    if status != 200:
        return 1

    t0 = time.monotonic()
    status, h, data = call(a.url + "/speak", json.dumps({"text": TEXT, "voice": "ru-rajt"}).encode(),
                           {"Content-Type": "application/json"})
    detail = (f"{status} voice={h.get('X-TTS-Voice-Used')} fell_back={h.get('X-TTS-Fell-Back')} "
              f"reason={h.get('X-TTS-Fell-Back-Reason')} {time.monotonic() - t0:.1f} s")
    ok = status == 200 and h.get("X-TTS-Voice-Used") == "ru-host" and h.get("X-TTS-Fell-Back") == "1"
    if status == 200:
        sr, secs = wav_info(data)
        ok = ok and sr == 24000
        detail += f", {sr} Hz, {secs:.1f} s звука"
        if out:
            (out / "speak.wav").write_bytes(data)
    check("speak", ok, detail)

    if not a.no_clone:
        voices = Path(a.voices)
        ref = (voices / "ru-host.wav").read_bytes()
        ref_text = (voices / "ru-host.txt").read_text(encoding="utf-8").strip()
        body, hdr = multipart({"text": TEXT, "ref_text": ref_text}, {"ref_audio": ("ref.wav", ref)})
        t0 = time.monotonic()
        status, _, data = call(a.url + "/clone", body, hdr)
        detail, ok = f"{status} {time.monotonic() - t0:.1f} s", status == 200
        if ok:
            sr, secs = wav_info(data)
            ok = sr == 24000
            detail += f", {sr} Hz, {secs:.1f} s звука"
            if out:
                (out / "clone.wav").write_bytes(data)
        check("clone", ok, detail)
        body, hdr = multipart({"text": TEXT, "ref_text": ref_text},
                              {"ref_audio": ("ref.mp3", b"ID3\x03\x00 not a wav")})
        status, _, _ = call(a.url + "/clone", body, hdr)
        check("clone-not-wav", status == 415, str(status))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
