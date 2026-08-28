"""Errors the protocol layer expects and turns into `{"ok": false}`.

Anything not derived from `NotebookError` reaching `handle()` is a bug in
the kernel rather than a bad request, and is reported as `internal`.
"""

from __future__ import annotations

__all__ = ["CellNotFound", "NotebookError", "PercentFormatError"]


class NotebookError(Exception):
    """Base for every "the caller asked for something impossible"."""


class CellNotFound(NotebookError):
    """No cell with that id. Carries the id so the message can name it."""

    def __init__(self, cid: str) -> None:
        super().__init__(f"no cell with id {cid!r}")
        self.cid = cid


class PercentFormatError(NotebookError):
    """A file that was asked to be a notebook and is not one."""
