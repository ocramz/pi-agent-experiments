// This package's binding to the shared pty harness — see
// pi-issue-tracker/test/tui/session.ts for the pattern this follows.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { startPi, type PiSession } from "../../../shared/test/tui/pi-session.ts";

const EXTENSION = resolve(import.meta.dirname, "..", "..", "extensions", "index.ts");

export { AGENT_DIR } from "../../../shared/test/tui/pi-session.ts";

export interface Session extends PiSession {}

/**
 * Start pi in a fresh temp directory with the extension loaded, and wait
 * until it is taking input. No fixture content is needed: the kernel is
 * state on the Python side, built through the commands under test.
 * PI_TUI_KEEP=1 keeps the directory for post-mortem.
 */
export async function session(t: TestContext, opts: { live?: boolean } = {}): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-inc-tui-"));
	const pi = await startPi(t, root, {
		extension: EXTENSION,
		live: opts.live,
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) console.log(`fixture kept: ${root}`);
			else rmSync(root, { recursive: true, force: true });
		},
	});
	return pi;
}
