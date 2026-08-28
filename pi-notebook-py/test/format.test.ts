/**
 * The renderers, as pure functions.
 *
 * These are what the model actually reads, so the assertions are about
 * legibility as much as correctness: a hint that is present but unactionable
 * is a hint the model will not act on.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	formatEval,
	formatHints,
	formatInspect,
	formatRead,
	formatRun,
	imagesOf,
	type CellOutput,
	type RunResponse,
} from "../src/format.ts";

function output(over: Partial<CellOutput> = {}): CellOutput {
	return { cell: "c1", status: "ok", seconds: 0.001, execution_count: 1, ...over };
}

function response(over: Partial<RunResponse> = {}): RunResponse {
	return { ok: true, results: [], stale: [], unrun: [], failing: [], globals: {}, ...over };
}

test("a successful cell renders as one line with its execution count", () => {
	const text = formatRun(response({ results: [output({ value: "42" })] }));
	assert.match(text, /^\* \[1\] c1 1\.0ms {2}42$/m);
});

test("stdout is indented under the cell that produced it", () => {
	const text = formatRun(response({ results: [output({ stdout: "one\ntwo\n" })] }));
	assert.match(text, /^ {2}\| one$/m);
	assert.match(text, /^ {2}\| two$/m);
});

test("a quiet notebook says nothing about being quiet", () => {
	// Every empty hint list omitted: the tails exist to be noticed, and a
	// response that always prints `stale: ` teaches the model to skip the line.
	assert.equal(formatRun(response({ results: [output({ value: "1" })] })).split("\n").length, 1);
});

test("an error renders its traceback rather than repeating the headline", () => {
	const text = formatRun(
		response({
			results: [
				output({
					status: "error",
					error: "ZeroDivisionError: division by zero",
					traceback: 'Traceback:\n  File "<cell c1>", line 1\n    1/0\nZeroDivisionError',
				}),
			],
			failing: ["c1"],
		}),
	);
	assert.match(text, /^! \[1\] c1 .*ZeroDivisionError/m);
	// The `  | ` prefix, then the traceback's own indentation, kept intact.
	assert.match(text, /^ {2}\| {3}File "<cell c1>", line 1$/m);
	assert.match(text, /^failing: c1$/m);
});

test("the staleness hint says what to do about it", () => {
	// The whole point of the hint. `stale: c3, c4` is a fact the model has no
	// instruction attached to; this line carries the recovery move with it.
	const text = formatRun(response({ stale: ["c3", "c4"] }));
	assert.match(text, /stale .*: c3, c4/);
	assert.match(text, /nb_run \{op: "all"\}/);
});

test("unrun and failing are reported separately from stale", () => {
	const lines = formatHints({ stale: ["c2"], unrun: ["c3"], failing: ["c1"] });
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^failing: c1$/);
	assert.match(lines[1], /^stale /);
	assert.match(lines[2], /^unrun: c3$/);
});

test("images are announced in the text as well as attached", () => {
	// The model gets the picture as a separate content block, but a line in
	// the text is what ties it to the cell it came out of.
	const resp = response({
		results: [output({ images: [{ mime: "image/png", b64: "AAAA" }] })],
	});
	assert.match(formatRun(resp), /\[attached: image\/png\]/);
	assert.deepEqual(imagesOf(resp), [{ mime: "image/png", b64: "AAAA" }]);
});

test("notes explain an image that did not make it", () => {
	const text = formatRun(
		response({ results: [output({ notes: ["figure 1 omitted: larger than 1000 kB"] })] }),
	);
	assert.match(text, /\(figure 1 omitted: larger than 1000 kB\)/);
});

test("imagesOf collects across every cell in a run", () => {
	const resp = response({
		results: [
			output({ cell: "c1", images: [{ mime: "image/png", b64: "A" }] }),
			output({ cell: "c2", images: [] }),
			output({ cell: "c3", images: [{ mime: "image/jpeg", b64: "B" }] }),
		],
	});
	assert.deepEqual(
		imagesOf(resp).map((i) => i.b64),
		["A", "B"],
	);
});

test("a save reports where it went and how much of it", () => {
	const text = formatRun(response({ saved: { path: "nb.py", cells: 3, bytes: 120 } }));
	assert.match(text, /saved 3 cell\(s\) to nb\.py/);
});

test("an install names what still needs a restart, and why it matters", () => {
	const text = formatRun(
		response({ installed: ["numpy"], restart_required: ["numpy"] }),
	);
	assert.match(text, /installed: numpy/);
	assert.match(text, /still running the old code: numpy/);
	assert.match(text, /nb_run \{op: "all"\}/);
});

test("an install with nothing to restart says nothing about restarting", () => {
	const text = formatRun(response({ installed: ["cowsay"], restart_required: [] }));
	assert.doesNotMatch(text, /old code/);
});

test("a failed response renders the error and nothing else", () => {
	assert.equal(formatRun({ ok: false, error: "boom" }), "Error: boom");
});

test("inspect lists cells with their state and a preview", () => {
	const text = formatInspect({
		ok: true,
		path: "nb.py",
		cells: [
			{
				id: "c1",
				index: 0,
				kind: "code",
				name: "setup",
				execution_count: 1,
				lines: 1,
				preview: "import math",
				state: "ok",
			},
			{
				id: "c2",
				index: 1,
				kind: "markdown",
				name: null,
				execution_count: null,
				lines: 2,
				preview: "Notes",
				state: "unrun",
			},
		],
		stale: [],
	});
	assert.match(text, /^2 cells \(file: nb\.py\):$/m);
	assert.match(text, /^\[1\] c1 \(setup\) ok {2}import math$/m);
	assert.match(text, /^\[ \] c2 markdown unrun {2}Notes$/m);
});

test("an empty notebook says so rather than printing a header", () => {
	assert.equal(formatInspect({ ok: true, cells: [] }), "(empty notebook)");
});

test("read prints full source under a labelled separator", () => {
	const text = formatRead({
		ok: true,
		cells: [{ id: "c1", kind: "code", name: "load", src: "a = 1\nb = 2" }],
	});
	assert.equal(text, "--- c1 (load)\na = 1\nb = 2");
});

test("eval prints stdout before the value", () => {
	assert.equal(formatEval({ ok: true, value: "7", stdout: "noise\n" }), "noise\n7");
});

test("a failed eval prefers the traceback to the one-line error", () => {
	const text = formatEval({ ok: false, error: "NameError: x", traceback: "Traceback:\n  x" });
	assert.equal(text, "Traceback:\n  x");
});
