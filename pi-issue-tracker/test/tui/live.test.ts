// The cases that need a real model turn.
//
// /plan-stories drives the model itself, and /undo-turn has nothing to restore
// until the turn_end hook has fired — which only happens after the agent has
// actually answered. Session relocation is here for a subtler reason: pi writes
// a session file only once the session holds an assistant message, so before the
// first reply there is no file for `SessionManager.forkFrom` to fork and a
// session cannot move at all.
//
// That makes these slow, non-deterministic and not free, so they are the one
// file that needs a key.
//
// Refusing loudly beats skipping quietly, so an absent key fails the run rather
// than silently reducing it. PI_TUI_SKIP_LIVE=1 is the explicit opt-out, for the
// fork CI job that gets no secrets.

import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { getAllStories, getEpicBranch } from "../../src/database.ts";
import { rowCount } from "./inspect.ts";
import { session, sessionFileExists, sessionFilesFor, type Session } from "./session.ts";

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

describe("/start-epic --worktree", { skip: SKIP ? "PI_TUI_SKIP_LIVE=1" : false }, () => {
	/**
	 * The one case that reaches pi's session relocation.
	 *
	 * The model turn is not incidental: pi flushes a session file only once the
	 * first assistant message lands, and `SessionManager.forkFrom` refuses an
	 * unwritten one — so before a reply there is literally nothing to relocate.
	 * That is why this lives here and not beside W1–W9, which cover everything
	 * about worktree mode that does not depend on the session moving.
	 *
	 * It stops after the move. Driving a *second* command through the rebuilt TUI
	 * does not work in this harness — see the note in README.md — so the rest of
	 * the round trip is covered at the library level in ../worktree.test.ts.
	 */
	it("W10 relocates the session into the epic's worktree", async (t) => {
		const s = await session(t, "stories", { live: true });
		const epic = s.facts.epicId!;

		await s.command("Reply with exactly the word: ok. Do not use any tools.");
		// Not "wait until the screen says ok": the model streams its own paraphrase
		// of the prompt, so that matches long before the turn is over. The session
		// file appearing is the actual precondition — it is what makes the session
		// forkable at all.
		await until(s, "pi to write a session file", async () => sessionFileExists(s.dir));

		await s.command(`/start-epic ${epic} --worktree`);
		await s.expect("This session has moved into the worktree at", MODEL);
		await s.close();

		const worktree = s.db((db) => getEpicBranch(db, epic))?.path;
		assert.ok(worktree, "the epic recorded its worktree");
		assert.ok(existsSync(worktree!), "the worktree exists on disk");

		// The durable proof, and the reason this case exists: pi wrote a session
		// whose header names the worktree. The screen cannot show this — a switch
		// repaints the TUI and the footer is not reliable evidence either way.
		assert.equal(
			sessionFilesFor(worktree!).length,
			1,
			`pi should have forked a session rooted in ${worktree}`,
		);
		assert.equal(await s.branch(), "feat/work", "the main checkout never moved");
	});
});
