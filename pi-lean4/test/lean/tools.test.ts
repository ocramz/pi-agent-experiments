// Every op against a real `lake serve`, and the lifecycle guarantees with real
// Lean processes: one server, rebuilt imports, nothing left behind.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { test } from "node:test";
import { descendants, groupAlive, pidAlive } from "../../src/lean/process.ts";
import { hypothesesOp } from "../../src/ops/analyze/hypotheses.ts";
import { profileOp } from "../../src/ops/analyze/profile.ts";
import { attemptOp } from "../../src/ops/attempt.ts";
import { buildOp } from "../../src/ops/build.ts";
import { diagnosticsOp } from "../../src/ops/diagnostics.ts";
import { goalOp } from "../../src/ops/goals.ts";
import { navOp } from "../../src/ops/nav.ts";
import { RateLimiter } from "../../src/ops/search/ratelimit.ts";
import { searchOp } from "../../src/ops/search/search.ts";
import { sorriesOp } from "../../src/ops/sorries.ts";
import { axiomsOp } from "../../src/ops/verify.ts";
import { BASIC, USE, oc, project, runtime } from "./fixture.ts";

const hash = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("LN1: diagnostics, with columns counted in characters past an astral one", async (t) => {
	const p = project(t, { "Fixture/Basic.lean": BASIC, "Fixture/Astral.lean": "def 𝔽x : Nat := 1\ntheorem t : 𝔽x = 1 := boom\n" });
	const { rt, cfg } = runtime(t);
	const r = await diagnosticsOp(rt, { path: "Fixture/Astral.lean" }, oc(p, cfg));
	const err = r.details.items.find((i) => i.severity === "error");
	assert.ok(err, r.text);
	assert.equal(err.line, 2);
	assert.equal(err.column, [..."theorem t : 𝔽x = 1 := "].length + 1);
	assert.equal(r.details.complete, true);
	assert.equal(r.details.clean, false);
});

test("LN2: goals before and after a line, at a column, and term goals", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const r = await goalOp(rt, { path: "Fixture/Use.lean", line: 9 }, oc(p, cfg));
	assert.equal(r.details.before?.status, "goals");
	assert.deepEqual(r.details.before?.goals, ["a b : Nat\n⊢ a + b = b + a"]);
	assert.equal(r.details.after?.status, "complete");
	const outside = await goalOp(rt, { path: "Fixture/Use.lean", line: 1, column: 1 }, oc(p, cfg));
	assert.equal(outside.details.at?.status, "no_goal");
	const term = await goalOp(rt, { path: "Fixture/Use.lean", line: 5, column: 40, kind: "term" }, oc(p, cfg));
	assert.match(term.details.expectedType ?? "", /⊢ Nat/);
	await assert.rejects(goalOp(rt, { path: "Fixture/Use.lean", line: 999 }, oc(p, cfg)), /out of range/);
});

test("LN3: attempts are judged per candidate and never touch the file", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const file = p.path("Fixture/Use.lean");
	const before = { hash: hash(file), mtime: statSync(file).mtimeMs };
	const r = await attemptOp(rt, { op: "tactics", path: "Fixture/Use.lean", line: 9, snippets: ["omega", "simp", "exact Nat.add_comm a b", "skip"] }, oc(p, cfg));
	const v = (r.details as { outcomes: { verdict: string }[] }).outcomes.map((o) => o.verdict);
	assert.deepEqual(v, ["closes the goal", "fails", "closes the goal", "goals remain"]);
	assert.equal(hash(file), before.hash);
	assert.equal(statSync(file).mtimeMs, before.mtime);
	assert.equal(existsSync(p.path("_PiLean4Scratch0.lean")), false);
});

test("LN4: standalone code elaborates in the project, imports included", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const ok = await attemptOp(rt, { op: "code", code: "import Fixture.Basic\n#eval double 21\n" }, oc(p, cfg));
	assert.equal((ok.details as { success: boolean }).success, true, ok.text);
	assert.match(ok.text, /42/);
	const bad = await attemptOp(rt, { op: "code", code: "theorem x : 1 = 2 := rfl\n" }, oc(p, cfg));
	assert.equal((bad.details as { success: boolean }).success, false);
});

test("LN5: axioms — standard, incomplete, native, custom", async (t) => {
	const p = project(t, {
		"Fixture/Ax.lean": [
			"theorem std (p : Prop) : p ∨ ¬p := Classical.em p",
			"theorem inc : 1 = 1 := sorry",
			"theorem nat : 10 + 10 = 20 := by native_decide",
			"axiom cheat : False",
			"theorem cus : 1 = 2 := cheat.elim",
			"",
		].join("\n"),
	});
	const { rt, cfg } = runtime(t);
	const r = await axiomsOp(rt, { path: "Fixture/Ax.lean" }, oc(p, cfg));
	const trust = Object.fromEntries((r.details as { verdicts: { name: string; trust: string }[] }).verdicts.map((v) => [v.name, v.trust]));
	assert.deepEqual(trust, { std: "standard", inc: "incomplete", nat: "native", cus: "custom" }, r.text);
	assert.match(r.text, /axiom declaration/);
	const one = await axiomsOp(rt, { path: "Fixture/Ax.lean", name: "std", scanSource: false }, oc(p, cfg));
	assert.equal((one.details as { allStandard: boolean }).allStandard, true);
});

test("LN6: an edit to an unopened transitive import is seen on the next question", async (t) => {
	const p = project(t, {
		"Fixture/Base.lean": "def base : Nat := 1\n",
		"Fixture/Mid.lean": "import Fixture.Base\ndef mid : Nat := base\n",
		"Fixture/Top.lean": "import Fixture.Mid\ntheorem top : mid = 1 := rfl\n",
	});
	p.build();
	const { rt, cfg } = runtime(t);
	const first = await diagnosticsOp(rt, { path: "Fixture/Top.lean" }, oc(p, cfg));
	assert.equal(first.details.clean, true, first.text);
	p.write("Fixture/Base.lean", "def base : Nat := 2\n");
	const later = new Date(Date.now() + 5000);
	utimesSync(p.path("Fixture/Base.lean"), later, later);
	const second = await diagnosticsOp(rt, { path: "Fixture/Top.lean" }, oc(p, cfg));
	assert.ok(second.details.items.some((i) => i.severity === "error"), `the stale import went unnoticed:\n${second.text}`);
});

test("LN7: an unbuilt project's imports are built once, for that file only", async (t) => {
	const p = project(t, { "Fixture/Basic.lean": BASIC, "Fixture/Use.lean": USE, "Fixture/Other.lean": "def other := 1\n" });
	const { rt, cfg } = runtime(t);
	const r = await diagnosticsOp(rt, { path: "Fixture/Use.lean" }, oc(p, cfg));
	assert.ok(r.details.reopened, r.text);
	assert.match(r.text, /lake rebuilt them/);
	assert.ok(!r.details.items.some((i) => /out of date/.test(i.message)));
	assert.ok(existsSync(p.path(".lake/build/lib/lean/Fixture/Basic.olean")));
	assert.equal(existsSync(p.path(".lake/build/lib/lean/Fixture/Other.olean")), false);
});

test("LN8: lean_build skips when nothing changed and builds after an edit", async (t) => {
	const p = project(t);
	const { rt, cfg } = runtime(t);
	const first = await buildOp(rt, {}, oc(p, cfg));
	assert.equal((first.details as { success: boolean }).success, true, first.text);
	const second = await buildOp(rt, {}, oc(p, cfg));
	assert.equal((second.details as { skipped: boolean }).skipped, true);
	p.write("Fixture/Basic.lean", `${BASIC}\ntheorem more : True := trivial\n`);
	const third = await buildOp(rt, {}, oc(p, cfg));
	assert.equal((third.details as { skipped: boolean }).skipped, false);
	p.write("Fixture/Basic.lean", `${BASIC}\ntheorem broken : 1 = 2 := rfl\n`);
	const failed = await buildOp(rt, {}, oc(p, cfg));
	assert.equal((failed.details as { success: boolean }).success, false);
	assert.match(failed.text, /error/);
	const again = await buildOp(rt, {}, oc(p, cfg));
	assert.equal((again.details as { skipped: boolean }).skipped, false, "a failed build leaves no stamp");
});

test("LN9/LN10: concurrent first calls share one server; dispose leaves no process behind", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	await Promise.all([
		goalOp(rt, { path: "Fixture/Use.lean", line: 9 }, oc(p, cfg)),
		diagnosticsOp(rt, { path: "Fixture/Use.lean" }, oc(p, cfg)),
		diagnosticsOp(rt, { path: "Fixture/Basic.lean" }, oc(p, cfg)),
		navOp(rt, { op: "outline", path: "Fixture/Use.lean" }, oc(p, cfg)),
		attemptOp(rt, { op: "code", code: "#eval 1\n" }, oc(p, cfg)),
	]);
	const s = rt.status();
	assert.equal(s.starts, 1, "one server for five first calls");
	const pid = s.server!.pid;
	const family = descendants(pid);
	assert.ok(family.length >= 2);
	await rt.dispose();
	assert.equal(groupAlive(pid), false);
	assert.deepEqual(family.filter(pidAlive), [], "a lean process outlived dispose");
});

test("LN11: a killed worker is reported and its file reopened on the next call", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	await diagnosticsOp(rt, { path: "Fixture/Use.lean" }, oc(p, cfg));
	const server = rt.running()!;
	const worker = descendants(server.pid).find((pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("--worker"));
	assert.ok(worker, "no worker found");
	process.kill(worker, "SIGKILL");
	await new Promise((r) => setTimeout(r, 500));
	let r: Awaited<ReturnType<typeof goalOp>> | null = null;
	for (let i = 0; i < 3 && !r; i++) {
		try {
			r = await goalOp(rt, { path: "Fixture/Use.lean", line: 9 }, oc(p, cfg));
		} catch (err) {
			assert.match((err as Error).message, /crashed|worker/i);
		}
	}
	assert.ok(r, "the file never recovered");
	assert.equal(r.details.before?.status, "goals");
	assert.equal(rt.status().starts, 1, "a worker crash is not a server restart");
});

test("LN12: a killed server is restarted on the next call, which says so", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	await diagnosticsOp(rt, { path: "Fixture/Use.lean" }, oc(p, cfg));
	process.kill(-rt.running()!.pid, "SIGKILL");
	await new Promise((r) => setTimeout(r, 500));
	const r = await diagnosticsOp(rt, { path: "Fixture/Use.lean" }, oc(p, cfg));
	assert.match(r.text, /exited unexpectedly.*restarted/s);
	assert.equal(rt.status().starts, 2);
});

test("LN13: local search finds project declarations, qualified, and Lean core's", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const o = oc(p, cfg);
	assert.ok(o.rg, "ripgrep is part of the host toolchain: make lean-install");
	const lim = new RateLimiter();
	const mine = await searchOp(rt, { source: "local", query: "use_double" }, o, lim);
	assert.match(mine.text, /- Fixture\.use_double {2}\(theorem, Fixture\/Use\.lean:5\)/);
	const core = await searchOp(rt, { source: "local", query: "Nat.add_comm", limit: 3 }, o, lim);
	assert.match(core.text, /- Nat\.add_comm {2}\(theorem, <stdlib>\//);
	await diagnosticsOp(rt, { path: "Fixture/Use.lean" }, o);
	const indexed = await searchOp(rt, { source: "local", query: "double" }, o, lim);
	assert.equal((indexed.details as { index: string }).index, "consulted");
});

test("LN14/LN15: profile a theorem; find the hypothesis it does not need", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const prof = await profileOp(rt, { path: "Fixture/Use.lean", line: 11 }, oc(p, cfg));
	assert.match(prof.text, /extra_hyp elaborates in \d+ ms/);
	assert.equal(existsSync(p.path(".lake/pi-lean4")) && readFileSync(p.path("Fixture/Use.lean"), "utf8") === USE, true);
	const hyp = await hypothesesOp(rt, { path: "Fixture/Use.lean", name: "extra_hyp" }, oc(p, cfg));
	const v = Object.fromEntries((hyp.details as { verdicts: { binder: string; status: string }[] }).verdicts.map((x) => [x.binder, x.status]));
	assert.deepEqual(v, { "(n : Nat)": "load-bearing", "(h : 0 < n)": "removable", "(k : Nat)": "load-bearing" });
});

test("LN16: code actions carry Lean's suggestion, unapplied", async (t) => {
	const p = project(t, { "Fixture/Basic.lean": BASIC, "Fixture/Sugg.lean": "import Fixture.Basic\ntheorem s (n : Nat) : double n = 2 * n := by\n  exact?\n" });
	const { rt, cfg } = runtime(t);
	const r = await navOp(rt, { op: "code_actions", path: "Fixture/Sugg.lean", line: 3 }, oc(p, cfg));
	const actions = (r.details as { actions: { title: string; edits: { newText: string }[] }[] }).actions;
	assert.ok(actions.some((a) => a.edits.some((e) => /double_eq/.test(e.newText))), r.text);
	assert.match(readFileSync(p.path("Fixture/Sugg.lean"), "utf8"), /exact\?/);
});

test("LN17: hover, definition, references and outline", async (t) => {
	const p = project(t);
	p.build();
	const { rt, cfg } = runtime(t);
	const o = oc(p, cfg);
	assert.match((await navOp(rt, { op: "hover", path: "Fixture/Use.lean", symbol: "double" }, o)).text, /double \(n : Nat\) : Nat/);
	const def = await navOp(rt, { op: "definition", path: "Fixture/Use.lean", symbol: "double" }, o);
	assert.match(def.text, /Fixture\/Basic\.lean:1:5/);
	const refs = await navOp(rt, { op: "references", path: "Fixture/Use.lean", symbol: "double" }, o);
	assert.ok((refs.details as { total: number }).total >= 3, refs.text);
	const outline = await navOp(rt, { op: "outline", path: "Fixture/Use.lean" }, o);
	assert.match(outline.text, /imports: Fixture\.Basic/);
	assert.match(outline.text, /theorem extra_hyp \(n : Nat\) \(h : 0 < n\) \(k : Nat\) : n \+ k = k \+ n/);
	const sorries = sorriesOp({}, o);
	assert.equal(sorries.details.total, 1);
});
