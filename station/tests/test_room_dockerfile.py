"""Контракт между `server.py` и `Dockerfile` образа комнаты.

`Dockerfile` перечисляет копируемые файлы поимённо (`COPY a.py b.py ./`).
Забытый модуль не роняет сборку: `docker build` пройдёт, а контейнер уйдёт в
рестарт-петлю с `ModuleNotFoundError` при первом же импорте. Настоящую сборку
образа этот тест не заменяет — она дело деплоя, и Docker на машине с тестами
может не быть вовсе. Он ловит именно эту ошибку в быстром наборе, за
миллисекунды, статическим разбором `server.py` (через `ast`) и `Dockerfile`
(построчно).

`normalize.py` — своя копия комнаты (была `music/normalize.py` проекта music)
и копируется как любой модуль.
"""
import ast
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROOM = ROOT / "room"
DOCKERFILE = ROOM / "Dockerfile"


def _direct_imports(tree: ast.Module) -> set[str]:
    """Имена модулей, импортируемых телом модуля на верхнем уровне.

    Только `tree.body` — импорт внутри функции в `server.py` не в счёт
    (сейчас таких нет, но если появятся, ронять здесь их не наша забота).
    Для `from X import …` берётся только `level == 0` (абсолютный импорт):
    `from . import Y` не называет модуль в `node.module` вовсе, поэтому
    отсеивается той же проверкой `node.module` на истинность.
    """
    names: set[str] = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                names.add(alias.name.split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                names.add(node.module.split(".")[0])
    return names


def required_room_modules(entry: Path, room_dir: Path) -> set[str]:
    """Сиблинги `room_dir`, нужные `entry` — транзитивно.

    Сиблинг, который импортирует другой сиблинг, тоже тянет свою зависимость:
    обход идёт по очереди, а не только по прямым импортам `entry`.
    """
    seen: set[str] = set()
    queue = [entry]
    while queue:
        path = queue.pop()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for name in _direct_imports(tree):
            sibling = room_dir / f"{name}.py"
            if name in seen or not sibling.is_file():
                continue
            seen.add(name)
            queue.append(sibling)
    return seen


def copied_modules(dockerfile_text: str) -> set[str]:
    """Модули каталога комнаты, перечисленные в строках `COPY`.

    Контекст сборки — сам каталог комнаты, поэтому модуль — голое имя `x.py`;
    токен с каталогом (`a/x.py`) — чужой файл, последний токен — место назначения.
    Продолжения строк (`\\` + перевод строки) склеиваются в одну ПЕРЕД разбором.
    """
    joined = dockerfile_text.replace("\\\n", " ")
    names: set[str] = set()
    for line in joined.splitlines():
        tokens = line.split()
        if not tokens or tokens[0].upper() != "COPY":
            continue
        for token in tokens[1:-1]:
            if token.endswith(".py") and "/" not in token:
                names.add(token[:-len(".py")])
    return names


def test_dockerfile_copies_every_module_server_imports():
    imported = required_room_modules(ROOM / "server.py", ROOM)
    copied = copied_modules(DOCKERFILE.read_text(encoding="utf-8"))
    missing = imported - copied
    assert not missing, (
        f"Dockerfile COPY не копирует модули {sorted(missing)}, которые "
        "server.py импортирует (прямо или через сиблинга) — образ соберётся, "
        "а контейнер уйдёт в рестарт-петлю с ModuleNotFoundError."
    )


def test_parser_pins_continuation_lines_and_import_collection(tmp_path):
    """Разбор пином на инлайн-примере.

    Без этого теста ошибка в `copied_modules`/`_direct_imports` (например,
    тихий возврат пустого множества с обеих сторон) сделала бы тест выше
    зелёным вхолостую — subset пустого множества с пустым не отличить от
    настоящего совпадения.
    """
    dockerfile_text = (
        "FROM python:3.13-alpine\n"
        "WORKDIR /app\n"
        "COPY guard.py store.py \\\n"
        "     naming.py server.py ./\n"
        "COPY extra/other.py ./other.py\n"
    )
    assert copied_modules(dockerfile_text) == {"guard", "store", "naming", "server"}

    sample = tmp_path / "sample.py"
    sample.write_text(
        "import os\n"
        "import naming\n"
        "from store import Store\n"
        "from . import guard\n"          # относительный импорт — не в счёт
        "\n"
        "def f():\n"
        "    import station\n"           # не верхний уровень — не в счёт
        "    return station, Store, guard\n",
        encoding="utf-8",
    )
    tree = ast.parse(sample.read_text(encoding="utf-8"))
    assert _direct_imports(tree) == {"os", "naming", "store"}
