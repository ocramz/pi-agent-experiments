"""Property-based tests for the invariants the kernel is sold on.

The unit suite checks named scenarios; these check the laws. Run with:

    uv run python -m unittest discover -s test-py

hypothesis is a dev dependency, not a runtime one — without it this
module skips itself so a bare interpreter still runs the rest.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

try:
    from hypothesis import HealthCheck, given, settings
    from hypothesis import strategies as st

    HAVE_HYPOTHESIS = True
except ImportError:  # pragma: no cover
    HAVE_HYPOTHESIS = False

from kernel import (  # noqa: E402
    CycleError,
    DuplicateNameError,
    Edit,
    MultipleDefinitionError,
    Notebook,
    analyze,
    digest,
)

if not HAVE_HYPOTHESIS:  # pragma: no cover
    raise unittest.SkipTest("hypothesis not installed")


# ----------------------------------------------------------- strategies

MAX_VARS = 6
SLOW = settings(
    max_examples=60,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow],
)


@st.composite
def dags(draw, size=MAX_VARS):
    """A random DAG over variables v0..vn, as one cell per variable.

    Cell k reads a subset of {v0..v(k-1)}, which makes acyclicity
    structural: a cell can only ever read a lower-numbered variable.
    Returns [(var, src)] in a random *insertion* order, so the graph the
    kernel sees is not pre-sorted.
    """
    n = draw(st.integers(min_value=1, max_value=size))
    cells = []
    for k in range(n):
        parents = draw(st.lists(st.sampled_from(range(k)), unique=True)) if k else []
        rhs = " + ".join(f"v{p}" for p in parents) or str(draw(st.integers(0, 9)))
        cells.append((f"v{k}", f"v{k} = {rhs}"))
    return draw(st.permutations(cells))


def build(cells, seed=0):
    """A notebook holding `cells`, run. Returns (nb, {var: cid})."""
    nb = Notebook(seed=seed)
    ids = {}
    for var, src in cells:
        ids[var], _ = nb.add(src, run=False)
    nb.run()
    return nb, ids


def ns_digests(nb):
    """The observable result of a notebook: every global some cell owns."""
    return {n: digest(nb.ns[n]) for n in nb.provider if n in nb.ns}


def full_state(nb):
    """Everything staging promises to roll back."""
    return (
        dict(nb.cells),
        dict(nb.provider),
        dict(nb.parents_of),
        {k: set(v) for k, v in nb.kids.items()},
        set(nb.pending),
        dict(nb.done),
        nb.env,
    )


# ------------------------------------------------------------ properties


class TestGraph(unittest.TestCase):
    @SLOW
    @given(dags())
    def test_topo_is_a_topological_order(self, cells):
        nb, _ = build(cells)
        order = nb.topo()
        position = {cid: i for i, cid in enumerate(order)}
        self.assertEqual(len(order), len(nb.cells))
        for cid in nb.cells:
            for parent in nb.parents_of[cid]:
                self.assertLess(position[parent], position[cid])

    @SLOW
    @given(dags(), st.data())
    def test_topo_of_a_subset_is_a_topological_order(self, cells, data):
        nb, _ = build(cells)
        picks = st.lists(st.sampled_from(sorted(nb.cells)), unique=True)
        subset = set(data.draw(picks))
        order = nb.topo(subset)
        self.assertEqual(set(order), subset)
        position = {cid: i for i, cid in enumerate(order)}
        for cid in subset:
            for parent in nb.parents_of[cid] & subset:
                self.assertLess(position[parent], position[cid])

    @SLOW
    @given(dags(), st.integers(0, 1000), st.integers(0, 1000))
    def test_order_is_independent_of_generated_ids(self, cells, seed_a, seed_b):
        """Ids are random; execution order must not be."""
        a, ids_a = build(cells, seed=seed_a)
        b, ids_b = build(cells, seed=seed_b)
        to_var_a = {cid: var for var, cid in ids_a.items()}
        to_var_b = {cid: var for var, cid in ids_b.items()}
        self.assertEqual(
            [to_var_a[cid] for cid in a.topo()],
            [to_var_b[cid] for cid in b.topo()],
        )

    @SLOW
    @given(dags())
    def test_descendants_agree_with_reachability(self, cells):
        nb, _ = build(cells)
        for cid in nb.cells:
            reachable = {k for k in nb.cells if cid in nb.parents_of[k]}
            self.assertTrue(reachable <= nb.descendants(cid))
            for kid in nb.descendants(cid):
                self.assertIn(cid, nb.descendants(cid) | {cid})
                self.assertNotEqual(kid, cid)  # a DAG has no self-descendant


class TestIncrementalEqualsFromScratch(unittest.TestCase):
    """The headline claim: the notebook is a program, not a transcript."""

    @SLOW
    @given(dags(), st.data())
    def test_edits_then_replay_match_a_fresh_build(self, cells, data):
        nb, ids = build(cells)
        sources = dict(cells)

        # A few edits: change a leaf constant or an interior expression.
        for _ in range(data.draw(st.integers(min_value=1, max_value=4))):
            var = data.draw(st.sampled_from(sorted(sources)))
            k = int(var[1:])
            parents = [f"v{p}" for p in range(k)]
            rhs = data.draw(
                st.sampled_from(
                    [str(data.draw(st.integers(0, 99)))]
                    + ([" + ".join(parents)] if parents else [])
                )
            )
            sources[var] = f"{var} = {rhs}"
            nb.set(ids[var], sources[var])

        fresh, _ = build(list(sources.items()))
        self.assertEqual(ns_digests(nb), ns_digests(fresh))

    @SLOW
    @given(dags())
    def test_caching_never_changes_the_result(self, cells):
        """Early cutoff must be invisible: a notebook whose cache is
        wiped before every run must reach the same namespace."""
        cached, _ = build(cells)
        uncached, _ = build(cells)
        uncached.done.clear()
        uncached.pending = set(uncached.cells)
        uncached.run()
        self.assertEqual(ns_digests(cached), ns_digests(uncached))

    @SLOW
    @given(dags())
    def test_run_all_is_idempotent_for_stateless_cells(self, cells):
        nb, _ = build(cells)
        once = ns_digests(nb)
        nb.run_all()
        self.assertEqual(once, ns_digests(nb))

    @SLOW
    @given(dags())
    def test_nothing_pending_after_a_successful_run(self, cells):
        nb, _ = build(cells)
        self.assertEqual(nb.pending, set())
        self.assertEqual(nb.failing(), [])


class TestStaging(unittest.TestCase):
    REJECTED = (
        MultipleDefinitionError,
        DuplicateNameError,
        CycleError,
        SyntaxError,
        KeyError,
        ValueError,
    )

    @SLOW
    @given(
        dags(),
        st.lists(
            st.sampled_from(
                [
                    ("dup-def", "v0 = 1"),  # MultipleDefinitionError
                    ("syntax", "v9 = ("),  # SyntaxError
                    ("missing", None),  # KeyError on set/delete
                    ("ok", "spare = 1"),
                ]
            ),
            min_size=1,
            max_size=3,
        ),
    )
    def test_a_rejected_batch_changes_nothing(self, cells, kinds):
        nb, _ = build(cells)
        before = full_state(nb)
        before_ns = ns_digests(nb)

        edits = []
        for kind, src in kinds:
            if kind == "missing":
                edits.append(Edit("set", id="zzzzzz", src="x = 1"))
            else:
                edits.append(Edit("add", src=src))

        try:
            nb.apply(edits)
        except self.REJECTED:
            self.assertEqual(full_state(nb), before)
            self.assertEqual(ns_digests(nb), before_ns)

    @SLOW
    @given(dags())
    def test_plan_does_not_commit_and_bounds_apply(self, cells):
        nb, ids = build(cells)
        var = sorted(ids)[0]
        edit = [Edit("set", id=ids[var], src=f"{var} = 12345")]

        before = full_state(nb)
        predicted = nb.plan(edit)
        self.assertEqual(full_state(nb), before)  # plan is side-effect free

        results, _ = nb.apply(edit)
        touched = {r.cell for r in results} | nb.pending
        self.assertTrue(touched <= predicted)

    @SLOW
    @given(dags())
    def test_deleting_every_cell_retracts_every_global(self, cells):
        nb, ids = build(cells)
        owned = set(nb.provider)
        nb.apply([Edit("delete", id=cid) for cid in list(nb.cells)])
        self.assertEqual(nb.cells, {})
        self.assertEqual(nb.done, {})  # no orphaned cache entries
        for name in owned:
            self.assertNotIn(name, nb.ns)

    @SLOW
    @given(dags())
    def test_a_cell_deleted_and_recreated_does_not_inherit_a_cache_hit(self, cells):
        nb, ids = build(cells)
        var = sorted(ids)[-1]
        cid = ids[var]
        nb.delete(cid)
        again, results = nb.add(f"{var} = 4242")
        self.assertEqual({r.cell: r.status for r in results}[again], "ran")


class TestFailureIsolation(unittest.TestCase):
    @SLOW
    @given(dags(), st.data())
    def test_no_descendant_of_a_failure_reports_ran(self, cells, data):
        nb, ids = build(cells)
        var = data.draw(st.sampled_from(sorted(ids)))
        results = nb.set(ids[var], f"{var} = undefined_name_xyz")
        statuses = {r.cell: r.status for r in results}
        self.assertEqual(statuses[ids[var]], "error")
        for kid in nb.descendants(ids[var]):
            self.assertNotEqual(statuses.get(kid), "ran")
            self.assertIn(kid, nb.pending)  # skipped, not poisoned

    @SLOW
    @given(dags(), st.data())
    def test_a_failure_leaves_no_half_written_state(self, cells, data):
        nb, ids = build(cells)
        var = data.draw(st.sampled_from(sorted(ids)))
        before = nb.ns.get(var)
        nb.set(ids[var], f"{var} = 1 / 0")
        self.assertEqual(nb.ns.get(var), before)  # restored, not left broken


class TestAnalyzePurity(unittest.TestCase):
    IDENT = st.sampled_from(["a", "b", "c", "rows", "n", "x"])

    @SLOW
    @given(IDENT, IDENT)
    def test_comprehension_target_is_never_a_def(self, target, source):
        defs, _ = analyze(f"out = [{target} * 2 for {target} in {source}]")
        self.assertNotIn(target, defs)
        self.assertIn("out", defs)

    @SLOW
    @given(IDENT, IDENT)
    def test_a_real_binding_survives_a_comprehension_of_the_same_name(
        self, name, source
    ):
        defs, _ = analyze(f"{name} = 1\nout = [{name} for {name} in {source}]")
        self.assertIn(name, defs)

    @SLOW
    @given(IDENT)
    def test_del_never_defines(self, name):
        defs, _ = analyze(f"{name} = 1\ndel {name}")
        self.assertNotIn(name, defs)

    @SLOW
    @given(IDENT, IDENT)
    def test_subscript_assignment_defines_nothing(self, container, key):
        """`d[k] = v` mutates d; it does not bind d or k."""
        src = f"{container}[{key}] = 1"
        defs, refs = analyze(src)
        self.assertNotIn(container, defs)
        self.assertIn(container, refs)

    @SLOW
    @given(IDENT)
    def test_function_locals_never_escape(self, name):
        defs, refs = analyze(f"def f({name}):\n    return {name} + 1")
        self.assertEqual(defs, frozenset({"f"}))
        self.assertNotIn(name, refs)

    @SLOW
    @given(IDENT)
    def test_self_reference_is_both(self, name):
        defs, refs = analyze(f"{name} = {name} + 1")
        self.assertIn(name, defs)
        self.assertIn(name, refs)


class TestDigestStability(unittest.TestCase):
    """Keys are lineage (docs/persistence.md), so they must be a
    function of content alone — no addresses, no run-to-run drift."""

    # (source, an edit to it that changes behaviour). The nested `def`
    # and `lambda` cases are the ones a repr-based digest gets wrong:
    # their code objects live in `co_consts`, and a code object's repr
    # carries its address.
    EDITS = st.sampled_from(
        [
            ("def f():\n    return 1", "def f():\n    return 2"),
            (
                "def f():\n    g = lambda x: x + 1\n    return g(2)",
                "def f():\n    g = lambda x: x + 99\n    return g(2)",
            ),
            (
                "def f():\n    def inner():\n        return 7\n    return inner",
                "def f():\n    def inner():\n        return 8\n    return inner",
            ),
            ("f = lambda: [i for i in range(3)]", "f = lambda: [i for i in range(4)]"),
        ]
    )

    @SLOW
    @given(EDITS)
    def test_identical_sources_digest_identically(self, pair):
        src, _ = pair
        a, b = Notebook(seed=1), Notebook(seed=2)
        a.add(src)
        b.add(src)
        self.assertEqual(digest(a.ns["f"]), digest(b.ns["f"]))

    @SLOW
    @given(EDITS)
    def test_an_edited_body_digests_differently(self, pair):
        src, edited = pair
        nb = Notebook(seed=1)
        cid, _ = nb.add(src)
        before = digest(nb.ns["f"])
        nb.set(cid, edited)
        self.assertNotEqual(digest(nb.ns["f"]), before)


if __name__ == "__main__":
    unittest.main()
