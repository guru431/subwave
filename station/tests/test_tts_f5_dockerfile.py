"""Dockerfile F5-службы: koziev в пакете ruaccent.

RUAccent.load ищет POS-теггер и лемматизатор koziev в каталоге своего пакета, а не
в workdir (ruaccent.py:82-87). В колесе ruaccent их нет, и без них load лезет в
Hugging Face: при HF_HUB_OFFLINE=1 служба не стартует даже с F5_ENGINE=dry, а
проверка `import ruaccent` при сборке этого не видит.
"""
from pathlib import Path

F5_DIR = Path(__file__).resolve().parent.parent / "tts-f5"
DOCKERFILE = F5_DIR / "Dockerfile"


def _copy_line():
    return next(line for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
                if line.startswith("COPY ") and "f5_text.py" in line).split()


def test_image_carries_every_service_module():
    # модуль, забытый в COPY, служба не найдёт только на старте контейнера на gpu-host
    modules = sorted(p.name for p in F5_DIR.glob("f5_*.py")) + ["server.py"]
    assert [m for m in modules if m not in _copy_line()] == []


def test_image_installs_and_checks_num2words():
    # f5_numbers без num2words не импортируется — а с ним и вся служба
    reqs = (F5_DIR / "requirements.txt").read_text(encoding="utf-8").split()
    assert any(r.startswith("num2words==") for r in reqs)
    check = next(line for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
                 if "imports ok" in line)
    assert "num2words" in check


def test_image_carries_the_pronunciation_dictionary():
    # f5_text без файла молча работает с пустым словарём: пропуск COPY вернул бы
    # «Даррис Тредс» в эфир без единой ошибки
    copy = [line for line in DOCKERFILE.read_text(encoding="utf-8").splitlines()
            if line.startswith("COPY ") and "f5_text.py" in line]
    assert copy and "pronunciation.json" in copy[0].split()


def test_image_puts_koziev_into_the_ruaccent_package_and_checks_it():
    text = DOCKERFILE.read_text(encoding="utf-8")
    assert "source=ruaccent-koziev" in text and '"$d/koziev"' in text
    assert "import ruaccent.rule_accent_engine" in text     # сборка падает без koziev
