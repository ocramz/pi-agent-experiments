"""Image capture, driven against a fake pyplot.

The fake is the point. matplotlib is not a dependency of this kernel and
must not become one just to test it, and the thing worth testing is our
side of the contract anyway: which figures we save, that we cap them, and
that we always close them.

Real matplotlib is covered a tier up, in test/container/test_plot_in_image.sh,
where it can be installed and driven over the actual wire. Skipping a case
here on a missing import would report green over nothing.
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from nbkernel import Notebook  # noqa: E402
from nbkernel.display import MAX_BYTES, MAX_IMAGES, capture  # noqa: E402

_PYPLOT = "matplotlib.pyplot"


class FakeFigure:
    def __init__(self, size: int) -> None:
        self.size = size

    def savefig(self, buffer, format=None, dpi=None) -> None:
        # The downscale retry passes an explicit dpi; honouring it is what
        # makes the size-cap path testable without a real renderer.
        buffer.write(b"\x89PNG" * (self.size if dpi is None else self.size // 100))


class FakePyplot:
    """Just enough of the pyplot surface for `display._figures`."""

    def __init__(self, sizes: dict[int, int]) -> None:
        self.sizes = sizes
        self.closed: list[int] = []

    def get_fignums(self) -> list[int]:
        return sorted(self.sizes)

    def figure(self, num: int) -> FakeFigure:
        return FakeFigure(self.sizes[num])

    def close(self, num: int) -> None:
        self.closed.append(num)


class DisplayTest(unittest.TestCase):
    def install(self, pyplot) -> None:
        """Put a fake pyplot in sys.modules for one test."""
        previous = sys.modules.get(_PYPLOT)
        sys.modules[_PYPLOT] = pyplot
        self.addCleanup(
            lambda: sys.modules.__setitem__(_PYPLOT, previous)
            if previous is not None
            else sys.modules.pop(_PYPLOT, None)
        )


class TestFigureCapture(DisplayTest):
    def test_nothing_is_captured_without_matplotlib(self):
        self.assertNotIn(_PYPLOT, sys.modules)
        self.assertEqual(capture(object()), ([], []))

    def test_every_open_figure_is_captured(self):
        self.install(FakePyplot({1: 4, 2: 4}))
        images, notes = capture(None)
        self.assertEqual(len(images), 2)
        self.assertEqual(notes, [])
        self.assertTrue(all(i.mime == "image/png" for i in images))

    def test_figures_are_closed_so_they_cannot_reappear(self):
        pyplot = FakePyplot({1: 4, 2: 4})
        self.install(pyplot)
        capture(None)
        self.assertEqual(pyplot.closed, [1, 2])
        pyplot.sizes.clear()
        self.assertEqual(capture(None), ([], []))

    def test_no_figures_is_not_an_error(self):
        self.install(FakePyplot({}))
        self.assertEqual(capture(None), ([], []))

    def test_more_figures_than_the_cap_are_reported_and_still_closed(self):
        pyplot = FakePyplot({n: 4 for n in range(1, MAX_IMAGES + 3)})
        self.install(pyplot)
        images, notes = capture(None)
        self.assertEqual(len(images), MAX_IMAGES)
        self.assertIn("2 more figure(s) not shown", notes[0])
        self.assertEqual(len(pyplot.closed), MAX_IMAGES + 2)

    def test_an_oversized_figure_is_retried_at_a_lower_dpi(self):
        self.install(FakePyplot({1: MAX_BYTES}))  # 4 bytes per unit, so way over
        images, notes = capture(None)
        self.assertEqual(len(images), 1)
        self.assertEqual(notes, [])

    def test_a_figure_too_big_even_downscaled_is_omitted_with_a_note(self):
        self.install(FakePyplot({1: MAX_BYTES * 100}))
        images, notes = capture(None)
        self.assertEqual(images, [])
        self.assertIn("larger than", notes[0])

    def test_a_figure_that_will_not_render_is_a_note_not_a_failure(self):
        pyplot = FakePyplot({1: 4})
        pyplot.figure = lambda num: (_ for _ in ()).throw(RuntimeError("no renderer"))
        self.install(pyplot)
        images, notes = capture(None)
        self.assertEqual(images, [])
        self.assertIn("RuntimeError", notes[0])
        # Still closed: an unrenderable figure left open would be retried,
        # and fail again, on every subsequent cell.
        self.assertEqual(pyplot.closed, [1])

    def test_a_broken_get_fignums_captures_nothing_and_does_not_raise(self):
        pyplot = FakePyplot({1: 4})
        pyplot.get_fignums = lambda: (_ for _ in ()).throw(RuntimeError("broken"))
        self.install(pyplot)
        self.assertEqual(capture(None), ([], []))


class TestValueCapture(DisplayTest):
    def test_repr_png_on_the_display_value(self):
        class Plottable:
            def _repr_png_(self):
                return b"\x89PNG-payload"

        images, notes = capture(Plottable())
        self.assertEqual(len(images), 1)
        self.assertEqual(images[0].mime, "image/png")

    def test_repr_jpeg_is_accepted_too(self):
        class Photo:
            def _repr_jpeg_(self):
                return b"\xff\xd8jpeg"

        self.assertEqual(capture(Photo())[0][0].mime, "image/jpeg")

    def test_a_base64_string_is_passed_through(self):
        class Preencoded:
            def _repr_png_(self):
                return "aGVsbG8="

        self.assertEqual(capture(Preencoded())[0][0].b64, "aGVsbG8=")

    def test_an_oversized_value_image_is_omitted(self):
        class Huge:
            def _repr_png_(self):
                return b"x" * (MAX_BYTES + 1)

        images, notes = capture(Huge())
        self.assertEqual(images, [])
        self.assertIn("larger than", notes[0])

    def test_a_broken_renderer_is_ignored(self):
        class Broken:
            def _repr_png_(self):
                raise ValueError("nope")

        self.assertEqual(capture(Broken()), ([], []))

    def test_a_value_is_not_captured_twice_when_a_figure_was(self):
        self.install(FakePyplot({1: 4}))

        class Figureish:
            def _repr_png_(self):
                return b"\x89PNG-also"

        images, _ = capture(Figureish())
        self.assertEqual(len(images), 1)

    def test_an_ordinary_value_yields_nothing(self):
        self.assertEqual(capture([1, 2, 3]), ([], []))


class TestThroughACell(DisplayTest):
    def test_images_ride_along_on_the_cell_output(self):
        self.install(FakePyplot({1: 4}))
        nb = Notebook()
        nb.add("1 + 1")
        output = nb.run_all()[0]
        self.assertEqual(len(output.images), 1)
        self.assertEqual(output.value, "2")

    def test_a_cell_that_plotted_then_raised_still_closes_its_figures(self):
        pyplot = FakePyplot({1: 4})
        self.install(pyplot)
        nb = Notebook()
        nb.add("1 / 0")
        output = nb.run_all()[0]
        self.assertEqual(output.status, "error")
        self.assertEqual(len(output.images), 1)
        self.assertEqual(pyplot.closed, [1])

    def test_capture_does_not_leak_onto_stdout(self):
        pyplot = FakePyplot({1: 4})
        original = pyplot.figure
        pyplot.figure = lambda num: (print("chatty backend"), original(num))[1]
        self.install(pyplot)
        nb = Notebook()
        nb.add("42")
        output = nb.run_all()[0]
        # Captured into the cell's own output, never onto the JSON-lines wire.
        self.assertIn("chatty backend", output.stdout)


if __name__ == "__main__":
    unittest.main()
