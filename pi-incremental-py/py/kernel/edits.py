"""The vocabulary of a change to a notebook.

One `Edit` per change, so a batch is a list and the notebook can validate
the *final* graph rather than each step: a rename, a split, or interposing
a node cannot be expressed as a sequence of individually-valid single-cell
edits.
"""

from __future__ import annotations

from dataclasses import dataclass


def as_flag(value: object) -> bool | None:
    """ The "volatile" flag is tri-state: None means "inherit", not "False".

    A `set` carrying only new source must not silently un-declare a cell
    the author already marked volatile, for the same reason `set` preserves
    `name`. Passing `false` explicitly is how you clear it.
    """
    if value is None or isinstance(value, bool):
        return value
    else:
        raise ValueError(f"volatile must be a boolean, got {value!r}")


@dataclass(frozen=True)
class Edit:
    """One staged change. `add` with no id has one minted for it."""

    op: str  # add | set | delete
    id: str | None = None
    src: str | None = None
    name: str | None = None
    volatile: bool | None = None  # None: inherit (see `as_flag`)

    @classmethod
    def from_json(cls, raw: object) -> Edit:
        match raw:
            case {"op": "add", "src": str(src), **rest}:
                return cls(
                    "add",
                    src=src,
                    name=rest.get("name"),
                    volatile=as_flag(rest.get("volatile")),
                )
            case {"op": "set", "id": str(cid), "src": str(src), **rest}:
                return cls(
                    "set",
                    id=cid,
                    src=src,
                    volatile=as_flag(rest.get("volatile")),
                )
            case {"op": "delete", "id": str(cid)}:
                return cls("delete", id=cid)
            case _:
                raise ValueError(f"bad edit {raw!r}")
