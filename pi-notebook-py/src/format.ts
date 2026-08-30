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

/** The kernel's answer to `env`, decorated by the client with `producer`. */
export interface EnvResponse {
	ok: boolean;
	error?: string;
	executable?: string;
	version?: string;
	implementation?: string;
	prefix?: string;
	base_prefix?: string;
	packages?: string[];
	producer?: string;
}

/** What only the client knows: which rule picked the interpreter. `envPlan` in `kernel.ts`. */
export interface EnvPlan {
	notebook: string;
	/** The interpreter the resolution rules chose. */
	python: string;
	source: NotebookListing["source"];
	/** Set only for `venv`. */
	venv?: string;
	/** True when what is running is not what was planned. */
	mismatch: boolean;
}

/** Both sides of the checkpoint comparison, as the client assembles them. */
export interface DigestReport {
	notebook: string;
	checkpoint: string;
	/** The file on disk, or null when there is none yet. */
	file: { sha256: string; bytes: number } | null;
	/** The kernel's own answer, or null when no kernel is running. */
	kernel: { sha256: string; bytes: number; cells: number } | null;
	error?: string;
}

/** One `nb_run {op: "file"}`, as `runFile` in `kernel.ts` reports it. */
export interface FileRunResult {
	path: string;
	python: string;
	code: number | null;
	seconds: number;
	stdout: string;
	stderr: string;
	stdoutDropped: number;
	stderrDropped: number;
	timedOut: boolean;
	error?: string;
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

/**
 * Which interpreter this notebook is running, and everything in it.
 *
 * The package list is the deliverable — a caller storing this as an
 * `env.lock` wants requirements.txt lines and nothing else — so it goes
 * last, one per line, unadorned, and the header above it says how many
 * lines follow and what produced them. It is not truncated at any length:
 * a lock with the tail cut off is not a lock, and the count is the warning
 * a caller needs in order to decide for itself.
 */
export function formatEnv(resp: EnvResponse, plan: EnvPlan): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines = [
		`notebook "${plan.notebook}"`,
		`python   ${resp.executable ?? plan.python}`,
		`source   ${plan.source}${plan.source === "venv" && plan.venv ? ` (${plan.venv})` : ""}`,
		`version  ${resp.version ?? "unknown"}${resp.implementation ? ` (${resp.implementation})` : ""}`,
	];
	if (resp.prefix) {
		const base = resp.base_prefix && resp.base_prefix !== resp.prefix ? ` (base ${resp.base_prefix})` : "";
		lines.push(`prefix   ${resp.prefix}${base}`);
	}
	// The one case where `source` must not be trusted: `resolvePython` falls
	// back to the base interpreter, or to a bare `python3`, when a venv build
	// fails, and the rule that chose the path then describes an environment
	// nothing is running in.
	if (plan.mismatch) {
		lines.push(
			`NOTE: the rules choose ${plan.python} (${plan.source}), but the kernel is running ` +
				`${resp.executable} — the venv could not be built, so a fallback interpreter is in use. ` +
				"Anything nb_env installed here is not in the notebook's own environment.",
		);
	}
	const packages = resp.packages;
	if (!packages) return lines.join("\n");
	lines.push(`lock     ${packages.length} package(s), via ${resp.producer ?? "importlib.metadata"}`);
	lines.push(...packages);
	return lines.join("\n");
}

/**
 * Whether the committed checkpoint still is what the kernel would write.
 *
 * Divergence is rare by construction — the checkpoint is rewritten after
 * every mutating call — which is exactly what makes it worth reporting:
 * when it happens it is either a hand-edit of a file this package invites
 * people to hand-edit, or a checkpoint write that failed. Both remedies
 * are spelled as the call that applies them.
 */
export function formatDigest(report: DigestReport): string {
	if (report.error) return `Error: ${report.error}`;
	const { file, kernel, checkpoint } = report;
	const lines = [`notebook "${report.notebook}"`, `checkpoint ${checkpoint}`];

	if (!kernel) {
		lines.push(
			file
				? `sha256     ${file.sha256}  (${file.bytes} bytes)`
				: `no checkpoint at ${checkpoint} yet.`,
		);
		// Not spawning is the point: a digest must not build a venv to answer.
		lines.push("the kernel is not running, so nothing can have diverged.");
		return lines.join("\n");
	}

	if (!file) {
		lines.push(`kernel     ${kernel.sha256}  (${kernel.bytes} bytes, ${kernel.cells} cell(s))`);
		lines.push(
			kernel.cells === 0
				? "no checkpoint yet, and the kernel is empty — nothing has been written because nothing has happened."
				: `diverged: there is no checkpoint, but the kernel holds ${kernel.cells} cell(s). ` +
					"A checkpoint write must have failed — check that .pi/notebooks/ is writable, then " +
					'`nb_notebook {op: "save", path}` to get the cells onto disk.',
		);
		return lines.join("\n");
	}

	if (file.sha256 === kernel.sha256) {
		lines.push(`sha256     ${file.sha256}  (${file.bytes} bytes, ${kernel.cells} cell(s))`);
		lines.push("in step: the kernel would write exactly this file.");
		return lines.join("\n");
	}

	lines.push("diverged: the live kernel would write a different file.");
	lines.push(`  kernel   ${kernel.sha256}  (${kernel.bytes} bytes, ${kernel.cells} cell(s))`);
	lines.push(`  on disk  ${file.sha256}  (${file.bytes} bytes)`);
	lines.push(
		"Either the checkpoint was edited outside this session, or a checkpoint write failed. " +
			`\`nb_notebook {op: "open", path: "${checkpoint}"}\` adopts the file; any cell edit ` +
			"rewrites it from the kernel.",
	);
	return lines.join("\n");
}

/**
 * One script run, in the shape a cell result already has.
 *
 * The same `*`/`!` marks and the same `  | ` gutter, so this reads like
 * every other tool result. What it deliberately does *not* carry is a
 * staleness report: nothing was disturbed, and printing three empty hint
 * lists would suggest otherwise.
 */
export function formatFile(run: FileRunResult): string {
	if (run.error) return `Error: ${run.error}`;
	const ms = run.seconds.toFixed(1);
	const lines: string[] = [];
	if (run.timedOut) {
		lines.push(
			`! ${run.path} was killed after ${ms}s (its own time budget, not the kernel's — ` +
				"the notebook namespace is untouched)",
		);
	} else {
		const mark = run.code === 0 ? "*" : "!";
		const status = run.code === null ? "was killed" : `exited ${run.code}`;
		lines.push(`${mark} ${run.path} ${status} in ${ms}s`);
	}
	if (run.stdout.trim()) lines.push(indent(run.stdout.trimEnd()));
	if (run.stdoutDropped) lines.push(`  ${dropped("stdout", run.stdoutDropped, run.stdout.length)}`);
	if (run.stderr.trim()) lines.push(indent(run.stderr.trimEnd()));
	if (run.stderrDropped) lines.push(`  ${dropped("stderr", run.stderrDropped, run.stderr.length)}`);
	return lines.join("\n");
}

function dropped(stream: string, gone: number, kept: number): string {
	return `(${stream} truncated: ${gone} characters dropped, the last ${kept} are shown)`;
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
