# AGENTS.md — station/ (наша часть форка)

Репозиторий — форк perminder-klair/subwave. Корневые `AGENTS.md`, `CLAUDE.md`,
`.claude/skills/` — апстрима: их не правим, они описывают кодовую базу апстрима.
Исключение — настоящая ошибка апстрима, на которой встаёт CI-гейт публикации:
`.claude/skills/subwave-llm-bench/scripts/assess-models.sh` (SC2259, подробно — в
`.claude/rules/radio.md`). Наше — только `station/`, `.claude/rules/radio.md`, блок
в конце `.gitignore` и корневой `.gitattributes`.

Ключевые файлы:
- `station/README.md` — что добавляет форк, раскладка.
- `station/docs/deploy.md` — развёртывание стека.
- `station/docs/station-pitfalls.md` — грабли станции; читать перед правкой
  `station/deploy`, `room`, `tts-*`, `loudness`.
- `station/docs/controller-changes.md`, `web-changes.md` — наши фичи в коде апстрима.

Правила:
- Публичный репозиторий: обезличен **каждый** коммит. Реальные адреса, домены,
  учётки, пути установки, фамилии дикторов — только плейсхолдерами
  (`python station/tools/sanitize.py`, карта вне git); эталоны голосов (`*.wav`) в
  git не идут. Хук pre-commit не обходить (`--no-verify` запрещён).
- Значения установки — из окружения или `station/.env` (шаблон `station/.env.example`),
  без умолчаний, привязанных к конкретной сети.
- На хосте станции не запускать `tsc`, `npm ci`, отдельный `node` — хост уходит в OOM.
  Тесты контроллера — `bash station/run-tests.sh` (в образе), линтер — на рабочей машине.
- Тесты станции: `cd station && python -m pytest` (бюджет 60 с).
- Новая версия апстрима — `git merge vX.Y.Z` в `main`, не rebase.
