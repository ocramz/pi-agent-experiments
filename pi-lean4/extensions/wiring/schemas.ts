/**
 * The typebox parameter schemas of the eight tools — the only place they exist.
 *
 * One flat object per tool, with an `op`/`source` enum where a tool does
 * several things and per-op required parameters checked in code: a
 * discriminated union does not survive conversion to every provider's schema
 * dialect (pi-notebook-py's tools follow the same rule). Enums are
 * `StringEnum`, which serialises to a plain `{type: "string", enum}`.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	ANALYZE_OPS,
	ATTEMPT_OPS,
	GOAL_KINDS,
	NAV_OPS,
	SEARCH_SOURCES,
	SEVERITIES,
	VERIFY_OPS,
} from "../../src/tools.ts";

const path = (what = "Path to the .lean file (absolute, or relative to the working directory).") =>
	Type.String({ description: what });
const line = (what = "1-indexed line number.") => Type.Integer({ minimum: 1, description: what });
const column = (what = "1-indexed column, counted in characters as shown by read.") => Type.Integer({ minimum: 1, description: what });
const seconds = (what: string) => Type.Number({ minimum: 1, description: what });

export const diagnosticsSchema = Type.Object({
	path: path(),
	startLine: Type.Optional(line("Only report messages ending at or after this line.")),
	endLine: Type.Optional(line("Only report messages starting at or before this line.")),
	declaration: Type.Optional(Type.String({ description: "Only report messages inside this declaration (name or qualified name)." })),
	severity: Type.Optional(StringEnum(SEVERITIES, { description: "Only report messages of this severity." })),
	timeout: Type.Optional(seconds("Seconds to wait for elaboration before returning a partial result (default 600).")),
});

export const goalSchema = Type.Object({
	path: path(),
	line: line(),
	column: Type.Optional(column("Column for the goal at an exact point. Omit to get the goals before and after the whole line.")),
	kind: Type.Optional(StringEnum(GOAL_KINDS, { description: 'tactic (default): the proof goals. term: the expected type of the term at the position.' })),
	timeout: Type.Optional(seconds("Seconds to wait for elaboration (default 600).")),
});

export const navSchema = Type.Object({
	op: StringEnum(NAV_OPS, {
		description:
			"hover, completions, definition, references need line+column (or symbol for definition/references/hover); code_actions needs line; outline needs only path.",
	}),
	path: path(),
	line: Type.Optional(line()),
	column: Type.Optional(column()),
	symbol: Type.Optional(Type.String({ description: "Instead of line+column: a name to look up at its first occurrence in the file." })),
	maxResults: Type.Optional(Type.Integer({ minimum: 1, description: "Cap on completions/references listed (default 50)." })),
	contextLines: Type.Optional(Type.Integer({ minimum: 1, description: "For definition: how many lines of the target to show (default 20)." })),
});

export const attemptSchema = Type.Object({
	op: StringEnum(ATTEMPT_OPS, {
		description: "tactics: try each snippet at path:line[:column] on a scratch copy of the file. code: elaborate standalone code (with its own imports).",
	}),
	path: Type.Optional(path("For tactics: the file. For code: optional, any file of the project the code should be elaborated in.")),
	line: Type.Optional(line("For tactics: the line whose tactic (from column, default its first non-space character) each snippet replaces.")),
	column: Type.Optional(column()),
	snippets: Type.Optional(
		Type.Array(Type.String(), {
			description: "For tactics: candidate tactic(s); a snippet of n lines replaces n lines starting at line. Give 2-4 at once.",
		}),
	),
	code: Type.Optional(Type.String({ description: "For code: complete Lean source, including its imports." })),
	timeout: Type.Optional(seconds("Seconds to wait per candidate (default 600).")),
});

export const searchSchema = Type.Object({
	source: StringEnum(SEARCH_SOURCES, {
		description:
			"local: names in the project, its packages and Lean core (fast, offline). leansearch / leanfinder: natural language. loogle: type patterns and constants. premises: lemmas for the goal at path:line:column.",
	}),
	query: Type.Optional(Type.String({ description: "What to search for. Not used by premises." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "Maximum results." })),
	path: Type.Optional(path("For premises: the file. For local: optional, picks the project when not run from inside it.")),
	line: Type.Optional(line("For premises: the goal's line.")),
	column: Type.Optional(column("For premises: the goal's column.")),
	version: Type.Optional(Type.String({ description: "For leanfinder: Mathlib index version, v4.19.0 / v4.24.0 / v4.28.0 (default the latest)." })),
});

export const verifySchema = Type.Object({
	op: StringEnum(VERIFY_OPS, {
		description: "axioms: what a theorem depends on (needs path; name optional — default every theorem in the file). sorries: every sorry in a file or directory.",
	}),
	path: Type.Optional(path("A .lean file (axioms), or a file or directory (sorries; default the project).")),
	name: Type.Optional(Type.String({ description: "For axioms: the theorem's fully qualified name, e.g. Namespace.theorem." })),
	scanSource: Type.Optional(Type.Boolean({ description: "For axioms: also list soundness-relevant constructs in the file (default true)." })),
});

export const buildSchema = Type.Object({
	path: Type.Optional(path("Any path inside the project (default: the working directory's project).")),
	clean: Type.Optional(Type.Boolean({ description: "Run lake clean first." })),
	fetchCache: Type.Optional(Type.Boolean({ description: "Run lake exe cache get first (Mathlib's prebuilt .oleans; downloads)." })),
	force: Type.Optional(Type.Boolean({ description: "Build even if nothing changed since the last successful build." })),
	outputLines: Type.Optional(Type.Integer({ minimum: 0, description: "Lines of build output to include (default 20)." })),
});

export const analyzeSchema = Type.Object({
	op: StringEnum(ANALYZE_OPS, {
		description: "profile: per-line timing of the theorem starting at line. hypotheses: which explicit hypotheses of theorem name are needed. golf: shortening candidates in the file.",
	}),
	path: path(),
	line: Type.Optional(line("For profile: the line where the theorem starts.")),
	name: Type.Optional(Type.String({ description: "For hypotheses: the theorem's name." })),
	topN: Type.Optional(Type.Integer({ minimum: 1, description: "For profile: how many slowest lines to list (default 5)." })),
	timeout: Type.Optional(seconds("For profile and hypotheses: seconds allowed (default 60).")),
});
