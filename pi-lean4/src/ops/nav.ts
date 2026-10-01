/**
 * lean_nav: hover, completions, definition, references, code actions, outline.
 *
 * Ported from lean-lsp-mcp tools/navigation.py (MIT, © 2025 Oliver Dressler).
 * Code actions are *reported*, never applied — the model applies them with
 * `edit`, which keeps every change to a file in pi's own transcript.
 *
 * Code actions are asked for per diagnostic on the line, with the diagnostic's
 * own range (a "Try this" always comes with one); a line without diagnostics
 * is asked about as a whole.
 */

import { fileURLToPath } from "node:url";
import { LeanToolError } from "../errors.ts";
import { parseImports } from "../lean/imports.ts";
import { displayPath } from "../lean/project.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import { type Range, codepointLength, rangeFromLsp, splitLines } from "../lsp/positions.ts";
import {
	type CodeAction,
	COMPLETION_KINDS,
	type CompletionItem,
	type Diagnostic,
	type DocumentSymbol,
	type Hover,
	type Location,
	type LocationLink,
	SYMBOL_KINDS,
	type TextEdit,
} from "../lsp/protocol.ts";
import { boundText, indent, unfence } from "../format.ts";
import { type OpContext, type OpResult, withFile, withNotes } from "./common.ts";

export type NavOp = "hover" | "completions" | "definition" | "references" | "code_actions" | "outline";

export interface NavInput {
	op: NavOp;
	path: string;
	line?: number;
	column?: number;
	symbol?: string;
	maxResults?: number;
	contextLines?: number;
}

function need<T>(v: T | undefined, key: string, op: string): T {
	if (v === undefined || v === null) throw new LeanToolError(`${key} is required for op "${op}"`);
	return v;
}

function hoverText(h: Hover | null): string {
	if (!h) return "";
	const c = h.contents;
	if (typeof c === "string") return unfence(c);
	if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? x : x.value)).join("\n");
	return unfence(c.value);
}

/** Where `symbol` first occurs in the file as a whole word, as a 1-indexed point. */
export function findSymbol(lines: readonly string[], symbol: string): { line: number; column: number } | null {
	const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(`(^|[^\\p{L}\\p{N}_.'])(${escaped})(?![\\p{L}\\p{N}_'])`, "u");
	for (let i = 0; i < lines.length; i++) {
		const m = re.exec(lines[i]);
		if (m) return { line: i + 1, column: [...lines[i].slice(0, m.index + m[1].length)].length + 1 };
	}
	return null;
}

function rankCompletions(items: CompletionItem[], prefix: string): CompletionItem[] {
	const p = prefix.toLowerCase();
	const score = (c: CompletionItem) => {
		const l = c.label.toLowerCase();
		return l.startsWith(p) ? 0 : l.includes(p) ? 1 : 2;
	};
	return [...items].sort((a, b) => {
		if (a.sortText !== undefined && b.sortText !== undefined && a.sortText !== b.sortText) return a.sortText < b.sortText ? -1 : 1;
		return score(a) - score(b) || a.label.localeCompare(b.label);
	});
}

function locations(r: Location | Location[] | LocationLink[] | null): { uri: string; range: Range }[] {
	if (!r) return [];
	const list = Array.isArray(r) ? r : [r];
	return list.map((l) => ("targetUri" in l ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l));
}

function editsOf(action: CodeAction, uri: string): TextEdit[] {
	const e = action.edit;
	if (!e) return [];
	const fromDocs = (e.documentChanges ?? []).filter((d) => d.textDocument.uri === uri).flatMap((d) => d.edits);
	return fromDocs.length ? fromDocs : (e.changes?.[uri] ?? []);
}

export interface OutlineEntry {
	name: string;
	kind: string;
	startLine: number;
	endLine: number;
	signature: string;
	children: OutlineEntry[];
}

function signatureOf(lines: readonly string[], startLine: number, endLine: number): string {
	const text = lines.slice(startLine - 1, endLine).join("\n");
	const at = text.indexOf(":=");
	const head = (at >= 0 ? text.slice(0, at) : text.split("\n")[0]).replace(/\s+/g, " ").trim();
	return head.length > 200 ? `${head.slice(0, 197)}...` : head;
}

function outlineOf(symbols: readonly DocumentSymbol[], lines: readonly string[]): OutlineEntry[] {
	return symbols.map((s) => {
		const r = rangeFromLsp(lines, s.range);
		return {
			name: s.name,
			kind: SYMBOL_KINDS[s.kind] ?? String(s.kind),
			startLine: r.start.line,
			endLine: r.end.line,
			signature: s.kind === 3 ? "" : signatureOf(lines, r.start.line, r.end.line),
			children: outlineOf(s.children ?? [], lines),
		};
	});
}

function renderOutline(entries: readonly OutlineEntry[], depth = 0): string[] {
	const out: string[] = [];
	for (const e of entries) {
		const pad = "  ".repeat(depth);
		const lines = e.startLine === e.endLine ? `${e.startLine}` : `${e.startLine}–${e.endLine}`;
		out.push(`${pad}${lines}  ${e.kind} ${e.name}${e.signature && e.kind !== "namespace" ? `\n${pad}    ${e.signature}` : ""}`);
		out.push(...renderOutline(e.children, depth + 1));
	}
	return out;
}

export async function navOp(rt: LeanRuntime, input: NavInput, oc: OpContext): Promise<OpResult> {
	const { value, notes } = await withFile(rt, input.path, oc, async (doc, server, { shown }) => {
		const td = { uri: doc.uri };
		const max = input.maxResults ?? 50;
		switch (input.op) {
			case "outline": {
				const symbols = (await doc.request<DocumentSymbol[] | null>("textDocument/documentSymbol", { textDocument: td }, { signal: oc.signal })) ?? [];
				const entries = outlineOf(symbols, doc.lines);
				const imports = parseImports(doc.text);
				const text = [
					`${shown}: ${doc.lines.length} lines`,
					`imports: ${imports.length ? imports.join(", ") : "(none)"}`,
					...(entries.length ? renderOutline(entries) : ["(no declarations)"]),
				].join("\n");
				return { text, details: { op: "outline", imports, declarations: entries } };
			}
			case "code_actions": {
				const line = need(input.line, "line", "code_actions");
				doc.pos(line, 1);
				await doc.diagnostics({ signal: oc.signal });
				const onLine = doc.current().filter((d: Diagnostic) => {
					const r = d.fullRange ?? d.range;
					return r.start.line <= line - 1 && r.end.line >= line - 1;
				});
				const ranges: { range: Range; diagnostics: Diagnostic[] }[] = onLine.map((d) => ({ range: d.fullRange ?? d.range, diagnostics: [d] }));
				if (ranges.length === 0) {
					const text = doc.lines[line - 1];
					const start = doc.pos(line, Math.max(1, [...text].length - [...text.trimStart()].length + 1));
					ranges.push({ range: { start, end: doc.pos(line, codepointLength(text) + 1) }, diagnostics: [] });
				}
				const actions: { title: string; preferred: boolean; edits: { start: string; end: string; newText: string }[] }[] = [];
				const seen = new Set<string>();
				for (const r of ranges) {
					const found =
						(await doc.request<CodeAction[] | null>(
							"textDocument/codeAction",
							{ textDocument: td, range: r.range, context: { diagnostics: r.diagnostics, triggerKind: 1 } },
							{ signal: oc.signal },
						)) ?? [];
					for (let a of found) {
						if (!a.edit) a = (await doc.request<CodeAction>("codeAction/resolve", a, { signal: oc.signal }).catch(() => a)) ?? a;
						const edits = editsOf(a, doc.uri).map((e) => {
							const p = rangeFromLsp(doc.lines, e.range);
							return { start: `${p.start.line}:${p.start.column}`, end: `${p.end.line}:${p.end.column}`, newText: e.newText };
						});
						const key = `${a.title}\0${JSON.stringify(edits)}`;
						if (seen.has(key)) continue;
						seen.add(key);
						actions.push({ title: a.title, preferred: !!a.isPreferred, edits });
					}
				}
				const text = actions.length
					? [
							`${shown}:${line}: ${actions.length} code action(s) (not applied — apply with edit):`,
							...actions.map(
								(a) =>
									`- ${a.title}${a.preferred ? " (preferred)" : ""}` +
									a.edits.map((e) => `\n    replace ${e.start}–${e.end} with:\n${indent(e.newText, "      ")}`).join(""),
							),
						].join("\n")
					: `${shown}:${line}: no code actions on this line.`;
				return { text, details: { op: "code_actions", line, actions } };
			}
			default:
				break;
		}

		// Positional ops: line+column, or a symbol to find in the file.
		let line = input.line;
		let column = input.column;
		if ((line === undefined || column === undefined) && input.symbol) {
			const hit = findSymbol(doc.lines, input.symbol);
			if (!hit) throw new LeanToolError(`${input.symbol} does not occur in ${shown}; give line and column instead`);
			line = hit.line;
			column = hit.column;
		}
		line = need(line, "line", input.op);
		column = need(column, "column", input.op);
		const position = doc.pos(line, column);
		const where = `${shown}:${line}:${column}`;

		switch (input.op) {
			case "hover": {
				const h = await doc.request<Hover | null>("textDocument/hover", { textDocument: td, position }, { signal: oc.signal });
				const info = hoverText(h);
				const here = doc
					.current()
					.filter((d) => {
						const r = d.fullRange ?? d.range;
						return r.start.line <= position.line && r.end.line >= position.line;
					})
					.map((d) => `- ${d.message.split("\n")[0]}`);
				return {
					text: `${where}\n${info ? boundText(info, oc.cfg.maxOutputChars) : "(no hover information here)"}${here.length ? `\nmessages on this line:\n${here.join("\n")}` : ""}`,
					details: { op: "hover", line, column, info },
				};
			}
			case "completions": {
				const r = await doc.request<CompletionItem[] | { items: CompletionItem[] } | null>(
					"textDocument/completion",
					{ textDocument: td, position, context: { triggerKind: 1 } },
					{ signal: oc.signal },
				);
				const items = Array.isArray(r) ? r : (r?.items ?? []);
				const prefix = /[\p{L}\p{N}_.']*$/u.exec(doc.lines[line - 1].slice(0, position.character))?.[0] ?? "";
				const ranked = rankCompletions(items, prefix.split(".").pop() ?? "").slice(0, Math.min(max, 64));
				const resolved: CompletionItem[] = [];
				for (const [i, c] of ranked.entries()) {
					resolved.push(i < 8 && !c.detail ? ((await doc.request<CompletionItem>("completionItem/resolve", c, { signal: oc.signal }).catch(() => c)) ?? c) : c);
				}
				const text = resolved.length
					? [`${where}: ${resolved.length} of ${items.length} completions`, ...resolved.map((c) => `- ${c.label}${c.kind ? ` (${COMPLETION_KINDS[c.kind] ?? c.kind})` : ""}${c.detail ? `: ${c.detail.replace(/\s+/g, " ")}` : ""}`)].join("\n")
					: `${where}: no completions.`;
				return { text, details: { op: "completions", line, column, items: resolved.map((c) => ({ label: c.label, detail: c.detail })) } };
			}
			case "definition": {
				let r = await doc.request<Location | Location[] | LocationLink[] | null>("textDocument/definition", { textDocument: td, position }, { signal: oc.signal });
				if (locations(r).length === 0) {
					r = await doc.request<Location | Location[] | LocationLink[] | null>("textDocument/declaration", { textDocument: td, position }, { signal: oc.signal });
				}
				const locs = locations(r);
				if (locs.length === 0) return { text: `${where}: no definition found.`, details: { op: "definition", locations: [] } };
				const ctxLines = input.contextLines ?? 20;
				const shownLocs = locs.slice(0, 3).map((l) => {
					const path = fileURLToPath(l.uri);
					const text = server.textOf(path) ?? "";
					const lines = splitLines(text);
					const p = rangeFromLsp(lines, l.range);
					const from = Math.max(1, p.start.line);
					const to = Math.min(lines.length, from + ctxLines - 1);
					const slice = lines
						.slice(from - 1, to)
						.map((t, i) => `${String(from + i).padStart(5)}  ${t}`)
						.join("\n");
					return { path: displayPath(path, oc.cwd), line: p.start.line, column: p.start.column, slice };
				});
				const text = shownLocs.map((l) => `${l.path}:${l.line}:${l.column}\n${boundText(l.slice, oc.cfg.maxOutputChars)}`).join("\n\n");
				return { text: `${where} is defined at:\n${text}`, details: { op: "definition", locations: shownLocs.map(({ slice: _s, ...rest }) => rest) } };
			}
			case "references": {
				const r = await doc.request<Location[] | null>(
					"textDocument/references",
					{ textDocument: td, position, context: { includeDeclaration: true } },
					{ signal: oc.signal },
				);
				const all = r ?? [];
				const refs = all.slice(0, max).map((l) => {
					const path = fileURLToPath(l.uri);
					const lines = splitLines(server.textOf(path) ?? "");
					const p = rangeFromLsp(lines, l.range);
					return { path: displayPath(path, oc.cwd), line: p.start.line, column: p.start.column, text: (lines[p.start.line - 1] ?? "").trim() };
				});
				const text = refs.length
					? [`${where}: ${all.length} reference(s)${all.length > refs.length ? `, first ${refs.length}` : ""}:`, ...refs.map((x) => `${x.path}:${x.line}:${x.column}  ${x.text}`)].join("\n")
					: `${where}: no references found (the symbol index may still be warming up; references in files never built are not indexed).`;
				return { text, details: { op: "references", total: all.length, references: refs } };
			}
			default:
				throw new LeanToolError(`unknown op ${String(input.op)}`);
		}
	});
	return { text: withNotes(value.text, notes), details: value.details as Record<string, unknown> };
}
