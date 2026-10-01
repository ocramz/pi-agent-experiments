/**
 * The remote search services, as lean-lsp-mcp calls them (tools/search.py,
 * loogle.py; MIT, © 2025 Oliver Dressler). `fetch` is injected so the unit
 * tier asserts request bodies and parses canned answers without a network.
 *
 * Each sends the query — or, for premises, the goal at a position — to a
 * third party. Offline mode refuses before any of these is called.
 */

import { LeanToolError } from "../../errors.ts";

export const DEFAULT_URLS = {
	leansearch: "https://leansearch.net/search",
	loogle: "https://loogle.lean-lang.org",
	leanfinder: "https://lean-lsp-proxy.leanfinder.workers.dev",
	premises: "http://leanpremise.net",
} as const;

export const LEANFINDER_VERSIONS = ["v4.19.0", "v4.24.0", "v4.28.0"] as const;

export interface RemoteHit {
	name: string;
	type?: string;
	module?: string;
	kind?: string;
	description?: string;
}

const HEADERS = { "User-Agent": "pi-lean4/0.1", "Content-Type": "application/json" };
const TIMEOUT_MS = 10_000;

async function getJson(fetchImpl: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
	const s = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
	let res: Response;
	try {
		res = await fetchImpl(url, { ...init, signal: s });
	} catch (err) {
		if (signal?.aborted) throw err;
		throw new LeanToolError(`could not reach ${new URL(url).host}: ${(err as Error).message}`);
	}
	if (!res.ok) throw new LeanToolError(`${new URL(url).host} answered HTTP ${res.status}`);
	try {
		return await res.json();
	} catch {
		throw new LeanToolError(`${new URL(url).host} answered with something that is not JSON`);
	}
}

export async function leansearch(q: string, limit: number, f: typeof fetch, url: string = DEFAULT_URLS.leansearch, signal?: AbortSignal): Promise<RemoteHit[]> {
	const data = (await getJson(f, url, { method: "POST", headers: HEADERS, body: JSON.stringify({ num_results: String(limit), query: [q] }) }, signal)) as
		| { result: { name: string[]; module_name: string[]; kind?: string; type?: string; docstring?: string } }[][]
		| null;
	const first = Array.isArray(data) ? data[0] : null;
	if (!Array.isArray(first)) return [];
	return first.slice(0, limit).map(({ result: r }) => ({
		name: (r.name ?? []).join("."),
		module: (r.module_name ?? []).join("."),
		kind: r.kind,
		type: r.type,
	}));
}

export async function loogle(q: string, limit: number, f: typeof fetch, base: string = DEFAULT_URLS.loogle, signal?: AbortSignal): Promise<RemoteHit[]> {
	const data = (await getJson(f, `${base.replace(/\/$/, "")}/json?q=${encodeURIComponent(q)}`, { headers: { "User-Agent": HEADERS["User-Agent"] } }, signal)) as {
		hits?: { name: string; type?: string; module?: string; doc?: string }[];
		error?: string;
		suggestions?: string[];
	};
	if (data?.error) {
		const hint = data.suggestions?.length ? ` Suggestions: ${data.suggestions.slice(0, 5).join(", ")}` : "";
		throw new LeanToolError(`loogle could not parse the query: ${data.error}.${hint}`);
	}
	return (data?.hits ?? []).slice(0, limit).map((h) => ({ name: h.name, type: h.type, module: h.module, description: h.doc ?? undefined }));
}

export async function leanfinder(
	q: string,
	limit: number,
	version: string,
	f: typeof fetch,
	url: string = DEFAULT_URLS.leanfinder,
	signal?: AbortSignal,
): Promise<RemoteHit[]> {
	const data = (await getJson(f, url, { method: "POST", headers: HEADERS, body: JSON.stringify({ inputs: q, top_k: limit, version }) }, signal)) as {
		results?: { formal_name?: string; informal_name?: string; kind?: string; type?: string; informal_description?: string; path?: string }[];
		error?: string;
	};
	if (data?.error) throw new LeanToolError(`Lean Finder: ${data.error}`);
	return (data?.results ?? []).map((r) => ({
		name: r.formal_name ?? "",
		type: r.type,
		kind: r.kind,
		module: (r.path ?? "").replace(/\//g, "."),
		description: [r.informal_name, r.informal_description].filter(Boolean).join(": ") || undefined,
	}));
}

export async function premises(state: string, k: number, f: typeof fetch, base: string = DEFAULT_URLS.premises, signal?: AbortSignal): Promise<RemoteHit[]> {
	const data = (await getJson(
		f,
		`${base.replace(/\/$/, "")}/retrieve`,
		{ method: "POST", headers: HEADERS, body: JSON.stringify({ state, new_premises: [], k }) },
		signal,
	)) as { name: string }[] | null;
	return (Array.isArray(data) ? data : []).map((r) => ({ name: r.name }));
}
