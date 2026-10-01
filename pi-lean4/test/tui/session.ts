// This package's binding to the shared pty harness (shared/test/tui/pi-session.ts),
// on the pattern of pi-notebook-py/test/tui/session.ts.
//
// The package directory itself is passed to pi as `-e`, so the manifest's
// skills and prompt templates load with the extension, as they would from npm.
// No Lean is needed here: this tier runs in the dev container and on the CI
// runner without a toolchain, and covers what the human and the model are
// *told* and what happens when Lean is missing. test/lean/ covers Lean itself.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { startPi, type PiSession, sessionFilesFor } from "../../../shared/test/tui/pi-session.ts";
import { FAUX_DIR, SCRIPT_FILE, type ScriptStep } from "../faux/faux-script.ts";

export const PKG = resolve(import.meta.dirname, "..", "..");
const FAUX = resolve(import.meta.dirname, "..", "faux", "faux-model.ts");

export interface Recorded {
	systemPrompt?: string;
	tools?: { name: string; description?: string; parameters?: { properties?: Record<string, Record<string, unknown>>; required?: string[] } }[];
	messages: { role: string; content: unknown; toolName?: string; isError?: boolean }[];
}

export interface Session extends PiSession {
	root: string;
	turns(): Recorded[];
	sessionText(): string;
}

export interface SessionOptions {
	faux?: ScriptStep[];
	/** Files to create in the fixture before pi starts. */
	files?: Record<string, string>;
	/** Make the fixture a Lake project (lean-toolchain + lakefile.toml). */
	lake?: boolean;
	env?: NodeJS.ProcessEnv;
}

export async function session(t: TestContext, opts: SessionOptions = {}): Promise<Session> {
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-tui-"));
	if (opts.lake) {
		writeFileSync(join(root, "lean-toolchain"), "leanprover/lean4:v4.34.1\n");
		writeFileSync(join(root, "lakefile.toml"), 'name = "fixture"\n');
	}
	for (const [rel, text] of Object.entries(opts.files ?? {})) {
		mkdirSync(join(root, rel, ".."), { recursive: true });
		writeFileSync(join(root, rel), text);
	}
	if (opts.faux) {
		mkdirSync(join(root, FAUX_DIR), { recursive: true });
		writeFileSync(join(root, FAUX_DIR, SCRIPT_FILE), JSON.stringify(opts.faux));
	}
	const pi = await startPi(t, root, {
		extension: [PKG, ...(opts.faux ? [FAUX] : [])],
		// A lake that cannot exist: this tier must behave the same on a host
		// that happens to have Lean installed.
		env: { PI_LEAN_LAKE: "/nonexistent/lake", ...opts.env },
		afterExit: () => {
			if (process.env.PI_TUI_KEEP) console.log(`fixture kept: ${root}`);
			else rmSync(root, { recursive: true, force: true });
		},
	});
	return {
		...pi,
		root,
		turns() {
			const dir = join(root, FAUX_DIR);
			if (!existsSync(dir)) return [];
			return readdirSync(dir)
				.filter((f) => /^turn-\d+\.json$/.test(f))
				.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
				.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Recorded);
		},
		sessionText: () => sessionFilesFor(root).map((f) => readFileSync(f, "utf8")).join("\n"),
	};
}

export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	return (content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("");
}
