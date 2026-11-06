"""Идемпотентное потребление подтверждённых карт контроллера после commit комнаты."""
import json
import threading
from pathlib import Path

_lock = threading.Lock()


def sync(store, directory: str) -> None:
    if not directory:
        return
    with _lock:
        files = sorted(Path(directory).glob("*.json"))
        combined = {}
        for file in files:
            batch = json.loads(file.read_text(encoding="utf-8"))
            mapping = batch.get("trackMap")
            if batch.get("version") != 1 or not isinstance(mapping, dict) or any(
                    not isinstance(k, str) or not k or not isinstance(v, str) or not v
                    for k, v in mapping.items()):
                raise ValueError("неверная карта ротации комнаты")
            for old, new in mapping.items():
                if old in combined and combined[old] != new:
                    raise ValueError("конфликт карт ротации")
                combined[old] = new
        store.remap_song_ids(combined)
        for file in files:
            file.unlink()  # Только после commit: обрыв до удаления безопасно повторит пакет.
