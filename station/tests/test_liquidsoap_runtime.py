"""Offline mixer regressions on the installed Liquidsoap version.

Set LIQUIDSOAP_TEST_COMMAND to a Liquidsoap stdin command, e.g. a local
`liquidsoap -` or SSH + `docker exec -i ... liquidsoap -`. The harness replaces
file IPC and queues in its own process; it never accesses broadcast state.
"""
import os
import re
import shlex
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.integration
SOURCE = Path(__file__).resolve().parents[2] / "liquidsoap" / "radio.liq"


def function(name):
    source = SOURCE.read_text(encoding="utf-8")
    return re.search(rf"^def {name}\(.*?^end$", source, re.M | re.S).group(0)


def run_harness(code):
    command = os.environ.get("LIQUIDSOAP_TEST_COMMAND")
    if not command:
        pytest.skip("set LIQUIDSOAP_TEST_COMMAND for the offline mixer harness")
    result = subprocess.run(shlex.split(command), input=code + "\nexit(0)\n", text=True,
                            encoding="utf-8", capture_output=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "HARNESS_OK" in result.stdout


def test_file_pollers_survive_a_read_failure_and_accept_the_next_item():
    code = '''
settings.init.allow_root := true
state_dir = "/fixture"
fixture_error = error.register("fixture")
failing = ref(true)
queued = ref(0)
def fixture_exists(_) = true end
def fixture_contents(_) = if failing() then error.raise(fixture_error, "read denied") else "fixture.mp3" end end
def fixture_remove(_) = () end
def fixture_create(uri) = uri end
dj_queue = {push = fun(_) -> begin queued := queued() + 1; 0 end}
jingle_now_queue = dj_queue
voice_queue = dj_queue
intro_queue = dj_queue
sfx_queue = dj_queue
has_leadin = false
leadin_path = ""
def write_pause_voice_accepted(_) = () end
def redact_subhttp_uri(uri) = uri end
'''
    names = ["poll_queue", "poll_jingle_now", "poll_voice", "poll_intro", "poll_sfx"]
    pollers = "\n".join(function(name) for name in names)
    for original, replacement in [("file.exists", "fixture_exists"),
                                  ("file.contents", "fixture_contents"),
                                  ("file.remove", "fixture_remove"),
                                  ("request.create", "fixture_create")]:
        pollers = pollers.replace(original, replacement)
    code += pollers + "\n"
    for name in names:
        code += f"failing := true\n{name}()\nfailing := false\n{name}()\n"
    code += 'assert(queued() == 5)\nprint("HARNESS_OK")\n'
    run_harness(code)


def test_uncollected_probe_results_are_bounded_and_consumed_once():
    code = "settings.init.allow_root := true\nsubhttp_probe_outcomes = ref([])\n"
    code += "\n".join(function(name) for name in [
        "subhttp_probe_id", "remember_subhttp_outcome", "take_subhttp_outcome"]) + "\n"
    code += '''
for i = 0 to 300 do
  remember_subhttp_outcome("http://fixture/#subwave_probe=#{i}", "ready")
end
assert(list.length(subhttp_probe_outcomes()) == 256)
assert(take_subhttp_outcome("0") == "pending")
assert(take_subhttp_outcome("300") == "ready")
assert(take_subhttp_outcome("300") == "pending")
print("HARNESS_OK")
'''
    run_harness(code)
