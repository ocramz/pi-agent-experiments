// What pi-lean4 assumes about the pinned Lean server, asserted against it.
//
// Every design decision in src/lean/server.ts that depends on Lean's behaviour
// rather than on the LSP spec is pinned here, with the raw connection and no
// LeanServer in between. When shared/versions.env moves the toolchain, this
// file is what says whether those assumptions still hold.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { type GroupHandle, descendants, killGroup, pidAlive, spawnGroup } from "../../src/lean/process.ts";
import { OUT_OF_DATE } from "../../src/lean/server.ts";
import { LspConnection } from "../../src/lsp/connection.ts";
import { type Diagnostic, buildInitializeParams } from "../../src/lsp/protocol.ts";
import { BASIC, project, requireLean } from "./fixture.ts";

interface Raw {
	conn: LspConnection;
	pid: number;
	handle: GroupHandle;
	publishes: { uri: string; version?: number; diagnostics: Diagnostic[] }[];
	notifications: string[];
	init: { capabilities: Record<string, unknown> };
	uri(rel: string): string;
	open(rel: string, mode: "never" | "once", version?: number, text?: string): Promise<Diagnostic[]>;
	last(rel: string): Diagnostic[];
}

async function raw(t: TestContext, root: string): Promise<Raw> {
	const { lake } = requireLean();
	const h = spawnGroup(lake, ["serve"], { cwd: root });
	const publishes: Raw["publishes"] = [];
	const notifications: string[] = [];
	const conn = new LspConnection({
		input: h.child.stdout!,
		output: h.child.stdin!,
		onNotification: (m, p) => {
			notifications.push(m);
			if (m === "textDocument/publishDiagnostics") publishes.push(p as Raw["publishes"][number]);
		},
		defaultTimeoutMs: 120_000,
	});
	t.after(() => killGroup(h, { graceMs: 500 }));
	const uri = (rel: string) => pathToFileURL(join(root, rel)).href;
	const init = await conn.request<Raw["init"]>("initialize", buildInitializeParams({ root, rootUri: pathToFileURL(root).href, name: "contract", version: "0" }));
	conn.notify("initialized", {});
	const last = (rel: string) => {
		const mine = publishes.filter((p) => p.uri === uri(rel));
		return mine.length ? mine[mine.length - 1].diagnostics : [];
	};
	return {
		conn,
		pid: h.pid,
		handle: h,
		publishes,
		notifications,
		init,
		uri,
		last,
		async open(rel, mode, version = 1, text) {
			conn.notify("textDocument/didOpen", {
				textDocument: { uri: uri(rel), languageId: "lean4", version, text: text ?? readFileSync(join(root, rel), "utf8") },
				dependencyBuildMode: mode,
			});
			await conn.request("textDocument/waitForDiagnostics", { uri: uri(rel), version });
			return last(rel);
		},
	};
}

test("K1: initialize advertises what the tools use, in UTF-16 positions", async (t) => {
	const p = project(t);
	const r = await raw(t, p.root);
	const caps = r.init.capabilities;
	for (const k of ["hoverProvider", "completionProvider", "definitionProvider", "referencesProvider", "codeActionProvider", "documentSymbolProvider", "workspaceSymbolProvider"]) {
		assert.ok(caps[k], `server lacks ${k}`);
	}
	assert.ok(caps.positionEncoding === undefined || caps.positionEncoding === "utf-16", `positionEncoding ${String(caps.positionEncoding)}`);
});

test("K2: waitForDiagnostics answers after the version's final publish", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	const final = await r.open("Fixture/Use.lean", "never");
	assert.ok(final.some((d) => /declaration uses `sorry`/.test(d.message)), JSON.stringify(final));
	const count = r.publishes.length;
	await new Promise((res) => setTimeout(res, 500));
	const later = r.publishes.slice(count).filter((x) => x.uri === r.uri("Fixture/Use.lean") && x.version === 1);
	assert.deepEqual(later, [], "nothing more was published for that version after the barrier");
});

test("K3: with 'never', an unbuilt import says it must be rebuilt — the exact text the client matches", async (t) => {
	const p = project(t);
	const r = await raw(t, p.root);
	const d = await r.open("Fixture/Use.lean", "never");
	const hit = d.find((x) => OUT_OF_DATE.test(x.message));
	assert.ok(hit, `no out-of-date message in ${JSON.stringify(d.map((x) => x.message))}`);
	assert.equal(OUT_OF_DATE.exec(hit.message)?.[1], "must");
	assert.equal(hit.severity, 1);
	assert.equal(hit.range.start.line, 0);
	assert.equal(existsSync(p.path(".lake/build/lib/lean/Fixture/Basic.olean")), false, "'never' built nothing");
});

test("K4: 'once' builds exactly the file's imports, not the rest of the project", async (t) => {
	const p = project(t, { "Fixture/Basic.lean": BASIC, "Fixture/Use.lean": "import Fixture.Basic\ntheorem u : double 1 = 2 := rfl\n", "Fixture/Other.lean": "def other := 1\n" });
	const r = await raw(t, p.root);
	const d = await r.open("Fixture/Use.lean", "once");
	assert.ok(!d.some((x) => OUT_OF_DATE.test(x.message)), JSON.stringify(d));
	assert.ok(existsSync(p.path(".lake/build/lib/lean/Fixture/Basic.olean")));
	assert.equal(existsSync(p.path(".lake/build/lib/lean/Fixture/Other.olean")), false);
});

test("K5: an *open* import that changes tags its open dependents 'should be rebuilt'", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	await r.open("Fixture/Use.lean", "never");
	await r.open("Fixture/Basic.lean", "never");
	// As the client does it: the file changes on disk, then didChange + didSave.
	const text = `${BASIC}\ntheorem extra : True := trivial\n`;
	p.write("Fixture/Basic.lean", text);
	r.conn.notify("textDocument/didChange", { textDocument: { uri: r.uri("Fixture/Basic.lean"), version: 2 }, contentChanges: [{ text }] });
	r.conn.notify("textDocument/didSave", { textDocument: { uri: r.uri("Fixture/Basic.lean") }, text });
	await r.conn.request("textDocument/waitForDiagnostics", { uri: r.uri("Fixture/Basic.lean"), version: 2 });
	let tagged: Diagnostic | undefined;
	for (let i = 0; i < 50 && !tagged; i++) {
		tagged = r.last("Fixture/Use.lean").find((x) => OUT_OF_DATE.test(x.message));
		if (!tagged) await new Promise((res) => setTimeout(res, 100));
	}
	assert.ok(tagged, "the dependent was not tagged");
	assert.equal(OUT_OF_DATE.exec(tagged.message)?.[1], "should");
});

test("K6: an *unopened* import changing on disk tells an open dependent nothing — why the client fingerprints the closure", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	await r.open("Fixture/Use.lean", "never");
	const before = r.publishes.length;
	// pi-lean4 sends no workspace/didChangeWatchedFiles (it runs no file
	// watcher), so neither does this: the edit just happens on disk.
	p.write("Fixture/Basic.lean", `${BASIC}\ntheorem extra : True := trivial\n`);
	await new Promise((res) => setTimeout(res, 2000));
	const after = r.publishes.slice(before).filter((x) => x.uri === r.uri("Fixture/Use.lean"));
	assert.ok(!after.some((x) => x.diagnostics.some((d) => OUT_OF_DATE.test(d.message))), "the server noticed after all — the closure fingerprint may be redundant now");
	assert.ok(!r.notifications.includes("$/lean/staleDependency"));
});

test("K7: a scratch URI for a file that does not exist elaborates, imports and all", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	const text = "import Fixture.Basic\ntheorem s : double 2 = 4 := by decide\n#print axioms s\n";
	const d = await r.open("_PiLean4Scratch0.lean", "never", 1, text);
	assert.equal(existsSync(p.path("_PiLean4Scratch0.lean")), false);
	assert.ok(!d.some((x) => x.severity === 1), JSON.stringify(d));
	assert.ok(d.some((x) => /'s' (does not depend on any axioms|depends on axioms)/.test(x.message)), JSON.stringify(d));
});

test("K8: goals and term goals have the shapes the tools parse; a suggestion's code action answers on its range", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	await r.open("Fixture/Use.lean", "never");
	const td = { uri: r.uri("Fixture/Use.lean") };
	const g = await r.conn.request<{ goals: string[]; rendered: string }>("$/lean/plainGoal", { textDocument: td, position: { line: 8, character: 2 } });
	assert.deepEqual(g.goals, ["a b : Nat\n⊢ a + b = b + a"]);
	const none = await r.conn.request<{ goals: string[] } | null>("$/lean/plainGoal", { textDocument: td, position: { line: 0, character: 0 } });
	assert.equal(none, null, "outside a proof: null, not an empty list");
	const tg = await r.conn.request<{ goal: string }>("$/lean/plainTermGoal", { textDocument: td, position: { line: 4, character: 31 } });
	assert.match(tg.goal, /⊢ Nat/);
	const text = "example : 2 = 2 := by exact?\n";
	const d = await r.open("_PiLean4Scratch0.lean", "never", 1, text);
	const suggestion = d.find((x) => /Try this/.test(x.message));
	assert.ok(suggestion, JSON.stringify(d));
	const scratch = { uri: r.uri("_PiLean4Scratch0.lean") };
	const actions = await r.conn.request<{ title: string; edit?: unknown }[]>("textDocument/codeAction", {
		textDocument: scratch,
		range: suggestion.fullRange ?? suggestion.range,
		context: { diagnostics: [suggestion], triggerKind: 1 },
	});
	assert.ok(actions.length > 0, "no code action on the suggestion's own range");
});

test("K9: workers run in their own process groups, and everything exits when the server's stdin closes", async (t) => {
	const p = project(t);
	p.build();
	const r = await raw(t, p.root);
	await r.open("Fixture/Use.lean", "never");
	const family = descendants(r.pid);
	assert.ok(family.length >= 2, `expected lean --server and a worker under lake, got ${family}`);
	const pgid = (pid: number) => {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);
	};
	assert.ok(family.some((pid) => pgid(pid) !== r.pid), "every worker shares lake's group — a group kill alone would now suffice");
	// What happens when pi dies hard: its end of the pipe closes.
	r.handle.child.stdin!.end();
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline && [r.pid, ...family].some(pidAlive)) await new Promise((res) => setTimeout(res, 100));
	assert.deepEqual([r.pid, ...family].filter(pidAlive), [], "processes outlived stdin EOF by 5s");
});
