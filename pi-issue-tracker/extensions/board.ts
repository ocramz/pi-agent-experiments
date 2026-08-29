/**
 * The story board's painter.
 *
 * Everything it draws comes from `src/board.ts`; what stays here is the drawing
 * itself — `ctx.ui.custom`, `matchesKey`, `theme.fg`, `tui.requestRender` — none
 * of which `src/` may import.
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { BOARD_KEYS, BOARD_LEGEND, boardDetailLines, buildBoardRows } from "../src/board.ts";
import { getAllStories } from "../src/database.ts";
import { isOpen, storyToText } from "../src/format.ts";
import type { Story } from "../src/types.ts";
import { ensureDb, isDbReady, refreshStatus, transitionStatus } from "./runtime.ts";

/** Open `/stories`. Falls back to a printed list outside the TUI. */
export async function openBoard(ctx: ExtensionCommandContext): Promise<void> {
	if (!isDbReady()) {
		if (ctx.hasUI) ctx.ui.notify("Story DB not ready", "error");
		return;
	}
	const db = ensureDb();
	const all = getAllStories(db);
	if (ctx.mode !== "tui") {
		const open = all.filter(isOpen);
		const text = open.map((s) => storyToText(s, true)).join("\n") || "All stories are closed.";
		if (ctx.hasUI) ctx.ui.notify(`${all.length} stories total, ${open.length} open:\n\n${text}`, "info");
		return;
	}

	const result = await ctx.ui.custom<Story | null>((tui, theme, _kb, done) => {
		let selectedIndex = 0;
		let cachedLines: string[] | undefined;
		let widthCached = 0;
		const rows = buildBoardRows(db, all);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function setStatus(index: number, updates: Partial<Story>) {
			const row = rows[index];
			if (!row) return;
			// Key handlers are synchronous, but a transition now performs git
			// work. Refresh when it lands rather than blocking the board.
			void transitionStatus(row.story.id, updates).then((updated) => {
				if (updated) rows[index] = { ...row, story: updated };
				refresh();
			});
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
				selectedIndex = Math.min(rows.length - 1, selectedIndex + 1);
				refresh();
				return;
			}
			for (const { key, updates } of BOARD_KEYS) {
				if (matchesKey(data, key)) {
					setStatus(selectedIndex, updates);
					return;
				}
			}
			if (matchesKey(data, "enter")) {
				done(rows[selectedIndex]?.story ?? null);
			}
		}

		function render(width: number): string[] {
			if (cachedLines && widthCached === width) return cachedLines;
			const lines: string[] = [];
			const openCount = rows.filter((r) => isOpen(r.story)).length;
			lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
			lines.push(` ${theme.fg("accent", theme.bold("Story Board"))}  ${theme.fg("muted", `${openCount} open`)}`);
			lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));

			if (rows.length === 0) {
				lines.push(`  ${theme.fg("dim", "No stories yet. Use /plan-stories <goal> to create some.")}`);
			}

			for (let i = 0; i < rows.length; i++) {
				const { story: s, depth, isEpic, statusTone } = rows[i];
				const isActive = i === selectedIndex;
				const indent = "  ".repeat(depth);
				const prefix = isActive ? theme.fg("accent", "> ") : "  ";
				const epicMark = isEpic ? theme.fg("muted", "▾ ") : "";
				lines.push(
					`${prefix}${indent}${epicMark}${theme.fg(statusTone, `[${s.status}]`)} ${theme.fg("accent", `#${s.id}`)} ${theme.fg("text", s.title)}`,
				);
				if (isActive) {
					const pad = `     ${indent}`;
					for (const detail of boardDetailLines(s, width - pad.length - 1)) {
						lines.push(`${pad}${theme.fg(detail.tone, detail.text)}`);
					}
				}
			}

			lines.push(theme.fg("accent", "─".repeat(Math.max(0, width))));
			lines.push(`  ${theme.fg("dim", BOARD_LEGEND)}`);
			lines.push(theme.fg("accent", "═".repeat(Math.max(0, width))));
			cachedLines = lines;
			widthCached = width;
			return lines;
		}

		return { render, handleInput, invalidate: () => { cachedLines = undefined; } };
	});

	refreshStatus(ctx);
	if (result) {
		ctx.ui.notify(`Selected #${result.id}: ${result.title}`, "info");
	}
}
