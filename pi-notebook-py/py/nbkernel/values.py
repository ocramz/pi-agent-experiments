"""One-line summaries of runtime values.

Adapted from pi-incremental-py's `kernel.values.brief`, minus the digest
machinery around it: a linear notebook has no content-addressed cache, so
`brief` is the only thing that module was needed for.

It leans further towards *contents* than that one does, because here the
display value is the cell's output rather than a label on a cached node.
`brief("Agg")` reporting `str(3)` is a correct summary and a useless
answer. Two things still get summarised instead of shown: anything with a
`.shape` (a dataframe's repr is a table), and any container big enough
that building its repr in order to truncate it would itself be the cost.
"""

from __future__ import annotations

import types

__all__ = ["brief", "globals_brief"]

# Enough to show a dataframe's shape or a list's contents, short enough
# that twenty of them still fit in a tool result.
_LIMIT = 120

# Past this a container is described rather than shown. Well above what
# `_LIMIT` will print, so nothing that would have fit is summarised away.
_MAX_REPR_ITEMS = 100

# Python's own convention for "not part of the surface".
_SKIP_PREFIX = "_"


def brief(value: object, limit: int = _LIMIT) -> str:
    """One line describing a value: its contents where those fit, its shape
    where they do not."""
    if value is None:
        return "None"
    if isinstance(value, types.ModuleType):
        return f"module {value.__name__!r}"
    try:
        size = value.shape  # type: ignore[attr-defined]  # numpy, pandas, torch
        return f"{type(value).__name__}{tuple(size)}"
    except (AttributeError, TypeError):
        pass
    # A million-element list has a seven-megabyte repr, and truncating it
    # afterwards has already paid for all of it. Strings are excluded: they
    # are their own repr, so there is nothing to build.
    if not isinstance(value, str | bytes | bytearray):
        try:
            length = len(value)  # type: ignore[arg-type]
        except TypeError:
            length = None
        if length is not None and length > _MAX_REPR_ITEMS:
            return f"{type(value).__name__}({length})"
    try:
        text = repr(value)
    except Exception as exc:  # a broken __repr__ must not sink the response
        return f"<unreprable {type(value).__name__}: {type(exc).__name__}>"
    return text if len(text) <= limit else text[:limit] + "..."


def globals_brief(ns: dict, limit: int = 40) -> dict[str, str]:
    """The user-visible bindings, summarised and capped.

    Underscore-prefixed names are Python's convention for "not part of the
    surface", and `__builtins__` is the interpreter's own. The cap exists
    because a notebook that binds three hundred names would otherwise turn
    every single tool result into a wall of them.
    """
    names = sorted(n for n in ns if not n.startswith(_SKIP_PREFIX))
    return {n: brief(ns[n]) for n in names[:limit]}
