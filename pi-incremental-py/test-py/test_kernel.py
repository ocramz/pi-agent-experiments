"""Stdlib-only tests for the reactive kernel. Run with:

    python3 -m unittest discover -s test-py

No third-party packages required.
"""

import dataclasses
import os
import sys
import time
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from kernel import (  # noqa: E402
    CycleError,
    DuplicateNameError,
    Edit,
    Memo,
    MultipleDefinitionError,
    Notebook,
    Result,
    StatefulVariantError,
    analyze,
    digest,
)
from kernel.values import _hash  # noqa: E402
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

    # `refs` means "globals read from the incoming namespace". symtable
    # reports what is assigned and what is referenced but never in what
    # order, so it is wrong at both ends about names a cell binds *and*
    # mentions. These pin both corrections.

    def test_trailing_display_expression_is_not_a_read(self):
        # The display idiom this kernel recommends. symtable sees `total`
        # assigned and referenced, exactly as in `total = total + 1`, but the
        # tail runs after the body against the same namespace: it reads back
        # what the body just wrote. Keeping it would put the cell's own value
        # in its own cache key, costing it a re-run on every change.
        defs, refs = analyze("total = 1\ntotal")
        self.assertEqual(defs, {"total"})
        self.assertNotIn("total", refs)

    def test_a_conditional_binding_keeps_its_self_reference(self):
        # The other branch of the same question, and the reason `_certainly_bound`
        # only counts the body's own top level: when `flag` is false nothing
        # binds x, so the tail really does read the previous committed value.
        # Every uncertain case keeps the ref.
        defs, refs = analyze("if flag:\n    x = 1\nx")
        self.assertEqual(defs, {"x"})
        self.assertIn("x", refs)
        self.assertIn("flag", refs)

    def test_augmented_assignment_is_a_read(self):
        # `x += 1` binds through a Store with no Load node anywhere, so
        # symtable calls it assigned and not referenced.
        defs, refs = analyze("n += 1")
        self.assertEqual(defs, {"n"})
        self.assertEqual(refs, {"n"})

    def test_augmented_assignment_respects_scope(self):
        declared = analyze("def f():\n    global n\n    n += 1")
        self.assertIn("n", declared[1])
        # A function-local accumulator is nobody else's business: claiming it
        # would invent a dependency on an unrelated global of the same name.
        local = analyze("def f():\n    n = 0\n    n += 1")
        self.assertNotIn("n", local[1])


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

    def test_displaying_a_value_does_not_make_a_cell_stateful(self):
        # `stateful` is `refs & defs`, so it inherits whatever `refs` decided.
        # See TestAnalyze for the two corrections that make it right.
        nb = Notebook(seed=1)
        display, _ = nb.add("shown = 1\nshown", run=False)
        self.assertFalse(nb.stateful(display))
        # ...while an accumulator keeps its flag when it displays too.
        both, _ = nb.add(f"{self.COUNTER}\ncount", run=False)
        self.assertTrue(nb.stateful(both))

    def test_the_two_accumulator_spellings_are_indistinguishable(self):
        # `n += 1` and `n = n + 1` are the same computation, so nothing
        # downstream should be able to tell them apart: not the stateful flag,
        # not the cache key, not whether a plain run() advances them.
        plus_equals = "try:\n    n += 1\nexcept NameError:\n    n = 0"
        rebinding = "try:\n    n = n + 1\nexcept NameError:\n    n = 0"
        seen = []
        for src in (plus_equals, rebinding):
            nb = Notebook(seed=1)
            cid, _ = nb.add(src)
            self.assertTrue(nb.stateful(cid), src)
            values = []
            for _ in range(3):
                nb.pending = {cid}
                nb.run()  # run(), not rerun(): this must advance on its own
                values.append(nb.ns["n"])
            seen.append(values)
        self.assertEqual(seen[0], [1, 2, 3])
        self.assertEqual(seen[0], seen[1])

    def test_a_displaying_cell_caches_like_any_other(self):
        # A cell that displays its own global used to carry that global in its
        # own cache key — absent before the first run, present after — so it
        # re-ran once at creation and again after every real change.
        nb = Notebook(seed=1)
        a, _ = nb.add("a = 1\na")
        b, _ = nb.add("b = a + 1\nb")

        def statuses():
            nb.pending = {b}
            return [r.status for r in nb.run()]

        self.assertEqual(statuses(), ["cached"])
        self.assertEqual(statuses(), ["cached"])
        nb.set(a, "a = 2\na")  # one real change; b re-runs there
        self.assertEqual(nb.ns["b"], 3)
        self.assertEqual(statuses(), ["cached"])

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


class TestAddressing(unittest.TestCase):
    """A value's content address is computed once and reused as key
    material, instead of being re-derived per reader per run.

    The point of the change is cost, so the tests are about *how often*
    hashing happens and about the invalidation that caching it makes
    necessary. That it does not change the keys themselves is asserted
    first, because everything else assumes it."""

    def test_a_key_still_hashes_the_digests_of_its_inputs(self):
        """The address is the digest. Same rules, same bytes, same key —
        so every caching property proved against the old formula still
        describes this one."""
        nb = Notebook(seed=1)
        nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")

        expected = _hash("rows = [source, 2, 3]" + repr([("source", digest(10))]))
        self.assertEqual(nb._key(load), expected)

    def test_a_value_is_hashed_once_however_many_cells_read_it(self):
        """The cost this change exists to remove: three readers used to
        mean three picklings of the same object on every run.

        Forced with `rerun`, because a producer that is merely pending is
        found fresh and never re-executes — in which case its address is
        not retracted at all and the count is zero, which would pass for
        the wrong reason."""
        nb = Notebook(seed=1)
        nb.ns["_counter"] = Counted()
        produce, _ = nb.add("shared = _counter", name="produce")
        nb.add("a = shared", name="a")
        nb.add("b = shared", name="b")
        nb.add("c = shared", name="c")

        Counted.pickled = 0
        nb.rerun(produce)  # re-executes, retracting `shared`'s address
        self.assertEqual(Counted.pickled, 1)

    def test_an_address_survives_a_run_that_executes_nothing(self):
        """The other half, and where the saving actually lives: readers
        that turn out to be cached never execute, so nothing retracts the
        address and the next run re-hashes nothing at all."""
        nb = Notebook(seed=1)
        nb.ns["_counter"] = Counted()
        produce, _ = nb.add("shared = _counter", name="produce")
        nb.add("a = shared", name="a")
        nb.add("b = shared", name="b")

        nb.pending = {produce}
        nb.run()  # warms the address; every cell comes out cached

        Counted.pickled = 0
        nb.pending = {produce}
        nb.run()
        self.assertEqual(Counted.pickled, 0)

    def test_a_cell_mutating_what_it_reads_retracts_the_address(self):
        """`data.append(4)` binds nothing, so retracting on rebind alone
        would leave a reader keyed on the value the list used to hold.
        Hashing per read caught this for free; retracting refs is what
        buys it back."""
        nb = Notebook(seed=1)
        nb.add("data = [1, 2, 3]", name="source")
        reader, _ = nb.add("total = sum(data)", name="reader")
        mutate, _ = nb.add("data.append(4)", name="mutate")
        before = nb._key(reader)

        nb.set(mutate, "data.append(99)")  # re-executes, mutating in place
        self.assertNotEqual(nb._key(reader), before)

    def test_a_snippet_mutating_a_global_retracts_the_address(self):
        """The same hole through the human's escape hatch."""
        nb = Notebook(seed=1)
        nb.add("data = [1, 2, 3]", name="source")
        reader, _ = nb.add("total = sum(data)", name="reader")
        before = nb._key(reader)

        nb.eval_src("data.append(99)")
        self.assertNotEqual(nb._key(reader), before)

    def test_rebinding_a_global_retracts_its_address(self):
        nb = Notebook(seed=1)
        source, _ = nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        before = nb._key(load)

        nb.set(source, "source = 99")
        self.assertNotEqual(nb._key(load), before)

    def test_eval_clobbering_a_global_retracts_its_address(self):
        """`/py` execs in the live namespace, so a snippet can rebind a
        global some cell provides. The old key re-hashed on every read and
        noticed; a recorded address has to be retracted by hand."""
        nb = Notebook(seed=1)
        nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        before = nb._key(load)

        nb.eval_src("source = 99")
        self.assertNotEqual(nb._key(load), before)

    def test_a_snippet_binding_an_unowned_name_leaves_addresses_alone(self):
        nb = Notebook(seed=1)
        nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        before = nb._key(load)

        nb.eval_src("scratch = 99")  # no cell provides `scratch`
        self.assertEqual(nb._key(load), before)

    def test_run_all_drops_every_address(self):
        """`run_all` is the recovery move: it drops the namespace, so the
        addresses describing it cannot be allowed to outlive it."""
        nb = Notebook(seed=1)
        nb.add("source = 10", name="config")
        nb.add("rows = [source, 2, 3]", name="load")
        nb.addr["ghost"] = ("stale", 0)

        nb.run_all()
        self.assertNotIn("ghost", nb.addr)

    def test_deleting_a_cell_retracts_its_address_with_its_global(self):
        nb = Notebook(seed=1)
        source, _ = nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        nb._key(load)  # records an address for `source`

        nb.delete(load)
        nb.delete(source)
        self.assertNotIn("source", nb.addr)


class TestMemo(unittest.TestCase):
    """A value displaced by an edit is not lost: the key that produced it
    still names it, so undoing the edit puts it back without re-running.

    `memo_min_seconds=0` throughout — these cells run in microseconds, and
    the default threshold exists to stop the kernel pickling values that
    were cheaper to compute than to save."""

    def build(self, **kw):
        nb = Notebook(seed=1, memo_min_seconds=0, **kw)
        config, _ = nb.add("source = 10", name="config")
        load, _ = nb.add("rows = [source, 2, 3]", name="load")
        return nb, config, load

    def statuses(self, results):
        return {r.cell: r.status for r in results}

    def test_undoing_an_edit_restores_instead_of_rerunning(self):
        """The round trip. `load` re-runs on the way out and comes back
        without executing, because its key is the one it had before."""
        nb, config, load = self.build()
        self.assertEqual(self.statuses(nb.set(config, "source = 99"))[load], "ran")
        self.assertEqual(self.statuses(nb.set(config, "source = 10"))[load], "restored")
        self.assertEqual(nb.ns["rows"], [10, 2, 3])

    def test_a_restored_cell_carries_its_value(self):
        nb, config, load = self.build()
        nb.set(config, "source = 99")
        results = {r.cell: r for r in nb.set(config, "source = 10")}
        self.assertIsNotNone(results[load].value)

    def test_two_programs_reaching_the_same_value_share_one_entry(self):
        """Convergence: the entry belongs to the computation, not to the
        cell that got there first. A different upstream *source* that
        yields the same upstream *value* is the same key downstream."""
        nb, config, load = self.build()
        nb.set(config, "source = 99")
        # Same value as the original, reached by different source.
        results = self.statuses(nb.set(config, "source = 5 * 2"))
        self.assertEqual(results[config], "ran")
        self.assertEqual(results[load], "restored")

    def test_a_restored_cell_is_fresh_next_time(self):
        """Restoring commits a run, so the cell is live in the namespace
        again and the next pass finds it cached rather than restoring it
        a second time."""
        nb, config, load = self.build()
        nb.set(config, "source = 99")
        self.assertEqual(self.statuses(nb.set(config, "source = 10"))[load], "restored")

        nb.pending = {load}
        self.assertEqual(self.statuses(nb.run())[load], "cached")

    def test_a_convergent_restore_is_attributed_to_the_cell_that_asked(self):
        """Entries belong to computations, so the cell that stored one and
        the cell that gets it back need not be the same cell."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        first, _ = nb.add("shared = sum([1, 2, 3])", name="first")
        nb.delete(first)
        second, results = nb.add("shared = sum([1, 2, 3])", name="second")

        self.assertEqual(self.statuses(results)[second], "restored")
        self.assertEqual(nb.done[second].result.cell, second)

    def test_rerun_forces_past_the_memo(self):
        """`rerun` pops `done` so freshness cannot short-circuit it; the
        memo is a second place the same short-circuit could happen."""
        nb, config, load = self.build()
        nb.set(config, "source = 99")
        nb.set(config, "source = 10")  # `load` is now restored, not run
        self.assertEqual(self.statuses(nb.rerun(load))[load], "ran")

    def test_run_all_replays_rather_than_answering_from_the_memo(self):
        """The recovery move has to actually execute. It refills the memo
        as it goes, so what proves the wipe is that nothing survived it."""
        nb, _, load = self.build()
        nb.memo["ghost"] = Memo({"a": b"x"}, 1, 1.0, Result("a", "ran", 1.0))

        self.assertEqual(self.statuses(nb.run_all())[load], "ran")
        self.assertNotIn("ghost", nb.memo)

    def test_a_cell_defining_a_function_is_not_memoized(self):
        """Pickle stores a function by name, so it would come back as
        whatever answers to that name later — not as what was saved."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        nb.add("def scale(x):\n    return x * 2\n", name="fn")
        self.assertEqual(nb.memo, {})

    def test_an_unpicklable_value_is_not_memoized(self):
        nb = Notebook(seed=1, memo_min_seconds=0)
        nb.add("import socket\nsock = socket.socket()", name="net")
        self.addCleanup(nb.ns["sock"].close)
        self.assertEqual(nb.memo, {})

    def test_a_failed_run_is_not_memoized(self):
        nb = Notebook(seed=1, memo_min_seconds=0)
        nb.add("boom = 1 / 0", name="boom")
        self.assertEqual(nb.memo, {})

    # ---- module-valued defs

    # Binds `math` as well as `unit`, and reads `scale`, so it is
    # displaceable. `math` is a def and never a ref, so this is an
    # ordinary cell and not an accumulator.
    IMPORTING = "import math\nunit = math.floor(scale)"

    def test_a_cell_binding_a_module_is_memoized(self):
        """`freeze` refuses a module — pickling one stores a pointer into
        `sys.modules` — which used to cost the cell its whole entry.
        Recorded by name and imported back instead."""
        import math

        nb = Notebook(seed=1, memo_min_seconds=0)
        knob, _ = nb.add("scale = 1", name="knob")
        cell, _ = nb.add(self.IMPORTING, name="importer")

        self.assertEqual(self.statuses(nb.set(knob, "scale = 2"))[cell], "ran")
        self.assertEqual(self.statuses(nb.set(knob, "scale = 1"))[cell], "restored")
        self.assertIs(nb.ns["math"], math)
        self.assertEqual(nb.ns["unit"], 1)

    def test_hoisting_the_import_no_longer_changes_the_answer(self):
        """The asymmetry this closes. The same computation with its import
        lifted into a cell of its own was restorable; with the import left
        in place it was not, and re-ran on every round trip."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        knob, _ = nb.add("scale = 1", name="knob")
        inline, _ = nb.add(self.IMPORTING, name="inline")
        nb.add("import statistics", name="hoisted")
        lifted, _ = nb.add("other = statistics.mean([scale, scale])", name="lifted")

        nb.set(knob, "scale = 2")
        results = self.statuses(nb.set(knob, "scale = 1"))
        self.assertEqual(results[lifted], "restored")  # always worked
        self.assertEqual(results[inline], "restored")  # now agrees

    def test_an_entry_whose_module_will_not_import_is_a_miss(self):
        """The same rule a blob that will not load gets: an entry that
        cannot be rebuilt is not an answer, and must not be a crash."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        knob, _ = nb.add("scale = 1", name="knob")
        cell, _ = nb.add(self.IMPORTING, name="importer")
        key = nb.done[cell].key
        nb.set(knob, "scale = 2")

        nb.memo[key] = dataclasses.replace(
            nb.memo[key], modules={"math": "no_such_module_xyz"}
        )
        self.assertEqual(self.statuses(nb.set(knob, "scale = 1"))[cell], "ran")
        # Dropped on the way past, and the re-run wrote an honest one back
        # under the same key — the miss costs one execution, not the entry.
        self.assertEqual(nb.memo[key].modules, {"math": "math"})

    def test_a_cheap_cell_is_not_worth_saving(self):
        """The default threshold: pickling a value costs real work, and
        below it the cell was cheaper to run than to store."""
        nb = Notebook(seed=1)  # default memo_min_seconds
        nb.add("source = 10", name="config")
        self.assertEqual(nb.memo, {})

    def test_eviction_keeps_what_is_expensive_per_byte(self):
        """An LRU would drop the slow entry to keep the big one. Cost per
        byte is the question a cache of computed values is answering."""
        nb = Notebook(seed=1, memo_min_seconds=0, memo_budget=50)
        # `bulky` is the more recently used, and by far the larger.
        nb.memo["slow"] = Memo({"a": b"xx"}, 2, 10.0, Result("a", "ran", 10.0))
        nb.memo["bulky"] = Memo({"b": b"x" * 100}, 100, 0.1, Result("b", "ran", 0.1))
        nb._evict()
        self.assertEqual(list(nb.memo), ["slow"])


class TestVariants(unittest.TestCase):
    """Alternative programs over one namespace, and the reuse that makes
    moving between them worth doing."""

    def build(self, **kw):
        """The shape the design is for: a shared prefix, then a cell whose
        alternatives are what the researcher is actually comparing."""
        nb = Notebook(seed=1, memo_min_seconds=0, **kw)
        load, _ = nb.add("raw = [1, 2, 3, 4]", name="load")
        feats, _ = nb.add("feats = [x * 10 for x in raw]", name="feats")
        model, _ = nb.add("model = ('mean', sum(feats) / len(feats))", name="model")
        score, _ = nb.add("score = model[1] * 2", name="score")
        return nb, load, feats, model, score

    def statuses(self, results):
        return {r.cell: r.status for r in results}

    def test_forking_leaves_the_program_alone(self):
        nb, *_ = self.build()
        before = dict(nb.cells)
        nb.fork("alt")
        self.assertEqual(nb.current, "alt")
        self.assertEqual(nb.cells, before)

    def test_a_variant_edit_reruns_only_below_the_divergence(self):
        """Level one: upstream of the fork point is never recomputed."""
        nb, load, feats, model, score = self.build()
        nb.fork("median")
        results = self.statuses(nb.set(model, "model = ('median', 25.0)"))

        self.assertEqual(results[model], "ran")
        self.assertEqual(results[score], "ran")
        self.assertNotIn(load, results)  # not even considered
        self.assertNotIn(feats, results)

    def test_switching_back_restores_rather_than_recomputes(self):
        """Level two, and the whole point: the displaced computation comes
        back out of the memo instead of being redone."""
        nb, _, _, model, score = self.build()
        nb.fork("median")
        nb.set(model, "model = ('median', 25.0)")

        results = self.statuses(nb.switch("main"))
        self.assertEqual(results[model], "restored")
        self.assertEqual(results[score], "restored")
        self.assertEqual(nb.ns["model"], ("mean", 25.0))

    def test_a_round_trip_leaves_the_program_identical(self):
        nb, *_ = self.build()
        before = list(nb.cells.items())
        nb.fork("alt")
        nb.add("extra = 1", name="extra")
        nb.switch("main")
        self.assertEqual(list(nb.cells.items()), before)

    def test_variants_may_bind_the_same_name_differently(self):
        """The reason variants exist: two cells cannot both provide
        `model`, so the alternatives cannot be siblings in one graph."""
        nb, _, _, model, _ = self.build()
        nb.fork("median")
        nb.set(model, "model = ('median', 25.0)")
        self.assertEqual(nb.ns["model"][0], "median")

        nb.switch("main")
        self.assertEqual(nb.ns["model"][0], "mean")

    def test_a_variant_that_adds_a_cell_retracts_it_on_the_way_out(self):
        nb, *_ = self.build()
        nb.fork("extra")
        nb.add("bonus = 99", name="bonus")
        self.assertIn("bonus", nb.ns)

        nb.switch("main")
        self.assertNotIn("bonus", nb.ns)  # its provider is gone

    def test_switching_preserves_cell_ids(self):
        """Ids are what let the agent talk about `model` across variants,
        and what makes the two variants' keys line up."""
        nb, *_ = self.build()
        ids = set(nb.cells)
        nb.fork("alt")
        nb.add("extra = 1")
        nb.switch("main")
        self.assertEqual(set(nb.cells), ids)

    def test_dropping_a_variant_invalidates_nothing(self):
        """Entries are addressed by what they computed, so a name going
        away cannot take a value with it."""
        nb, _, _, model, score = self.build()
        nb.fork("median")
        nb.set(model, "model = ('median', 25.0)")
        nb.switch("main")
        nb.drop("median")

        nb.set(model, "model = ('median', 25.0)")
        self.assertEqual(self.statuses(nb.rerun(score))[score], "ran")
        self.assertEqual(nb.ns["model"][0], "median")

    def test_the_current_variant_cannot_be_dropped(self):
        nb, *_ = self.build()
        nb.fork("alt")
        with self.assertRaises(ValueError):
            nb.drop("alt")

    def test_forking_a_name_twice_is_refused(self):
        nb, *_ = self.build()
        nb.fork("alt")
        nb.switch("main")
        with self.assertRaises(DuplicateNameError):
            nb.fork("alt")

    def test_a_bad_variant_name_is_refused(self):
        nb, *_ = self.build()
        with self.assertRaises(ValueError):
            nb.fork("Not A Name")

    def test_switching_to_an_unknown_variant_is_refused(self):
        nb, *_ = self.build()
        with self.assertRaises(KeyError):
            nb.switch("nope")

    def test_variants_reports_what_differs_from_the_current_one(self):
        nb, _, _, model, _ = self.build()
        nb.fork("median")
        nb.set(model, "model = ('median', 25.0)")

        described = nb.describe_variants()
        by_name = {v["name"]: v for v in described["variants"]}
        self.assertEqual(described["current"], "median")
        self.assertEqual(by_name["median"]["differs"], [])
        self.assertEqual(by_name["main"]["differs"], [model])
        self.assertEqual(by_name["median"]["parent"], "main")

    def test_inspect_names_the_variant(self):
        nb, *_ = self.build()
        self.assertEqual(nb.describe()["variant"], "main")
        nb.fork("alt")
        self.assertEqual(nb.describe()["variant"], "alt")

    # ---- the guard

    # Reads what it writes, and sits downstream of `knob` — so an edit to
    # `knob` puts it in the blast radius.
    ACCUMULATOR = "try:\n    seen = seen + knob\nexcept NameError:\n    seen = knob"

    def accumulating(self):
        nb = Notebook(seed=1, memo_min_seconds=0)
        knob, _ = nb.add("knob = 1", name="knob")
        counter, _ = nb.add(self.ACCUMULATOR, name="counter")
        other, _ = nb.add("other = 1", name="other")
        return nb, knob, counter, other

    def test_a_switch_across_an_accumulator_is_refused(self):
        """Such a cell keys on its own last value, so a switch advances it
        rather than restoring it — and the value it left is unrecoverable."""
        nb, knob, counter, _ = self.accumulating()
        nb.fork("alt")
        nb.set(knob, "knob = 2")

        with self.assertRaises(StatefulVariantError) as caught:
            nb.switch("main")
        self.assertIn(counter, str(caught.exception))
        self.assertEqual(nb.current, "alt")  # refused, and went nowhere

    def test_a_refused_switch_leaves_the_program_untouched(self):
        nb, knob, _, _ = self.accumulating()
        nb.fork("alt")
        nb.set(knob, "knob = 2")
        before = dict(nb.cells)

        with self.assertRaises(StatefulVariantError):
            nb.switch("main")
        self.assertEqual(nb.cells, before)

    def test_force_proceeds_across_an_accumulator(self):
        nb, knob, _, _ = self.accumulating()
        nb.fork("alt")
        nb.set(knob, "knob = 2")

        nb.switch("main", force=True)
        self.assertEqual(nb.current, "main")

    def test_an_accumulator_outside_the_cone_does_not_block(self):
        """The guard is about the blast radius, not about the notebook
        containing an accumulator anywhere."""
        nb, _, _, other = self.accumulating()
        nb.fork("alt")
        nb.set(other, "other = 2")  # cone is {other}; the counter is elsewhere

        nb.switch("main")
        self.assertEqual(nb.current, "main")


class TestDescriptions(unittest.TestCase):
    """The second identity: what a program *says*, not what it produced.

    A key cannot be known before its inputs exist; a description can. That
    is what lets a result be found without building what is behind it —
    and the reason it needs a determinism gate that a key does not."""

    def build(self, seed=1, **kw):
        nb = Notebook(seed=seed, memo_min_seconds=0, **kw)
        raw, _ = nb.add("raw = [1, 2, 3, 4]", name="raw")
        feats, _ = nb.add("feats = [x * 10 for x in raw]", name="feats")
        score, _ = nb.add("score = sum(feats)", name="score")
        return nb, raw, feats, score

    def test_a_description_covers_the_whole_upstream_subtree(self):
        nb, raw, feats, score = self.build()
        before = nb.descriptions()

        nb.set(raw, "raw = [9, 9]")
        after = nb.descriptions()
        self.assertNotEqual(after[score], before[score])  # an ancestor moved
        self.assertNotEqual(after[raw], before[raw])

    def test_a_description_ignores_what_the_values_turn_out_to_be(self):
        """The complement of a key, which is built from values alone: two
        sources computing the same thing describe differently."""
        nb, raw, _, score = self.build()
        before = nb.descriptions()[score]
        nb.set(raw, "raw = [1, 2, 3] + [4]")  # same value, different words
        self.assertNotEqual(nb.descriptions()[score], before)

    def test_a_description_is_independent_of_cell_ids(self):
        """Ids are minted at random. Two notebooks holding the same program
        have to describe it the same way, or nothing could be shared."""
        one, *_ = self.build()
        other, *_ = self.build(seed=7)
        self.assertNotEqual(set(one.cells), set(other.cells))
        self.assertEqual(
            sorted(one.descriptions().values()), sorted(other.descriptions().values())
        )

    def test_the_environment_reaches_the_descriptions_of_importers(self):
        nb = Notebook(seed=1)
        probe, _ = nb.add("import json\nlib = json", name="probe")
        plain, _ = nb.add("plain = 1", name="plain")
        before = nb.descriptions()

        nb.env = "pretend something was installed"
        after = nb.descriptions()
        self.assertNotEqual(after[probe], before[probe])
        self.assertEqual(after[plain], before[plain])

    # ---- the gate

    def test_an_accumulator_makes_a_description_untrustworthy(self):
        """Its value is a function of how many times it ran, which is not
        something its source records."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        counter, _ = nb.add(
            "try:\n    seen = seen + 1\nexcept NameError:\n    seen = 0", name="counter"
        )
        downstream, _ = nb.add("doubled = seen * 2", name="downstream")

        self.assertFalse(nb._deterministic(counter))
        self.assertFalse(nb._deterministic(downstream))  # inherited

    def test_an_opaque_global_makes_a_description_untrustworthy(self):
        nb = Notebook(seed=1, memo_min_seconds=0)
        nb.add("import socket\nsock = socket.socket()", name="net")
        reader, _ = nb.add("port = sock.fileno()", name="reader")
        self.addCleanup(nb.ns["sock"].close)

        self.assertFalse(nb._deterministic(reader))

    def test_an_ordinary_cone_is_trusted(self):
        nb, _, _, score = self.build()
        self.assertTrue(nb._deterministic(score))

    # ---- shallow restore

    def test_a_shallow_switch_answers_without_building_the_interior(self):
        """`score` comes back although `feats`, the thing it was computed
        from, is never rebuilt — which the ordinary path cannot do, because
        it needs the input's address before it can name the result."""
        nb, _, feats, score = self.build()
        nb.fork("scratch")
        nb.delete(score)
        nb.delete(feats)

        results = nb.switch("main", shallow=True)
        statuses = {r.cell: r.status for r in results}
        self.assertEqual(statuses.get(score), "restored")
        self.assertNotIn(feats, statuses)
        self.assertEqual(nb.ns["score"], 100)

    def test_what_a_shallow_switch_skips_stays_pending(self):
        """The namespace is deliberately partial, and says so."""
        nb, raw, feats, score = self.build()
        nb.fork("scratch")
        nb.delete(score)
        nb.delete(feats)
        nb.switch("main", shallow=True)

        self.assertIn(feats, nb.pending)
        self.assertNotIn("feats", nb.ns)
        self.assertEqual(nb.ns["score"], 100)

    def test_an_ordinary_run_fills_in_what_shallow_left_out(self):
        nb, _, feats, score = self.build()
        nb.fork("scratch")
        nb.delete(score)
        nb.delete(feats)
        nb.switch("main", shallow=True)

        nb.run()
        self.assertEqual(nb.ns["feats"], [10, 20, 30, 40])
        self.assertEqual(nb.ns["score"], 100)

    def test_a_partial_namespace_never_mints_a_key(self):
        """The soundness the shallow path depends on: with an upstream
        value absent, a cell has no address to be keyed from, so it must
        not be handed one built out of the hole."""
        nb, _, feats, score = self.build()
        nb.ns.pop("feats")  # as a shallow restore leaves it

        self.assertNotEqual(nb._key(score), nb._key(score))  # poisoned, not stable

    def test_a_shallow_switch_declines_where_it_cannot_be_trusted(self):
        nb = Notebook(seed=1, memo_min_seconds=0)
        nb.add("knob = 1", name="knob")
        nb.add(
            "try:\n    seen = seen + knob\nexcept NameError:\n    seen = knob",
            name="counter",
        )
        knob = next(c for c, cell in nb.cells.items() if "knob = 1" in cell.src)
        counter = next(c for c in nb.cells if c != knob)
        nb.fork("scratch")
        nb.set(knob, "knob = 2")

        results = nb.switch("main", shallow=True, force=True)
        restored = {r.cell for r in results}
        self.assertNotIn(counter, restored)  # its description names no one value
        self.assertIn(counter, nb.pending)


class TestOpaqueGlobals(unittest.TestCase):
    """The kernel already knows which values it cannot identify — they
    poison a cell's key so it never caches — and never used to say so."""

    def opaque(self, nb):
        return nb.describe()["opaque"]

    def test_a_value_that_cannot_be_identified_is_reported(self):
        nb = Notebook(seed=1)
        nb.add("import socket\nsock = socket.socket()", name="net")
        self.addCleanup(nb.ns["sock"].close)
        nb.add("port = sock.fileno()", name="reader")  # reads it, so it is keyed

        self.assertEqual(self.opaque(nb), ["sock"])

    def test_an_unread_value_is_not_reported(self):
        """Opacity only has a consequence where something reads it, and
        checking a value costs the same as hashing it — so the report
        covers what was actually asked about, not the whole namespace."""
        nb = Notebook(seed=1)
        nb.add("import socket\nsock = socket.socket()", name="net")
        self.addCleanup(nb.ns["sock"].close)

        self.assertEqual(self.opaque(nb), [])

    def test_an_ordinary_value_is_not_reported(self):
        nb = Notebook(seed=1)
        nb.add("source = 10", name="config")
        nb.add("rows = [source]", name="load")
        self.assertEqual(self.opaque(nb), [])

    def test_a_reader_of_an_opaque_value_never_caches(self):
        """The consequence the report is warning about."""
        nb = Notebook(seed=1)
        nb.add("import socket\nsock = socket.socket()", name="net")
        reader, _ = nb.add("port = sock.fileno()", name="reader")
        self.addCleanup(nb.ns["sock"].close)

        nb.pending = {reader}
        self.assertEqual({r.cell: r.status for r in nb.run()}[reader], "ran")

    def test_a_dropped_global_stops_being_reported(self):
        nb = Notebook(seed=1)
        net, _ = nb.add("import socket\nsock = socket.socket()", name="net")
        reader, _ = nb.add("port = sock.fileno()", name="reader")
        self.addCleanup(nb.ns["sock"].close)
        self.assertEqual(self.opaque(nb), ["sock"])

        nb.delete(reader)
        nb.delete(net)
        self.assertEqual(self.opaque(nb), [])


class Fetches:
    """A counted stand-in for the effect all of this is about.

    Every call answers differently, exactly as a clock or a URL does, and
    the count is the only honest witness to whether the effect was really
    performed — a status of `cached` says the kernel *thinks* it skipped
    work, not that it did.
    """

    def __init__(self):
        self.n = 0

    def __call__(self, url):
        self.n += 1
        return f"{url}-{self.n}"


class TestEffectfulCells(unittest.TestCase):
    """Cells that read a clock, an RNG or a URL.

    The kernel assumes a cell is a pure function of its source and its
    inputs, and can *see* only two ways for that to fail: a self-edge
    (`stateful`), and a global `digest` cannot identify (`opaque`). An
    effectful cell is neither — a timestamp pickles perfectly well — so it
    has to say so. These cases pin both sides: what an unmarked one does,
    which is the behaviour the whole design implies, and what marking one
    buys.
    """

    def build(self, impure=False):
        nb = Notebook(seed=1, memo_min_seconds=0)
        fetches = Fetches()
        nb.ns["_fetch"] = fetches  # no cell provides it, so it keys nothing
        knob, _ = nb.add("url = 'a'", name="knob")
        page, _ = nb.add("page = _fetch(url)", name="fetch", impure=impure)
        report, _ = nb.add("report = page.upper()", name="report")
        return nb, fetches, knob, page, report

    def statuses(self, results):
        return {r.cell: r.status for r in results}

    # ---- unmarked: the contract as it stands

    def test_unmarked_it_caches_and_the_effect_is_paid_once(self):
        nb, fetches, _, page, _ = self.build()
        self.assertEqual(fetches.n, 1)

        nb.pending = {page}
        self.assertEqual(self.statuses(nb.run())[page], "cached")
        self.assertEqual(fetches.n, 1)  # source and inputs still, so no fetch

    def test_unmarked_a_variant_round_trip_puts_the_old_answer_back(self):
        """The one the version trees make reachable: the fetch is displaced
        by the fork's edit and comes out of the memo on the way home."""
        nb, fetches, knob, page, _ = self.build()
        nb.fork("alt")
        nb.set(knob, "url = 'b'")
        self.assertEqual(fetches.n, 2)  # diverging really did fetch

        results = self.statuses(nb.switch("main"))
        self.assertEqual(results[page], "restored")
        self.assertEqual(fetches.n, 2)  # ...and coming back did not
        self.assertEqual(nb.ns["page"], "a-1")  # the first fetch, not a fresh one

    def test_unmarked_the_description_index_will_answer_for_it(self):
        """The sharpest edge. `run_shallow` hands back a result whose inputs
        were never rebuilt, and an unmarked effectful cone carries nothing
        that tells it not to."""
        nb, fetches, _, page, report = self.build()
        self.assertTrue(nb._deterministic(page))
        self.assertTrue(nb._deterministic(report))

        nb.fork("scratch")
        nb.delete(report)
        nb.delete(page)
        results = self.statuses(nb.switch("main", shallow=True))
        self.assertEqual(results[report], "restored")
        self.assertNotIn(page, results)  # answered without re-fetching
        self.assertEqual(fetches.n, 1)

    def test_unmarked_rerun_re_performs_the_effect(self):
        """One of the two manual escape hatches. Both already worked;
        nothing had ever checked that they do."""
        nb, fetches, _, page, _ = self.build()
        nb.rerun(page)
        self.assertEqual(fetches.n, 2)
        self.assertEqual(nb.ns["page"], "a-2")

    def test_unmarked_a_restart_re_performs_the_effect(self):
        """The other one, on a real clock — a restart drops the namespace
        and the memo together, which is why it is the recovery move."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        cid, _ = nb.add("import time\nstamp = time.time_ns()", name="clock")
        first = nb.ns["stamp"]

        nb.pending = {cid}
        self.assertEqual(self.statuses(nb.run())[cid], "cached")
        self.assertEqual(nb.ns["stamp"], first)  # the clock was not consulted

        nb.run_all(restart=True)
        self.assertNotEqual(nb.ns["stamp"], first)

    # ---- marked: what declaring it buys

    def test_marked_it_never_caches(self):
        nb, fetches, _, page, _ = self.build(impure=True)
        # No content names its next run, so it cannot be handed an address.
        self.assertNotEqual(nb._key(page), nb._key(page))

        nb.pending = {page}
        self.assertEqual(self.statuses(nb.run())[page], "ran")
        self.assertEqual(fetches.n, 2)

    def test_a_poisoned_key_is_unique_inside_one_clock_tick(self):
        """`time_ns` does not promise to advance between two calls, and a
        poison that repeats is a key that *matches* — a cell reported
        `cached` over an effect that was never re-performed. The counter is
        what makes it unique; the clock only separates processes."""
        nb, _, _, page, _ = self.build(impure=True)
        with mock.patch.object(time, "time_ns", return_value=1):
            minted = {nb._key(page) for _ in range(100)}
        self.assertEqual(len(minted), 100)

    def test_marked_it_re_runs_even_when_the_clock_stands_still(self):
        """The same guarantee, through the front door."""
        nb, fetches, _, page, _ = self.build(impure=True)
        with mock.patch.object(time, "time_ns", return_value=1):
            for _ in range(3):
                nb.pending = {page}
                self.assertEqual(self.statuses(nb.run())[page], "ran")
        self.assertEqual(fetches.n, 4)

    def test_marked_it_is_re_run_on_an_ordinary_pass(self):
        nb, fetches, _, page, _ = self.build(impure=True)
        nb.pending = {page}
        self.assertEqual(self.statuses(nb.run())[page], "ran")
        self.assertEqual(fetches.n, 2)

    def test_marked_a_variant_round_trip_re_performs_the_effect(self):
        nb, fetches, knob, page, _ = self.build(impure=True)
        nb.fork("alt")
        nb.set(knob, "url = 'b'")
        self.assertEqual(fetches.n, 2)

        results = self.statuses(nb.switch("main"))
        self.assertEqual(results[page], "ran")  # not `restored`
        self.assertEqual(fetches.n, 3)
        self.assertEqual(nb.ns["page"], "a-3")  # fetched again, not put back

    def test_marked_a_dependent_still_cuts_off_when_the_value_repeats(self):
        """What makes the poison cheap: it moves the impure cell's own key,
        never its dependents'. Those key off the address of what it
        produced, so an unchanged answer still stops there."""
        nb = Notebook(seed=1, memo_min_seconds=0)
        calls = {"n": 0}
        nb.ns["_clock"] = lambda: calls.__setitem__("n", calls["n"] + 1) or 7
        stamp, _ = nb.add("stamp = _clock()", name="stamp", impure=True)
        reader, _ = nb.add("doubled = stamp * 2", name="reader")

        nb.pending = {stamp}
        results = self.statuses(nb.run())
        self.assertEqual(results[stamp], "ran")  # the effect was re-performed
        self.assertEqual(results[reader], "cached")  # its answer did not move
        self.assertEqual(calls["n"], 2)

    def test_marked_nothing_is_memoized_for_it(self):
        """An entry under a nonce could never be found again, only
        accumulate."""
        nb, _, _, _, _ = self.build(impure=True)
        stored = {name for m in nb.memo.values() for name in m.blobs}
        self.assertNotIn("page", stored)
        self.assertIn("report", stored)  # its dependents are cached as usual

    def test_marked_the_description_index_declines_it(self):
        nb, _, _, page, report = self.build(impure=True)
        self.assertFalse(nb._deterministic(page))
        self.assertFalse(nb._deterministic(report))  # inherited down the cone

        nb.fork("scratch")
        nb.delete(report)
        nb.delete(page)
        self.assertEqual(self.statuses(nb.switch("main", shallow=True)), {})
        self.assertIn(report, nb.pending)

    def test_a_switch_across_an_impure_cell_is_not_refused(self):
        """The contrast with an accumulator, and the reason there is no
        guard here. Re-performing a fetch restores it; advancing a counter
        does not, and the value it left is unrecoverable."""
        nb, _, knob, page, _ = self.build(impure=True)
        nb.fork("alt")
        nb.set(knob, "url = 'b'")

        nb.switch("main")  # no StatefulVariantError
        self.assertEqual(nb.current, "main")
        self.assertFalse(nb.stateful(page))

    def test_inspect_reports_the_flag(self):
        nb, _, _, page, _ = self.build(impure=True)
        described = {c["id"]: c for c in nb.describe()["cells"]}
        self.assertTrue(described[page]["impure"])
        self.assertFalse(described[page]["stateful"])  # a different thing

    # ---- the metadata channel itself

    def test_a_set_that_says_nothing_keeps_the_flag(self):
        """As `name` survives a `set`: an edit carrying source is not a
        request to clear the cell's metadata."""
        nb, _, _, page, _ = self.build(impure=True)
        nb.set(page, "page = _fetch(url) + '!'")
        self.assertTrue(nb.cells[page].impure)

        nb.set(page, "page = _fetch(url)", impure=False)
        self.assertFalse(nb.cells[page].impure)

    def test_two_variants_differing_only_in_the_flag_are_two_programs(self):
        """`diff` compares what the cells compute, and the flag decides
        whether a cell is ever answered from the cache — so a variant that
        only sets it has to produce an edit, or switching would be a no-op
        that silently left the wrong program running."""
        nb, _, _, page, _ = self.build()
        nb.fork("live")
        nb.set(page, "page = _fetch(url)", impure=True)

        described = {v["name"]: v for v in nb.describe_variants()["variants"]}
        self.assertEqual(described["main"]["differs"], [page])

        nb.switch("main")
        self.assertFalse(nb.cells[page].impure)  # the flag travelled back
        nb.switch("live")
        self.assertTrue(nb.cells[page].impure)  # ...and forward again


class Counted:
    """Counts how many times it is pickled — i.e. how often the kernel
    computes its content address."""

    pickled = 0

    def __reduce__(self):
        type(self).pickled += 1
        return (Counted, ())


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

    def test_impure_travels_the_protocol_on_every_verb(self):
        """It is declared, so the wire is the only way it can arrive."""
        nb = Notebook(seed=1)
        cid = handle(nb, {"tool": "add_cell", "src": "x = 1", "impure": True})["id"]
        described = {c["id"]: c for c in handle(nb, {"tool": "inspect"})["cells"]}
        self.assertTrue(described[cid]["impure"])

        # A `set_cell` that says nothing about the flag leaves it alone.
        handle(nb, {"tool": "set_cell", "id": cid, "src": "x = 2"})
        self.assertTrue(nb.cells[cid].impure)

        # ...and `apply_edits` carries it on both arms.
        edits = [{"op": "set", "id": cid, "src": "x = 3", "impure": False}]
        handle(nb, {"tool": "apply_edits", "edits": edits})
        self.assertFalse(nb.cells[cid].impure)

        made = [{"op": "add", "src": "y = 1", "impure": True}]
        added = handle(nb, {"tool": "apply_edits", "edits": made})
        self.assertTrue(nb.cells[added["created"][0]].impure)

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
