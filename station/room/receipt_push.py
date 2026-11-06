"""Отдельное согласие на уведомление об одном заказе; квитанция — capability."""
import json
import sys
import time
import urllib.error
import urllib.request

TERMINAL = {"aired", "declined", "failed", "removed", "answered"}


def fetch_receipt(base: str, request_id: str) -> dict | None:
    try:
        with urllib.request.urlopen(base.rstrip("/") + "/request/" + request_id, timeout=10) as r:
            body = json.loads(r.read())
        if not isinstance(body, dict):
            raise ValueError("неверная квитанция")
        return body
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


class RequestWatch:
    def __init__(self, store, notifier, fetch):
        self.store, self.notifier, self.fetch = store, notifier, fetch

    def tick(self) -> int:
        sent = 0
        for row in self.store.pending_request_push():
            try:
                receipt = self.fetch(row["request_id"])
                if receipt is None:
                    self.store.finish_request_push(row["request_id"], row["endpoint"])
                    continue
                phase = receipt.get("phase")
                if phase not in TERMINAL:
                    continue
                track = receipt.get("track") or {}
                body = (f"{track.get('artist') or ''} — {track.get('title') or ''}" if phase == "aired"
                        else receipt.get("message") or receipt.get("ack") or "Откройте квитанцию заказа.")
                status = self.notifier.sender(json.loads(row["subscription"]), {
                    "title": "Ваш заказ в эфире" if phase == "aired" else "Результат заказа",
                    "body": body[:180], "tag": "subwave-request-" + row["request_id"],
                    "url": "/?request=1",
                }, self.notifier.vapid, self.notifier.subject)
                if 200 <= status < 300 or status in (404, 410):
                    self.store.finish_request_push(row["request_id"], row["endpoint"])
                    sent += 1
            except Exception as e:
                # Не журналировать capability и endpoint, включая текст сетевой ошибки.
                print(f"room: квитанция push: {type(e).__name__}", file=sys.stderr, flush=True)
        return sent

    def run(self) -> None:
        while True:
            try:
                self.tick()
            except Exception as e:
                print(f"room: квитанции: {type(e).__name__}", file=sys.stderr, flush=True)
            time.sleep(20)
