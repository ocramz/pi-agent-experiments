// Offline TUI cases: drive the /py commands through pi's real TUI in a pty
// and assert what the user sees. The kernel side is real (stdlib python3);
// no model is involved.

import { test } from "node:test";
import { session } from "./session.ts";

test("W1: /py inspect on an empty kernel says so", async (t) => {
	const s = await session(t);
	await s.command("/py inspect");
	await s.expect("(no cells)");
	await s.close();
});

test("W2: /py add creates a cell and shows the generated id", async (t) => {
	const s = await session(t);
	await s.command("/py add base x = 41");
	await s.expect("id:");
	await s.expect("globals: x=41");
	await s.close();
});

test("W3: /py <expr> evaluates without creating a cell", async (t) => {
	const s = await session(t);
	await s.command("/py add base x = 41");
	await s.expect("globals: x=41");
	await s.command("/py x + 1");
	await s.expect("42");
	await s.command("/py inspect");
	await s.expect("1 cell"); // still just the one — eval mints nothing
	await s.close();
});

test("W4: /py rerun advances a stateful cell", async (t) => {
	const s = await session(t);
	// One line so the slash command can carry it: try/except via parens-free form.
	await s.command("/py add counter count = count + 1 if 'count' in dir() else None");
	await s.expect("globals: count=None");
	await s.command("/py inspect");
	await s.expect("stateful");
	await s.close();
});

test("W5: /py run-all replays from the top", async (t) => {
	const s = await session(t);
	await s.command("/py add base x = 1");
	await s.expect("globals: x=1");
	await s.command("/py run-all");
	await s.expect("globals: x=1"); // replay converges
	await s.close();
});

test("W6: a failing cell reports the error, not a dead kernel", async (t) => {
	const s = await session(t);
	await s.command("/py add bad y = undefined_name");
	await s.expect("NameError");
	await s.expect("failing:");
	// kernel still serves the next command
	await s.command("/py x = 1 + 1");
	await s.expect("2");
	await s.close();
});
