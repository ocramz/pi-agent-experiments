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
	formatDigest,
	formatEnv,
	formatEval,
	formatFile,
	formatHints,
	formatInspect,
	formatNotebooks,
	formatRead,
	formatRun,
	imagesOf,
	type CellOutput,
	type DigestReport,
	type EnvPlan,
	type EnvResponse,
	type FileRunResult,
	type NotebookListing,
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
				execution_count: 1,
				lines: 1,
				preview: "import math",
				state: "ok",
			},
			{
				id: "c2",
				index: 1,
				kind: "markdown",
				execution_count: null,
				lines: 2,
				preview: "Notes",
				state: "unrun",
			},
		],
		stale: [],
	});
	assert.match(text, /^2 cells \(file: nb\.py\):$/m);
	assert.match(text, /^\[1\] c1 ok {2}import math$/m);
	assert.match(text, /^\[ \] c2 markdown unrun {2}Notes$/m);
});

test("an empty notebook says so rather than printing a header", () => {
	assert.equal(formatInspect({ ok: true, cells: [] }), "(empty notebook)");
});

test("read prints full source under a labelled separator", () => {
	const text = formatRead({
		ok: true,
		cells: [{ id: "c1", kind: "code", src: "a = 1\nb = 2" }],
	});
	assert.equal(text, "--- c1\na = 1\nb = 2");
});

test("eval prints stdout before the value", () => {
	assert.equal(formatEval({ ok: true, value: "7", stdout: "noise\n" }), "noise\n7");
});

test("a failed eval prefers the traceback to the one-line error", () => {
	const text = formatEval({ ok: false, error: "NameError: x", traceback: "Traceback:\n  x" });
	assert.equal(text, "Traceback:\n  x");
});

function listing(over: Partial<NotebookListing> = {}): NotebookListing {
	return {
		name: "sales",
		file: "/proj/.pi/notebooks/sales.py",
		hasFile: true,
		venv: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales",
		hasVenv: true,
		python: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales/bin/python",
		source: "venv",
		...over,
	};
}

test("the notebook listing names the environment each one runs in", () => {
	const text = formatNotebooks([listing(), listing({ name: "scratch", hasVenv: false })], "sales");
	assert.match(text, /^\* sales$/m); // the session's own is marked
	assert.match(text, /^ {4}venv \/home\/u\/\.pi\/notebook-py\/venvs\/proj-ab12\/sales$/m);
	assert.match(text, /^ {2}scratch$/m);
	assert.match(text, /\(not built yet\)$/m);
});

test("a venv stranded by a pin is still listed, and named as reclaimable", () => {
	// The whole point of the line: an override leaves the built venv on disk,
	// and one that cannot be seen cannot be reclaimed. So both are reported —
	// what runs, and what is merely taking up space.
	const text = formatNotebooks([listing({ source: "pin", python: "/usr/bin/python3.13" })], "other");
	assert.match(text, /^ {4}pin: \/usr\/bin\/python3\.13$/m);
	assert.match(text, /^ {4}venv \S+\/sales \(built, unused\. Delete it with \/nb drop-venv\)$/m);
});

test("a pin with no venv behind it says nothing about one", () => {
	const text = formatNotebooks(
		[listing({ source: "pin", python: "/usr/bin/python3.13", hasVenv: false })],
		"other",
	);
	assert.match(text, /^ {4}pin: \/usr\/bin\/python3\.13$/m);
	assert.equal(/built, unused/.test(text), false);
});

// ---- env: which interpreter this is, and what is in it

function envResponse(over: Partial<EnvResponse> = {}): EnvResponse {
	return {
		ok: true,
		executable: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales/bin/python",
		version: "3.13.2",
		implementation: "cpython",
		prefix: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales",
		base_prefix: "/usr",
		packages: ["numpy==2.1.3", "pandas==2.2.3"],
		producer: "importlib.metadata",
		...over,
	};
}

function envPlan(over: Partial<EnvPlan> = {}): EnvPlan {
	return {
		notebook: "sales",
		python: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales/bin/python",
		source: "venv",
		venv: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales",
		mismatch: false,
		...over,
	};
}

test("the lock is plain requirements lines, so it can be stored as one", () => {
	// The point of the op: something else records this. Anything decorating
	// the package lines would have to be stripped back off before use.
	const text = formatEnv(envResponse(), envPlan());
	assert.match(text, /^lock {5}2 package\(s\), via importlib\.metadata$/m);
	assert.match(text, /^numpy==2\.1\.3$/m);
	assert.match(text, /^pandas==2\.2\.3$/m);
	assert.match(text, /^version {2}3\.13\.2 \(cpython\)$/m);
	assert.match(text, /^source {3}venv \(\/home\/u\/\.pi\/notebook-py\/venvs\/proj-ab12\/sales\)$/m);
});

test("the base prefix is printed only when it differs, which is what venv means", () => {
	assert.match(formatEnv(envResponse(), envPlan()), /^prefix {3}\S+sales \(base \/usr\)$/m);
	const outside = envResponse({ prefix: "/usr", base_prefix: "/usr" });
	assert.equal(/base/.test(formatEnv(outside, envPlan({ source: "pin" }))), false);
});

test("a lock that was not asked for leaves the interpreter report intact", () => {
	const text = formatEnv(envResponse({ packages: undefined, producer: undefined }), envPlan());
	assert.equal(/lock/.test(text), false);
	assert.match(text, /^python {3}\S+sales\/bin\/python$/m);
});

test("an interpreter that is not the planned one is called out, not papered over", () => {
	// The venv could not be built, so `source` describes an environment
	// nothing is running in — and nb_env has been putting packages
	// somewhere other than this notebook the whole time.
	const text = formatEnv(
		envResponse({ executable: "/usr/bin/python3.13" }),
		envPlan({ mismatch: true }),
	);
	assert.match(text, /^python {3}\/usr\/bin\/python3\.13$/m);
	assert.match(text, /NOTE: the rules choose \S+sales\/bin\/python \(venv\)/);
	assert.match(text, /nb_env/);
});

test("a failed env call is an error, not an empty report", () => {
	assert.match(formatEnv({ ok: false, error: "kernel process exited" }, envPlan()), /^Error: kernel/);
});

// ---- digest: whether the checkpoint still is what the kernel would write

function digest(over: Partial<DigestReport> = {}): DigestReport {
	return {
		notebook: "sales",
		checkpoint: ".pi/notebooks/sales.py",
		file: { sha256: "9f3a", bytes: 1412 },
		kernel: { sha256: "9f3a", bytes: 1412, cells: 12 },
		...over,
	};
}

test("matching hashes say so in one line and offer nothing to do", () => {
	const text = formatDigest(digest());
	assert.match(text, /in step: the kernel would write exactly this file\./);
	assert.equal(/diverged/.test(text), false);
});

test("a divergence names both hashes and the call that resolves it", () => {
	const text = formatDigest(digest({ kernel: { sha256: "7b21", bytes: 1509, cells: 13 } }));
	assert.match(text, /^ {2}kernel {3}7b21 {2}\(1509 bytes, 13 cell\(s\)\)$/m);
	assert.match(text, /^ {2}on disk {2}9f3a {2}\(1412 bytes\)$/m);
	// A report that says "diverged" and stops is a report the model cannot act on.
	assert.match(text, /nb_notebook \{op: "open", path: "\.pi\/notebooks\/sales\.py"\}/);
});

test("with no kernel running there is nothing that could have diverged", () => {
	// The property that keeps a digest from building a venv to answer.
	const text = formatDigest(digest({ kernel: null }));
	assert.match(text, /^sha256 {5}9f3a {2}\(1412 bytes\)$/m);
	assert.match(text, /the kernel is not running, so nothing can have diverged\./);
	assert.equal(/diverged:/.test(text), false);
});

test("an empty kernel with no checkpoint is not a divergence", () => {
	const text = formatDigest(digest({ file: null, kernel: { sha256: "e3b0", bytes: 0, cells: 0 } }));
	assert.match(text, /nothing has been written because nothing has happened/);
	assert.equal(/diverged/.test(text), false);
});

test("cells with no checkpoint behind them means a write failed, and says which", () => {
	const text = formatDigest(digest({ file: null, kernel: { sha256: "7b21", bytes: 1509, cells: 13 } }));
	assert.match(text, /diverged: there is no checkpoint, but the kernel holds 13 cell\(s\)/);
	assert.match(text, /\.pi\/notebooks\/ is writable/);
});

// ---- a .py run as a fresh process

function fileRun(over: Partial<FileRunResult> = {}): FileRunResult {
	return {
		path: "etl.py",
		python: "/home/u/.pi/notebook-py/venvs/proj-ab12/sales/bin/python",
		code: 0,
		seconds: 3.21,
		stdout: "loaded 40122 rows\n",
		stderr: "",
		stdoutDropped: 0,
		stderrDropped: 0,
		timedOut: false,
		...over,
	};
}

test("a file run reads like a cell result, with the same marks and gutter", () => {
	const text = formatFile(fileRun());
	assert.match(text, /^\* etl\.py exited 0 in 3\.2s$/m);
	assert.match(text, /^ {2}\| loaded 40122 rows$/m);
});

test("a non-zero exit is marked as a failure and shows stderr", () => {
	const text = formatFile(fileRun({ code: 1, stdout: "", stderr: "KeyError: 'total'\n" }));
	assert.match(text, /^! etl\.py exited 1 in 3\.2s$/m);
	assert.match(text, /^ {2}\| KeyError: 'total'$/m);
});

test("a timeout says whose budget ran out and that the namespace survived", () => {
	// The reason this runs outside the kernel at all: the round-trip timer
	// would have killed the kernel and taken the namespace with it.
	const text = formatFile(fileRun({ code: null, timedOut: true, seconds: 120 }));
	assert.match(text, /^! etl\.py was killed after 120\.0s/m);
	assert.match(text, /namespace is untouched/);
});

test("truncation is stated rather than left to look like the whole output", () => {
	const text = formatFile(fileRun({ stdout: "tail\n", stdoutDropped: 214032 }));
	assert.match(text, /\(stdout truncated: 214032 characters dropped, the last 5 are shown\)/);
});

test("a run that never started is an error rather than an exit status of null", () => {
	assert.match(formatFile(fileRun({ error: "no such file: /proj/etl.py" })), /^Error: no such file/);
});
