/**
 * The import header of a Lean file, and a fingerprint of everything a file
 * transitively imports from its own project.
 *
 * Why a fingerprint: Lean's server only notices that an import changed when
 * that import is *open* in the same server (it then tags dependents with
 * "Imports are out of date and should be rebuilt"). An edit to an unopened
 * dependency — the common case, `edit` on Basic.lean while the goal you are
 * asking about is in Main.lean — leaves the open Main.lean elaborated against
 * the old Basic.olean with nothing said. test/lean/contract.test.ts pins that
 * down. So each open document remembers the (mtime, size) of its in-project
 * import closure, and a mismatch on next use reopens it with
 * `dependencyBuildMode: "once"`, which rebuilds exactly those imports.
 *
 * Only in-project modules are tracked. Packages under `.lake/packages` change
 * through `lake update`, which is a lean_build, not an edit.
 */

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Module names a file imports, in order. Understands `module`/`prelude`,
 * comments (line and nested block) and the module-system modifiers
 * (`public import`, `meta import`, `import all`).
 */
export function parseImports(text: string): string[] {
	const out: string[] = [];
	let i = 0;
	const n = text.length;
	const skipTrivia = () => {
		for (;;) {
			while (i < n && /\s/.test(text[i])) i++;
			if (text.startsWith("--", i)) {
				const nl = text.indexOf("\n", i);
				i = nl < 0 ? n : nl + 1;
				continue;
			}
			if (text.startsWith("/-", i)) {
				let depth = 1;
				i += 2;
				while (i < n && depth > 0) {
					if (text.startsWith("/-", i)) {
						depth++;
						i += 2;
					} else if (text.startsWith("-/", i)) {
						depth--;
						i += 2;
					} else i++;
				}
				continue;
			}
			return;
		}
	};
	const word = (): string => {
		// A name part may be «quoted», spaces and all.
		const m = /^(?:«[^»]*»|[^\s()[\]{},«])+/u.exec(text.slice(i, i + 512));
		return m ? m[0] : "";
	};
	skipTrivia();
	for (const kw of ["module", "prelude"]) {
		if (word() === kw) {
			i += kw.length;
			skipTrivia();
		}
	}
	for (;;) {
		skipTrivia();
		const start = i;
		let w = word();
		while (w === "public" || w === "meta" || w === "private") {
			i += w.length;
			skipTrivia();
			w = word();
		}
		if (w !== "import") {
			i = start;
			return out;
		}
		i += w.length;
		skipTrivia();
		w = word();
		if (w === "all") {
			i += w.length;
			skipTrivia();
			w = word();
		}
		if (!w) return out;
		out.push(w.replace(/«|»/g, ""));
		i += w.length;
	}
}

/**
 * Where a project keeps its sources: the root, plus any `srcDir` its lakefile
 * names (`srcDir = "src"` in TOML, `srcDir := "src"` in Lean). A regex rather
 * than a lakefile evaluator — a computed srcDir is not found, and then a module
 * there simply does not take part in the fingerprint.
 */
export function sourceDirs(root: string): string[] {
	const dirs = [root];
	for (const name of ["lakefile.toml", "lakefile.lean"]) {
		let text: string;
		try {
			text = readFileSync(join(root, name), "utf8");
		} catch {
			continue;
		}
		for (const m of text.matchAll(/srcDir\s*:?=\s*"([^"]+)"/g)) {
			const dir = join(root, m[1]);
			if (!dirs.includes(dir)) dirs.push(dir);
		}
	}
	return dirs;
}

/** The project file a module name refers to, if it is in this project. */
export function moduleFile(dirs: readonly string[], module: string): string | null {
	for (const dir of dirs) {
		const file = join(dir, ...module.split(".")) + ".lean";
		try {
			if (statSync(file).isFile()) return file;
		} catch {
			/* try the next source dir */
		}
	}
	return null;
}

interface HeaderCacheEntry {
	key: string;
	imports: string[];
}

/** Parsed headers by path, keyed by mtime+size so an edit invalidates. */
export class ImportGraph {
	#dirs: string[];
	#cache = new Map<string, HeaderCacheEntry>();

	constructor(root: string) {
		this.#dirs = sourceDirs(root);
	}

	#importsOf(file: string): { stamp: string; imports: string[] } | null {
		let stamp: string;
		try {
			const st = statSync(file);
			stamp = `${st.mtimeMs}:${st.size}`;
		} catch {
			return null;
		}
		const hit = this.#cache.get(file);
		if (hit && hit.key === stamp) return { stamp, imports: hit.imports };
		let text: string;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			return null;
		}
		const imports = parseImports(text);
		this.#cache.set(file, { key: stamp, imports });
		return { stamp, imports };
	}

	/**
	 * A fingerprint of the in-project modules `text` (the file's current
	 * contents) transitively imports. Changes whenever any of them is edited,
	 * added or removed; does not change when the file itself is.
	 */
	closureFingerprint(text: string): { fingerprint: string; modules: string[] } {
		const seen = new Map<string, string>();
		const queue = parseImports(text)
			.map((m) => moduleFile(this.#dirs, m))
			.filter((f): f is string => f !== null);
		while (queue.length) {
			const file = queue.shift()!;
			if (seen.has(file)) continue;
			const entry = this.#importsOf(file);
			seen.set(file, entry?.stamp ?? "missing");
			if (!entry) continue;
			for (const m of entry.imports) {
				const dep = moduleFile(this.#dirs, m);
				if (dep && !seen.has(dep)) queue.push(dep);
			}
		}
		const modules = [...seen.keys()].sort();
		const hash = createHash("sha256");
		for (const f of modules) hash.update(`${f}\0${seen.get(f)}\n`);
		return { fingerprint: hash.digest("hex"), modules };
	}
}
