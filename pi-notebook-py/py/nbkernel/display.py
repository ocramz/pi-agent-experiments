"""Turning what a cell drew into something the model can look at.

pi accepts image blocks in a tool result and normalises them before they
enter history, so a plot can go straight to the model's eyes rather than
being described to it. Two sources, in order:

    open matplotlib figures   -> saved and closed, the way the inline
                                 backend consumes them on display
    the cell's display value  -> `_repr_png_` / `_repr_jpeg_`, which is
                                 the protocol PIL and friends already speak

matplotlib is never imported here. It is only used if the *cell* imported
it, which is what keeps the kernel stdlib-only: a notebook that never
plots never pays for this module.
"""

from __future__ import annotations

import base64
import contextlib
import sys
from dataclasses import dataclass

__all__ = ["Image", "MAX_BYTES", "MAX_IMAGES", "capture"]

# Four is enough for a cell that draws a small grid of plots, and few
# enough that a loop drawing a hundred cannot bury the transcript.
MAX_IMAGES = 4

# Past this we downscale once and then give up. pi resizes oversized
# images itself, but a payload this big has already cost a JSON-lines
# round trip to move.
MAX_BYTES = 1_000_000
_RETRY_DPI = 72


@dataclass(frozen=True)
class Image:
    mime: str
    b64: str


def _encode(data: bytes, mime: str) -> Image:
    return Image(mime=mime, b64=base64.b64encode(data).decode("ascii"))


def _save_figure(pyplot, num: int) -> bytes | None:
    """One figure as PNG bytes, downscaled once if it comes out too big."""
    import io

    figure = pyplot.figure(num)
    buffer = io.BytesIO()
    figure.savefig(buffer, format="png")
    data = buffer.getvalue()
    if len(data) > MAX_BYTES:
        buffer = io.BytesIO()
        figure.savefig(buffer, format="png", dpi=_RETRY_DPI)
        data = buffer.getvalue()
    return data if len(data) <= MAX_BYTES else None


def _figures(notes: list[str]) -> list[Image]:
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return []
    images: list[Image] = []
    try:
        numbers = list(pyplot.get_fignums())
    except Exception:
        return []
    for num in numbers[:MAX_IMAGES]:
        try:
            data = _save_figure(pyplot, num)
        except Exception as exc:
            notes.append(f"figure {num} could not be rendered ({type(exc).__name__})")
            continue
        if data is None:
            notes.append(
                f"figure {num} omitted: larger than {MAX_BYTES // 1000} kB"
            )
            continue
        images.append(_encode(data, "image/png"))
    if len(numbers) > MAX_IMAGES:
        extra = len(numbers) - MAX_IMAGES
        notes.append(f"{extra} more figure(s) not shown (cap {MAX_IMAGES})")
    # Closed whether or not they rendered: leaving them open would make the
    # next cell in the notebook redraw every one of them.
    for num in numbers:
        with contextlib.suppress(Exception):
            pyplot.close(num)
    return images


def _from_value(value: object, notes: list[str]) -> list[Image]:
    for attribute, mime in (("_repr_png_", "image/png"), ("_repr_jpeg_", "image/jpeg")):
        render = getattr(value, attribute, None)
        if render is None:
            continue
        try:
            data = render()
        except Exception:
            continue
        if isinstance(data, str):  # some implementations return base64 already
            return [Image(mime=mime, b64=data)]
        if isinstance(data, bytes | bytearray):
            if len(data) > MAX_BYTES:
                notes.append(f"image omitted: larger than {MAX_BYTES // 1000} kB")
                return []
            return [_encode(bytes(data), mime)]
    return []


def capture(value: object) -> tuple[list[Image], list[str]]:
    """`(images, notes)` for one cell run. Never raises.

    A failure to render is a note, not an error: the cell itself ran fine,
    and losing the whole result over a broken `_repr_png_` would be a much
    worse trade than losing the picture.
    """
    notes: list[str] = []
    try:
        images = _figures(notes)
        # Only when nothing was drawn. A cell ending in `fig` would
        # otherwise contribute the same picture twice, once from the
        # figure registry and once from the value's own renderer.
        if not images:
            images = _from_value(value, notes)
        return images, notes
    except Exception as exc:  # pragma: no cover - the belt to the braces above
        return [], [f"display capture failed ({type(exc).__name__})"]
