// Live cases: a real model drives the Tavily search tool.
//
// These call a LLM API and the Tavily API and cost money, and they always
// run — there is no opt-out. They are the only coverage extensions/index.ts
// has, so refusing loudly beats skipping quietly: an absent key fails the
// run rather than silently reducing it.

import { test } from "node:test";
import { session } from "./session.ts";

for (const key of ["OPENROUTER_API_KEY", "TAVILY_API_KEY"]) {
	if (!process.env[key]) {
		throw new Error(
			`${key} is not set — the live interactive cases cannot run.\n` +
				"Set it in .env at the repo root (see env.example).",
		);
	}
}

// L1: the model should reach for web_search_tavily, not guess from
// training data, and report something only the search results contain.
// The query is phrased to be about current reality, so a non-searching
// model cannot bluff its way through reliably.
test("L1: model answers a factual question via web_search_tavily", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"Use the web_search_tavily tool to find out who wrote the novel 'The Name of the Rose', then tell me the author and give me the source URL the tool returned.",
	);
	await s.expect("Umberto Eco", { timeout: 240_000 });
	await s.expect("http", { timeout: 60_000 });
	await s.close();
});

// L2: with the key deliberately hidden, the tool result tells the model
// the key is missing, and the model should relay that instead of
// fabricating search results.
test("L2: model reports a missing TAVILY_API_KEY rather than fabricating", async (t) => {
	const saved = process.env.TAVILY_API_KEY;
	delete process.env.TAVILY_API_KEY;
	t.after(() => {
		if (saved !== undefined) process.env.TAVILY_API_KEY = saved;
	});
	const s = await session(t, { live: true });
	await s.command(
		"Search the web for today's weather in Tokyo using the web_search_tavily tool, and tell me what happened.",
	);
	await s.expect("TAVILY_API_KEY", { timeout: 240_000 });
	await s.close();
});
