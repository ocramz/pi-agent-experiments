"""Named alternative programs over one namespace.

Two cells cannot both bind `model`, and the single-provider rule is what
makes the dependency graph derivable at all — so alternatives of one
computation cannot be siblings in a graph. They have to be alternative
*graphs*, which is what a variant is: a snapshot of the cells, under a
name, remembering what it was forked from.

A snapshot is cheap. `Cell` is frozen, so the snapshot shares the very
objects the live notebook holds and costs one dict of pointers. Nothing
here copies a value or a namespace.

Switching is not a new kind of execution. The difference between two
variants is a batch of edits, and applying a batch is what the notebook
already does: staging works out the blast radius, everything upstream of
the divergence stays live, and only the cells that actually differ are
re-run. What makes the return trip cheap is one layer down — a key is a
content address, so the cells a switch displaces come back out of the
memo instead of being recomputed.

The tree that results is a trie, and nobody builds it. Two variants
agreeing on a prefix of the computation produce byte-identical keys for
that prefix, so they share its entries by construction; they diverge at
the first cell whose source or inputs differ. Because an address is a
hash of a *value*, two prefixes that arrive at the same values converge
back onto one node — the trie is allowed to re-merge, and that
re-merging is early cutoff. Dropping a variant therefore invalidates
nothing: names are a way of talking about the store, not a claim on it.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .cell import Cell
from .edits import Edit

DEFAULT = "main"

_NAME = re.compile(r"[a-z0-9][a-z0-9-]*\Z")


@dataclass(frozen=True)
class Variant:
    """A program under a name. `cells` is a snapshot; `order` is its
    insertion order, which is the notebook's topological tie-break."""

    name: str
    parent: str | None
    cells: dict[str, Cell]
    order: tuple[str, ...]


def check_name(name: str) -> None:
    if not _NAME.match(name):
        raise ValueError(
            f"variant name {name!r} must be lowercase letters, digits and dashes"
        )


def diff(src: dict[str, Cell], dst: dict[str, Cell]) -> list[Edit]:
    """The batch that turns one program into another.

    Ordering within the batch does not matter: the notebook validates the
    *final* graph once, after applying everything, so a variant that moves
    which cell binds a name never passes through the invalid intermediate
    state that would refuse it.

    Ids are carried across verbatim — `add` accepts an explicit one. That
    is what lets a cell keep its identity between variants, so `pending`
    and `failing` still name something the reader recognises after a
    switch, and so the two variants' keys line up wherever their sources do.
    """
    return [
        *(Edit("delete", id=cid) for cid in src.keys() - dst.keys()),
        *(
            Edit("set", id=cid, src=dst[cid].src)
            for cid in src.keys() & dst.keys()
            if src[cid].src != dst[cid].src
        ),
        *(
            Edit("add", id=cid, src=dst[cid].src, name=dst[cid].name)
            for cid in dst.keys() - src.keys()
        ),
    ]
