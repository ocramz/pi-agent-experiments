// A scripted model, loaded beside the extension under test.
//
// Two jobs, the same two as pi-incremental-py/test/tui/faux-model.ts:
//
//   driver    — it returns the next scripted assistant message, so pi runs a
//               real agent loop, real tools and real session persistence with
//               no network and no key;
//   recorder  — it writes each call's `Context` to .faux/turn-N.json, and that
//               file's `systemPrompt` is the prompt the provider was actually
//               handed. It is the one independent witness the trajectory's
//               system step can be checked against.
//
// Test-only: `files` in package.json ships extensions/ and src/, so nothing
// under test/ reaches the registry — `npm run pack-check` enforces it.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
	type Context,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAUX_DIR, FAUX_MODEL, FAUX_PROVIDER, SCRIPT_FILE, turnFile, type ScriptStep } from "./faux-script.ts";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL }] });
	pi.registerProvider(faux.provider);

	pi.on("session_start", async (_event, ctx) => {
		const dir = join(ctx.cwd, FAUX_DIR);
		mkdirSync(dir, { recursive: true });
		const script = JSON.parse(readFileSync(join(dir, SCRIPT_FILE), "utf8")) as ScriptStep[];

		let turn = 0;
		faux.setResponses(
			script.map((step) => (context: Context) => {
				turn++;
				writeFileSync(
					turnFile(ctx.cwd, turn),
					JSON.stringify({ systemPrompt: context.systemPrompt, tools: context.tools, messages: context.messages }, null, 1),
					"utf8",
				);
				if ("tool" in step) return fauxAssistantMessage(fauxToolCall(step.tool, step.args), { stopReason: "toolUse" });
				return fauxAssistantMessage(step.thinking ? [fauxThinking(step.thinking), fauxText(step.text)] : step.text);
			}),
		);

		// Selected here, not with --provider/--model: a provider registered in the
		// factory is applied when the runner initialises, which session_start
		// follows, so this is where the model is known to exist.
		const model = ctx.modelRegistry.find(FAUX_PROVIDER, FAUX_MODEL);
		if (!model) throw new Error("faux: the faux model did not register");
		if (!(await pi.setModel(model))) throw new Error("faux: pi refused the faux model");
	});
}
