// Live cases: a real model drives the kernel through the agent tools.
//
// These call a LLM API and cost money, and they always run — there is no opt-out.
// They are the only coverage extensions/index.ts has, so refusing loudly beats
// skipping quietly: an absent key fails the run rather than silently reducing it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { session, sessionFilesFor } from "./session.ts";

if (!process.env.OPENROUTER_API_KEY) {
	throw new Error(
		"OPENROUTER_API_KEY is not set — the live interactive cases cannot run.\n" +
			"Set it in .env at the repo root (see env.example).",
	);
}

// L1: the model should prefer py_cell over bash python, quote the returned
// id when modifying, and land a correct final value in the namespace.
test("L1: model builds cells and modifies one by id", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"Using the python kernel tools (py_cell), create a cell that sets total = 10, then a second cell that sets doubled = total * 2. Then modify the first cell so total = 21. Finally tell me the value of doubled.",
	);
	await s.expect("doubled", { timeout: 240_000 });
	await s.expect("42", { timeout: 60_000 });
	await s.close();
});

// L2: after an ImportError the model should reach for py_install, not bash.
// Each fixture's kernel runs in a fresh project venv, so cowsay genuinely
// is not installed. The assertion keys on the tool's output text (the word
// restart_required/installed), not the echoed prompt.
test("L2: model installs a package via py_install after ImportError", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"In the python kernel (py_cell), write a cell that imports the cowsay package and sets have_cowsay = True. The import will fail; install the package into the kernel properly and make sure the cell ends up ran, then confirm have_cowsay is True.",
	);
	// py_install's result text: "installed (environment changed)"
	await s.expect("environment changed", { timeout: 300_000 });
	await s.expect("have_cowsay=True", { timeout: 60_000 });
	await s.close();
});

// L3: the context filter, which nothing below this tier can reach — the hook
// fires before an LLM call, so proving it is registered takes a real one.
//
// The assertion is that the model reads back a word this test never says. A
// cell edited twice leaves three values behind, but the two older tool results
// are re-rendered before each call and no longer carry theirs; what is in their
// place is the marker. If the hook were not firing, the model would be quoting
// `* <id> ran ... 1` instead.
test("L3: superseded cell output is gone from the model's context", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"Using py_cell, create ONE cell that sets total = 1. Then modify that same cell so total = 2, " +
			"and modify it once more so total = 3. Finally, look back at your two EARLIER py_cell " +
			"results for that cell and quote me, word for word, the last line each one shows you now.",
	);
	await s.expect("superseded", { timeout: 300_000 });
	await s.close();

	// The structured copy the filter re-renders from rides on the tool result's
	// `details`, which is persisted — so a resumed session can still filter a
	// transcript it did not write.
	const files = sessionFilesFor(s.dir);
	assert.ok(files.length, `no session file recorded for ${s.dir}`);
	assert.match(readFileSync(files[0], "utf8"), /"kind":"py\.cells"/);
});
