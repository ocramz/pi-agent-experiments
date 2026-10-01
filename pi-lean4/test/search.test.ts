// lean_search without a network or ripgrep: request shapes and response
// parsing through an injected fetch, the rate limiter, and the local search's
// rg-JSON parsing, namespace re-qualification and ranking.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { LeanRuntime } from "../src/lean/runtime.ts";
import { indexHits, isCompilerHelper, merge, namespacesAt, parseRgJson, qualifyAndRank, rgPattern } from "../src/ops/search/local.ts";
import { RateLimiter } from "../src/ops/search/ratelimit.ts";
import { leanfinder, leansearch, loogle, premises } from "../src/ops/search/remote.ts";
import { searchOp } from "../src/ops/search/search.ts";

type Call = { url: string; init?: RequestInit };

function fakeFetch(body: unknown, calls: Call[] = [], status = 200): typeof fetch {
	return (async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init });
		return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
	}) as typeof fetch;
}

test("Q1: leansearch posts {num_results: string, query: [q]} and joins name parts", async () => {
	const calls: Call[] = [];
	const hits = await leansearch(
		"sum of evens",
		2,
		fakeFetch([[{ result: { name: ["Even", "add"], module_name: ["Mathlib", "Algebra", "Group", "Even"], kind: "theorem", type: "Even m → Even n → Even (m + n)" } }]], calls),
	);
	assert.equal(calls[0].url, "https://leansearch.net/search");
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { num_results: "2", query: ["sum of evens"] });
	assert.deepEqual(hits, [{ name: "Even.add", module: "Mathlib.Algebra.Group.Even", kind: "theorem", type: "Even m → Even n → Even (m + n)" }]);
});

test("Q2: loogle GETs /json?q= and turns a query error into a tool error with suggestions", async () => {
	const calls: Call[] = [];
	const hits = await loogle("Real.sin", 5, fakeFetch({ hits: [{ name: "Real.sin_le_one", type: "∀ x, sin x ≤ 1", module: "Mathlib.X" }] }, calls));
	assert.equal(calls[0].url, "https://loogle.lean-lang.org/json?q=Real.sin");
	assert.equal(hits[0].name, "Real.sin_le_one");
	await assert.rejects(loogle("(", 5, fakeFetch({ error: "parse error", suggestions: ["Real.sin"] })), /parse error.*Suggestions: Real\.sin/);
});

test("Q3: leanfinder posts inputs/top_k/version; paths become modules", async () => {
	const calls: Call[] = [];
	const hits = await leanfinder(
		"commutativity",
		3,
		"v4.28.0",
		fakeFetch({ results: [{ formal_name: "Nat.add_comm", informal_name: "comm", kind: "theorem", type: "a + b = b + a", informal_description: "swap", path: "Init/Nat" }] }, calls),
	);
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { inputs: "commutativity", top_k: 3, version: "v4.28.0" });
	assert.equal(hits[0].module, "Init.Nat");
	assert.match(hits[0].description ?? "", /comm: swap/);
});

test("Q4: premises posts the goal state to /retrieve", async () => {
	const calls: Call[] = [];
	const hits = await premises("⊢ a + b = b + a", 4, fakeFetch([{ name: "Nat.add_comm" }], calls));
	assert.equal(calls[0].url, "http://leanpremise.net/retrieve");
	assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { state: "⊢ a + b = b + a", new_premises: [], k: 4 });
	assert.deepEqual(hits, [{ name: "Nat.add_comm" }]);
});

test("Q5: HTTP failures and non-JSON answers are tool errors that name the host", async () => {
	await assert.rejects(leansearch("x", 1, fakeFetch({}, [], 503)), /leansearch\.net answered HTTP 503/);
	const notJson = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
	await assert.rejects(loogle("x", 1, notJson), /not JSON/);
	const down = (async () => {
		throw new Error("ECONNREFUSED");
	}) as unknown as typeof fetch;
	await assert.rejects(premises("g", 1, down), /could not reach leanpremise\.net: ECONNREFUSED/);
});

test("Q6: offline mode refuses every remote source before any fetch", async () => {
	const calls: Call[] = [];
	const rt = new LeanRuntime({ config: () => ({ ...DEFAULTS, offline: true }), clientVersion: "t" });
	for (const source of ["leansearch", "loogle", "leanfinder"] as const) {
		await assert.rejects(
			searchOp(rt, { source, query: "x" }, { cwd: tmpdir(), cfg: { ...DEFAULTS, offline: true }, fetch: fakeFetch([], calls) }, new RateLimiter()),
			/offline mode is on/,
		);
	}
	assert.equal(calls.length, 0);
	await rt.dispose();
});

test("Q7: the rate limit is a sliding window, and a custom URL is not limited", async () => {
	let now = 0;
	const lim = new RateLimiter(() => now);
	for (let i = 0; i < 3; i++) assert.equal(lim.take("loogle").ok, true);
	const fourth = lim.take("loogle");
	assert.equal(fourth.ok, false);
	assert.equal(!fourth.ok && fourth.retryAfterMs, 30_000);
	now = 29_999;
	assert.equal(lim.take("loogle").ok, false);
	now = 30_000;
	assert.equal(lim.take("loogle").ok, true, "the oldest hit has left the window");

	const rt = new LeanRuntime({ config: () => DEFAULTS, clientVersion: "t" });
	const used = new RateLimiter(() => 0);
	for (let i = 0; i < 3; i++) used.take("loogle");
	const oc = { cwd: tmpdir(), cfg: DEFAULTS, fetch: fakeFetch({ hits: [] }) };
	await assert.rejects(searchOp(rt, { source: "loogle", query: "x" }, oc, used), /rate-limited to 3 requests per 30s.*never|Do not loop/s);
	const custom = { ...oc, cfg: { ...DEFAULTS, search: { loogleUrl: "http://localhost:8088" } } };
	const r = await searchOp(rt, { source: "loogle", query: "x" }, custom, used);
	assert.match(r.text, /no results/);
	await rt.dispose();
});

test("Q8: the rg pattern searches the last name component, with modifiers allowed", () => {
	const re = new RegExp(rgPattern("Foo.bar_baz"), "u");
	assert.ok(re.test("@[simp] protected theorem bar_baz_comm (x : Nat) : x = x"));
	assert.ok(re.test("theorem Foo.bar_baz"));
	assert.ok(!re.test("-- theorem bar"));
});

test("Q9: rg JSON → hits, re-qualified by namespace, filtered for a qualified query, ranked", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-lean4-search-"));
	try {
		const a = join(root, "A.lean");
		writeFileSync(a, "namespace Foo\nsection\ntheorem bar_le : True := trivial\nend\ntheorem bar : True := trivial\nend Foo\ntheorem bar_other : True := trivial\n");
		const dep = join(root, ".lake", "packages", "m", "M.lean");
		const ev = (path: string, line: number, text: string) => JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text }, line_number: line } });
		const out = [
			JSON.stringify({ type: "begin", data: {} }),
			ev(a, 3, "theorem bar_le : True := trivial\n"),
			ev(a, 5, "theorem bar : True := trivial\n"),
			ev(a, 7, "theorem bar_other : True := trivial\n"),
			ev(dep, 1, "lemma bar : 1 = 1 := rfl\n"),
			ev("/elsewhere/X.lean", 1, "theorem bar : True := trivial\n"),
		].join("\n");
		const parsed = parseRgJson(out, root, null);
		assert.equal(parsed.length, 4, "files outside the project and stdlib are dropped");
		const ranked = qualifyAndRank(parsed, "bar", 10);
		assert.deepEqual(
			ranked.map((h) => h.name),
			["Foo.bar", "bar", "Foo.bar_le", "bar_other"],
		);
		assert.equal(ranked[1].file, join(".lake", "packages", "m", "M.lean"), "packages rank after the project");
		assert.deepEqual(
			qualifyAndRank(parsed, "Foo.bar", 10).map((h) => h.name),
			["Foo.bar", "Foo.bar_le"],
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("Q10: namespaces: sections and mutual blocks add nothing; end pops", () => {
	const text = "namespace A.B\nsection S\nmutual\nend\nend S\ntheorem x := 1\nend A.B\ntheorem y := 1\n";
	const ns = namespacesAt(text, new Set([6, 8]));
	assert.equal(ns.get(6), "A.B");
	assert.equal(ns.get(8), "");
});

test("Q11: index symbols merge in, compiler helpers do not (unless asked for by name)", () => {
	const root = "/p";
	const sym = (name: string, file = "/p/A.lean") => ({ name, kind: 12, location: { uri: `file://${file}`, range: { start: { line: 4, character: 0 }, end: { line: 4, character: 1 } } } });
	const helper = "_private.Foo.0._aux_Foo___macroRules_x_1";
	assert.ok(isCompilerHelper(helper));
	assert.ok(isCompilerHelper("foo._@.Mod._hygCtx._hyg.12"));
	const idx = indexHits([sym("Finset.sum_range_succ"), sym(helper), sym("Elsewhere.x", "/other/B.lean")], root, null, "sum_range_succ");
	assert.deepEqual(
		idx.map((h) => h.name),
		["Finset.sum_range_succ"],
	);
	const merged = merge([{ name: "Finset.sum_range_succ_mul", kind: "theorem", file: "A.lean", source: "text" }], idx, "sum_range_succ", 5);
	assert.deepEqual(
		merged.map((h) => h.name),
		["Finset.sum_range_succ", "Finset.sum_range_succ_mul"],
	);
});
