/**
 * The shape every search backend normalises into, so extensions/index.ts
 * and the formatter never see a provider-specific response. Adding a
 * backend means one file in src/ exporting a function that returns this.
 */

export interface SearchResult {
	title: string;
	url: string;
	/** Excerpt or snippet, already plain text. */
	content: string;
	/** Backend-specific relevance score, when it reports one. */
	score?: number;
}

export interface SearchResponse {
	/** Short synthesized answer, if the backend was asked for one. */
	answer?: string;
	results: SearchResult[];
}

/** A backend's failure mode, as a readable string instead of a thrown
 * error: the tool result is the model's only channel back. */
export type SearchOutcome =
	| { ok: true; response: SearchResponse }
	| { ok: false; error: string };
