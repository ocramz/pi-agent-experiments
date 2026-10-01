/**
 * The few lines appended to an `edit`/`write` result on a .lean file.
 *
 * Deliberately short: it rides on every edit, so it carries the verdict (clean,
 * or what broke) and the first few errors, and points at lean_diagnostics for
 * the rest. The model reads it as "did my edit compile?", which is the question
 * it would otherwise spend a tool call asking.
 */

import { type DiagItem, counts } from "../ops/diagnostics.ts";

export const AUTOCHECK_TAG = "[lean auto-check]";
const MAX_ERRORS = 5;

export function autocheckSummary(
	shown: string,
	items: readonly DiagItem[],
	opts: { complete: boolean; timeoutMs: number; reopened?: string },
): string {
	const c = counts(items);
	const errors = items.filter((i) => i.severity === "error");
	const sorries = items.filter((i) => i.category === "sorry");
	const lines: string[] = [];
	if (opts.reopened) lines.push(`${AUTOCHECK_TAG} note: ${opts.reopened}.`);
	if (!opts.complete) {
		lines.push(
			`${AUTOCHECK_TAG} ${shown}: still elaborating after ${Math.round(opts.timeoutMs / 1000)}s` +
				(c.errors ? `; ${c.errors} error(s) so far` : "; no errors so far") +
				' — lean_diagnostics {path} waits for the full result.',
		);
	} else if (c.errors === 0 && c.sorries === 0) {
		lines.push(`${AUTOCHECK_TAG} ${shown}: compiles — no errors, no sorries${c.warnings ? ` (${c.warnings} warning(s))` : ""}.`);
		return lines.join("\n");
	} else {
		lines.push(`${AUTOCHECK_TAG} ${shown}: ${c.errors} error(s), ${c.sorries} sorry(ies)${c.warnings ? `, ${c.warnings} warning(s)` : ""}.`);
	}
	for (const e of errors.slice(0, MAX_ERRORS)) lines.push(`  error ${e.line}:${e.column} ${e.message.split("\n")[0].slice(0, 200)}`);
	if (errors.length > MAX_ERRORS) lines.push(`  … ${errors.length - MAX_ERRORS} more error(s): lean_diagnostics {path} for all of them`);
	if (sorries.length) lines.push(`  sorry at line(s) ${sorries.map((s) => s.line).join(", ")}`);
	return lines.join("\n");
}
