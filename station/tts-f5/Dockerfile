# F5-TTS на gpu-host. База — vllm/vllm-openai:v0.27.1: уже лежит на gpu-host (слоты
# ocr, ocr-cand, tts-qwen), torch 2.13+cu130 собран с sm_120 (RTX 5060 Ti,
# Blackwell), пакеты ставятся pip в системный Python, как у qwen3-tts:local.
# Слоёв Chatterbox в ней нет — после миграции его образ удаляется целиком.
FROM vllm/vllm-openai:v0.27.1

# у базы ENTRYPOINT ["vllm","serve"]
ENTRYPOINT []
WORKDIR /app

# Версии того, что уже в базе, прибиваются: иначе резолвер вправе заменить torch
# сборкой с PyPI без ядер sm_120. Сборки +cu130 живут только на индексе PyTorch —
# без него прибитая версия неразрешима (грабля 2026-09-22).
RUN python3 -c "import torch, torchaudio, numpy, transformers, safetensors, huggingface_hub as h; print(f'torch=={torch.__version__}'); print(f'torchaudio=={torchaudio.__version__}'); print(f'numpy=={numpy.__version__}'); print(f'transformers=={transformers.__version__}'); print(f'safetensors=={safetensors.__version__}'); print(f'huggingface-hub=={h.__version__}')" > /tmp/pin.txt \
 && cat /tmp/pin.txt

COPY requirements.txt /app/requirements.txt
# Сеть контейнеров за NAT Docker Desktop рвёт загрузки: кэш pip переживает
# повтор, попыток пять.
RUN --mount=type=cache,target=/root/.cache/pip \
    ok=0; for i in 1 2 3 4 5; do \
      if pip install --retries 10 --timeout 120 -c /tmp/pin.txt \
           --extra-index-url https://download.pytorch.org/whl/cu130 \
           -r /app/requirements.txt; then ok=1; break; fi; \
      echo "pip attempt $i failed, retrying"; sleep 15; \
    done; test "$ok" = 1
RUN pip install --retries 10 --no-deps f5-tts==1.1.22 \
 && python3 -c "import f5_tts.infer.utils_infer, f5_tts.model, ruaccent, soundfile, pydub, multipart, yaml, num2words; print('imports ok')"

# koziev (POS-теггер и лемматизатор RuleEngine) в колесо ruaccent не входит, а
# RUAccent.load ищет его в каталоге пакета, не в workdir (ruaccent.py:82-87), и без
# него лезет в Hugging Face: при HF_HUB_OFFLINE=1 служба не стартовала бы даже с
# F5_ENGINE=dry. Копия — из венва SuperTonic, где RUAccent той же версии докачал его
# сам; в контекст сборки её кладёт задача 9 плана. Проверка грузит оба словаря —
# без неё поломка всплыла бы только на старте контейнера. sqlite молча создаёт
# пустую базу на месте пропавшей, поэтому её наличие проверяется отдельно.
RUN --mount=type=bind,source=ruaccent-koziev,target=/tmp/koziev \
    d="$(python3 -c 'import os, ruaccent; print(os.path.dirname(ruaccent.__file__))')" \
 && cp -r /tmp/koziev "$d/koziev" \
 && test -s "$d/koziev/rupostagger/database/ruword2tags.db" \
 && python3 -c "import ruaccent.rule_accent_engine; from ruaccent.koziev.rulemma.rulemma import Lemmatizer; from ruaccent.koziev.rupostagger import RuPosTagger; Lemmatizer().load(); RuPosTagger().load(); print('koziev ok')"

# pronunciation.json — словарь латиницы коллекции для f5_text; без него служба
# стартует, но читает английские имена по-русски
COPY f5_audio.py f5_text.py f5_numbers.py f5_worker.py f5_accent.py f5_voices.py f5_engine.py f5_service.py server.py pronunciation.json /app/
ENV PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1 \
    PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
EXPOSE 4126
CMD ["python3", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "4126"]
