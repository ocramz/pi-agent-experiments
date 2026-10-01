/**
 * A lexical view of a Lean file: code with comments and strings removed, and
 * the declarations in it with their namespace-qualified names.
 *
 * Lexical on purpose — it needs no server, so lean_verify {op: "sorries"} and
 * the autoprove loop's measurements cost no elaboration at all. The comment
 * and string handling and the declaration pattern follow lean4-skills'
 * sorry_analyzer.py (MIT, © 2025 Lean 4 Theorem Proving Skill Contributors);
 * namespace tracking is added so names can be handed to `#print axioms`.
 */

/**
 * Each line with comments and string literals blanked to spaces, so offsets
 * still line up with the original text. Nested block comments carry across
 * lines.
 */
export function codeLines(text: string): string[] {
	const out: string[] = [];
	let depth = 0;
	for (const line of text.split("\n")) {
		let code = "";
		let inString = false;
		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			const next = line[i + 1] ?? "";
			if (depth > 0) {
				if (ch === "/" && next === "-") {
					depth++;
					code += "  ";
					i++;
				} else if (ch === "-" && next === "/") {
					depth--;
					code += "  ";
					i++;
				} else code += " ";
				continue;
			}
			if (inString) {
				if (ch === "\\") {
					code += "  ";
					i++;
				} else {
					if (ch === '"') inString = false;
					code += " ";
				}
				continue;
			}
			if (ch === '"') {
				inString = true;
				code += " ";
				continue;
			}
			if (ch === "-" && next === "-") break;
			if (ch === "/" && next === "-") {
				depth++;
				code += "  ";
				i++;
				continue;
			}
			code += ch;
		}
		out.push(code);
	}
	return out;
}

const MODIFIERS = "(?:(?:private|protected|local|scoped|noncomputable|unsafe|partial|nonrec|public|meta)\\s+)*";
export const DECL_RE = new RegExp(
	`^\\s*(?:@\\[[^\\]]*\\]\\s*)*${MODIFIERS}(theorem|lemma|def|abbrev|example|instance|structure|class|inductive|opaque|axiom)\\b(?:\\s+([^\\s:({\\[⦃]+))?`,
	"u",
);

export interface Decl {
	keyword: string;
	/** As written; null for `example` and anonymous instances. */
	name: string | null;
	/** With the enclosing namespaces, `_root_.` resolved. */
	qualified: string | null;
	private: boolean;
	/** 1-based first line, and the last line before the next declaration or scope change. */
	line: number;
	endLine: number;
}

export function declarations(text: string): Decl[] {
	const lines = codeLines(text);
	const scopes: { kind: "namespace" | "section"; name: string }[] = [];
	const decls: Decl[] = [];
	const close = (at: number) => {
		const last = decls[decls.length - 1];
		if (last && last.endLine === -1) last.endLine = at;
	};
	for (let i = 0; i < lines.length; i++) {
		const code = lines[i];
		let m = /^\s*namespace\s+([^\s]+)/u.exec(code);
		if (m) {
			close(i);
			scopes.push({ kind: "namespace", name: m[1] });
			continue;
		}
		m = /^\s*(?:noncomputable\s+)?section\b\s*([^\s]*)/u.exec(code);
		if (m) {
			close(i);
			scopes.push({ kind: "section", name: m[1] });
			continue;
		}
		m = /^\s*end\b\s*([^\s]*)/u.exec(code);
		if (m) {
			close(i);
			scopes.pop();
			continue;
		}
		const d = DECL_RE.exec(code);
		if (d) {
			close(i);
			const name = d[2] ?? null;
			const ns = scopes.filter((s) => s.kind === "namespace").map((s) => s.name);
			let qualified: string | null = null;
			if (name) qualified = name.startsWith("_root_.") ? name.slice(7) : [...ns, name].join(".");
			decls.push({ keyword: d[1], name, qualified, private: /\bprivate\b/.test(code.slice(0, d.index + d[0].length)), line: i + 1, endLine: -1 });
		}
	}
	close(lines.length);
	return decls;
}

/** The declaration containing 1-based `line`, if any. */
export function declarationAt(decls: readonly Decl[], line: number): Decl | null {
	for (let i = decls.length - 1; i >= 0; i--) {
		if (decls[i].line <= line && line <= decls[i].endLine) return decls[i];
	}
	return null;
}

export function declLabel(d: Decl | null): string {
	if (!d) return "(top level)";
	return d.qualified ? `${d.keyword} ${d.qualified}` : d.keyword;
}
