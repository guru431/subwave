# -*- coding: utf-8 -*-
"""Демо-ролик диктора → эталонный клип для Chatterbox.

Под роликом диктора играет музыка, а Chatterbox клонирует всё, что слышит, —
подложку вместе с голосом. Поэтому: найти участки без музыки, вырезать самый
длинный, загрузить в библиотеку и прочитать им одну подводку для сравнения
на слух.

Музыка опознаётся по энергии в басу: женский голос ниже 130 Гц почти не
звучит, подложка звучит всегда, разница между ними около 30 dB.

    python prep_voice.py "voices/<ролик диктора>.mp3" ru-host

Адреса — из окружения: `TTS_BRIDGE_URL` (мостик, `http://<gpu-host>:4124`) и
`CHATTERBOX_VOICES_URL` (библиотека голосов, `http://<gpu-host>:4123/voices`).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import wave
from collections import OrderedDict
from pathlib import Path

LISTEN_DIR = Path(os.getenv("DJ_VOICES_DIR", "dj-voices"))  # что прослушать
REFS = Path(__file__).parent / "refs"     # использованные срезы; в git не идут


def library_url() -> str:
    """Библиотека голосов Chatterbox (`…:4123/voices`) — из окружения:
    у публичного кода нет адресов конкретной установки."""
    url = os.environ.get("CHATTERBOX_VOICES_URL", "").strip().rstrip("/")
    if not url:
        raise SystemExit("CHATTERBOX_VOICES_URL не задан: адрес библиотеки голосов, "
                         "например http://<gpu-host>:4123/voices")
    return url


def bridge_url() -> str:
    """Мостик TTS (`…:4124`) — из окружения, по той же причине."""
    url = os.environ.get("TTS_BRIDGE_URL", "").strip().rstrip("/")
    if not url:
        raise SystemExit("TTS_BRIDGE_URL не задан: адрес мостика TTS, "
                         "например http://<gpu-host>:4124")
    return url

MIN_CLIP = 5.0          # короче Chatterbox нечего клонировать
MAX_CLIP = 20.0         # длиннее он ничего не выигрывает
BASS_GAP = 8.0          # dB над самым тихим басом ещё считается «музыки нет»
SPEECH_FLOOR = -35.0    # LUFS: тише — это пауза, а не речь

PODVODKA = (
    "Добрый вечер. Это AI радио, и рядом со мной та самая коллекция, "
    "которую собирали годами. Только что отзвучали Dire Straits — "
    "«Brothers in Arms». Дальше поставлю Кино, «Звезда по имени Солнце», "
    "восемьдесят девятый год. А потом будет потише, обещаю."
)


def loudness_profile(src: Path, filters: str = "") -> OrderedDict:
    """Кратковременная громкость раз в 0.1 с, как {секунда: LUFS}."""
    chain = f"{filters}ebur128=peak=none" if filters else "ebur128=peak=none"
    out = subprocess.run(
        ["ffmpeg", "-hide_banner", "-nostats", "-i", str(src),
         "-af", chain, "-f", "null", "-"],
        capture_output=True, text=True, encoding="utf-8", errors="replace").stderr
    prof = OrderedDict()
    for line in out.splitlines():
        m = re.search(r"t:\s*([\d.]+).*?S:\s*(-?[\d.]+)", line)
        if m:
            prof[round(float(m.group(1)), 1)] = float(m.group(2))
    return prof


def clean_regions(src: Path, has_music: bool = True) -> list[tuple[float, float]]:
    """Участки, где речь есть, а подложки нет.

    `has_music=False` — для источника, уже очищенного разделением (Demucs).
    Там поиск по басу бессмыслен и вреден: музыки нет вовсе, поэтому «самый
    тихий бас» — это пауза между фразами, и на её фоне собственный бас голоса
    выглядит подложкой. Остаётся один критерий — говорят или молчат.
    """
    full = loudness_profile(src)
    if has_music:
        bass = loudness_profile(src, "lowpass=f=130,")
        finite = sorted(v for v in bass.values() if v > -100)
        if not finite:
            return []
        threshold = finite[len(finite) // 100] + BASS_GAP
        print(f"  порог тишины в басу: {threshold:.1f} LUFS")

        def usable(t: float) -> bool:
            return bass.get(t, 0.0) < threshold and full[t] > SPEECH_FLOOR
    else:
        print("  источник без подложки, ищу только речь")

        def usable(t: float) -> bool:
            return full[t] > SPEECH_FLOOR

    regions, start, prev = [], None, None
    for t in full:
        if usable(t) and start is None:
            start = t
        elif not usable(t) and start is not None:
            regions.append((start, prev))
            start = None
        prev = t
    if start is not None:
        regions.append((start, prev))
    return [(a, b) for a, b in regions if b - a >= MIN_CLIP]


def cut(src: Path, start: float, end: float, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", f"{start:.2f}", "-to", f"{end:.2f}", "-i", str(src),
         "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", str(dst)],
        check=True)


def wait_ready(timeout: float = 180.0) -> bool:
    """Пульт gpu-ctl вправе погасить слот в любой момент, холодный старт — около
    29 с. Без ожидания загрузка отвечает пустотой (`curl 52`), а синтез — 502."""
    health = f"{bridge_url()}/health"
    deadline = time.time() + timeout
    announced = False
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(health, timeout=10) as r:
                if json.loads(r.read()).get("ok"):
                    return True
        except Exception:                              # noqa: BLE001 - ещё поднимается
            pass
        if not announced:
            print("  движок не готов, жду…")
            announced = True
        time.sleep(5)
    return False


def _post_voice(clip: Path, voice: str) -> str:
    return subprocess.run(
        ["curl", "-s", "--max-time", "60", "-X", "POST", library_url(),
         "-F", f"voice_name={voice}", "-F", "language=ru",
         "-F", f"voice_file=@{clip};type=audio/wav"],
        check=True, capture_output=True, text=True, encoding="utf-8").stdout


def upload(clip: Path, voice: str) -> None:
    """Загрузка в библиотеку. `language=ru` здесь и есть весь смысл операции:
    язык многоязычной модели берётся из метаданных голоса, а не из текста.

    Занятое имя освобождается и заливается заново. `PUT` тут не годится — он
    переименовывает, а не заменяет; а оставить как есть нельзя: `curl` без
    `--fail` считает успехом и ответ `voice_exists_error`, так что повторный
    прогон с перерезанным срезом молча оставил бы в библиотеке старый эталон,
    а синтез выглядел бы проверкой нового.
    """
    answer = _post_voice(clip, voice)
    if "voice_exists_error" in answer:
        print("  имя занято, заменяю эталон")
        # `--fail`: отказ удаления (404, 5xx) иначе тоже выглядел бы успехом
        subprocess.run(["curl", "-s", "--fail", "--max-time", "30", "-X", "DELETE",
                        f"{library_url()}/{voice}"], check=True, capture_output=True)
        answer = _post_voice(clip, voice)
        if "voice_exists_error" in answer:
            raise SystemExit(f"  эталон {voice} не заменён: {answer.strip()}")
    print(f"  библиотека: {answer.strip()}")


def speak(text: str, voice: str, dst: Path, attempts: int = 3) -> None:
    """Мостик сам повторяет 5xx с паузой 5 с, но срывы Chatterbox идут пачками
    (FINDINGS.md), и пачка эту паузу переживает. Здесь пауза длиннее. `4xx` не
    повторяется: это упрёк в наш адрес, повтором его не исправить."""
    body = json.dumps({"text": text, "voice": voice}).encode()
    for attempt in range(1, attempts + 1):
        req = urllib.request.Request(
            f"{bridge_url()}/speak", data=body, headers={"Content-Type": "application/json"})
        t0 = time.time()
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                dst.write_bytes(r.read())
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == attempts:
                raise
            print(f"  попытка {attempt} сорвалась ({exc.code}), жду 15 с")
            time.sleep(15)
            continue
        with wave.open(str(dst)) as w:
            dur = w.getnframes() / w.getframerate()
        print(f"  синтез {time.time() - t0:.1f}c, звук {dur:.1f}c -> {dst.name}")
        return


def main() -> int:
    src, voice = Path(sys.argv[1]), sys.argv[2]
    has_music = "--no-music" not in sys.argv[3:]
    LISTEN_DIR.mkdir(parents=True, exist_ok=True)
    print(f"{src.name} -> {voice}")

    regions = clean_regions(src, has_music)
    if not regions:
        print(f"  пригодных участков длиннее {MIN_CLIP:.0f} c нет — "
              f"отделить речь от музыки (Demucs) и прогнать с --no-music")
        return 1
    for a, b in regions:
        print(f"  годится: {a:.1f}-{b:.1f} c ({b - a:.1f} c)")

    start, end = max(regions, key=lambda r: r[1] - r[0])
    end = min(end, start + MAX_CLIP)
    clip = REFS / f"{voice}.wav"
    cut(src, start, end, clip)
    print(f"  эталон: {start:.1f}-{end:.1f} c ({end - start:.1f} c) -> {clip}")

    if not wait_ready():
        print("  движок так и не поднялся — эталон нарезан, загрузку повторить")
        return 1
    upload(clip, voice)
    shutil.copyfile(clip, LISTEN_DIR / f"_эталон-{voice}.wav")
    speak(PODVODKA, voice, LISTEN_DIR / f"{voice}.wav")
    return 0


if __name__ == "__main__":
    sys.exit(main())
