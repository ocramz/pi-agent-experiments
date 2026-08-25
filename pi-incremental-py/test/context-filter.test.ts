import assert from "node:assert/strict";
import { test } from "node:test";
import {
	filterPyContext,
	type ContextMessage,
	type PyDetails,
	type PyPayload,
} from "../src/context-filter.ts";
import { formatResults, type CellResult, type MutatingResponse } from "../src/format.ts";

// Synthetic transcripts. No kernel, no model — the filter is a pure function of
// the messages and where the kernel has got to, which is the whole reason it
// lives in src/ rather than inline in the extension.

let nextId = 0;

/** A tool result carrying a py.* payload, rendered the way the extension renders it. */
function py(payload: PyPayload, stamp: { gen?: number; mut?: number } = {}): ContextMessage {
	const details = { ...payload, gen: stamp.gen ?? 0, mut: stamp.mut ?? 0 } as PyDetails;
	const text =
		details.kind === "py.inspect"
			? "(rendered inspect)"
			: formatResults(details.response) + (details.note ?? "");
	return {
		role: "toolResult",
		toolCallId: `call_${nextId++}`,
		toolName: details.kind === "py.inspect" ? "py_kernel" : "py_cell",
		content: [{ type: "text", text }],
		details,
		isError: false,
		timestamp: 0,
	} as unknown as ContextMessage;
}

function ran(cell: string, value: string, extra: Partial<CellResult> = {}): CellResult {
	return { cell, status: "ran", seconds: 0.001, value, ...extra };
}

function cellsResponse(results: CellResult[], globals?: Record<string, string>): MutatingResponse {
	return { ok: true, results, ...(globals ? { globals } : {}) };
}

function user(text: string): ContextMessage {
	return { role: "user", content: text, timestamp: 0 } as unknown as ContextMessage;
}

/** The text a message would send to the provider. */
function shown(m: ContextMessage): string {
	const c = (m as { content: unknown }).content;
	if (typeof c === "string") return c;
	return (c as { type: string; text?: string }[])
		.map((b) => (b.type === "text" ? (b.text ?? "") : ""))
		.join("");
}

const LIVE = { gen: 0, mut: 0 };

test("a re-run supersedes the earlier value, and keeps the newest", () => {
	const before = py({ kind: "py.cells", response: cellsResponse([ran("c3", "41")]) });
	const after = py({ kind: "py.cells", response: cellsResponse([ran("c3", "42")]) });

	const out = filterPyContext([before, after], LIVE);

	assert.equal(shown(out[0]), "- superseded: c3");
	assert.equal(shown(out[1]), "* c3 ran 1.0ms  42");
});

test("stdout goes with the superseded value", () => {
	const noisy = py({
		kind: "py.cells",
		response: cellsResponse([ran("c3", "None", { output: "a very large dataframe dump\n" })]),
	});
	const after = py({ kind: "py.cells", response: cellsResponse([ran("c3", "42")]) });

	const out = filterPyContext([noisy, after], LIVE);
	assert.ok(!shown(out[0]).includes("dataframe"), shown(out[0]));
});

test("an untouched cell in an older message survives", () => {
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1"), ran("c2", "2")]) });
	const second = py({ kind: "py.cells", response: cellsResponse([ran("c2", "22")]) });

	const out = filterPyContext([first, second], LIVE);
	assert.match(shown(out[0]), /\* c1 ran .* 1$/m);
	assert.match(shown(out[0]), /- superseded: c2/);
});

test("a stateful cell keeps its history but not its stdout", () => {
	const first = py({
		kind: "py.cells",
		response: cellsResponse([ran("c7", "3", { stateful: true, output: "tick\n" })]),
	});
	const second = py({
		kind: "py.cells",
		response: cellsResponse([ran("c7", "4", { stateful: true })]),
	});

	const out = filterPyContext([first, second], LIVE);
	// The accumulator advanced: 3 then 4 is a record, not a stale copy of one truth.
	assert.match(shown(out[0]), /\* c7 ran .* 3$/m);
	assert.ok(!shown(out[0]).includes("tick"), shown(out[0]));
});

test("an error keeps its message once the cell runs clean", () => {
	const failed = py({
		kind: "py.cells",
		response: cellsResponse([
			{ cell: "c3", status: "error", seconds: 0.001, error: "NameError: nope", output: "noise\n" },
		]),
	});
	const fixed = py({ kind: "py.cells", response: cellsResponse([ran("c3", "42")]) });

	const out = filterPyContext([failed, fixed], LIVE);
	// The attempt failed: unlike a value, that cannot be recovered by asking the
	// kernel again, so it stays. Its stdout still goes.
	assert.match(shown(out[0]), /! c3 error .* NameError: nope/);
	assert.ok(!shown(out[0]).includes("noise"), shown(out[0]));
});

test("a cached mention claims nothing — it asserts the older value still holds", () => {
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]) });
	const second = py({
		kind: "py.cells",
		response: cellsResponse([{ cell: "c1", status: "cached", seconds: 0, value: "1" }]),
	});

	const out = filterPyContext([first, second], LIVE);
	// Collapsing here would delete the only copy of c1's value: the newer message
	// renders cached cells as a bare count.
	assert.match(shown(out[0]), /\* c1 ran .* 1$/m);
});

test("a restored mention claims the cell — the value was displaced and came back", () => {
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]) });
	const second = py({
		kind: "py.cells",
		response: cellsResponse([{ cell: "c1", status: "restored", seconds: 0, value: "7" }]),
	});

	const out = filterPyContext([first, second], LIVE);
	// Unlike `cached`, this does not assert the older line still holds: the
	// namespace was rebuilt from a different computation in between, so the
	// older value is stale and the newer message is the one carrying c1.
	assert.equal(shown(out[0]), "- superseded: c1");
	assert.match(shown(out[1]), /\+ c1 restored .* 7$/m);
});

test("a cell re-run on another variant does not supersede it on this one", () => {
	const onMain = py({
		kind: "py.cells",
		response: { ...cellsResponse([ran("c1", "mean")]), variant: "main" },
	});
	const onAlt = py({
		kind: "py.cells",
		response: { ...cellsResponse([ran("c1", "median")]), variant: "median" },
	});

	const out = filterPyContext([onMain, onAlt], LIVE);
	// Both are current, each for its own program. Collapsing across them
	// would delete the value the user forked in order to compare against.
	assert.match(shown(out[0]), /\* c1 ran .* mean$/m);
	assert.match(shown(out[1]), /\* c1 ran .* median$/m);
	assert.match(shown(out[1]), /^variant: median$/m);
});

test("a cell re-run on the same variant still supersedes", () => {
	const first = py({
		kind: "py.cells",
		response: { ...cellsResponse([ran("c1", "1")]), variant: "median" },
	});
	const second = py({
		kind: "py.cells",
		response: { ...cellsResponse([ran("c1", "2")]), variant: "median" },
	});

	const out = filterPyContext([first, second], LIVE);
	assert.match(shown(out[0]), /- superseded: c1/);
});

test("a transcript with no variant on it behaves as it always did", () => {
	// Sessions recorded before variants existed carry no `variant`, so they
	// all scope alike and supersede each other exactly as before.
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]) });
	const second = py({ kind: "py.cells", response: cellsResponse([ran("c1", "2")]) });

	const out = filterPyContext([first, second], LIVE);
	assert.match(shown(out[0]), /- superseded: c1/);
	assert.ok(!shown(out[1]).includes("variant:"), shown(out[1]));
});

test("only the newest message keeps the globals tail", () => {
	const first = py({
		kind: "py.cells",
		response: cellsResponse([ran("c1", "1")], { x: "1" }),
	});
	const second = py({
		kind: "py.cells",
		response: cellsResponse([ran("c2", "2")], { x: "1", y: "2" }),
	});

	const out = filterPyContext([first, second], LIVE);
	assert.ok(!shown(out[0]).includes("globals:"), shown(out[0]));
	assert.match(shown(out[1]), /globals: x=1, y=2/);
});

test("an older inspect collapses whole", () => {
	const older = py({
		kind: "py.inspect",
		response: { ok: true, cells: [{ id: "c1", name: null, defines: ["x"], depends_on: [], stateful: false, failing: false }] },
	});
	const newer = py({
		kind: "py.inspect",
		response: { ok: true, cells: [{ id: "c1", name: null, defines: ["x"], depends_on: [], stateful: false, failing: false }] },
	});

	const out = filterPyContext([older, newer], LIVE);
	assert.equal(shown(out[0]), "- inspect (superseded)");
	assert.match(shown(out[1]), /1 cell:/);
});

test("a kernel restart voids everything before it", () => {
	const old = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")], { x: "1" }) });
	const fresh = py({ kind: "py.cells", response: cellsResponse([ran("c9", "9")]) }, { gen: 1 });

	const out = filterPyContext([old, fresh], { gen: 1, mut: 0 });
	assert.equal(shown(out[0]), "- superseded by a kernel restart (python state lost)");
	assert.match(shown(out[1]), /\* c9 ran/);
});

test("a note survives the re-render", () => {
	const note = "\n\nNOTE: rebuild with run_all.";
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]), note });
	const second = py({ kind: "py.cells", response: cellsResponse([ran("c1", "2")]) });

	const out = filterPyContext([first, second], LIVE);
	assert.ok(shown(out[0]).endsWith(note), shown(out[0]));
});

test("the beacon fires only when a mutation left no message behind", () => {
	const only = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]) }, { mut: 4 });

	const quiet = filterPyContext([only], { gen: 0, mut: 4 });
	assert.ok(!shown(quiet[0]).includes("NOTE:"), shown(quiet[0]));

	// A /py command ran since: state moved with nothing in the transcript to say so.
	const drifted = filterPyContext([only], { gen: 0, mut: 5 });
	assert.match(shown(drifted[0]), /changed outside this transcript/);
});

test("the beacon lands on the newest py message only", () => {
	const first = py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")]) }, { mut: 1 });
	const second = py({ kind: "py.cells", response: cellsResponse([ran("c2", "2")]) }, { mut: 2 });

	const out = filterPyContext([first, second], { gen: 0, mut: 3 });
	assert.ok(!shown(out[0]).includes("NOTE:"), shown(out[0]));
	assert.match(shown(out[1]), /changed outside this transcript/);
});

test("an install keeps its header and loses only the stale cells under it", () => {
	const install = py({
		kind: "py.install",
		header: ["installed (environment changed)"],
		response: cellsResponse([ran("c1", "DataFrame(1000)")]),
	});
	const after = py({ kind: "py.cells", response: cellsResponse([ran("c1", "DataFrame(2000)")]) });

	const out = filterPyContext([install, after], LIVE);
	assert.match(shown(out[0]), /^installed \(environment changed\)/);
	assert.match(shown(out[0]), /- superseded: c1/);
});

test("messages that are not ours are never touched", () => {
	const messages = [user("hello"), user("world")];
	// Same array back, not a copy: nothing to rewrite means nothing to invalidate
	// in the provider's cached prefix.
	assert.equal(filterPyContext(messages, LIVE), messages);
});

test("a current transcript is returned untouched", () => {
	const messages = [
		user("run it"),
		py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")], { x: "1" }) }),
	];
	assert.equal(filterPyContext(messages, LIVE), messages);
});

test("filtering is idempotent, and preserves the shape of the transcript", () => {
	const messages = [
		user("go"),
		py({ kind: "py.cells", response: cellsResponse([ran("c1", "1")], { x: "1" }) }),
		py({ kind: "py.inspect", response: { ok: true, cells: [] } }),
		py({ kind: "py.cells", response: cellsResponse([ran("c1", "2"), ran("c2", "9")], { x: "2" }) }),
		py({ kind: "py.inspect", response: { ok: true, cells: [] } }),
	];

	const once = filterPyContext(messages, LIVE);
	const twice = filterPyContext(once, LIVE);
	assert.deepEqual(twice.map(shown), once.map(shown));

	// Every tool_use must still be answered, in order: dropping a message or
	// renaming a call would make the payload unserialisable.
	const ids = (ms: readonly ContextMessage[]) =>
		ms.map((m) => (m as { toolCallId?: string }).toolCallId ?? "-");
	assert.equal(once.length, messages.length);
	assert.deepEqual(ids(once), ids(messages));
});
