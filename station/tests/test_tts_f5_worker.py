"""f5_worker: одна генерация на карте за раз, эфир — вперёд digital_me.

У Chatterbox два синтеза разом валили оба (инцидент 2026-09-22); у F5 то же не
проверено, поэтому воркер один. А приоритет нужен, чтобы абзац /clone на две
минуты речи не держал реплику эфира дольше одного куска.
"""
import sys
import threading
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
import f5_worker as W  # noqa: E402


def wait_until(cond, timeout=1.0):
    deadline = time.monotonic() + timeout
    while not cond():
        assert time.monotonic() < deadline, "условие не наступило"
        time.sleep(0.001)


@pytest.fixture
def worker():
    return W.Worker()


def blocking_job():
    started, gate = threading.Event(), threading.Event()

    def job():
        started.set()
        gate.wait(2)
    return job, started, gate


def test_results_come_back_in_order(worker):
    assert worker.run_all([lambda: 1, lambda: 2, lambda: 3], W.BROADCAST, 1.0) == [1, 2, 3]


def test_broadcast_overtakes_queued_clone(worker):
    job, started, gate = blocking_job()
    order = []
    t0 = threading.Thread(target=worker.run_all, args=([job], W.CLONE, 1.0))
    t0.start()
    assert started.wait(1)
    t1 = threading.Thread(target=worker.run_all,
                          args=([lambda: order.append("clone")], W.CLONE, 1.0))
    t1.start()
    wait_until(lambda: worker.pending() == 1)
    t2 = threading.Thread(target=worker.run_all,
                          args=([lambda: order.append("broadcast")], W.BROADCAST, 1.0))
    t2.start()
    wait_until(lambda: worker.pending() == 2)
    gate.set()
    for t in (t0, t1, t2):
        t.join(2)
    assert order == ["broadcast", "clone"]


def test_one_generation_at_a_time(worker):
    active, peak, lock = [0], [0], threading.Lock()

    def job():
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.01)
        with lock:
            active[0] -= 1

    threads = [threading.Thread(target=worker.run_all, args=([job, job], W.BROADCAST, 2.0))
               for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(3)
    assert peak[0] == 1


def test_queue_timeout_withdraws_the_request(worker):
    job, started, gate = blocking_job()
    ran = []
    t = threading.Thread(target=worker.run_all, args=([job], W.BROADCAST, 1.0))
    t.start()
    assert started.wait(1)
    with pytest.raises(W.QueueTimeout):
        worker.run_all([lambda: ran.append(1)], W.CLONE, 0.05)
    gate.set()
    t.join(2)
    worker.run_all([lambda: None], W.BROADCAST, 1.0)     # воркер жив, очередь чиста
    assert ran == []


def test_error_reaches_the_caller_and_worker_survives(worker):
    def boom():
        raise RuntimeError("CUDA OOM")
    with pytest.raises(RuntimeError, match="CUDA OOM"):
        worker.run_all([boom], W.BROADCAST, 1.0)
    assert worker.run_all([lambda: "ok"], W.BROADCAST, 1.0) == ["ok"]
