// This package's binding to the shared pty harness — see
// pi-issue-tracker/test/tui/session.ts for the pattern this follows.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { startPi, type PiSession } from "../../../shared/test/tui/pi-session.ts";
import { FAUX_DIR, SCRIPT_FILE, type ScriptStep } from "./faux-script.ts";
import { LOG_DIR, inspector, type Inspector } from "./inspect.ts";

const EXTENSION = resolve(import.meta.dirname, "..", "..", "extensions", "index.ts");
const FAUX = resolve(import.meta.dirname, "faux-model.ts");
const LOGGER = resolve(import.meta.dirname, "..", "..", "..", "shared", "dev", "pi-logger.ts");

export { AGENT_DIR, sessionFilesFor } from "../../../shared/test/tui/pi-session.ts";

export interface Session extends PiSession, Inspector {}

export interface SessionOptions {
	/** Drive the run with a real model. Costs money; see live.test.ts. */
	live?: boolean;
	/** Drive it with the scripted faux model instead, and record every turn. */
	faux?: ScriptStep[];
	/**
	 * Load shared/dev/pi-logger.ts too, writing into the fixture. Defaults to on
	 * for live runs, which are the ones that cost money and cannot be repeated
	 * cheaply to find out what happened; the faux tier records the whole
	 * `Context` already and needs nothing.
	 */
	log?: boolean;
	/** Extra environment for the pi process — e.g. PI_PY_CONTEXT_FILTER. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Start pi in a fresh temp directory with the extension loaded, and wait
 * until it is taking input. No fixture content is needed: the kernel is
 * state on the Python side, built through the commands under test.
 * PI_TUI_KEEP=1 keeps the directory for post-mortem.
 */
export async function session(t: TestContext, opts: SessionOptions = {}): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-inc-tui-"));
	if (opts.faux) {
		mkdirSync(join(root, FAUX_DIR), { recursive: true });
		writeFileSync(join(root, FAUX_DIR, SCRIPT_FILE), JSON.stringify(opts.faux), "utf8");
	}
	// The logger goes last, so its `context` handler runs after the extension's
	// filter and records what the model was actually handed rather than the raw
	// transcript. pi chains those handlers in load order; see shared/dev/pi-logger.ts.
	const logging = opts.log ?? Boolean(opts.live);
	const extension = [EXTENSION, ...(opts.faux ? [FAUX] : []), ...(logging ? [LOGGER] : [])];
	const pi = await startPi(t, root, {
		extension,
		live: opts.live,
		env: { ...(logging ? { PI_PY_LOG_DIR: join(root, LOG_DIR) } : {}), ...opts.env },
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) {
				console.log(`fixture kept: ${root}`);
				// Named explicitly: the whole point of the log is to be read after a
				// live case failed, and a path nobody prints is a path nobody opens.
				if (logging) console.log(`  prompt log: ${join(root, LOG_DIR)}`);
			} else rmSync(root, { recursive: true, force: true });
		},
	});
	return { ...pi, ...inspector(root) };
}
