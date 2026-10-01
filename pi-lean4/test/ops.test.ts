// The parts of each op that are plain text processing: no server, no Lean.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { golfCandidates } from "../src/ops/analyze/golf.ts";
import { dropBinder, explicitHypotheses, theoremBinders, withoutAutoImplicit } from "../src/ops/analyze/hypotheses.ts";
import { extractTheorem, lineTimes, parseProfile } from "../src/ops/analyze/profile.ts";
import { buildAttemptText, identity, shiftedIdentity } from "../src/ops/attempt.ts";
import { fingerprint, keepLine, loadStamp, progressOf, saveStamp } from "../src/ops/build.ts";
import { codeLines, declarationAt, declarations } from "../src/ops/decls.ts";
import { categorize, failedDependencyPaths, findDeclaration, hintFor, toItems } from "../src/ops/diagnostics.ts";
import { firstNonSpace } from "../src/ops/goals.ts";
import { findSymbol } from "../src/ops/nav.ts";
import { findSorries, scanSorries } from "../src/ops/sorries.ts";
import { classifyAxioms, parseAxiomMessage, scanSource } from "../src/ops/verify.ts";
import { autocheckSummary } from "../src/hooks/autocheck.ts";
import { boundText } from "../src/format.ts";
import type { Diagnostic } from "../src/lsp/protocol.ts";

const diag = (line: number, ch: number, severity: 1 | 2 | 3 | 4, message: string): Diagnostic => ({
	range: { start: { line, character: ch }, end: { line, character: ch + 1 } },
	severity,
	message,
});

test("D1: categories", () => {
	assert.equal(categorize("warning", "declaration uses `sorry`"), "sorry");
	assert.equal(categorize("warning", "declaration uses 'sorry'"), "sorry");
	assert.equal(categorize("info", "Try this: exact foo"), "suggestion");
	assert.equal(categorize("warning", "unused variable `h`\nnote: this linter can be disabled with ..."), "linter");
	assert.equal(categorize("error", "unused variable `h`"), "diagnostic", "only warnings are linter noise");
	assert.equal(categorize("error", "type mismatch"), "diagnostic");
});

test("D2: hints for failures whose message names no remedy", () => {
	assert.match(hintFor("error", "failed to synthesize instance of type class\n  DecidableEq α") ?? "", /classical/);
	assert.match(hintFor("error", "invalid binder annotation, type is not a class instance\n  ?m.12 x") ?? "", /unresolved/);
	assert.equal(hintFor("error", "invalid binder annotation, type is not a class instance\n  Foo x"), undefined);
	assert.equal(hintFor("warning", "deterministic timeout"), undefined);
	assert.match(hintFor("error", "(deterministic) timeout at whnf, maximum number of heartbeats") ?? "x", /x|heartbeat/);
});

test("D3: items are 1-indexed codepoint positions, sorted, exact repeats dropped", () => {
	const lines = ["theorem t (x : 𝔽) : x = x := boom", ""];
	const col = lines[0].indexOf("boom"); // UTF-16
	const raw = [diag(0, col, 1, "unknown identifier 'boom'"), diag(0, col, 1, "unknown identifier 'boom'"), diag(0, 0, 2, "declaration uses `sorry`")];
	const { items } = toItems(raw, lines, 1000);
	assert.equal(items.length, 2);
	assert.equal(items[0].column, 1);
	assert.equal(items[1].column, [...lines[0].slice(0, col)].length + 1, "𝔽 counts as one column");
	assert.equal(items[1].severity, "error");
});

test("D4: lake's build stderr at 1:1 becomes failed dependencies, not an item", () => {
	const stderr = "error: ./Foo/Bar.lean:3:4: unknown identifier\nerror: Foo/Baz.lean:1:1: oops\n";
	const { items, failedDependencies } = toItems([diag(0, 0, 1, stderr)], [""], 1000);
	assert.equal(items.length, 0);
	assert.deepEqual(failedDependencies, ["./Foo/Bar.lean", "Foo/Baz.lean"]);
	assert.deepEqual(failedDependencyPaths("nothing here"), []);
});

test("D5: bounding cuts the middle and keeps the goal's target", () => {
	const goal = `${"h : very long hypothesis\n".repeat(200)}⊢ the target`;
	const b = boundText(goal, 300);
	assert.ok(b.length < goal.length);
	assert.match(b, /⊢ the target$/);
	assert.match(b, /characters elided/);
	assert.equal(boundText("short", 300), "short");
	assert.equal(boundText(goal, 0), goal, "0 disables the bound");
});

test("D6: declarations are found in a documentSymbol tree by name or qualified name", () => {
	const r = { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } };
	const tree = [{ name: "Foo", kind: 3, range: r, selectionRange: r, children: [{ name: "bar", kind: 6, range: r, selectionRange: r }] }];
	assert.equal(findDeclaration(tree, "bar")?.name, "bar");
	assert.equal(findDeclaration(tree, "Foo.bar")?.name, "bar");
	assert.equal(findDeclaration(tree, "baz"), null);
});

test("A1: an attempt replaces from the column to the end of the line", () => {
	const lines = ["theorem t : 1 = 1 := by", "  skip", "  sorry", ""];
	const a = buildAttemptText(lines, lines[2], 2, "rfl", 3);
	assert.equal(a.text, "theorem t : 1 = 1 := by\n  skip\n  rfl\n\n");
	assert.equal(a.goalLine, 2);
	assert.equal(a.goalColumn, 5);
	assert.equal(a.lineDelta, 0);
});

test("A2: a multi-line snippet replaces as many lines, indented to the column", () => {
	const lines = ["example : True ∧ True := by", "  sorry", "  done", ""];
	const a = buildAttemptText(lines, lines[1], 2, "constructor\n· trivial\n· trivial", 2);
	assert.equal(a.text, "example : True ∧ True := by\n  constructor\n  · trivial\n  · trivial\n");
	assert.equal(a.lineDelta, 0, "three lines replaced three");
	assert.equal(a.goalLine, 3);
	const b = buildAttemptText(["a", "  x", "b"], "  x", 2, "y\nz", 2);
	assert.equal(b.text, "a\n  y\n  z\n");
	assert.equal(b.lineDelta, 0);
	const c = buildAttemptText(["a", "  x"], "  x", 2, "y\nz\nw", 2);
	assert.equal(c.lineDelta, 2, "past the end of the file the splice grows it");
});

test("A3: the baseline shifts by the splice's delta below the edit, not above", () => {
	const above = diag(1, 0, 1, "e");
	const below = diag(9, 0, 1, "e");
	assert.equal(shiftedIdentity(above, 5, 2), identity(above));
	assert.equal(shiftedIdentity(below, 5, 2), identity(diag(11, 0, 1, "e")));
});

test("A4: the default column is the first non-space character", () => {
	assert.equal(firstNonSpace("    omega"), 5);
	assert.equal(firstNonSpace(""), 1);
	assert.equal(firstNonSpace("  · 𝔽"), 3);
});

const SRC = `import Mathlib
/- a block comment with sorry
   and /- nested -/ sorry -/
namespace Foo

-- sorry in a line comment
theorem one : 1 = 1 := by
  sorry

@[simp] protected lemma two (n : Nat) : n = n := by simp

def str : String := "sorry"

section
variable (x : Nat)
theorem three : x = x := sorry
end

theorem _root_.Top.four : True := by
  sorry_lemma
  exact sorry
end Foo

theorem five : True := trivial
`;

test("X1: comments and strings are blanked, offsets kept", () => {
	const code = codeLines(SRC);
	assert.equal(code.length, SRC.split("\n").length);
	assert.ok(!code[1].includes("sorry") && !code[2].includes("sorry"));
	assert.ok(!code[11].includes("sorry"));
	assert.equal(code[7].indexOf("sorry"), SRC.split("\n")[7].indexOf("sorry"));
});

test("X2: declarations carry namespaces, _root_ and their extent", () => {
	const d = declarations(SRC);
	assert.deepEqual(
		d.map((x) => [x.keyword, x.qualified, x.line]),
		[
			["theorem", "Foo.one", 7],
			["lemma", "Foo.two", 10],
			["def", "Foo.str", 12],
			["theorem", "Foo.three", 16],
			["theorem", "Top.four", 19],
			["theorem", "five", 24],
		],
	);
	assert.equal(declarationAt(d, 8)?.qualified, "Foo.one");
	assert.equal(declarationAt(d, 14), null, "a section header is not inside a declaration");
});

test("X3: every real sorry, attributed; sorry_lemma and comments are not", () => {
	const hits = findSorries(SRC);
	assert.deepEqual(
		hits.map((h) => [h.line, h.column, h.declaration]),
		[
			[8, 3, "theorem Foo.one"],
			[16, 26, "theorem Foo.three"],
			[21, 9, "theorem Top.four"],
		],
	);
});

test("X4: a tree scan skips .lake and scratch files", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-sorries-"));
	try {
		mkdirSync(join(root, ".lake", "packages", "dep"), { recursive: true });
		mkdirSync(join(root, "A"), { recursive: true });
		writeFileSync(join(root, "A", "B.lean"), "theorem b : True := sorry\n");
		writeFileSync(join(root, "C.lean"), "theorem c : True := trivial\n");
		writeFileSync(join(root, ".lake", "packages", "dep", "D.lean"), "theorem d : True := sorry\n");
		writeFileSync(join(root, "_PiLean4Scratch0.lean"), "theorem s : True := sorry\n");
		const r = scanSorries(root, root);
		assert.equal(r.filesScanned, 2);
		assert.equal(r.total, 1);
		assert.equal(r.files[0].path, join("A", "B.lean"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("V1: #print axioms messages, one line or wrapped", () => {
	assert.deepEqual(parseAxiomMessage("'t3' does not depend on any axioms"), []);
	assert.deepEqual(parseAxiomMessage("'Foo.bar' depends on axioms: [propext,\n Classical.choice,\n Quot.sound]"), ["propext", "Classical.choice", "Quot.sound"]);
	assert.equal(parseAxiomMessage("something else"), null);
});

test("V2: trust is the worst axiom present", () => {
	assert.equal(classifyAxioms(["propext", "Quot.sound"]).trust, "standard");
	assert.equal(classifyAxioms([]).trust, "standard");
	assert.equal(classifyAxioms(["propext", "sorryAx", "Lean.ofReduceBool"]).trust, "incomplete");
	assert.equal(classifyAxioms(["Lean.ofReduceBool"]).trust, "native");
	assert.equal(classifyAxioms(["Foo._native.native_decide.ax_1_3"]).trust, "native");
	assert.deepEqual(classifyAxioms(["propext", "myAxiom"]), { trust: "custom", nonStandard: ["myAxiom"] });
});

test("V3: the source scan finds soundness-relevant constructs, not comments about them", () => {
	const w = scanSource("-- unsafe in a comment\nunsafe def f := 1\nlocal instance : Foo := ⟨⟩\naxiom cheat : False\n@[implemented_by g] def h := 0\n");
	assert.deepEqual(
		w.map((x) => [x.line, x.pattern]),
		[
			[2, "unsafe"],
			[3, "local instance"],
			[4, "axiom declaration"],
			[5, "@[implemented_by]"],
		],
	);
});

test("B1: the build fingerprint moves with sources and lake files, not with .lake", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-fp-"));
	try {
		writeFileSync(join(root, "lakefile.toml"), 'name = "x"\n');
		writeFileSync(join(root, "A.lean"), "def a := 1\n");
		const f0 = fingerprint(root);
		assert.equal(fingerprint(root), f0, "stable");
		mkdirSync(join(root, ".lake", "build"), { recursive: true });
		writeFileSync(join(root, ".lake", "build", "A.olean"), "x");
		assert.equal(fingerprint(root), f0, ".lake does not count");
		const later = new Date(Date.now() + 10_000);
		utimesSync(join(root, "A.lean"), later, later);
		const f1 = fingerprint(root);
		assert.notEqual(f1, f0, "an edit counts");
		writeFileSync(join(root, "lake-manifest.json"), "{}");
		assert.notEqual(fingerprint(root), f1, "the manifest counts");
		assert.equal(loadStamp(root), null);
		saveStamp(root, "abc");
		assert.equal(loadStamp(root), "abc");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("B2: build output filtering and progress", () => {
	assert.equal(keepLine("trace: .> LEAN_PATH=..."), false);
	assert.equal(keepLine("✔ [3/5] Built Foo (206ms)"), true);
	assert.deepEqual(progressOf("✔ [3/5] Built Foo (206ms)"), { done: 3, total: 5, what: "Built Foo" });
	assert.equal(progressOf("Build completed successfully."), null);
});

test("H1: binders up to the colon; explicit hypotheses only", () => {
	const src = "theorem t {α : Type} [inst : Foo α] (n : Nat) (h : 0 < n) ⦃x : α⦄ : n = n := rfl\n";
	const b = theoremBinders(src, "t");
	assert.deepEqual(
		b.map((x) => x.text),
		["{α : Type}", "[inst : Foo α]", "(n : Nat)", "(h : 0 < n)", "⦃x : α⦄"],
	);
	const e = explicitHypotheses(b);
	assert.deepEqual(
		e.map((x) => x.text),
		["(n : Nat)", "(h : 0 < n)"],
	);
	assert.equal(dropBinder(src, e[1]), "theorem t {α : Type} [inst : Foo α] (n : Nat) ⦃x : α⦄ : n = n := rfl\n");
	assert.equal(theoremBinders(src, "missing").length, 0);
});

test("H2: the variant turns autoImplicit off on the declaration's own line", () => {
	const src = "import X\n\ntheorem t (n : Nat) : n = n := rfl\n";
	const v = withoutAutoImplicit(src, "t");
	assert.equal(v.split("\n").length, src.split("\n").length);
	assert.match(v.split("\n")[2], /^set_option autoImplicit false in theorem t/);
});

test("PR1: the profile source is the file up to the end of the theorem", () => {
	const lines = ["import X", "def d := 1", "theorem t : d = 1 := by", "  rfl", "theorem u : True := trivial"];
	const r = extractTheorem(lines, 3);
	assert.equal(r.name, "t");
	assert.equal(r.source, "import X\ndef d := 1\ntheorem t : d = 1 := by\n  rfl\n");
	assert.deepEqual([r.start, r.end], [3, 4]);
	assert.throws(() => extractTheorem(lines, 1), /no theorem/);
});

test("PR2: trace lines map to proof lines", () => {
	const out = [
		"[Elab.definition.value] [0.050000] t",
		"  [Elab.step] [0.030000] ✅️ simp",
		"  [Elab.step] [0.010000] ✅️ ring",
		"cumulative profiling times:",
		"\tsimp 30ms",
		"\ttype checking 1.5s",
	].join("\n");
	const p = parseProfile(out);
	assert.equal(p.traces.length, 3);
	assert.equal(p.cumulative["type checking"], 1500);
	const src = ["theorem t : x := by", "  simp", "  ring"];
	const { times, total } = lineTimes(p.traces, "t", src, 1);
	assert.equal(total, 50);
	assert.deepEqual([...times.entries()], [
		[2, 30],
		[3, 10],
	]);
});

test("GF1-7: each golf detector fires on its pattern", () => {
	const src = [
		"theorem a : True := by",
		"  exact trivial",
		"",
		"theorem b (x : Nat) : x = x := by",
		"  let y := x",
		"  have h : y = x := rfl",
		"  exact h ▸ rfl",
		"",
		"theorem c : 1 ≤ 5 := by",
		"  calc 1 ≤ 2 := by decide",
		"    _ ≤ 3 := by decide",
		"    _ ≤ 4 := by decide",
		"    _ ≤ 5 := by decide",
		"",
		"theorem d : True ∧ True := by",
		"  constructor",
		"  · have : True := trivial",
		"    exact this",
		"  · have : True := trivial",
		"    have : True := this",
		"    exact this",
		"",
		"theorem e : True := by",
		"  have h1 : True := trivial",
		"  have h2 : True := trivial",
		"  have h3 : True := trivial",
		"  have h4 : True := trivial",
		"  have h5 : True := trivial",
		"  exact h5",
		"",
		"theorem f (a b : Nat) (h : a ≤ b) : a ≤ b + 1 := by",
		"  have hb : b ≤ b + 1 := Nat.le_succ b",
		"  calc a ≤ b := h",
		"    _ ≤ b + 1 := hb",
		"",
		"theorem g (p q : Prop) (hp : p) (hq : q) : p ∧ q := by",
		"  apply And.intro",
		"  exact hp",
		"  exact hq",
	].join("\n");
	const found = golfCandidates(src).map((c) => [c.pattern, c.line]);
	for (const [pattern, line] of [
		["by exact wrapper", 1],
		["let + have + exact", 5],
		["calc chain", 10],
		["constructor branches", 16],
		["multiple haves", 24],
		["have-calc single-use", 32],
		["apply-exact chain", 37],
	] as const) {
		assert.ok(
			found.some(([p, l]) => p === pattern && l === line),
			`${pattern} at line ${line} not found in ${JSON.stringify(found)}`,
		);
	}
});

test("N1: a symbol is found as a whole word, not inside another name", () => {
	const lines = ["theorem doubled := double_x", "  exact double"];
	assert.deepEqual(findSymbol(lines, "double"), { line: 2, column: 9 });
	assert.equal(findSymbol(lines, "missing"), null);
	assert.deepEqual(findSymbol(["  Nat.add_comm a b"], "Nat.add_comm"), { line: 1, column: 3 });
});

test("AC1: the auto-check summary is short and says what to do next", () => {
	const err = { severity: "error" as const, line: 3, column: 2, endLine: 3, endColumn: 4, message: "unknown identifier 'x'\nmore", category: "diagnostic" as const };
	const sorry = { severity: "warning" as const, line: 7, column: 1, endLine: 7, endColumn: 2, message: "declaration uses `sorry`", category: "sorry" as const };
	assert.match(autocheckSummary("F.lean", [], { complete: true, timeoutMs: 15000 }), /compiles — no errors, no sorries/);
	const s = autocheckSummary("F.lean", [err, sorry], { complete: true, timeoutMs: 15000 });
	assert.match(s, /1 error\(s\), 1 sorry/);
	assert.match(s, /error 3:2 unknown identifier 'x'$/m);
	assert.match(s, /sorry at line\(s\) 7/);
	assert.match(autocheckSummary("F.lean", [], { complete: false, timeoutMs: 15000 }), /still elaborating after 15s/);
});
