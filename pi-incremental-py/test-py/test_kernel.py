"""Stdlib-only tests for the reactive kernel. Run with:

    python3 -m unittest discover -s test-py

No third-party packages required.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

import protocol  # noqa: E402
from kernel import (  # noqa: E402
    CycleError,
    DuplicateNameError,
    Edit,
    MultipleDefinitionError,
    Notebook,
    Result,
    analyze,
    file_digest,
)
from kernel.values import _hash_file  # noqa: E402
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


class TestVolatile(unittest.TestCase):
    """A declared-volatile cell is never served from cache, and neither
    is anything downstream of it.

    The downstream half is not a nicety. `digest` sees a function's code,
    closures, defaults and globals — all of which sit perfectly still for
    `def now(): return time.time()` — so a cell calling `now()` keys
    constant and would cache a stale answer forever.
    """

    def statuses(self, results):
        return {r.cell: r.status for r in results}

    def test_declared_volatile_never_reports_cached(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("import time\nstamp = time.time()", volatile=True)
        first = nb.ns["stamp"]
        results = nb.run_all(restart=False)
        self.assertEqual(self.statuses(results)[cid], "ran")
        self.assertNotEqual(nb.ns["stamp"], first)

    def test_an_ordinary_neighbour_still_caches(self):
        # The flag must not be a blunt instrument on the whole notebook.
        nb = Notebook(seed=1)
        vol, _ = nb.add("import time\nstamp = time.time()", volatile=True)
        plain, _ = nb.add("total = 1 + 1")
        results = nb.run_all(restart=False)
        self.assertEqual(self.statuses(results)[vol], "ran")
        self.assertEqual(self.statuses(results)[plain], "cached")

    def test_volatility_reaches_readers_through_a_function(self):
        nb = Notebook(seed=1)
        src, _ = nb.add("import time\ndef now(): return time.time()", volatile=True)
        reader, _ = nb.add("t = now()")
        self.assertEqual(nb.volatile(), {src, reader})

        before = nb.ns["t"]
        nb.pending = {src, reader}
        self.assertEqual(self.statuses(nb.run())[reader], "ran")
        self.assertNotEqual(nb.ns["t"], before)

    def test_undeclared_volatility_is_still_stale(self):
        """What the declaration buys, stated as what its absence costs.

        `now`'s digest never moves — code, closures, defaults and globals
        all sit still — so the reader's key never moves and it reports
        `cached` over a timestamp from minutes ago. `time` raises no
        audit event, so nothing can catch this for us: it is exactly the
        case the flag exists for.
        """
        nb = Notebook(seed=1)
        nb.add("import time\ndef now(): return time.time()")
        reader, _ = nb.add("t = now()")
        nb.pending = {reader}
        self.assertEqual(self.statuses(nb.run())[reader], "cached")

    def test_editing_a_cell_reconsiders_its_demotion(self):
        """A demotion describes source, so replacing the source drops it.

        Otherwise a cell that once called `requests.get` would keep
        re-running forever after being rewritten into `x = 1`.
        """
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1")
        nb.detected.add(cid)
        nb.reads[cid] = ("/tmp/gone.csv",)
        nb.set(cid, "x = 2")  # re-runs, so `reads` is re-recorded as empty
        self.assertNotIn(cid, nb.detected)
        self.assertEqual(nb.reads.get(cid, ()), ())
        self.assertEqual(self.statuses(nb.run_all(restart=False))[cid], "cached")

    def test_set_without_the_flag_keeps_it(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1", volatile=True)
        nb.set(cid, "x = 2")
        self.assertTrue(nb.cells[cid].volatile)

    def test_set_can_clear_the_flag_explicitly(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1", volatile=True)
        nb.set(cid, "x = 2", volatile=False)
        self.assertFalse(nb.cells[cid].volatile)
        self.assertEqual(nb.volatile(), set())

    def test_a_recycled_id_inherits_nothing(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add("x = 1")
        nb.detected.add(cid)
        nb.reads[cid] = ("/tmp/whatever",)
        nb.delete(cid)
        self.assertNotIn(cid, nb.detected)
        self.assertNotIn(cid, nb.reads)


class TestTrackedFileReads(unittest.TestCase):
    """A file a cell reads is an input, not a surrender.

    The audit hook cannot digest a socket, so a cell touching one has to
    re-run forever. A file is different: it has content, so the honest
    move is to put that content in the key and let the cell cache until
    the file actually changes.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.data = os.path.join(self.tmp, "data.csv")
        self.write("a,b\n1,2\n")
        _hash_file.cache_clear()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, text):
        # mtime has coarse granularity on some filesystems, and the stat
        # gate keys on it. Stepping it explicitly keeps these cases off
        # the clock instead of sleeping through it.
        with open(self.data, "w") as handle:
            handle.write(text)
        stamp = os.stat(self.data).st_mtime_ns + 10_000_000_000
        os.utime(self.data, ns=(stamp, stamp))

    def reader(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add(f"rows = open({self.data!r}).read()")
        return nb, cid

    def status(self, nb, cid):
        nb.pending = {cid}
        return {r.cell: r.status for r in nb.run()}[cid]

    def test_the_file_becomes_an_input(self):
        nb, cid = self.reader()
        self.assertEqual(nb.reads[cid], (self.data,))

    def test_unchanged_file_caches(self):
        nb, cid = self.reader()
        self.assertEqual(self.status(nb, cid), "cached")

    def test_changed_contents_rerun(self):
        nb, cid = self.reader()
        self.write("a,b\n1,2\n3,4\n")
        self.assertEqual(self.status(nb, cid), "ran")
        self.assertEqual(nb.ns["rows"].count("\n"), 3)

    def test_identical_rewrite_still_caches(self):
        """The case that pins the content hash.

        mtime moves, so the stat gate opens and the file is re-read — but
        the digest comes back the same, the key does not move, and early
        cutoff holds. An mtime-only comparison would re-run here, and
        would drag every downstream cell along with it.
        """
        nb, cid = self.reader()
        self.write("a,b\n1,2\n")
        self.assertEqual(self.status(nb, cid), "cached")

    def test_creating_a_missing_file_invalidates(self):
        missing = os.path.join(self.tmp, "later.txt")
        nb = Notebook(seed=1)
        src = f"try:\n    v = open({missing!r}).read()\nexcept OSError:\n    v = None"
        cid, _ = nb.add(src)
        self.assertEqual(nb.reads[cid], (missing,))
        self.assertEqual(self.status(nb, cid), "cached")

        with open(missing, "w") as handle:
            handle.write("hello")
        self.assertEqual(self.status(nb, cid), "ran")
        self.assertEqual(nb.ns["v"], "hello")

    def test_writes_are_not_inputs(self):
        # A cell does not depend on what it produced itself.
        out = os.path.join(self.tmp, "out.txt")
        nb = Notebook(seed=1)
        cid, _ = nb.add(f"open({out!r}, 'w').write('x')\ndone = True")
        self.assertEqual(nb.reads.get(cid, ()), ())

    def test_the_stat_gate_skips_the_read(self):
        # Invisible from the notebook, and the whole point of the memo:
        # an unchanged file costs one stat, not a re-read.
        file_digest(self.data)
        before = _hash_file.cache_info()
        file_digest(self.data)
        after = _hash_file.cache_info()
        self.assertEqual(after.hits, before.hits + 1)
        self.assertEqual(after.misses, before.misses)

    def test_a_transient_failure_is_not_memoised(self):
        """`chmod` moves ctime, not mtime.

        So caching a read failure would keep serving `<missing-file>`
        under an unchanged key long after the file became readable — the
        reason the failure path sits outside the memo.
        """
        os.chmod(self.data, 0o000)
        if os.access(self.data, os.R_OK):
            self.skipTest("running as root: permissions do not bite")
        self.assertEqual(file_digest(self.data), "<missing-file>")
        os.chmod(self.data, 0o644)
        self.assertNotEqual(file_digest(self.data), "<missing-file>")

    def test_a_fifo_is_refused_rather_than_hashed(self):
        """Hashing a FIFO would hang, not raise — so S_ISREG comes first."""
        fifo = os.path.join(self.tmp, "pipe")
        os.mkfifo(fifo)
        self.assertIsNone(file_digest(fifo))

    def test_an_undigestible_read_demotes_the_cell(self):
        fifo = os.path.join(self.tmp, "pipe")
        os.mkfifo(fifo)
        nb = Notebook(seed=1)
        cid, _ = nb.add("opened = True")
        nb._record(cid, Result(cid, "ran", 0.0, reads=(fifo,)))
        self.assertIn(cid, nb.detected)
        self.assertNotIn(cid, nb.reads)
        self.assertEqual(self.status(nb, cid), "ran")

    def test_too_many_reads_degrades_to_volatile(self):
        for i in range(70):
            with open(os.path.join(self.tmp, f"f{i}.txt"), "w") as handle:
                handle.write(str(i))
        pattern = os.path.join(self.tmp, "f*.txt")
        nb = Notebook(seed=1)
        cid, _ = nb.add(
            f"import glob\n"
            f"blobs = [open(p).read() for p in sorted(glob.glob({pattern!r}))]"
        )
        self.assertIn(cid, nb.detected)
        self.assertEqual(nb.reads.get(cid, ()), ())
        self.assertEqual(self.status(nb, cid), "ran")

    def test_an_importing_cell_tracks_nothing(self):
        """The regression that would silently destroy the whole cache.

        `import json` really does open a dozen files. Without the
        interpreter-path filter every importing cell would either carry a
        dozen spurious inputs or trip the count guard and stop caching.
        """
        nb = Notebook(seed=1)
        cid, _ = nb.add("import json\nblob = json.dumps({'a': 1})")
        self.assertEqual(nb.reads.get(cid, ()), ())
        self.assertEqual(nb.detected, set())
        self.assertEqual(self.status(nb, cid), "cached")


class TestUndigestibleEffects(unittest.TestCase):
    """What the hook catches that no static analysis could.

    Hermetic: `socket.connect` fires before the connection is made, so
    the event is raised whether or not anything is listening.
    """

    SRC = (
        "import socket\n"
        "_s = socket.socket()\n"
        "_s.settimeout(0.01)\n"
        "try:\n"
        "    _s.connect(('127.0.0.1', 1))\n"
        "except OSError:\n"
        "    pass\n"
        "finally:\n"
        "    _s.close()\n"
        "reached = True\n"
    )

    def test_a_socket_demotes_the_cell(self):
        nb = Notebook(seed=1)
        cid, results = nb.add(self.SRC)
        self.assertIn("socket.connect", results[0].effects)
        self.assertIn(cid, nb.detected)
        self.assertIn(cid, nb.volatile())

    def test_the_demoted_cell_stops_caching(self):
        nb = Notebook(seed=1)
        cid, _ = nb.add(self.SRC)
        nb.pending = {cid}
        self.assertEqual({r.cell: r.status for r in nb.run()}[cid], "ran")

    def test_an_ordinary_cell_records_nothing(self):
        nb = Notebook(seed=1)
        _, results = nb.add("total = sum(range(10))")
        self.assertEqual(results[0].effects, ())
        self.assertEqual(results[0].reads, ())


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

    def test_volatile_crosses_the_wire(self):
        nb = Notebook(seed=1)
        resp = handle(
            nb,
            {
                "tool": "add_cell",
                "src": "import time\nt = time.time()",
                "volatile": True,
            },
        )
        cid = resp["id"]
        self.assertTrue(nb.cells[cid].volatile)
        self.assertTrue(resp["results"][0]["volatile"])

        again = handle(nb, {"tool": "run_all", "restart": False})
        self.assertEqual(again["results"][0]["status"], "ran")

    def test_set_over_the_wire_keeps_the_flag(self):
        nb = Notebook(seed=1)
        cid = handle(nb, {"tool": "add_cell", "src": "x = 1", "volatile": True})["id"]
        handle(nb, {"tool": "set_cell", "id": cid, "src": "x = 2"})
        self.assertTrue(nb.cells[cid].volatile)
        handle(nb, {"tool": "set_cell", "id": cid, "src": "x = 3", "volatile": False})
        self.assertFalse(nb.cells[cid].volatile)

    def test_a_non_boolean_flag_is_refused(self):
        # `from_json` is the wire boundary, so it validates rather than
        # silently coercing "no" into a truthy declaration.
        nb = Notebook(seed=1)
        resp = handle(
            nb,
            {
                "tool": "apply_edits",
                "edits": [{"op": "add", "src": "x = 1", "volatile": "yes"}],
            },
        )
        self.assertFalse(resp["ok"])
        self.assertIn("volatile", resp["error"])

    def test_edits_accept_the_flag(self):
        nb = Notebook(seed=1)
        resp = handle(
            nb,
            {
                "tool": "apply_edits",
                "edits": [{"op": "add", "src": "x = 1", "volatile": True}],
            },
        )
        self.assertTrue(resp["ok"])
        self.assertTrue(nb.cells[resp["created"][0]].volatile)

    def test_results_do_not_carry_read_paths(self):
        # Dozens of paths per cell, unchanged between runs: `inspect`
        # reports them once instead.
        nb = Notebook(seed=1)
        resp = handle(nb, {"tool": "add_cell", "src": "x = 1"})
        self.assertNotIn("reads", resp["results"][0])

    def test_inspect_reports_volatility_and_reads(self):
        nb = Notebook(seed=1)
        cid = handle(nb, {"tool": "add_cell", "src": "x = 1", "volatile": True})["id"]
        desc = handle(nb, {"tool": "inspect"})
        cell = next(c for c in desc["cells"] if c["id"] == cid)
        self.assertTrue(cell["volatile"])
        self.assertEqual(cell["reads"], [])

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


class TestInstallReportsWhatItDid(unittest.TestCase):
    """An install re-runs cells, so it owes its caller the same tails every
    other mutating op returns: `pending`, `failing` and the globals it was
    called to move. Without them the agent has to spend a second `inspect`
    to find out what the install it just made left behind — and an agent
    that does not bother is left asserting from a bare `ran`.

    Hermetic: pip is replaced by a success and the environment digest is
    moved by hand, which is exactly the state change a real install causes.
    See test/container/test_install_in_image.sh for the same claim against
    a real PyPI round trip.
    """

    PROBE = (
        "try:\n"
        "    import cowsay\n"
        "    have_cowsay = True\n"
        "except ImportError:\n"
        "    have_cowsay = False\n"
    )

    def install(self, nb, digest="cowsay just landed"):
        ok = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        with (
            mock.patch.object(protocol, "_pip", return_value=ok),
            mock.patch.object(protocol, "env_digest", return_value=digest),
        ):
            return protocol.install(nb, "cowsay")

    def test_install_reports_the_state_it_left(self):
        nb = Notebook(seed=1)
        nb.add("base = 6 * 7")
        probe, _ = nb.add(self.PROBE)
        resp = self.install(nb)

        self.assertTrue(resp["ok"])
        self.assertTrue(resp["environment_changed"])
        self.assertEqual(resp["restart_required"], [])
        # The re-run the install triggered, and its consequences — the three
        # keys below used to be absent from an install response entirely.
        statuses = {r["cell"]: r["status"] for r in resp["results"]}
        self.assertEqual(statuses[probe], "ran")
        self.assertEqual(resp["globals"]["have_cowsay"], "False")
        self.assertEqual(resp["globals"]["base"], "42")  # untouched, still reported
        self.assertEqual(resp["pending"], [])
        self.assertEqual(resp["failing"], [])

    def test_a_still_environment_still_reports_state(self):
        # An install that changed nothing is not a no-op for the caller: it
        # still wants to know what the kernel holds. `environment_changed`
        # false answers a different question.
        nb = Notebook(seed=1)
        nb.add("base = 6 * 7")
        resp = self.install(nb, digest=nb.env)

        self.assertFalse(resp["environment_changed"])
        self.assertEqual(resp["results"], [])
        self.assertEqual(resp["globals"]["base"], "42")


if __name__ == "__main__":
    unittest.main()
