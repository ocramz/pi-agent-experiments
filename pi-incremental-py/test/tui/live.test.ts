// Live cases: a real model drives the kernel through the agent tools.
//
// These call a LLM API and cost money, and they always run — there is no opt-out.
// They are the only coverage extensions/index.ts has, so refusing loudly beats
// skipping quietly: an absent key fails the run rather than silently reducing it.
//
// Every live session loads shared/dev/pi-logger.ts (session.ts defaults `log` on
// for `live`), so the payload the provider was sent is on disk under the
// fixture. That turns a failure here from "the model did not say the word" —
// which could mean the extension broke, or the model had an off day — into
// something readable: `PI_TUI_KEEP=1` prints the log path.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PyDetails } from "../../src/context-filter.ts";
import { loggedToolCalls, payloadToolResults, waitForLog } from "./inspect.ts";
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

/**
 * The kernel snapshot a py_* result carried, if it carried one.
 *
 * `details` never reaches the provider, so this is the extension's own record
 * of what the kernel answered rather than a re-parse of what it printed.
 */
function snapshotOf(c: {
	result?: { details?: unknown };
}): { globals?: Record<string, string>; failing?: string[] } | undefined {
	const response = (c.result?.details as { response?: { globals?: Record<string, string> } })
		?.response;
	return response?.globals ? response : undefined;
}

/** The most recent one, which is the only one describing the kernel as it is. */
function newestSnapshot(calls: Parameters<typeof snapshotOf>[0][]) {
	return calls.map(snapshotOf).filter((s) => s !== undefined).at(-1);
}

// L2: after an ImportError the model should reach for py_install, not bash.
// Each fixture's kernel runs in a fresh project venv, so cowsay genuinely
// is not installed.
//
// Nothing here reads the screen. What pi prints of a turn is the model's own
// paraphrase of it, and this case used to wait for the literal `have_cowsay=True`
// — which failed against a model that wrote `have_cowsay = True` after doing
// every single thing right. The log moves when the extension moves; the screen
// moves when the model picks different words.
test("L2: model installs a package via py_install after ImportError", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"In the python kernel (py_cell), write a cell that imports the cowsay package and sets have_cowsay = True. The import will fail; install the package into the kernel properly and make sure the cell ends up ran, then confirm have_cowsay is True.",
	);
	// The outcome, not one call: an install that errored carries no structured
	// details, so a model that mistyped a package name gets the turn it was
	// about to spend fixing that rather than a session closed underneath it.
	await waitForLog(
		s,
		"a py_install leaving the kernel with have_cowsay = True",
		(calls) =>
			calls.some(
				(c) => c.tool === "py_install" && (c.result?.details as { kind?: unknown })?.kind === "py.install",
			) && newestSnapshot(calls)?.globals?.have_cowsay === "True",
	);
	await s.close();

	const calls = loggedToolCalls(s.logEvents());

	// Half the claim: py_install, for the package the prompt named.
	const installs = calls.filter((c) => c.tool === "py_install");
	assert.ok(installs.length, `no py_install call under ${s.logPath()}`);
	assert.match(JSON.stringify(installs.map((c) => c.input)), /cowsay/);

	// The other half, which this case is named for and never checked. Narrow on
	// purpose: a model shelling out to `python -c "import cowsay"` to see for
	// itself has done nothing wrong — installing from bash is what bypasses the
	// kernel's environment tracking and leaves cached cells stale.
	const shelled = calls.filter(
		(c) =>
			c.tool === "bash" &&
			/\b(?:pip[0-9.]*|uv)\b[\s\S]*\binstall\b/.test(JSON.stringify(c.input)),
	);
	assert.equal(
		shelled.length,
		0,
		`the model installed from bash instead of py_install:\n${shelled
			.map((c) => JSON.stringify(c.input))
			.join("\n")}`,
	);

	// The install put a package there that was genuinely absent — a fresh
	// project venv per fixture is what makes that a fact rather than a hope.
	const headers = installs.flatMap(
		(c) => (c.result?.details as Extract<PyDetails, { kind: "py.install" }>)?.header ?? [],
	);
	assert.ok(
		headers.some((h) => h.includes("environment changed")),
		`no install reported an environment change: ${headers.join(" / ") || "(no headers)"}`,
	);

	// And the kernel ended up holding what was asked for. Read off the newest
	// globals snapshot any py_* result carried rather than off the install
	// specifically: which call reports it depends on the order the model worked
	// in. Write the failing cell first and the install re-runs it and says so —
	// it reports the same tails as every other mutating op, which is new, and
	// is what let this case stop demanding a confirming `inspect`. Install up
	// front instead and the py_cell that follows is where it shows.
	const newest = newestSnapshot(calls);
	assert.equal(
		newest?.globals?.have_cowsay,
		"True",
		`the kernel never ended up holding have_cowsay = True; log: ${s.logPath()}`,
	);
	assert.deepEqual(newest?.failing ?? [], [], "a cell was left failing");
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

	// What the model quoted back is evidence, but indirect: it is the model's
	// report of its own context, and a model can misreport. The logger recorded
	// the payload the provider was actually sent, which is the claim itself.
	// This is the one place it can be checked — the faux tier has no real
	// provider, so `before_provider_request` never fires there.
	//
	// The payload's *tool results*, specifically, and not the payload as a whole.
	// The filter rewrites tool results; it does not touch what the model itself
	// wrote, and no `context` handler should — an assistant message is the
	// model's own memory, and editing it would be forging one. A model that
	// reasons "the cell shows total=1" before editing has that sentence replayed
	// into every later request, so a grep over the whole serialized payload
	// fails on the model's prose while the filter is working perfectly. That is
	// exactly how this case once broke.
	const payloads = s.logEvents().filter((e) => e.event === "payload");
	assert.ok(payloads.length, `the logger recorded no provider payload under ${s.logPath()}`);
	const results = payloadToolResults(payloads[payloads.length - 1].payload);
	// Without this the two checks below are vacuous: an unrecognised wire shape
	// yields no results, and everything `doesNotMatch` an empty string.
	assert.ok(results.length, `no tool results in the last payload under ${s.logPath()}`);
	const shown = results.join("\n");
	assert.match(shown, /superseded/, "the last payload's tool results carried no superseded marker");
	assert.match(shown, /total=3/, "the newest result lost the live value");
	assert.doesNotMatch(
		shown,
		/total=1\b/,
		"a value the kernel has recomputed twice was still in a tool result",
	);

	// The structured copy the filter re-renders from rides on the tool result's
	// `details`, which is persisted — so a resumed session can still filter a
	// transcript it did not write.
	const files = sessionFilesFor(s.dir);
	assert.ok(files.length, `no session file recorded for ${s.dir}`);
	assert.match(readFileSync(files[0], "utf8"), /"kind":"py\.cells"/);
});
