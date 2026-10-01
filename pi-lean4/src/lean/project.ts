/**
 * Which Lake project a file belongs to, and how to name files to the model.
 *
 * A project root is a directory holding `lean-toolchain` *and* a lakefile
 * (`lakefile.lean` or `lakefile.toml`) — the same rule lean-lsp-mcp uses
 * (file_utils.py). The innermost such directory wins, with one exception: a
 * file under `<r>/.lake/packages/...` belongs to `r`, because a dependency's
 * sources are only elaborated through the project that pulled them in — its
 * own lakefile describes a project nobody built.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LeanToolError } from "../errors.ts";

export interface ProjectInfo {
	root: string;
	name: string;
	lakefile: string;
	/** The `lean-toolchain` line, e.g. `leanprover/lean4:v4.34.1`. */
	toolchain: string | null;
}

export function isProjectRoot(dir: string): boolean {
	return (
		existsSync(join(dir, "lean-toolchain")) &&
		(existsSync(join(dir, "lakefile.lean")) || existsSync(join(dir, "lakefile.toml")))
	);
}

/** The project owning `path` (a file or a directory), or null. */
export function findProjectRoot(path: string): string | null {
	const abs = resolve(path);
	const packages = `${sep}.lake${sep}packages${sep}`;
	const at = abs.indexOf(packages);
	if (at > 0) {
		const outer = abs.slice(0, at);
		if (isProjectRoot(outer)) return outer;
	}
	let dir = isDirectory(abs) ? abs : dirname(abs);
	for (;;) {
		if (isProjectRoot(dir)) return dir;
		const up = dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

export function projectInfo(root: string): ProjectInfo {
	const lakefile = existsSync(join(root, "lakefile.lean")) ? "lakefile.lean" : "lakefile.toml";
	let toolchain: string | null = null;
	try {
		toolchain = statSync(join(root, "lean-toolchain")).isFile()
			? readFirstLine(join(root, "lean-toolchain"))
			: null;
	} catch {
		toolchain = null;
	}
	return { root, name: basename(root), lakefile, toolchain };
}

function readFirstLine(path: string): string | null {
	const line = readFileSync(path, "utf8").split("\n")[0]?.trim();
	return line ? line : null;
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A path argument as the model wrote it, made absolute.
 *
 * Some models prefix paths with `@` (pi's own tools strip it; docs/extensions.md
 * asks custom tools to do the same). Relative paths resolve against the
 * session's cwd, which is what `read` and `edit` do too.
 */
export function resolveToolPath(raw: string, cwd: string): string {
	let p = raw.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~" || p.startsWith("~/")) p = join(process.env.HOME ?? "", p.slice(1));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

export function isInside(path: string, dir: string): boolean {
	const rel = relative(dir, path);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** How a file is named back to the model: relative to cwd when it is under it. */
export function displayPath(abs: string, cwd: string): string {
	return isInside(abs, cwd) ? relative(cwd, abs) || "." : abs;
}

/** A `.lean` file inside a project, or a LeanToolError that says what to do. */
export function requireLeanFile(abs: string): { file: string; root: string } {
	if (!abs.endsWith(".lean")) throw new LeanToolError(`${abs} is not a .lean file`);
	if (!existsSync(abs)) throw new LeanToolError(`${abs} does not exist`);
	const root = findProjectRoot(abs);
	if (!root) {
		throw new LeanToolError(
			`${abs} is not inside a Lake project: no ancestor directory has both lean-toolchain ` +
				"and lakefile.lean/lakefile.toml. Create one with `lake new <name>` (or `lake init`) " +
				"and put the file under it.",
		);
	}
	return { file: abs, root };
}
