"""Dockerfile F5-службы: koziev в пакете ruaccent.

RUAccent.load ищет POS-теггер и лемматизатор koziev в каталоге своего пакета, а не
в workdir (ruaccent.py:82-87). В колесе ruaccent их нет, и без них load лезет в
Hugging Face: при HF_HUB_OFFLINE=1 служба не стартует даже с F5_ENGINE=dry, а
проверка `import ruaccent` при сборке этого не видит.
"""
from pathlib import Path

DOCKERFILE = Path(__file__).resolve().parent.parent / "tts-f5" / "Dockerfile"


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
