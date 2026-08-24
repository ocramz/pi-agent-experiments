/**
 * pi-web-search: web search tools for the pi agent, one tool per backend.
 *
 * Backends live one-per-file in src/ and normalise into a shared result
 * shape; adding one means a registerTool call here plus its src/ file.
 * Each tool reads its API key from the environment at execute time — a
 * missing key is a readable tool result, not a thrown error, so the
 * model can tell the user exactly what to set.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { tavilySearch } from "../src/tavily.ts";
import { formatResults } from "../src/format.ts";

function text(t: string) {
	return { content: [{ type: "text" as const, text: t }], details: {} };
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search_tavily",
		label: "Web Search (Tavily)",
		description:
			"Search the web via Tavily. Returns a short list of results — title, URL and a text " +
			"excerpt each — and optionally a synthesized answer. Use for current events, " +
			"documentation, and anything too recent or too specific for training data. Requires " +
			"the TAVILY_API_KEY environment variable.",
		promptSnippet: "web_search_tavily: search the web; returns titles, URLs and excerpts.",
		promptGuidelines: [
			"Prefer specific queries with the key terms over full questions.",
			"For recency-sensitive questions set topic to \"news\" or pass time_range; cite the URLs you used back to the user.",
			"If the tool reports a missing TAVILY_API_KEY, tell the user to set it — do not retry.",
			"One search is usually enough; refine the query rather than repeating the same one.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "The search query." }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum number of results (default 5)." }),
			),
			topic: Type.Optional(
				Type.Union([Type.Literal("general"), Type.Literal("news")], {
					description: "\"general\" (default) or \"news\".",
				}),
			),
			search_depth: Type.Optional(
				Type.Union([Type.Literal("basic"), Type.Literal("advanced")], {
					description: "\"basic\" (default, fast) or \"advanced\" (deeper, slower).",
				}),
			),
			time_range: Type.Optional(
				Type.String({
					description: "Limit to results published within a range: day/week/month/year or shorthand like \"3d\".",
				}),
			),
			start_date: Type.Optional(
				Type.String({ description: "Earliest publish date, YYYY-MM-DD." }),
			),
			end_date: Type.Optional(
				Type.String({ description: "Latest publish date, YYYY-MM-DD." }),
			),
			include_answer: Type.Optional(
				Type.Boolean({ description: "Also return a short synthesized answer (default false)." }),
			),
			include_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Restrict results to these domains." }),
			),
			exclude_domains: Type.Optional(
				Type.Array(Type.String(), { description: "Exclude these domains." }),
			),
		}),
		async execute(_id, params) {
			const apiKey = process.env.TAVILY_API_KEY;
			if (!apiKey) {
				return text(
					"TAVILY_API_KEY is not set — web search via Tavily is unavailable. " +
						"Tell the user to export TAVILY_API_KEY and restart the session.",
				);
			}
			const outcome = await tavilySearch(apiKey, {
				query: params.query,
				maxResults: params.max_results,
				topic: params.topic,
				searchDepth: params.search_depth,
				timeRange: params.time_range,
				startDate: params.start_date,
				endDate: params.end_date,
				includeAnswer: params.include_answer,
				includeDomains: params.include_domains,
				excludeDomains: params.exclude_domains,
			});
			if (!outcome.ok) return text(outcome.error);
			return text(formatResults(params.query, outcome.response));
		},
	});
}
