// The autoprove loop's decisions, without pi: when it continues, when it stops
// and why, and how its time is counted.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Budget,
	type Measure,
	boundary,
	cycleText,
	isProgress,
	kickoffText,
	parseArgs,
	pause,
	restore,
	resume,
	start,
	summaryText,
	userStop,
} from "../src/hooks/autoprove.ts";

const B: Budget = { maxCycles: 5, maxStuck: 2, maxRuntimeMs: 60_000 };
const m = (sorries: number, errors = 0): Measure => ({ sorries, errors, focus: null });

test("AP1: progress is fewer sorries without more errors, or fewer errors without more sorries", () => {
	assert.ok(isProgress(m(3), m(2)));
	assert.ok(isProgress(m(2, 2), m(2, 1)));
	assert.ok(!isProgress(m(2), m(2)));
	assert.ok(!isProgress(m(2, 0), m(1, 1)), "trading a sorry for an error is not progress");
	assert.ok(!isProgress(m(2), m(3)));
});

test("AP2: completion stops at once", () => {
	const s = start("/p/F.lean", "/p", m(2), B, 0);
	const d = boundary(s, m(0), { aborted: false }, 1000);
	assert.equal(d.kind, "stop");
	assert.equal(d.kind === "stop" && d.reason, "completion");
	assert.equal(d.state.cycles, 1);
	assert.equal(d.state.status, "stopped");
});

test("AP3: errors left mean not complete, even with no sorry", () => {
	const s = start("/p/F.lean", "/p", m(1), B, 0);
	const d = boundary(s, m(0, 1), { aborted: false }, 1000);
	assert.equal(d.kind, "continue");
});

test("AP4: stuck cycles accumulate, progress resets them, the budget stops the loop", () => {
	let s = start("/p/F.lean", "/p", m(3), B, 0);
	let d = boundary(s, m(3), { aborted: false }, 1);
	assert.equal(d.kind, "continue");
	assert.equal(d.state.stuckStreak, 1);
	d = boundary(d.state, m(2), { aborted: false }, 2);
	assert.equal(d.state.stuckStreak, 0, "progress resets the streak");
	d = boundary(d.state, m(2), { aborted: false }, 3);
	d = boundary(d.state, m(2, 1), { aborted: false }, 4);
	assert.equal(d.kind, "stop");
	assert.equal(d.kind === "stop" && d.reason, "max-stuck");
	s = d.state;
	assert.equal(s.history.length, 4);
	assert.deepEqual(
		s.history.map((h) => h.stuck),
		[true, false, true, true],
	);
});

test("AP5: the cycle budget stops the loop", () => {
	let s = start("/p/F.lean", "/p", m(10), { ...B, maxCycles: 2 }, 0);
	let d = boundary(s, m(9), { aborted: false }, 1);
	assert.equal(d.kind, "continue");
	d = boundary(d.state, m(8), { aborted: false }, 2);
	assert.equal(d.kind === "stop" && d.reason, "max-cycles");
	s = d.state;
	assert.equal(s.cycles, 2);
});

test("AP6: running time excludes paused time", () => {
	let s = start("/p/F.lean", "/p", m(10), { ...B, maxRuntimeMs: 1000 }, 0);
	s = pause(s, 600);
	assert.equal(s.activeMs, 600);
	s = resume(s, 1_000_000);
	const d = boundary(s, m(9), { aborted: false }, 1_000_300);
	assert.equal(d.kind, "continue", "900ms of activity, not a million");
	const d2 = boundary(d.state, m(8), { aborted: false }, 1_000_500);
	assert.equal(d2.kind === "stop" && d2.reason, "max-runtime");
});

test("AP7: an aborted run is a user stop, a failed one an error", () => {
	const s = start("/p/F.lean", "/p", m(2), B, 0);
	const a = boundary(s, m(2), { aborted: true }, 1);
	assert.equal(a.kind === "stop" && a.reason, "user-stop");
	assert.equal(a.state.cycles, 0, "an interrupted turn is not a cycle");
	const e = boundary(s, m(2), { aborted: false, error: "429" }, 1);
	assert.equal(e.kind === "stop" && e.reason, "error");
	assert.equal(e.state.stop?.detail, "429");
});

test("AP8: restore picks the branch's latest entry, and a live loop comes back paused", () => {
	const running = start("/p/F.lean", "/p", m(2), B, 0);
	const older = { ...running, cycles: 1 };
	const entries = [
		{ type: "message" },
		{ type: "custom", customType: "lean-autoprove", data: older },
		{ type: "custom", customType: "other", data: {} },
		{ type: "custom", customType: "lean-autoprove", data: { ...running, cycles: 3 } },
	];
	const r = restore(entries, 5000);
	assert.equal(r?.cycles, 3);
	assert.equal(r?.status, "paused");
	assert.equal(r?.segmentStart, null);
	assert.equal(restore([{ type: "message" }], 0), null);
	const stopped = userStop(running, 10);
	assert.equal(restore([{ type: "custom", customType: "lean-autoprove", data: stopped }], 0)?.status, "stopped");
});

test("AP9: arguments", () => {
	assert.deepEqual(parseArgs("Foo.lean", B), { file: "Foo.lean", budget: B, resume: false });
	const p = parseArgs("--max-cycles=7 Foo.lean --max-stuck=4 --max-runtime=2h", B);
	assert.equal(p.file, "Foo.lean");
	assert.deepEqual(p.budget, { maxCycles: 7, maxStuck: 4, maxRuntimeMs: 7_200_000 });
	assert.equal(parseArgs("resume", B).resume, true);
	assert.match(parseArgs("A.lean B.lean", B).error ?? "", /one file/);
	assert.match(parseArgs("--frobnicate", B).error ?? "", /unknown option/);
	assert.equal(parseArgs("--max-runtime=90 X.lean", B).budget.maxRuntimeMs, 90 * 60_000);
});

test("AP10: the messages carry the cycle, the measurement and the reason", () => {
	const s = start("/p/F.lean", "/p", { sorries: 2, errors: 1, focus: "error at line 3: boom" }, B, 0);
	assert.match(kickoffText(s, "F.lean"), /cycle 1\/5 target=F\.lean/);
	assert.match(kickoffText(s, "F.lean"), /error at line 3: boom/);
	const d = boundary(s, m(2, 1), { aborted: false }, 1);
	assert.match(cycleText(d.state, "F.lean"), /cycle 2\/5/);
	assert.match(cycleText(d.state, "F.lean"), /no progress \(stuck 1\/2\)/);
	const done = boundary(d.state, m(0), { aborted: false }, 2);
	assert.match(summaryText(done.state, "F.lean"), /every sorry is filled/);
	assert.match(summaryText(done.state, "F.lean"), /sorries 2 → 0, errors 1 → 0/);
});
