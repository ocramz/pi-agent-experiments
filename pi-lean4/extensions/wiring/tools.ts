/**
 * The eight tools: descriptions, prompt lines, and the step from an op's
 * result to a tool result.
 *
 * Errors are thrown (pi then marks the result isError); Lean's own verdicts —
 * errors in the file, sorries, an unfinished elaboration — are results. Every
 * text passes through pi's truncation; when it bites, the whole text is kept
 * in a temp file and the result says where.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionContext, truncateTail } from "@earendil-works/pi-coding-agent";
import { LeanToolError } from "../../src/errors.ts";
import { attemptOp } from "../../src/ops/attempt.ts";
import { golfCandidates } from "../../src/ops/analyze/golf.ts";
import { hypothesesOp } from "../../src/ops/analyze/hypotheses.ts";
import { profileOp } from "../../src/ops/analyze/profile.ts";
import { buildOp } from "../../src/ops/build.ts";
import type { OpResult } from "../../src/ops/common.ts";
import { diagnosticsOp } from "../../src/ops/diagnostics.ts";
import { goalOp } from "../../src/ops/goals.ts";
import { navOp } from "../../src/ops/nav.ts";
import { searchOp } from "../../src/ops/search/search.ts";
import { sorriesOp } from "../../src/ops/sorries.ts";
import { axiomsOp } from "../../src/ops/verify.ts";
import { displayPath, requireLeanFile, resolveToolPath } from "../../src/lean/project.ts";
import { readFileSync } from "node:fs";
import type { Instance } from "./instance.ts";
import {
	analyzeSchema,
	attemptSchema,
	buildSchema,
	diagnosticsSchema,
	goalSchema,
	navSchema,
	searchSchema,
	verifySchema,
} from "./schemas.ts";

function need<T>(value: T | undefined | null, key: string, op: string): T {
	if (value === undefined || value === null || (typeof value === "string" && !value.trim())) {
		throw new LeanToolError(`${key} is required for op "${op}"`);
	}
	return value;
}

let spillDir: string | null = null;

/** Bound the text the way pi's own tools do, keeping the full text on disk. */
export function finish(r: OpResult<object>, kind: string) {
	let text = r.text;
	const t = truncateTail(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
	if (t.truncated) {
		try {
			spillDir ??= mkdtempSync(join(tmpdir(), "pi-lean4-"));
			mkdirSync(spillDir, { recursive: true });
			const file = join(spillDir, `${kind}-${Date.now()}.txt`);
			writeFileSync(file, text);
			text = `[output truncated: showing the last ${t.outputLines} of ${t.totalLines} lines; the full text is in ${file}]\n${t.content}`;
		} catch {
			text = `[output truncated: showing the last ${t.outputLines} of ${t.totalLines} lines]\n${t.content}`;
		}
	}
	return { content: [{ type: "text" as const, text }], details: { kind, ...r.details } };
}

export function registerTools(inst: Instance): void {
	const { pi } = inst;
	const run = async (ctx: ExtensionContext, kind: string, fn: () => Promise<OpResult<object>> | OpResult<object>) => {
		try {
			return finish(await fn(), kind);
		} finally {
			inst.refreshStatus(ctx);
		}
	};
	const progress = (onUpdate: ((r: { content: { type: "text"; text: string }[]; details: unknown }) => void) | undefined) =>
		onUpdate ? (m: string) => onUpdate({ content: [{ type: "text", text: m }], details: { progress: m } }) : undefined;

	pi.registerTool({
		name: "lean_diagnostics",
		label: "Lean Diagnostics",
		description:
			"The errors, warnings, sorries and info messages Lean reports for a .lean file, as it is on disk now. " +
			"Only what changed since the last check is re-elaborated, and asking again about an unchanged file is free. " +
			"Narrow with startLine/endLine or declaration; filter with severity. If elaboration does not finish within " +
			"timeout seconds the result is partial and names the lines still elaborating — an answer, not a failure: call " +
			"again to keep waiting. Positions are 1-indexed line:column.",
		promptSnippet: "errors, warnings and sorries Lean reports for a .lean file, or for one declaration or line range of it.",
		promptGuidelines: [
			"Results of edit and write on a .lean file may end with a [lean auto-check] summary of errors and sorries after the edit; when there is none, or you need every message, use lean_diagnostics.",
			"A lean_diagnostics result that says Lean is still elaborating is a partial answer, not a failure: call it again to keep waiting instead of editing blindly.",
		],
		parameters: diagnosticsSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, "lean.diagnostics", () => diagnosticsOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate))));
		},
	});

	pi.registerTool({
		name: "lean_goal",
		label: "Lean Goal",
		description:
			"The proof state — hypotheses and goals — at a position in a .lean file. With column: the goals at that point. " +
			"Without: the goals before the line's first token and after its last, which shows what that line's tactic does. " +
			'"no goals" means the proof is complete there. kind "term" gives the expected type of the term being elaborated at ' +
			"the position instead.",
		promptSnippet: "the proof goals at a line (before and after it) or at an exact position in a .lean file.",
		promptGuidelines: [
			"Use lean_goal before writing each proof step and after any step whose effect you are unsure of; never guess the goal state.",
		],
		parameters: goalSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, "lean.goal", () => goalOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate))));
		},
	});

	pi.registerTool({
		name: "lean_nav",
		label: "Lean Navigate",
		description:
			"Navigate Lean code through the language server. Ops: hover (type and docs of the name at line:column), " +
			"completions (what Lean would complete at line:column), definition (where a name is defined, with its source), " +
			"references (every use of a name), code_actions (Lean's suggested edits on a line — e.g. the result of exact?, " +
			"apply?, simp? — reported, never applied), outline (imports and declarations of the file, with signatures). " +
			"definition, references and hover accept symbol instead of line+column.",
		promptSnippet: "hover info, completions, definitions, references, code actions (e.g. exact?/simp? suggestions) and an outline of a .lean file.",
		promptGuidelines: [
			'lean_nav {op: "code_actions", path, line} lists the edits Lean suggests on a line (e.g. from exact?, apply?, simp?) without applying them; apply the one you choose with edit.',
		],
		parameters: navSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, `lean.nav.${params.op}`, () => navOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate))));
		},
	});

	pi.registerTool({
		name: "lean_attempt",
		label: "Lean Attempt",
		description:
			"Try proof candidates without editing any file. op tactics: each snippet replaces the tactic at path:line (from " +
			"column, default the line's first non-space character, to the end of the line) in a scratch copy of the file; the " +
			"result says per candidate whether it closes the goal, what goals remain, and any new errors. op code: elaborate " +
			"standalone Lean code (with its own imports) and report its messages.",
		promptSnippet: "try several tactics at a proof position, or check a standalone Lean snippet, on a scratch copy — the file is not modified.",
		promptGuidelines: [
			'Before editing a proof step, try 2-4 candidates at once with lean_attempt {op: "tactics", path, line, snippets}; write only a candidate that closes the goal or clearly makes progress.',
			'Use lean_attempt {op: "code"} for throwaway experiments (#check, #eval, a test lemma) instead of creating scratch files in the project.',
		],
		parameters: attemptSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, `lean.attempt.${params.op}`, () => attemptOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate))));
		},
	});

	pi.registerTool({
		name: "lean_search",
		label: "Lean Search",
		description:
			"Find Lean and Mathlib declarations. Sources: local — declarations matching a name in the project, its .lake " +
			"packages (Mathlib, if present) and Lean core, offline and fast; leansearch — natural-language search of Mathlib " +
			"(leansearch.net); leanfinder — semantic search by mathematical meaning, also accepts a goal pasted as text " +
			"(Lean Finder); loogle — type patterns and constants, e.g. `Real.sin`, `(?a → ?b) → List ?a → List ?b`, " +
			"`_ * (_ ^ _)` (loogle.lean-lang.org); premises — lemmas likely useful for the goal at path:line:column. " +
			"All but local send the query (premises: the goal) to a third-party service, are rate-limited, and are " +
			"unavailable in offline mode.",
		promptSnippet: "find lemmas and definitions: by name locally (project, packages, Lean core), in natural language, by type pattern, or for the goal at a position.",
		promptGuidelines: [
			'Search before you prove, and check a lemma name exists with lean_search {source: "local", query} before using it: a guessed name costs a failed compile.',
			"Choose the lean_search source by the question: local for names, leansearch or leanfinder for statements in words, loogle for type shapes, premises for the goal you are stuck on.",
			"lean_search remote sources are rate-limited public services: when one reports a rate limit, switch to another source or to local — never retry it in a loop.",
		],
		parameters: searchSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, `lean.search.${params.source}`, () =>
				searchOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate)), inst.limiter),
			);
		},
	});

	pi.registerTool({
		name: "lean_verify",
		label: "Lean Verify",
		description:
			"Check that proofs are really finished. op axioms: which axioms a theorem (or, without name, every theorem in the " +
			"file) depends on, checked on a scratch copy: propext, Classical.choice and Quot.sound are standard; sorryAx means " +
			"a sorry is still in it or in something it uses; anything else is a custom axiom or trust in compiled code; also " +
			"lists constructs in the file that can change what a proof means. op sorries: every sorry in a file or directory " +
			"(default the project), found lexically — comments and strings ignored — without compiling anything.",
		promptSnippet: "which axioms a theorem depends on (sorryAx = unfinished), and every sorry in a file or project.",
		promptGuidelines: [
			'Before reporting a proof as finished, run lean_verify {op: "axioms", path, name}: only propext, Classical.choice and Quot.sound are standard, and sorryAx means it is not finished.',
		],
		parameters: verifySchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (params.op === "sorries") return run(ctx, "lean.verify.sorries", () => sorriesOp(params, inst.opContext(ctx, signal)));
			const path = need(params.path, "path", "axioms");
			return run(ctx, "lean.verify.axioms", () =>
				axiomsOp(inst.runtime(), { path, name: params.name, scanSource: params.scanSource }, inst.opContext(ctx, signal, progress(onUpdate))),
			);
		},
	});

	pi.registerTool({
		name: "lean_build",
		label: "Lean Build",
		description:
			"Run lake build for the project — skipped, without invoking lake, when no source, lakefile or manifest changed " +
			"since the last successful build. Optionally lake clean first, or fetch Mathlib's prebuilt cache (lake exe cache " +
			"get). The Lean server is stopped for the build and restarts on the next call. Ordinary edits never need this: " +
			"the server rebuilds a file's stale imports by itself.",
		promptSnippet: "run lake build for the project (skipped when nothing changed since the last successful build).",
		promptGuidelines: [
			"Use lean_build only after changing imports or adding modules, when lean_diagnostics reports imports that failed to build, or before a final checkpoint; ordinary edits never need it.",
		],
		parameters: buildSchema,
		executionMode: "sequential",
		async execute(_id, params, signal, onUpdate, ctx) {
			return run(ctx, "lean.build", () => buildOp(inst.runtime(), params, inst.opContext(ctx, signal, progress(onUpdate))));
		},
	});

	pi.registerTool({
		name: "lean_analyze",
		label: "Lean Analyze",
		description:
			"Analyse proofs that already compile. op profile: compile the theorem starting at line on its own with lean " +
			"--profile and report its slowest lines (slow: use it on proofs that are actually slow). op hypotheses: drop each " +
			"explicit (h : T) hypothesis of theorem name in turn on a scratch copy and report which ones the proof needs — " +
			"report only, since removing one changes the statement. op golf: list places in the file where a proof could " +
			"likely be shortened, each to be tried with lean_attempt before applying.",
		promptSnippet: "profile a slow proof line by line, find hypotheses a theorem does not need, or list proof-shortening candidates.",
		promptGuidelines: [
			'lean_analyze {op: "golf"} only finds candidates: try each with lean_attempt and keep it only if it compiles; never change a theorem statement while golfing.',
		],
		parameters: analyzeSchema,
		async execute(_id, params, signal, onUpdate, ctx) {
			const oc = inst.opContext(ctx, signal, progress(onUpdate));
			switch (params.op) {
				case "profile":
					return run(ctx, "lean.analyze.profile", () =>
						profileOp(inst.runtime(), { path: params.path, line: need(params.line, "line", "profile"), topN: params.topN, timeout: params.timeout }, oc),
					);
				case "hypotheses":
					return run(ctx, "lean.analyze.hypotheses", () =>
						hypothesesOp(inst.runtime(), { path: params.path, name: need(params.name, "name", "hypotheses"), timeout: params.timeout }, oc),
					);
				default:
					return run(ctx, "lean.analyze.golf", () => {
						const { file } = requireLeanFile(resolveToolPath(params.path, ctx.cwd));
						const found = golfCandidates(readFileSync(file, "utf8"));
						const shown = displayPath(file, ctx.cwd);
						const text = found.length
							? [
									`${shown}: ${found.length} golfing candidate(s) — try each with lean_attempt before applying:`,
									...found.map((g) => `- line ${g.line} [${g.priority}] ${g.pattern} (~${g.estimate} shorter): ${g.advice}\n${g.snippet.split("\n").map((l) => `    ${l}`).join("\n")}`),
								].join("\n")
							: `${shown}: no golfing candidates found by the pattern detectors.`;
						return { text, details: { op: "golf", path: shown, candidates: found } };
					});
			}
		},
	});
}
