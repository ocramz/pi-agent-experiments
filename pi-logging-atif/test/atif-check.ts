// The ATIF constraints Harbor's validator enforces, ported so the unit tier can
// check every trajectory it builds without Python.
//
// A fast oracle, not the authority. The authority is
// `python -m harbor.utils.trajectory_validator`, which the container tier runs
// over the same scenarios (test/container/emit-scenarios.ts) — so if this port
// and Harbor ever disagree, that tier is where it shows. Ported from the
// pydantic models in harbor-framework/harbor src/harbor/models/trajectories/:
// every model there is `extra="forbid"`, which is most of what this checks.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { IMAGE_MEDIA_TYPES } from "../src/atif.ts";

const VERSIONS = ["1.0", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8"].map((v) => `ATIF-v${v}`);
const ROOT = ["schema_version", "session_id", "trajectory_id", "agent", "steps", "notes", "final_metrics",
	"continued_trajectory_ref", "extra", "subagent_trajectories"];
const AGENT = ["name", "version", "model_name", "tool_definitions", "extra"];
const STEP = ["step_id", "timestamp", "source", "model_name", "reasoning_effort", "message", "reasoning_content",
	"tool_calls", "observation", "metrics", "is_copied_context", "llm_call_count", "extra"];
const AGENT_ONLY = ["model_name", "reasoning_effort", "reasoning_content", "tool_calls", "metrics"];
const TOOL_CALL = ["tool_call_id", "function_name", "arguments", "extra"];
const RESULT = ["source_call_id", "content", "subagent_trajectory_ref", "extra"];
const METRICS = ["prompt_tokens", "completion_tokens", "cached_tokens", "cost_usd", "prompt_token_ids",
	"completion_token_ids", "logprobs", "extra"];
const FINAL = ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_cost_usd",
	"total_steps", "extra"];

type Obj = Record<string, unknown>;

/**
 * Every violation in a trajectory, as readable paths. Empty means valid.
 *
 * `baseDir` turns on the validator's one filesystem check: that each local
 * image path exists relative to the trajectory file.
 */
export function atifErrors(t: unknown, baseDir?: string): string[] {
	const errors: string[] = [];
	const err = (path: string, msg: string): void => {
		errors.push(`${path}: ${msg}`);
	};

	if (!isObj(t)) return ["trajectory: not an object"];
	keys(t, ROOT, "trajectory", err);
	if (!VERSIONS.includes(t.schema_version as string)) err("schema_version", `unknown ${String(t.schema_version)}`);
	optString(t, ["session_id", "trajectory_id", "notes", "continued_trajectory_ref"], "trajectory", err);
	optDict(t, "extra", "trajectory", err);

	if (!isObj(t.agent)) err("agent", "required object");
	else {
		keys(t.agent, AGENT, "agent", err);
		for (const k of ["name", "version"]) if (typeof t.agent[k] !== "string") err(`agent.${k}`, "required string");
		optString(t.agent, ["model_name"], "agent", err);
		optDict(t.agent, "extra", "agent", err);
		const defs = t.agent.tool_definitions;
		if (defs !== undefined && (!Array.isArray(defs) || !defs.every(isObj))) err("agent.tool_definitions", "list of dicts");
	}

	if (!Array.isArray(t.steps) || t.steps.length === 0) err("steps", "required, at least one");
	else t.steps.forEach((s, i) => step(s, i, `steps[${i}]`, err, baseDir));

	if (t.final_metrics !== undefined) {
		if (!isObj(t.final_metrics)) err("final_metrics", "object");
		else {
			keys(t.final_metrics, FINAL, "final_metrics", err);
			for (const k of ["total_prompt_tokens", "total_completion_tokens", "total_cached_tokens", "total_steps"]) {
				optInt(t.final_metrics, k, "final_metrics", err);
			}
			optNumber(t.final_metrics, "total_cost_usd", "final_metrics", err);
			optDict(t.final_metrics, "extra", "final_metrics", err);
		}
	}
	return errors;
}

function step(s: unknown, i: number, path: string, err: (p: string, m: string) => void, baseDir?: string): void {
	if (!isObj(s)) return err(path, "not an object");
	keys(s, STEP, path, err);
	if (s.step_id !== i + 1) err(`${path}.step_id`, `expected ${i + 1} (sequential from 1), got ${String(s.step_id)}`);
	if (!["system", "user", "agent"].includes(s.source as string)) err(`${path}.source`, `invalid ${String(s.source)}`);
	if (s.timestamp !== undefined && !isIso(s.timestamp)) err(`${path}.timestamp`, `not ISO 8601: ${String(s.timestamp)}`);
	if (s.source !== "agent") {
		for (const k of AGENT_ONLY) if (s[k] !== undefined) err(`${path}.${k}`, `agent-only, but source is ${String(s.source)}`);
	}
	optString(s, ["model_name", "reasoning_content"], path, err);
	if (s.reasoning_effort !== undefined && !["string", "number"].includes(typeof s.reasoning_effort)) {
		err(`${path}.reasoning_effort`, "string or number");
	}
	content(s.message, `${path}.message`, err, baseDir, true);
	if (s.is_copied_context !== undefined && typeof s.is_copied_context !== "boolean") err(`${path}.is_copied_context`, "bool");
	if (s.llm_call_count !== undefined) {
		if (!Number.isInteger(s.llm_call_count) || (s.llm_call_count as number) < 0) err(`${path}.llm_call_count`, "int >= 0");
		if (s.llm_call_count === 0 && s.source === "agent") {
			for (const k of ["metrics", "reasoning_content"]) if (s[k] !== undefined) err(`${path}.${k}`, "absent when llm_call_count is 0");
		}
	}
	optDict(s, "extra", path, err);

	const ids = new Set<string>();
	if (s.tool_calls !== undefined) {
		if (!Array.isArray(s.tool_calls)) err(`${path}.tool_calls`, "list");
		else s.tool_calls.forEach((c, j) => {
			const p = `${path}.tool_calls[${j}]`;
			if (!isObj(c)) return err(p, "object");
			keys(c, TOOL_CALL, p, err);
			if (typeof c.tool_call_id !== "string") err(`${p}.tool_call_id`, "required string");
			else ids.add(c.tool_call_id);
			if (typeof c.function_name !== "string") err(`${p}.function_name`, "required string");
			if (!isObj(c.arguments)) err(`${p}.arguments`, "required dict");
			optDict(c, "extra", p, err);
		});
	}

	if (s.observation !== undefined) {
		const o = s.observation;
		if (!isObj(o) || !Array.isArray(o.results)) err(`${path}.observation`, "{results: [...]}");
		else {
			keys(o, ["results"], `${path}.observation`, err);
			o.results.forEach((r, j) => {
				const p = `${path}.observation.results[${j}]`;
				if (!isObj(r)) return err(p, "object");
				keys(r, RESULT, p, err);
				if (r.source_call_id !== undefined) {
					if (typeof r.source_call_id !== "string") err(`${p}.source_call_id`, "string");
					else if (!ids.has(r.source_call_id)) err(`${p}.source_call_id`, `${r.source_call_id} is not in this step's tool_calls`);
				}
				if (r.content !== undefined) content(r.content, `${p}.content`, err, baseDir, false);
				optDict(r, "extra", p, err);
			});
		}
	}

	if (s.metrics !== undefined) {
		const m = s.metrics;
		if (!isObj(m)) err(`${path}.metrics`, "object");
		else {
			keys(m, METRICS, `${path}.metrics`, err);
			for (const k of ["prompt_tokens", "completion_tokens", "cached_tokens"]) optInt(m, k, `${path}.metrics`, err);
			optNumber(m, "cost_usd", `${path}.metrics`, err);
			optDict(m, "extra", `${path}.metrics`, err);
		}
	}
}

function content(c: unknown, path: string, err: (p: string, m: string) => void, baseDir: string | undefined, required: boolean): void {
	if (c === undefined) return required ? err(path, "required") : undefined;
	if (typeof c === "string") return;
	if (!Array.isArray(c)) return err(path, "string or list of content parts");
	c.forEach((part, j) => {
		const p = `${path}[${j}]`;
		if (!isObj(part)) return err(p, "object");
		keys(part, ["type", "text", "source"], p, err);
		if (part.type === "text") {
			if (typeof part.text !== "string") err(`${p}.text`, "required when type=text");
			if (part.source !== undefined) err(`${p}.source`, "not allowed when type=text");
		} else if (part.type === "image") {
			if (part.text !== undefined) err(`${p}.text`, "not allowed when type=image");
			const src = part.source;
			if (!isObj(src)) return err(`${p}.source`, "required when type=image");
			keys(src, ["media_type", "path"], `${p}.source`, err);
			if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(src.media_type as string)) {
				err(`${p}.source.media_type`, `not an image type ATIF accepts: ${String(src.media_type)}`);
			}
			if (typeof src.path !== "string") err(`${p}.source.path`, "required string");
			else if (baseDir !== undefined && !/^[a-z]+:\/\//i.test(src.path) && !existsSync(join(baseDir, src.path))) {
				err(`${p}.source.path`, `does not exist: ${src.path}`);
			}
		} else err(`${p}.type`, `invalid ${String(part.type)}`);
	});
}

function keys(o: Obj, allowed: string[], path: string, err: (p: string, m: string) => void): void {
	for (const k of Object.keys(o)) {
		if (o[k] === undefined) continue; // dropped by JSON.stringify, so never seen by the validator
		if (!allowed.includes(k)) err(`${path}.${k}`, "extra field not permitted");
	}
}

function optString(o: Obj, ks: string[], path: string, err: (p: string, m: string) => void): void {
	for (const k of ks) if (o[k] !== undefined && typeof o[k] !== "string") err(`${path}.${k}`, "string");
}

function optInt(o: Obj, k: string, path: string, err: (p: string, m: string) => void): void {
	if (o[k] !== undefined && !Number.isInteger(o[k])) err(`${path}.${k}`, "int");
}

function optNumber(o: Obj, k: string, path: string, err: (p: string, m: string) => void): void {
	if (o[k] !== undefined && (typeof o[k] !== "number" || !Number.isFinite(o[k]))) err(`${path}.${k}`, "number");
}

function optDict(o: Obj, k: string, path: string, err: (p: string, m: string) => void): void {
	if (o[k] !== undefined && !isObj(o[k])) err(`${path}.${k}`, "dict");
}

function isObj(v: unknown): v is Obj {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** What `datetime.fromisoformat(v.replace("Z", "+00:00"))` accepts, near enough for what we emit. */
function isIso(v: unknown): boolean {
	return typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(v);
}
