"""The ways a set of cells can fail to be a notebook, and the one way a
move between variants can fail to be reversible.

Separate from the modules that raise them so that `graph` and `notebook`
can share them without importing each other.
"""

from __future__ import annotations


class CycleError(Exception):
    """Cells form a dependency cycle; no valid execution order exists."""


class MultipleDefinitionError(Exception):
    """Two cells bind the same global, so the graph would be ambiguous."""


class DuplicateNameError(Exception):
    """Two cells carry the same display name."""


class StatefulVariantError(Exception):
    """A switch would re-run a cell that reads what it writes.

    Such a cell keys on its own last committed value, so its key is a
    function of how many times it has run rather than of the program. A
    variant switch across one does not restore the value it left, it
    advances the accumulator again — and the value it left is then gone,
    with nothing recording that it ever existed. Refusing is the only
    move that keeps the promise the memo makes everywhere else; `force`
    is there for when the accumulator is not what the user cares about.
    """
