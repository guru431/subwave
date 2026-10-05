"""Нарезчик патча по фичам: каждый hunk — ровно одной фиче, подмножества
hunk'ов одного файла накладываются независимо и в сумме дают целый патч."""
import importlib.util
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location("split_patch", ROOT / "tools" / "split_patch.py")
SP = importlib.util.module_from_spec(_spec)
sys.modules["split_patch"] = SP
_spec.loader.exec_module(SP)

TOY = """\
diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,3 @@
 one
-two
+TWO
 three
@@ -10,3 +10,4 @@
 ten
 eleven
+eleven-and-a-half
 twelve
diff --git a/src/b.ts b/src/b.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/b.ts
@@ -0,0 +1,2 @@
+export const b = 1;
+export const c = 2;
"""
A_TS = "".join(f"{w}\n" for w in "one two three four five six seven eight nine ten eleven twelve thirteen".split())


def test_inventory_lists_every_hunk():
    rows = SP.inventory(SP.parse(TOY))
    assert [r.split("\t")[:2] for r in rows] == [["src/a.ts", "#1"], ["src/a.ts", "#2"], ["src/b.ts", "#1"]]
    assert rows[0].split("\t")[3] == "+1/-1"


def test_split_gives_each_feature_its_hunks():
    out = SP.split(SP.parse(TOY), {"F1": ["src/a.ts#1", "src/b.ts"], "F2": ["src/a.ts#2"]})
    assert "+TWO" in out["F1"] and "export const b" in out["F1"]
    assert "eleven-and-a-half" not in out["F1"]
    assert "eleven-and-a-half" in out["F2"] and "+TWO" not in out["F2"]
    assert out["F2"].startswith("diff --git a/src/a.ts b/src/a.ts\n")


@pytest.mark.parametrize("assign, message", [
    ({"F1": ["src/a.ts#1", "src/b.ts"]}, "src/a.ts#2: ни одной фиче"),
    ({"F1": ["src/a.ts", "src/b.ts"], "F2": ["src/a.ts#2"]}, "src/a.ts#2: и F1, и F2"),
    ({"F1": ["src/a.ts", "src/b.ts#1"]}, "новый файл src/b.ts делится только целиком"),
    ({"F1": ["src/a.ts", "src/b.ts", "src/c.ts"]}, "файла src/c.ts в патче нет"),
])
def test_bad_assignment_is_refused(assign, message):
    with pytest.raises(SystemExit) as e:
        SP.split(SP.parse(TOY), assign)
    assert message in str(e.value)


def test_crlf_patch_file_is_read_as_lf(tmp_path):
    p = tmp_path / "x.patch"
    p.write_bytes(TOY.replace("\n", "\r\n").encode("utf-8"))
    assert SP.read_patch(p) == TOY


def test_parts_apply_in_any_order_to_the_same_result(tmp_path):
    def repo(name):
        r = tmp_path / name
        (r / "src").mkdir(parents=True)
        (r / "src" / "a.ts").write_text(A_TS, encoding="utf-8", newline="\n")
        subprocess.run(["git", "init", "-q", str(r)], check=True)
        return r
    whole, parts = repo("whole"), repo("parts")
    (tmp_path / "all.patch").write_text(TOY, encoding="utf-8", newline="\n")
    subprocess.run(["git", "-C", str(whole), "apply", str(tmp_path / "all.patch")], check=True)
    out = SP.split(SP.parse(TOY), {"F1": ["src/a.ts#1", "src/b.ts"], "F2": ["src/a.ts#2"]})
    for name in ("F2", "F1"):                       # обратный порядок — нарочно
        (tmp_path / f"{name}.patch").write_text(out[name], encoding="utf-8", newline="\n")
        subprocess.run(["git", "-C", str(parts), "apply", str(tmp_path / f"{name}.patch")], check=True)
    for f in ("src/a.ts", "src/b.ts"):
        assert (whole / f).read_text(encoding="utf-8") == (parts / f).read_text(encoding="utf-8")
