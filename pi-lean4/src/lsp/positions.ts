/**
 * Positions, as the model sees them and as the server does.
 *
 * Tools speak 1-indexed lines and 1-indexed *codepoint* columns — what a human
 * counts and what `read` shows. LSP speaks 0-indexed lines and UTF-16 code
 * units. The two disagree on every astral character (𝔽, 𝓝, most emoji), and
 * Mathlib is full of them, so every position crosses this module and never the
 * raw arithmetic.
 *
 * Lines split on "\n" only. A "\r" stays part of its line, exactly as the
 * server counts it.
 */

import { LeanToolError } from "../errors.ts";

export interface Position {
	line: number;
	character: number;
}

export interface Range {
	start: Position;
	end: Position;
}

/** A tool-side coordinate: 1-indexed line and codepoint column. */
export interface Point {
	line: number;
	column: number;
}

export function splitLines(text: string): string[] {
	return text.split("\n");
}

/** UTF-16 offset of the `cp`-th codepoint (0-based) of `line`, clamped to its end. */
export function utf16Offset(line: string, cp: number): number {
	let units = 0;
	let seen = 0;
	for (const ch of line) {
		if (seen >= cp) return units;
		units += ch.length;
		seen++;
	}
	return units;
}

/** Codepoint index (0-based) at UTF-16 offset `units` of `line`, clamped to its end. */
export function codepointIndex(line: string, units: number): number {
	let at = 0;
	let seen = 0;
	for (const ch of line) {
		if (at >= units) return seen;
		at += ch.length;
		seen++;
	}
	return seen;
}

/** Number of codepoints in a line. */
export function codepointLength(line: string): number {
	let n = 0;
	for (const _ of line) n++;
	return n;
}

/**
 * Tool coordinates → LSP. Throws when the line is outside the file, because a
 * goal "at line 900" of a 40-line file is a mistake the model should hear
 * about, not a silently clamped answer about some other line. A column past the
 * end clamps to the end: "after the last tactic on this line" is a fair ask.
 */
export function toLsp(lines: readonly string[], line: number, column = 1): Position {
	if (!Number.isInteger(line) || line < 1 || line > lines.length) {
		throw new LeanToolError(`line ${line} is out of range (the file has ${lines.length} lines)`);
	}
	if (!Number.isInteger(column) || column < 1) {
		throw new LeanToolError(`column ${column} is out of range (columns start at 1)`);
	}
	const text = lines[line - 1];
	return { line: line - 1, character: utf16Offset(text, column - 1) };
}

/** LSP → tool coordinates, against the text the position was computed on. */
export function fromLsp(lines: readonly string[], pos: Position): Point {
	const text = lines[pos.line] ?? "";
	return { line: pos.line + 1, column: codepointIndex(text, pos.character) + 1 };
}

export function rangeFromLsp(lines: readonly string[], range: Range): { start: Point; end: Point } {
	return { start: fromLsp(lines, range.start), end: fromLsp(lines, range.end) };
}
