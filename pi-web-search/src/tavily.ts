/**
 * Tavily search backend — https://api.tavily.com/search
 *
 * POSTs the search request with `Authorization: Bearer <apiKey>` and
 * normalises the response into the shared SearchResponse shape. Only the
 * options an agent should steer are parameters; the rest of the request
 * body (images, favicons, raw content, usage accounting) is pinned to
 * defaults that keep the response small and text-only.
 *
 * Never throws: every failure — network, HTTP status, malformed JSON —
 * comes back as `{ ok: false, error }`, because the tool result is the
 * model's only channel for finding out what went wrong.
 */

import type { SearchOutcome } from "./types.ts";

const ENDPOINT = "https://api.tavily.com/search";

export interface TavilyOptions {
	query: string;
	maxResults?: number;
	topic?: "general" | "news";
	searchDepth?: "basic" | "advanced";
	/** One of day/week/month/year, or shorthand like "3d". */
	timeRange?: string;
	/** YYYY-MM-DD; only meaningful together. */
	startDate?: string;
	endDate?: string;
	includeAnswer?: boolean;
	includeDomains?: string[];
	excludeDomains?: string[];
}

interface TavilyApiResult {
	title?: string;
	url?: string;
	content?: string;
	score?: number;
}

interface TavilyApiResponse {
	answer?: string;
	results?: TavilyApiResult[];
}

/** The full request body, for tests to inspect. Exported so the unit
 * suite asserts request construction without standing up a server. */
export function buildRequestBody(opts: TavilyOptions): Record<string, unknown> {
	return {
		query: opts.query,
		auto_parameters: false,
		topic: opts.topic ?? "general",
		search_depth: opts.searchDepth ?? "basic",
		chunks_per_source: 3,
		max_results: opts.maxResults ?? 5,
		time_range: opts.timeRange ?? null,
		start_date: opts.startDate ?? null,
		end_date: opts.endDate ?? null,
		include_answer: opts.includeAnswer ?? false,
		include_raw_content: false,
		include_images: false,
		include_image_descriptions: false,
		include_favicon: false,
		include_domains: opts.includeDomains ?? [],
		exclude_domains: opts.excludeDomains ?? [],
		country: null,
		include_usage: false,
	};
}

export async function tavilySearch(
	apiKey: string,
	opts: TavilyOptions,
	fetchImpl: typeof fetch = fetch,
): Promise<SearchOutcome> {
	let res: Response;
	try {
		res = await fetchImpl(ENDPOINT, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(buildRequestBody(opts)),
		});
	} catch (err) {
		return { ok: false, error: `tavily: request failed: ${(err as Error).message}` };
	}

	const bodyText = await res.text();
	if (!res.ok) {
		return {
			ok: false,
			error: `tavily: HTTP ${res.status} ${res.statusText}: ${bodyText.slice(0, 500)}`,
		};
	}

	let data: TavilyApiResponse;
	try {
		data = JSON.parse(bodyText) as TavilyApiResponse;
	} catch {
		return { ok: false, error: `tavily: response was not JSON: ${bodyText.slice(0, 500)}` };
	}

	const results = (data.results ?? [])
		.filter((r) => r.title && r.url)
		.map((r) => ({
			title: r.title as string,
			url: r.url as string,
			content: r.content ?? "",
			...(typeof r.score === "number" ? { score: r.score } : {}),
		}));

	return {
		ok: true,
		response: {
			...(typeof data.answer === "string" && data.answer ? { answer: data.answer } : {}),
			results,
		},
	};
}
