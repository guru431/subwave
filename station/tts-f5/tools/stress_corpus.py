"""Корпус реплик ведущей для stress_audit.py: ответы LLM станции, которые уходят в эфир.

    python3 stress_corpus.py <logs-dir> > corpus.json

logs-dir — state/logs стека станции, например <deploy-dir>/subwave/state/logs
(журналы events-*.jsonl, с 2026-09-09). Многострочные ответы — рассуждение модели,
утёкшее в ответ до правки контроллера, — и почти целиком латинские пропускаются.
"""
import glob
import json
import re
import sys

KINDS = {"generateLink", "generateStationId", "generateHourlyTime", "generateIntro",
         "djAgentSegment", "djAgentRequest"}
CYR = re.compile(r"[А-Яа-яЁё]")
LAT = re.compile(r"[A-Za-z]")

if len(sys.argv) < 2:
    sys.exit(__doc__)
logs = sys.argv[1]
seen = {}
for path in sorted(glob.glob(f"{logs}/events-*.jsonl")):
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            r = e.get("response")
            if e.get("type") != "llm" or e.get("kind") not in KINDS or not e.get("ok") \
                    or not isinstance(r, str):
                continue
            r = r.strip()
            cyr = len(CYR.findall(r))
            if cyr and "\n" not in r and not r.startswith(("{", "[")) \
                    and len(LAT.findall(r)) <= 0.3 * cyr:
                seen.setdefault(r)
json.dump(list(seen), sys.stdout, ensure_ascii=False, indent=0)
