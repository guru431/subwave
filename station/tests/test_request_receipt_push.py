import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1] / "room"


def load(name):
    spec = importlib.util.spec_from_file_location("receipt_test_" + name, ROOT / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def test_receipt_notification_is_durable_private_and_retries_until_delivered(tmp_path):
    store_mod, receipt_push = load("store"), load("receipt_push")
    db = tmp_path / "room.db"
    now = datetime(2026, 11, 1, tzinfo=timezone.utc)
    store = store_mod.Store(str(db), now=now)
    sub = {"endpoint": "https://push.test/token", "p256dh": "key", "auth": "auth"}
    assert store.watch_request("one", sub, "listener", 10, 1, now=now)
    assert not store.watch_request("two", sub, "listener", 10, 1, now=now)
    assert store.subscriptions() == [], "receipt consent must not subscribe to chat"
    store.close()
    store = store_mod.Store(str(db), now=now)
    original_pending = store.pending_request_push
    store.pending_request_push = lambda: original_pending(now=now)
    phase, codes, deliveries = ["queued"], [503, 201], []

    def sender(subscription, payload, vapid, subject):
        deliveries.append(payload)
        return codes.pop(0)

    notifier = SimpleNamespace(sender=sender, vapid=None, subject="https://radio.test")
    watch = receipt_push.RequestWatch(store, notifier, lambda request_id: {
        "phase": phase[0], "track": {"artist": "Кино", "title": "Звезда"}})
    try:
        assert watch.tick() == 0 and deliveries == []
        phase[0] = "aired"
        assert watch.tick() == 0 and len(store.pending_request_push()) == 1
        assert watch.tick() == 1 and store.pending_request_push() == []
        assert watch.tick() == 0 and len(deliveries) == 2
        assert deliveries[0]["tag"] == deliveries[1]["tag"]
        assert deliveries[0]["title"] == "Ваш заказ в эфире"
    finally:
        store.close()
