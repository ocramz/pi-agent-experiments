/**
 * lean_verify {op: "sorries"}: every `sorry` in a file or a tree, lexically.
 *
 * No server, no elaboration: a token scan with comments and strings removed
 * (decls.ts), attributed to the enclosing declaration. That makes it the cheap
 * question to ask often — and what the autoprove loop measures each cycle with.
 * Ported in spirit from lean4-skills' sorry_analyzer.py (MIT).
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { LeanToolError } from "../errors.ts";
import { displayPath, findProjectRoot, resolveToolPath } from "../lean/project.ts";
import { codeLines, declLabel, declarationAt, declarations } from "./decls.ts";
import type { OpContext, OpResult } from "./common.ts";

const SORRY = /(?<![\p{L}\p{N}_!?'])sorry(?![\p{L}\p{N}_!?'])/gu;
const SKIP_DIRS = new Set([".lake", ".git", "build", "node_modules", ".pi"]);

export interface SorryHit {
	line: number;
	column: number;
	declaration: string;
	text: string;
}

export function findSorries(text: string): SorryHit[] {
	const lines = text.split("\n");
	const code = codeLines(text);
	const decls = declarations(text);
	const hits: SorryHit[] = [];
	code.forEach((c, i) => {
		for (const m of c.matchAll(SORRY)) {
			hits.push({
				line: i + 1,
				// codeLines blanks rather than deletes, so the offset is the original's.
				column: [...lines[i].slice(0, m.index)].length + 1,
				declaration: declLabel(declarationAt(decls, i + 1)),
				text: lines[i].trim(),
			});
		}
	});
	return hits;
}

export function leanFiles(dir: string): string[] {
	const out: string[] = [];
	const walk = (d: string) => {
		let entries: string[];
		try {
			entries = readdirSync(d);
		} catch {
			return;
		}
		for (const e of entries.sort()) {
			if (SKIP_DIRS.has(e)) continue;
			const p = join(d, e);
			let st;
			try {
				st = statSync(p);
			} catch {
				continue;
			}
			if (st.isDirectory()) walk(p);
			else if (e.endsWith(".lean") && !e.startsWith("_PiLean4")) out.push(p);
		}
	};
	walk(dir);
	return out;
}

export interface SorriesDetails {
	scope: string;
	filesScanned: number;
	total: number;
	files: { path: string; sorries: SorryHit[] }[];
}

export function scanSorries(target: string, cwd: string): SorriesDetails {
	let st;
	try {
		st = statSync(target);
	} catch {
		throw new LeanToolError(`${target} does not exist`);
	}
	const files = st.isDirectory() ? leanFiles(target) : [target];
	if (files.length === 0) throw new LeanToolError(`no .lean files under ${displayPath(target, cwd)} (dependencies in .lake are not scanned)`);
	const results = files
		.map((f) => ({ path: displayPath(f, cwd), sorries: findSorries(readFileSync(f, "utf8")) }))
		.filter((r) => r.sorries.length > 0);
	return {
		scope: displayPath(target, cwd),
		filesScanned: files.length,
		total: results.reduce((n, r) => n + r.sorries.length, 0),
		files: results,
	};
}

export function sorriesOp(input: { path?: string }, oc: OpContext): OpResult<SorriesDetails> {
	const target = input.path
		? resolveToolPath(input.path, oc.cwd)
		: (findProjectRoot(oc.cwd) ?? oc.cwd);
	const d = scanSorries(target, oc.cwd);
	if (d.total === 0) {
		return { text: `${d.scope}: no sorry in ${d.filesScanned} file(s) scanned (comments and strings ignored).`, details: d };
	}
	const lines = [`${d.scope}: ${d.total} sorry in ${d.files.length} of ${d.filesScanned} file(s):`];
	for (const f of d.files) {
		for (const s of f.sorries) lines.push(`${f.path}:${s.line}:${s.column}  ${s.declaration}  \`${s.text.length > 80 ? `${s.text.slice(0, 77)}...` : s.text}\``);
	}
	return { text: lines.join("\n"), details: d };
}
