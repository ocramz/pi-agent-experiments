/**
 * Render kernel JSON responses as compact agent-facing text.
 *
 * Budget: a normal response is a handful of lines. One line per executed
 * cell, its stdout indented under it, then the hint tails — and those only
 * when they are non-empty, so a notebook in step says nothing about being
 * in step.
 *
 * The hints are the whole reason this kernel is worth using over `python`
 * in bash, so they are worded as facts with a consequence rather than as
 * bare lists: `stale: c3, c4` tells a model nothing it will act on.
 */

export interface CellImage {
	mime: string;
	b64: string;
}

export interface CellOutput {
	cell: string;
	status: "ok" | "error";
	seconds: number;
	execution_count?: number | null;
	value?: string | null;
	error?: string | null;
	traceback?: string | null;
	stdout?: string;
	images?: CellImage[];
	notes?: string[];
}

export interface RunResponse {
	ok: boolean;
	error?: string;
	internal?: boolean;
	results?: CellOutput[];
	stale?: string[];
	unrun?: string[];
	failing?: string[];
	globals?: Record<string, string>;
	id?: string;
	cells?: number;
	saved?: { path: string; cells: number; bytes: number };
	loaded?: { path: string; cells: number };
	installed?: string[];
	restart_required?: string[];
}

/** One notebook, as `listNotebooks` in `kernel.ts` reports it. */
export interface NotebookListing {
	name: string;
	file: string;
	hasFile: boolean;
	venv: string;
	hasVenv: boolean;
	python: string;
	source: "env" | "pin" | "settings" | "venv";
}

export interface CellSummary {
	id: string;
	index: number;
	kind: string;
	execution_count: number | null;
	lines: number;
	preview: string;
	state: "ok" | "stale" | "unrun" | "failing";
}

export interface InspectResponse {
	ok: boolean;
	error?: string;
	cells?: CellSummary[];
	path?: string | null;
	stale?: string[];
	unrun?: string[];
	failing?: string[];
	globals?: Record<string, string>;
}

export interface ReadResponse {
	ok: boolean;
	error?: string;
	cells?: { id: string; kind: string; src: string }[];
}

const MARK: Record<string, string> = { ok: "*", error: "!" };

export function formatRun(resp: RunResponse): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines: string[] = [];
	if (resp.id) lines.push(`id: ${resp.id}`);
	if (resp.saved) {
		lines.push(`saved ${resp.saved.cells} cell(s) to ${resp.saved.path}`);
	}
	if (resp.loaded) {
		lines.push(`loaded ${resp.loaded.cells} cell(s) from ${resp.loaded.path}`);
	}
	if (resp.installed?.length) {
		lines.push(`installed: ${resp.installed.join(", ")}`);
		if (resp.restart_required?.length) {
			lines.push(
				`already imported, so still running the old code: ${resp.restart_required.join(", ")} — ` +
					`run nb_run {op: "all"} to pick up the new version`,
			);
		}
	}

	for (const r of resp.results ?? []) {
		const count = r.execution_count != null ? `[${r.execution_count}] ` : "";
		const ms = (r.seconds * 1000).toFixed(1);
		const tail = r.status === "error" ? (r.error ?? "") : (r.value ?? "");
		lines.push(`${MARK[r.status]} ${count}${r.cell} ${ms}ms${tail ? `  ${tail}` : ""}`);
		if (r.stdout?.trim()) lines.push(indent(r.stdout.trimEnd()));
		// The traceback supersedes the headline error rather than repeating
		// it: it ends with the same line, and carries the source line above.
		if (r.status === "error" && r.traceback) lines.push(indent(r.traceback));
		for (const image of r.images ?? []) lines.push(`  [attached: ${image.mime}]`);
		for (const note of r.notes ?? []) lines.push(`  (${note})`);
	}

	lines.push(...formatHints(resp));
	return lines.join("\n") || "ok";
}

/**
 * The three hint lists, phrased so the model knows what to do about them.
 *
 * Shared by every response shape because they mean the same thing on all
 * of them, and a model that learned to read `stale:` on a run should not
 * have to learn a second spelling for `inspect`.
 */
export function formatHints(resp: {
	stale?: string[];
	unrun?: string[];
	failing?: string[];
	globals?: Record<string, string>;
}): string[] {
	const lines: string[] = [];
	if (resp.failing?.length) lines.push(`failing: ${resp.failing.join(", ")}`);
	if (resp.stale?.length) {
		lines.push(
			`stale (a cell above them changed since they ran): ${resp.stale.join(", ")} — ` +
				`nb_run {op: "all"} to bring the notebook back in step`,
		);
	}
	if (resp.unrun?.length) lines.push(`unrun: ${resp.unrun.join(", ")}`);
	const globals = Object.entries(resp.globals ?? {});
	if (globals.length) {
		lines.push(`globals: ${globals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	}
	return lines;
}

export function formatInspect(resp: InspectResponse, notebook?: string): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	// The name is a prefix rather than a rewrite: a caller with nothing to
	// say about which notebook this is gets exactly the header it always got.
	const where = notebook ? `notebook "${notebook}": ` : "";
	const cells = resp.cells ?? [];
	if (!cells.length) return notebook ? `(notebook "${notebook}" is empty)` : "(empty notebook)";
	const lines = [
		`${where}${cells.length} cell${cells.length === 1 ? "" : "s"}${resp.path ? ` (file: ${resp.path})` : ""}:`,
	];
	for (const c of cells) {
		const count = c.execution_count != null ? `[${c.execution_count}]` : "[ ]";
		const kind = c.kind === "code" ? "" : ` ${c.kind}`;
		lines.push(`${count} ${c.id}${kind} ${c.state}  ${c.preview}`);
	}
	lines.push(...formatHints(resp));
	return lines.join("\n");
}

/**
 * The notebooks this project has, and where each one's environment is.
 *
 * The venv path is printed rather than summarised because it is the thing
 * someone reclaiming disk actually needs, and because it is the visible
 * proof that nothing environment-shaped is inside the working tree.
 */
export function formatNotebooks(list: NotebookListing[], current: string): string {
	if (!list.length) return `no notebooks yet; this session is on "${current}"`;
	const lines = list.map((n) => {
		const mark = n.name === current ? "*" : " ";
		const file = n.hasFile ? n.file : "(no checkpoint yet)";
		const env =
			n.source === "venv"
				? n.hasVenv
					? `venv ${n.venv}`
					: `venv ${n.venv} (not built yet)`
				: `${n.source}: ${n.python}`;
		// An override does not delete the venv that was built before it, and a
		// stranded one only takes disk space. Say it is there, and that nothing runs it.
		const stranded =
			n.source !== "venv" && n.hasVenv ? `\n    venv ${n.venv} (built, unused. Delete it with /nb drop-venv)` : "";
		return `${mark} ${n.name}\n    ${file}\n    ${env}${stranded}`;
	});
	lines.push("* is this session's notebook. Checkpoints are source; venvs are not in the repo.");
	return lines.join("\n");
}

export function formatRead(resp: ReadResponse): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const cells = resp.cells ?? [];
	if (!cells.length) return "(no cells)";
	return cells
		.map((c) => {
			const kind = c.kind === "code" ? "" : ` [${c.kind}]`;
			return `--- ${c.id}${kind}\n${c.src}`;
		})
		.join("\n");
}

export function formatEval(resp: {
	ok: boolean;
	value?: string | null;
	error?: string | null;
	traceback?: string | null;
	stdout?: string;
}): string {
	const lines: string[] = [];
	if (resp.stdout?.trim()) lines.push(resp.stdout.trimEnd());
	if (resp.ok) lines.push(resp.value ?? "None");
	else lines.push(resp.traceback ?? `Error: ${resp.error ?? "unknown"}`);
	return lines.join("\n");
}

/** Every image the run produced, in cell order, ready to become content blocks. */
export function imagesOf(resp: RunResponse): CellImage[] {
	return (resp.results ?? []).flatMap((r) => r.images ?? []);
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((l) => `  | ${l}`)
		.join("\n");
}
