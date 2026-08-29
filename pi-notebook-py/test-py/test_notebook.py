"""Stdlib-only tests for the notebook kernel. Run with:

    python3 -m unittest discover -s test-py

No third-party packages required.
"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from nbkernel import CellNotFound, Notebook, NotebookError, brief  # noqa: E402
from protocol import bootstrap_path, handle  # noqa: E402


def notebook(*sources: str) -> Notebook:
    nb = Notebook()
    for src in sources:
        nb.add(src)
    return nb


def ran(nb: Notebook) -> Notebook:
    nb.run_all()
    return nb


class TestOrdering(unittest.TestCase):
    def test_add_appends_by_default(self):
        nb = notebook("a = 1", "b = 2")
        self.assertEqual([c.src for c in nb.cells], ["a = 1", "b = 2"])

    def test_add_after_a_cell(self):
        nb = notebook("a", "c")
        nb.add("b", after="c1")
        self.assertEqual([c.src for c in nb.cells], ["a", "b", "c"])

    def test_add_at_start(self):
        nb = notebook("b")
        nb.add("a", after="start")
        self.assertEqual([c.src for c in nb.cells], ["a", "b"])

    def test_add_after_unknown_cell_is_an_error(self):
        with self.assertRaises(CellNotFound):
            notebook("a").add("b", after="nope")

    def test_ids_are_never_reused(self):
        nb = Notebook()
        first = nb.add("1")
        nb.delete(first.id)
        self.assertNotEqual(nb.add("2").id, first.id)

    def test_move_reorders(self):
        nb = notebook("a", "b", "c")
        nb.move("c3", "start")
        self.assertEqual([c.id for c in nb.cells], ["c3", "c1", "c2"])

    def test_a_failed_move_leaves_the_order_alone(self):
        nb = notebook("a", "b")
        with self.assertRaises(CellNotFound):
            nb.move("c1", "nope")
        self.assertEqual([c.id for c in nb.cells], ["c1", "c2"])

    def test_rejects_an_unknown_kind(self):
        with self.assertRaises(NotebookError):
            Notebook().add("x", kind="raw")


class TestExecution(unittest.TestCase):
    def test_cells_share_one_namespace(self):
        nb = ran(notebook("x = 2", "y = x * 3", "y"))
        self.assertEqual(nb.cells[-1].last.value, "6")

    def test_trailing_expression_is_the_display_value(self):
        nb = ran(notebook("1 + 1"))
        self.assertEqual(nb.cells[0].last.value, "2")

    def test_a_cell_ending_in_a_statement_displays_nothing(self):
        nb = ran(notebook("z = 1 + 1"))
        self.assertEqual(nb.cells[0].last.value, "None")

    def test_stdout_is_captured_not_leaked(self):
        nb = ran(notebook("print('hello')"))
        self.assertEqual(nb.cells[0].last.stdout, "hello\n")

    def test_execution_count_advances_per_run(self):
        nb = ran(notebook("a = 1", "b = 2"))
        self.assertEqual([c.execution_count for c in nb.cells], [1, 2])
        nb.run_cell("c1")
        self.assertEqual(nb.cell("c1").execution_count, 3)

    def test_markdown_cells_never_execute(self):
        nb = Notebook()
        nb.add("not python at all", kind="markdown")
        self.assertEqual(nb.run_all(), [])

    def test_empty_cells_are_skipped(self):
        nb = Notebook()
        nb.add("   \n  ")
        self.assertEqual(nb.run_all(), [])

    def test_run_above_is_exclusive(self):
        nb = notebook("a = 1", "b = 2", "c = 3")
        self.assertEqual([o.cell for o in nb.run_above("c3")], ["c1", "c2"])

    def test_run_below_is_inclusive(self):
        nb = notebook("a = 1", "b = 2", "c = 3")
        self.assertEqual([o.cell for o in nb.run_below("c2")], ["c2", "c3"])

    def test_restart_clears_the_namespace(self):
        nb = ran(notebook("q = 7"))
        nb.restart()
        self.assertEqual(nb.eval_src("q").status, "error")
        self.assertIsNone(nb.cell("c1").execution_count)

    def test_run_all_restarts_by_default(self):
        nb = ran(notebook("acc = [1]"))
        nb.eval_src("acc.append(2)")
        nb.run_all()
        self.assertEqual(nb.eval_src("acc").value, "[1]")

    def test_run_all_without_restart_keeps_the_namespace(self):
        nb = ran(notebook("a = 1"))
        nb.eval_src("survivor = 9")
        nb.run_all(restart=False)
        self.assertEqual(nb.eval_src("survivor").value, "9")

    def test_eval_creates_no_cell_and_advances_nothing(self):
        nb = ran(notebook("a = 1"))
        before = nb.cell("c1").execution_count
        self.assertEqual(nb.eval_src("a + 1").value, "2")
        self.assertEqual(len(nb.cells), 1)
        self.assertEqual(nb.cell("c1").execution_count, before)


class TestFailure(unittest.TestCase):
    def test_a_failing_cell_stops_the_run(self):
        nb = notebook("a = 1", "1 / 0", "unreachable = True")
        statuses = [(o.cell, o.status) for o in nb.run_all()]
        self.assertEqual(statuses, [("c1", "ok"), ("c2", "error")])
        self.assertEqual(nb.failing(), ["c2"])
        self.assertEqual(nb.unrun(), ["c3"])

    def test_cells_above_the_failure_keep_their_values(self):
        nb = notebook("a = 1", "1 / 0")
        nb.run_all()
        self.assertEqual(nb.cell("c1").last.status, "ok")
        self.assertEqual(nb.eval_src("a").value, "1")

    def test_the_traceback_names_the_cell_and_shows_the_line(self):
        nb = ran(notebook("def boom():\n    raise ValueError('nope')\nboom()"))
        traceback = nb.cell("c1").last.traceback
        self.assertIn("<cell c1>", traceback)
        self.assertIn("raise ValueError('nope')", traceback)
        # The kernel's own exec frame is not part of the cell's story.
        self.assertNotIn("run_cell", traceback)

    def test_a_syntax_error_is_a_cell_failure_not_a_kernel_one(self):
        nb = ran(notebook("def ("))
        self.assertEqual(nb.cell("c1").last.status, "error")
        self.assertIn("SyntaxError", nb.cell("c1").last.error)

    def test_sys_exit_does_not_take_the_kernel_down(self):
        nb = ran(notebook("import sys; sys.exit(1)", "after = True"))
        self.assertEqual(nb.cell("c1").last.status, "error")
        self.assertEqual(nb.unrun(), ["c2"])

    def test_a_fixed_cell_stops_failing(self):
        nb = ran(notebook("1 / 0"))
        nb.set("c1", "1 / 1")
        nb.run_cell("c1")
        self.assertEqual(nb.failing(), [])


class TestStaleness(unittest.TestCase):
    """The two invariants the whole model rests on."""

    def test_run_all_leaves_nothing_stale(self):
        nb = ran(notebook("a = 1", "b = a", "c = b", "d = c"))
        self.assertEqual(nb.stale(), [])
        self.assertEqual(nb.unrun(), [])

    def test_editing_a_cell_marks_exactly_the_cells_below_it(self):
        nb = ran(notebook("a = 1", "b = 2", "c = 3", "d = 4", "e = 5"))
        nb.set("c2", "b = 20")
        self.assertEqual(nb.stale(), ["c3", "c4", "c5"])
        # The edited cell is unrun, not stale: the two are disjoint.
        self.assertEqual(nb.unrun(), ["c2"])

    def test_a_fresh_notebook_has_no_staleness_only_unrun(self):
        nb = notebook("a = 1", "b = 2")
        self.assertEqual(nb.stale(), [])
        self.assertEqual(nb.unrun(), ["c1", "c2"])

    def test_setting_identical_source_invalidates_nothing(self):
        nb = ran(notebook("a = 1", "b = 2"))
        nb.set("c1", "a = 1")
        self.assertEqual((nb.stale(), nb.unrun()), ([], []))

    def test_rerunning_the_edited_cell_does_not_clear_the_cells_below(self):
        nb = ran(notebook("a = 1", "b = a", "c = b"))
        nb.set("c1", "a = 99")
        nb.run_cell("c1")
        self.assertEqual(nb.unrun(), [])
        self.assertEqual(nb.stale(), ["c2", "c3"])

    def test_deleting_a_cell_marks_everything_from_the_hole_down(self):
        nb = ran(notebook("a = 1", "b = 2", "c = 3", "d = 4"))
        nb.delete("c2")
        self.assertEqual(nb.stale(), ["c3", "c4"])

    def test_deleting_the_first_cell_marks_all_the_rest(self):
        nb = ran(notebook("a = 1", "b = 2", "c = 3"))
        nb.delete("c1")
        self.assertEqual(nb.stale(), ["c2", "c3"])

    def test_deleting_the_last_cell_marks_nothing(self):
        nb = ran(notebook("a = 1", "b = 2"))
        nb.delete("c2")
        self.assertEqual(nb.stale(), [])

    def test_moving_a_cell_makes_it_unrun_and_disturbs_the_span(self):
        nb = ran(notebook("a = 1", "b = 2", "c = 3"))
        nb.move("c3", "start")
        self.assertEqual(nb.unrun(), ["c3"])
        self.assertEqual(nb.stale(), ["c1", "c2"])

    def test_inserting_a_cell_stales_everything_below_the_insertion(self):
        # Even before the new cell runs: the notebook no longer reproduces
        # c2's recorded value, because a run_all would execute c3 first.
        nb = ran(notebook("a = 1", "b = 2"))
        nb.add("mid = 0", after="c1")
        self.assertEqual(nb.stale(), ["c2"])
        self.assertEqual(nb.unrun(), ["c3"])

    def test_appending_a_cell_stales_nothing(self):
        nb = ran(notebook("a = 1", "b = 2"))
        nb.add("c = 3")
        self.assertEqual(nb.stale(), [])

    def test_restart_makes_everything_unrun_and_nothing_stale(self):
        nb = ran(notebook("a = 1", "b = 2"))
        nb.set("c1", "a = 2")
        nb.restart()
        self.assertEqual(nb.stale(), [])
        self.assertEqual(nb.unrun(), ["c1", "c2"])

    def test_markdown_and_empty_cells_are_never_unrun(self):
        nb = Notebook()
        nb.add("prose", kind="markdown")
        nb.add("")
        self.assertEqual(nb.unrun(), [])


class TestIntrospection(unittest.TestCase):
    def test_describe_reports_one_state_per_cell(self):
        nb = ran(notebook("a = 1", "b = 2", "1 / 0"))
        nb.set("c1", "a = 9")
        states = {c["id"]: c["state"] for c in nb.describe()["cells"]}
        self.assertEqual(states, {"c1": "unrun", "c2": "stale", "c3": "failing"})

    def test_globals_skip_underscored_names(self):
        nb = ran(notebook("shown = 1\n_hidden = 2"))
        self.assertEqual(list(nb.globals()), ["shown"])

    def test_read_returns_full_source(self):
        nb = notebook("line one\nline two")
        self.assertEqual(nb.read("c1")[0]["src"], "line one\nline two")

    def test_preview_is_the_first_non_blank_line(self):
        nb = notebook("\n\nreal = 1\nmore = 2")
        self.assertEqual(nb.describe()["cells"][0]["preview"], "real = 1")


class TestBrief(unittest.TestCase):
    """The display value is the cell's output, so `brief` shows contents
    wherever they fit — describing them is the fallback, not the rule."""

    def test_a_string_shows_its_contents(self):
        self.assertEqual(brief("Agg"), "'Agg'")

    def test_a_small_container_shows_its_contents(self):
        self.assertEqual(brief([1, 2, 3]), "[1, 2, 3]")
        self.assertEqual(brief({"a": 1}), "{'a': 1}")

    def test_a_long_value_is_truncated_with_a_marker(self):
        text = brief("x" * 500)
        self.assertTrue(text.endswith("..."))
        self.assertLess(len(text), 140)

    def test_a_huge_container_is_described_not_built(self):
        self.assertEqual(brief(list(range(10_000))), "list(10000)")

    def test_a_module_shows_its_name_not_its_path(self):
        import json as json_module

        self.assertEqual(brief(json_module), "module 'json'")

    def test_a_shaped_value_shows_its_shape(self):
        class Frame:
            shape = (3, 4)

        self.assertEqual(brief(Frame()), "Frame(3, 4)")

    def test_a_broken_repr_does_not_sink_the_response(self):
        class Hostile:
            def __repr__(self):
                raise RuntimeError("no")

        self.assertIn("unreprable", brief(Hostile()))


class TestProtocol(unittest.TestCase):
    """The wire: every response must be JSON, and errors must not kill it."""

    def setUp(self):
        self.nb = Notebook()

    def call(self, **req) -> dict:
        response = handle(self.nb, req)
        json.dumps(response)  # the wire is JSON-lines; unserialisable is fatal
        return response

    def test_add_returns_the_new_id_and_the_hints(self):
        response = self.call(tool="add_cell", src="a = 1")
        self.assertTrue(response["ok"])
        self.assertEqual(response["id"], "c1")
        for key in ("results", "stale", "unrun", "failing", "globals"):
            self.assertIn(key, response)

    def test_run_false_stages_without_executing(self):
        response = self.call(tool="add_cell", src="a = 1", run=False)
        self.assertEqual(response["results"], [])
        self.assertEqual(response["unrun"], ["c1"])

    def test_a_cell_error_is_a_result_not_a_protocol_error(self):
        response = self.call(tool="add_cell", src="1 / 0")
        self.assertTrue(response["ok"])
        self.assertEqual(response["results"][0]["status"], "error")

    def test_an_unknown_cell_is_an_expected_error(self):
        response = self.call(tool="run_cell", id="nope")
        self.assertFalse(response["ok"])
        self.assertNotIn("internal", response)
        self.assertIn("nope", response["error"])

    def test_an_unknown_tool_is_reported_not_raised(self):
        self.assertFalse(self.call(tool="frobnicate")["ok"])

    def test_a_missing_argument_names_the_argument(self):
        response = self.call(tool="add_cell")  # no src
        self.assertFalse(response["ok"])
        self.assertNotIn("internal", response)
        self.assertIn("src", response["error"])

    def test_eval_does_not_go_through_the_cell_list(self):
        self.call(tool="add_cell", src="a = 4")
        response = self.call(tool="eval", src="a * 2")
        self.assertEqual(response["value"], "8")
        self.assertEqual(len(self.nb.cells), 1)

    def test_inspect_carries_the_hints_too(self):
        self.call(tool="add_cell", src="a = 1", run=False)
        response = self.call(tool="inspect")
        self.assertEqual(response["unrun"], ["c1"])
        self.assertEqual(len(response["cells"]), 1)

    def test_save_and_load_round_trip_over_the_wire(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "nb.py")
            self.call(tool="add_cell", src="a = 1")
            self.assertTrue(self.call(tool="save", path=path)["ok"])
            other = Notebook()
            response = handle(other, {"tool": "load", "path": path})
            self.assertEqual(response["loaded"]["cells"], 1)
            self.assertEqual(other.cells[0].src, "a = 1")

    def test_load_refuses_a_missing_file(self):
        response = self.call(tool="load", path="/nonexistent/nb.py")
        self.assertFalse(response["ok"])
        self.assertNotIn("internal", response)


class TestBootstrapPath(unittest.TestCase):
    """`__main__` only calls this, so the cases drive it directly.

    Each restores sys.path: the kernel mutates the interpreter it is about
    to serve from, whereas here it is the test runner's own.
    """

    def setUp(self):
        saved = list(sys.path)
        self.addCleanup(lambda: sys.path.__setitem__(slice(None), saved))

    def test_puts_the_directory_first(self):
        # First, not appended: a project's own module has to win, which is
        # the whole point and also where the shadowing cost comes from.
        bootstrap_path("/somewhere/project")
        self.assertEqual(sys.path[0], "/somewhere/project")

    def test_defaults_to_the_working_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            here = os.getcwd()
            os.chdir(directory)
            self.addCleanup(os.chdir, here)
            bootstrap_path()
            # macOS hands out /var -> /private/var, so compare resolved.
            self.assertEqual(os.path.realpath(sys.path[0]), os.path.realpath(directory))

    def test_is_idempotent(self):
        bootstrap_path("/somewhere/project")
        bootstrap_path("/somewhere/project")
        self.assertEqual(sys.path.count("/somewhere/project"), 1)


if __name__ == "__main__":
    unittest.main()
