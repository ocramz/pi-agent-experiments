// A scripted model, loaded beside the extension under test (pi -e).
//
// pi-ai's `fauxProvider` is its own in-process test double; a response factory
// receives the `Context` pi built for the call, so this file is both halves of
// a deterministic tier:
//
//   driver    it returns the next scripted assistant message, so real tools
//             run against a real Lean server with no model involved;
//   recorder  it writes each turn's whole Context to .faux/turn-N.json — the
//             only place promptSnippet, promptGuidelines and the skills block
//             can be observed as the model receives them.
//
// Adapted from pi-notebook-py/test/tui/faux-model.ts. Test-only: `files` in
// package.json never ships test/.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FAUX_DIR, FAUX_MODEL, FAUX_PROVIDER, SCRIPT_FILE, type ScriptStep, turnFile } from "./faux-script.ts";

export default function (pi: ExtensionAPI) {
	const faux = fauxProvider({ provider: FAUX_PROVIDER, models: [{ id: FAUX_MODEL }] });
	pi.registerProvider(faux.provider);

	pi.on("session_start", async (_event, ctx) => {
		const dir = join(ctx.cwd, FAUX_DIR);
		mkdirSync(dir, { recursive: true });
		const script = JSON.parse(readFileSync(join(dir, SCRIPT_FILE), "utf8")) as ScriptStep[];
		let turn = 0;
		const respond = (context: Context) => {
			const step = script[Math.min(turn, script.length - 1)];
			turn++;
			writeFileSync(
				turnFile(ctx.cwd, turn),
				JSON.stringify({ systemPrompt: context.systemPrompt, tools: context.tools, messages: context.messages }, null, 1),
				"utf8",
			);
			if ("text" in step) return fauxAssistantMessage(step.text);
			return fauxAssistantMessage(fauxToolCall(step.tool, step.args), { stopReason: "toolUse" });
		};
		// Enough responses for any loop the tests run; each one reads the script
		// by turn number, so the list's length is only a ceiling.
		faux.setResponses(Array.from({ length: 200 }, () => respond));

		const model = ctx.modelRegistry.find(FAUX_PROVIDER, FAUX_MODEL);
		if (!model) throw new Error("faux: the faux model did not register");
		if (!(await pi.setModel(model))) throw new Error("faux: pi refused the faux model");
	});
}
