// A real model drives the extension through pi. 
// 
//NB : uses pi API calls so could cost money.
//
// Test coverage to show that a model, given these
// tools and skills, actually uses them to finish a proof. It refuses to start
// without OPENROUTER_API_KEY rather than skipping — a run without a key must not
// report green over the one thing this tier exists to check. Assertions are on
// durable state (the file, Lean's own verdict on it, the session record), never
// on the model's prose.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { groupAlive } from "../../src/lean/process.ts";
import { axiomsOp } from "../../src/ops/verify.ts";
import { findSorries } from "../../src/ops/sorries.ts";
import { oc, project, runtime } from "./fixture.ts";
import { piPrint } from "./pi-print.ts";

if (!process.env.OPENROUTER_API_KEY) {
	throw new Error(
		"OPENROUTER_API_KEY is not set: test/lean/live.test.ts is the only coverage of a model using pi-lean4, and it does not skip. " +
			"Run it through `make test-lean` (which loads .env) or export the key.",
	);
}

test("PL1: a model fills a sorry using the Lean tools, and the result checks out", async (t) => {
	const p = project(t, {
		"Fixture/Comm.lean": "theorem my_add_comm (a b : Nat) : a + b = b + a := by\n  sorry\n",
	});
	p.build();
	const r = await piPrint(
		p.root,
		"In Fixture/Comm.lean, replace the sorry in my_add_comm with a real proof. " +
			"Use lean_goal to see the goal and lean_attempt to test tactics before editing; then confirm the file compiles. Do not change the statement.",
		{ live: true },
	);
	assert.equal(r.code, 0, `pi failed:\n${r.stderr.slice(-2000)}`);
	const text = readFileSync(p.path("Fixture/Comm.lean"), "utf8");
	assert.deepEqual(findSorries(text), [], `the sorry is still there:\n${text}`);
	assert.match(text, /theorem my_add_comm \(a b : Nat\) : a \+ b = b \+ a :=/, "the statement was changed");
	const session = r.sessionText();
	assert.match(session, /"toolName":"lean_(goal|attempt|diagnostics)"/, "the model never used a Lean tool");
	assert.deepEqual(r.pgids.filter(groupAlive), [], "a Lean server outlived pi");
	const { rt, cfg } = runtime(t);
	const v = await axiomsOp(rt, { path: "Fixture/Comm.lean", name: "my_add_comm" }, oc(p, cfg));
	assert.equal((v.details as { allStandard: boolean }).allStandard, true, v.text);
});
