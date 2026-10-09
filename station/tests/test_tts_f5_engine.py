"""f5_engine: синтез идёт мимо штатного пути F5, который пишет эталон на диск.

preprocess_ref_audio_text открывает эталон по пути, экспортирует копию в
NamedTemporaryFile(delete=False), не удаляет её и держит путь в глобальном кэше.
Для эталона владельца digital_me это утечка биометрии на диск gpu-host. Заглушки
ниже роняют тест при любом вызове этого пути.
"""
import concurrent.futures
import sys
import threading
import types
from pathlib import Path

import pytest

np = pytest.importorskip("numpy")      # без него пропускается этот файл, а не весь набор
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tts-f5"))
import f5_engine  # noqa: E402


class FakeTensor:
    def __init__(self, arr):
        self.arr = arr
        self.shape = arr.shape

    def unsqueeze(self, dim):
        return FakeTensor(np.expand_dims(self.arr, dim))


def forbidden(*args, **kwargs):
    raise AssertionError("путь через временный файл на диске")


@pytest.fixture
def f5(monkeypatch):
    calls = {"batch": [], "empty_cache": 0}
    torch = types.ModuleType("torch")
    torch.from_numpy = FakeTensor

    def empty_cache():
        calls["empty_cache"] += 1
    torch.cuda = types.SimpleNamespace(empty_cache=empty_cache, is_available=lambda: True)

    utils = types.ModuleType("f5_tts.infer.utils_infer")

    def infer_batch_process(ref_audio, ref_text, batches, model, vocoder, **kw):
        calls["batch"].append((ref_audio, ref_text, batches, kw))
        yield np.full(2400, 0.1, np.float64), 24000, None
    utils.infer_batch_process = infer_batch_process
    utils.ThreadPoolExecutor = concurrent.futures.ThreadPoolExecutor   # как в utils_infer.py:5
    utils.preprocess_ref_audio_text = forbidden
    utils.infer_process = forbidden
    api = types.ModuleType("f5_tts.api")
    api.F5TTS = types.SimpleNamespace(infer=forbidden)
    for name, mod in [("torch", torch), ("f5_tts", types.ModuleType("f5_tts")),
                      ("f5_tts.infer", types.ModuleType("f5_tts.infer")),
                      ("f5_tts.infer.utils_infer", utils), ("f5_tts.api", api)]:
        monkeypatch.setitem(sys.modules, name, mod)
    return calls


def test_reference_goes_to_f5_as_tensor_not_path(f5):
    eng = f5_engine.Engine("model", "vocoder", "vocos", "cuda")
    wave = eng.synth(np.zeros(24000, np.float32), 24000, "эталон. ", "текст")
    (ref_audio, ref_text, batches, kw), = f5["batch"]
    assert isinstance(ref_audio, tuple) and isinstance(ref_audio[0], FakeTensor)
    assert ref_audio[0].shape == (1, 24000) and ref_audio[1] == 24000
    assert ref_text == "эталон. " and batches == ["текст"]
    assert kw["progress"] is None and kw["device"] == "cuda" and kw["mel_spec_type"] == "vocos"
    assert wave.dtype == np.float32 and len(wave) == 2400
    assert f5["empty_cache"] == 1


def test_empty_result_is_an_error(f5, monkeypatch):
    def nothing(*args, **kwargs):
        yield None, 24000, None
    monkeypatch.setattr(sys.modules["f5_tts.infer.utils_infer"], "infer_batch_process", nothing)
    with pytest.raises(RuntimeError):
        f5_engine.Engine("m", "v", "vocos", "cuda").synth(
            np.zeros(100, np.float32), 24000, "э. ", "т")


def _pooled_infer(utils, ran_in, fail=None):
    """Как infer_batch_process f5-tts 1.1.22 (utils_infer.py:553-556): новый пул на
    каждый вызов, имя ThreadPoolExecutor берётся из модуля в момент вызова."""
    def infer_batch_process(ref_audio, ref_text, batches, model, vocoder, **kw):
        def work():
            ran_in.append(threading.get_ident())
            if fail:
                raise fail
            return np.zeros(10)
        with utils.ThreadPoolExecutor() as executor:
            wave = executor.submit(work).result()
        yield wave, 24000, None
    return infer_batch_process


def test_synthesis_runs_in_callers_thread(f5, monkeypatch):
    """Новый поток на каждый синтез: CUDA/cuBLAS/cuDNN заводят на поток своё
    состояние и не отдают его — +4 МиБ анонимной памяти на запрос при любом тексте
    (замер на gpu-host 2026-09-23), то есть OOM службы меньше чем за сутки эфира."""
    utils = sys.modules["f5_tts.infer.utils_infer"]
    ran_in = []
    monkeypatch.setattr(utils, "infer_batch_process", _pooled_infer(utils, ran_in))
    f5_engine.Engine("m", "v", "vocos", "cuda").synth(np.zeros(100, np.float32), 24000, "э. ", "т")
    assert ran_in == [threading.get_ident()]


def test_synthesis_error_still_reaches_the_caller(f5, monkeypatch):
    utils = sys.modules["f5_tts.infer.utils_infer"]
    monkeypatch.setattr(utils, "infer_batch_process",
                        _pooled_infer(utils, [], fail=RuntimeError("CUDA OOM")))
    with pytest.raises(RuntimeError, match="CUDA OOM"):
        f5_engine.Engine("m", "v", "vocos", "cuda").synth(
            np.zeros(100, np.float32), 24000, "э. ", "т")


def test_dry_engine_needs_no_torch():
    dry = f5_engine.DryEngine()
    wave = dry.synth(np.zeros(100, np.float32), 24000, "э. ", "текст")
    assert wave.dtype == np.float32 and len(wave) > 0
    assert dry.dtype == "dry" and dry.vram() == {}
