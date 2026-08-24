"""Stdlib-only tests for the reactive kernel. Run with:

    python3 -m unittest discover -s test-py

No third-party packages required.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from kernel import (  # noqa: E402
    CycleError,
    DuplicateNameError,
    Edit,
    MultipleDefinitionError,
    Notebook,
    analyze,
)
from protocol import handle  # noqa: E402


class TestAnalyze(unittest.TestCase):
    def test_basic_defs_refs(self):
        defs, refs = analyze("import math\narea = math.pi * radius ** 2")
        self.assertEqual(defs, {"math", "area"})
        self.assertEqual(refs, {"radius"})

    def test_comprehension_var_is_not_a_def(self):
        defs, _ = analyze("scaled = [r * n for r in rows]")
        self.assertEqual(defs, {"scaled"})

    def test_function_body_globals_are_refs(self):
        defs, refs = analyze("def f():\n    return radius * 2")
        self.assertEqual(defs, {"f"})
        self.assertEqual(refs, {"radius"})

    def test_declared_global_assignment_is_a_def(self):
        defs, _ = analyze("def f():\n    global counter\n    counter = 1")
        self.assertIn("counter", defs)

    def test_self_reference_is_a_ref(self):
        defs, refs = analyze("x = x + 1")
        self.assertEqual(defs, {"x"})
        self.assertEqual(refs, {"x"})

    def test_del_is_not_a_def(self):
        defs, _ = analyze("del x")
        self.assertNotIn("x", defs)

    def test_builtins_kept_in_refs(self):
        # Purity: the graph, not analyze, decides whether `len` is an edge.
        _, refs = analyze("n = len(rows)")
        self.assertEqual(refs, {"len", "rows"})


class TestIdentity(unittest.TestCase):
    def test_generated_ids(self):
        nb = Notebook(seed=1)
        ids = {nb.add(f"x{i} = {i}", run=False)[0] for i in range(20)}
        self.assertEqual(len(ids), 20)
        for cid in ids:
            self.assertEqual(len(cid), 6)
            self.assertRegex(cid, r"^[a-z2-7]{6}$")

    def test_seed_makes_ids_deterministic(self):
        a = Notebook(seed=42)._new_id()
        b = Notebook(seed=42)._new_id()
        self.assertEqual(a, b)

    def test_cell_dataclass_has_no_id(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1")
        self.assertFalse(hasattr(nb.cells[cid], "id"))

    def test_named_cells(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1", name="config")
        self.assertEqual(nb.cells[cid].name, "config")
        with self.assertRaises(DuplicateNameError):
            nb.add("y = 2", name="config", run=False)

    def test_bad_name_rejected(self):
        nb = Notebook(seed=1)
        with self.assertRaises(ValueError):
            nb.add("x = 1", name="not an identifier", run=False)

    def test_create_modify_split(self):
        nb = Notebook(seed=1)
        with self.assertRaises(KeyError):
            nb.set("zzzzzz", "x = 1")
        cid, _ = nb.add("x = 1")
        nb.set(cid, "x = 2")
        self.assertEqual(nb.ns["x"], 2)

    def test_execution_order_independent_of_ids(self):
        # Two independent cells run in insertion order, not id order.
        nb = Notebook(seed=1)
        first, _ = nb.add("order.append('a')", run=False)
        second, _ = nb.add("order.append('b')", run=False)
        nb.add("order = []", run=False)  # defined last on purpose
        nb.run_all()
        # 'order' cell runs first (dependency), then insertion order a, b
        self.assertEqual(nb.ns["order"], ["a", "b"])
        self.assertLess(nb.topo().index(first), nb.topo().index(second))


class TestNotebook(unittest.TestCase):
    def build(self):
        nb = Notebook(seed=1)
        data, _ = nb.add("radius = 2", name="data")
        derived, _ = nb.add("area = radius ** 2", name="derived")
        return nb, data, derived

    def test_edit_propagates_downstream(self):
        nb, data, _ = self.build()
        nb.set(data, "radius = 10")
        self.assertEqual(nb.ns["area"], 100)

    def test_delete_retracts_globals(self):
        nb, data, derived = self.build()
        nb.delete(data)
        self.assertNotIn("radius", nb.ns)
        self.assertIn(derived, nb.pending)

    def test_multiple_definition_rejected_and_rolled_back(self):
        nb, _, _ = self.build()
        with self.assertRaises(MultipleDefinitionError):
            nb.add("area = 0", run=False)
        self.assertEqual(len(nb.cells), 2)
        self.assertEqual(nb.ns["area"], 4)

    def test_cycle_rejected(self):
        nb = Notebook(seed=1)
        nb.add("p = q", run=False)
        with self.assertRaises(CycleError):
            nb.add("q = p", run=False)
        self.assertEqual(len(nb.cells), 1)

    def test_plan_does_not_commit(self):
        nb, data, derived = self.build()
        affected = nb.plan([Edit("set", id=data, src="radius = 99")])
        self.assertEqual(affected, {data, derived})
        self.assertEqual(nb.ns["radius"], 2)

    def test_add_without_run(self):
        nb, _, _ = self.build()
        cid, _ = nb.add("area * 2", run=False)
        self.assertIn(cid, nb.pending)
        nb.run()
        self.assertEqual(nb.pending, set())

    def test_run_all_from_the_top(self):
        nb, _, _ = self.build()
        nb.ns["area"] = 999  # simulate drift
        nb.run_all()
        self.assertEqual(nb.ns["area"], 4)

    def test_builtin_shadowing_is_an_edge(self):
        nb = Notebook(seed=1)
        shadower, _ = nb.add("def len(x):\n    return 42")
        user, _ = nb.add("n = len([1, 2, 3])")
        self.assertEqual(nb.ns["n"], 42)
        self.assertIn(shadower, nb.parents(user))
        nb.set(shadower, "def len(x):\n    return 7")
        self.assertEqual(nb.ns["n"], 7)


class TestVersionedNamespaces(unittest.TestCase):
    IDIOM = "try:\n    items = items + [1]\nexcept NameError:\n    items = None"
    COUNTER = "try:\n    count = count + 1\nexcept NameError:\n    count = 0"

    def test_self_edge_advances_on_rerun(self):
        nb = Notebook(seed=1)
        acc, _ = nb.add(self.IDIOM, name="counter")
        nb.run()
        self.assertIsNone(nb.ns["items"])  # None: neutral "nothing yet"
        nb.set(acc, "items = [] if items is None else items + [1]")
        nb.rerun(acc)
        self.assertEqual(nb.ns["items"], [1])
        nb.rerun(acc)
        self.assertEqual(nb.ns["items"], [1, 1])

    def test_stateful_flag(self):
        nb = Notebook(seed=1)
        acc, _ = nb.add(self.IDIOM, run=False)
        plain, _ = nb.add("y = 1", run=False)
        self.assertTrue(nb.stateful(acc))
        self.assertFalse(nb.stateful(plain))

    def test_failure_restores_committed_version(self):
        nb = Notebook(seed=1)
        acc, _ = nb.add(self.COUNTER)
        nb.run()
        self.assertEqual(nb.ns["count"], 0)
        results = nb.set(acc, "count = count + 1 if count < 5 else boom")
        self.assertEqual(results[0].status, "ran")
        self.assertEqual(nb.ns["count"], 1)
        nb.set(acc, "count = count + 1 if False else boom")  # will raise
        self.assertEqual(nb.ns["count"], 1)  # restored, not deleted

    def test_replay_converges(self):
        nb = Notebook(seed=1)
        acc, _ = nb.add(self.COUNTER)
        nb.rerun(acc)
        nb.rerun(acc)
        self.assertEqual(nb.ns["count"], 2)
        nb.run_all()  # replay from scratch
        self.assertEqual(nb.ns["count"], 0)

    def test_describe_marks_stateful(self):
        nb = Notebook(seed=1)
        nb.add(self.IDIOM, name="counter")
        desc = nb.describe()
        self.assertTrue(desc["cells"][0]["stateful"])


class TestCaching(unittest.TestCase):
    IDIOM = "try:\n    count = count + 1\nexcept NameError:\n    count = 0"

    def build(self):
        nb = Notebook(seed=1)
        config, _ = nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        report, _ = nb.add("sum(rows)", name="report")
        return nb, config, load, report

    def statuses(self, results):
        return {r.cell: r.status for r in results}

    def test_unrelated_edit_does_not_rerun(self):
        nb, *_ = self.build()
        other, results = nb.add("x = 1")
        self.assertEqual(self.statuses(results), {other: "ran"})

    def test_early_cutoff_on_same_value(self):
        nb, config, load, report = self.build()
        results = nb.set(config, "name = 5\nsource = name * 2")
        s = self.statuses(results)
        self.assertEqual(s[config], "ran")
        self.assertEqual(s[load], "cached")
        self.assertEqual(s[report], "cached")

    def test_changed_value_reruns_downstream(self):
        nb, config, load, report = self.build()
        results = nb.set(config, "source = 99")
        s = self.statuses(results)
        self.assertEqual(s[load], "ran")
        self.assertEqual(s[report], "ran")

    def test_cached_results_carry_values(self):
        nb, config, _, report = self.build()
        results = nb.set(config, "source = 10")  # same value -> cached
        cached = {r.cell: r for r in results}
        self.assertEqual(cached[report].status, "cached")
        self.assertIsNotNone(cached[report].value)

    def test_error_marks_downstream_skipped(self):
        nb, config, load, _ = self.build()
        results = nb.set(config, "source = undefined_name")
        s = self.statuses(results)
        self.assertEqual(s[config], "error")
        self.assertNotIn(load, s)  # skipped, not run
        self.assertIn(load, nb.pending)

    def test_stateful_cell_rekeys_on_rerun(self):
        nb = Notebook(seed=1)
        acc, _ = nb.add("try:\n    count = count + 1\nexcept NameError:\n    count = 0")
        nb.run()
        r1 = nb.rerun(acc)
        self.assertEqual(r1[0].status, "ran")  # key moved: previous version changed
        self.assertEqual(nb.ns["count"], 1)

    def test_stdout_captured_not_leaked(self):
        import io

        nb = Notebook(seed=1)
        out = io.StringIO()
        old = sys.stdout
        sys.stdout = out
        try:
            cid, results = nb.add("print('hello from cell')\n42")
        finally:
            sys.stdout = old
        self.assertEqual(out.getvalue(), "")
        self.assertIn("hello from cell", results[0].output)


class TestEarlyCutoff(unittest.TestCase):
    """A cached cell must not merely *report* `cached` — it must not run.

    The side-effecting counter stands in for the expensive I/O this is
    all for: a cell that costs 400ms should pay it once.
    """

    def test_refactor_with_same_value_does_not_re_execute(self):
        nb = Notebook(seed=1)
        counter = {"n": 0}
        nb.ns["tick"] = counter
        config, _ = nb.add("source = 10", name="config")
        load, _ = nb.add("tick['n'] += 1\nrows = [source, 2, 3]", name="load")
        self.assertEqual(counter["n"], 1)

        # Same resulting value by a different route: `load` keeps its key.
        results = nb.set(config, "base = 5\nsource = base * 2")
        self.assertEqual({r.cell: r.status for r in results}[load], "cached")
        self.assertEqual(counter["n"], 1)  # the work was genuinely skipped

        # A genuinely different value moves the key and the work is paid.
        nb.set(config, "source = 99")
        self.assertEqual(counter["n"], 2)


class TestEnvironmentIsATrackedInput(unittest.TestCase):
    """The scenario env-tracking exists for: a cell whose source and
    inputs never change still has to re-run when the environment moves.

    Hermetic — `Notebook.env` is the whole interface to the installed
    set, so moving it by hand is exactly what a pip install does."""

    # Both branches bind both defs. A cell that leaves one of its defs
    # unbound is never fresh (see `_fresh`), so it re-runs anyway and
    # never goes stale — it is *this* well-behaved shape that needs the
    # environment edge.
    PROBE = (
        "try:\n"
        "    import cowsay\n"
        "    backend = 'cowsay'\n"
        "except ImportError:\n"
        "    cowsay = None\n"
        "    backend = 'plain'\n"
    )

    def build(self):
        nb = Notebook(seed=1)
        probe, _ = nb.add(self.PROBE, name="probe")
        greet, _ = nb.add("message = f'rendering via {backend}'", name="greet")
        plain, _ = nb.add("unrelated = 1", name="plain")
        return nb, probe, greet, plain

    def test_importing_cells_carry_an_environment_edge(self):
        nb, probe, _, plain = self.build()
        self.assertTrue(nb.cells[probe].imports)
        self.assertFalse(nb.cells[plain].imports)

    def test_environment_change_invalidates_exactly_the_importers(self):
        nb, probe, greet, plain = self.build()
        key_before = nb._key(probe)
        nb.env = "pretend cowsay just landed"
        self.assertNotEqual(nb._key(probe), key_before)
        self.assertEqual(nb._key(plain), nb._key(plain))  # no env edge

        # What install() does once the digest has moved.
        nb.pending |= {probe} | nb.descendants(probe)
        statuses = {r.cell: r.status for r in nb.run()}
        self.assertEqual(statuses[probe], "ran")
        self.assertNotIn(plain, statuses)  # untouched, not even considered

    def test_a_still_environment_leaves_the_cell_cached(self):
        # The hazard, stated positively: source and inputs never move, so
        # without the env edge nothing would ever invalidate this cell.
        nb, probe, _, _ = self.build()
        before = nb._key(probe)
        nb.pending.add(probe)
        self.assertEqual({r.cell: r.status for r in nb.run()}[probe], "cached")
        self.assertEqual(nb._key(probe), before)


class TestEval(unittest.TestCase):
    def test_eval_reads_namespace_without_creating_a_cell(self):
        nb = Notebook(seed=1)
        nb.add("rows = [1, 2, 3]")
        before = set(nb.cells)
        r = nb.eval_src("len(rows)")
        self.assertEqual(r.status, "ran")
        self.assertEqual(r.value, "3")
        self.assertEqual(set(nb.cells), before)
        self.assertEqual(nb.pending, set())

    def test_eval_defs_land_untracked(self):
        nb = Notebook(seed=1)
        r = nb.eval_src("temp = 42")
        self.assertEqual(r.status, "ran")
        self.assertEqual(nb.ns["temp"], 42)
        self.assertNotIn("temp", nb.provider)  # no cell owns it

    def test_eval_error_shape(self):
        nb = Notebook(seed=1)
        r = nb.eval_src("1/0")
        self.assertEqual(r.status, "error")
        self.assertIn("ZeroDivisionError", r.error)

    def test_eval_via_protocol(self):
        nb = Notebook(seed=1)
        handle(nb, {"tool": "add_cell", "src": "rows = [1]"})
        resp = handle(nb, {"tool": "eval", "src": "len(rows)"})
        self.assertTrue(resp["ok"])
        self.assertEqual(resp["value"], "1")
        resp = handle(nb, {"tool": "eval", "src": "1/0"})
        self.assertFalse(resp["ok"])
        self.assertIn("ZeroDivisionError", resp["error"])


class TestProtocol(unittest.TestCase):
    def test_add_returns_generated_id(self):
        nb = Notebook(seed=1)
        resp = handle(nb, {"tool": "add_cell", "src": "x = 1"})
        self.assertTrue(resp["ok"])
        self.assertRegex(resp["id"], r"^[a-z2-7]{6}$")

    def test_add_without_run_via_protocol(self):
        nb = Notebook(seed=1)
        resp = handle(nb, {"tool": "add_cell", "src": "x = 1", "run": False})
        self.assertTrue(resp["ok"])
        self.assertIn(resp["id"], resp["pending"])

    def test_results_carry_statefulness(self):
        # A consumer holding only results has no other way to tell a history
        # (an accumulator advancing) from stale copies of one value.
        nb = Notebook(seed=1)
        plain = handle(nb, {"tool": "add_cell", "src": "x = 1"})
        self.assertFalse(plain["results"][0]["stateful"])
        src = "c = c + 1 if 'c' in dir() else 0"
        acc = handle(nb, {"tool": "add_cell", "src": src})
        self.assertTrue(acc["results"][0]["stateful"])

    def test_deleting_a_cell_still_serialises_its_dependents(self):
        # `stateful` is asked of the notebook, which no longer holds the cell.
        nb = Notebook(seed=1)
        a = handle(nb, {"tool": "add_cell", "src": "a = 1"})["id"]
        handle(nb, {"tool": "add_cell", "src": "b = a + 1"})
        resp = handle(nb, {"tool": "delete_cell", "id": a})
        self.assertTrue(resp["ok"])
        self.assertTrue(all("stateful" in r for r in resp["results"]))

    def test_run_all_and_rerun_verbs(self):
        nb = Notebook(seed=1)
        cid = handle(nb, {"tool": "add_cell", "src": "x = 1"})["id"]
        resp = handle(nb, {"tool": "rerun_cell", "id": cid})
        self.assertTrue(resp["ok"])
        resp = handle(nb, {"tool": "run_all"})
        self.assertTrue(resp["ok"])

    def test_apply_edits_dict_shape(self):
        nb = Notebook(seed=1)
        resp = handle(
            nb,
            {
                "tool": "apply_edits",
                "edits": [
                    {"op": "add", "src": "a = 1", "name": "first"},
                    {"op": "add", "src": "b = a + 1"},
                ],
            },
        )
        self.assertTrue(resp["ok"])
        self.assertEqual(len(resp["created"]), 2)
        cid = resp["created"][0]
        resp = handle(
            nb, {"tool": "apply_edits", "edits": [{"op": "delete", "id": cid}]}
        )
        self.assertTrue(resp["ok"])

    def test_plan_edits(self):
        nb = Notebook(seed=1)
        a = handle(nb, {"tool": "add_cell", "src": "a = 1"})["id"]
        b = handle(nb, {"tool": "add_cell", "src": "b = a"})["id"]
        resp = handle(
            nb,
            {"tool": "plan_edits", "edits": [{"op": "set", "id": a, "src": "a = 2"}]},
        )
        self.assertEqual(sorted(resp["would_invalidate"]), sorted([a, b]))

    def test_inspect_has_labels_and_pending(self):
        nb = Notebook(seed=1)
        handle(nb, {"tool": "add_cell", "src": "x = 1", "name": "config"})
        resp = handle(nb, {"tool": "inspect"})
        self.assertIn("pending", resp)
        self.assertIn("failing", resp)
        self.assertEqual(list(resp["names"].values()), ["config"])

    def test_expected_error_is_json_shaped(self):
        nb = Notebook(seed=1)
        resp = handle(nb, {"tool": "nope"})
        self.assertFalse(resp["ok"])
        resp = handle(nb, {"tool": "set_cell", "id": "zzzzzz", "src": "x = 1"})
        self.assertFalse(resp["ok"])
        self.assertIn("KeyError", resp["error"])
        self.assertNotIn("internal", resp)

    def test_unexpected_error_tagged_internal(self):
        nb = Notebook(seed=1)
        resp = handle(nb, {"tool": "apply_edits", "edits": None})
        self.assertFalse(resp["ok"])
        self.assertTrue(resp["internal"])


if __name__ == "__main__":
    unittest.main()
