/**
 * A dev-only pi extension that records what the model was told, shown and asked.
 *
 *   pi -e <package>/extensions/index.ts -e shared/dev/pi-logger.ts
 *
 * Every tier in this repo asserts on something the model *did*. This records
 * the inputs instead — the assembled system prompt, the tool schemas, the
 * payload on the wire, and each tool call with the `details` its result carried.
 * It is for the dev loop and for post-mortems on live tests, not for CI: nothing
 * here asserts anything.
 *
 * ── Not a package, on purpose ──────────────────────────────────────
 * `shared/` has no package.json and no `files` allowlist, so this cannot reach
 * the registry by any route. A logger that shipped inside an extension would be
 * a debug tool running in users' sessions, writing their transcripts to disk.
 *
 * ── Order matters ──────────────────────────────────────────────────
 * pi runs `context` handlers in extension load order, chaining each one's result
 * into the next (ExtensionRunner.emitContext). So:
 *
 *   -e index.ts -e pi-logger.ts    logs what the model sees   (post-filter)
 *   -e pi-logger.ts -e index.ts    logs the raw transcript    (pre-filter)
 *
 * The first is almost always what is wanted, and is what test/tui/session.ts
 * arranges. This handler returns `undefined` either way — pi's no-op — and a
 * logger that returned messages would silently become a filter.
 *
 * ── One file per session ───────────────────────────────────────────
 * `node --test` runs suites concurrently and a dev container may hold several
 * sessions at once, so a fixed path would interleave unrelated runs into one
 * unreadable file. JSONL rather than pretty-printed blocks so `grep` and `jq`
 * both work:
 *
 *   jq -r 'select(.event=="tool_call") | .input.src' .pi-log/*.jsonl
 *   jq -r 'select(.event=="context") | "\(.messages) msgs \(.bytes)b"' .pi-log/*.jsonl
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Where the log goes. Absolute, or relative to the session's cwd. */
const LOG_DIR = process.env.PI_PY_LOG_DIR ?? ".pi-log";

/**
 * Cap on any one recorded string.
 *
 * A `run_all` over a large notebook, or a provider payload late in a session,
 * runs to hundreds of kilobytes. Truncation is marked rather than silent: a log
 * that quietly drops the end of the payload is worse than no log, because it
 * reads as evidence that the end was not there.
 */
const MAX_CHARS = Number(process.env.PI_PY_LOG_MAX ?? 8192);

export default function (pi: ExtensionAPI) {
	// Resolved at session_start, when there is a cwd and a session id. Until
	// then there is nothing to log anyway: no prompt is assembled and no tool
	// has run.
	let file: string | undefined;

	const log = (event: string, data: Record<string, unknown>): void => {
		if (!file) return;
		try {
			appendFileSync(file, `${JSON.stringify({ t: Date.now(), event, ...clipRecord(data) })}\n`);
		} catch {
			// A logger must never be the reason a session fails. A full disk or a
			// read-only cwd costs the log, not the run.
		}
	};

	pi.on("session_start", (_event, ctx) => {
		const dir = LOG_DIR.startsWith("/") ? LOG_DIR : join(ctx.cwd, LOG_DIR);
		try {
			mkdirSync(dir, { recursive: true });
			file = join(dir, `${process.pid}.jsonl`);
		} catch {
			return;
		}
		log("session_start", { cwd: ctx.cwd });
		// The schemas as *registered*, which is not quite the schemas as sent:
		// `sourceInfo` says which extension a tool came from, and
		// `promptGuidelines` are still attributed to their tool here, where the
		// assembled prompt has flattened them into one anonymous list.
		log("tools", { tools: pi.getAllTools() });
	});

	// Fires once per user turn, with the prompt pi assembled and the structured
	// inputs it built it from — custom prompt, active tools, snippets,
	// guidelines, cwd, context files, skills. This is where to look when a
	// promptSnippet or a guideline did not land.
	pi.on("before_agent_start", (event) => {
		log("prompt", {
			systemPrompt: event.systemPrompt,
			systemPromptOptions: event.systemPromptOptions,
		});
	});

	// The literal payload, after every context hook has had its turn. Live
	// providers only: pi-ai's faux provider never calls `onPayload`, so this is
	// silent under test/tui/faux-model.ts and the deterministic tier reads the
	// `Context` instead.
	pi.on("before_provider_request", (event) => {
		log("payload", { payload: event.payload });
	});

	// Read-only. See "Order matters" above for which side of the filter this is.
	pi.on("context", (event) => {
		log("context", {
			messages: event.messages.length,
			bytes: JSON.stringify(event.messages).length,
		});
	});

	pi.on("tool_call", (event) => {
		log("tool_call", { tool: event.toolName, id: event.toolCallId, input: event.input });
	});

	// `details` is the interesting half: it never reaches the provider, and in
	// pi-incremental-py it is the structured response the context filter
	// re-renders every superseded result from.
	pi.on("tool_result", (event) => {
		log("tool_result", {
			tool: event.toolName,
			id: event.toolCallId,
			isError: event.isError,
			content: event.content,
			details: event.details,
		});
	});
}

/**
 * Truncate every string in the record, however deeply nested.
 *
 * Walks rather than clipping the serialized line so that the output stays valid
 * JSON — a log you cannot `jq` is a log you end up reading with your eyes.
 */
function clipRecord(data: Record<string, unknown>): Record<string, unknown> {
	const seen = new WeakSet<object>();
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) out[k] = clip(v, seen);
	return out;
}

function clip(value: unknown, seen: WeakSet<object>): unknown {
	if (typeof value === "string") {
		return value.length > MAX_CHARS
			? `${value.slice(0, MAX_CHARS)}… [${value.length - MAX_CHARS} more chars]`
			: value;
	}
	if (value === null || typeof value !== "object") return value;
	if (seen.has(value)) return "[circular]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((v) => clip(v, seen));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) out[k] = clip(v, seen);
	return out;
}
