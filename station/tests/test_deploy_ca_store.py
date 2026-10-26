"""Контейнеры стека доверяют корням хоста, а не бандлу образа.

Пробы 2026-10-26 изнутри контейнеров на хосте станции: адрес с цепочкой
скомпрометированных промежуточных eMudhra открывали urllib комнаты и анализатора,
curl broadcast и wget caddy, а хост отказывает. Бандл образа обновляет только
пересборка, а образы апстрима мы не собираем; хранилище хоста обновляет apt.
Node свежих образов отказывает и сам, но по своему выпуску, а не по хранилищу хоста.

Только чтение файлов репозитория. Новый сервис апстрима роняет тест, пока его не
впишут в override или в исключения.
"""
from pathlib import Path

import yaml

STATION = Path(__file__).resolve().parent.parent
REPO = STATION.parent
HOST_CA = ["/etc/ssl/certs:/etc/ssl/certs:ro", "/usr/share/ca-certificates:/usr/share/ca-certificates:ro"]
CA_FILE = "/etc/ssl/certs/ca-certificates.crt"
EXEMPT = {
    "docker-socket-proxy": "наружу не ходит",
    "tts-heavy": "профиль, на станции не запущен: синтез — мостик TTS",
}
# Встроенные корни Node и certifi идут мимо системных файлов.
NODE = {"controller", "web"}
CERTIFI = {"analyzer"}  # тяжёлый вариант: transformers → huggingface_hub


def _services(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8"))["services"]


def test_every_service_trusts_the_host_ca_store():
    upstream = _services(REPO / "docker-compose.yml")
    ours = _services(STATION / "deploy" / "docker-compose.override.yml")
    assert set(EXEMPT) <= set(upstream), "исключение для сервиса, которого у апстрима нет"
    for name in sorted((set(upstream) | set(ours)) - set(EXEMPT)):
        svc = ours.get(name) or {}
        volumes = svc.get("volumes", [])
        assert all(m in volumes for m in HOST_CA), f"{name}: {volumes}"
        env = svc.get("environment") or {}
        assert env.get("SSL_CERT_FILE") == CA_FILE, name
        if name in NODE:
            assert "--use-openssl-ca" in env.get("NODE_OPTIONS", "").split(), name
        if name in CERTIFI:
            assert env.get("REQUESTS_CA_BUNDLE") == CA_FILE, name
