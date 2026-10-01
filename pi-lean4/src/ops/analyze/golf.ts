/**
 * lean_analyze {op: "golf"}: places a compiling proof could be shorter.
 *
 * The seven detectors of lean4-skills' find_golfable.py (MIT, © 2025 Lean 4
 * Theorem Proving Skill Contributors), ported over comment-stripped lines.
 * They are *candidates*: each one is tried with lean_attempt and kept only if
 * it still compiles — the lean4-golf skill says how.
 */

import { codeLines } from "../decls.ts";

export interface GolfCandidate {
	pattern: string;
	line: number;
	lines: number;
	snippet: string;
	estimate: string;
	priority: "HIGH" | "MEDIUM" | "LOW";
	advice: string;
}

const t = (s: string) => s.trim();
const indentOf = (s: string) => s.length - s.trimStart().length;
const snippetOf = (lines: readonly string[], from: number, to: number) => {
	const s = lines.slice(from, to).join("\n");
	return s.length > 200 ? `${s.slice(0, 197)}...` : s;
};
const uses = (code: readonly string[], name: string, from: number, to = code.length) => {
	const re = new RegExp(`(?<![\\p{L}\\p{N}_'])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_'])`, "gu");
	let n = 0;
	for (let i = from; i < Math.min(to, code.length); i++) n += (code[i].match(re) ?? []).length;
	return n;
};

export function golfCandidates(text: string): GolfCandidate[] {
	const raw = text.split("\n");
	const code = codeLines(text);
	const out: GolfCandidate[] = [];

	// let + have + exact: a let feeding one have and an exact.
	for (let i = 0; i < code.length; i++) {
		const m = /^let\s+([\p{L}_][\p{L}\p{N}_']*)\s*(?::|:=)/u.exec(t(code[i]));
		if (!m) continue;
		let sawHave = false;
		for (let j = i + 1; j < Math.min(i + 15, code.length); j++) {
			if (/^have\s+[\p{L}_][\p{L}\p{N}_']*\s*(?::|:=)/u.test(t(code[j]))) sawHave = true;
			if (sawHave && t(code[j]).startsWith("exact ")) {
				if (uses(code, m[1], i) - 1 < 3) {
					out.push({
						pattern: "let + have + exact",
						line: i + 1,
						lines: j - i + 1,
						snippet: snippetOf(raw, i, j + 1),
						estimate: "60-80%",
						priority: "HIGH",
						advice: `inline the let/have into one exact term (check ${m[1]} is used at most twice)`,
					});
				}
				i = j;
				break;
			}
		}
	}

	// `:= by` then `exact e` alone: the term is the proof.
	for (let i = 0; i + 1 < code.length; i++) {
		if (/:=\s*by\s*$/.test(t(code[i])) && t(code[i + 1]).startsWith("exact ")) {
			const next = code[i + 2];
			if (next !== undefined && t(next) && indentOf(next) >= indentOf(code[i + 1])) continue; // more tactics follow
			out.push({
				pattern: "by exact wrapper",
				line: i + 1,
				lines: 2,
				snippet: snippetOf(raw, i, i + 2),
				estimate: "50%",
				priority: "MEDIUM",
				advice: "replace `:= by exact e` with `:= e`",
			});
		}
	}

	// Long calc chains.
	for (let i = 0; i < code.length; i++) {
		if (!t(code[i]).startsWith("calc")) continue;
		let j = i + 1;
		while (j < code.length && (t(code[j]).startsWith("_") || (t(code[j]) && indentOf(code[j]) > indentOf(code[i]) && !/^\S/.test(code[j])))) j++;
		const steps = code.slice(i, j).filter((l) => /^\s*(calc\b|_\s)/.test(l)).length;
		if (steps >= 4) {
			out.push({
				pattern: "calc chain",
				line: i + 1,
				lines: j - i,
				snippet: snippetOf(raw, i, Math.min(j, i + 5)),
				estimate: "30-50%",
				priority: "MEDIUM",
				advice: "try closing the whole chain with one tactic (linarith, nlinarith, gcongr, positivity, ring_nf) or merge trivial steps",
			});
			i = j - 1;
		}
	}

	// constructor followed by long branches.
	for (let i = 0; i < code.length; i++) {
		if (t(code[i]) !== "constructor") continue;
		const base = indentOf(code[i]);
		let j = i + 1;
		while (j < code.length && (!t(code[j]) || indentOf(code[j]) >= base) && !/^\s*(theorem|lemma|def|example)\b/.test(code[j])) j++;
		if (j - i - 1 >= 6) {
			out.push({
				pattern: "constructor branches",
				line: i + 1,
				lines: j - i - 1,
				snippet: snippetOf(raw, i, Math.min(j, i + 10)),
				estimate: "25-50%",
				priority: "LOW",
				advice: "try `exact ⟨e₁, e₂⟩`, `refine ⟨?_, ?_⟩ <;> tac`, or `constructor <;> tac`",
			});
			i = j - 1;
		}
	}

	// Five or more consecutive haves.
	for (let i = 0; i < code.length; i++) {
		if (!/^\s*have\s+[\p{L}_][\p{L}\p{N}_']*\s*:/u.test(code[i])) continue;
		let j = i + 1;
		while (j < code.length && /^\s*have\s+[\p{L}_][\p{L}\p{N}_']*\s*:/u.test(code[j])) j++;
		if (j - i >= 5) {
			out.push({
				pattern: "multiple haves",
				line: i + 1,
				lines: (j - i) * 2,
				snippet: snippetOf(raw, i, Math.min(j, i + 7)),
				estimate: "10-30%",
				priority: "LOW",
				advice: "check each have is used more than once; inline single-use ones",
			});
			i = j - 1;
		}
	}

	// A have used exactly once, in the calc right after it.
	for (let i = 0; i < code.length; i++) {
		const m = /^have\s+([\p{L}_][\p{L}\p{N}_']*)\s*:/u.exec(t(code[i]));
		if (!m) continue;
		let calc = -1;
		for (let j = i + 1; j < Math.min(i + 6, code.length); j++) if (/^\s*calc\s/.test(code[j])) {
			calc = j;
			break;
		}
		if (calc < 0) continue;
		let end = calc + 1;
		const base = indentOf(code[calc]);
		for (let j = calc + 1; j < Math.min(calc + 20, code.length); j++) {
			if (!t(code[j])) {
				end = j + 1;
				continue;
			}
			if (indentOf(code[j]) <= base && !/^\s*[<>=≤≥_]/.test(code[j])) break;
			end = j + 1;
		}
		let after = 0;
		for (let j = end; j < Math.min(end + 20, code.length); j++) {
			if (/^\s*(theorem|lemma|def|example)\s/.test(code[j])) break;
			after += uses(code, m[1], j, j + 1);
		}
		if (uses(code, m[1], calc, end) === 1 && after === 0) {
			out.push({
				pattern: "have-calc single-use",
				line: i + 1,
				lines: calc - i + 1,
				snippet: snippetOf(raw, i, Math.min(end, i + 8)),
				estimate: "40-50%",
				priority: "MEDIUM",
				advice: `inline ${m[1]}'s proof at its one use in the calc step`,
			});
			i = end - 1;
		}
	}

	// apply X followed only by exact branches: often one exact term.
	for (let i = 0; i < code.length; i++) {
		if (!/^\s*(?:·\s*)?apply\b/.test(code[i])) continue;
		const base = indentOf(code[i]);
		let j = i + 1;
		const body: string[] = [];
		while (j < code.length && t(code[j]) && indentOf(code[j]) >= base && j - i <= 4) {
			if (indentOf(code[j]) === base && !/^\s*(?:·\s*)?exact\b/.test(code[j])) break;
			body.push(code[j]);
			j++;
		}
		if (body.length === 0 || body.length > 3) continue;
		if (!body.every((l) => /^\s*(?:·\s*)?exact\b/.test(l))) continue;
		if (body.some((l) => /\b(simp|omega|decide|norm_num)\b/.test(l))) continue;
		if (code.slice(Math.max(0, i - 3), i).some((l) => /\b(calc|cases|induction|match)\b/.test(l))) continue;
		out.push({
			pattern: "apply-exact chain",
			line: i + 1,
			lines: j - i,
			snippet: snippetOf(raw, i, j),
			estimate: "40-60%",
			priority: "MEDIUM",
			advice: "collapse into one `exact f a b` (or `exact f (g x) h`) term",
		});
		i = j - 1;
	}

	const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
	return out.sort((a, b) => order[a.priority] - order[b.priority] || a.line - b.line);
}
