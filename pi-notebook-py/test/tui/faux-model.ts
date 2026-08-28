// A scripted model, loaded beside the extension under test.
//
// pi-ai ships `fauxProvider`, its own in-process test double, and a
// `FauxResponseFactory` receives the `Context` pi built for the call. That
// makes this extension both halves of a deterministic tier:
//
//   driver    — it returns the next scripted assistant message, so real tools
//               run against a real Python kernel with no model involved;
//   recorder  — it writes each turn's whole `Context` to .faux/turn-N.json.
//
// The `Context` is recorded whole — `{ systemPrompt, tools, messages }` — and
// not just its messages. The other two are the only place the extension's
// `promptSnippet`, `promptGuidelines` and typebox parameter descriptions can be
// observed as the model receives them: none of it appears in a message, and
// `before_provider_request` (the hook that carries the wire payload) never
// fires here, because the faux provider does not call pi-ai's `onPayload`.
//
// No network, no API key, no cost, nothing to flake. Test-only: `files` in
// package.json ships extensions/, src/ and py/*.py, so nothing under test/ can
// reach the registry — `npm run pack-check` enforces it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	type Context,
	type Message,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	FAUX_DIR,
	FAUX_MODEL,
	FAUX_PROVIDER,
	LAST_ID,
	SCRIPT_FILE,
	turnFile,
	type ScriptStep,
} from "./faux-script.ts";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL }] });
	pi.registerProvider(faux.provider);

	pi.on("session_start", async (_event, ctx) => {
		const dir = join(ctx.cwd, FAUX_DIR);
		mkdirSync(dir, { recursive: true });
		const script = JSON.parse(readFileSync(join(dir, SCRIPT_FILE), "utf8")) as ScriptStep[];

		// Own counter rather than `state.callCount`, whose increment point
		// relative to the factory is not part of the documented contract. Turns
		// are numbered from 1 in the order the provider was asked.
		let turn = 0;
		faux.setResponses(
			script.map((step) => (context: Context) => {
				turn++;
				writeFileSync(
					turnFile(ctx.cwd, turn),
					JSON.stringify(
						{
							systemPrompt: context.systemPrompt,
							tools: context.tools,
							messages: context.messages,
						},
						null,
						1,
					),
					"utf8",
				);
				if ("text" in step) return fauxAssistantMessage(step.text);
				return fauxAssistantMessage(fauxToolCall(step.tool, resolve(step.args, context.messages)), {
					stopReason: "toolUse",
				});
			}),
		);

		// Selected here rather than with --provider/--model on the command line.
		// A registration made in the extension factory is queued and applied when
		// the runner initialises, and session_start is documented to run after
		// that, so this is the point where the model is known to exist.
		const model = ctx.modelRegistry.find(FAUX_PROVIDER, FAUX_MODEL);
		if (!model) throw new Error("faux: the faux model did not register");
		if (!(await pi.setModel(model))) throw new Error("faux: pi refused the faux model");
	});
}

/** Substitute cell-id placeholders in a scripted tool's arguments. */
function resolve(
	args: Record<string, unknown>,
	messages: readonly Message[],
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		out[key] = typeof value === "string" ? substitute(value, messages) : value;
	}
	return out;
}

function substitute(value: string, messages: readonly Message[]): string {
	if (value === LAST_ID) {
		const ids = cellIds(messages);
		if (!ids.length) throw new Error(`faux: ${LAST_ID} used before any cell was created`);
		return ids[ids.length - 1];
	}
	const nth = value.match(/^@id:(\d+)$/);
	if (!nth) return value;
	const ids = cellIds(messages);
	const n = Number(nth[1]);
	if (n < 1 || n > ids.length) {
		throw new Error(`faux: ${value} but only ${ids.length} cells have been created`);
	}
	return ids[n - 1];
}

/**
 * Every cell id in the transcript, in creation order.
 *
 * `nb_cell` prints `id: <id>` on every call, create or edit, so these lines are
 * deduplicated to recover the creation order. Read from the transcript on
 * purpose: a script that cannot find the id it just created is itself an
 * assertion that the id reached the model.
 */
function cellIds(messages: readonly Message[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		if (m.role !== "toolResult") continue;
		const text = m.content.map((c) => (c.type === "text" ? c.text : "")).join("");
		const hit = text.match(/^id: (\S+)/m);
		if (hit && !ids.includes(hit[1])) ids.push(hit[1]);
	}
	return ids;
}
