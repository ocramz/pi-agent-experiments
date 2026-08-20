import { StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { Text, matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { randomUUID } from "node:crypto";
import {
	closeDb,
	createStory,
	deleteStories,
	getAllStories,
	getAppState,
	getDb,
	getHistory,
	getStoriesByStatus,
	getStoryById,
	logHistory,
	searchStories,
	setAppState,
	updateStory,
} from "../src/database.ts";
import type { Story } from "../src/types.ts";

// ─── State ──────────────────────────────────────────────────────────
let dbPath: string | null = null;

// ─── Helpers ────────────────────────────────────────────────────────
function ensureDb() {
	if (!dbPath) throw new Error("Database not initialized (session not started)");
	return getDb(dbPath);
}

function storyToText(story: Story, compact = true): string {
	const lines = [
		`#${story.id} [${story.status}] ${story.title}`,
	];
	if (!compact) {
		lines.push(`  Sub-goal: ${story.sub_goal}`);
		lines.push("  Proposed changes:");
		for (const line of story.proposed_changes.split("\n")) {
			lines.push(`    ${line}`);
		}
		if (story.depends_on.length) {
			lines.push(`  Depends on: ${story.depends_on.join(", ")}`);
		}
		if (story.next_id) {
			lines.push(`  Next: #${story.next_id}`);
		}
	} else {
		lines[0] += ` — ${story.sub_goal.slice(0, 60)}${story.sub_goal.length > 60 ? "…" : ""}`;
	}
	return lines.join("\n");
}

function isDbReady() {
	try {
		ensureDb();
		return true;
	} catch {
		return false;
	}
}

// ─── Schema ─────────────────────────────────────────────────────────
const StoryParams = Type.Object({
	action: StringEnum(["create", "update", "delete", "list", "mark_done", "mark_in_progress", "reorder", "simplify", "get_next", "search", "set_top_level"] as const),

	title: Type.Optional(Type.String({ description: "Title (for create / update / simplify)" })),
	sub_goal: Type.Optional(Type.String({ description: "Sub-goal (for create / update)" })),
	proposed_changes: Type.Optional(Type.String({ description: "Proposed changes (for create / update)" })),
	story_id: Type.Optional(Type.Number({ description: "Target story ID" })),
	status: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	depends_on: Type.Optional(Type.Array(Type.Number(), { description: "Dependency story IDs (for create / update)" })),
	next_story_id: Type.Optional(Type.Number({ description: "Next linked story ID (for create / update)" })),

	status_filter: Type.Optional(StringEnum(["draft", "ready", "in_progress", "done", "cancelled", "archived"] as const)),
	query: Type.Optional(Type.String({ description: "Search query" })),
	ordered_ids: Type.Optional(Type.Array(Type.Number(), { description: "Ordered IDs for reorder" })),
	source_ids: Type.Optional(Type.Array(Type.Number(), { description: "Source IDs to merge via simplify" })),
	merged_title: Type.Optional(Type.String({ description: "Title for merged story (simplify)" })),
});

// ─── Extension ──────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
	// ── Session lifecycle ────────────────────────────────────────────
	pi.on("session_start", async (event, ctx) => {
		const cwd = event.cwd ?? process.cwd();
		const base = cwd.startsWith("/tmp") ? process.cwd() : cwd;
		dbPath = `${base}/.pi/stories.db`;
		const db = ensureDb();

		if (ctx.hasUI) {
			const total = getAllStories(db).filter((s) => s.status !== "done" && s.status !== "cancelled" && s.status !== "archived").length;
			if (total > 0) {
				ctx.ui.setStatus("issue-tracker", `${total} open story(ies)`);
			}
		}
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// ── Context injection ─────────────────────────────────────────────
	pi.on("before_agent_start", async (_event, _ctx) => {
		if (!isDbReady()) return;
		const db = ensureDb();

		const allOpen = getAllStories(db).filter(
			(s) => s.status !== "done" && s.status !== "cancelled" && s.status !== "archived",
		);

		// 1. Ready story to work on now (topological: all deps done, then by priority/id)
		const readyStories = getStoriesByStatus(db, "ready");
		const readyToWork = readyStories
			.filter((s) => s.depends_on.every((depId) => getStoryById(db, depId)?.status === "done"))
			.sort((a, b) => a.priority - b.priority || a.id - b.id)[0] ?? null;

		// 2. Top-level story (big picture)
		const topLevelIdRaw = getAppState(db, "top_level_story_id");
		const topLevelStory = topLevelIdRaw ? getStoryById(db, Number(topLevelIdRaw)) : null;

		// 3. Story just closed in previous turn
		const lastClosedIdRaw = getAppState(db, "last_closed_story_id");
		const justClosed = lastClosedIdRaw ? getStoryById(db, Number(lastClosedIdRaw)) : null;
		if (lastClosedIdRaw) {
			setAppState(db, "last_closed_story_id", "");
		}

		// 4. Other in-progress stories
		const inProgressStories = getStoriesByStatus(db, "in_progress").sort(
			(a, b) => a.priority - b.priority || a.id - b.id,
		);
		const primaryFocus = readyToWork ?? inProgressStories[0] ?? null;
		const otherInProgress = inProgressStories.filter((s) => s.id !== primaryFocus?.id);

		const hasAnythingToShow = primaryFocus || topLevelStory || justClosed || otherInProgress.length > 0 || allOpen.length > 0;
		if (!hasAnythingToShow) return;

		const lines: string[] = [">>> STORY CONTEXT"];

		if (readyToWork) {
			lines.push(`\n>>> NEXT UP — work on this now`);
			lines.push(`#${readyToWork.id}: ${readyToWork.title}`);
			lines.push(`Sub-goal: ${readyToWork.sub_goal}`);
			lines.push(`Changes: ${readyToWork.proposed_changes}`);
			if (readyToWork.depends_on.length) {
				lines.push(`Dependencies met: ${readyToWork.depends_on.map((id) => `#${id}`).join(", ")}`);
			}
		} else if (inProgressStories.length > 0) {
			const p = inProgressStories[0];
			lines.push(`\n>>> IN PROGRESS — continue working on this`);
			lines.push(`#${p.id}: ${p.title}`);
			lines.push(`Sub-goal: ${p.sub_goal}`);
			lines.push(`Changes: ${p.proposed_changes}`);
		} else {
			lines.push(`\n>>> NO ACTIVE WORK — no ready or in-progress stories`);
		}

		if (topLevelStory) {
			lines.push(`\n>>> BIG PICTURE`);
			lines.push(`#${topLevelStory.id}: ${topLevelStory.title}`);
			lines.push(`${topLevelStory.sub_goal}`);
		}

		if (justClosed) {
			lines.push(`\n>>> JUST COMPLETED (previous turn)`);
			lines.push(`#${justClosed.id}: ${justClosed.title}`);
		}

		if (otherInProgress.length > 0) {
			lines.push(`\n>>> ALSO IN PROGRESS`);
			const selection = otherInProgress.slice(0, 5);
			for (const s of selection) {
				lines.push(`  ▶ #${s.id}: ${s.title} — ${s.sub_goal.slice(0, 60)}${s.sub_goal.length > 60 ? "…" : ""}`);
			}
			if (otherInProgress.length > 5) {
				lines.push(`  ... ${otherInProgress.length - 5} more`);
			}
		}

		return {
			message: {
				customType: "story-context",
				content: lines.join("\n"),
				display: true,
			},
		};
	});

	// ── Story Tool ──────────────────────────────────────────────────
	pi.registerTool({
		name: "story",
		label: "Story",
		description:
			"Issue tracker for self-contained work chunks (user stories). Actions: create (title, sub_goal, proposed_changes, status, next_story_id, depends_on), update (story_id + fields), delete (story_id), list (status_filter), search (query), mark_in_progress (story_id), mark_done (story_id), get_next (fetch top ready), reorder (ordered_ids), simplify (source_ids + merged_title), set_top_level (story_id).",
		parameters: StoryParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const db = ensureDb();
			const { action } = params;

			// ── create ─────────────────────────────────────────────
			if (action === "create") {
				if (!params.title || !params.sub_goal) {
					return { content: [{ type: "text", text: "Error: title and sub_goal are required for create" }], details: { action, error: "missing fields" } };
				}
				const story = createStory(db, {
					title: params.title,
					sub_goal: params.sub_goal,
					proposed_changes: params.proposed_changes ?? "",
					status: params.status ?? "draft",
					priority: 0,
					parent_id: null,
					next_id: params.next_story_id ?? null,
					depends_on: params.depends_on ?? [],
				});
				return {
					content: [{ type: "text", text: `Created story #${story.id}: ${story.title}\n\n${storyToText(story, false)}` }],
					details: { action, story },
				};
			}

			// ── update ─────────────────────────────────────────────
			if (action === "update") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for update" }], details: { action, error: "missing story_id" } };
				}
				const story = updateStory(db, params.story_id, {
					title: params.title,
					sub_goal: params.sub_goal,
					proposed_changes: params.proposed_changes,
					status: params.status,
					next_id: params.next_story_id,
					depends_on: params.depends_on,
				});
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				return {
					content: [{ type: "text", text: `Updated story #${story.id}:\n${storyToText(story, false)}` }],
					details: { action, story },
				};
			}

			// ── delete ─────────────────────────────────────────────
			if (action === "delete") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for delete" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				deleteStories(db, [params.story_id]);
				return {
					content: [{ type: "text", text: `Deleted story #${params.story_id}: ${story.title}` }],
					details: { action, deleted: story },
				};
			}

			// ── mark_in_progress ───────────────────────────────────
			if (action === "mark_in_progress") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for mark_in_progress" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				// dependency check
				const unmet = story.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
				if (unmet.length > 0) {
					return {
						content: [{ type: "text", text: `Cannot start: dependencies not done — ${unmet.map((id) => `#${id}`).join(", ")}` }],
						details: { action, error: "unmet dependencies", unmet },
					};
				}
				const updated = updateStory(db, params.story_id, { status: "in_progress" });
				if (!updated) {
					return { content: [{ type: "text", text: "Update failed unexpectedly" }], details: { action, error: "update failed" } };
				}
				return {
					content: [{ type: "text", text: `✓ Story #${updated.id} is now IN PROGRESS\n${storyToText(updated, false)}` }],
					details: { action, story: updated },
				};
			}

			// ── list ──────────────────────────────────────────────
			if (action === "list") {
				const validStatuses = new Set<Story["status"]>(["draft", "ready", "in_progress", "done", "cancelled", "archived"]);
				const stories = params.status_filter && validStatuses.has(params.status_filter as Story["status"])
					? getStoriesByStatus(db, params.status_filter as Story["status"])
					: getAllStories(db);
				if (stories.length === 0) {
					return {
						content: [{ type: "text", text: "No stories found." }],
						details: { action, stories: [] },
					};
				}
				const text = stories.map((s) => storyToText(s, false)).join("\n\n");
				return {
					content: [{ type: "text", text }],
					details: { action, stories },
				};
			}

			// ── search ─────────────────────────────────────────────
			if (action === "search") {
				if (!params.query) {
					return { content: [{ type: "text", text: "Error: query required for search" }], details: { action, error: "missing query" } };
				}
				const stories = searchStories(db, params.query);
				const text = stories.length ? stories.map((s) => storyToText(s, false)).join("\n\n") : "No matches.";
				return {
					content: [{ type: "text", text }],
					details: { action, stories },
				};
			}

			// ── mark_done ──────────────────────────────────────────
			if (action === "mark_done") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for mark_done" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				// dependency check
				const unmet = story.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
				if (unmet.length > 0) {
					return {
						content: [{ type: "text", text: `Cannot mark done: dependencies not done — ${unmet.map((id) => `#${id}`).join(", ")}` }],
						details: { action, error: "unmet dependencies", unmet },
					};
				}
				const updated = updateStory(db, params.story_id, { status: "done" });
				if (!updated) {
					return { content: [{ type: "text", text: "Update failed unexpectedly" }], details: { action, error: "update failed" } };
				}
				setAppState(db, "last_closed_story_id", String(updated.id));

				// Promote next if ready and dependencies met
				let nextMsg = "";
				if (updated.next_id) {
					const next = getStoryById(db, updated.next_id);
					if (next && next.status !== "done" && next.status !== "cancelled") {
						const nextUnmet = next.depends_on.filter((id) => getStoryById(db, id)?.status !== "done");
						if (nextUnmet.length === 0 && next.status !== "in_progress") {
							updateStory(db, next.id, { status: "ready" });
							nextMsg = `\n\n>>> NEXT UP: Story #${next.id} is now READY.\nTitle: ${next.title}\nSub-goal: ${next.sub_goal}\nProposed changes: ${next.proposed_changes}`;
						} else if (nextUnmet.length > 0) {
							nextMsg = `\n\nNext story #${next.id} (${next.title}) is still waiting on dependencies: ${nextUnmet.map((id) => `#${id}`).join(", ")}`;
						}
					}
				}

				return {
					content: [{ type: "text", text: `✓ Story #${updated.id} marked as DONE.${nextMsg}` }],
					details: { action, story: updated, nextMessage: nextMsg },
				};
			}

			// ── get_next ──────────────────────────────────────────
			if (action === "get_next") {
				const ready = getStoriesByStatus(db, "ready");
				const topReady = ready.find((s) => s.depends_on.every((id) => getStoryById(db, id)?.status === "done"));
				if (!topReady) {
					return {
						content: [{ type: "text", text: "No ready stories available right now." }],
						details: { action, story: null },
					};
				}
				return {
					content: [{ type: "text", text: `Next story to work on:\n${storyToText(topReady, false)}` }],
					details: { action, story: topReady },
				};
			}

			// ── set_top_level ────────────────────────────────────
			if (action === "set_top_level") {
				if (!params.story_id) {
					return { content: [{ type: "text", text: "Error: story_id required for set_top_level" }], details: { action, error: "missing story_id" } };
				}
				const story = getStoryById(db, params.story_id);
				if (!story) {
					return { content: [{ type: "text", text: `Story #${params.story_id} not found` }], details: { action, error: "not found" } };
				}
				setAppState(db, "top_level_story_id", String(story.id));
				return {
					content: [{ type: "text", text: `Top-level story set to #${story.id}: ${story.title}` }],
					details: { action, story },
				};
			}

			// ── reorder ──────────────────────────────────────────
			if (action === "reorder") {
				if (!params.ordered_ids || params.ordered_ids.length === 0) {
					return { content: [{ type: "text", text: "Error: ordered_ids required for reorder" }], details: { action, error: "missing ordered_ids" } };
				}
				// Validate all IDs exist
				for (const id of params.ordered_ids) {
					if (!getStoryById(db, id)) {
						return { content: [{ type: "text", text: `Story #${id} not found` }], details: { action, error: "not found" } };
					}
				}
				// Assign priority and chain next_id
				for (let i = 0; i < params.ordered_ids.length; i++) {
					const id = params.ordered_ids[i];
					const nextId = i + 1 < params.ordered_ids.length ? params.ordered_ids[i + 1] : null;
					updateStory(db, id, { priority: i, next_id: nextId });
				}
				const reordered = params.ordered_ids.map((id) => getStoryById(db, id)!);
				return {
					content: [{ type: "text", text: `Reordered ${reordered.length} stories. New order:\n${reordered.map((s) => `#${s.id}: ${s.title}`).join("\n")}` }],
					details: { action, stories: reordered },
				};
			}

			// ── simplify ─────────────────────────────────────────
			if (action === "simplify") {
				if (!params.source_ids || params.source_ids.length < 2) {
					return { content: [{ type: "text", text: "Error: simplify requires at least 2 source_ids" }], details: { action, error: "not enough sources" } };
				}
				const sources = params.source_ids.map((id) => getStoryById(db, id)).filter(Boolean) as Story[];
				if (sources.length < 2) {
					return { content: [{ type: "text", text: "Error: could not locate all source stories" }], details: { action, error: "missing sources" } };
				}
				const mergedTitle = params.merged_title ?? `Merged: ${sources.map((s) => s.title).join(" + ")}`;
				const mergedSubGoal = sources.map((s) => s.sub_goal).join("\n");
				const mergedChanges = sources.map((s) => s.proposed_changes).join("\n---\n");
				const first = sources[0];
				const merged = createStory(db, {
					title: mergedTitle,
					sub_goal: mergedSubGoal,
					proposed_changes: mergedChanges,
					status: first.status === "done" ? "done" : first.status === "in_progress" ? "in_progress" : "ready",
					priority: first.priority,
					parent_id: null,
					next_id: first.next_id,
					depends_on: [...new Set(sources.flatMap((s) => s.depends_on))],
				});
				// Archive old ones
				for (const s of sources) {
					updateStory(db, s.id, { status: "archived" });
				}
				return {
					content: [
						{
							type: "text",
							text: `Simplified ${sources.length} stories into #${merged.id}: ${merged.title}\n\nSources archived: ${sources.map((s) => `#${s.id}`).join(", ")}\n\n${storyToText(merged, false)}`,
						},
					],
					details: { action, merged, sources },
				};
			}

			return { content: [{ type: "text", text: `Unknown action: ${action}` }], details: { action, error: "unknown" } };
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

	// /stories — show a scrollable list in TUI
	pi.registerCommand("stories", {
		description: "Open the story board (interactive list)",
		handler: async (_args, ctx) => {
			if (!isDbReady()) {
				if (ctx.hasUI) ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const all = getAllStories(db);
			if (ctx.mode !== "tui") {
				const open = all.filter((s) => s.status !== "done" && s.status !== "cancelled" && s.status !== "archived");
				const text = open.map((s) => storyToText(s, true)).join("\n") || "All stories are closed.";
				if (ctx.hasUI) ctx.ui.notify(`${all.length} stories total, ${open.length} open:\n\n${text}`, "info");
				return;
			}

			const result = await ctx.ui.custom<Story | null>((tui, theme, _kb, done) => {
				let selectedIndex = 0;
				let cachedLines: string[] | undefined;
				let widthCached = 0;

				function refresh() {
					cachedLines = undefined;
					tui.requestRender();
				}

				function handleInput(data: string) {
					if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
						done(null);
						return;
					}
					if (matchesKey(data, "up")) {
						selectedIndex = Math.max(0, selectedIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, "down")) {
						selectedIndex = Math.min(all.length - 1, selectedIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, "r") && all[selectedIndex]) {
						updateStory(db, all[selectedIndex].id, { status: "ready" });
						all[selectedIndex] = { ...all[selectedIndex], status: "ready" };
						refresh();
						return;
					}
					if (matchesKey(data, "s") && all[selectedIndex]) {
						updateStory(db, all[selectedIndex].id, { status: "in_progress" });
						all[selectedIndex] = { ...all[selectedIndex], status: "in_progress" };
						refresh();
						return;
					}
					if (matchesKey(data, "d") && all[selectedIndex]) {
						updateStory(db, all[selectedIndex].id, { status: "done" });
						all[selectedIndex] = { ...all[selectedIndex], status: "done" };
						refresh();
						return;
					}
					if (matchesKey(data, "x") && all[selectedIndex]) {
						updateStory(db, all[selectedIndex].id, { status: "cancelled" });
						all[selectedIndex] = { ...all[selectedIndex], status: "cancelled" };
						refresh();
						return;
					}
					if (matchesKey(data, "enter")) {
						done(all[selectedIndex] ?? null);
					}
				}

				function render(width: number): string[] {
					if (cachedLines && widthCached === width) return cachedLines;
					const lines: string[] = [];
					lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
					lines.push(` ${theme.fg("accent", theme.bold("Story Board"))}  ${theme.fg("muted", `${all.filter((s) => s.status !== "done" && s.status !== "cancelled" && s.status !== "archived").length} open`)}`);
					lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));

					if (all.length === 0) {
						lines.push(`  ${theme.fg("dim", "No stories yet. Use /plan-stories <goal> to create some.")}`);
					}

					for (let i = 0; i < all.length; i++) {
						const s = all[i];
						const isActive = i === selectedIndex;
						const statusColor =
							s.status === "done"
								? "success"
								: s.status === "in_progress"
									? "accent"
									: s.status === "ready"
										? "text"
										: "dim";
						const prefix = isActive ? theme.fg("accent", "> ") : "  ";
						const row = `${prefix}${theme.fg(statusColor, `[${s.status}]`)} ${theme.fg("accent", `#${s.id}`)} ${theme.fg("text", s.title)}`;
						lines.push(row);
						if (isActive) {
							lines.push(`     ${theme.fg("dim", s.sub_goal.slice(0, width - 6))}`);
							if (s.next_id) {
								lines.push(`     ${theme.fg("dim", `Next → #${s.next_id}`)}`);
							}
						}
					}

					lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));
					lines.push(`  ${theme.fg("dim", "↑↓ navigate • R ready • S start • D done • X cancel • Enter detail • Esc close")}`);
					lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
					cachedLines = lines;
					widthCached = width;
					return lines;
				}

				return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
			});

			if (result) {
				ctx.ui.notify(`Selected #${result.id}: ${result.title}`, "info");
			}
		},
	});

	// /stories plan <goal>
	pi.registerCommand("plan-stories", {
		description: "Break down a high-level goal into user stories",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/plan-stories requires interactive mode", "error");
				return;
			}
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /plan-stories <high-level goal>", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("No model selected", "error");
				return;
			}

			// First pass: ask for clarifications or a story breakdown
			const systemPrompt = `You are a requirements assistant. The user wants to break down a high-level goal into user stories.\n\nFirst, determine if the goal is ambiguous or needs clarification. If so, respond with a short list of 1-3 clarifying questions, prefixed by ">>> CLARIFY:".\n\nIf the goal is clear enough, respond ONLY with a JSON array of user stories. Each story must have:\n- title (string)\n- sub_goal (string, 1-2 sentences)\n- proposed_changes (string, bullet or numbered list of concrete code/file changes)\n- depends_on (array of 0-based indices referencing earlier array items; optional)\n\nDo NOT include markdown code fences around the JSON. Keep it compact and valid JSON. If dependencies exist, ensure they reference earlier indices only.`;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			let storiesJson: Array<{ title: string; sub_goal: string; proposed_changes: string; depends_on?: number[] }> | null = null;
			let clarifications: string[] | null = null;
			let turn = 0;
			const maxTurns = 3;

			while (turn < maxTurns && !storiesJson) {
				const contentText = turn === 0 && !clarifications
					? goal
					: `Goal: ${goal}\n\n${clarifications ? `Clarifications:\n${clarifications.join("\n")}` : ""}`;

				// Run model call with persistent loader so the user sees activity and can abort
				const responseText = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, `Planning stories (turn ${turn + 1}/${maxTurns}) using ${ctx.model!.id}…`);
					loader.onAbort = () => done(null);

					const doPlan = async () => {
						try {
							const response = await ctx.modelRegistry.complete(
								ctx.model!,
								{
									systemPrompt,
									messages: [
										{ role: "user" as const, content: [{ type: "text" as const, text: contentText }], timestamp: Date.now() },
									],
								},
								{ cacheRetention: "none", sessionId: randomUUID(), signal: loader.signal },
							);
							if (response.stopReason === "aborted") return null;
							return response.content
								.filter((c): c is { type: "text"; text: string } => c.type === "text")
								.map((c) => c.text)
								.join("\n")
								.trim();
						} catch (err) {
							console.error("plan-stories model call failed:", err);
							return null;
						}
					};

					doPlan().then(done).catch(() => done(null));
					return loader;
				});

				if (responseText === null) {
					ctx.ui.notify("Planning cancelled or failed. Check logs for details.", "info");
					return;
				}

				if (responseText.includes(">>> CLARIFY")) {
					const qs = responseText.split(">>> CLARIFY")[1]?.split("\n").filter((l) => l.trim().startsWith("-") || l.trim().match(/^\d+\./)) ?? [];
					if (qs.length === 0) {
						// Unexpected format, treat as JSON attempt
						try {
							storiesJson = JSON.parse(responseText);
						} catch {
							ctx.ui.notify("Could not parse plan response. Aborting.", "error");
							return;
						}
					} else {
						// Ask user clarifications via select/input
						const answers: string[] = [];
						for (let i = 0; i < qs.length; i++) {
							const q = qs[i].replace(/^[-\d\.\s]+/, "").trim();
							const ans = await ctx.ui.input(`Clarification ${i + 1}/${qs.length}`, q);
							if (ans === undefined) {
								ctx.ui.notify("Planning cancelled", "info");
								return;
							}
							answers.push(`${q}\nAnswer: ${ans}`);
						}
						clarifications = answers;
					}
				} else {
					try {
						storiesJson = JSON.parse(responseText);
					} catch {
						ctx.ui.notify("Could not parse JSON plan. Aborting.", "error");
						return;
					}
				}
				turn++;
			}

			if (!storiesJson || !Array.isArray(storiesJson) || storiesJson.length === 0) {
				ctx.ui.notify("No stories generated after clarification loop.", "warning");
				return;
			}

			// Insert into DB, link next_id
			const createdIds: number[] = [];
			for (let i = 0; i < storiesJson.length; i++) {
				const item = storiesJson[i];
				const dependsOn = (item.depends_on ?? [])
					.map((idx) => createdIds[idx])
					.filter((id): id is number => id !== undefined);
				const nextId = i + 1 < storiesJson.length ? -1 : null; // placeholder
				const story = createStory(db, {
					title: item.title,
					sub_goal: item.sub_goal,
					proposed_changes: item.proposed_changes ?? "",
					status: "draft",
					priority: i,
					parent_id: null,
					next_id: nextId,
					depends_on: dependsOn,
				});
				createdIds.push(story.id);
			}
			// Fix next_id chain
			for (let i = 0; i < createdIds.length; i++) {
				const nextId = i + 1 < createdIds.length ? createdIds[i + 1] : null;
				updateStory(db, createdIds[i], { next_id: nextId });
			}

			ctx.ui.notify(`Created ${createdIds.length} stories. Use /stories to view.`, "info");
		},
	});

	// /top-story <id>
	pi.registerCommand("top-story", {
		description: "Set the top-level story for big-picture context",
		handler: async (args, ctx) => {
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const id = Number(args.trim());
			if (!id || Number.isNaN(id)) {
				ctx.ui.notify("Usage: /top-story <story_id>", "error");
				return;
			}
			const story = getStoryById(db, id);
			if (!story) {
				ctx.ui.notify(`Story #${id} not found`, "error");
				return;
			}
			setAppState(db, "top_level_story_id", String(story.id));
			ctx.ui.notify(`Top-level story set to #${story.id}: ${story.title}`, "info");
		},
	});

	// /stories export [path]
	pi.registerCommand("export-stories", {
		description: "Export stories to a human-readable markdown file",
		handler: async (args, ctx) => {
			if (!isDbReady()) {
				ctx.ui.notify("Story DB not ready", "error");
				return;
			}
			const db = ensureDb();
			const targetPath = (args.trim() || "stories.md").replace(/^~/, process.env.HOME ?? "~");
			const all = getAllStories(db);
			if (all.length === 0) {
				ctx.ui.notify("No stories to export", "warning");
				return;
			}

			const lines: string[] = ["# User Stories", ""];
			for (const s of all) {
				lines.push(`## ${s.status === "in_progress" ? "▶" : s.status === "done" ? "✓" : s.status === "ready" ? "○" : "•"} #${s.id}: ${s.title}`);
				lines.push(`**Status:** ${s.status}`);
				lines.push(`**Sub-goal:** ${s.sub_goal}`);
				lines.push("**Proposed changes:**");
				for (const change of s.proposed_changes.split("\n")) {
					lines.push(`- ${change}`);
				}
				if (s.depends_on.length) {
					lines.push(`**Depends on:** ${s.depends_on.map((id) => `#${id}`).join(", ")}`);
				}
				if (s.next_id) {
					lines.push(`**Next →** #${s.next_id}`);
				}
				lines.push("");
			}

			const { writeFileSync } = await import("node:fs");
			const { isAbsolute, join } = await import("node:path");
			const outPath = isAbsolute(targetPath) ? targetPath : join(process.cwd(), targetPath);
			writeFileSync(outPath, lines.join("\n"), "utf-8");
			ctx.ui.notify(`Exported ${all.length} stories to ${outPath}`, "info");
		},
	});
}
