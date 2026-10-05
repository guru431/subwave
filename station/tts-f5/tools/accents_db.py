r"""Словарь ударений RUAccent → SQLite для службы (f5_accent.DictionaryDb).

    accents_db.py [workdir]

workdir — каталог моделей RUAccent, по умолчанию `ruaccent` в каталоге службы
(рядом с `app`, где лежит этот `tools`).
Запускать на хосте gpu-host в венве с numpy (D:\Temp\f5-probe\venv) до выкатки образа:
без dictionary\accents.sqlite служба не стартует, а в контейнере разбор json занял бы
661 МБ — те самые, ради которых база и заведена.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from f5_accent import build_dictionary_db  # noqa: E402

SERVICE = Path(__file__).resolve().parents[2]          # <каталог службы>\app\tools
print(build_dictionary_db(Path(sys.argv[1]) if len(sys.argv) > 1 else SERVICE / "ruaccent"))
