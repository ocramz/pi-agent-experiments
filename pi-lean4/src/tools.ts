/**
 * The extension's public contract with the model, as plain data: tool names,
 * the enums their parameters take, and the command names. The typebox schemas
 * in extensions/wiring/schemas.ts are built from these, and the unit tier
 * checks the skills against them (every `lean_*` and `{op: "…"}` a skill
 * mentions must exist here) without pi installed.
 */

export const TOOL_NAMES = [
	"lean_diagnostics",
	"lean_goal",
	"lean_nav",
	"lean_attempt",
	"lean_search",
	"lean_verify",
	"lean_build",
	"lean_analyze",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export const SEVERITIES = ["error", "warning", "info", "hint"] as const;
export const GOAL_KINDS = ["tactic", "term"] as const;
export const NAV_OPS = ["hover", "completions", "definition", "references", "code_actions", "outline"] as const;
export const ATTEMPT_OPS = ["tactics", "code"] as const;
export const SEARCH_SOURCES = ["local", "leansearch", "loogle", "leanfinder", "premises"] as const;
export const VERIFY_OPS = ["axioms", "sorries"] as const;
export const ANALYZE_OPS = ["profile", "hypotheses", "golf"] as const;

/** Which enum-valued parameter each tool has, and its values. */
export const TOOL_ENUMS: Record<ToolName, Record<string, readonly string[]>> = {
	lean_diagnostics: { severity: SEVERITIES },
	lean_goal: { kind: GOAL_KINDS },
	lean_nav: { op: NAV_OPS },
	lean_attempt: { op: ATTEMPT_OPS },
	lean_search: { source: SEARCH_SOURCES },
	lean_verify: { op: VERIFY_OPS },
	lean_build: {},
	lean_analyze: { op: ANALYZE_OPS },
};

/** `/lean` and its subcommands. Prompt templates must not collide with "lean". */
export const COMMAND = "lean";
export const SUBCOMMANDS = ["status", "restart", "stop", "build", "autoprove", "stop-autoprove", "guardrails", "help"] as const;

/** The customType of autoprove's session entries and messages. */
export const AUTOPROVE_TYPE = "lean-autoprove";
/** The customType of the setup-check message the model is given. */
export const SETUP_TYPE = "lean-setup";
/** The flag that turns every network-reaching feature off. */
export const OFFLINE_FLAG = "lean-offline";

/** Sent to the Lean server as clientInfo. test/tools.test.ts keeps it equal to package.json's. */
export const VERSION = "0.1.0";
