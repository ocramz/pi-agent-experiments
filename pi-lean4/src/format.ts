/**
 * Bounding text before it reaches the model.
 *
 * Two layers. Each *field* (a goal, a message) is bounded here, cutting the
 * middle rather than the end: a Lean goal states its target last, after the
 * local context, and a reader who loses `⊢ …` loses the one line they came for
 * (lean-lsp-mcp's `bound_output`, same 2/3 + 1/3 split). The whole result is
 * then bounded by pi's own truncation in extensions/wiring/tools.ts, which
 * also keeps the full text in a temp file and says where.
 */

export function boundText(text: string, limit: number): string {
	if (limit <= 0 || text.length <= limit) return text;
	const elided = text.length - limit;
	const head = Math.floor((limit * 2) / 3);
	const tail = limit - head;
	const bounded =
		`${text.slice(0, head)}\n\n[... ${elided} characters elided; ` +
		`set PI_LEAN_MAX_OUTPUT_CHARS=0 for the whole text ...]\n\n${text.slice(-tail)}`;
	return bounded.length < text.length ? bounded : text;
}

export function plural(n: number, word: string, many = `${word}s`): string {
	return `${n} ${n === 1 ? word : many}`;
}

export function indent(text: string, by = "  "): string {
	return text
		.split("\n")
		.map((l) => (l ? by + l : l))
		.join("\n");
}

/** Strip a ```lean fence Lean wraps goals and hovers in. */
export function unfence(text: string): string {
	return text
		.replace(/^```(?:lean)?\n?/m, "")
		.replace(/\n?```\s*$/m, "")
		.trim();
}
