/**
 * Rendering of a SearchResponse into the markdown the model reads.
 *
 * Sized for an agent's context, not a human's page: results are a flat
 * list of title / URL / excerpt, and every excerpt is truncated so one
 * garrulous page cannot crowd out the other results.
 */

import type { SearchResponse } from "./types.ts";

/** Per-result content cap. Tavily excerpts run a few hundred characters;
 * this only bites on backends that return longer ones. */
export const CONTENT_CAP = 500;

function truncate(text: string, cap: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= cap ? flat : `${flat.slice(0, cap)}…`;
}

export function formatResults(query: string, resp: SearchResponse): string {
	if (resp.results.length === 0 && !resp.answer) {
		return `No results for "${query}".`;
	}

	const parts: string[] = [];
	if (resp.answer) {
		parts.push(`**Answer:** ${resp.answer}\n`);
	}
	parts.push(`**Results for "${query}":**\n`);
	for (const [i, r] of resp.results.entries()) {
		const score = r.score !== undefined ? ` (score ${r.score.toFixed(2)})` : "";
		const content = r.content ? `\n${truncate(r.content, CONTENT_CAP)}` : "";
		parts.push(`${i + 1}. **${r.title}**${score}\n${r.url}${content}`);
	}
	return parts.join("\n");
}
