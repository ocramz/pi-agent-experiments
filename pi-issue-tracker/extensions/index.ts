/**
 * Every tool, command and event this extension registers — and nothing else.
 *
 * Each entry is declared here in full, prompt text and all: what pi is told
 * about a tool is what a reader wants to find beside its name. Each *handler* is
 * one call away — into `extensions/` for the parts that need pi (the board
 * painter, the planner's loader, the epic commands' dialogs and session
 * relocation), and into `src/` for everything else, where `node --test` reaches
 * it without a pi runtime.
 *
 * The boundary that makes that work: `src/` must not import from
 * `@earendil-works/*`. See src/README.md.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { runStoryAction, type StoryActionParams } from "../src/actions.ts";
import { getAllStories, getStoryById, setAppState } from "../src/database.ts";
import { storiesToMarkdown } from "../src/format.ts";
import { buildStoryContext, STORY_CONTEXT_TYPE } from "../src/injection.ts";
import { gatherFindings, type ReviewGate } from "../src/review.ts";
import { formatFindings, isBranchEscapingCommand, pruneStaleInjections } from "../src/rules.ts";
import { writeCheckpoint } from "../src/epic.ts";
import { REVIEW_VERDICTS, STORY_RESOLUTIONS, type Story } from "../src/types.ts";
import { openBoard } from "./board.ts";
import {
	cancelEpicCommand,
	mergeEpicCommand,
	startEpicCommand,
	undoMergeCommand,
	undoStoryCommand,
	undoTurnCommand,
} from "./epic-commands.ts";
import { runPlanner } from "./planner.ts";
import {
	buildReviewer,
	endSession,
	ensureDb,
	ensureTracker,
	isDbReady,
	maybeTracker,
	refreshStatus,
	reportReviewUsage,
	serializeGit,
	sessionEpic,
	startSession,
} from "./runtime.ts";

// ─── Schema ─────────────────────────────────────────────────────────
const StoryParams = Type.Object({
	action: StringEnum(["create", "update", "delete", "list", "mark_done", "mark_in_progress", "reorder", "simplify", "get_next", "search", "set_top_level", "review_plan", "review_work"] as const),

	title: Type.Optional(Type.String({ description: "Title (for create / update / simplify)" })),
	sub_goal: Type.Optional(Type.String({ description: "Sub-goal (for create / update)" })),
	proposed_changes: Type.Optional(Type.String({ description: "Proposed changes (for create / update)" })),
	story_id: Type.Optional(Type.Number({ description: "Target story ID" })),
	status: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	depends_on: Type.Optional(Type.Array(Type.Number(), { description: "Dependency story IDs (for create / update)" })),
	next_story_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Next linked story ID (for create / update). Pass null to unlink." })),
	parent_story_id: Type.Optional(Type.Union([Type.Number(), Type.Null()], { description: "Parent story ID (for create / update). Pass null to detach from its parent." })),

	resolution: Type.Optional(
		StringEnum(STORY_RESOLUTIONS, {
			description:
				"Why the story closed (required for mark_done): completed = built as planned; superseded = replaced by other work; obsolete = no longer needed; wontfix = decided against; duplicate = already covered elsewhere.",
		}),
	),
	resolution_note: Type.Optional(Type.String({ description: "One line of detail on the resolution, e.g. 'Merged into #12'" })),
	learnings: Type.Optional(
		Type.String({
			description:
				"Only set this if something CONTRADICTED proposed_changes — an assumption that proved false, an API that behaved differently than expected, a hidden dependency. If the implementation matched the plan, omit this field. Most stories should have no learnings.",
		}),
	),

	handoff_notes: Type.Optional(
		Type.String({
			description:
				"REQUIRED for mark_done. What the next person needs to know to pick up from here: where the work lives, what was not obvious, what you deliberately left undone. Unlike learnings, every story should have one. Write it for someone who has not read this conversation.",
		}),
	),
	verdict: Type.Optional(
		StringEnum(REVIEW_VERDICTS, {
			description:
				"Your review verdict (review_plan / review_work). Omit on the first call to get the findings first. Refused outright when a reviewer model is configured — the verdict is then not yours to set.",
		}),
	),
	findings: Type.Optional(
		Type.String({ description: "What your review found (review_plan / review_work), alongside your verdict." }),
	),

	status_filter: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	query: Type.Optional(Type.String({ description: "Search query" })),
	ordered_ids: Type.Optional(Type.Array(Type.Number(), { description: "Ordered IDs for reorder" })),
	source_ids: Type.Optional(Type.Array(Type.Number(), { description: "Source IDs to merge via simplify" })),
	merged_title: Type.Optional(Type.String({ description: "Title for merged story (simplify)" })),
});

// ─── Extension ──────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	// ── Session lifecycle ────────────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => startSession(pi, ctx));
	pi.on("session_shutdown", async () => endSession());

	// ── Context injection ─────────────────────────────────────────────
	pi.on("before_agent_start", async () => {
		const session = maybeTracker();
		if (!session) return;
		const message = buildStoryContext(session);
		return message ? { message } : undefined;
	});

	// pi appends the message above and never replaces it: it lands in the
	// transcript as a `custom` message and `convertToLlm` re-sends every one of
	// them as a user message on every request. So the block naming #12 as "work
	// on this now" is still being sent long after #12 closed, ahead of the block
	// that supersedes it. Only the newest is current.
	//
	// `context` runs on a clone of the message array before each provider request,
	// so pruning here leaves the session history, the TUI scrollback and the HTML
	// export whole — it narrows only what the model is shown.
	pi.on("context", async (event) => {
		const messages = pruneStaleInjections(event.messages, STORY_CONTEXT_TYPE);
		// Unchanged by identity: return bare, so the array reaches the next handler untouched.
		return messages === event.messages ? undefined : { messages };
	});

	// ── Story Tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "story",
		label: "Story",
		description:
			"Issue tracker for self-contained work chunks (user stories). Actions: create (title, sub_goal, proposed_changes, status, next_story_id, depends_on, parent_story_id), update (story_id + fields), delete (story_id), list (status_filter), search (query), review_plan (story_id — call with no verdict first to get findings), mark_in_progress (story_id — needs an approved plan review), review_work (story_id — call with no verdict first), mark_done (story_id + REQUIRED resolution and handoff_notes, optional resolution_note and learnings — needs an approved work review), get_next (fetch top ready), reorder (ordered_ids), simplify (source_ids + merged_title), set_top_level (story_id). Stories form a tree: a story with children is an epic and is never handed out as work.",
		promptSnippet:
			"story: plan, review, track and close units of work. Review gates guard starting and closing; every closed story records a handoff note.",
		// Every guideline names the tool it is about, and spells an action as the
		// call it is. pi concatenates each active tool's guidelines into one flat
		// list alongside its own bash/edit/write advice, with nothing recording
		// whose is whose (agent-session.ts _rebuildSystemPrompt → buildSystemPrompt).
		// `story` is also an ordinary English word, so the bare noun does not name
		// the tool — hence the `story{action:"…"}` form, which is the same idiom
		// the injected context uses.
		promptGuidelines: [
			"Work each unit through the story tool's full cycle: story{action:\"create\"} → review_plan → mark_in_progress → do the work → review_work → mark_done. The two review gates are enforced, so skipping one just makes the next story call fail.",
			"Call story{action:\"review_plan\"} and story{action:\"review_work\"} with only story_id first. They run mechanical checks (dependency cycles, whether the story is an epic, whether `verify` passes) and hand the findings back. A finding marked BLOCKER cannot be approved past — fix it instead.",
			"When a reviewer model is configured it decides the verdict and story{action:\"review_plan\"}/story{action:\"review_work\"} refuse yours. That is deliberate: you do not grade your own work. If the reviewer cannot be reached, nothing is recorded and the gate stays shut.",
			"story{action:\"mark_done\"} requires handoff_notes: what the next person needs to know to pick up from here — entry points, what was not obvious, what you deliberately left undone. Unlike learnings, every story should have one. Handoff notes from related work are injected into later turns, so write for a reader who has not seen this conversation.",
			"Starting, merging and cancelling an epic are the user's to run (/start-epic, /merge-epic, /cancel-epic) — the story tool has no action for them. Ask rather than attempting them yourself.",
		],
		parameters: StoryParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			// Assigning the inferred TypeBox params to the hand-written interface is
			// what keeps the schema above and src/actions.ts from drifting apart.
			const typed: StoryActionParams = params;
			const result = await runStoryAction(ensureTracker(), typed, {
				reviewer: buildReviewer(ctx),
				signal,
			});
			if (result.refreshStatus) refreshStatus(ctx);
			if (result.reviewed) reportReviewUsage(ctx);
			return { content: [{ type: "text", text: result.text }], details: result.details };
		},

		// TUI render
		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("story ")) + theme.fg("muted", String(args.action));
			if (args.story_id !== undefined) text += ` #${args.story_id}`;
			if (args.title) text += ` "${theme.fg("dim", args.title as string)}"`;
			if (args.query) text += ` "${theme.fg("dim", args.query as string)}"`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as Record<string, unknown> | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}
			if (details.story) {
				const s = details.story as Story;
				return new Text(theme.fg("success", "✓ ") + theme.fg("accent", `#${s.id} `) + theme.fg("muted", s.title), 0, 0);
			}
			if (details.merged) {
				const m = details.merged as Story;
				return new Text(theme.fg("success", "✓ Merged into ") + theme.fg("accent", `#${m.id} `) + theme.fg("muted", m.title), 0, 0);
			}
			if (details.stories) {
				const ss = (details.stories as Story[]).slice(0, 5);
				const lines = ss.map((s) => `${theme.fg("accent", `#${s.id}`)} ${theme.fg("muted", s.title)}`).join("\n");
				return new Text(lines + (((details.stories as Story[]).length > 5) ? theme.fg("dim", `\n... ${(details.stories as Story[]).length - 5} more`) : ""), 0, 0);
			}
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	});

	// ── Commands ────────────────────────────────────────────────────
	pi.registerCommand("stories", {
		description: "Open the story board (interactive list)",
		handler: async (_args, ctx) => openBoard(ctx),
	});

	pi.registerCommand("plan-stories", {
		description: "Break down a high-level goal into user stories",
		handler: async (args, ctx) => runPlanner(args, ctx),
	});

	pi.registerCommand("top-story", {
		description: "Set the top-level story for big-picture context",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const db = ensureDb();
			const id = Number(args.trim());
			if (!id || Number.isNaN(id)) return void ctx.ui.notify("Usage: /top-story <story_id>", "error");
			const story = getStoryById(db, id);
			if (!story) return void ctx.ui.notify(`Story #${id} not found`, "error");

			setAppState(db, "top_level_story_id", String(story.id));
			ctx.ui.notify(`Top-level story set to #${story.id}: ${story.title}`, "info");
		},
	});

	pi.registerCommand("export-stories", {
		description: "Export stories to a human-readable markdown file",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const all = getAllStories(ensureDb());
			if (all.length === 0) return void ctx.ui.notify("No stories to export", "warning");

			const targetPath = (args.trim() || "stories.md").replace(/^~/, process.env.HOME ?? "~");
			const { writeFileSync } = await import("node:fs");
			const { isAbsolute, join } = await import("node:path");
			const outPath = isAbsolute(targetPath) ? targetPath : join(process.cwd(), targetPath);
			writeFileSync(outPath, storiesToMarkdown(all), "utf-8");
			ctx.ui.notify(`Exported ${all.length} stories to ${outPath}`, "info");
		},
	});

	pi.registerCommand("review-story", {
		description: "Show the mechanical review findings for a story (usage: /review-story <story_id> [work])",
		handler: async (args, ctx) => {
			if (!isDbReady()) return void ctx.ui.notify("Story DB not ready", "error");
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const id = Number(tokens[0]);
			if (!Number.isInteger(id)) return void ctx.ui.notify("Usage: /review-story <story_id> [work]", "error");
			const story = getStoryById(ensureDb(), id);
			if (!story) return void ctx.ui.notify(`Story #${id} not found`, "error");

			// Read-only on purpose: this is the human's window onto the same checks
			// the tool runs, not a way to record a verdict on the agent's behalf.
			const gate: ReviewGate = tokens[1] === "work" ? "work" : "plan";
			const { findings } = await gatherFindings(ensureTracker(), story, gate);

			const lines = [
				`${gate === "plan" ? "Plan" : "Work"} review — #${story.id} ${story.title}`,
				"",
				formatFindings(findings),
			];
			const recorded = story.review[gate];
			lines.push(
				"",
				recorded
					? `Recorded: ${recorded.verdict} by ${recorded.by} at ${new Date(recorded.at).toISOString()}`
					: "No verdict recorded yet.",
			);
			ctx.ui.notify(lines.join("\n"), findings.some((f) => f.severity === "blocker") ? "warning" : "info");
		},
	});

	// ── Git: epic lifecycle ─────────────────────────────────────────
	// Starting and merging an epic are user actions, never the agent's. Merging
	// rewrites the branch the user is sitting on, and pi can only relocate a
	// session from a command handler, so both live here rather than in the tool.
	pi.registerCommand("start-epic", {
		description:
			"Start an epic on its own branch, or in its own worktree (usage: /start-epic <story_id> [--worktree])",
		handler: startEpicCommand,
	});

	pi.registerCommand("merge-epic", {
		description: "Merge a finished epic into its base branch (usage: /merge-epic [story_id])",
		handler: mergeEpicCommand,
	});

	pi.registerCommand("cancel-epic", {
		description: "Stop an epic without merging; its branch is kept (usage: /cancel-epic [story_id])",
		handler: cancelEpicCommand,
	});

	pi.registerCommand("undo-story", {
		description: "Reverse one story's commit (usage: /undo-story <story_id>)",
		handler: undoStoryCommand,
	});

	pi.registerCommand("undo-merge", {
		description: "Put the base branch back where it was before /merge-epic (usage: /undo-merge [story_id])",
		handler: undoMergeCommand,
	});

	pi.registerCommand("undo-turn", {
		description: "Restore the working tree to the last turn's checkpoint",
		handler: undoTurnCommand,
	});

	// ── Per-turn checkpoints ────────────────────────────────────────
	pi.on("turn_end", async () => {
		const tracked = maybeTracker();
		if (!tracked) return;
		const epic = sessionEpic();
		if (!epic) return;
		await serializeGit(() => writeCheckpoint(tracked, epic));
	});

	// ── Branch guard ────────────────────────────────────────────────
	// The agent cannot be stopped from leaving the epic branch, but the handful
	// of commands that actually strand an epic are cheap to intercept.
	pi.on("tool_call", async (event) => {
		if (event.toolName !== "bash") return;
		if (!maybeTracker()) return;
		const epic = sessionEpic();
		if (!epic) return;

		const command = (event.input as { command?: unknown } | undefined)?.command;
		if (typeof command !== "string" || !isBranchEscapingCommand(command)) return;

		return {
			block: true,
			reason:
				// Addressed to the agent, which cannot run a slash command: this used
				// to tell it to use /merge-epic, which it has no channel to invoke.
				`Epic #${epic.epic_id} is active on ${epic.branch}. Switching branches, hard-resetting or ` +
				`deleting branches would strand its work. Leave the branch alone and keep working; if the epic ` +
				`needs to be merged, cancelled or undone, ask the user to run /merge-epic, /cancel-epic, ` +
				`/undo-story or /undo-turn.`,
		};
	});
}
