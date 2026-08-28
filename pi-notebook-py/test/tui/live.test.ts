// Live cases: a real model drives the notebook through the agent tools.
//
// These call a LLM API and cost money, and they always run — there is no
// opt-out. They are the only coverage extensions/index.ts has, so refusing
// loudly beats skipping quietly: an absent key fails the run rather than
// silently reducing it.
//
// `PI_TUI_KEEP=1` keeps the fixture, which is where the saved notebook and the
// session file are when one of these fails for a reason worth reading.
//
// Every `expect` here keys on text the *extension* produced, never on a word
// that also appears in the prompt: pi echoes the typed command onto the screen,
// so `expect("saved")` after asking the model to "tell me when it is saved"
// matches instantly and asserts nothing at all.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { session } from "./session.ts";

if (!process.env.OPENROUTER_API_KEY) {
	throw new Error(
		"OPENROUTER_API_KEY is not set — the live interactive cases cannot run.\n" +
			"Set it in .env at the repo root (see env.example).",
	);
}

// L1: the model should prefer nb_cell over bash python, quote the returned id
// when editing, and land a correct final value in the namespace.
test("L1: the model builds cells and edits one by id", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"Using the notebook tools (nb_cell, nb_run), create a cell that sets total = 1000, " +
			"then a second cell that sets doubled = total * 2. Then edit the first cell so " +
			"total = 12345, re-run what needs re-running, and tell me the value of doubled.",
	);
	// Five digits on purpose. The expected answer appears nowhere in the prompt,
	// so it cannot match the echo — and it cannot match a rendered duration
	// either, the way a bare "42" would against `* [1] c1 42.1ms`.
	await s.expect("24690", { timeout: 240_000 });
	await s.close();
});

// L2: the staleness report has to be *actionable*, not merely present. The
// model is told nothing about it here — if it re-runs, it did so because the
// tool result said to.
test("L2: the model acts on the staleness report without being told about it", async (t) => {
	const s = await session(t, { live: true });
	await s.command(
		"Using the notebook tools, make three cells: a = 2, then b = a * 4444, then print(b). " +
			"Run them. Then change the first cell to a = 5 and make sure every cell's output " +
			"is up to date. Finish by telling me the final printed value.",
	);
	// See L1 on why the expected value is five digits.
	await s.expect("22220", { timeout: 240_000 });
	await s.close();
});

// L3: the whole persistence story, end to end and through a real model —
// save, then read the file back off disk ourselves.
test("L3: the model saves a notebook that is really on disk", async (t) => {
	const s = await session(t, { live: true });
	const path = join(s.root, "analysis.py");
	await s.command(
		`Using the notebook tools, create one cell that sets answer = 42, run it, then write ` +
			`the notebook to ${path} with nb_notebook. Report what the tool told you.`,
	);
	// The extension's own wording — `saved 1 cell(s) to <path>` — so this waits
	// for the tool to have actually run rather than for the model to say so.
	await s.expect("cell(s) to", { timeout: 240_000 });
	await s.close();

	// After close(): the kernel writes the file from a subprocess, and reading
	// it while the session is live races that.
	assert.ok(existsSync(path), `the model reported saving but there is no file at ${path}`);
	const text = readFileSync(path, "utf8");
	assert.match(text, /^# %%/m, `not a percent-format notebook:\n${text}`);
	assert.match(text, /answer\s*=\s*42/);
});

// L4: an ImportError should send the model to nb_install, not to bash. Each
// fixture's kernel runs in a fresh project venv, so cowsay genuinely is not
// installed.
test("L4: the model installs into the kernel rather than shelling out to pip", async (t) => {
	const s = await session(t, { live: true });
	// Deliberately does not say how to fix it: reaching for nb_install rather
	// than for bash is the thing under test, and naming the tool would hand the
	// model the answer.
	await s.command(
		"Using the notebook tools, make a cell that does `import cowsay` and run it. " +
			"If it does not work, make it work, then run the cell again to prove it.",
	);
	// The extension's own wording on a successful install.
	await s.expect("installed: cowsay", { timeout: 240_000 });
	await s.close();

	// pip in bash would install somewhere the kernel is not looking, so the
	// cell could not have come to work that way.
	const transcript = s.sessionText();
	assert.match(transcript, /nb_install/, "the model never reached for nb_install");
});
