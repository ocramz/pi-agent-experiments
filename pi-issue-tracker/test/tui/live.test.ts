// The three cases that need a real model turn.
//
// /plan-stories drives the model itself, and /undo-turn has nothing to restore
// until the turn_end hook has fired — which only happens after the agent has
// actually answered. That makes these slow, non-deterministic and not free, so
// they are the one file that needs a key.
//
// Refusing loudly beats skipping quietly, so an absent key fails the run rather
// than silently reducing it. PI_TUI_SKIP_LIVE=1 is the explicit opt-out, for the
// fork CI job that gets no secrets.

import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAllStories } from "../../src/database.ts";
import { rowCount } from "./inspect.ts";
import { session, type Session } from "./pi-session.ts";

const SKIP = process.env.PI_TUI_SKIP_LIVE === "1";
if (!SKIP && !process.env.OPENROUTER_API_KEY) {
	throw new Error(
		"OPENROUTER_API_KEY is not set — the live interactive cases cannot run.\n" +
			"Set it in .env at the repo root (see env.example), or pass PI_TUI_SKIP_LIVE=1 to leave them out.",
	);
}

/** A model turn and a planning loop are both far slower than a git command. */
const MODEL = { timeout: 240_000 };

/** Poll the fixture until `check` holds. For state pi writes outside its output. */
async function until(s: Session, what: string, check: () => Promise<boolean>, timeout = 240_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((done) => setTimeout(done, 1000));
	}
	assert.fail(`timed out waiting for ${what}\n\nlast output:\n${s.screen().slice(-2000)}`);
}

describe("/plan-stories", { skip: SKIP ? "PI_TUI_SKIP_LIVE=1" : false }, () => {
	it("B1 builds a story tree from a goal", async (t) => {
		const s = await session(t, "empty", { live: true });
		await s.command("/plan-stories add rate limiting to the public API");
		await s.expect("Created epic #", MODEL);
		await s.close();

		const stories = s.db((db) => getAllStories(db));
		assert.ok(stories.length >= 2, `planning created a story tree (got ${stories.length})`);
		assert.ok(
			stories.some((story) => story.parent_id !== null),
			"the plan nests children under a parent",
		);
	});

	it("B3 a second run adds rather than replaces", async (t) => {
		const s = await session(t, "stories", { live: true });
		const before = s.db((db) => rowCount(db, "stories"));
		await s.command("/plan-stories improve error handling in the widget loader");
		await s.expect("Created epic #", MODEL);
		await s.close();

		const after = s.db((db) => rowCount(db, "stories"));
		assert.ok(after > before, `planning added to the existing stories (${before} → ${after})`);
	});
});

describe("/undo-turn", { skip: SKIP ? "PI_TUI_SKIP_LIVE=1" : false }, () => {
	it("I1 restores the working tree from the newest checkpoint", async (t) => {
		// turn_end checkpoints with `git stash create`, which only records tracked
		// modifications and reports nothing at all on a clean tree. So the tree has
		// to be dirty before the first turn ends for there to be a checkpoint.
		const s = await session(t, "epicActive", {
			live: true,
			prepare: (dir) => appendFileSync(join(dir, "README.md"), "work in progress\n"),
		});

		await s.command("Reply with exactly the word: ok. Do not use any tools.");
		await until(s, "a turn_end checkpoint", async () => (await s.piRefs("checkpoint")).length > 0);

		// Throw the change away, so the restore has something to put back and
		// `stash apply` cannot collide with the very edit it is carrying.
		await s.git("checkout", "--", "README.md");
		assert.equal(await s.git("status", "--porcelain"), "", "the working tree is clean before the undo");

		await s.command("/undo-turn");
		await s.expect("Restored the working tree from checkpoint", MODEL);
		await s.close();

		assert.match(s.read("README.md"), /work in progress/, "the checkpointed change is back");
	});
});
