# The authoring model: what the kernel commits a user to

What kind of Python you have to write for this kernel to work, which of those
constraints are the design, and which are accidents worth removing.

The [README](../README.md)'s "Kernel semantics" describes the model as intended.
This document describes it as observed, and is deliberately the pessimistic
counterpart: it catalogues the places where the two differ.

Everything below was verified by driving `kernel.analysis.analyze` and
`kernel.notebook.Notebook` directly under Python 3.13. Probe output is quoted
inline. Nothing here is inferred from reading alone.

---

## 1. Observations

### 1.1 The rule that generates everything else

One provider per global name, notebook-wide
([graph.py:39-46](../py/kernel/graph.py#L39-L46)). Two cells binding the same
name is a `MultipleDefinitionError`, validated on the final graph per batch, with
rollback ([notebook.py:161-170](../py/kernel/notebook.py#L161-L170)). There is no
last-writer-wins and no shadowing.

Every constraint in section 3 is a consequence of this rule meeting a definition
of "binds" that is wider than the rule needs.

### 1.2 Edges are deduped by construction; symbol identity is discarded

Asked directly, since it is the question that started this document. Cells
sharing several symbols produce exactly one edge.

```python
parents_of = {
    cid: frozenset(
        provider[n] for n in cell.refs if n in provider and provider[n] != cid
    )
    for cid, cell in cells.items()
}
```
— [graph.py:51-56](../py/kernel/graph.py#L51-L56)

The generator yields the same provider id once per shared symbol; the
`frozenset` collapses them. `kids` is built from `set()` and frozen at
[graph.py:65](../py/kernel/graph.py#L65). Dedup happens three times over, each
redundant with the next: `Analysis.defs`/`refs` are already `frozenset`
([analysis.py:66-67](../py/kernel/analysis.py#L66-L67)), so multiplicity is gone
before the graph is reached at all.

There is no per-symbol edge label anywhere. Nothing downstream can ask which name
an edge is for, and no code needs to.

**The invariant this rests on is implicit and coupled.** `topo` computes
in-degree as `len(parents_of[i] & ids)` — distinct parents — but decrements once
per entry in `kids[node]` ([graph.py:111-123](../py/kernel/graph.py#L111-L123)).
The two containers must agree on multiplicity. If `parents_of` ever became a
list with a repeated parent, `indeg` would never reach zero and the failure would
surface as a **spurious `CycleError`**, which reads as a graph-shape bug and not
as a dedup bug. Now stated in a comment at the site, and covered by tests; see
[P0](#p0--cheap-and-uncontested-done).

### 1.3 What counts as a definition

Every binding at a cell's top level, including ones no other cell could ever
use. Probed:

```
loop var          defs=['i']              refs=['print', 'range']
comprehension     defs=['ys']             refs=['range']
with-as           defs=['data', 'f']      refs=['open']
except-as         defs=[]                 refs=['ValueError', 'go', 'print']
bare annotation   defs=[]                 refs=['int']
import            defs=['np']             refs=[]
private helper    defs=['_fmt']           refs=['str']
star import       defs=[]                 refs=[]
inplace mutate    defs=[]                 refs=['xs']
```

Three exemptions exist, all narrow, and all under the same
nothing-else-binds-that-name guard:

- **`phantom`** — comprehension targets, excused under PEP 709.
- **`deleted`** — `del x` retracts a definition (verified: a cell doing
  `scratch = 1; keep = scratch + 1; del scratch` defines only `keep`, and caches).
- **`transient`** — `except ... as e` and a valueless `x: int`, the two positions
  where the language itself takes the name back. Added by
  [P1](#p1--the-caching-bug-21-done); before it, both were defs that could never
  be in the namespace.

All three are in `_survey_bindings`
([analysis.py:155-217](../py/kernel/analysis.py#L155-L217)).

Note what is *not* exempt: the loop variable and the `with` target still claim
their names notebook-wide. They dropped out of `refs`, not out of `defs` — the
scratch-variable tax in §3.1 is unchanged and remains P2's business.

### 1.4 What counts as a reference

Globals read from the incoming namespace, including reads deferred inside
function and class bodies ([analysis.py:109-121](../py/kernel/analysis.py#L109-L121)).
`def f(): return g()` refs `g`. This is what makes function-valued cells re-key
correctly, and also what makes section 3.3 happen.

*Incoming* is the load-bearing word, and symtable cannot supply it: it reports
what is assigned and what is referenced, never in what order. A load the cell has
provably already bound reads back its own binding, so it is not a dependency at
all, and `_shadowed_reads` drops it. Two things are provable — a load inside the
body of the `for`/`with`/`except` that binds it, and a load after a top-level
statement `_certainly_bound` accounts for. Everything else keeps the ref. §2.1
is what happens when this is not done.

Unresolved refs (builtins nobody shadows, genuinely undefined names) produce no
edge. Self-refs are excluded from the topological graph and handled temporally in
`_inputs_key` ([notebook.py:244-265](../py/kernel/notebook.py#L244-L265)).

### 1.5 One namespace, shared

`self.ns` is a single dict for the whole notebook
([notebook.py:42](../py/kernel/notebook.py#L42)). Cells are not isolated at
runtime; the graph is the only thing that imposes structure. This matters for
§2.2: anything that moves a value without moving a *name* is invisible.

---

## 2. Known bugs

### 2.1 Ordinary Python that cached never, and silently (fixed)

**Fixed in [P1](#p1--the-caching-bug-21-done); kept because it is the sharpest
statement of what `defs` and `refs` are for.** What follows is the state before
the fix.

Two mechanisms, both reaching the same place. Probed, with a plain cell as
control:

| cell | defs | refs | 2nd run |
|---|---|---|---|
| `x = int("1")` | `x` | | `cached` |
| `try: x = int("1")` / `except ValueError as e: x = 0` | `e`, `x` | | **`ran`** |
| `y: int` / `z = 1` | `y`, `z` | | **`ran`** |
| `flag = False` / `if flag: extra = 1` / `base = 2` | `base`, `extra`, `flag` | | **`ran`** |
| `rows = []` / `for r in rows: pass` / `n = 0` | `n`, `r`, `rows` | | **`ran`** |
| `with open(p) as f:` / `    text = f.read()` | `f`, `text` | **`f`** | **`ran`** |

**Mechanism one — `_fresh` required every static def to be in the namespace:**

```python
all(name in self.ns for name in self.cells[cid].defs)
```
— was [notebook.py:366](../py/kernel/notebook.py#L366); now
[notebook.py:382](../py/kernel/notebook.py#L382)

When a name enters `defs` but never lands in `ns`, that condition is permanently
false and the cell **re-executes on every pass, forever**. Four causes, rows 2-5:

- **`except ... as e`** — Python implicitly deletes the handler name at the end
  of the block, and the implicit delete leaves no `ast.Del` node for the
  `deleted` pass to find.
- **Bare annotation** — `x: int` binds nothing at runtime. `_certainly_bound`
  already knew this, but the knowledge was used only for the tail correction.
- **Conditional binding** — a branch not taken.
- **A loop that does not iterate** — an empty sequence.

The first two are statically fixable. **The last two are not**: whether `extra`
or `r` binds is a function of runtime data. Any fix confined to the AST leaves
half the class in place, which is what rules out the obvious approach.

**Mechanism two — the key, not the guard.** Row 6 has every def present in `ns`,
so it defeats any repair of `_fresh`. `symtable` sees `f` assigned *and*
referenced, exactly as in `x = x + 1`, so `f` was a temporal self-ref and
`_inputs_key` digested the *previous* `f`: a closed file handle, which pickles to
nothing, so `digest` returns `None`, so `_combine` falls through to
`_hash(time.time_ns())` ([notebook.py:282-293](../py/kernel/notebook.py#L282-L293))
— a key guaranteed to miss. `with open(p) as f: f.read()` is not a corner case.

**One confusion underneath both.** `defs` and `refs` are *may*-sets — what a cell
might bind, and every name it mentions. They are the right sets for ownership and
for edges. The cache needs *must*-sets: what a run definitely left behind, and
what a load definitely read from the incoming namespace. `defs` is repaired by
observing (`Outcome.produced`), `refs` by proving (`_shadowed_reads`); neither is
repaired by shrinking the may-set.

Severity was high and the presentation silent. The cost is incrementality — the
entire product — and nothing surfaced it: `describe()` reports `volatile`,
`stateful` and `failing`, and such a cell was none of the three. It did report
rows 5 and 6 as `stateful`, which was itself wrong.

### 2.2 Cross-cell mutation is invisible and order-dependent

Edges derive from name references, so a cell that mutates a value it does not
bind is a parent of nothing. Ordering then falls back to the insertion-order
tie-break. Same three cells, differing only in creation order:

```
A: xs = [1]        B: xs.append(100)        C: total = sum(xs)

C created before B  ->  parents_of[C] = [A]   total = 1
B created before C  ->  parents_of[C] = [A]   total = 101
```

`B` never appears in `C`'s dependencies in either arrangement. Worse, the result
is **stable under `run_all(restart=True)`** — the first notebook replays to `1`
again — so it presents as reproducible and correct rather than as a race.

This is the one hazard here that produces a silently wrong *answer* rather than a
refusal or a lost optimisation. It also cannot be fixed by static analysis in
Python, which the kernel already accepts elsewhere: the audit-hook design
([cell.py:8-23](../py/kernel/cell.py#L8-L23)) exists precisely because the world
must be observed rather than predicted. Mutation deserves the same treatment and
does not currently get it.

### 2.3 Star imports bind nothing

`from os import *` yields `defs=[]`, so every name it introduces is unowned.
Readers of those names resolve to no provider, get no edge, and go stale
silently. The names are real in `ns` but invisible to the graph.

Low frequency, but it is an unbounded hole rather than a bounded one — a single
star import can un-track arbitrarily many names.

---

## 3. Infelicities

Not bugs. Design choices whose cost lands on how the user writes code.

### 3.1 The scratch-variable tax

This is the one that makes notebooks feel stylized.

Because §1.3 counts every top-level binding, throwaway names become notebook-wide
claims. Two cells that each contain `for i in ...` are refused:

```
'i' defined by both ieqh74 and 6yng7b
```

The same applies to `f` from `with open(p) as f`, and to `tmp`, `row`, `line`,
`n`, `path`, and any `_helper` you would naturally write more than once.
(`e` from `except ... as e` was on this list until [P1](#p1--the-caching-bug-21-done)
made it `transient`; it is now the one scratch name two cells may share, because
it is the one Python guarantees does not survive.)

The asymmetry is what makes it feel arbitrary rather than principled:
`[f(x) for x in xs]` is fine in ten cells, `for x in xs:` is an error in two. The
lesson a user extracts — prefer comprehensions, hide loops in functions, invent
unique loop variables — follows from PEP 709 inlining and not from anything about
dataflow.

Note how far the claim exceeds the damage. The namespace really is shared, so two
cells' `i` really do clobber each other in `ns` — but that is observable only if
some cell *reads* `i`, and `i` appears in neither cell's cache key. The kernel
refuses a program that would have been correct.

### 3.2 Single assignment across cells

`df = load()` in one cell and `df = clean(df)` in another is refused. Every
intermediate needs its own name.

**This one is the product.** It is what Marimo and Observable also require, and
it is what makes the graph derivable at all. Listed for completeness, not as a
candidate for change.

### 3.3 Mutually recursive functions cannot span cells

Deferred reads inside function bodies (§1.4) are real refs, so:

```python
def f(n): return 1 if n <= 0 else g(n-1)   # cell A refs g
def g(n): return f(n-1)                    # cell B refs f
```

is `CycleError: cycle among [...]`. Inherent to a DAG; the workaround — keep a
recursive group in one cell — is what a Python module would do anyway. Minor.

### 3.4 Function-valued cells key on the full value of everything they mention

`def plot(): return df` makes the `df` cell a parent, so the `def` cell re-runs
and re-digests `df` whenever it changes. Correct, and required for the volatility
inheritance the README describes — but the work is proportional to the data while
the cell only rebinds a function object. A performance tax, not a style tax.

---

## 4. What a well-behaved notebook currently requires

Collecting the above into the rules a user has to internalise:

1. Single assignment for anything crossing a cell boundary. *(§3.2 — the design)*
2. A globally unique name for every intermediate **and every scratch variable**,
   `except ... as e` excepted. *(§3.1)*
3. Comprehensions over `for` statements, or loops hidden inside functions. *(§3.1)*
4. No cross-cell mutation: no `.append`, no `inplace=True`, no `d[k] = v` on a
   shared dict. *(§2.2)*
5. Imports centralised in one cell. *(§3.1)*

Rules 1 and 4 are the dataflow model asserting itself. Rules 2, 3 and 5 are not —
they are artifacts of the definition of "binds", and are P2's business.

There used to be a sixth: *no bare annotations, no `except ... as`, and no
conditionally-bound or maybe-empty-loop names in any cell you want cached*. It
was the one rule no user could have been expected to derive, and
[P1](#p1--the-caching-bug-21-done) removed it. Nothing about how a cell binds its
names now affects whether it caches.

---

## 5. Development plan

Ordered by harm × cost. P0 and P1 are done; P2 is a design change that needs a
decision before it needs code.

### P0 — Cheap and uncontested (done)

The coupling is commented at the `parents_of` comprehension in
[graph.py](../py/kernel/graph.py), pinned by
`test_two_names_from_one_cell_make_one_edge` in
[test_kernel.py](../test-py/test_kernel.py), and covered in general by `dags()`,
which now gives every cell two defs and has every edge read both of its parent's
names ([test_properties.py](../test-py/test_properties.py), `cell_src`). The
whole property suite therefore runs on multi-symbol edges.

Two things learned in the doing, both recorded at their sites:

- The second def **must not read the first**. `Cell.stateful` is `refs & defs`,
  so `w{k} = v{k}` would make every generated cell stateful and nothing would
  ever report `cached`. Both defs are written against the parents' names only.
- Every test that rewrites a generated cell has to rewrite **both** defs.
  Dropping `w{k}` deletes that cell's edges rather than editing the cell, which
  in `test_no_descendant_of_a_failure_reports_ran` would have quietly emptied
  the descendant set the assertions loop over.

Verified by breaking it: with `parents_of` built as a `tuple` and in-degree
counting multiplicity, the new case and eight property cases fail with exactly
the spurious `CycleError` above. The pre-change suite caught that same break in
one test only, and by a `TypeError` on its own `&`, never by the `CycleError`.

### P1 — The caching bug (§2.1) (done)

The original plan here proposed one change — record what a run produced, check
`_fresh` against that — and called the AST tidying optional. Probing turned up a
**sixth cause with a different mechanism**, `with open(p) as f: f.read()`, which
that change cannot reach: every def is in the namespace, and it is the *key* that
is poisoned. Finding it is what turned three separate patches into one idea.

**One rule, applied twice.** `defs` and `refs` are may-sets; the cache needs
must-sets. Where the must-set is knowable only at runtime, observe it; where it
is provable from the source, prove it; never approximate it by shrinking the
may-set.

- **`defs` → observed.** `Outcome` carries `produced`, the defs a successful run
  actually left in `ns` ([cell.py:214-232](../py/kernel/cell.py#L214-L232)), and
  `_fresh` checks against that. Sound because the guard's question is whether a
  global has gone missing *since the run that produced it*, and a name that run
  never bound cannot have gone missing. Closes rows 2-5, the two
  runtime-dependent ones included.
- **`refs` → proved.** `_shadowed_reads` drops a load the cell has provably
  already bound: inside the body of the `for`/`with`/`except` that binds it, or
  after a top-level statement `_certainly_bound` accounts for. It subsumes the
  old tail-expression correction — the tail is just the last statement — so this
  is one pass where there were two. Closes row 6, and makes rows 4 and 5 cache on
  the *second* run rather than the third.

The tidying stopped being optional along the way. Once `_shadowed_reads` takes a
handler name out of `refs`, taking it out of `defs` costs nothing and cannot
strand a reader — so `except ... as e` and a valueless `x: int` are now
`transient` in the survey, under the same nothing-else-binds guard as `phantom`.
`describe()` stops claiming globals the cell cannot hold, and two cells may each
write `except ValueError as e`.

**Conservatism is unchanged**, and that is what the tests spend most of their
effort on. `_shadowed_reads` returns only names it *saw* loaded and proved every
load spurious, so the accumulator idiom still re-runs, a `for` target read after
its loop keeps its ref (an empty iterable binds nothing, unlike a `with` that
completed), a `lambda` escaping a loop body keeps its ref, and a read placed
before its binding keeps its ref.

Verified by probe on 3.12 and 3.13: all six shapes report `cached` on the second
run and none of them reports `stateful` any more, while all five conservative
shapes keep their dependency. `TestBindingsThatDoNotBind` in
[test_kernel.py](../test-py/test_kernel.py) pins the six and the accumulator;
`TestAnalyze` pins the conservative direction name by name. Asserting the
*second* run is the point — a partial fix converges by the third.

### P2 — Decide on private names (§3.1)

The change with the largest effect on how notebooks read, and the only one here
needing a decision rather than an implementation.

The proposal: **a name becomes a provider only when some other cell reads it.**
Names nothing else references stay cell-private, so `for i in ...` in twenty
cells is fine, and `i` is claimed the moment a cell actually reads it.

What it costs, stated plainly rather than buried:

- **Errors become retroactive.** Adding a cell that reads `i` turns two
  previously-legal cells into a `MultipleDefinitionError` — an edit to cell C
  produces an error naming cells A and B. Defensible (the ambiguity genuinely did
  not exist until C existed, and that is the honest moment to complain) but it is
  a real regression in error locality and the message must name all three cells
  to be actionable.
- **`globals_brief()` and `describe()` shrink**, since they key off `provider`
  ([notebook.py:448-449](../py/kernel/notebook.py#L448-L449)). Probably desirable
  — scratch variables are noise in the agent's view — but it is a visible
  behaviour change to the extension's output.
- **Retraction gets subtler.** `_stage` pops dropped globals from `ns` by
  diffing `provider` ([notebook.py:176-177](../py/kernel/notebook.py#L176-L177)).
  Private names would never be retracted and would accumulate in `ns` across
  edits. Harmless for correctness, since nothing reads them by construction, but
  it makes `run_all(restart=True)` and incremental runs diverge in namespace
  contents, and something has to decide whether that matters.

Alternatives considered and why they are worse: an explicit export list
contradicts the kernel's premise that cells declare nothing; restricting the
exemption to `for`/`with`/`except` target positions fixes the loop variable but
not `tmp` or `_fmt`, and preserves the arbitrariness that makes §3.1 grating.

**Recommendation: do it. P1 is done, which was the prerequisite** — until cells
cached reliably, changes to what counts as a definition were hard to evaluate,
and `_shadowed_reads` has since made `refs` mean what P2 needs it to mean when it
narrows `defs`. Prototype
against the property suite first; `dags()` with two defs per cell (P0, done) is
already close to the fixture this needs.

### P3 — Surface mutation (§2.2)

Not statically solvable, and prevention is not on the table. Detection is, and
the machinery mostly exists: `digest` already walks containers rather than
pickling them.

Snapshot the digests of globals a cell does not own, before and after it runs; if
one moved, the cell mutated something it does not provide. That is a fact worth
reporting — as a field in `describe()`, and possibly as an inferred edge from the
mutator to the readers of that name.

Cost is real: a digest of every referenced global on both sides of every run, on
top of the digesting `_inputs_key` already does. Likely wants gating — the
declared-`volatile` flag is the precedent for an author-declared escape.

Deferred behind P1 and P2 on cost, not on importance. It is the only item here
that yields a wrong answer rather than a refusal or a lost optimisation, so it
should not be deferred indefinitely.

### P4 — Star imports (§2.3)

Refuse them, with an error naming the cell and saying why. A `from x import *`
whose names cannot be tracked is a hole in the graph, and the kernel elsewhere
prefers refusing to a silent gap — `MultipleDefinitionError` and the `None`
digest in `_combine` ([notebook.py:282-293](../py/kernel/notebook.py#L282-L293))
are both this trade already.

Cheap. Independent of everything above. Do it whenever.

---

## 6. Not planned

- **Per-symbol edge labels.** Nothing downstream asks which name an edge is for.
  New capability, not a fix.
- **Multiple providers per name.** Directly contradicts §1.1.
- **Isolating cell namespaces.** Would fix §2.2 and §3.1 at once, and would make
  the notebook something other than a Python program — `run_all` as a true replay
  ([notebook.py:418-437](../py/kernel/notebook.py#L418-L437)) depends on the
  shared namespace.
