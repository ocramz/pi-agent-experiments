"""The three ways a set of cells can fail to be a notebook.

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
