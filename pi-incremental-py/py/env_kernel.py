"""Make the Python environment a tracked input to the reactive kernel.

Installing a package mid-session works — the files land on disk and
`importlib.invalidate_caches()` makes them visible. The hazard is that a
*cached* cell can silently encode the old environment:

    try:
        import cowsay
        have_cowsay = True
    except ImportError:
        have_cowsay = False

Its source never changes and its inputs never change, so its cache key
never moves, so it keeps reporting False forever after you install the
package. The environment is a hidden dependency.

Fix: treat the installed distribution set as a synthetic root node of the
DAG. Cells that import anything depend on it, so an install invalidates
exactly those cells and their descendants. The digest is deliberately
all-or-nothing: any install invalidates every importing cell, which is
coarse but never wrong.
"""

from __future__ import annotations

import ast
import builtins  # noqa: F401  (kept for namespace resets in embedders)
import importlib
import importlib.metadata
import importlib.util
import subprocess
import sys

from agent_kernel import (  # noqa: F401  (Result re-export)
    CachingNotebook,
    Result,
    _hash,
)

# PEP 668 marks Debian/Ubuntu interpreters as externally managed; inside a
# venv the flag is neither needed nor always accepted.
_SYSTEM_FLAGS = [] if sys.prefix != sys.base_prefix else ["--break-system-packages"]
PIP_FLAGS = ["-q", *_SYSTEM_FLAGS]


def _pip(*args: str, check: bool = False) -> subprocess.CompletedProcess:
    """Run pip, bootstrapping it first for pip-less (uv-built) venvs."""
    if importlib.util.find_spec("pip") is None:
        subprocess.run(
            [sys.executable, "-m", "ensurepip", "--upgrade"], capture_output=True
        )
    return subprocess.run(
        [sys.executable, "-m", "pip", *args],
        capture_output=True,
        text=True,
        check=check,
    )


def env_digest() -> str:
    """Hash of every installed distribution and its version."""
    names = sorted(
        f"{dist.metadata['Name']}=={dist.version}"
        for dist in importlib.metadata.distributions()
        if dist.metadata["Name"]
    )
    return _hash("\n".join(names))


class EnvNotebook(CachingNotebook):
    def __init__(self, seed: int | None = None) -> None:
        super().__init__(seed=seed)
        self.env = env_digest()
        self._imports: dict[str, bool] = {}

    def _snapshot_extra(self) -> object:
        return (*super()._snapshot_extra(), self.env)

    def _restore_extra(self, state: object) -> None:
        *parent, self.env = state  # type: ignore[misc]
        super()._restore_extra(tuple(parent))

    def _touches_imports(self, src: str) -> bool:
        if src not in self._imports:
            self._imports[src] = any(
                isinstance(n, (ast.Import, ast.ImportFrom))
                for n in ast.walk(ast.parse(src))
            )
        return self._imports[src]

    def _key(self, cid: str) -> str:
        key = super()._key(cid)
        if self._touches_imports(self.cells[cid].src):
            key = _hash(key + self.env)  # edge from the synthetic root
        return key

    # ---- tools

    def install(self, *packages: str, upgrade: bool = False) -> dict:
        proc = _pip("install", *PIP_FLAGS, *(["-U"] if upgrade else []), *packages)
        if proc.returncode:
            return {"ok": False, "error": proc.stderr.strip()[-400:]}

        # Without this the import system may serve a cached directory
        # listing and claim the package still isn't there.
        importlib.invalidate_caches()

        before, self.env = self.env, env_digest()
        if self.env != before:
            for cid, cell in self.cells.items():
                if self._touches_imports(cell.src):
                    self.pending |= {cid} | self.descendants(cid)

        # Already-imported modules keep their old code: `import x` is a
        # sys.modules hit, and reload() is unsound for C extensions.
        loaded = sorted(
            {p.split("==")[0].split("[")[0].replace("-", "_") for p in packages}
            & set(sys.modules)
        )
        return {
            "ok": True,
            "environment_changed": self.env != before,
            "restart_required": loaded,
            "results": [r.__dict__ for r in self.run()],
        }


# ------------------------------------------------------------------ demo

PROBE = (
    "try:\n"
    "    import cowsay\n"
    "    backend = 'cowsay'\n"
    "except ImportError:\n"
    "    backend = 'plain'\n"
)


def _demo() -> None:
    _pip("uninstall", "-y", "-q", *_SYSTEM_FLAGS, "cowsay")

    def show(label, results):
        print(f"\n{label}")
        for r in results:
            mark = {"ran": "*", "cached": "-", "error": "!"}[r.status]
            print(f"  {mark} {r.cell} {r.status:7} {r.value or r.error or ''}")

    for tracked in (False, True):
        nb = EnvNotebook() if tracked else CachingNotebook()
        title = "WITH environment tracking" if tracked else "WITHOUT (naive cache)"
        print(f"\n{'=' * 58}\n{title}\n{'=' * 58}")

        nb.add(PROBE, name="probe")
        nb.add("message = f'rendering via {backend}'", name="greet")
        print(f"initial: backend={nb.ns['backend']!r}")

        if tracked:
            report = nb.install("cowsay")  # kernel-aware install
            show('after install("cowsay")', [Result(**r) for r in report["results"]])
            print(f"  restart_required: {report['restart_required']}")
        else:
            _pip("install", "-q", *_SYSTEM_FLAGS, "cowsay", check=True)
            importlib.invalidate_caches()
            show(
                "after pip install via a separate bash tool",
                nb.set(
                    next(cid for cid, c in nb.cells.items() if c.name == "greet"),
                    "message = f'rendering via {backend}!'",
                ),
            )

        print(
            f"  backend is now {nb.ns['backend']!r}"
            f"  <-- {'correct' if nb.ns['backend'] == 'cowsay' else 'STALE'}"
        )

        _pip("uninstall", "-y", "-q", *_SYSTEM_FLAGS, "cowsay")
        sys.modules.pop("cowsay", None)


if __name__ == "__main__":
    _demo()
