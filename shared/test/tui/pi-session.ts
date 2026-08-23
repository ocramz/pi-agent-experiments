// Drive a real pi TUI session from a test, and read what it printed.
//
// Shared by every package in this repo. It knows how to get pi running under a
// pty and how to read its screen; it knows nothing about any one extension's
// fixtures or state. A package supplies both through its own thin `session()`
// wrapper — see pi-issue-tracker/test/tui/session.ts for the pattern.
//
// ── Why there is a pty in here ───────────────────────────────────────
// cli-testing-library spawns with child_process.spawn and pipes; it allocates no
// pty. pi picks its mode with `parsed.print || !stdinIsTTY || !stdoutIsTTY →
// "print"`, and print mode never parses a slash command. So driving pi through
// the library directly cannot reach a single one of the commands under test.
//
// `script(1)` closes the gap: it allocates a pty, runs pi inside it, and copies
// the master end to and from its own stdin and stdout — which are the pipes the
// library holds. pi sees a terminal; the library sees a stream.
//
// The pty `script` builds this way has no window size, so `process.stdout.columns`
// is 0 inside pi. pi-tui falls back to `Number(process.env.COLUMNS) || 80`, so
// COLUMNS and LINES below are what actually set the render width. They are wide
// on purpose: the story board truncates its rows to the terminal width, and a
// truncated row is a failed assertion about text that was really there.
//
// ── Why `screen()` does not use findByText ──────────────────────────
// The library's queries join the captured stdout chunks with "\n" before
// matching. A chunk boundary can land mid-word, so a phrase that pi printed in
// one piece can become unmatchable. `screen()` joins with "" instead and then
// normalises, which is the same idea without the seam. `waitFor` — the library's
// polling primitive, re-driven by its stdout observer — does the waiting.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { cleanup, configure, render, waitFor } from "cli-testing-library";
import type { RenderResult } from "cli-testing-library";
import stripAnsi from "strip-ansi";

const PI_BIN = process.env.PI_BIN ?? "pi";

// Shared across the whole run, and across runs on the same machine. pi
// downloads `fd` into this directory the first time it starts; a per-test
// directory would pay for that download in every single case. Setting it also
// suppresses pi's first-time-setup wizard, which would otherwise sit waiting for
// a theme choice that nobody is there to make.
export const AGENT_DIR = process.env.PI_TUI_AGENT_DIR ?? join(tmpdir(), "pi-tui-agent");

/**
 * Whether pi has written a session file for a fixture yet.
 *
 * pi flushes a session only once it holds an assistant message, so before the
 * first model reply there is no file at all — and `SessionManager.forkFrom`,
 * which is how worktree mode relocates a session, refuses an unwritten one.
 * A live case that needs to relocate has to wait for this rather than for
 * anything on screen: the model streams its own paraphrase of the prompt, so
 * matching output is not evidence the turn is over.
 */
export function sessionFileExists(cwd: string): boolean {
	return sessionFilesFor(cwd).length > 0;
}

/**
 * Session files whose header records `cwd`.
 *
 * This is how a relocation is checked. `SessionManager.forkFrom` writes a new
 * session whose header names the target directory, so a file appearing under the
 * worktree's cwd is direct evidence that the session moved — and unlike the
 * screen, it does not depend on what the TUI chose to repaint.
 */
export function sessionFilesFor(cwd: string): string[] {
	const root = join(AGENT_DIR, "sessions");
	if (!existsSync(root)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(root)) {
		const dir = join(root, entry);
		if (!statSync(dir).isDirectory()) continue;
		for (const file of readdirSync(dir)) {
			if (!file.endsWith(".jsonl")) continue;
			const path = join(dir, file);
			if (readFileSync(path, "utf8").includes(`"cwd":"${cwd}"`)) found.push(path);
		}
	}
	return found;
}

// Long enough for a git merge or a conflict report, nowhere near long enough to
// hide a hang. Live cases raise it per call.
configure({ asyncUtilTimeout: 30_000 });

/** pi's footer hint. Present once the TUI has painted and is taking input. */
const READY = "ctrl+o more";

export interface PiSession {
	dir: string;
	/** Everything pi has printed since the last `clear()`, ANSI stripped. */
	screen(): string;
	/** The same, but with whitespace intact — for assertions about layout. */
	rawScreen(): string;
	/** Type a slash command and submit it. */
	command(text: string): Promise<void>;
	/** Send raw keys — "[ArrowDown]", "[Enter]", "[Escape]", "r", "d". */
	press(keys: string, options?: { settle?: number }): Promise<void>;
	/** Answer a `ctx.ui.select` prompt by option index; 0 is the default. */
	choose(index: number): Promise<void>;
	/** Wait until pi has printed `text`. Fails the test if it never does. */
	expect(text: string, options?: { timeout?: number }): Promise<void>;
	/** Assert pi has *not* printed `text` (checked immediately, no waiting). */
	refute(text: string): void;
	/** Exit pi and wait for the process to go. Assert state only after this. */
	close(): Promise<void>;
}

const normalise = (text: string): string => stripAnsi(text).replace(/\s+/g, " ").trim();

/**
 * Start pi in an already-prepared directory and wait until it is taking input.
 *
 * The fixture is the caller's business, deliberately: this file is shared by
 * every package in the repo, and what a useful fixture looks like — which
 * stories exist, which branch is checked out — is exactly what differs between
 * them. A package wraps this in its own `session()` that builds a fixture, calls
 * `startPi`, and mixes in its own inspector; see
 * pi-issue-tracker/test/tui/session.ts.
 *
 * `extension` is likewise the caller's: it is the path to the package's
 * extension entry point, passed to pi as `-e`.
 *
 * Cleanup of the pi process is registered on the test context, so a failing case
 * cannot leak one. Removing the fixture directory belongs to whoever created it,
 * and `afterExit` is where that runs — once pi is provably gone.
 */
export async function startPi(
	t: TestContext,
	dir: string,
	opts: { extension: string; live?: boolean; afterExit?: () => void },
): Promise<PiSession> {
	mkdirSync(AGENT_DIR, { recursive: true });

	const env: NodeJS.ProcessEnv = {
		...process.env,
		COLUMNS: "200",
		LINES: "50",
		TERM: "xterm-256color",
		GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
		GIT_CONFIG_SYSTEM: "/dev/null",
		PI_CODING_AGENT_DIR: AGENT_DIR,
	};

	const flags = ["--tui-mode regular", "--approve", `-e ${opts.extension}`];
	if (opts.live) {
		// No literal fallbacks. The provider and model are pinned once, in
		// shared/versions.env, and `npm run test:tui` sources it — a default
		// spelled out here would be a sixth copy of a value that used to live in
		// five places and drift between them.
		const provider = process.env.PI_PROVIDER;
		const model = process.env.PI_MODEL;
		assert.ok(
			provider && model,
			"a live case needs PI_PROVIDER and PI_MODEL. `npm run test:tui` sources them from " +
				"shared/versions.env; running node --test directly means exporting them yourself.",
		);
		flags.push(`--provider ${provider}`);
		flags.push(`--model ${model}`);
	}
	// `-q` no banner, `-f` flush every write so assertions see output as it
	// happens, `-e` return pi's own exit status rather than script's.
	const pi = await render("script", ["-q", "-f", "-e", "-c", `${PI_BIN} ${flags.join(" ")}`, "/dev/null"], {
		cwd: dir,
		spawnOpts: { env },
	});

	let closed = false;
	const captured = (): string => pi.stdoutArr.map((chunk) => String(chunk.contents)).join("");
	const screen = (): string => normalise(captured());
	const rawScreen = (): string => stripAnsi(captured());

	const expect = async (text: string, options: { timeout?: number } = {}): Promise<void> => {
		const needle = normalise(text);
		try {
			await waitFor(
				() => {
					if (!screen().includes(needle)) throw new Error("not yet");
				},
				{ instance: pi, timeout: options.timeout },
			);
		} catch {
			assert.fail(`pi never printed ${JSON.stringify(text)}\n\nlast output:\n${screen().slice(-2000)}`);
		}
	};

	const settle = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

	const s: PiSession = {
		dir,
		screen,
		rawScreen,
		expect,
		refute(text) {
			const needle = normalise(text);
			assert.ok(
				!screen().includes(needle),
				`pi printed ${JSON.stringify(text)} and should not have\n\nlast output:\n${screen().slice(-2000)}`,
			);
		},
		async command(text) {
			pi.clear();
			await pi.userEvent.keyboard(text, { delay: 5 });
			// The slash autocomplete opens as the name is typed and closes again on
			// the first space. Either way the highlighted entry is the command just
			// spelled out in full, so Enter submits what was typed — but only once
			// the popup has caught up with the keystrokes.
			await settle(400);
			await pi.userEvent.keyboard("[Enter]");
			await settle(300);
		},
		async press(keys, options = {}) {
			pi.clear();
			await pi.userEvent.keyboard(keys, { delay: 30 });
			await settle(options.settle ?? 700);
		},
		async choose(index) {
			for (let i = 0; i < index; i++) await pi.userEvent.keyboard("[ArrowDown]", { delay: 30 });
			await settle(200);
			pi.clear();
			await pi.userEvent.keyboard("[Enter]");
			await settle(500);
		},
		async close() {
			if (closed) return;
			closed = true;
			// ctrl+d is "clear or exit": it exits only on an empty input line, so a
			// case that left text in the box gets a second press after the clear.
			await pi.userEvent.keyboard("\x04");
			if (!(await exited(pi, 8_000))) {
				await pi.userEvent.keyboard("\x04");
				assert.ok(await exited(pi, 8_000), `pi did not exit\n\nlast output:\n${screen().slice(-2000)}`);
			}
		},
	};

	t.after(async () => {
		// A failing case never reaches close(), so teardown has to be able to kill
		// pi on its own — and cannot lean on the library's cleanup() to do it.
		// That path goes through tree-kill, which enumerates children by shelling
		// out to `ps`; the debian-slim dev image has no procps, so the kill fails,
		// the pty stays open, and node --test hangs on a still-live child rather
		// than reporting the failure. Killing `script` directly drops the pty
		// master, and pi exits on the hangup.
		if (!pi.hasExit() && pi.process.pid) {
			try {
				process.kill(pi.process.pid, "SIGKILL");
			} catch {
				// Already gone between the check and the signal.
			}
			await exited(pi, 5_000);
		}
		await cleanup().catch(() => {});
		// The fixture directory is not removed here — whoever created it owns it,
		// and that is the package's wrapper. It hands in `afterExit` rather than
		// registering a `t.after` of its own so the ordering is explicit: deleting
		// the tree out from under a still-live pi is exactly the race that would
		// otherwise depend on which way node --test unwinds its hooks.
		opts.afterExit?.();
	});

	await expect(READY, { timeout: 60_000 });
	await settle(500);
	pi.clear();
	return s;
}

async function exited(pi: RenderResult, timeout: number): Promise<boolean> {
	try {
		await waitFor(
			() => {
				if (!pi.hasExit()) throw new Error("still running");
			},
			{ instance: pi, timeout },
		);
		return true;
	} catch {
		return false;
	}
}
