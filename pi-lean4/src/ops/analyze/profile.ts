/**
 * lean_analyze {op: "profile"}: where a slow proof spends its time.
 *
 * Ported from lean-lsp-mcp profile_utils.py (MIT, © 2025 Oliver Dressler).
 * The file up to the end of the theorem is copied to a temporary file under
 * <root>/.lake/pi-lean4/ (never beside the user's sources), compiled with
 * `lake env lean --profile -Dtrace.profiler=true`, and the trace is mapped
 * back to source lines. The compiler runs in its own process group, killed on
 * timeout or abort — an orphaned `lean` on a Mathlib file holds gigabytes.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeanToolError } from "../../errors.ts";
import { requireLeanFile, resolveToolPath, displayPath } from "../../lean/project.ts";
import type { LeanRuntime } from "../../lean/runtime.ts";
import { asError, lakeMissing } from "../../lean/preflight.ts";
import { locate } from "../../lean/toolchain.ts";
import { runGroup } from "../build.ts";
import type { OpContext, OpResult } from "../common.ts";

const TRACE = /^(\s*)\[([^\]]+)\]\s+\[([\d.]+)\]\s+(.+)$/;
const STATUS = /^(?:✅|❌|\u{1f4a5})️?\s*/u;
const CUMULATIVE = /^\s+(\S+(?:\s+\S+)*)\s+([\d.]+)(ms|s)$/;
const DECL = /^\s*(?:private\s+)?(theorem|lemma|def)\s+(\S+)/;
const SKIP_CATEGORIES = new Set(["import", "initialization", "parsing", "interpretation", "linting"]);

/**
 * The file up to the end of the theorem at `line` (1-based). Upstream kept only
 * the import header, which fails on any theorem using an earlier declaration
 * of the same file; the whole prefix costs what the file costs anyway, and the
 * trace is attributed to the target by name.
 */
export function extractTheorem(lines: readonly string[], line: number): { source: string; name: string; start: number; end: number } {
	const m = DECL.exec(lines[line - 1] ?? "");
	if (!m) throw new LeanToolError(`no theorem/lemma/def starts at line ${line}`);
	let end = lines.length;
	for (let i = line; i < lines.length; i++) {
		if (DECL.test(lines[i]) || /^\s*(end|namespace|section)\b/.test(lines[i]) || /^\s*@\[/.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { source: `${lines.slice(0, end).join("\n")}\n`, name: m[2], start: line, end };
}

export function parseProfile(output: string): { traces: [number, string, number, string][]; cumulative: Record<string, number> } {
	const traces: [number, string, number, string][] = [];
	const cumulative: Record<string, number> = {};
	let inCumulative = false;
	for (const line of output.split("\n")) {
		if (line.includes("cumulative profiling times:")) inCumulative = true;
		else if (inCumulative) {
			const m = CUMULATIVE.exec(line);
			if (m) cumulative[m[1]] = Number(m[2]) * (m[3] === "s" ? 1000 : 1);
		} else {
			const m = TRACE.exec(line);
			if (m) traces.push([Math.floor(m[1].length / 2), m[2], Number(m[3]) * 1000, m[4]]);
		}
	}
	return { traces, cumulative };
}

export function lineTimes(
	traces: readonly [number, string, number, string][],
	name: string,
	sourceLines: readonly string[],
	proofStart: number,
): { times: Map<number, number>; total: number } {
	const items: [number, string, boolean][] = [];
	for (let i = proofStart; i < sourceLines.length; i++) {
		const s = sourceLines[i].trim();
		if (s && !s.startsWith("--")) items.push([i + 1, s.replace(/^[·*\-\s]+/, ""), "·*-".includes(s[0])]);
	}
	const used = new Set<number>();
	const match = (tactic: string, bullet: boolean): number | null => {
		for (const [ln, content, srcBullet] of items) {
			if (used.has(ln)) continue;
			if (bullet && srcBullet) return ln;
			if (!bullet && content && (tactic.startsWith(content.slice(0, 25)) || content.startsWith(tactic.slice(0, 25)))) return ln;
		}
		return null;
	};
	const times = new Map<number, number>();
	let total = 0;
	let inValue = false;
	let valueDepth = 0;
	let tacticDepth: number | null = null;
	const nameRe = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
	for (const [depth, cls, ms, msg] of traces) {
		if (cls === "Elab.definition.value" && nameRe.test(msg)) {
			inValue = true;
			valueDepth = depth;
			total = ms;
		} else if (cls === "Elab.async" && msg.includes(`proof of ${name}`)) {
			total = Math.max(total, ms);
		} else if (inValue) {
			if (depth <= valueDepth) break;
			if (cls === "Elab.step") {
				const head = msg.split("\n")[0].trim().replace(STATUS, "");
				if (head && !head.startsWith("expected type:")) {
					tacticDepth ??= depth;
					if (depth === tacticDepth) {
						const tactic = head.replace(/^[·*\-\s]+/, "");
						const ln = match(tactic, !tactic);
						if (ln !== null) {
							times.set(ln, (times.get(ln) ?? 0) + ms);
							used.add(ln);
						}
					}
				}
			}
		}
	}
	return { times, total };
}

export async function profileOp(
	rt: LeanRuntime,
	input: { path: string; line: number; topN?: number; timeout?: number },
	oc: OpContext,
): Promise<OpResult> {
	const { file, root } = requireLeanFile(resolveToolPath(input.path, oc.cwd));
	const lake = locate("lake", { explicit: oc.cfg.lake });
	if (!lake.path) throw new LeanToolError(asError(lakeMissing(lake, oc.cfg)));
	const lines = readFileSync(file, "utf8").split("\n");
	if (input.line < 1 || input.line > lines.length) throw new LeanToolError(`line ${input.line} is out of range (the file has ${lines.length} lines)`);
	const { source, name, start, end } = extractTheorem(lines, input.line);
	const sourceLines = source.split("\n");
	const rel = sourceLines.slice(start - 1, end).findIndex((l) => l.includes(":= by") || /\sby\s*$/.test(l));
	const proofStart = rel < 0 ? -1 : start - 1 + rel;
	if (proofStart < 0) throw new LeanToolError("no tactic proof (`:= by`) found in that declaration; profiling maps tactic steps to lines");
	const dir = join(root, ".lake", "pi-lean4");
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `profile-${process.pid}-${Date.now()}.lean`);
	writeFileSync(tmp, source);
	const timeoutMs = (input.timeout ?? 60) * 1000;
	oc.onProgress?.(`profiling ${name} (lean --profile)`);
	let out: Awaited<ReturnType<typeof runGroup>>;
	try {
		out = await runGroup(lake.path, ["env", "lean", "--profile", "-Dtrace.profiler=true", "-Dtrace.profiler.threshold=0", tmp], {
			cwd: root,
			signal: AbortSignal.any([rt.lifetime, ...(oc.signal ? [oc.signal] : [])]),
			timeoutMs,
		});
	} finally {
		rmSync(tmp, { force: true });
	}
	if (out.aborted) {
		const e = new Error("profiling was aborted");
		e.name = "AbortError";
		throw e;
	}
	if (out.timedOut) throw new LeanToolError(`profiling timed out after ${timeoutMs / 1000}s (raise timeout, or profile a smaller proof)`);
	const output = out.lines.join("\n");
	// Only errors inside the theorem invalidate its profile; elsewhere in the
	// prefix they are the file's business (lean_diagnostics reports them).
	const errors = out.lines
		.filter((l) => /(^|: )error[(:]/.test(l))
		.filter((l) => {
			const at = /\.lean:(\d+):\d+:/.exec(l);
			return !at || (Number(at[1]) >= start && Number(at[1]) <= end);
		})
		.map((l) => l.replace(tmp, displayPath(file, oc.cwd)).trim());
	if (errors.length) throw new LeanToolError(`the theorem does not compile, so it cannot be profiled: ${errors.slice(0, 5).join(" | ")}`);
	const { traces, cumulative } = parseProfile(output);
	const { times, total } = lineTimes(traces, name, sourceLines, proofStart + 1);
	const offset = 0;
	const top = [...times.entries()]
		.filter(([, ms]) => ms >= total * 0.01)
		.sort((a, b) => b[1] - a[1])
		.slice(0, input.topN ?? 5)
		.map(([ln, ms]) => ({ line: ln + offset, ms: Math.round(ms * 10) / 10, text: (sourceLines[ln - 1] ?? "").trim().slice(0, 60) }));
	const categories = Object.entries(cumulative)
		.filter(([k, v]) => !SKIP_CATEGORIES.has(k) && v >= 1)
		.sort((a, b) => b[1] - a[1])
		.map(([k, v]) => [k, Math.round(v * 10) / 10] as const);
	const text = [
		`${displayPath(file, oc.cwd)}: ${name} elaborates in ${Math.round(total)} ms`,
		...(top.length ? ["slowest lines:", ...top.map((t) => `  ${t.line}: ${t.ms} ms  ${t.text}`)] : ["(no per-line timing could be attributed)"]),
		...(categories.length ? ["by category:", ...categories.slice(0, 8).map(([k, v]) => `  ${k}: ${v} ms`)] : []),
	].join("\n");
	return { text, details: { name, totalMs: total, lines: top, categories: Object.fromEntries(categories) } };
}
