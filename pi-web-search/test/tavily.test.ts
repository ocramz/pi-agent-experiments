// Unit tests for the Tavily backend and the formatter.
//
// No network: a stub fetch captures the request and returns canned JSON,
// so these cases cover request construction (auth header, pinned
// defaults, parameter passthrough), response normalisation, truncation,
// and the error paths — everything but Tavily's actual wire behaviour,
// which the live TUI tier covers.

import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRequestBody, tavilySearch, type TavilyOptions } from "../src/tavily.ts";
import { formatResults, CONTENT_CAP } from "../src/format.ts";

/** A fetch stub returning a canned response, recording its call. */
function stubFetch(
	body: unknown,
	init: { status?: number; statusText?: string; raw?: string } = {},
) {
	const calls: { url: unknown; init?: RequestInit }[] = [];
	const fetchImpl = (async (url: unknown, initArg?: RequestInit) => {
		calls.push({ url, init: initArg });
		return new Response(init.raw ?? JSON.stringify(body), {
			status: init.status ?? 200,
			statusText: init.statusText ?? "OK",
		});
	}) as typeof fetch;
	return { calls, fetchImpl };
}

const OPTS: TavilyOptions = { query: "who is Leo Messi?" };

test("request body pins the non-agent-steerable fields to defaults", () => {
	const body = buildRequestBody(OPTS);
	assert.equal(body.query, "who is Leo Messi?");
	assert.equal(body.auto_parameters, false);
	assert.equal(body.topic, "general");
	assert.equal(body.search_depth, "basic");
	assert.equal(body.max_results, 5);
	assert.equal(body.include_answer, false);
	assert.equal(body.include_raw_content, false);
	assert.equal(body.include_images, false);
	assert.deepEqual(body.include_domains, []);
	assert.equal(body.time_range, null);
	assert.equal(body.country, null);
});

test("request body passes agent options through under their API names", () => {
	const body = buildRequestBody({
		query: "q",
		maxResults: 3,
		topic: "news",
		searchDepth: "advanced",
		timeRange: "week",
		startDate: "2025-02-09",
		endDate: "2025-12-29",
		includeAnswer: true,
		includeDomains: ["example.com"],
		excludeDomains: ["spam.example"],
	});
	assert.equal(body.max_results, 3);
	assert.equal(body.topic, "news");
	assert.equal(body.search_depth, "advanced");
	assert.equal(body.time_range, "week");
	assert.equal(body.start_date, "2025-02-09");
	assert.equal(body.end_date, "2025-12-29");
	assert.equal(body.include_answer, true);
	assert.deepEqual(body.include_domains, ["example.com"]);
	assert.deepEqual(body.exclude_domains, ["spam.example"]);
});

test("sends the key as a bearer token to the Tavily endpoint", async () => {
	const { calls, fetchImpl } = stubFetch({ results: [] });
	await tavilySearch("test-key", OPTS, fetchImpl);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.tavily.com/search");
	const headers = calls[0].init?.headers as Record<string, string>;
	assert.equal(headers.Authorization, "Bearer test-key");
	assert.equal(headers["Content-Type"], "application/json");
});

test("normalises results and drops entries without title or url", async () => {
	const { fetchImpl } = stubFetch({
		answer: "An Argentine footballer.",
		results: [
			{ title: "Lionel Messi", url: "https://en.wikipedia.org/wiki/Lionel_Messi", content: "Leo Messi is…", score: 0.91 },
			{ title: "No URL entry", content: "dropped" },
			{ title: "No content entry", url: "https://example.com" },
		],
	});
	const outcome = await tavilySearch("k", OPTS, fetchImpl);
	assert.ok(outcome.ok);
	assert.equal(outcome.response.answer, "An Argentine footballer.");
	assert.equal(outcome.response.results.length, 2);
	assert.equal(outcome.response.results[0].score, 0.91);
	assert.equal(outcome.response.results[1].content, "");
	assert.equal(outcome.response.results[1].score, undefined);
});

test("HTTP errors come back as a readable string, not a throw", async () => {
	const { fetchImpl } = stubFetch({ detail: "unauthorized" }, { status: 401, statusText: "Unauthorized" });
	const outcome = await tavilySearch("bad-key", OPTS, fetchImpl);
	assert.ok(!outcome.ok);
	assert.match(outcome.error, /HTTP 401/);
	assert.match(outcome.error, /unauthorized/);
});

test("a non-JSON 200 is an error, not a crash", async () => {
	const { fetchImpl } = stubFetch(null, { raw: "<html>not json</html>" });
	const outcome = await tavilySearch("k", OPTS, fetchImpl);
	assert.ok(!outcome.ok);
	assert.match(outcome.error, /not JSON/);
});

test("network failure is an error, not a throw", async () => {
	const fetchImpl = (async () => {
		throw new Error("getaddrinfo ENOTFOUND api.tavily.com");
	}) as typeof fetch;
	const outcome = await tavilySearch("k", OPTS, fetchImpl);
	assert.ok(!outcome.ok);
	assert.match(outcome.error, /ENOTFOUND/);
});

test("formatter renders answer and numbered results with urls", () => {
	const out = formatResults("q", {
		answer: "Short answer.",
		results: [
			{ title: "T1", url: "https://a.example", content: "excerpt one", score: 0.5 },
			{ title: "T2", url: "https://b.example", content: "" },
		],
	});
	assert.match(out, /\*\*Answer:\*\* Short answer\./);
	assert.match(out, /1\. \*\*T1\*\* \(score 0\.50\)/);
	assert.match(out, /https:\/\/a\.example/);
	assert.match(out, /2\. \*\*T2\*\*/);
	assert.doesNotMatch(out, /score.*T2/);
});

test("formatter truncates long content at the cap", () => {
	const long = "word ".repeat(300);
	const out = formatResults("q", {
		results: [{ title: "T", url: "https://a.example", content: long }],
	});
	assert.ok(out.length < long.length);
	assert.match(out, /…$/);
	assert.ok(!out.includes("word ".repeat(200)));
	assert.equal(CONTENT_CAP, 500);
});

test("formatter says so when there is nothing", () => {
	assert.equal(formatResults("q", { results: [] }), 'No results for "q".');
});
