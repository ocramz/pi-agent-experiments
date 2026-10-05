// ATIF — the Agent Trajectory Interchange Format — as TypeScript types.
//
// A transcription of Harbor's pydantic models (src/harbor/models/trajectories/
// in harbor-framework/harbor), which are the specification in executable form:
// the RFC (rfcs/0001-trajectory-format.md) describes the fields, but it is the
// models that decide what a validator accepts. Every model there is
// `extra="forbid"`, so a key that is not declared here is not a harmless
// extension — it fails validation. Producer-specific data goes under `extra`.
//
// Only the fields this producer can fill are worth caring about, but all of
// them are declared so the types say what the format allows rather than what
// we happen to emit. Fields from v1.8 (audio) are left out: we emit v1.7, which
// both older Harbor releases and the current one accept.

export const SCHEMA_VERSION = "ATIF-v1.7";

export type Extra = Record<string, unknown>;

/** The image MIME types ImageSource accepts. Anything else fails validation. */
export const IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface ImageSource {
	media_type: ImageMediaType;
	/** Relative to the trajectory file, absolute, or a URL. Validated to exist when local. */
	path: string;
}

export type ContentPart = { type: "text"; text: string } | { type: "image"; source: ImageSource };

/** A plain string for text-only content, parts once an image is involved (v1.6+). */
export type Content = string | ContentPart[];

export interface ToolCall {
	tool_call_id: string;
	function_name: string;
	arguments: Record<string, unknown>;
	extra?: Extra;
}

export interface ObservationResult {
	/** Must name a tool_call_id in the same step's tool_calls when present. */
	source_call_id?: string;
	content?: Content;
	extra?: Extra;
}

export interface Observation {
	results: ObservationResult[];
}

export interface Metrics {
	/** All input tokens, cached and uncached alike. */
	prompt_tokens?: number;
	completion_tokens?: number;
	/** The subset of prompt_tokens that were cache hits. */
	cached_tokens?: number;
	cost_usd?: number;
	extra?: Extra;
}

export type Source = "system" | "user" | "agent";

export interface Step {
	/** 1..n with no gaps, in array order. */
	step_id: number;
	/** ISO 8601. */
	timestamp?: string;
	source: Source;
	// The next five are agent-only: the validator rejects them on any other source.
	model_name?: string;
	reasoning_effort?: string | number;
	message: Content;
	reasoning_content?: string;
	tool_calls?: ToolCall[];
	observation?: Observation;
	metrics?: Metrics;
	/** Re-included for context after a summarisation; not new behaviour. */
	is_copied_context?: boolean;
	llm_call_count?: number;
	extra?: Extra;
}

/** OpenAI's function-calling shape, which is what ATIF specifies for tool_definitions. */
export interface ToolDefinition {
	type: "function";
	function: { name: string; description?: string; parameters?: unknown };
}

export interface Agent {
	name: string;
	version: string;
	model_name?: string;
	tool_definitions?: ToolDefinition[];
	extra?: Extra;
}

export interface FinalMetrics {
	total_prompt_tokens?: number;
	total_completion_tokens?: number;
	total_cached_tokens?: number;
	total_cost_usd?: number;
	total_steps?: number;
	extra?: Extra;
}

export interface Trajectory {
	schema_version: typeof SCHEMA_VERSION;
	session_id?: string;
	trajectory_id?: string;
	agent: Agent;
	/** At least one. */
	steps: Step[];
	notes?: string;
	final_metrics?: FinalMetrics;
	continued_trajectory_ref?: string;
	extra?: Extra;
}

/**
 * The convention ATIF uses for context-window transformations, carried in a
 * system step's `extra`. With `boundary: "replace"`, the model's context for
 * every later step is the boundary step's observation plus what follows it.
 */
export interface ContextManagement {
	type: "compaction" | "pruning" | "injection";
	boundary: "replace" | "append" | "truncate";
}
