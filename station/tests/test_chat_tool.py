"""Навык chat (skills/chat/tool.mjs) — JavaScript, его тест на node:test
(chat_tool.test.mjs) запускается отсюда, чтобы идти в быстром наборе станции.
Без node — skip: навык исполняет контроллер, у станции своего node нет."""
import shutil
import subprocess
from pathlib import Path

import pytest

SUITE = Path(__file__).with_name("chat_tool.test.mjs")


def test_chat_tool_node_suite():
    node = shutil.which("node")
    if not node:
        pytest.skip("node не найден")
    r = subprocess.run([node, "--test", str(SUITE)], capture_output=True,
                       text=True, encoding="utf-8", errors="replace", timeout=25)
    assert r.returncode == 0, r.stdout + r.stderr
