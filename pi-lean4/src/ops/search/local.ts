/**
 * Local declaration search: ripgrep over the project, its packages and Lean's
 * own sources, plus the server's symbol index when a server is already up.
 *
 * Ported from lean-lsp-mcp search_utils.py (MIT, © 2025 Oliver Dressler):
 * the declaration pattern (attributes and modifiers allowed before the
 * keyword), searching the *last* name component and re-qualifying each hit by
 * the namespaces above it, the ranking (exact > prefix > substring, project
 * over packages, shorter first), and the index merge — `workspace/symbol`
 * knows the declarations attributes generate (`@[to_additive]` alone makes
 * ~16k in Mathlib) that never exist as text for ripgrep to find.
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LeanToolError } from "../../errors.ts";
import { isInside } from "../../lean/project.ts";
import type { SymbolInformation } from "../../lsp/protocol.ts";

const KEYWORDS = ["theorem", "lemma", "def", "axiom", "class", "instance", "structure", "inductive", "abbrev", "opaque"];
const MODIFIERS = ["public", "protected", "private", "noncomputable", "partial", "unsafe", "scoped", "local"];
const LEAD = `^\\s*(?:@\\[[^\\]]*\\]\\s*)*(?:(?:${MODIFIERS.join("|")})\\s+)*`;
const LINE_RE = new RegExp(`${LEAD}(${KEYWORDS.join("|")})\\s+([A-Za-z0-9_'\\p{L}]+(?:\\.[A-Za-z0-9_'\\p{L}]+)*)`, "u");

export interface LocalHit {
	name: string;
	kind: string;
	file: string;
	line?: number;
	source: "text" | "index";
}

export function rgPattern(query: string): string {
	const last = query.split(".").pop() ?? query;
	const escaped = last.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return `${LEAD}(?:${KEYWORDS.join("|")})\\s+(?:[A-Za-z0-9_'.]+\\.)*${escaped}[A-Za-z0-9_'.]*(?:\\s|:|$)`;
}

/** The namespace prefix in force at each requested 1-based line. */
export function namespacesAt(text: string, wanted: ReadonlySet<number>): Map<number, string> {
	const out = new Map<number, string>();
	const stack: (string | null)[] = [];
	const lines = text.split("\n");
	const last = Math.max(0, ...wanted);
	for (let i = 0; i < Math.min(lines.length, last); i++) {
		const s = lines[i].trim();
		let m: RegExpExecArray | null;
		if ((m = /^namespace\s+([\w.'\p{L}]+)/u.exec(s))) stack.push(m[1]);
		else if (/^(?:noncomputable\s+)?(?:section|mutual)\b/.test(s)) stack.push(null);
		else if (/^end\b/.test(s)) stack.pop();
		if (wanted.has(i + 1)) out.set(i + 1, stack.filter((x): x is string => x !== null).join("."));
	}
	return out;
}

export function rank(hit: LocalHit, query: string): [number, number, number, string, string] {
	const q = query.toLowerCase();
	const name = hit.name.toLowerCase();
	const base = name.split(".").pop() ?? name;
	let r: number;
	if (q.includes(".")) {
		r = name === q ? 0 : name.startsWith(q) ? 1 : name.includes(q) ? 2 : base === q ? 3 : base.startsWith(q) ? 4 : base.includes(q) ? 5 : 6;
	} else {
		r = name === q || base === q ? 0 : base.startsWith(q) ? 1 : base.includes(q) ? 2 : name.startsWith(q) ? 3 : name.includes(q) ? 4 : 5;
	}
	const pkg = hit.file.startsWith(".lake/packages/") || hit.file.startsWith("<stdlib>") ? 1 : 0;
	return [r, pkg, base.length, base, hit.name];
}

function compare(a: readonly (number | string)[], b: readonly (number | string)[]): number {
	for (let i = 0; i < a.length; i++) {
		if (a[i] < b[i]) return -1;
		if (a[i] > b[i]) return 1;
	}
	return 0;
}

export function displayFor(path: string, root: string, stdlib: string | null): string | null {
	if (isInside(path, root)) return relative(root, path);
	if (stdlib && isInside(path, stdlib)) return `<stdlib>/${relative(stdlib, path)}`;
	return null;
}

/** rg --json lines → declaration hits (unqualified). */
export function parseRgJson(output: string, root: string, stdlib: string | null): (LocalHit & { abs: string; line: number })[] {
	const hits: (LocalHit & { abs: string; line: number })[] = [];
	for (const line of output.split("\n")) {
		if (!line) continue;
		let ev: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
		try {
			ev = JSON.parse(line);
		} catch {
			continue;
		}
		if (ev.type !== "match" || !ev.data?.path?.text) continue;
		const m = LINE_RE.exec(ev.data.lines?.text ?? "");
		if (!m) continue;
		const abs = isAbsolute(ev.data.path.text) ? ev.data.path.text : join(root, ev.data.path.text);
		const file = displayFor(abs, root, stdlib);
		if (!file) continue;
		hits.push({ name: m[2], kind: m[1], file, abs, line: ev.data.line_number ?? 0, source: "text" });
	}
	return hits;
}

export function qualifyAndRank(hits: (LocalHit & { abs: string; line: number })[], query: string, limit: number): LocalHit[] {
	const byFile = new Map<string, Set<number>>();
	for (const h of hits) byFile.set(h.abs, (byFile.get(h.abs) ?? new Set()).add(h.line));
	const ns = new Map<string, Map<number, string>>();
	for (const [file, lines] of byFile) {
		try {
			ns.set(file, namespacesAt(readFileSync(file, "utf8"), lines));
		} catch {
			ns.set(file, new Map());
		}
	}
	let out: LocalHit[] = hits.map((h) => {
		const prefix = ns.get(h.abs)?.get(h.line) ?? "";
		return { name: prefix && !h.name.startsWith("_root_.") ? `${prefix}.${h.name}` : h.name.replace(/^_root_\./, ""), kind: h.kind, file: h.file, line: h.line, source: "text" };
	});
	const q = query.toLowerCase();
	if (q.includes(".")) out = out.filter((h) => h.name.toLowerCase().includes(q));
	out.sort((a, b) => compare(rank(a, query), rank(b, query)));
	const seen = new Set<string>();
	const deduped: LocalHit[] = [];
	for (const h of out) {
		const k = `${h.name}\0${h.kind}\0${h.file}`;
		if (seen.has(k)) continue;
		seen.add(k);
		deduped.push(h);
		if (deduped.length >= limit) break;
	}
	return deduped;
}

export function isCompilerHelper(name: string): boolean {
	const bare = name.replace(/^_root_\./, "");
	let leaf = bare.split(".").pop() ?? bare;
	if (leaf.startsWith("«") && leaf.endsWith("»")) leaf = leaf.slice(1, -1);
	const macroHelper = bare.startsWith("_private.") && leaf.startsWith("_aux_") && leaf.includes("_macroRules_");
	const hygienic = bare.includes("._@.") && bare.includes("._hygCtx._hyg.");
	return macroHelper || hygienic;
}

export function indexHits(symbols: readonly SymbolInformation[], root: string, stdlib: string | null, query: string): LocalHit[] {
	const wanted = query.trim().replace(/^_root_\./, "");
	const out: LocalHit[] = [];
	for (const s of symbols) {
		if (!s.name || (isCompilerHelper(s.name) && s.name.replace(/^_root_\./, "") !== wanted)) continue;
		let path: string;
		try {
			path = fileURLToPath(s.location.uri);
		} catch {
			continue;
		}
		const file = displayFor(path, root, stdlib);
		if (!file) continue;
		out.push({ name: s.name, kind: "declaration", file, line: s.location.range.start.line + 1, source: "index" });
	}
	return out;
}

export function merge(text: readonly LocalHit[], index: readonly LocalHit[], query: string, limit: number): LocalHit[] {
	const merged = [...text];
	const seen = new Set(merged.map((h) => h.name));
	for (const h of index) {
		if (seen.has(h.name)) continue;
		seen.add(h.name);
		merged.push(h);
	}
	merged.sort((a, b) => compare(rank(a, query), rank(b, query)));
	return merged.slice(0, limit);
}

/** Run ripgrep; stops reading after `maxCandidates` matches. */
export function runRg(rg: string, query: string, root: string, stdlib: string | null, maxCandidates: number, signal?: AbortSignal): Promise<string> {
	const args = [
		"--json",
		"--no-ignore",
		"--smart-case",
		"--hidden",
		"--color",
		"never",
		"--no-messages",
		"-g",
		"*.lean",
		"-g",
		"!.git/**",
		"-g",
		"!.lake/build/**",
		"-g",
		"!_PiLean4*",
		rgPattern(query),
		root,
		...(stdlib ? [stdlib] : []),
	];
	return new Promise((resolve, reject) => {
		const child = spawn(rg, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], signal });
		let out = "";
		let err = "";
		let matches = 0;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (c: string) => {
			out += c;
			matches += (c.match(/"type":"match"/g) ?? []).length;
			if (matches >= maxCandidates) child.kill();
		});
		child.stderr.on("data", (c: Buffer) => {
			if (err.length < 10_000) err += String(c);
		});
		child.on("error", (e) => {
			if (signal?.aborted) reject(e);
			else reject(new LeanToolError(`could not run ripgrep (${rg}): ${e.message}`));
		});
		child.on("close", (code) => {
			if (code !== null && code > 1 && !out) reject(new LeanToolError(`ripgrep failed (exit ${code}): ${err.trim().slice(0, 500)}`));
			else resolve(out);
		});
	});
}
