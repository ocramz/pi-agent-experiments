// This package's binding to the shared pty harness.
//
// Everything about *driving* pi — the `script(1)` pty, the COLUMNS fallback, the
// chunk-boundary-safe screen(), the teardown that works around a missing procps
// — lives in shared/test/tui/pi-session.ts and is identical for every extension.
// Everything about *this* extension — which fixture shapes exist, how to read
// the tracker's database and refs back — lives here.
//
// The split keeps the case files unchanged: they still call
// `session(t, "stories")` and still get `s.facts`, `s.db(...)` and `s.expect()`
// on one object.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { startPi, type PiSession } from "../../../shared/test/tui/pi-session.ts";
import { buildFixture, type Facts, type Shape } from "./fixtures.ts";
import { inspector, type Inspector } from "./inspect.ts";

/** The extension under test, as pi's `-e` wants it: an absolute path. */
const EXTENSION = resolve(import.meta.dirname, "..", "..", "extensions", "index.ts");

export { AGENT_DIR, sessionFileExists, sessionFilesFor } from "../../../shared/test/tui/pi-session.ts";

export interface Session extends PiSession, Inspector {
	facts: Facts;
}

/**
 * Build a fixture, start pi in it, and wait until it is taking input.
 *
 * Cleanup is registered on the test context, so a failing case cannot leak a pi
 * process or a temp directory. Set PI_TUI_KEEP=1 to keep the fixture for
 * post-mortem — the path is printed when a case fails.
 */
export async function session(
	t: TestContext,
	shape: Shape,
	opts: { live?: boolean; prepare?: (dir: string) => void } = {},
): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-tui-"));
	const dir = join(root, "fx");
	const facts = await buildFixture(shape, dir);
	opts.prepare?.(dir);

	const pi = await startPi(t, dir, {
		extension: EXTENSION,
		live: opts.live,
		// Runs inside the harness's own teardown, after pi is provably gone —
		// removing this tree while pi still held the database open is a race, not
		// a hook-ordering detail to be inferred.
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) console.log(`fixture kept: ${dir}`);
			else rmSync(root, { recursive: true, force: true });
		},
	});

	return { ...pi, ...inspector(dir), facts };
}
