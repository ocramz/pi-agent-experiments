/**
 * pi-logging-atif: write each pi session as an ATIF trajectory.
 *
 * ATIF is Harbor's interchange format for agent runs
 * (https://docs.harborframework.com/agents/atif). With a directory configured —
 * `--atif-dir <dir>` or PI_ATIF_DIR — every session is kept as one
 * `<dir>/<start>_<session-id>.atif.json`, rewritten whole after each prompt
 * from the session branch pi has already persisted. Without one, nothing is
 * recorded and nothing is written; `/atif-export <path>` still works on demand.
 *
 * Everything that decides what the file *says* is in src/convert.ts, pure and
 * unit-tested. This file is the wiring: when to capture, when to write, and
 * how to fail.
 */

import { VERSION, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { SYSTEM_PROMPT_ENTRY, lastRecordedPrompt, toTrajectory, type ConvertOutput } from "../src/convert.ts";
import { imageDirFor, producer, resolveDir, trajectoryFileName, writeTrajectory } from "../src/write.ts";

const FLAG = "atif-dir";
const PRODUCER = producer();

export default function (pi: ExtensionAPI) {
	pi.registerFlag(FLAG, {
		description: "Write each session as an ATIF trajectory into this directory (or set PI_ATIF_DIR)",
		type: "string",
	});

	const configuredDir = (ctx: ExtensionContext): string | undefined =>
		resolveDir(pi.getFlag(FLAG), process.env.PI_ATIF_DIR, ctx.cwd);

	const header = (ctx: ExtensionContext) =>
		ctx.sessionManager.getHeader() ?? {
			id: ctx.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: ctx.cwd,
		};

	const defaultFile = (ctx: ExtensionContext): string | undefined => {
		const dir = configuredDir(ctx);
		return dir === undefined ? undefined : resolve(dir, trajectoryFileName(header(ctx)));
	};

	const convert = (ctx: ExtensionContext, file: string): ConvertOutput | undefined => {
		const active = new Set(pi.getActiveTools());
		return toTrajectory({
			header: header(ctx),
			branch: ctx.sessionManager.getBranch(),
			agentVersion: VERSION,
			producer: PRODUCER,
			model: ctx.model && { id: ctx.model.id, provider: ctx.model.provider },
			tools: pi.getAllTools().filter((t) => active.has(t.name)),
			imageDir: imageDirFor(file),
			fallbackSystemPrompt: ctx.getSystemPrompt(),
		});
	};

	// A logger must never be the reason a session fails, so every write is
	// caught. It must not fail *silently* either: someone who configured a
	// directory and finds it empty has been misled about what was kept. Said
	// once per session, not once per prompt.
	let warned = false;
	const warn = (ctx: ExtensionContext, err: unknown): void => {
		if (warned) return;
		warned = true;
		const message = `pi-logging-atif: could not write the trajectory: ${err instanceof Error ? err.message : String(err)}`;
		if (ctx.hasUI) ctx.ui.notify(message, "warning");
		else process.stderr.write(`${message}\n`);
	};

	const autosave = (_event: unknown, ctx: ExtensionContext): void => {
		const file = defaultFile(ctx);
		if (file === undefined) return;
		try {
			const out = convert(ctx, file);
			if (out) writeTrajectory(file, out);
		} catch (err) {
			warn(ctx, err);
		}
	};

	pi.on("session_start", () => {
		warned = false;
	});

	// The system prompt, as the model receives it. pi 0.84 never persists it, so
	// it is recorded here as a custom entry — kept with the session, never sent
	// to the model — whenever it differs from the last one recorded.
	//
	// agent_start rather than before_agent_start: by agent_start pi has applied
	// every extension's before_agent_start edit, so `getSystemPrompt()` is the
	// final prompt whatever order the extensions loaded in. And it still precedes
	// the user message's persistence, so the entry lands ahead of the turn it
	// belongs to.
	pi.on("agent_start", (_event, ctx) => {
		if (configuredDir(ctx) === undefined) return;
		try {
			const prompt = ctx.getSystemPrompt();
			if (prompt !== lastRecordedPrompt(ctx.sessionManager.getBranch())) {
				pi.appendEntry(SYSTEM_PROMPT_ENTRY, { text: prompt });
			}
		} catch (err) {
			warn(ctx, err);
		}
	});

	// After each prompt; after a compaction, which rewrites what the model will
	// see next; and on the way out, which covers quit, /new, /resume and /fork.
	pi.on("agent_end", autosave);
	pi.on("session_compact", autosave);
	pi.on("session_shutdown", autosave);

	pi.registerCommand("atif-export", {
		description: "Write this session's ATIF trajectory now: /atif-export [path]",
		handler: async (args, ctx) => {
			const path = args.trim();
			const file = path ? resolve(ctx.cwd, path) : defaultFile(ctx);
			if (file === undefined) {
				ctx.ui.notify("Usage: /atif-export <path> — or set PI_ATIF_DIR / --atif-dir to choose a default", "info");
				return;
			}
			try {
				const out = convert(ctx, file);
				if (!out) {
					ctx.ui.notify("Nothing to export yet: the session has no turns", "info");
					return;
				}
				writeTrajectory(file, out);
				ctx.ui.notify(`ATIF trajectory written: ${file} (${out.trajectory.steps.length} steps)`, "info");
			} catch (err) {
				ctx.ui.notify(`ATIF export failed: ${err instanceof Error ? err.message : String(err)}`, "error");
			}
		},
	});
}
