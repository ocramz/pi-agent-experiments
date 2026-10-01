/**
 * lean_search: one tool, five sources.
 *
 *   local       ripgrep over the project, .lake/packages and Lean's sources,
 *               merged with the server's symbol index if a server is running
 *   leansearch  natural language → Mathlib (leansearch.net)
 *   loogle      type patterns and constants (loogle.lean-lang.org)
 *   leanfinder  semantic, by mathematical meaning (Lean Finder)
 *   premises    lemmas likely useful for the goal at a position (hammer premise)
 *
 * The decision tree for which to use is in skills/lean4/references/tools.md.
 */

import { join } from "node:path";
import { LeanToolError } from "../../errors.ts";
import { findProjectRoot, resolveToolPath } from "../../lean/project.ts";
import type { LeanRuntime } from "../../lean/runtime.ts";
import { asError, rgMissing } from "../../lean/preflight.ts";
import { leanPrefix, locate } from "../../lean/toolchain.ts";
import { type OpContext, type OpResult, withFile, withNotes } from "../common.ts";
import { tacticGoalAt } from "../goals.ts";
import { type LocalHit, indexHits, merge, parseRgJson, qualifyAndRank, runRg } from "./local.ts";
import { type RateLimiter, type RemoteSource, RATE_LIMITS } from "./ratelimit.ts";
import { DEFAULT_URLS, LEANFINDER_VERSIONS, type RemoteHit, leanfinder, leansearch, loogle, premises } from "./remote.ts";

export type Source = "local" | RemoteSource;
export const REMOTE_SOURCES: readonly RemoteSource[] = ["leansearch", "loogle", "leanfinder", "premises"];

export interface SearchInput {
	source: Source;
	query?: string;
	limit?: number;
	path?: string;
	line?: number;
	column?: number;
	version?: string;
}

const stdlibCache = new Map<string, Promise<string | null>>();

function stdlibFor(root: string): Promise<string | null> {
	let hit = stdlibCache.get(root);
	if (!hit) {
		hit = (async () => {
			const lean = locate("lean");
			if (!lean.path) return null;
			const prefix = await leanPrefix(lean.path, root);
			return prefix ? join(prefix, "src", "lean") : null;
		})();
		stdlibCache.set(root, hit);
	}
	return hit;
}

function renderRemote(source: string, hits: readonly RemoteHit[], query: string): string {
	if (hits.length === 0) return `${source}: no results for ${JSON.stringify(query)}.`;
	return [
		`${source}: ${hits.length} result(s) for ${JSON.stringify(query)}:`,
		...hits.map((h) => {
			const type = h.type ? ` : ${h.type.replace(/\s+/g, " ")}` : "";
			const where = h.module ? `  (${h.module})` : "";
			const desc = h.description ? `\n    ${h.description.replace(/\s+/g, " ").slice(0, 240)}` : "";
			return `- ${h.name}${type.length > 400 ? `${type.slice(0, 397)}...` : type}${where}${desc}`;
		}),
	].join("\n");
}

export async function searchOp(rt: LeanRuntime, input: SearchInput, oc: OpContext, limiter: RateLimiter): Promise<OpResult> {
	const source = input.source;
	if (source !== "local" && oc.cfg.offline) {
		throw new LeanToolError(
			`source "${source}" sends your query to a third-party service, and offline mode is on (--lean-offline / PI_LEAN_OFFLINE). Use source "local".`,
		);
	}
	const f = oc.fetch ?? fetch;
	const custom = (key: keyof OpContext["cfg"]["search"]) => !!oc.cfg.search[key];
	const gate = (s: RemoteSource, customUrl: boolean) => {
		if (customUrl) return;
		const r = limiter.take(s);
		if (!r.ok) {
			const { max, perMs } = RATE_LIMITS[s];
			throw new LeanToolError(
				`${s} is rate-limited to ${max} requests per ${perMs / 1000}s (a courtesy to a free public service); ` +
					`retry in ${Math.ceil(r.retryAfterMs / 1000)}s, or use source "local" meanwhile. Do not loop on this.`,
			);
		}
	};

	if (source === "premises") {
		if (!input.path || input.line === undefined || input.column === undefined) {
			throw new LeanToolError('source "premises" needs path, line and column of a goal (the query is the goal there)');
		}
		const { value, notes } = await withFile(rt, input.path, oc, async (doc) => tacticGoalAt(doc, input.line!, input.column!, oc.signal));
		if (value.status !== "goals") throw new LeanToolError(`no open goal at ${input.path}:${input.line}:${input.column} (${value.status})`);
		gate("premises", custom("premiseUrl"));
		const hits = await premises(value.goals[0], input.limit ?? 32, f, oc.cfg.search.premiseUrl ?? DEFAULT_URLS.premises, oc.signal);
		const text =
			hits.length === 0
				? "premises: no suggestions for this goal."
				: `premises for the goal at ${input.path}:${input.line}:${input.column} (try them in simp only [...], grind [...], or aesop):\n${hits.map((h) => h.name).join(", ")}`;
		return { text: withNotes(text, notes), details: { source, hits } };
	}

	const query = input.query?.trim();
	if (!query) throw new LeanToolError(`query is required for source "${source}"`);
	const limit = Math.max(1, Math.min(input.limit ?? (source === "local" ? 10 : source === "loogle" ? 8 : 5), 100));

	switch (source) {
		case "leansearch": {
			gate("leansearch", custom("leansearchUrl"));
			const hits = await leansearch(query, limit, f, oc.cfg.search.leansearchUrl ?? DEFAULT_URLS.leansearch, oc.signal);
			return { text: renderRemote("leansearch", hits, query), details: { source, hits } };
		}
		case "loogle": {
			gate("loogle", custom("loogleUrl"));
			const hits = await loogle(query, limit, f, oc.cfg.search.loogleUrl ?? DEFAULT_URLS.loogle, oc.signal);
			return { text: renderRemote("loogle", hits, query), details: { source, hits } };
		}
		case "leanfinder": {
			const version = input.version ?? LEANFINDER_VERSIONS[LEANFINDER_VERSIONS.length - 1];
			if (!(LEANFINDER_VERSIONS as readonly string[]).includes(version)) {
				throw new LeanToolError(`leanfinder version must be one of ${LEANFINDER_VERSIONS.join(", ")}`);
			}
			gate("leanfinder", custom("leanfinderUrl"));
			const hits = await leanfinder(query, limit, version, f, oc.cfg.search.leanfinderUrl ?? DEFAULT_URLS.leanfinder, oc.signal);
			return { text: renderRemote(`leanfinder (Mathlib ${version})`, hits, query), details: { source, hits } };
		}
		case "local": {
			const anchor = input.path ? resolveToolPath(input.path, oc.cwd) : oc.cwd;
			const root = findProjectRoot(anchor) ?? rt.boundRoot();
			if (!root) throw new LeanToolError('local search needs a Lake project: run from inside one, or pass path');
			if (!oc.rg) throw new LeanToolError(asError(rgMissing(oc.cfg)));
			const stdlib = await stdlibFor(root);
			const breadth = query.includes(".") ? 32 : 8;
			const maxCandidates = Math.min(Math.max(limit * breadth, limit), 2048);
			const raw = await runRg(oc.rg, query, root, stdlib, maxCandidates, oc.signal);
			let hits: LocalHit[] = qualifyAndRank(parseRgJson(raw, root, stdlib), query, limit);
			let index: "consulted" | "unavailable" | "error" = "unavailable";
			const server = rt.running();
			if (server && server.root === root) {
				try {
					hits = merge(hits, indexHits(await server.workspaceSymbol(query, 2000), root, stdlib, query), query, limit);
					index = "consulted";
				} catch {
					index = "error";
				}
			}
			const indexNote =
				index === "consulted"
					? ""
					: "\n(searched source text only — no Lean server is running for this project, so declarations generated by attributes such as @[to_additive] are not visible; an empty result does not prove absence)";
			const text = hits.length
				? `local: ${hits.length} declaration(s) matching ${JSON.stringify(query)}:\n${hits.map((h) => `- ${h.name}  (${h.kind}, ${h.file}${h.line ? `:${h.line}` : ""})`).join("\n")}${indexNote}`
				: `local: nothing matches ${JSON.stringify(query)}.${indexNote}`;
			return { text, details: { source, hits, index, root } };
		}
		default:
			throw new LeanToolError(`unknown source ${String(source)}`);
	}
}
