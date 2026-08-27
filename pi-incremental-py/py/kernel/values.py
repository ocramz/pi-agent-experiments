"""What the kernel knows about a value: how to identify it, how to
describe it.

`digest` is identity — the answer to "if a cell reads this again, could
its result differ?", and therefore the thing cache keys are built from.
`file_digest` answers the same question for a file a cell read, which is
an input the namespace cannot see. `brief` is description — a one-line
summary for an agent that wants shape rather than contents. Nothing here
knows about cells or the graph.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import os
import pickle
import stat
import sys
import types
from functools import lru_cache


def _hash(data: str | bytes) -> str:
    if isinstance(data, str):
        data = data.encode()
    return hashlib.blake2b(data, digest_size=12).hexdigest()


def _code_fingerprint(code: types.CodeType) -> tuple:
    """Structure of a code object, recursively.

    `repr` of a code object embeds its memory address, so a function
    holding a nested `def` or `lambda` would hash differently in every
    process. Keys are lineage (see docs/persistence.md), so they have to
    survive a restart.
    """
    return (
        code.co_code,
        code.co_names,
        code.co_varnames,
        tuple(
            _code_fingerprint(c) if isinstance(c, types.CodeType) else repr(c)
            for c in code.co_consts
        ),
    )


def _code_names(code: types.CodeType) -> frozenset[str]:
    """Every global name the code could read, nested functions included.

    `co_names` also holds attribute and method names, so this over-collects.
    The caller intersects it with the actual globals, and a coincidental
    match there costs one extra invalidation, never a wrong answer.
    """
    names = set(code.co_names)
    for const in code.co_consts:
        if isinstance(const, types.CodeType):
            names |= _code_names(const)
    return frozenset(names)


# Markers for the two structural cases that have no content of their own.
# Fixed strings, because they end up in a key that has to be reproducible.
_CYCLE = "<cycle>"
_EMPTY_CELL = "<empty-cell>"


def digest(obj: object) -> str | None:
    """Stable content digest, or None meaning 'assume always changed'.

    This answers one question: if a cell reads this object again, could
    its result differ? Four rules, in priority order.

    1. Sound. Equal digests must mean interchangeable. A false "same" is
       a wrong answer that surfaces as a cell reporting `cached` when it
       should have re-run, so this is the rule that cannot be traded.
    2. Process-stable. Keys are lineage (docs/persistence.md), so the
       same content must digest the same way in a fresh interpreter.
    3. Total. Never raises; unknown is None, which is the safe direction.
    4. Cheap. It runs once per ref, per key computation.

    Rule 1 is why functions are decomposed rather than hashed by code
    alone: two closures from one `def` differ only in what they captured,
    and two functions with one body can call different globals.
    Rule 2 is why sets are canonicalised rather than pickled: pickle
    walks them in iteration order, which is hash-randomised. It is also
    why lists, tuples and dicts are walked at all — pickling one emits
    any set inside it in that same randomised order.
    """
    return _digest(obj, frozenset())


def _digest(obj: object, seen: frozenset[int]) -> str | None:
    if isinstance(obj, types.ModuleType):
        # Include the version: a bare name is blind to upgrades, so early
        # cutoff would stop propagating after `pip install -U`.
        try:
            version = importlib.metadata.version(obj.__name__.split(".")[0])
        except Exception:
            version = getattr(obj, "__version__", "?")
        return f"module:{obj.__name__}:{version}"
    if isinstance(obj, (types.FunctionType, types.LambdaType)):
        if id(obj) in seen:
            return _CYCLE
        return _digest_function(obj, seen | {id(obj)})
    # Exact types only: a subclass may carry state of its own, and pickle
    # is the one that knows about it.
    if type(obj) in (set, frozenset):
        if id(obj) in seen:
            return _CYCLE
        return _digest_set(obj, seen | {id(obj)})
    # Containers are walked rather than pickled so that the rules above
    # reach what they hold: a set nested in a list is as hash-order
    # dependent as a bare one, and pickle would emit it in that order.
    # This is rule 2 bought with rule 4 — a Python-level walk costs ~30x
    # a single `pickle.dumps` on a large container (measured: 755ms vs
    # 27ms for 100k JSON-shaped records). Rule 2 outranks rule 4, and the
    # values this persona actually holds at that size are arrays and
    # frames, which are not exact containers and still take the pickle
    # path below. If a large *Python* container ever dominates a key
    # computation, the fix is a size guard here, not abandoning the walk.
    if type(obj) in (list, tuple):
        if id(obj) in seen:
            return _CYCLE
        return _digest_sequence(obj, seen | {id(obj)})
    if type(obj) is dict:
        if id(obj) in seen:
            return _CYCLE
        return _digest_mapping(obj, seen | {id(obj)})
    try:
        return _hash(pickle.dumps(obj, protocol=4))
    except Exception:
        return None  # sockets, file handles, live models, ...


def _digest_function(fn: types.FunctionType, seen: frozenset[int]) -> str | None:
    """Code, captures, defaults and globals — all that decides what it does.

    Pickle would serialise a function *by name*, so an edited body would
    hash identically; the code fingerprint fixes that. But the code is
    only part of it. `make(3)` and `make(4)` return closures sharing one
    code object and differing only in a captured cell, so a code-only
    digest calls them equal and every dependent silently keeps a stale
    value. Defaults are the same story with different storage.

    Globals are the same story a third time, and the one that bites
    hardest: `def f(): return helper()` captures nothing and its code
    never mentions what `helper` does, so editing `helper` used to leave
    `digest(f)` untouched and every cell reading `f` reported `cached`
    over a stale value. A global is read at call time, so it decides the
    result exactly as a capture does.

    Sections are labelled so that a capture and a default holding the
    same value cannot produce the same digest by rearrangement.
    """
    parts = ["code:" + repr(_code_fingerprint(fn.__code__))]

    for cell in fn.__closure__ or ():
        try:
            captured = cell.cell_contents
        except ValueError:
            # A cell not yet filled — a forward reference during class or
            # mutually-recursive definition. A state, not a failure.
            parts.append("closure:" + _EMPTY_CELL)
            continue
        digested = _digest(captured, seen)
        if digested is None:
            return None
        parts.append("closure:" + digested)

    for default in fn.__defaults__ or ():
        digested = _digest(default, seen)
        if digested is None:
            return None
        parts.append("default:" + digested)

    kwdefaults = fn.__kwdefaults__ or {}
    for name in sorted(kwdefaults):
        digested = _digest(kwdefaults[name], seen)
        if digested is None:
            return None
        parts.append(f"kwdefault:{name}={digested}")

    if _is_dynamic(fn):
        for name in sorted(_code_names(fn.__code__) & fn.__globals__.keys()):
            digested = _digest(fn.__globals__[name], seen)
            if digested is None:
                return None
            parts.append(f"global:{name}={digested}")

    return _hash("\x00".join(parts))


def _is_dynamic(fn: types.FunctionType) -> bool:
    """Was this function defined outside any importable module?

    True for anything a cell defined — a cell's namespace belongs to no
    module — and false for a library's own functions. The distinction
    decides whether the globals walk runs: a cell function's globals are
    the notebook, which the user edits between runs, while a library
    function's are the library, which only moves on an upgrade and is
    already covered by `env_digest`. Walking a library's globals would
    also mean digesting numpy's module dict to answer a question about
    `np.mean`.
    """
    module = sys.modules.get(fn.__globals__.get("__name__") or "")
    return getattr(module, "__dict__", None) is not fn.__globals__


def _digest_set(value: set | frozenset, seen: frozenset[int]) -> str | None:
    """Order-free digest of a set.

    `pickle.dumps` emits members in iteration order, and for str or bytes
    members that order follows PYTHONHASHSEED — so the same set digests
    differently in two processes and every dependent looks invalidated
    after a restart. Sorting the members' *digests* (not the members)
    gives a canonical order that works for unorderable and mixed types.
    """
    digested = []
    for element in value:
        element_digest = _digest(element, seen)
        if element_digest is None:
            return None
        digested.append(element_digest)
    kind = "frozenset" if isinstance(value, frozenset) else "set"
    return _hash(kind + ":" + "\x00".join(sorted(digested)))


def _digest_sequence(value: list | tuple, seen: frozenset[int]) -> str | None:
    """Ordered digest of a list or tuple.

    Order is content here — `[1, 2]` and `[2, 1]` are different values —
    so unlike a set's members these are not sorted. The kind is labelled
    because a list and a tuple of the same items are not interchangeable
    either.
    """
    digested = []
    for element in value:
        element_digest = _digest(element, seen)
        if element_digest is None:
            return None
        digested.append(element_digest)
    kind = "list" if type(value) is list else "tuple"
    return _hash(kind + ":" + "\x00".join(digested))


def _digest_mapping(value: dict, seen: frozenset[int]) -> str | None:
    """Digest of a dict, in insertion order.

    Not sorted, for the reason sets are: a dict's iteration order is
    already reproducible across processes (insertion order since 3.7),
    and it is observable — `list(d)` tells two dicts with the same items
    apart, so canonicalising them would call two distinguishable values
    identical.
    """
    digested = []
    for key, item in value.items():
        key_digest = _digest(key, seen)
        item_digest = _digest(item, seen)
        if key_digest is None or item_digest is None:
            return None
        digested.append(f"{key_digest}={item_digest}")
    return _hash("dict:" + "\x00".join(digested))


_env_digest: str | None = None


def env_digest(refresh: bool = False) -> str:
    """Hash of every installed distribution and its version.

    Cached: scanning the metadata of every distribution is far too slow
    to repeat per notebook, and the set only moves when we move it.
    """
    global _env_digest
    if _env_digest is None or refresh:
        names = sorted(
            f"{dist.metadata['Name']}=={dist.version}"
            for dist in importlib.metadata.distributions()
            if dist.metadata["Name"]
        )
        _env_digest = _hash("\n".join(names))
    return _env_digest


# A file a cell read is an input the namespace cannot see, so it belongs
# in the key the same way a global does. These three constants are the
# whole policy: what we refuse to hash, and how big a bite we read.
_MISSING_FILE = "<missing-file>"
_MAX_HASHED = 8 * 1024 * 1024
_FILE_CHUNK = 1 << 20


@lru_cache(maxsize=1024)
def _hash_file(path: str, size: int, mtime_ns: int) -> str:
    """Content digest of a regular file, memoised on its stat signature.

    `size` and `mtime_ns` are *arguments* rather than a check inside the
    body, and that is the whole trick: a file that moved has a different
    cache key, so a stale digest is unreachable by construction rather
    than by remembering to invalidate. Callers stat first and pass what
    they saw.

    Eviction is correctness-neutral — a miss re-reads and recomputes, so
    `maxsize` is a cost knob with no soundness surface. That is unusual
    for a cache and it is why this one needs no invalidation logic.

    NB: this opens a file, which raises an `open` audit event. It is only
    ever called from key computation, which happens between cells and
    never while `cell.py` is watching, so the kernel does not record its
    own reads as a cell's.
    """
    digest_ = hashlib.blake2b(digest_size=12)
    with open(path, "rb") as handle:
        while chunk := handle.read(_FILE_CHUNK):
            digest_.update(chunk)
    return "file:" + digest_.hexdigest()


def file_digest(path: str) -> str | None:
    """Digest of a file a cell read, or None meaning 'assume changed'.

    Same four rules as `digest`, and None means the same thing: this
    input cannot be identified, so nothing keyed on it may be cached.

    `S_ISREG` is checked before anything else because the alternative is
    not a wrong answer but a *hang*: reading `/dev/urandom`, a FIFO or
    `/dev/stdin` to hash it never returns, and rule 3 (never raise) is
    small comfort to a kernel that stopped. Oversized files are refused
    for a duller reason — hashing a multi-GB frame on every key
    computation is not viable, and refusing is honest where silently
    swapping in a weaker comparison would not be.

    A path that does not exist, or exists and cannot be read, digests to
    a fixed marker rather than None: "not there" is itself content, so
    *creating* the file moves the key and re-runs the cell that failed to
    find it — the same shape as the `cowsay` story in the design essay.

    The trade: a digest is reused whenever size and mtime both match, so
    an overwrite that *preserves* mtime (`cp -p`, `rsync -t`, `tar -x`)
    is missed. Closing that would mean re-reading every file on every key
    computation. This is the one soundness hole here, and it is the same
    one git's index and ccache accept.
    """
    try:
        st = os.stat(path)
    except OSError:
        return _MISSING_FILE
    if not stat.S_ISREG(st.st_mode) or st.st_size > _MAX_HASHED:
        return None
    try:
        return _hash_file(path, st.st_size, st.st_mtime_ns)
    except OSError:
        # Deliberately outside the memo. `chmod` moves ctime, not mtime,
        # so caching this would keep serving "<missing-file>" under an
        # unchanged key after the file became readable again.
        return _MISSING_FILE


def brief(value: object, limit: int = 120) -> str:
    """One-line value summary. Agents need shape, not contents."""
    if value is None:
        return "None"
    try:
        size = value.shape  # type: ignore[attr-defined]  # numpy, pandas, torch
        return f"{type(value).__name__}{tuple(size)}"
    except (AttributeError, TypeError):
        pass
    try:
        return f"{type(value).__name__}({len(value)})"  # type: ignore[arg-type]
    except TypeError:
        pass
    text = repr(value)
    return text if len(text) <= limit else text[:limit] + "..."
