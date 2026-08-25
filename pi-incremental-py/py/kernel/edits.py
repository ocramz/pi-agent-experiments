"""The vocabulary of a change to a notebook.

One `Edit` per change, so a batch is a list and the notebook can validate
the *final* graph rather than each step: a rename, a split, or interposing
a node cannot be expressed as a sequence of individually-valid single-cell
edits.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Edit:
    """One staged change. `add` with no id has one minted for it."""

    op: str  # add | set | delete
    id: str | None = None
    src: str | None = None
    name: str | None = None

    @classmethod
    def from_json(cls, raw: object) -> Edit:
        match raw:
            case {"op": "add", "src": str(src), **rest}:
                return cls("add", src=src, name=rest.get("name"))
            case {"op": "set", "id": str(cid), "src": str(src)}:
                return cls("set", id=cid, src=src)
            case {"op": "delete", "id": str(cid)}:
                return cls("delete", id=cid)
            case _:
                raise ValueError(f"bad edit {raw!r}")
