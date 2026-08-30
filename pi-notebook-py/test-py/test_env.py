"""What `nbkernel.env` reports about the interpreter it is running in.

Deliberately not asserting that any particular distribution is installed:
a notebook's venv is built empty, so the honest floor is zero packages, and
a test that needed one would only pass on the developer's machine. What is
worth pinning is the *shape* — the lock is meant to be stored and diffed,
so its ordering and its `name==version` spelling are the contract.
"""

import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "py"))

from nbkernel import env  # noqa: E402
from nbkernel.env import distributions, environment  # noqa: E402

_LINE = re.compile(r"^[^=]+==.+$")


class _FakeDistribution:
    def __init__(self, name, version):
        self.metadata = {"Name": name}
        self.version = version


class TestDistributions(unittest.TestCase):
    def test_every_line_is_a_requirement_specifier(self):
        for line in distributions():
            self.assertRegex(line, _LINE, f"not a requirements.txt line: {line!r}")

    def test_the_list_is_sorted(self):
        # A stored lock has to diff cleanly against the next one, which it
        # cannot do if the order follows whatever sys.path happened to be.
        found = distributions()
        self.assertEqual(found, sorted(found))

    def test_a_distribution_with_no_name_is_skipped_not_fatal(self):
        # A half-written .dist-info left by an interrupted install is a thing
        # that happens; it is not a reason for the whole report to fail.
        fake = [
            _FakeDistribution("beta", "2.0"),
            _FakeDistribution(None, "0.1"),
            _FakeDistribution("alpha", "1.0"),
        ]
        original = env.importlib.metadata.distributions
        env.importlib.metadata.distributions = lambda: iter(fake)
        try:
            self.assertEqual(distributions(), ["alpha==1.0", "beta==2.0"])
        finally:
            env.importlib.metadata.distributions = original


class TestEnvironment(unittest.TestCase):
    def test_it_reports_this_process_not_a_resolution_rule(self):
        # The whole reason this lives in the kernel: the client's rules can
        # choose one interpreter and a failed venv build leave another one
        # running, and only the child knows which.
        info = environment()
        self.assertEqual(info["executable"], sys.executable)
        self.assertEqual(
            info["version"], ".".join(str(part) for part in sys.version_info[:3])
        )
        self.assertEqual(info["implementation"], sys.implementation.name)
        self.assertEqual(info["prefix"], sys.prefix)
        self.assertEqual(info["base_prefix"], sys.base_prefix)

    def test_the_lock_can_be_left_out(self):
        info = environment(packages=False)
        self.assertNotIn("packages", info)
        self.assertNotIn("producer", info)
        self.assertIn("executable", info)

    def test_the_producer_is_named_alongside_the_lock(self):
        # Two producers can answer this question — the kernel's stdlib scan
        # and the client's `uv pip freeze` — and they do not agree on
        # editable installs, so a stored lock has to say which one wrote it.
        info = environment()
        self.assertEqual(info["producer"], "importlib.metadata")
        self.assertIsInstance(info["packages"], list)

    def test_asking_twice_gives_the_same_answer(self):
        # Nothing is cached and nothing is mutated: this is a read of the
        # environment, not a step in building one. (The pip route would have
        # had to bootstrap pip with ensurepip in a uv-built venv, changing
        # the thing it was asked to describe.)
        self.assertEqual(environment(), environment())


if __name__ == "__main__":
    unittest.main()
