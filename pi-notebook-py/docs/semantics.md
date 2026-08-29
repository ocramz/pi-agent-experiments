# The semantics this kernel commits to

The counterpart to the README's tour: what the model *is*, stated precisely enough to argue with,
including the parts that are costs rather than features. Where a claim is checkable, the test that
checks it is named.

## 1. Execution

### 1.1 One namespace, no graph

Every cell executes into the same dict, created as `{"__builtins__": builtins, "__name__":
"__main__"}` ([cell.py](../py/nbkernel/cell.py) `fresh_namespace`). Nothing is inferred from a
cell's source about what it defines or reads. There is no provider map, no cache key, and no rule
about which cell may bind which name — the two-cells-define-`x` case that
[pi-incremental-py rejects](../../pi-incremental-py/docs/authoring-model.md) is simply a notebook
where the second assignment wins, as in any Python script.

The consequence is that *every* invalidation question is answered positionally rather than by
dependency. Cell 4 is not "downstream of cell 2"; it is *below* cell 2, which is a weaker claim and
the only one available without analysis.

### 1.2 The trailing expression is the display value

If a cell's last statement is an expression, it is popped off the body at compile time and
evaluated separately ([source.py](../py/nbkernel/source.py) `compile_cell`). This is Jupyter's
`last_expr` behaviour and the one piece of it worth keeping: it is how a cell reports a result
without the author having to `print`.

`brief` ([values.py](../py/nbkernel/values.py)) renders that value. It shows contents wherever they
fit — a string is its repr, not `str(3)` — and describes rather than shows exactly two things:
anything with a `.shape` (a dataframe's repr is a table) and any container of more than 100
elements, where building the repr in order to truncate it would itself be the cost.

### 1.3 A run stops at the first failure

`run_all`, `run_above` and `run_below` execute in order and stop when a cell raises
([notebook.py](../py/nbkernel/notebook.py) `_run`). The cells below almost certainly depend on the
one that just failed, and running them anyway buries the real error under a pile of NameErrors.
Cells above keep their values, and the namespace keeps whatever the failed cell managed to bind
before it raised — there is no rollback, because there is no staging.

### 1.4 A cell failure is never a kernel failure

`run_cell` catches `BaseException`, not `Exception`: a cell calling `sys.exit()` fails as a cell.
A `SyntaxError` is likewise an ordinary cell failure raised at run time, not at write time, which
is what lets a cell with a typo be staged and then fixed. The traceback is trimmed of the kernel's
own `exec` frame and the source is registered with `linecache`, so it names the cell and shows the
offending line.

Pinned by `TestFailure` in [test_notebook.py](../test-py/test_notebook.py).

## 2. Staleness

### 2.1 The rule

One monotonic counter per notebook. Each cell carries `touched_at` — the sequence number at which
it last changed anything a cell below it could have seen — and `ran_at`, the sequence number of its
last execution.

> A cell is **stale** iff it has run at least once and some cell above it has a `touched_at`
> greater than its own `ran_at`.

Evaluated in one pass, carrying the high-water mark down the list ([notebook.py](../py/nbkernel/notebook.py)
`stale`).

Two invariants follow, and both are tests (`TestStaleness`):

- after `run_all`, nothing is stale — cell *k* ran after every cell above it, by construction;
- editing cell *i* marks exactly *i+1..n*.

### 2.2 The three states are disjoint

An edit sets `ran_at = None`, which moves the cell out of `stale` and into `unrun` rather than
leaving it in both. `failing` is read off the last output. A cell is in at most one of the three.

### 2.3 What counts as a disturbance

| Operation | Effect |
|---|---|
| edit a cell's source or kind | that cell becomes unrun; everything below it is stale |
| set identical source | nothing |
| run a cell | everything below it is stale |
| insert a cell | everything below the insertion point is stale, before it has even run |
| delete a cell | everything from the hole down is stale |
| move a cell | the moved cell becomes unrun; everything from the earlier of its two positions down is stale |
| restart | every cell becomes unrun; nothing is stale |

Restart is the one entry that is not a notebook operation at all. `Notebook.restart()` only swaps in
a fresh namespace, and the client does not stop there: `nb_notebook {op: "restart"}` and the restart
half of `nb_run {op: "all"}` checkpoint the cells, kill the interpreter, and load the checkpoint back
into a new one. The namespace is the smaller half of what a restart has to clear — `sys.modules`
survives a namespace reset, so a module imported from the project directory would otherwise keep its
old code no matter how many times the notebook was "restarted", and `install`'s `restart_required`
would name a fix no op could deliver. Cells and their ids survive, because `load` reconciles by id.

Deleting and moving mark *above* the affected span rather than at it (`_disturb`), because a cell's
own `touched_at` affects the cells below it and not itself — marking at the span would leave the
cell that inherited the position looking fresh when it is exactly as unreproducible as the ones
under it. At index 0 there is no cell above, which is what `_floor` is for.

Inserting is the least obvious entry. The new cell has not run, so the namespace has not moved and
the cells below still hold correct values — but the notebook no longer *reproduces* them, because a
`run_all` would execute the new cell first. Staleness is a claim about reproducibility, not about
the namespace.

## 3. Known costs

### 3.1 Deleting a cell does not retract its globals

The names it bound stay in the namespace until a restart. Retracting them would require knowing
which names the cell put there, which is the dependency analysis this kernel deliberately does not
do. This is Jupyter's behaviour, and the staleness report is the compensation: everything from the
hole down reports stale, so the drift is visible even though it is not repaired.

### 3.2 Staleness is positional, so it over-reports

Editing cell 2 marks cells 3..n stale even when cell 3 has nothing to do with it. A dependency
graph would mark only what actually depends on the edit — that graph is the whole of
pi-incremental-py, and its price is section 1.1. Over-reporting is the safe direction: the cost is
a re-run that was not needed, never a value trusted that should not have been.

### 3.3 The file format stores no outputs

Percent format carries source and nothing else, so an opened notebook has code and no results,
every cell comes back `unrun`, and images do not survive a session. Asserted in the
[protocol suite](../test/container/test_protocol_in_image.sh) (`HAS_OUTPUT=no`) rather than left as
a promise, because if outputs ever started being written, the claim that these files diff cleanly
would quietly become false.

### 3.4 A cell can outlive its budget

The client's round-trip timeout is 120 seconds, and it kills the kernel — taking the namespace with
it. There is no interrupt: the serve loop reads a request, runs it, and writes a response on one
thread, so there is nothing to deliver a signal to. A cell that hangs costs the session's state.

### 3.5 A `# %%` line inside a cell splits it

The format has no escape for its own delimiter. jupytext has the same limitation.

### 3.6 Isolation between notebooks is dependency-scoped, and nothing more

Each notebook runs in its own venv, so an `nb_install` in one cannot change what another imports,
and two notebooks may hold conflicting versions. That is the whole of the claim. A cell still runs
as the same user, in the same working directory, with the same network and the same filesystem as
every other notebook — and a cell that shells out to the *system* pip reaches past the venv
entirely. "Isolated" here means dependencies, not a sandbox, and nothing in the kernel is a
security boundary.

### 3.7 Two sessions on the same notebook still share everything

The name is the key, so two pi sessions that are both on `sales` get the same venv and the same
checkpoint file, and the second writer wins. There is no lock: the case that mattered was two
sessions in one project stepping on each other by *default*, which naming fixes, and a lock for the
case where two sessions were deliberately pointed at one notebook would be paid for on every
mutation by everyone.

### 3.8 Abandoned venvs are not collected

They sit outside the working tree, so `git clean` does not reach them either. `/nb drop-venv <name>`
removes one and `nb_notebook {op: "notebooks"}` prints where they all are; nothing removes one
automatically, because "this notebook looks finished" is not a judgement the kernel is in a position
to make.

It is a slash command and not an agent op for the same reason. The agent is no better placed than
the kernel to know a notebook is done with — abandonment is a fact about what the user intends
next, not about anything the notebook contains — and no analysis task has "delete a venv" as a
step. Reclaiming disk is the user's decision, so it is on the user's surface. What the agent is
left with is the reversible half: `new` and `use` cost a namespace, and `notebooks` costs nothing.

The listing reports a notebook's venv whether or not the notebook currently runs in it, because
`PI_PYTHON`, a `/nb-python` pin and a `.pi/settings.json` entry all leave an already-built venv on
disk while overriding it. Pinning is the likeliest way to strand one, so a listing that showed the
venv only while nothing overrode it would hide exactly the environments worth reclaiming. For the
same reason `drop-venv` resolves through `venvDir` rather than through the interpreter that is in
force: a pin changes what runs, not what this extension owns.

### 3.9 The project directory is on `sys.path`, and shadows the stdlib

`bootstrap_path` puts the kernel's working directory at `sys.path[0]` before the serve loop starts.
Without it the project's own modules are the one thing a notebook sitting in that project cannot
import: the kernel is spawned as `python <pkg>/py/protocol.py`, and for a script path CPython puts
the *script's* directory on `sys.path[0]` — `''` is prepended only for `-c`, `-m` and interactive
mode. So `open("data.csv")` worked while `import helper` did not, for a `helper.py` right there in
the cwd, which makes "write the long code to a file and call it from a small cell" fail for no
reason the agent can see.

Index 0 is Jupyter's choice, and it comes with Jupyter's cost: a project file named `io.py` or
`json.py` shadows the stdlib module of that name. The alternative — appending, so the stdlib always
wins — would make the notebook disagree with every other way of running Python in that directory,
and a shadowing bug that only appears under this kernel is worse than one that appears everywhere.
It is the user's own directory behaving the way Python says directories on the path behave.

The entry is the cwd at spawn time, not a live view: a cell that calls `os.chdir` moves the process
but not the path, exactly as in Jupyter.

Restarting the interpreter clears `sys.modules`, which is what makes an edited project file get
re-read — but it does not defeat `__pycache__`. CPython validates a `.pyc` against the source's
`(mtime, size)`, and the mtime it stores is truncated to whole seconds, so a file rewritten within
the same second as its cache entry *and* to exactly the same byte length loads the stale bytecode.
That is universal CPython behaviour — `python helper.py` twice in one second does the same — and it
is left alone for the same reason the path order is Jupyter's: a notebook that disagreed with every
other way of running the code in that directory would be the worse bug. It is narrow in practice,
since an edit that changes nothing about a file's length is rare.

## 4. Not planned

- **A dependency graph.** That is pi-incremental-py, and having both is the point.
- **Automatic re-running of stale cells.** The kernel reports; the agent decides. A kernel that
  re-ran on its own would be making the expensive choice on the agent's behalf, from strictly less
  information about what the agent is trying to do.
- **`.ipynb` as the working format.** A one-way export *with* outputs, for handing a finished
  notebook to a human, is worth having. Percent stays the format the kernel reads and writes.
