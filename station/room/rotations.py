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
                batch = None
            version = batch.get("version") if isinstance(batch, dict) else None
            if type(version) is int and version != 1:
                raise ValueError(f"неподдерживаемая версия карты ротации: {version}")
            mapping = batch.get("trackMap") if type(version) is int else None
            if not isinstance(mapping, dict) or any(
                    not k or not isinstance(v, str) or not v for k, v in mapping.items()):
                rejected = file.with_name(f"{file.name}.{uuid4().hex}.invalid")
                file.rename(rejected)
                logging.getLogger(__name__).warning("Повреждённая карта ротации %s сохранена в %s", file, rejected)
                continue
            for old, new in mapping.items():
                if old in combined and combined[old] != new:
                    raise ValueError("конфликт карт ротации")
                combined[old] = new
            files.append(file)
        store.remap_song_ids(combined)
        for file in files:
            file.unlink()  # Только после commit: обрыв до удаления безопасно повторит пакет.
