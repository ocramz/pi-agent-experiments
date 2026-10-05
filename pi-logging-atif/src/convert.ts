// A pi session branch, as an ATIF trajectory.
//
// Pure: entries in, a trajectory and the images it references out. No pi
// import — the input types below are declared structurally, and
// extensions/index.ts hands `sessionManager.getBranch()` straight in, so `npm
// run typecheck` is what proves pi's SessionEntry still fits them. A field pi
// renames fails there rather than as a silently missing value here.
//
// ── Why the branch, and not the event stream ───────────────────────────
// The branch is what pi persisted: the same root-to-leaf path its own /export
// walks. Converting it whole on every write means resume, reload, fork and
// /tree navigation all come out right with no state carried between events, and
// a trajectory is reproducible from the session file alone.
//
// ── What the trajectory is not ─────────────────────────────────────────
// It is the transcript, not the payload. An extension's `context` handler can
// rewrite what the model is shown on each call (pi-incremental-py does), and
// that rewrite is not persisted anywhere this can read.

import { createHash } from "node:crypto";
import {
	SCHEMA_VERSION,
	type Content,
	type ContentPart,
	type ContextManagement,
	type FinalMetrics,
	type ImageMediaType,
	type Metrics,
	type ObservationResult,
	type Step,
	type ToolDefinition,
	type Trajectory,
} from "./atif.ts";

/**
 * The custom entry type the extension records the system prompt under.
 *
 * pi 0.84 does not persist the system prompt at all — 0.86 starts writing it as
 * `role: "system"` messages, which this reads too — and a trajectory without
 * one is missing the input that most shapes everything after it.
 */
export const SYSTEM_PROMPT_ENTRY = "atif-system-prompt";

// ── Input: the parts of pi's session types this reads ──────────────────

export interface TextBlock {
	type: "text";
	text: string;
}
export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	redacted?: boolean;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}

export interface Usage {
	/** Uncached input only: pi-ai subtracts cacheRead and cacheWrite before reporting it. */
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** The subset of `output` spent reasoning, when the provider says. */
	reasoning?: number;
	cost: { total: number };
}

type UserContent = string | (TextBlock | ImageBlock)[];

export type PiMessage =
	| { role: "user"; content: UserContent; timestamp: number }
	| {
			role: "assistant";
			content: (TextBlock | ThinkingBlock | ToolCallBlock)[];
			api: string;
			provider: string;
			model: string;
			usage: Usage;
			stopReason: string;
			errorMessage?: string;
			timestamp: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextBlock | ImageBlock)[];
			isError: boolean;
			usage?: Usage;
			timestamp: number;
	  }
	| {
			role: "bashExecution";
			command: string;
			output: string;
			exitCode: number | undefined;
			cancelled: boolean;
			truncated: boolean;
			excludeFromContext?: boolean;
			timestamp: number;
	  }
	| { role: "custom"; customType: string; content: UserContent; timestamp: number }
	| { role: "branchSummary"; summary: string; timestamp: number }
	| { role: "compactionSummary"; summary: string; timestamp: number }
	// pi 0.86+. Not in the 0.84 union, which is fine: an input type may be wider.
	| { role: "system"; content: string | TextBlock[]; timestamp: number };

interface EntryBase {
	id: string;
	/** ISO 8601, as pi writes it. */
	timestamp: string;
}

export type BranchEntry = EntryBase &
	(
		| { type: "message"; message: PiMessage }
		| { type: "thinking_level_change"; thinkingLevel: string }
		| { type: "model_change"; provider: string; modelId: string }
		| { type: "compaction"; summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: Usage }
		| { type: "branch_summary"; summary: string; usage?: Usage }
		| { type: "custom"; customType: string; data?: unknown }
		| { type: "custom_message"; customType: string; content: UserContent }
		| { type: "label" }
		| { type: "session_info" }
	);

export interface SessionHeader {
	id: string;
	timestamp: string;
	cwd: string;
	parentSession?: string;
}

/** What pi reports for a registered tool; `parameters` is a typebox schema, i.e. JSON Schema. */
export interface ToolInfo {
	name: string;
	description?: string;
	parameters?: unknown;
}

export interface ConvertInput {
	header: SessionHeader;
	branch: readonly BranchEntry[];
	/** pi's VERSION. */
	agentVersion: string;
	/** Who wrote the file, e.g. "@ocramz/pi-logging-atif@0.1.0". */
	producer: string;
	/** The session's current model, for `agent.model_name`. Steps carry their own. */
	model?: { id: string; provider: string };
	/** The active tools, as the model is offered them. */
	tools?: readonly ToolInfo[];
	/**
	 * Directory image files are referenced under, relative to the trajectory
	 * file. Images are content-addressed inside it, so a rewrite is idempotent.
	 */
	imageDir: string;
	/**
	 * Used only when the branch holds no recorded prompt — an /atif-export of a
	 * session that ran without the extension enabled. It is the prompt *now*,
	 * which earlier turns may not have seen, and the step says so.
	 */
	fallbackSystemPrompt?: string;
}

export interface ImageFile {
	/** Relative to the trajectory file, exactly as the step references it. */
	path: string;
	/** Base64, as pi holds it. */
	data: string;
}

export interface ConvertOutput {
	trajectory: Trajectory;
	images: ImageFile[];
}

// ── Conversion ─────────────────────────────────────────────────────────

/**
 * The trajectory for a branch, or `undefined` when nothing has happened yet.
 *
 * "Nothing" means no user or agent step. A system prompt alone is not a
 * trajectory: it is what every session starts with, and writing a file for it
 * would leave one behind for every pi that was opened and closed again.
 */
export function toTrajectory(input: ConvertInput): ConvertOutput | undefined {
	const images = new Map<string, ImageFile>();
	const content = (blocks: UserContent): Content => toContent(blocks, input.imageDir, images);

	const steps: Step[] = [];
	// The steps each context-bearing entry produced, so a compaction can re-emit
	// the ones it keeps. Only originals: a copy is never copied again.
	const produced = new Map<string, Step[]>();
	const aux = emptyTotals();
	let lastPrompt: string | undefined;
	let thinkingLevel: string | undefined;
	// The agent step tool results attach to. Reset by anything that starts a turn.
	let agent: Step | undefined;

	const push = (entryId: string | undefined, step: Omit<Step, "step_id">): Step => {
		const s = { step_id: 0, ...step } as Step;
		steps.push(s);
		if (entryId !== undefined) {
			const list = produced.get(entryId) ?? [];
			list.push(s);
			produced.set(entryId, list);
		}
		return s;
	};

	const systemPrompt = (text: string, timestamp: string, entryId: string): void => {
		if (text === lastPrompt) return;
		lastPrompt = text;
		agent = undefined;
		push(undefined, { timestamp, source: "system", message: text, extra: { pi: { entry_id: entryId } } });
	};

	const injection = (entryId: string, timestamp: string, message: Content, pi: Record<string, unknown>): void => {
		agent = undefined;
		push(entryId, {
			timestamp,
			source: "system",
			message,
			extra: { context_management: cm("injection", "append"), pi: { entry_id: entryId, ...pi } },
		});
	};

	input.branch.forEach((entry, index) => {
		switch (entry.type) {
			case "custom":
				if (entry.customType === SYSTEM_PROMPT_ENTRY && isPromptData(entry.data)) {
					systemPrompt(entry.data.text, entry.timestamp, entry.id);
				}
				return;
			case "thinking_level_change":
				thinkingLevel = entry.thinkingLevel;
				return;
			case "custom_message":
				injection(entry.id, entry.timestamp, content(entry.content), { custom_type: entry.customType });
				return;
			case "branch_summary":
				addUsage(aux, entry.usage);
				injection(entry.id, entry.timestamp, entry.summary, { kind: "branch_summary" });
				return;
			case "compaction": {
				addUsage(aux, entry.usage);
				agent = undefined;
				push(entry.id, {
					timestamp: entry.timestamp,
					source: "system",
					message: "Context compaction performed",
					observation: { results: [{ content: entry.summary }] },
					extra: {
						context_management: cm("compaction", "replace"),
						pi: { entry_id: entry.id, tokens_before: entry.tokensBefore },
					},
				});
				// "replace" says the model's context restarts at the summary. pi keeps
				// the tail from firstKeptEntryId as well (buildContextEntries), so the
				// steps that tail produced are re-emitted after the boundary, marked as
				// copies — which is what is_copied_context is for. Their metrics go:
				// the tokens were spent once, by the originals.
				const first = input.branch.findIndex((e) => e.id === entry.firstKeptEntryId);
				if (first < 0 || first >= index) return;
				for (const kept of input.branch.slice(first, index)) {
					for (const original of produced.get(kept.id) ?? []) push(undefined, copyOf(original));
				}
				return;
			}
			case "message":
				break;
			default:
				// model_change carries nothing a step needs (assistant messages name
				// their own model); label and session_info are UI state.
				return;
		}

		const msg = entry.message;
		const timestamp = iso(msg.timestamp, entry.timestamp);
		switch (msg.role) {
			case "system":
				systemPrompt(textOf(msg.content), timestamp, entry.id);
				return;
			case "user":
				agent = undefined;
				push(entry.id, { timestamp, source: "user", message: content(msg.content), extra: piExtra(entry.id) });
				return;
			case "assistant":
				agent = push(entry.id, agentStep(msg, timestamp, entry.id, thinkingLevel));
				return;
			case "toolResult": {
				addUsage(aux, msg.usage);
				const extra = { tool_name: msg.toolName, is_error: msg.isError };
				// A source_call_id that names no call in the step fails validation, so
				// an unmatched result keeps its id in `extra` instead — which is what
				// ATIF calls a result from outside the standard tool-calling flow.
				const result: ObservationResult = agent?.tool_calls?.some((c) => c.tool_call_id === msg.toolCallId)
					? { source_call_id: msg.toolCallId, content: content(msg.content), extra }
					: { content: content(msg.content), extra: { ...extra, tool_call_id: msg.toolCallId } };
				if (agent) {
					agent.observation ??= { results: [] };
					agent.observation.results.push(result);
					return;
				}
				// No agent step to belong to at all.
				push(entry.id, {
					timestamp,
					source: "system",
					message: `Tool result for ${msg.toolName}`,
					observation: { results: [result] },
					extra: piExtra(entry.id),
				});
				return;
			}
			case "bashExecution":
				// `!!cmd` runs without the model ever seeing it.
				if (msg.excludeFromContext) return;
				agent = undefined;
				push(entry.id, {
					timestamp,
					source: "user",
					message: `!${msg.command}`,
					observation: { results: [{ content: msg.output }] },
					extra: {
						pi: {
							entry_id: entry.id,
							kind: "bash",
							exit_code: msg.exitCode,
							cancelled: msg.cancelled,
							truncated: msg.truncated,
						},
					},
				});
				return;
			case "custom":
				injection(entry.id, timestamp, content(msg.content), { custom_type: msg.customType });
				return;
			case "branchSummary":
			case "compactionSummary":
				injection(entry.id, timestamp, msg.summary, { kind: msg.role });
				return;
		}
	});

	if (!steps.some((s) => s.source !== "system")) return undefined;

	if (lastPrompt === undefined && input.fallbackSystemPrompt !== undefined) {
		steps.unshift({
			step_id: 0,
			source: "system",
			message: input.fallbackSystemPrompt,
			extra: { pi: { system_prompt: "current" } },
		});
	}
	steps.forEach((s, i) => {
		s.step_id = i + 1;
	});

	const lastModel = [...input.branch]
		.reverse()
		.map((e) => (e.type === "message" && e.message.role === "assistant" ? e.message : undefined))
		.find((m) => m !== undefined);
	const modelName = input.model?.id ?? lastModel?.model;
	const provider = input.model?.provider ?? lastModel?.provider;

	const trajectory: Trajectory = {
		schema_version: SCHEMA_VERSION,
		session_id: input.header.id,
		trajectory_id: input.header.id,
		agent: {
			name: "pi",
			version: input.agentVersion,
			...(modelName !== undefined && { model_name: modelName }),
			...(input.tools !== undefined && input.tools.length > 0 && { tool_definitions: input.tools.map(toolDefinition) }),
			extra: { ...(provider !== undefined && { provider }), cwd: input.header.cwd, producer: input.producer },
		},
		steps,
		final_metrics: finalMetrics(steps, aux),
		extra: {
			pi: {
				session_started: input.header.timestamp,
				...(input.header.parentSession !== undefined && { parent_session: input.header.parentSession }),
			},
		},
	};
	return { trajectory, images: [...images.values()] };
}

/** The last system prompt recorded on a branch — what a new capture is compared against. */
export function lastRecordedPrompt(branch: readonly BranchEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === SYSTEM_PROMPT_ENTRY && isPromptData(e.data)) return e.data.text;
		if (e.type === "message" && e.message.role === "system") return textOf(e.message.content);
	}
	return undefined;
}

// ── Pieces ─────────────────────────────────────────────────────────────

function agentStep(
	msg: Extract<PiMessage, { role: "assistant" }>,
	timestamp: string,
	entryId: string,
	thinkingLevel: string | undefined,
): Omit<Step, "step_id"> {
	const text = msg.content.filter((b) => b.type === "text").map((b) => b.text);
	const thinking = msg.content.filter((b) => b.type === "thinking");
	const visible = thinking.filter((b) => !b.redacted && b.thinking).map((b) => b.thinking);
	const calls = msg.content.filter((b) => b.type === "toolCall");
	return {
		timestamp,
		source: "agent",
		model_name: msg.model,
		...(thinkingLevel !== undefined && { reasoning_effort: thinkingLevel }),
		message: text.join("\n"),
		...(visible.length > 0 && { reasoning_content: visible.join("\n") }),
		...(calls.length > 0 && {
			tool_calls: calls.map((c) => ({ tool_call_id: c.id, function_name: c.name, arguments: c.arguments ?? {} })),
		}),
		metrics: metricsOf(msg.usage),
		llm_call_count: 1,
		extra: {
			pi: {
				entry_id: entryId,
				provider: msg.provider,
				api: msg.api,
				stop_reason: msg.stopReason,
				...(msg.errorMessage !== undefined && { error_message: msg.errorMessage }),
				...(thinking.some((b) => b.redacted) && { redacted_thinking: true }),
			},
		},
	};
}

function metricsOf(u: Usage): Metrics {
	return {
		prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
		completion_tokens: u.output,
		cached_tokens: u.cacheRead,
		cost_usd: u.cost.total,
		extra: {
			cache_write_tokens: u.cacheWrite,
			...(u.reasoning !== undefined && { reasoning_tokens: u.reasoning }),
		},
	};
}

interface Totals {
	prompt: number;
	completion: number;
	cached: number;
	cost: number;
	seen: boolean;
}

function emptyTotals(): Totals {
	return { prompt: 0, completion: 0, cached: 0, cost: 0, seen: false };
}

function addUsage(t: Totals, u: Usage | undefined): void {
	if (!u) return;
	const m = metricsOf(u);
	t.prompt += m.prompt_tokens ?? 0;
	t.completion += m.completion_tokens ?? 0;
	t.cached += m.cached_tokens ?? 0;
	t.cost += m.cost_usd ?? 0;
	t.seen = true;
}

/**
 * Totals over the agent steps — copies excluded, since their tokens were spent
 * by the originals. LLM calls that belong to no step (a compaction's summary, a
 * tool that called a model itself) are real spend too, but folding them into
 * the totals would make the totals disagree with the steps they claim to sum;
 * they are reported beside them instead.
 */
function finalMetrics(steps: Step[], aux: Totals): FinalMetrics {
	const t = emptyTotals();
	for (const s of steps) {
		if (s.is_copied_context || !s.metrics) continue;
		t.prompt += s.metrics.prompt_tokens ?? 0;
		t.completion += s.metrics.completion_tokens ?? 0;
		t.cached += s.metrics.cached_tokens ?? 0;
		t.cost += s.metrics.cost_usd ?? 0;
	}
	return {
		total_prompt_tokens: t.prompt,
		total_completion_tokens: t.completion,
		total_cached_tokens: t.cached,
		total_cost_usd: t.cost,
		total_steps: steps.length,
		...(aux.seen && {
			extra: {
				auxiliary: {
					prompt_tokens: aux.prompt,
					completion_tokens: aux.completion,
					cached_tokens: aux.cached,
					cost_usd: aux.cost,
				},
			},
		}),
	};
}

function copyOf(original: Step): Omit<Step, "step_id"> {
	const { step_id: _id, metrics: _metrics, ...rest } = structuredClone(original);
	const extra = rest.extra && { ...rest.extra };
	// A kept compaction is context, not a second reset: as a copy it is an
	// injected summary, or every consumer would drop what preceded it twice.
	const managed = extra?.context_management as ContextManagement | undefined;
	if (extra && managed?.boundary === "replace") extra.context_management = cm("injection", "append");
	return { ...rest, ...(extra && { extra }), is_copied_context: true };
}

function toolDefinition(t: ToolInfo): ToolDefinition {
	return {
		type: "function",
		function: {
			name: t.name,
			...(t.description !== undefined && { description: t.description }),
			// typebox schemas carry symbol-keyed metadata; a JSON round trip keeps
			// exactly what a provider would have been sent.
			...(t.parameters !== undefined && { parameters: JSON.parse(JSON.stringify(t.parameters)) }),
		},
	};
}

function toContent(blocks: UserContent, imageDir: string, images: Map<string, ImageFile>): Content {
	if (typeof blocks === "string") return blocks;
	if (!blocks.some((b) => b.type === "image")) return blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
	return blocks.map((b): ContentPart => {
		if (b.type === "text") return { type: "text", text: b.text };
		const ext = IMAGE_EXT[b.mimeType as ImageMediaType];
		if (!ext) return { type: "text", text: `[image omitted: ${b.mimeType} is not a type ATIF accepts]` };
		const hash = createHash("sha256").update(b.data).digest("hex").slice(0, 16);
		const path = `${imageDir}/${hash}.${ext}`;
		images.set(path, { path, data: b.data });
		return { type: "image", source: { media_type: b.mimeType as ImageMediaType, path } };
	});
}

const IMAGE_EXT: Record<ImageMediaType, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/gif": "gif",
	"image/webp": "webp",
};

function textOf(content: string | TextBlock[]): string {
	return typeof content === "string" ? content : content.map((b) => b.text).join("\n");
}

function isPromptData(data: unknown): data is { text: string } {
	return typeof data === "object" && data !== null && typeof (data as { text?: unknown }).text === "string";
}

function iso(ms: number | undefined, fallback: string): string {
	return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : fallback;
}

function cm(type: ContextManagement["type"], boundary: ContextManagement["boundary"]): ContextManagement {
	return { type, boundary };
}

function piExtra(entryId: string): Record<string, unknown> {
	return { pi: { entry_id: entryId } };
}
