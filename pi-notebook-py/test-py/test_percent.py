"""The percent format: round trip, real jupytext files, and reconciliation.

The round-trip property is the reason this module needs hypothesis, so the
import is unconditional — a suite that silently skips its only property is
worse than one that fails to start.
"""

import os
import re
import sys
import tempfile
import unittest

from hypothesis import given
from hypothesis import strategies as st

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from nbkernel import Notebook, NotebookError, ParsedCell  # noqa: E402
from nbkernel.source import emit_percent, parse_percent  # noqa: E402

_HEADERISH = re.compile(r"^#\s*%%")

# Lines with no newline, no control characters, and no trailing whitespace:
# `emit_percent` right-strips a markdown line once it has prefixed it, so a
# line ending in a space is not something the format claims to preserve.
_line = (
    st.text(
        alphabet=st.characters(blacklist_categories=("Cs", "Cc")),
        min_size=0,
        max_size=16,
    )
    .map(str.rstrip)
    .filter(lambda s: not _HEADERISH.match(s))
)

# Sources with no leading or trailing blank lines, which is the domain the
# format round-trips over — `parse_percent` strips those by construction.
_src = st.lists(_line, min_size=0, max_size=4).map(lambda ls: "\n".join(ls).strip("\n"))

# A name shares its line with the bracketed cell type and the key="value"
# metadata, so it cannot contain the characters that delimit those.
_name = st.one_of(
    st.none(),
    st.text(alphabet="abcdefghijklmnopqrstuvwxyz0123456789-_ ", min_size=1, max_size=12)
    .map(str.strip)
    .filter(bool),
)

_cell = st.builds(
    ParsedCell,
    src=_src,
    kind=st.sampled_from(["code", "markdown"]),
    name=_name,
    id=st.one_of(st.none(), st.integers(1, 99).map(lambda i: f"c{i}")),
)


class TestRoundTrip(unittest.TestCase):
    @given(st.lists(_cell, min_size=1, max_size=6))
    def test_parse_inverts_emit(self, cells):
        self.assertEqual(parse_percent(emit_percent(cells)), cells)

    @given(st.lists(_cell, min_size=1, max_size=4))
    def test_emitting_twice_is_stable(self, cells):
        once = emit_percent(cells)
        self.assertEqual(emit_percent(parse_percent(once)), once)


class TestParsing(unittest.TestCase):
    def test_a_plain_python_file_is_one_code_cell(self):
        cells = parse_percent("a = 1\nb = 2\n")
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0].src, "a = 1\nb = 2")
        self.assertEqual(cells[0].kind, "code")

    def test_an_empty_file_has_no_cells(self):
        self.assertEqual(parse_percent(""), [])
        self.assertEqual(parse_percent("\n\n  \n"), [])

    def test_a_hand_written_jupytext_file(self):
        cells = parse_percent(
            '# %% setup id="c1"\nimport math\n\n'
            "# %% [markdown]\n# Some prose\n\n"
            "# %%\nmath.pi\n"
        )
        self.assertEqual([c.kind for c in cells], ["code", "markdown", "code"])
        self.assertEqual(cells[0].name, "setup")
        self.assertEqual(cells[0].id, "c1")
        self.assertEqual(cells[1].src, "Some prose")
        self.assertIsNone(cells[2].name)

    def test_yaml_frontmatter_is_not_a_cell(self):
        cells = parse_percent(
            "# ---\n# jupyter:\n#   kernelspec: python3\n# ---\n\n# %%\na = 1\n"
        )
        self.assertEqual(len(cells), 1)
        self.assertEqual(cells[0].src, "a = 1")

    def test_text_above_the_first_header_becomes_a_cell(self):
        cells = parse_percent("import os\n\n# %%\na = 1\n")
        self.assertEqual([c.src for c in cells], ["import os", "a = 1"])

    def test_a_markdown_heading_keeps_its_hash(self):
        cells = parse_percent("# %% [markdown]\n# # Title\n# body\n")
        self.assertEqual(cells[0].src, "# Title\nbody")

    def test_an_unknown_cell_type_falls_back_to_code(self):
        self.assertEqual(parse_percent("# %% [raw]\na = 1\n")[0].kind, "code")

    def test_an_explicitly_empty_cell_survives(self):
        cells = parse_percent("# %%\n\n# %%\na = 1\n")
        self.assertEqual([c.src for c in cells], ["", "a = 1"])


class TestEmitting(unittest.TestCase):
    def test_the_header_order_is_name_type_metadata(self):
        cell = ParsedCell(src="x", kind="markdown", name="notes", id="c7")
        text = emit_percent([cell])
        self.assertEqual(text.splitlines()[0], '# %% notes [markdown] id="c7"')

    def test_code_cells_carry_no_bracketed_type(self):
        text = emit_percent([ParsedCell(src="x", id="c1")])
        self.assertEqual(text.splitlines()[0], '# %% id="c1"')

    def test_cells_are_separated_by_one_blank_line(self):
        text = emit_percent(
            [ParsedCell(src="a", id="c1"), ParsedCell(src="b", id="c2")]
        )
        self.assertEqual(text, '# %% id="c1"\na\n\n# %% id="c2"\nb\n')


class TestNotebookPersistence(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def path(self, name="nb.py") -> str:
        return os.path.join(self.directory.name, name)

    def saved(self) -> tuple[Notebook, str]:
        nb = Notebook()
        nb.add("a = 1", name="setup")
        nb.add("b = a + 1")
        nb.add("b")
        nb.run_all()
        path = self.path()
        nb.save(path)
        return nb, path

    def test_save_then_load_into_a_new_notebook(self):
        _, path = self.saved()
        other = Notebook()
        other.load(path)
        self.assertEqual([c.src for c in other.cells], ["a = 1", "b = a + 1", "b"])
        self.assertEqual(other.cells[0].name, "setup")
        # No outputs in the format, so everything comes back unrun.
        self.assertEqual(other.unrun(), ["c1", "c2", "c3"])
        self.assertEqual(other.stale(), [])

    def test_a_loaded_notebook_reproduces_its_values(self):
        nb, path = self.saved()
        other = Notebook()
        other.load(path)
        other.run_all()
        self.assertEqual(other.cells[-1].last.value, nb.cells[-1].last.value)

    def test_reloading_an_untouched_file_keeps_every_output(self):
        nb, path = self.saved()
        counts = [c.execution_count for c in nb.cells]
        nb.load(path)
        self.assertEqual([c.execution_count for c in nb.cells], counts)
        self.assertEqual((nb.unrun(), nb.stale()), ([], []))

    def test_a_cell_edited_on_disk_keeps_its_id_and_becomes_unrun(self):
        nb, path = self.saved()
        with open(path) as handle:
            text = handle.read()
        with open(path, "w") as handle:
            handle.write(text.replace("b = a + 1", "b = a + 100"))
        nb.load(path)
        self.assertEqual([c.id for c in nb.cells], ["c1", "c2", "c3"])
        self.assertEqual(nb.unrun(), ["c2"])
        self.assertEqual(nb.stale(), ["c3"])

    def test_a_cell_deleted_on_disk_disappears(self):
        nb, path = self.saved()
        with open(path) as handle:
            kept = [b for b in handle.read().split("\n\n") if "b = a + 1" not in b]
        with open(path, "w") as handle:
            handle.write("\n\n".join(kept))
        nb.load(path)
        self.assertEqual([c.id for c in nb.cells], ["c1", "c3"])

    def test_ids_adopted_from_a_file_are_not_handed_out_again(self):
        path = self.path()
        with open(path, "w") as handle:
            handle.write('# %% id="c9"\na = 1\n')
        nb = Notebook()
        nb.load(path)
        self.assertEqual([c.id for c in nb.cells], ["c9"])
        self.assertEqual(nb.add("b = 2").id, "c10")

    def test_save_refuses_to_clobber_a_plain_python_file(self):
        path = self.path("module.py")
        with open(path, "w") as handle:
            handle.write("def important():\n    return 1\n")
        nb = Notebook()
        nb.add("a = 1")
        with self.assertRaises(NotebookError):
            nb.save(path)
        with open(path) as handle:
            self.assertIn("important", handle.read())

    def test_save_overwrites_a_plain_file_when_told_to(self):
        path = self.path("module.py")
        with open(path, "w") as handle:
            handle.write("x = 1\n")
        nb = Notebook()
        nb.add("a = 1")
        nb.save(path, overwrite=True)
        with open(path) as handle:
            self.assertIn("# %%", handle.read())

    def test_save_replaces_an_existing_notebook_without_a_flag(self):
        nb, path = self.saved()
        nb.add("c = 3")
        nb.save(path)  # no overwrite needed: it is already a notebook
        other = Notebook()
        other.load(path)
        self.assertEqual(len(other.cells), 4)

    def test_load_reports_a_missing_file(self):
        with self.assertRaises(NotebookError):
            Notebook().load(self.path("absent.py"))


if __name__ == "__main__":
    unittest.main()
