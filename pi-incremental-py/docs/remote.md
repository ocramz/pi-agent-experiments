# The remote, shared kernel

A thought experiment, sibling to [persistence.md](persistence.md). That doc asks what
happens when the kernel process is not *permanent* — it dies, it comes back, what survives.
This one asks what happens when the process is not *local*: it runs somewhere else, and
more than one collaborator reaches the same one.

The conclusion up front: this is not a transport change with some concurrency bolted on.
Locality is a load-bearing premise of the current semantics, and removing it turns five
settled questions back into open ones. It also buys something large enough to be worth the
trouble, and — surprisingly — the kernel's existing design is already most of the way to
the answer.

No recommendation here. Three models are laid out and none is chosen.

## The premise being removed

Today a pi session, a kernel object, a Python process, and a namespace are bound
one-to-one-to-one-to-one. Nearly everything the extension guarantees falls out of that
binding rather than from any deliberate mechanism:

- **The namespace lives and dies with the client.** Closing pi ends the computation. State
  loss is a private event with exactly one witness.
- **The project directory is the kernel's working directory.** Cells read data by relative
  path and it simply works, because the interpreter is sitting in the project.
- **The environment has one owner.** `py_install` mutates a venv nobody else is using.
- **Death is the recovery path.** There is no interrupt; a runaway cell is cured by killing
  the process. That is cheap, because the process belongs to one person.
- **The human and the agent share a namespace safely.** `/py` and `py_cell` write into the
  same globals, and the only thing preventing them from interleaving is that a single
  client orders them.

Each of these is true *because* the process is local and single-client. Make it remote and
shared and each becomes a design question with several defensible answers. That is the
actual content of "make it remote"; the wire format is an afternoon.

## The load-bearing observation

[persistence.md](persistence.md) rules that **values never travel**: the value cache is
machine-local by nature, because a pickled value is pinned to the Python version, the
platform, and the library versions that produced it. Only the cell graph and the
environment lock are portable; the recipient warms their own cache on their first
`run_all`.

That rule is a consequence of *many machines*, not a property of the cache. One machine
dissolves it.

The content-addressed cell key — cell source plus the digests of every input, transitively
— stops being a local optimisation and becomes a genuine global content address. Same key,
same computation, same *process*: a collaborator's forty-minute model fit is already warm
for everyone whose edits have not touched its inputs. No export, no bundle, no format, no
sync protocol. The most expensive thing a team does becomes the thing they most naturally
share, and it happens as a side effect of the cache already being right.

This is the largest single thing remoteness buys, and it is worth noticing that it is
**independent of which sharing model you choose**. Even the most timid arrangement below —
where collaborators share nothing but a machine — collects it in full.

The same observation has a sharp edge. The cache key for an input that cannot be digested
is deliberately poisoned so it never matches, and persistence.md already flags that this
needs to become a per-notebook session salt so a restarted process cannot falsely match a
live socket. Shared, that salt has to become per-*collaborator* as well: a false cache hit
that crosses people is a much stranger bug than one that crosses restarts.

## The second observation: the graph is already a collaboration substrate

The reason notebook collaboration is usually hard is that a notebook is usually a
transcript. A transcript is single-writer by nature: its meaning depends on execution
order, so a second writer does not merely add to it, they retroactively change what the
first writer's cells meant. Every serious attempt at multiplayer Jupyter has had to fight
this, and the fight is generally lost at the level of hidden state.

This kernel is not a transcript. *The notebook is a program, not a transcript* is the
slogan the whole design is built on, and a program is exactly the kind of object several
people can edit at once — because edits are declarative rather than imperative. `set_cell`
does not say "run this now", it says "this is what the cell is"; what to re-run is derived.

Two properties follow, and both already exist:

- The kernel computes each edit's **blast radius** — the downstream cone that the edit
  invalidates — in both the old and the new graph, before committing anything, and rolls
  the whole edit back if validation fails.
- It already exposes that computation as a **dry run** that reports what an edit *would*
  invalidate without performing it.

So the unit of multiplayer conflict is not the cell. It is the cone. Two collaborators
editing cells with disjoint downstream cones do not conflict at all — not "conflict rarely"
or "conflict resolvably", but never, by construction — and need no arbitration whatsoever.
When cones do overlap, the kernel can say exactly which cells are contested and why, in the
vocabulary the user already thinks in.

This matters because it means the mechanism this design would reach for is *not* text
merge. persistence.md names merge as a non-goal — merging cell graphs with stateful cells
is a research project — and remoteness does not force a reversal. It offers a cheaper
partial answer instead: accept concurrent edits when their cones are disjoint, and when
they are not, refuse the second one and explain it in terms of the first. Refusal with a
good explanation is a legitimate conflict resolution strategy when the explanation is a
dependency cone rather than a diff hunk.

The dry run also becomes something it could never be locally: a **presence** signal.
"Priya is editing `featurize`; that will invalidate six of your cells" is a genuinely new
affordance, and it is an operation that already exists, pointed at somebody else's pending
edit.

## Three models

What is actually shared is the whole design question. Three answers, in descending order of
intimacy.

| | shared namespace | shared graph | shared compute |
|---|---|---|---|
| cell graph | shared, live | shared, live | private |
| Python namespace | **shared** | private | private |
| value cache | shared | shared | shared |
| environment | shared | shared | shared |
| presence | continuous | on edit | none |
| new concurrency semantics needed | many | some | **none** |

### Shared namespace — one REPL in the sky

Everyone attaches to one interpreter with one set of globals. This is the maximal reading
of "shared" and the one people usually mean by collaborative notebooks. Presence is
continuous and immediate: you watch a variable change under you.

The objection is not performance or plumbing, it is the state model, and it is severe.
Stateful cells in this kernel are **non-idempotent by design** — a self-referential cell
reads its own last committed version, so re-running an accumulator *advances* it, and the
kernel deliberately marks such cells so nobody is surprised. That is a feature when one
person owns the namespace and a defect when several do: nothing in the model records whose
increment that was, and there is no way to reconstruct it after the fact. Two people
re-running the same accumulator produce a number that is correct for neither of them.

Three more, in the same vein:

- **Replay is stop-the-world.** `run_all` with restart drops the namespace and re-derives
  it. Locally that is the guaranteed path back to sanity. Shared, one person's cleanup
  wipes everyone's working state simultaneously, including the colleague halfway through a
  training run.
- **The human escape hatch becomes a side channel.** `/py <expr>` evaluates in the live
  namespace without creating a cell, on purpose — it is how the human pokes at what the
  agent built. In a shared namespace that same hatch reads everyone's variables, and cells
  routinely carry API keys and absolute paths. persistence.md worries about secrets in
  *exported* cells; a shared namespace makes secrets readable with a one-line expression
  and no export at all.
- **Untracked writes.** Evaluation can bind names that no cell provides. Locally that is a
  contained mess. Shared, it is an unattributed mutation of a namespace other people are
  deriving conclusions from.

None of this is unfixable, but fixing it means attribution, per-collaborator views of the
namespace, and a story for non-idempotent operations — at which point one has arguably
built the second model with extra steps.

### Shared graph, private namespaces

The cell graph, the environment, and the value cache are shared and live. Each collaborator
computes in their own namespace.

Your edit lands in my graph immediately — as **pending**. Nothing runs in my namespace
until I ask.

That rule is not an invention. persistence.md already chose it, for a different reason:
restore is automatic and staged, warm restores stay pending too, *nothing runs before the
human says so*. It was a crash-recovery decision. It turns out to be the concurrency
control, and it is hard to overstate how convenient that is — the awkward part of live
collaboration is normally that somebody else's edit executes in your session, and this
design had already ruled that out on unrelated grounds.

The experience: I see your cells appear, marked pending, with their blast radius on mine
computed and shown. I choose when to absorb them. When I do, the work is mostly already
done, because your run populated the shared cache and my identical keys hit it. Divergence
is visible rather than silent — the graph knows which of my cells are stale with respect to
the shared tip.

The costs are real. There are now two kinds of "current" — the shared graph's tip and my
namespace's contents — and the gap between them is a confusing intermediate state.
persistence.md hits the same hazard with branch checkout and answers it by reporting the
two separately whenever they differ; the same answer applies, at higher frequency.
Stateful cells are still awkward: my accumulator and yours advance independently from a
shared definition, which is arguably correct and definitely surprising the first time.

### Shared compute, private graphs

The remote is a beefy box and nothing else. Notebooks stay per-person. Only the machine,
the environment, and the value cache are shared.

persistence.md already names this persona — the solo researcher hopping from laptop to GPU
box — and answers it with an ordinary git remote on the lineage repo, under the heading
*sync is not collaboration*. Making the kernel itself remote is the other half of that
answer: instead of moving the notebook to the big machine, the notebook stays put and the
computation moves.

It needs no new concurrency semantics at all. Every collaborator gets their own kernel
process, their own namespace, their own graph; the only shared mutable objects are the venv
and the cache directory, and the cache is content-addressed, which is to say
conflict-free by construction. Nothing above needs to be decided.

And it still collects the headline win: the cache is shared, so the forty-minute fit is
warm for the next person regardless of whose notebook they are in. You give up presence and
keep everything else.

The honest framing is that this is the floor rather than a rival: whichever model you end
up wanting, this is what it is built on top of.

## What every model has to answer

These do not depend on which arrangement above you pick.

**Where does the data live?** This is the most underrated breakage by a distance. Cells
read files by relative path from the project directory, and today that is the same
directory the human is editing in. Remoteness silently relocates every `read_csv` in every
notebook. No protocol design fixes it — the answers are a shared mount, an explicit upload
step, or a rule that data lives server-side and the local project directory is code only.
All three change what a cell means. Whichever is chosen has to be chosen loudly, because
the failure mode is a path that resolves to a *different file* rather than to an error.

**Who owns the environment?** The installed distribution set is a synthetic root of the
dependency graph, all-or-nothing by design: an install invalidates every importing cell.
That is exactly right for one person and startling for a team, where one colleague's
upgrade invalidates everybody's importing cells at once, coherently and without warning.
The upside is real, though — `env.lock` stops being a hope about reproducibility and
becomes a fact, because there is one environment and it is the one everything ran in.

**Does the remote interpreter start with `PYTHONHASHSEED=0`?** It has to. Cache keys are
content addresses, and a key computed on one machine has to equal the key computed on
another or nothing about shared caching works. `digest` canonicalises a set it is handed
directly, but a set *nested* inside a pickled structure is serialised in iteration order,
and for `str` and `bytes` members that order follows the hash seed. Locally the extension
sets it at spawn; remotely it becomes part of the contract for what a conforming kernel
process is, alongside the interpreter version floor. The failure mode is quiet — every
dependent of a set-holding cell looks invalidated, so the graph recomputes work it already
had and nobody sees an error.

**What happens to operations that are not idempotent?** Advancing a stateful cell is a
deliberate feature locally. Shared, it is a mutation with no author. Either such operations
acquire an owner or they need to be confined to a private namespace — which is most of the
argument between the first two models.

**What replaces death as the recovery path?** There is no interrupt. The cure for a
runaway cell is killing the process, and every timeout is fatal for that reason. A shared
kernel cannot be killed to rescue one person from one mistake, so the missing interrupt
stops being an omission one can live with and becomes the blocking issue. A remote design
needs cancellation as a first-class operation before it needs anything else on this list.
Note also that a client-side deadline and a server-side kill must come apart: giving up on
a response is mine to decide, ending the computation is not.

**What does a collaborator learn asynchronously?** State loss is a private sticky flag
today, read once and reported to the model as prose. Shared, it is an event somebody else
caused, and every attached client has to find out — including the ones that were not
talking at the time. The protocol is strictly one request, one response; something has to
give, whether that is a push channel or merely a generation counter that every response
carries, so a client discovers on its next call that it missed a restart.

**Who did this?** Nothing in the model has an author. Cells have ids and optional display
names; edits have no actor, and the lineage's commit trailer records the operation but was
never asked to record a person. Sharing makes attribution load-bearing for the first time,
and it is cheap to add early and painful to retrofit onto an existing history.

## Personas revisited

persistence.md's table, with what remoteness does to each. The pattern is that the file
formats it designed remain useful, but for fewer people.

| persona | local answer (persistence.md) | what remoteness changes |
|---|---|---|
| **Maya** — machine-hopping | git remote on the lineage repo | The need largely **dissolves**. There is one kernel; the laptop and the GPU box are two clients of it, not two states to reconcile. |
| **Priya** — handing a prototype to ML engineering | lineage bundle | The handoff becomes **live**: Tom attaches to the graph instead of receiving it. The bundle survives as the archival artifact, and for recipients outside the team. |
| **Tom** — reviewing an experiment | bundle, imported as a new branch | Reads the shared graph directly, warm, without importing anything. Needs read-only attachment to be a real thing. |
| **Aisha** — educator / open-science author | snapshot JSON | **Unchanged.** Her audience is not on the box, so the portable format is still the answer. |
| **Diego** — debugging a prod model | lineage repo reachable somewhere durable | Improves the most: the lineage is reachable **by construction** rather than by having remembered to push. A shipped module's header sha resolves because the server is the durable home. |
| **audit/compliance** | git substrate, out of scope | Gets easier in one respect (one history, one machine) and harder in another (attribution now matters, and there is nobody to attribute to yet). |

Two the local framing had no reason to invent:

- **Whoever owns the box.** A shared kernel has a lifetime, an administrator, an access
  list, and a bill. Somebody decides when it restarts, who may attach, and what happens to
  the cache when the disk fills. No persona in persistence.md has this job because a local
  subprocess does not need one.
- **The collaborator who is not there.** Presence is the exception; asynchrony is the
  normal case. Most of the time the other person is asleep and what you actually interact
  with is the trace they left — which argues that the graph, the cache, and the lineage
  matter far more than live cursors do, and that the intimacy ranking above is not the same
  as a usefulness ranking.

## What it costs

The current install story is that the extension spawns a subprocess. The kernel is
stdlib-only, there is no daemon, no port, no account, no configuration, and no bill; the
extension quietly builds a project venv the first time it needs one and the user never
learns any of this happened.

All of that ends. A remote kernel is a service: it must be deployed, reached, secured,
paid for, and kept alive, and every one of those is a thing that can be broken by someone
other than the user. The trade is not "local simplicity for shared power" so much as
"something that always works for something that is better when it works."

Offline ends too, or the design acquires a local/remote duality — which is probably the
honest destination, since nobody wants to lose the ability to open a laptop on a plane and
poke at a notebook. But a duality has to say what happens when the same notebook exists in
both places, and that is the reconciliation problem this whole design was trying to route
around. Worth noting that the shared-compute model degrades most gracefully here: private
graphs mean the local and remote copies are already separate things.

Finally, the single-process assumption runs deeper than the transport. The server loop is
synchronous and single-threaded over one notebook object, which is a virtue — it is why the
protocol never needs locking. Multi-tenancy should preserve that by giving each namespace
its own process behind a supervisor rather than by making one process concurrent.
persistence.md already made exactly this call for multiple notebooks, on exactly this
reasoning plus blast containment. Remoteness extends the same decision along one more axis
rather than overturning it.

## Where this leaves persistence.md

| decision | fate |
|---|---|
| **values never travel** | **Inverts.** It was a consequence of many machines. One machine makes the value cache the most valuable shared artifact in the system. |
| **sync ≠ collaboration** | **Sharpens.** Remoteness gives sync a better answer (there is nothing to sync) which throws the collaboration question into relief rather than answering it. |
| **no merge** | **Softens, partially.** Still no text merge — but disjoint blast radii are a real, cheap concurrency rule for the common case, and the contested case gets an explanation instead of a diff. |
| **restore is staged; warm stays pending** | **Survives and gains a second job.** Written for crash recovery, it is exactly the right rule for absorbing someone else's edit. |
| **git as the lineage DAG** | **Survives untouched**, and finally has an obvious durable home instead of a remote somebody has to remember to configure. |
| **import lands as a new branch, never in place** | **Generalises.** The same rule is a good answer for a rejected concurrent edit. |
| **one process per notebook** | **Extends.** Same reasoning, one more axis: one process per namespace, supervised. |
| **the cache's never-match key needs a session salt** | **Escalates.** The salt has to be per-collaborator, not just per-notebook. |

## Non-goals

- Choosing a model. This doc surveys; it does not recommend.
- Live text co-editing of a cell's source. The interesting concurrency in this design is
  at the graph level, and cell-level co-editing is a solved commodity problem that would
  contribute nothing to the hard part.
- Merging stateful cell graphs. Still a research project; remoteness does not change that.
- Authentication and authorization design. Named as required, not designed here.

## Open questions

- **Which model** — and specifically whether the shared namespace is a legitimate
  destination or an attractive-looking dead end. The stateful-cell argument against it is
  strong but it is not a proof.
- **Is local still the default?** If the local kernel remains the common case, remoteness
  is an opt-in mode and every semantic above needs a local reading too. If remote becomes
  the default, the zero-config property is gone for everyone.
- **What does trust mean here?** persistence.md observes that importing a notebook is
  importing code, and answers it with the staged/pending contract: nothing runs until the
  recipient looks. Shared execution weakens that — the code now runs on hardware someone
  else is also using, against an environment they depend on, near secrets they own. Staging
  protects the recipient's namespace. It does not protect the machine.
- **Is a read-only attachment a distinct thing?** Tom reviewing, and every dashboard-shaped
  use case, want to see the graph and the results without being able to advance anything.
  That may be a much easier and much more useful first target than write collaboration.
- **Does the shared cache need eviction politics?** Locally it is one user's disk and an LRU
  is fine. Shared, evicting a key is taking away someone else's forty minutes.
