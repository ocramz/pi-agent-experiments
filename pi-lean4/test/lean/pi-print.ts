// Drive pi in print mode (`pi -p`) with this package loaded.
//
// Print mode needs no pty, so these cases run wherever pi and Lean do — macOS
// included — and it is the mode CI and scripts use. It exits when the prompt is
// done, which makes it the cleanest proof of the lifecycle: every process
// group the extension spawned is recorded in a pidfile (PI_LEAN4_PIDFILE) and
// must be gone once pi is.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAUX_DIR, SCRIPT_FILE, type ScriptStep } from "../faux/faux-script.ts";

export const PKG = resolve(import.meta.dirname, "..", "..");
const FAUX = resolve(import.meta.dirname, "..", "faux", "faux-model.ts");
const PI_BIN = process.env.PI_BIN ?? "pi";
export const AGENT_DIR = process.env.PI_TUI_AGENT_DIR ?? join(tmpdir(), "pi-tui-agent");

export interface PrintRun {
	code: number | null;
	stdout: string;
	stderr: string;
	pgids: number[];
	turns(): { systemPrompt?: string; tools?: { name: string }[]; messages: { role: string; content: unknown; toolName?: string }[] }[];
	sessionText(): string;
}

export async function piPrint(
	dir: string,
	prompt: string,
	opts: { faux?: ScriptStep[]; env?: NodeJS.ProcessEnv; live?: boolean; timeoutMs?: number; extraArgs?: string[] } = {},
): Promise<PrintRun> {
	mkdirSync(AGENT_DIR, { recursive: true });
	const sessions = join(dir, ".sessions");
	const pidfile = join(dir, ".pids");
	writeFileSync(pidfile, "");
	const args = ["-p", "--approve", "--session-dir", sessions, "-e", PKG];
	if (opts.faux) {
		mkdirSync(join(dir, FAUX_DIR), { recursive: true });
		writeFileSync(join(dir, FAUX_DIR, SCRIPT_FILE), JSON.stringify(opts.faux));
		args.push("-e", FAUX, "--offline");
	}
	if (opts.live) {
		const provider = process.env.PI_PROVIDER;
		const model = process.env.PI_MODEL;
		assert.ok(provider && model, "a live case needs PI_PROVIDER and PI_MODEL (npm run test:lean sources them)");
		args.push("--provider", provider, "--model", model);
	}
	args.push(...(opts.extraArgs ?? []), prompt);
	const timeoutMs = opts.timeoutMs ?? Number(process.env.PI_TIMEOUT ?? 240) * 1000;
	const child = spawn(PI_BIN, args, {
		cwd: dir,
		env: { ...process.env, PI_CODING_AGENT_DIR: AGENT_DIR, PI_LEAN4_PIDFILE: pidfile, ...opts.env },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
	child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
	const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
	const code = await new Promise<number | null>((res) => child.on("close", (c) => res(c)));
	clearTimeout(timer);
	const pgids = readFileSync(pidfile, "utf8").split("\n").filter(Boolean).map(Number);
	return {
		code,
		stdout,
		stderr,
		pgids,
		turns() {
			const fd = join(dir, FAUX_DIR);
			if (!existsSync(fd)) return [];
			return readdirSync(fd)
				.filter((f) => /^turn-\d+\.json$/.test(f))
				.sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))
				.map((f) => JSON.parse(readFileSync(join(fd, f), "utf8")));
		},
		sessionText() {
			if (!existsSync(sessions)) return "";
			const out: string[] = [];
			const walk = (d: string) => {
				for (const e of readdirSync(d, { withFileTypes: true })) {
					if (e.isDirectory()) walk(join(d, e.name));
					else if (e.name.endsWith(".jsonl")) out.push(readFileSync(join(d, e.name), "utf8"));
				}
			};
			walk(sessions);
			return out.join("\n");
		},
	};
}

/** The text of every tool result named `tool` in the last recorded turn. */
export function toolResults(run: PrintRun, tool: string): string[] {
	const turns = run.turns();
	const last = turns[turns.length - 1];
	if (!last) return [];
	return last.messages
		.filter((m) => m.role === "toolResult" && m.toolName === tool)
		.map((m) => (Array.isArray(m.content) ? (m.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("") : String(m.content)));
}
