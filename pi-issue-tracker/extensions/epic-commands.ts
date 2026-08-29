/**
 * The six epic commands, and the orchestration around them.
 *
 * These stay pi-coupled on purpose. The *decisions* are already pure — see
 * `checkCanStartEpic` and `checkCanMerge` in `src/rules.ts`, and the epic
 * lifecycle in `src/epic.ts`. What is left here is the part that cannot leave:
 * `ctx.ui.select` confirmation dialogs, and session relocation, which pi offers
 * only from a command handler.
 *
 * Read src/README.md's "Constraints discovered in the SDK" before touching
 * `relocateSession` or anything around `switchSession`.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import {
	getActiveBranchModeEpic,
	getActiveEpicBranches,
	getChildren,
	getEpicBranch,
	getLastMergedEpicBranch,
	getStoryById,
} from "../src/database.ts";
import {
	cancelEpic,
	epicWorktreePath,
	findEpicForStory,
	mergeIntoBase,
	pruneEpicRefs,
	releaseWorktree,
	restoreLastCheckpoint,
	startEpic,
	undoMerge,
	undoStory,
	updateFromBase,
} from "../src/epic.ts";
import { currentBranch, isDirty, revParse } from "../src/git.ts";
import {
	checkCanMerge,
	checkCanStartEpic,
	epicBranchName,
	parseCommandArgs,
} from "../src/rules.ts";
import type { EpicBranch, EpicMode } from "../src/types.ts";
import { branchCheckoutLocation } from "../src/worktree.ts";
import {
	ensureDb,
	ensureTracker,
	isDbReady,
	maybeTracker,
	NOTHING_TO_RELOCATE,
	refreshStatus,
	report,
	repoInfo,
	type ReplacedSession,
	serializeGit,
	sessionEpic,
	transitionStatus,
} from "./runtime.ts";

// ── Git: epic lifecycle ─────────────────────────────────────────
// Starting and merging an epic are user actions, never the agent's. Merging
// rewrites the branch the user is sitting on, and pi can only relocate a
// session from a command handler, so both live here rather than in the tool.

/** Resolve an epic from an explicit id, or fall back to this session's own. */
export function resolveEpic(args: string): { epic?: EpicBranch; error?: string } {
	const db = ensureDb();
	const raw = parseCommandArgs(args).tokens[0] ?? "";
	if (raw) {
		const id = Number(raw);
		if (!Number.isInteger(id)) return { error: `"${raw}" is not a story id` };
		const epic = getEpicBranch(db, id);
		return epic ? { epic } : { error: `epic #${id} has no branch — start it with /start-epic ${id}` };
	}
	const own = sessionEpic();
	return own
		? { epic: own }
		: { error: "this session is not working on an epic — pass an id, or start one with /start-epic" };
}

/**
 * Move this session into `targetCwd`, carrying its history.
 *
 * The only true relocation pi offers: `ctx.cwd` is a read-only getter, the
 * built-in tools capture their directory at construction, and
 * `process.chdir()` is inert. `forkFrom` writes a new session file whose
 * header records the new directory, and `switchSession` rebinds the runtime
 * to it.
 *
 * Everything after the switch must go through the replacement context. By the
 * time `withSession` runs, the old session has emitted `session_shutdown` and
 * every session-bound object captured beforehand — including `ctx` and
 * `ctx.sessionManager` — throws if touched.
 */
async function relocateSession(
	ctx: ExtensionCommandContext,
	targetCwd: string,
	after: (rc: ReplacedSession) => Promise<void>,
): Promise<{ ok: boolean; note: string }> {
	const sourceSession = ctx.sessionManager.getSessionFile();
	if (!sourceSession) return { ok: false, note: NOTHING_TO_RELOCATE };

	let relocated: string | undefined;
	try {
		relocated = SessionManager.forkFrom(sourceSession, targetCwd).getSessionFile();
	} catch (error) {
		// Overwhelmingly this is the empty-session case, which is not a fault
		// worth spelling out in SDK terms.
		const detail = String(error);
		return {
			ok: false,
			note: detail.includes("empty or invalid") ? NOTHING_TO_RELOCATE : `could not fork the session: ${detail}`,
		};
	}
	if (!relocated) return { ok: false, note: NOTHING_TO_RELOCATE };

	const result = await ctx.switchSession(relocated, { withSession: async (rc) => after(rc) });
	return result.cancelled
		? { ok: false, note: "an extension cancelled the session switch" }
		: { ok: true, note: `session moved to ${targetCwd}` };
}

/**
 * Land a merge, then take the worktree down and offer to tidy the refs.
 *
 * Everything here runs *after* any session relocation, against a freshly
 * resolved tracker — the one captured before a switch belongs to a torn-down
 * session.
 */
async function finishMerge(epic: EpicBranch, ctx: ExtensionCommandContext | ReplacedSession): Promise<void> {
	const tracked = ensureTracker();
	const merged = await serializeGit(() => mergeIntoBase(tracked, epic));
	if (!merged.ok) return void (await report(ctx, merged.note, "error"));

	const notes = [merged.note];
	const current = getEpicBranch(tracked.db, epic.epic_id) ?? epic;

	if (current.mode === "worktree" && current.path) {
		const released = await serializeGit(() => releaseWorktree(tracked, current));
		notes.push(released.ok ? released.note : `${released.note} — remove it by hand when you can.`);
	}
	if (tracked.epicId === epic.epic_id) tracked.epicId = null;

	// Reported before the prune question, not after it. Pruning is an optional
	// afterthought and the merge is the thing the user asked for; making them
	// answer a dialog before learning whether it worked gets that backwards.
	await report(ctx, notes.join("\n"));
	await offerToPrune(epic.epic_id, "pre-merge", "The merge stays undoable either way.", ctx);
}

/**
 * Offer to delete an epic's refs, always keeping the one its undo depends on.
 *
 * Backup refs are the safety net that gives every command an inverse, so they
 * are never pruned on their own — only when the user says so, and never the
 * ref that would make the operation they just ran irreversible.
 */
async function offerToPrune(
	epicId: number,
	keep: string,
	reassurance: string,
	ctx: ExtensionCommandContext | ReplacedSession,
): Promise<void> {
	if (!ctx.hasUI) return;
	const choice = await ctx.ui.select(`Prune epic #${epicId}'s checkpoints and backup refs? ${reassurance}`, [
		"No, keep them",
		`Yes, prune all but ${keep}`,
	]);
	if (!choice?.startsWith("Yes")) return;

	const tracked = ensureTracker();
	const pruned = await serializeGit(() => pruneEpicRefs(tracked, epicId, [keep]));
	await report(ctx, `Pruned ${pruned} ref(s) for epic #${epicId}.`);
}

/**
 * Whether this session is standing in the directory `epic` is about to lose.
 *
 * Asked of the resolved session epic rather than by comparing `ctx.cwd` to
 * `epic.path`: the path match was already done once, carefully, at
 * `session_start` — `resolveSessionEpic` normalises through git — and
 * repeating it as raw string equality here would reintroduce exactly the
 * symlink mismatch that resolution exists to avoid.
 */
function sessionIsInsideWorktreeOf(epic: EpicBranch): boolean {
	return epic.mode === "worktree" && epic.path !== null && maybeTracker()?.epicId === epic.epic_id;
}

/** Cancel, then offer to prune. Runs after any relocation, like `finishMerge`. */
async function finishCancel(epic: EpicBranch, ctx: ExtensionCommandContext | ReplacedSession): Promise<void> {
	const tracked = ensureTracker();
	const result = await serializeGit(() => cancelEpic(tracked, epic));
	if (!result.ok) return void (await report(ctx, result.note, "error"));
	if (tracked.epicId === epic.epic_id) tracked.epicId = null;

	await report(ctx, result.note);
	// pre-cancel holds the abandoned work; pruning it would make the cancel
	// irreversible, which is the one thing it promises not to be.
	await offerToPrune(epic.epic_id, "pre-cancel", "The abandoned work stays reachable either way.", ctx);
}

export async function startEpicCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const db = tracked.db;

	const { tokens, flags } = parseCommandArgs(args);
	const mode: EpicMode = flags.has("--worktree") ? "worktree" : "branch";
	const id = Number(tokens[0]);
	if (!Number.isInteger(id)) {
		return void ctx.ui.notify("Usage: /start-epic <story_id> [--worktree]", "error");
	}

	const story = getStoryById(db, id);
	const branch = await currentBranch(tracked.git, tracked.paths.repoRoot);
	const dirty = await isDirty(tracked.git, tracked.paths.repoRoot);

	// Worktree mode collides on two things branch mode cannot: a branch that
	// already exists, and a directory already sitting where it would go.
	const worktreePath = story ? epicWorktreePath(tracked, story) : "";
	const input = {
		isRepo: repoInfo()?.isRepo ?? false,
		branch,
		dirty,
		story,
		childCount: story ? getChildren(db, story.id).length : 0,
		mode,
		activeEpics: getActiveEpicBranches(db),
		branchExists:
			mode === "worktree" && story
				? (await revParse(tracked.git, `refs/heads/${epicBranchName(story)}`, tracked.paths.repoRoot)) !== null
				: false,
		pathExists: mode === "worktree" && story ? existsSync(worktreePath) : false,
	};

	let carryDirty = false;
	let check = checkCanStartEpic(input);
	if (!check.ok && dirty && checkCanStartEpic({ ...input, carryDirty: true }).ok) {
		// Refusing outright over a dirty tree is what makes people work
		// around the tool, so offer to bring the changes along instead.
		const choice = ctx.hasUI
			? await ctx.ui.select("You have uncommitted changes. Carry them onto the epic branch?", [
					"Yes, commit them as the epic's first commit",
					"No, let me handle them first",
				])
			: undefined;
		if (!choice?.startsWith("Yes")) {
			return void ctx.ui.notify("Commit or stash your changes, then run /start-epic again.", "warning");
		}
		carryDirty = true;
		check = checkCanStartEpic({ ...input, carryDirty: true });
	}
	if (!check.ok) return void ctx.ui.notify(`Cannot start epic: ${check.reason}`, "error");

	// A worktree checkout plus the manifest's setup command is the slowest
	// thing this extension does, and it otherwise happens with no output.
	const start = () => serializeGit(() => startEpic(tracked, { story: story!, mode, carryDirty }));
	const started =
		mode === "worktree" && ctx.mode === "tui"
			? await ctx.ui.custom<Awaited<ReturnType<typeof start>>>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Creating a worktree for epic #${id}...`);
					start().then(done, (error) => done({ ok: false, note: String(error) }));
					return loader;
				})
			: await start();

	if (!started.ok || !started.epic) return void ctx.ui.notify(started.note, "error");

	// Every database write has to land before the switch: the session that
	// makes them is about to be torn down.
	await transitionStatus(story!.id, { status: "in_progress" });
	refreshStatus(ctx);
	tracked.epicId = started.epic.epic_id;

	if (mode !== "worktree" || !started.epic.path) {
		return void ctx.ui.notify(started.note, "info");
	}

	const note = started.note;
	const worktree = started.epic.path;
	const moved = await relocateSession(ctx, worktree, async (rc) => {
		await report(
			rc,
			`${note}\n\nThis session has moved into the worktree at ${worktree}. Work here; /merge-epic will bring it back.`,
		);
	});
	if (!moved.ok) {
		// The worktree exists and the epic is recorded; only the session
		// failed to follow. Say exactly that, because the recovery is to open
		// pi in the worktree, not to start the epic again.
		ctx.ui.notify(
			`${note}\nBut the session could not move: ${moved.note}. Start pi in ${worktree} to work on it.`,
			"warning",
		);
	}
}

export async function mergeEpicCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const { epic, error } = resolveEpic(args);
	if (!epic) return void ctx.ui.notify(error!, "error");
	if (epic.state !== "active") return void ctx.ui.notify(`Epic #${epic.epic_id} is already ${epic.state}.`, "warning");

	const gate = checkCanMerge({
		epic,
		baseCheckedOutAt: await branchCheckoutLocation(tracked.git, tracked.paths.repoRoot, epic.base_branch),
		repoRoot: tracked.paths.repoRoot,
		mainCheckoutEpicId: getActiveBranchModeEpic(tracked.db)?.epic_id ?? null,
	});
	if (!gate.ok) return void ctx.ui.notify(`Cannot merge: ${gate.reason}`, "error");

	// Re-run step 1 in case the base branch moved since the epic closed;
	// step 2 is fast-forward-only and would otherwise refuse. It runs in the
	// worktree, so conflicts land where the agent has been working.
	const updated = await serializeGit(() => updateFromBase(tracked, epic));
	if (!updated.ok) return void ctx.ui.notify(updated.note, "error");

	// Merging rewrites the branch the user is on, so it is always confirmed.
	if (ctx.hasUI) {
		const choice = await ctx.ui.select(`Merge ${epic.branch} into ${epic.base_branch}?`, [
			`Yes, fast-forward ${epic.base_branch}`,
			"No, leave the branch for me",
		]);
		if (!choice?.startsWith("Yes")) return void ctx.ui.notify("Left the epic branch as it is.", "info");
	} else {
		return void ctx.ui.notify(
			`Epic #${epic.epic_id} is ready, but merging needs confirmation. Run /merge-epic interactively.`,
			"warning",
		);
	}

	// If this session is standing in the worktree we are about to delete, it
	// has to move out first — removing the directory a session is sitting in
	// breaks the session.
	const inside = sessionIsInsideWorktreeOf(epic);
	if (!inside) return void (await finishMerge(epic, ctx));

	const epicId = epic.epic_id;
	const moved = await relocateSession(ctx, tracked.paths.repoRoot, async (rc) => {
		const fresh = getEpicBranch(ensureTracker().db, epicId);
		if (fresh) await finishMerge(fresh, rc);
	});
	if (!moved.ok) {
		ctx.ui.notify(`Nothing merged: ${moved.note}. The epic is untouched.`, "error");
	}
}

export async function cancelEpicCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const { epic, error } = resolveEpic(args);
	if (!epic) return void ctx.ui.notify(error!, "error");

	// Same reason as /merge-epic: cancelling a worktree epic removes its
	// directory, and a session cannot be standing in it when that happens.
	const inside = sessionIsInsideWorktreeOf(epic);
	if (!inside) return void (await finishCancel(epic, ctx));

	const epicId = epic.epic_id;
	const moved = await relocateSession(ctx, tracked.paths.repoRoot, async (rc) => {
		const fresh = getEpicBranch(ensureTracker().db, epicId);
		if (fresh) await finishCancel(fresh, rc);
	});
	if (!moved.ok) {
		ctx.ui.notify(`Nothing cancelled: ${moved.note}. The epic is untouched.`, "error");
	}
}

export async function undoStoryCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const id = Number(parseCommandArgs(args).tokens[0]);
	if (!Number.isInteger(id)) return void ctx.ui.notify("Usage: /undo-story <story_id>", "error");

	const epic = findEpicForStory(tracked, id);
	if (!epic) return void ctx.ui.notify(`Story #${id} is not part of an active epic.`, "error");

	const result = await serializeGit(() => undoStory(tracked, id, epic));
	ctx.ui.notify(result.note, result.ok ? "info" : "error");
}

export async function undoMergeCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const raw = parseCommandArgs(args).tokens[0] ?? "";
	const db = tracked.db;
	// Unlike the others this defaults to the most recently merged epic,
	// because by definition no epic is active once its merge has landed.
	// "Most recent" is by `updated_at` — when the merge landed — not by when
	// the epic started; with concurrent epics those are different questions.
	const epic = raw ? getEpicBranch(db, Number(raw)) : getLastMergedEpicBranch(db);
	if (!epic) return void ctx.ui.notify("No merged epic to undo — pass a story id.", "error");

	const result = await serializeGit(() => undoMerge(tracked, epic));
	ctx.ui.notify(result.note, result.ok ? "info" : "error");
}

export async function undoTurnCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
	const tracked = ensureTracker();
	const epic = sessionEpic();
	if (!epic) {
		return void ctx.ui.notify(
			"This session is not working on an epic, so no checkpoints are being taken.",
			"warning",
		);
	}

	const result = await serializeGit(() => restoreLastCheckpoint(tracked, epic));
	ctx.ui.notify(result.note, result.ok ? "info" : "error");
}
