// This package's binding to the shared pty harness — see
// pi-incremental-py/test/tui/session.ts for the pattern this follows.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { startPi, type PiSession } from "../../../shared/test/tui/pi-session.ts";
import { FAUX_DIR, SCRIPT_FILE, type ScriptStep } from "./faux-script.ts";
import { inspector, type Inspector } from "./inspect.ts";

const EXTENSION = resolve(import.meta.dirname, "..", "..", "extensions", "index.ts");
const FAUX = resolve(import.meta.dirname, "faux-model.ts");

export { AGENT_DIR, sessionFilesFor } from "../../../shared/test/tui/pi-session.ts";

export interface Session extends PiSession, Inspector {
	/** The fixture directory, for cases that read or write files in it. */
	root: string;
}

export interface SessionOptions {
	/** Drive the run with a real model. Costs money; see live.test.ts. */
	live?: boolean;
	/** Drive it with the scripted faux model instead, and record every turn. */
	faux?: ScriptStep[];
	/** Extra environment for the pi process. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Start pi in a fresh temp directory with the extension loaded, and wait
 * until it is taking input. No fixture content is needed: the notebook is
 * state on the Python side, built through the commands under test.
 * PI_TUI_KEEP=1 keeps the directory for post-mortem.
 */
export async function session(t: TestContext, opts: SessionOptions = {}): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-nb-tui-"));
	if (opts.faux) {
		mkdirSync(join(root, FAUX_DIR), { recursive: true });
		writeFileSync(join(root, FAUX_DIR, SCRIPT_FILE), JSON.stringify(opts.faux), "utf8");
	}
	const extension = [EXTENSION, ...(opts.faux ? [FAUX] : [])];
	const pi = await startPi(t, root, {
		extension,
		live: opts.live,
		env: opts.env,
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) console.log(`fixture kept: ${root}`);
			else rmSync(root, { recursive: true, force: true });
		},
	});
	return { ...pi, ...inspector(root), root };
}
