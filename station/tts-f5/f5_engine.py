"""Единственный модуль службы, который трогает torch и f5-tts.

Модель грузится без f5_tts.api: там импортируется cached_path, а F5TTS.infer
идёт через preprocess_ref_audio_text — тот открывает эталон по пути, пишет
обработанную копию в NamedTemporaryFile(delete=False), не удаляет её и держит
путь в глобальном кэше. Для эталона владельца digital_me это утечка биометрии на
диск gpu-host. Поэтому синтез — напрямую infer_batch_process с кортежем
(тензор, частота), по одному куску за вызов: так же обходится и его
ThreadPoolExecutor без лимита, из-за которого пик VRAM не ограничен.
"""
import concurrent.futures
import importlib
from importlib import resources

import numpy as np

from f5_audio import SR


class _InlineExecutor:
    """ThreadPoolExecutor, который исполняет задачу сразу в вызывающем потоке.

    infer_batch_process в f5-tts 1.1.22 на каждый вызов заводит новый пул
    (utils_infer.py:553), и синтез шёл в свежем потоке. CUDA, cuBLAS и cuDNN
    заводят на поток своё состояние и не отдают его после выхода потока:
    +4 МиБ анонимной памяти на запрос при любом тексте (замер на gpu-host
    2026-09-23) — при 200 репликах в сутки OOM службы меньше чем за сутки. Наш
    синтез и так идёт из одного постоянного потока-воркера — пусть в нём и остаётся."""

    def __init__(self, *args, **kwargs):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def submit(self, fn, *args, **kwargs):
        future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except BaseException as e:            # noqa: BLE001 — ошибка уходит через result()
            future.set_exception(e)
        return future


class Engine:
    def __init__(self, model, vocoder, mel_spec_type: str, device: str):
        self.model = model
        self.vocoder = vocoder
        self.mel_spec_type = mel_spec_type
        self.device = device

    @classmethod
    def load(cls, model_name, ckpt, vocab, vocos_dir, device="cuda"):
        """Те же шаги, что F5TTS.__init__ (f5_tts/api.py:35-84), без cached_path и hydra."""
        import yaml
        from f5_tts.infer.utils_infer import load_model, load_vocoder
        text = resources.files("f5_tts").joinpath(f"configs/{model_name}.yaml").read_text(
            encoding="utf-8")
        cfg = yaml.safe_load(text)["model"]
        model_cls = getattr(importlib.import_module("f5_tts.model"), cfg["backbone"])
        mel = cfg["mel_spec"]["mel_spec_type"]
        vocoder = load_vocoder(mel, True, str(vocos_dir), device)
        # dtype не передаётся: load_checkpoint сам берёт fp16 на CUDA с архитектурой 7+
        model = load_model(model_cls, cfg["arch"], str(ckpt), mel, str(vocab), "euler", True, device)
        return cls(model, vocoder, mel, device)

    @property
    def dtype(self) -> str:
        return str(next(self.model.parameters()).dtype)

    def synth(self, samples, sr, ref_text, text) -> np.ndarray:
        import torch
        import f5_tts.infer.utils_infer as utils_infer
        from f5_tts.infer.utils_infer import infer_batch_process
        utils_infer.ThreadPoolExecutor = _InlineExecutor   # имя берётся из модуля при вызове
        audio = torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32)).unsqueeze(0)
        try:
            wave, _, _ = next(infer_batch_process(
                (audio, sr), ref_text, [text], self.model, self.vocoder,
                mel_spec_type=self.mel_spec_type, progress=None, device=self.device))
        finally:
            if self.device.startswith("cuda"):
                # кэш аллокатора видит nvidia-smi, а по нему считает бюджет пульт gpu-ctl
                torch.cuda.empty_cache()
        if wave is None:
            raise RuntimeError("F5 не вернул звук")
        return np.asarray(wave, dtype=np.float32)

    def vram(self) -> dict:
        """Счётчики torch — диагностика роста памяти, а не источник vram_gb слота:
        CUDA-контекст (0.4–0.6 ГиБ) и память вне аллокатора в них не входят."""
        import torch
        if not (self.device.startswith("cuda") and torch.cuda.is_available()):
            return {}
        free, total = torch.cuda.mem_get_info()
        mb = 2 ** 20
        return {"vram_free_mb": free // mb, "vram_total_mb": total // mb,
                "vram_allocated_mb": torch.cuda.memory_allocated() // mb,
                "vram_peak_mb": torch.cuda.max_memory_allocated() // mb,
                "vram_reserved_mb": torch.cuda.memory_reserved() // mb}


class DryEngine:
    """Без модели: полсекунды тона на кусок. Проверяет обвязку контейнера —
    HTTP, голоса, RUAccent офлайн, путь /clone — в малой памяти и без карты."""
    device = "cpu"
    dtype = "dry"

    def synth(self, samples, sr, ref_text, text) -> np.ndarray:
        t = np.arange(SR // 2) / SR
        return (0.02 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    def vram(self) -> dict:
        return {}
