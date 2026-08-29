/**
 * The story board's model: what it shows, and what its keys mean.
 *
 * The painting stays in `extensions/` — it needs pi-tui's `theme`, `matchesKey`
 * and `tui.requestRender`, none of which `src/` may import. What lives here is
 * everything the painter reads: the rows, the tone each status is drawn in, the
 * detail lines under the selected row, and what each key writes.
 *
 * Tones are named, not coloured. A theme resolves the name; this file must not
 * know what colour "success" is.
 */

import type { DatabaseSync } from "node:sqlite";
import { hasChildren } from "./database.ts";
import { treeOrder, truncate } from "./format.ts";
import type { Story } from "./types.ts";

export type Tone = "accent" | "muted" | "dim" | "text" | "success" | "warning";

export interface BoardRow {
	story: Story;
	depth: number;
	/** A story with children is an epic — marked, and never a unit of work. */
	isEpic: boolean;
	statusTone: Tone;
}

function toneFor(status: Story["status"]): Tone {
	if (status === "done") return "success";
	if (status === "in_progress") return "accent";
	if (status === "ready") return "text";
	return "dim";
}

/**
 * Epics first, children indented beneath them.
 *
 * `isEpic` is resolved once here rather than per row per repaint: the painter
 * used to call `hasChildren` inside `render`, which is a query per visible story
 * every time the board redrew.
 */
export function buildBoardRows(db: DatabaseSync, stories: Story[]): BoardRow[] {
	return treeOrder(stories).map(({ story, depth }) => ({
		story,
		depth,
		isEpic: hasChildren(db, story.id),
		statusTone: toneFor(story.status),
	}));
}

/**
 * What a board key writes.
 *
 * Board keys are human actions, so they do not hit the tool's resolution gate —
 * but a closed story with no resolution is exactly the hole this work fills, so
 * each closing key records a default.
 */
export interface BoardKey {
	/**
	 * Narrowed to the four literals rather than `string`, so `extensions/` can
	 * pass them straight to pi-tui's `matchesKey`, whose parameter is a union of
	 * key names. `src/` may not import that type; this is the seam.
	 */
	key: "r" | "s" | "d" | "x";
	updates: Partial<Story>;
}

export const BOARD_KEYS: readonly BoardKey[] = [
	{ key: "r", updates: { status: "ready" } },
	{ key: "s", updates: { status: "in_progress" } },
	{
		key: "d",
		updates: { status: "done", resolution: "completed", resolution_note: "Closed from the story board." },
	},
	{
		key: "x",
		updates: { status: "cancelled", resolution: "wontfix", resolution_note: "Cancelled from the story board." },
	},
];

export const BOARD_LEGEND = "↑↓ navigate • R ready • S start • D done • X cancel • Enter detail • Esc close";

export interface DetailLine {
	tone: Tone;
	text: string;
}

/**
 * The lines shown under the selected row.
 *
 * `width` is the space left after the indent, so a narrow terminal truncates
 * rather than wrapping the frame. The floor of 10 keeps a pathological width
 * from producing an ellipsis and nothing else.
 */
export function boardDetailLines(story: Story, width: number): DetailLine[] {
	const lines: DetailLine[] = [{ tone: "dim", text: truncate(story.sub_goal, Math.max(10, width)) }];

	if (story.next_id) lines.push({ tone: "dim", text: `Next → #${story.next_id}` });
	if (story.resolution) {
		lines.push({
			tone: "muted",
			text: `Resolution: ${story.resolution}${story.resolution_note ? ` — ${story.resolution_note}` : ""}`,
		});
	}
	if (story.learnings) {
		lines.push({ tone: "warning", text: `⚠ ${truncate(story.learnings, Math.max(10, width - 2))}` });
	}

	// Shown because the board's keys bypass the review gates on purpose — a human
	// overriding one should see what they are overriding, and who (or whether
	// anyone) reviewed it.
	const marks = (["plan", "work"] as const)
		.map((gate) => ({ gate, record: story.review[gate] }))
		.filter((entry) => entry.record)
		.map((entry) => `${entry.gate}: ${entry.record!.verdict} (${entry.record!.by})`);
	if (marks.length > 0) {
		const approved = (["plan", "work"] as const).every(
			(gate) => !story.review[gate] || story.review[gate]!.verdict === "approved",
		);
		lines.push({ tone: approved ? "success" : "warning", text: `⌾ ${marks.join(" · ")}` });
	}

	if (story.handoff_notes) {
		lines.push({ tone: "muted", text: `↪ ${truncate(story.handoff_notes, Math.max(10, width - 2))}` });
	}
	return lines;
}
