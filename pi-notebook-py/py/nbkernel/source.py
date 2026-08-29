"""Turning source text into something runnable, and into something on disk.

Two jobs that both come down to "what is a cell, textually":

`compile_cell` splits a trailing expression off the body so the cell has a
display value, which is the one piece of Jupyter semantics worth keeping.
It also registers the source with `linecache`, so a traceback out of a
cell shows the offending line instead of the bare `<cell c3>` marker.

`parse_percent` / `emit_percent` are the jupytext percent format: cells as
`# %%` blocks in an ordinary `.py`. The format stores no outputs — that is
the deliberate cost of a file that diffs, greps, and opens in an editor.
"""

from __future__ import annotations

import ast
import linecache
import re
import types
from dataclasses import dataclass

__all__ = [
    "ParsedCell",
    "cell_filename",
    "compile_cell",
    "emit_percent",
    "forget_source",
    "parse_percent",
    "read_frontmatter",
]

# jupytext's header: `# %%` then an optional title, an optional [celltype]
# in brackets, and any number of key="value" pairs, in that order.
_HEADER = re.compile(r"^#\s*%%(?P<rest>.*)$")
_CELLTYPE = re.compile(r"\[(\w+)\]")
_METADATA = re.compile(r'(\w+)="([^"]*)"')

# jupytext writes a YAML frontmatter block as a run of comment lines fenced
# by `# ---`. A file written by jupytext itself has one and it is not a cell;
# we write one too, carrying the notebook's name, so that opening a
# checkpoint can select the interpreter it was written under instead of
# guessing at whatever the current directory happens to offer.
_FENCE = "# ---"

# `# key: value` inside the fence. Deliberately not a YAML parser: one flat
# level of scalars is all this carries, and depending on PyYAML would cost
# the kernel its stdlib-only property for the sake of a colon.
_FRONTMATTER = re.compile(r"^#\s*([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$")

KINDS = ("code", "markdown")


def cell_filename(cid: str) -> str:
    """The pseudo-filename a cell's code compiles under.

    Angle brackets are the convention for "not a real file", which keeps
    tools that walk tracebacks from trying to stat it.
    """
    return f"<cell {cid}>"


def compile_cell(
    src: str, cid: str = "?"
) -> tuple[types.CodeType, types.CodeType | None]:
    """Compile a cell to (body, tail).

    If the last statement is an expression it is popped off the body and
    compiled separately in `eval` mode, so the caller can use its value as
    the cell's display value. Raises `SyntaxError`, which the notebook
    reports as an ordinary cell failure — the same thing Jupyter does, and
    the reason a cell with a syntax error can still be staged and fixed.
    """
    filename = cell_filename(cid)
    tree = ast.parse(src, filename=filename)
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        node = tree.body.pop()
        expression = ast.Expression(node.value)
        ast.copy_location(expression, expression.body)
        tail = compile(expression, filename, "eval")
    body = compile(tree, filename, "exec")
    # What makes a traceback readable. linecache is keyed by filename and
    # consulted by `traceback`, so registering the source here is the whole
    # of it; IPython does the same thing for the same reason.
    lines = src.splitlines(keepends=True)
    linecache.cache[filename] = (len(src), None, lines, filename)
    return body, tail


def forget_source(cid: str) -> None:
    """Drop a cell's registered source. Called when a cell is deleted."""
    linecache.cache.pop(cell_filename(cid), None)


# ------------------------------------------------------------ percent format


@dataclass(frozen=True)
class ParsedCell:
    """A cell as it appears in a file: no outputs, no execution history."""

    src: str
    kind: str = "code"
    name: str | None = None
    id: str | None = None


def _parse_header(rest: str) -> tuple[str, str | None, str | None]:
    """`(kind, name, id)` out of everything after the `# %%` marker.

    The name is whatever text is left once the bracketed cell type and the
    key="value" pairs have been lifted out, which is how jupytext gets a
    title and metadata onto one line without quoting the title.
    """
    cid = dict(_METADATA.findall(rest)).get("id") or None
    kind = "code"
    if (found := _CELLTYPE.search(rest)) is not None:
        if found.group(1) in KINDS:
            kind = found.group(1)
        rest = rest[: found.start()] + rest[found.end() :]
    name = _METADATA.sub("", rest).strip() or None
    return kind, name, cid


def _decode_markdown(lines: list[str]) -> str:
    """Undo the comment prefix a markdown cell is stored under.

    One `#`, then one optional space — so a markdown heading (`# Title`,
    stored as `# # Title`) survives with its own `#` intact.
    """
    out = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("#"):
            body = stripped[1:]
            out.append(body[1:] if body.startswith(" ") else body)
        else:
            out.append(line)
    return "\n".join(out)


def read_frontmatter(text: str) -> dict[str, str]:
    """The `key: value` pairs in a leading `# ---` fenced block, if any.

    Returns an empty dict for a file without a fence, which is every file
    written before this existed and every plain `.py` — so a caller can ask
    unconditionally and treat "no answer" as "this file does not say".
    """
    lines = text.splitlines()
    if not lines or lines[0].strip() != _FENCE:
        return {}
    out: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == _FENCE:
            break
        if (found := _FRONTMATTER.match(line.strip())) is not None:
            out[found.group(1)] = found.group(2)
    return out


def parse_percent(text: str) -> list[ParsedCell]:
    """Cells out of a percent-format `.py`.

    A file with no `# %%` at all is one code cell — which means opening any
    ordinary Python file gives a working one-cell notebook rather than an
    error.
    """
    lines = text.splitlines()
    start = 0

    # Skip a jupytext YAML frontmatter block, if there is one.
    if lines and lines[0].strip() == _FENCE:
        for i in range(1, len(lines)):
            if lines[i].strip() == _FENCE:
                start = i + 1
                break

    # Split into (header-or-None, body) segments. Only the first segment
    # can have no header, and it is the text above the first `# %%`.
    segments: list[tuple[str | None, list[str]]] = []
    header: str | None = None
    buffer: list[str] = []
    for line in lines[start:]:
        found = _HEADER.match(line)
        if found is None:
            buffer.append(line)
            continue
        segments.append((header, buffer))
        header, buffer = found.group("rest"), []
    segments.append((header, buffer))

    cells: list[ParsedCell] = []
    for head, body in segments:
        src = "\n".join(body).strip("\n")
        if head is None:
            # Blank space above the first header is not a cell. Anything
            # else is, which is what makes a plain .py open as one cell.
            if src.strip():
                cells.append(ParsedCell(src=src))
            continue
        kind, name, cid = _parse_header(head)
        if kind == "markdown":
            src = _decode_markdown(src.splitlines()).strip("\n")
        cells.append(ParsedCell(src=src, kind=kind, name=name, id=cid))
    return cells


def emit_percent(cells: list[ParsedCell], notebook: str | None = None) -> str:
    """The inverse of `parse_percent`, for sources with no leading or
    trailing blank lines (`parse_percent` strips those).

    `notebook` writes a frontmatter fence naming it. That name is what lets
    `open` put the file back into the environment it was written under; a
    file saved without one is portable but says nothing about its
    dependencies, and the reader is told so rather than left to find out at
    the first ImportError.
    """
    chunks: list[str] = []
    if notebook:
        chunks.append(f"{_FENCE}\n# notebook: {notebook}\n{_FENCE}")
    for cell in cells:
        head = ["# %%"]
        if cell.name:
            head.append(cell.name)
        if cell.kind != "code":
            head.append(f"[{cell.kind}]")
        if cell.id:
            head.append(f'id="{cell.id}"')
        src = cell.src.strip("\n")
        if cell.kind == "markdown":
            src = "\n".join(f"# {line}".rstrip() for line in src.splitlines())
        chunks.append(" ".join(head) + "\n" + src)
    # One blank line between cells: each chunk contributes its own trailing
    # newline, and the join adds the separator.
    return "\n".join(chunk.rstrip("\n") + "\n" for chunk in chunks)
