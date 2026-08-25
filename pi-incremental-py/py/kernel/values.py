"""What the kernel knows about a value: how to identify it, how to
describe it.

`digest` is identity — the answer to "if a cell reads this again, could
its result differ?", and therefore the thing cache keys are built from.
`brief` is description — a one-line summary for an agent that wants shape
rather than contents. Nothing here knows about cells or the graph.
"""

from __future__ import annotations

import hashlib
import importlib.metadata
import pickle
import types


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
    alone: two closures from one `def` differ only in what they captured.
    Rule 2 is why sets are canonicalised rather than pickled: pickle
    walks them in iteration order, which is hash-randomised.
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
    try:
        return _hash(pickle.dumps(obj, protocol=4))
    except Exception:
        return None  # sockets, file handles, live models, ...


def _digest_function(fn: types.FunctionType, seen: frozenset[int]) -> str | None:
    """Code, captures and defaults — everything that decides what it does.

    Pickle would serialise a function *by name*, so an edited body would
    hash identically; the code fingerprint fixes that. But the code is
    only part of it. `make(3)` and `make(4)` return closures sharing one
    code object and differing only in a captured cell, so a code-only
    digest calls them equal and every dependent silently keeps a stale
    value. Defaults are the same story with different storage.

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

    return _hash("\x00".join(parts))


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
