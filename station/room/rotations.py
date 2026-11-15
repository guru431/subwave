"""Идемпотентное потребление подтверждённых карт контроллера после commit комнаты."""
import json
import logging
import threading
from pathlib import Path
from uuid import uuid4

_lock = threading.Lock()


def sync(store, directory: str) -> None:
    if not directory:
        return
    with _lock:
        files = []
        combined = {}
        for file in sorted(Path(directory).glob("*.json")):
            try:
                batch = json.loads(file.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, UnicodeDecodeError):
                rejected = file.with_name(f"{file.name}.{uuid4().hex}.invalid")
                file.rename(rejected)
                logging.getLogger(__name__).warning("Повреждённая карта ротации %s сохранена в %s", file, rejected)
                continue
            if not isinstance(batch, dict):
                raise ValueError("неверная карта ротации комнаты")
            mapping = batch.get("trackMap")
            if batch.get("version") != 1 or not isinstance(mapping, dict) or any(
                    not isinstance(k, str) or not k or not isinstance(v, str) or not v
                    for k, v in mapping.items()):
                raise ValueError("неверная карта ротации комнаты")
            for old, new in mapping.items():
                if old in combined and combined[old] != new:
                    raise ValueError("конфликт карт ротации")
                combined[old] = new
            files.append(file)
        store.remap_song_ids(combined)
        for file in files:
            file.unlink()  # Только после commit: обрыв до удаления безопасно повторит пакет.
