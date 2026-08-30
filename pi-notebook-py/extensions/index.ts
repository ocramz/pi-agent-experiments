/**
 * pi-notebook-py: a Jupyter-shaped Python notebook for the pi agent.
 *
 * Four agent tools (nb_cell, nb_run, nb_notebook, nb_install) over a
 * long-lived Python subprocess, plus /nb slash commands so the human can
 * poke the same namespace. Cells are an ordered list over one mutable
 * dict, exactly as in Jupyter; what the kernel adds is a report, on every
 * response, of which cells an edit left behind.
 *
 * A session is always *on* a named notebook. The name picks the venv the
 * kernel runs in, so two notebooks in one project can hold conflicting
 * versions and an install into one cannot reach the other; and it names
 * the checkpoint under `.pi/notebooks/`, which is ordinary source and is
 * meant to be committed. The venvs are not in the working tree at all —
 * see `src/config.ts` for why that is a guarantee rather than a habit.
 *
 * No logic lives here. An extension only exists inside a running pi
 * session, so this file's only coverage is a real model driving it —
 * everything worth testing is in src/ and py/.
 */

import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	Kernel,
	dropVenv,
	envPlan,
	fileDigest,
	listNotebooks,
	nameError,
	notebookFile,
	pinPython,
	plannedInterpreter,
	runFile,
	unpinPython,
	uvFreeze,
	type KernelResponse,
} from "../src/kernel.ts";
import {
	formatDigest,
	formatEnv,
	formatEval,
	formatFile,
	formatInspect,
	formatNotebooks,
	formatRead,
	formatRun,
	imagesOf,
	type DigestReport,
	type EnvResponse,
	type InspectResponse,
	type ReadResponse,
	type RunResponse,
} from "../src/format.ts";

const LOST_STATE_NOTE =
	"\n\nNOTE: the kernel process was restarted; all Python state was lost. " +
	'Every cell is unrun — nb_run {op: "all"} to rebuild.';

/**
 * A restart replaces the interpreter, not just the namespace — which is the
 * whole reason to reach for it after editing a file the notebook imports,
 * and is not something the cell listing above it can show.
 */
const RESTART_NOTE =
	"\n\nNOTE: the interpreter process was replaced, so sys.modules is empty too: " +
	"a project file that was imported before this will be read fresh on the next import.";

/** A switch is a deliberate loss, and reads as a fault unless it says so. */
const SWITCH_NOTE =
	"\n\nNOTE: this is a different notebook, so the namespace is empty and every " +
	'cell is unrun — nb_run {op: "all"} to rebuild. It also has its own ' +
	"interpreter: packages installed in another notebook are not here.";

/** Requests that change kernel state. `inspect`, `read` and `eval` do not. */
const MUTATING = new Set([
	"add_cell",
	"set_cell",
	"delete_cell",
	"move_cell",
	"run_cell",
	"run_all",
	"run_above",
	"run_below",
	"restart",
	"load",
	"install",
]);

/**
 * The notebook a percent file says it belongs to, or null if it does not say.
 *
 * Read here rather than in the kernel because the answer decides which
 * *interpreter* to spawn, and that has to be settled before there is a
 * Python process to ask. Only the frontmatter fence is scanned, so this
 * stays a few hundred bytes even for a large notebook.
 */
function declaredNotebook(path: string): string | null {
	try {
		const head = readFileSync(path, "utf8").slice(0, 4096).split("\n");
		if (head[0]?.trim() !== "# ---") return null;
		for (const line of head.slice(1)) {
			if (line.trim() === "# ---") break;
			const found = line.trim().match(/^#\s*notebook\s*:\s*(.+?)\s*$/);
			if (found) return found[1];
		}
	} catch {
		/* unreadable is just "does not say" */
	}
	return null;
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const kernel = new Kernel(undefined, cwd);

	// Where the kernel is in its own history. Stamped onto every result so a
	// later context filter can tell a current output from one that has been
	// superseded; `mut` counts the /nb commands too, which is the only way to
	// notice state that moved with no message in the transcript to show for it.
	let gen = 0;
	let mut = 0;

	/**
	 * Write the notebook's own file after every change.
	 *
	 * This is what makes `.pi/notebooks/<name>.py` trustworthy enough to
	 * commit and to switch away from: without it, `use a` → work → `use b`
	 * would drop the work on the floor, since the namespace and the cell list
	 * both live in a process that is about to be killed.
	 *
	 * It calls the kernel directly rather than through `call` below — it must
	 * not count as a mutation, and it must not autosave itself.
	 */
	async function checkpoint(): Promise<void> {
		await kernel.saveCheckpoint();
	}

	async function call(req: Record<string, unknown>): Promise<KernelResponse> {
		const resp = await kernel.call(req);
		const mutating = MUTATING.has(req.tool as string);
		if (mutating) mut++;
		let lost = false;
		if (kernel.lostState) {
			kernel.lostState = false;
			gen++;
			lost = true;
		}
		// Never checkpoint a kernel that has just been replaced: its cell list
		// is empty because the process died, not because the user emptied it,
		// and writing that out would destroy the file it was meant to protect.
		if (mutating && resp.ok && !lost) await checkpoint();
		return lost ? { ...resp, _lostState: true } : resp;
	}

	/**
	 * A tool result: rendered text, then one block per image the run
	 * produced, with the structured response kept alongside in `details`.
	 * `details` never reaches the provider, so tagging costs nothing.
	 */
	function reply(t: string, kind: string, response?: unknown, images: CellImages = []) {
		return {
			content: [
				{ type: "text" as const, text: t },
				...images.map((i) => ({
					type: "image" as const,
					data: i.b64,
					mimeType: i.mime,
				})),
			],
			details: { kind, response, gen, mut },
		};
	}

	type CellImages = { mime: string; b64: string }[];

	/** The common tail of every tool that runs cells. */
	function runReply(resp: KernelResponse, preamble = "", postamble = "") {
		const response = resp as RunResponse;
		const note = (resp as Record<string, unknown>)._lostState ? LOST_STATE_NOTE : "";
		return reply(
			preamble + formatRun(response) + note + postamble,
			"nb.run",
			response,
			imagesOf(response),
		);
	}

	/**
	 * Move the session to another notebook, killing the kernel so the next
	 * call comes up under that notebook's interpreter, and loading its
	 * checkpoint if it has one.
	 */
	async function switchTo(name: string, create: boolean, loadCheckpoint = true): Promise<string> {
		const bad = nameError(name);
		if (bad) return `Error: ${bad}`;

		const file = notebookFile(cwd, name);
		const known = existsSync(file) || listNotebooks(cwd).some((n) => n.name === name);
		if (create && known) {
			return `Error: notebook "${name}" already exists — switch to it with op "use"`;
		}
		if (!create && !known && name !== kernel.notebook) {
			const have = listNotebooks(cwd).map((n) => n.name);
			return (
				`Error: no notebook "${name}"` +
				(have.length ? ` — this project has: ${have.join(", ")}` : "") +
				'. Create it with op "new".'
			);
		}

		if (name === kernel.notebook) return `already on notebook "${name}"`;
		const failed = kernel.useNotebook(name);
		if (failed) return `Error: ${failed}`;
		gen++;
		mut++;

		const planned = plannedInterpreter(cwd, name);
		const head = `notebook "${name}" (${planned.source === "venv" ? planned.venv : planned.python})`;
		// `open` passes false: it is about to load a specific file, and loading
		// the checkpoint first would only be reconciled away by that.
		if (!loadCheckpoint) return `${head}${SWITCH_NOTE}`;
		if (!existsSync(file)) return `${head}\nnew and empty.${SWITCH_NOTE}`;
		const loaded = await call({ tool: "load", path: file });
		return `${head}\n${formatRun(loaded as RunResponse)}${SWITCH_NOTE}`;
	}

	/**
	 * A restart, and the bookkeeping that goes with one.
	 *
	 * `Kernel.restartProcess` does the work — it replaces the interpreter
	 * rather than just the namespace, which is what makes an edited project
	 * file get re-read. What belongs out here is the generation counter: the
	 * namespace every earlier result described is gone, so those results are
	 * superseded, exactly as after a notebook switch.
	 */
	async function hardRestart(): Promise<KernelResponse> {
		const resp = await kernel.restartProcess();
		gen++;
		mut++;
		return resp;
	}

	// ── nb_cell: write a cell ───────────────────────────────────────
	pi.registerTool({
		name: "nb_cell",
		label: "Notebook Cell",
		description:
			"Create or edit a cell in a persistent Python notebook, and run it. Cells are an ordered " +
			"list over one shared namespace and execute top to bottom, as in Jupyter. Omit " +
			"`id` to create a cell (the generated id comes back; quote it to edit that cell later); " +
			"pass `after` to insert somewhere other than the end. Set `run: false` to write without " +
			"executing. Prefer this over running python in bash: the nb_cell namespace persists between calls.",
		// pi renders this as `- nb_cell: <snippet>`, so the name is already there.
		promptSnippet: "create or edit a cell in a persistent Python notebook and run it.",
		// Every guideline names the tool it is about. pi concatenates each
		// active tool's guidelines into one flat list alongside its own
		// bash/edit/write advice, deduped and bulleted, with nothing recording
		// whose is whose.
		promptGuidelines: [
			"Aim to use nb_cell with one small, self-contained statement per cell (eg. a data load, a transform, a plot): small cells are what make re-running a single step cheap.",
			"In nb_cell, a cell whose last line is an expression displays that value; use that to show a result. print() also works and its output is captured, but the trailing expression also prints a summary or a value's shape.",
			"nb_cell reports `stale` cells: ones that ran before something above them changed. Their variables are still in the namespace but the notebook no longer reproduces them — re-run with nb_run before trusting those values.",
			"Editing a cell with nb_cell discards its previous output, because that output belonged to code the cell no longer contains. The cell comes back as `unrun`.",
			"On ImportError in nb_cell, use nb_install rather than pip or uv from bash, so the package lands in the interpreter the kernel is actually running.",
			'The nb_cell kernel runs in the project directory and that directory is on sys.path, so a module you write there can be imported from a notebook cell. After editing such a file, run `nb_notebook {op: "restart"}` before importing.',
		],
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({ description: "Existing cell id to edit. Omit to create a new cell." }),
			),
			src: Type.String({ description: "The cell's source." }),
			after: Type.Optional(
				Type.String({
					description:
						'Where to insert a new cell: a cell id to go after, "start", or "end" (the default). Ignored when editing.',
				}),
			),
			kind: Type.Optional(
				Type.Union([Type.Literal("code"), Type.Literal("markdown")], {
					description: "Cell type. Markdown cells are never executed. Defaults to code.",
				}),
			),
			run: Type.Optional(
				Type.Boolean({ description: "Execute immediately (default true). False writes without running." }),
			),
		}),
		async execute(_id, params) {
			return runReply(
				await call(
					params.id
						? {
								tool: "set_cell",
								id: params.id,
								src: params.src,
								kind: params.kind,
								run: params.run ?? true,
							}
						: {
								tool: "add_cell",
								src: params.src,
								after: params.after,
								kind: params.kind ?? "code",
								run: params.run ?? true,
							},
				),
			);
		},
	});

	// ── nb_run: execute what is already there ───────────────────────
	pi.registerTool({
		name: "nb_run",
		label: "Notebook Run",
		description:
			"Execute cells that already exist. Ops: cell (just that one), all (every cell from the " +
			"top, into a fresh interpreter by default — the Restart & Run All button), above (every " +
			"cell before the given one), below (the given cell and everything after it). A run stops " +
			"at the first cell that raises. Also file: run a .py in the notebook's own interpreter as " +
			"a fresh process — it sees the packages nb_install put there, but it is not a cell, so it " +
			"binds nothing in the namespace, makes nothing stale, and returns no plots.",
		promptSnippet:
			"run one notebook cell, everything, everything above or below a cell, or a .py file.",
		promptGuidelines: [
			'`nb_run {op: "all"}` restarts the interpreter and replays the notebook as a program. It is the way to clear a `stale` report, and the only run that proves the notebook reproduces — including re-importing any project file that changed on disk.',
			'After editing a cell in the middle, `nb_run {op: "below", id: <that cell>}` is usually what you want: it re-runs the edited cell and everything that could depend on it, without redoing the expensive setup above.',
			'`nb_run {op: "file", path}` runs a .py as a fresh process in the notebook\'s own interpreter — use it to check a script or a project file you just wrote, instead of `python` in bash, which runs under an interpreter the notebook is not using. It binds nothing in the namespace and disturbs no cell.',
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("cell"),
					Type.Literal("all"),
					Type.Literal("above"),
					Type.Literal("below"),
					Type.Literal("file"),
				],
				{ description: "Which cells to run." },
			),
			id: Type.Optional(Type.String({ description: "Cell id (required for cell, above, below)." })),
			restart: Type.Optional(
				Type.Boolean({
					description:
						'Only for op "all": start from a fresh namespace (default true). False replays over the current one.',
				}),
			),
			path: Type.Optional(
				Type.String({
					description:
						'Only for op "file": the .py to run, absolute or relative to the project. It runs as an ordinary script, so its own directory is on sys.path — not the project directory, which is what a cell gets.',
				}),
			),
			args: Type.Optional(
				Type.Array(Type.String(), {
					description: 'Only for op "file": command-line arguments, passed to the script as sys.argv[1:].',
				}),
			),
		}),
		async execute(_id, params) {
			if (params.op === "file") {
				if (!params.path) return reply('Error: path required for op "file"', "nb.error");
				// Deliberately not through `call`: this never reaches the kernel, so
				// it counts as no mutation, writes no checkpoint, and reports no
				// staleness — there is none to report.
				const run = await runFile(await kernel.pythonFor(), params.path, params.args ?? [], cwd);
				return reply(formatFile(run), "nb.file", run);
			}
			if (params.op === "all") {
				// The restart is done out here rather than passed down, so that
				// "into a fresh namespace" means a fresh interpreter: a run that
				// replays over a stale imported module proves nothing about
				// whether the notebook reproduces.
				if (params.restart ?? true) {
					const restarted = await hardRestart();
					if (!restarted.ok) return runReply(restarted);
				}
				return runReply(await call({ tool: "run_all", restart: false }));
			}
			if (!params.id) return reply(`Error: id required for op ${params.op}`, "nb.error");
			const tool = { cell: "run_cell", above: "run_above", below: "run_below" }[params.op];
			return runReply(await call({ tool, id: params.id }));
		},
	});

	// ── nb_notebook: everything that is not writing or running ──────
	pi.registerTool({
		name: "nb_notebook",
		label: "Notebook",
		description:
			"Inspect and manage the notebook itself. Ops: list (every cell with its state — cheap, use " +
			"it to orient), read (full source of one cell or all), delete, move, restart (replace the " +
			"interpreter — the namespace and every imported module go, the cells stay), " +
			"save (export to a percent-format .py), open (read one back), " +
			"notebooks (every notebook in this project), new (start a fresh one under a name), use " +
			"(switch to an existing one), env (the interpreter, its version and every installed " +
			"package — the lock to record when a result has to be reproducible later), digest (the " +
			"checkpoint's content hash, and whether the live kernel has drifted from it). " +
			"Each notebook has its own interpreter and its own installed packages, and is checkpointed " +
			"to .pi/notebooks/<name>.py, which is ordinary source and is meant to be committed. " +
			"The file format is jupytext `# %%` blocks, so it opens in Jupyter and VS Code and diffs " +
			"like source — but it stores no outputs, so an opened notebook has code and no results.",
		promptSnippet:
			"list, read, delete, move, restart, save, open, switch between notebooks, or report the environment and the checkpoint.",
		promptGuidelines: [
			'Call `nb_notebook {op: "list"}` to orient before editing cells you did not create — the user may have added their own via /nb, or opened a notebook from disk.',
			'Use `nb_notebook {op: "new", name}` when starting work that needs different packages from what is already loaded: each notebook has its own venv. NB: Switching venv discards the current namespace.',
			'`nb_notebook {op: "save"}` exports a .py that stores source but no outputs; the notebook is already checkpointed to .pi/notebooks/ after every change, so save is for handing a copy somewhere else.',
			'Deleting a cell with nb_notebook does NOT remove the variables it defined — they stay in the namespace until a restart. Use `nb_run {op: "all"}` if you need to refresh the namespace.',
			'`nb_notebook {op: "env"}` reports the interpreter actually running, which rule chose it, and every installed package as `name==version` lines. Record it alongside a result that has to be reproducible later, and read it when an import fails in a way that suggests the wrong environment.',
			'`nb_notebook {op: "digest"}` says whether .pi/notebooks/<name>.py still matches the live kernel. It should be in step, because it is rewritten after every change — so check it after editing that file outside the session, and `nb_notebook {op: "open", path}` to adopt the file if it diverged.',
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("list"),
					Type.Literal("read"),
					Type.Literal("delete"),
					Type.Literal("move"),
					Type.Literal("restart"),
					Type.Literal("save"),
					Type.Literal("open"),
					Type.Literal("notebooks"),
					Type.Literal("new"),
					Type.Literal("use"),
					Type.Literal("env"),
					Type.Literal("digest"),
				],
				{ description: "Notebook operation." },
			),
			id: Type.Optional(Type.String({ description: "Cell id (read, delete, move)." })),
			after: Type.Optional(
				Type.String({ description: 'Where to move the cell: a cell id, "start", or "end".' }),
			),
			path: Type.Optional(Type.String({ description: "File path (save, open)." })),
			name: Type.Optional(
				Type.String({
					description: "Notebook name (new, use). Letters, digits, dot, dash and underscore.",
				}),
			),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Only for save: replace a file that is not already a notebook. Without it, saving over a plain .py is refused.",
				}),
			),
			run: Type.Optional(
				Type.Boolean({ description: "Only for open: run every cell after loading (default false)." }),
			),
			lock: Type.Optional(
				Type.Boolean({
					description:
						"Only for env: include the package list (default true). False reports just the interpreter, its version and where it came from.",
				}),
			),
		}),
		async execute(_id, params) {
			switch (params.op) {
				case "list": {
					const response = (await call({ tool: "inspect" })) as InspectResponse;
					return reply(formatInspect(response, kernel.notebook), "nb.list", response);
				}
				case "read": {
					const response = (await call({ tool: "read", id: params.id })) as ReadResponse;
					return reply(formatRead(response), "nb.read", response);
				}
				case "delete":
					if (!params.id) return reply("Error: id required for delete", "nb.error");
					return runReply(await call({ tool: "delete_cell", id: params.id }));
				case "move":
					if (!params.id) return reply("Error: id required for move", "nb.error");
					return runReply(await call({ tool: "move_cell", id: params.id, after: params.after }));
				case "restart":
					return runReply(await hardRestart(), "", RESTART_NOTE);
				case "save":
					if (!params.path) return reply("Error: path required for save", "nb.error");
					return runReply(
						await call({
							tool: "save",
							path: params.path,
							overwrite: params.overwrite ?? false,
							notebook: kernel.notebook,
						}),
					);
				case "open": {
					if (!params.path) return reply("Error: path required for open", "nb.error");
					const declared = declaredNotebook(params.path);
					let preamble = "";
					if (declared && !nameError(declared) && declared !== kernel.notebook) {
						// The file names the environment it was written under, so put it
						// back there rather than running it against whatever is loaded.
						const switched = await switchTo(declared, false, false);
						if (switched.startsWith("Error:")) return reply(switched, "nb.error");
						preamble = `${switched}\n\n`;
					} else if (!declared) {
						preamble =
							`this file names no notebook, so it is being opened in "${kernel.notebook}" — ` +
							"its imports may not be installed here.\n";
					}
					return runReply(
						await call({ tool: "load", path: params.path, run: params.run ?? false }),
						preamble,
					);
				}
				case "notebooks":
					return reply(
						formatNotebooks(listNotebooks(cwd), kernel.notebook),
						"nb.notebooks",
						listNotebooks(cwd),
					);
				case "env": {
					const wantLock = params.lock ?? true;
					const response = (await call({ tool: "env", lock: wantLock })) as EnvResponse;
					if (!response.ok) {
						return reply(`Error: ${response.error ?? "unknown"}`, "nb.error", response);
					}
					// uv is asked second and wins when it answers: it renders an
					// editable or VCS install as the reference it is, where the
					// kernel's `importlib.metadata` scan shows only a version — and a
					// lock that turns a checkout into a release number is worse than
					// no lock. The kernel's answer stands when uv is not installed.
					if (wantLock && response.executable) {
						const uv = await uvFreeze(response.executable);
						if (uv) {
							response.packages = uv;
							response.producer = "uv pip freeze";
						}
					}
					const plan = envPlan(cwd, kernel.notebook, response.executable);
					return reply(formatEnv(response, plan), "nb.env", { ...response, plan });
				}
				case "digest": {
					const file = fileDigest(kernel.checkpoint);
					// Only a *live* kernel is asked. Going through `call` would spawn
					// one — and on a fresh clone that means building a venv, seconds
					// of work as a side effect of asking whether a hash matches.
					let live: DigestReport["kernel"] = null;
					if (kernel.running) {
						const resp = await call({ tool: "digest", notebook: kernel.notebook });
						if (!resp.ok) return reply(`Error: ${resp.error ?? "unknown"}`, "nb.error", resp);
						live = {
							sha256: resp.sha256 as string,
							bytes: resp.bytes as number,
							cells: resp.cells as number,
						};
					}
					const report: DigestReport = {
						notebook: kernel.notebook,
						checkpoint: kernel.checkpoint,
						file,
						kernel: live,
					};
					return reply(formatDigest(report), "nb.digest", report);
				}
				case "new":
				case "use": {
					if (!params.name) return reply(`Error: name required for ${params.op}`, "nb.error");
					const text = await switchTo(params.name, params.op === "new");
					return reply(text, text.startsWith("Error:") ? "nb.error" : "nb.switch");
				}
			}
		},
	});

	// ── nb_install: packages into the kernel's own interpreter ──────
	pi.registerTool({
		name: "nb_install",
		label: "Notebook Install",
		description:
			"Install Python packages INTO the notebook kernel's interpreter. Use this instead of pip " +
			"or uv in bash, which install somewhere the kernel is not looking. Each notebook has its " +
			"own environment, so this affects only the notebook the session is on. A package that was " +
			"already imported keeps its old code until the interpreter is restarted; the result says so " +
			'when that happens, and `nb_notebook {op: "restart"}` is what clears it.',
		promptSnippet: "pip-install packages into the notebook kernel's own interpreter.",
		promptGuidelines: [
			"Give nb_install all packages in one call, so pip can resolve the whole set together.",
			'When nb_install raises a version conflict, creating a fresh environment with `nb_notebook {op: "new", name}` can be a quick fix.',
			// The remedy named here is the one `formatRun` prints at the moment it
			// happens, so the guideline and the tool result cannot disagree.
			'An nb_install disturbs no cell: nothing becomes `stale` and the namespace is untouched, so there is nothing to re-run afterwards — unless the result names a package that was already imported, which keeps its old code until `nb_run {op: "all"}`.',
		],
		parameters: Type.Object({
			packages: Type.Array(Type.String(), {
				description: 'Package specifiers, e.g. ["pandas", "matplotlib==3.9.2"].',
			}),
			upgrade: Type.Optional(Type.Boolean({ description: "Pass -U to pip." })),
		}),
		async execute(_id, params) {
			return runReply(
				await call({
					tool: "install",
					packages: params.packages,
					upgrade: params.upgrade ?? false,
				}),
			);
		},
	});

	// ── /nb-python: pin the interpreter this notebook runs under ────
	pi.registerCommand("nb-python", {
		description:
			"Pin which python the current notebook uses: /nb-python /path/to/venv (or .../bin/python). " +
			"Restarts the kernel — python state is lost.",
		handler: async (args, ctx) => {
			const target = args.trim();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			if (!target) {
				const planned = plannedInterpreter(cwd, kernel.notebook);
				notify(
					`notebook "${kernel.notebook}" runs ${planned.python} (${planned.source}).\n` +
						"Usage: /nb-python /path/to/venv-or-python — pins this notebook only, on this " +
						"machine only. /nb-python clear goes back to the notebook's own venv.",
				);
				return;
			}
			if (target === "clear") {
				unpinPython(cwd, kernel.notebook);
				kernel.kill();
				mut++;
				notify(
					`notebook "${kernel.notebook}" unpinned; it goes back to its own venv ` +
						"(kernel will restart, python state lost).",
				);
				return;
			}
			pinPython(cwd, kernel.notebook, target);
			kernel.kill(); // next tool call respawns under the pinned interpreter
			// State changed with nothing in the transcript to show for it. `gen`
			// follows on the next call, when the respawn reports the loss.
			mut++;
			notify(
				`notebook "${kernel.notebook}" pinned to ${target}; kernel will restart (python state lost).`,
			);
		},
	});

	// ── /nb: the human shares the namespace ─────────────────────────
	pi.registerCommand("nb", {
		description:
			"Poke the notebook kernel: /nb lists cells, /nb add <src>, /nb run <id>, " +
			"/nb run-all, /nb read <id>, /nb save <path>, /nb open <path>, /nb notebooks, " +
			"/nb new <name>, /nb use <name>, /nb drop-venv <name>, /nb <expr> evaluates.",
		handler: async (args, ctx) => {
			const input = args.trim();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			const show = (resp: KernelResponse) =>
				notify(formatRun(resp as RunResponse), resp.ok ? "info" : "error");

			if (!input || input === "list") {
				const resp = await call({ tool: "inspect" });
				notify(formatInspect(resp as InspectResponse, kernel.notebook), resp.ok ? "info" : "error");
				return;
			}
			if (input === "notebooks") {
				notify(formatNotebooks(listNotebooks(cwd), kernel.notebook));
				return;
			}
			// The same restart nb_run does, for the same reason: a run-all that
			// replayed over a stale imported module would be the one command
			// that is supposed to prove the notebook reproduces, quietly not
			// proving it. The human's surface gets the guarantee too.
			if (input === "run-all") {
				const restarted = await hardRestart();
				if (!restarted.ok) return show(restarted);
				return show(await call({ tool: "run_all", restart: false }));
			}

			const switching = input.match(/^(new|use)\s+(\S+)$/);
			if (switching) {
				const text = await switchTo(switching[2], switching[1] === "new");
				notify(text, text.startsWith("Error:") ? "error" : "info");
				return;
			}

			// Reclaiming disk is the human's call, not the agent's: "this
			// notebook is finished" is a fact about intentions, and the model is
			// no better placed to know it than the kernel is (semantics.md §3.8).
			// So this is a command and there is no matching nb_notebook op.
			const dropping = input.match(/^drop-venv\s+(\S+)$/);
			if (dropping) {
				const name = dropping[1];
				const bad = nameError(name);
				if (bad) return notify(`Error: ${bad}`, "error");
				const removed = dropVenv(cwd, name);
				// Whether this took the environment out from under the session,
				// which is *not* the same as it being the current notebook: an
				// override means the kernel never ran that venv, so removing it
				// is pure disk and costs the namespace nothing. Killing on
				// `current` alone would throw the session away for no reason and
				// then promise a rebuild that `resolvePython` never performs.
				const live =
					removed !== null &&
					name === kernel.notebook &&
					plannedInterpreter(cwd, name).source === "venv";
				if (live) {
					kernel.kill(); // the next call rebuilds it
					// `gen` follows on the next call, when the respawn reports the
					// loss — same as /nb-python. Bumping it here would count the
					// one loss twice, since nothing stamps this notify.
					mut++;
				}
				const file = notebookFile(cwd, name);
				notify(
					(removed
						? `removed the venv for "${name}": ${removed}`
						: `notebook "${name}" has no venv to remove`) +
						(existsSync(file) ? `\n${file} is untouched.` : `\n${file} was removed. This is a bug!`) +
						// Dropping the environment out from under the running session
						// is a state loss like any other, and has to say so.
						(live
							? "\n\nNOTE: that was this session's own environment. The namespace is " +
								"gone and every cell is unrun; the venv is rebuilt, empty, on the next " +
								'call, so anything installed must be installed again. nb_run {op: "all"} to rebuild.'
							: ""),
				);
				return;
			}

			const run = input.match(/^run\s+(\S+)/);
			if (run) return show(await call({ tool: "run_cell", id: run[1] }));

			const read = input.match(/^read(?:\s+(\S+))?$/);
			if (read) {
				const resp = await call({ tool: "read", id: read[1] });
				notify(formatRead(resp as ReadResponse), resp.ok ? "info" : "error");
				return;
			}
			const save = input.match(/^save\s+(\S+)/);
			if (save) {
				return show(await call({ tool: "save", path: save[1], notebook: kernel.notebook }));
			}

			const open = input.match(/^open\s+(\S+)/);
			if (open) {
				const declared = declaredNotebook(open[1]);
				if (declared && !nameError(declared) && declared !== kernel.notebook) {
					// Same as the tool's `open`: the file about to be loaded is the
					// point, so the notebook's own checkpoint is not read first.
					notify(await switchTo(declared, false, false));
				}
				return show(await call({ tool: "load", path: open[1] }));
			}

			// Everything after `add` is source. There is no optional name slot to
			// be greedy about, so `/nb add import math` adds `import math` rather
			// than a cell named `import` whose body is `math`.
			const add = input.match(/^add\s+([\s\S]+)/);
			if (add) return show(await call({ tool: "add_cell", src: add[1] }));
			// Anything else is an expression to evaluate without creating a cell.
			const resp = await call({ tool: "eval", src: input });
			notify(
				formatEval(resp as { ok: boolean; value?: string | null; error?: string | null }),
				resp.ok ? "info" : "error",
			);
		},
	});
}
