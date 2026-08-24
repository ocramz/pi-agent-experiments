/**
 * Getting JSON back out of model prose.
 *
 * Two callers ask a model for JSON and get it wrapped in code fences, prefaced
 * with "Here's the plan:", or trailed by a summary, despite the prompt asking
 * for none of that — `/plan-stories` and the story reviewer. Both used to be
 * unreachable from a test: this lived in `extensions/index.ts`, which cannot be
 * imported without a pi runtime.
 */

/** Strip a ```json fence if there is one, and return the body. */
function unfence(text: string): string {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	return (fenced ? fenced[1] : text).trim();
}

/** Tolerate code fences and prose around the array. */
export function extractJsonArray(text: string): string {
	const body = unfence(text);
	const start = body.indexOf("[");
	const end = body.lastIndexOf("]");
	return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/** The same, for a single object — what a reviewer returns. */
export function extractJsonObject(text: string): string {
	const body = unfence(text);
	const start = body.indexOf("{");
	const end = body.lastIndexOf("}");
	return start !== -1 && end > start ? body.slice(start, end + 1) : body;
}

/**
 * Parse an object out of a model reply, or null.
 *
 * Returns null rather than throwing because every caller treats "the model
 * produced something unusable" as an outcome to report, not an exception.
 */
export function parseJsonObject(text: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(extractJsonObject(text)) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
		return parsed as Record<string, unknown>;
	} catch {
		return null;
	}
}
