// This package's binding to the shared pty harness — see
// pi-issue-tracker/test/tui/session.ts for the pattern this follows.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { sessionFilesFor, startPi, type PiSession } from "../../../shared/test/tui/pi-session.ts";
import type { Trajectory } from "../../src/atif.ts";
import { FAUX_DIR, SCRIPT_FILE, turnFile, type ScriptStep } from "./faux-script.ts";

const EXTENSION = resolve(import.meta.dirname, "..", "..", "extensions", "index.ts");
const FAUX = resolve(import.meta.dirname, "faux-model.ts");

/** Where a case that turns recording on points PI_ATIF_DIR, under the fixture. */
export const ATIF_DIR = "atif";

export interface Session extends PiSession {
	/** Trajectory files in the configured directory, by name. */
	atifFiles(): string[];
	/** A trajectory file, parsed. Relative paths resolve against the fixture. */
	trajectory(file: string): Trajectory;
	/** The system prompt the faux provider was handed on call `n`. */
	providerPrompt(n: number): string;
	/** Every entry pi wrote to this fixture's session file. */
	sessionEntries(): { type: string; customType?: string; [k: string]: unknown }[];
}

export interface SessionOptions {
	faux: ScriptStep[];
	/** Set PI_ATIF_DIR to <fixture>/atif. Otherwise it is set empty, i.e. off. */
	record?: boolean;
}

/**
 * Start pi in a fresh temp directory with the extension and the faux model,
 * and wait until it is taking input. PI_TUI_KEEP=1 keeps the directory.
 */
export async function session(t: TestContext, opts: SessionOptions): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-atif-tui-"));
	mkdirSync(join(root, FAUX_DIR), { recursive: true });
	writeFileSync(join(root, FAUX_DIR, SCRIPT_FILE), JSON.stringify(opts.faux), "utf8");
	const atifDir = join(root, ATIF_DIR);

	const pi = await startPi(t, root, {
		// The extension first, deliberately: it captures the prompt at agent_start,
		// after every extension's edits, so load order must not matter.
		extension: [EXTENSION, FAUX],
		// Empty rather than absent, so a PI_ATIF_DIR in the caller's environment
		// cannot turn recording on behind a case that expects it off.
		env: { PI_ATIF_DIR: opts.record ? atifDir : "" },
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) console.log(`fixture kept: ${root}`);
			else rmSync(root, { recursive: true, force: true });
		},
	});

	return {
		...pi,
		atifFiles: () => (existsSync(atifDir) ? readdirSync(atifDir).filter((f) => f.endsWith(".atif.json")).sort() : []),
		trajectory: (file) => JSON.parse(readFileSync(resolve(root, file), "utf8")) as Trajectory,
		providerPrompt: (n) => {
			const recorded = JSON.parse(readFileSync(turnFile(root, n), "utf8")) as { systemPrompt?: string };
			if (typeof recorded.systemPrompt !== "string") throw new Error(`turn ${n} recorded no system prompt`);
			return recorded.systemPrompt;
		},
		sessionEntries: () => {
			const files = sessionFilesFor(root);
			if (files.length !== 1) throw new Error(`expected one session file for ${root}, found ${files.length}`);
			return readFileSync(files[0], "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line));
		},
	};
}
