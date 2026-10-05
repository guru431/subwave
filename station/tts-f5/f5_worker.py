"""Одна генерация на карте за раз, эфир — вперёд digital_me.

Один поток-воркер и очередь с приоритетом. Каждый кусок текста — отдельное
задание: длинный абзац /clone не держит реплику эфира дольше одного куска.
"""
import heapq
import itertools
import threading

BROADCAST, CLONE = 0, 1


class QueueTimeout(Exception):
    """Первое задание запроса не начало исполняться за отведённое время."""


class _Job:
    __slots__ = ("fn", "started", "cancelled", "done", "result", "error")

    def __init__(self, fn):
        self.fn = fn
        self.started = False
        self.cancelled = False
        self.done = threading.Event()
        self.result = None
        self.error = None


class Worker:
    def __init__(self):
        self._heap = []
        self._seq = itertools.count()
        self._cv = threading.Condition()
        self.jobs_done = 0
        threading.Thread(target=self._loop, name="f5-worker", daemon=True).start()

    def pending(self) -> int:
        with self._cv:
            return sum(1 for _, _, job in self._heap if not job.cancelled)

    def _loop(self):
        while True:
            with self._cv:
                while not self._heap:
                    self._cv.wait()
                _, _, job = heapq.heappop(self._heap)
                if job.cancelled:
                    continue
                job.started = True
                self._cv.notify_all()
            try:
                job.result = job.fn()
            except BaseException as e:           # noqa: BLE001 — ошибка уходит тому, кто ждёт
                job.error = e
            finally:
                job.done.set()
                with self._cv:
                    self.jobs_done += 1

    def run_all(self, fns, priority, wait_s):
        """Поставить все куски запроса разом и дождаться всех по порядку.

        Если первый кусок не начал исполняться за wait_s — снимаются все, и
        QueueTimeout. Ошибка куска снимает ещё не начатые и поднимается наружу."""
        jobs = [_Job(fn) for fn in fns]
        with self._cv:
            for job in jobs:
                heapq.heappush(self._heap, (priority, next(self._seq), job))
            self._cv.notify_all()
            if jobs and not self._cv.wait_for(lambda: jobs[0].started, timeout=wait_s):
                for job in jobs:
                    job.cancelled = True
                raise QueueTimeout(f"очередь не разошлась за {wait_s:.0f} с")
        results = []
        for job in jobs:
            job.done.wait()
            if job.error is not None:
                with self._cv:
                    for rest in jobs:
                        if not rest.started:
                            rest.cancelled = True
                raise job.error
            results.append(job.result)
        return results
