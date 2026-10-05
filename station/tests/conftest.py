import sqlite3

import pytest

_connect = sqlite3.connect


@pytest.fixture(autouse=True)
def _sqlite_without_fsync(monkeypatch):
    # Базы тестов живут во временном каталоге и после прогона не нужны, а
    # умолчания SQLite на каждую фиксацию заводят и удаляют файл журнала и
    # ждут fsync. Под нагрузкой на диск это десятки секунд на тест из пяти
    # треков (замер 2026-09-23: 38.5 с), и бюджет быстрого набора уходил
    # в ожидание диска, а не в проверки. Откат транзакций журнал в памяти
    # сохраняет, теряется лишь стойкость к падению ОС — тестам она не нужна.
    def connect(*args, **kwargs):
        conn = _connect(*args, **kwargs)
        conn.execute("PRAGMA synchronous = OFF")
        conn.execute("PRAGMA journal_mode = MEMORY")
        return conn

    monkeypatch.setattr(sqlite3, "connect", connect)
