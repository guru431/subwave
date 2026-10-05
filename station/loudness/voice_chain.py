#!/usr/bin/env python3
"""Модель голосовой цепочки Liquidsoap: с какой громкостью реплика выходит в эфир.

Повторяет `mic_chain` из `liquidsoap/radio.liq` апстрима: усиление `tts.gainDb`
(liq_amplify) → компрессор 4:1 выше −18 dBFS (атака 5 мс, отпускание 120 мс,
колено 2, +7 dB компенсации) → ×1.4. Компрессор сжимает изменения на входе
примерно вчетверо, поэтому сдвиг `gainDb` на N dB меняет громкость голоса в
эфире лишь на ~N/4 — и подбирать ручку надо по выходу цепочки, а не на глаз.

Правило владельца: голос ведущей ГРОМЧЕ музыки — примерно на 2 dB выше медианы
музыки. Музыка выровнена к −14 LUFS, значит голос — около −12 LUFS на выходе
цепочки. На 2026-09-23 это `gainDb = +6` для F5 (сырые реплики −18.9 LUFS) и
около +5 для Chatterbox (−17.35). Ручка — следствие правила: новый движок или
новая цель музыки — пересчитать отсюда.

Клипы сперва проверять на речь (`station/tts-f5/tools/check_speech.py`): у
шипения громкость, частота и длительность такие же, как у речи.

Запускать там, где есть ffmpeg, — на gpu-host (отрицательные значения — через `=`):

    python voice_chain.py --clips <каталог клипов> --gains=4,6,8
"""
import argparse
import glob
import os
import re
import statistics
import subprocess

I_RE = re.compile(r"^\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS", re.M)


def lufs(path: str, chain: str) -> float:
    af = (chain + "," if chain else "") + "ebur128=framelog=quiet"
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-nostdin", "-i", path,
                        "-af", af, "-f", "null", "-"], capture_output=True)
    err = p.stderr.decode("utf-8", "replace")
    found = I_RE.search(err.rpartition("Summary:")[2])
    if found is None:
        raise SystemExit(f"{path}: ffmpeg не выдал итог ebur128 (код {p.returncode}):\n"
                         f"{err.strip()[-500:]}")
    return float(found.group(1))


def mic_chain(gain_db: float) -> str:
    # у acompressor порог и компенсация линейные: −18 dB = 0.12589, +7 dB = 2.2387
    return (f"volume={gain_db}dB,acompressor=threshold=0.12589:ratio=4:attack=5:"
            "release=120:knee=2:makeup=2.2387:detection=rms,volume=1.4")


def main() -> None:
    ap = argparse.ArgumentParser(description="громкость голоса на выходе mic_chain")
    ap.add_argument("--clips", required=True, help="каталог с WAV-репликами ведущей")
    ap.add_argument("--gains", default="9,5,3,0,-3,-4,-6",
                    help="значения tts.gainDb через запятую")
    args = ap.parse_args()
    clips = sorted(glob.glob(os.path.join(args.clips, "*.wav")))
    if not clips:
        raise SystemExit(f"в {args.clips} нет WAV")
    raw = [lufs(c, "") for c in clips]
    print(f"клипов: {len(clips)}, сырой уровень: медиана {statistics.median(raw):.2f} LUFS")
    for gain in (float(g) for g in args.gains.split(",")):
        out = [lufs(c, mic_chain(gain)) for c in clips]
        print(f"gainDb {gain:+.0f}: на выходе медиана {statistics.median(out):.1f} LUFS "
              f"({min(out):.1f}…{max(out):.1f})")


if __name__ == "__main__":
    main()
