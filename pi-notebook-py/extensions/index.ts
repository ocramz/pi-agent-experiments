/**
 * pi-notebook-py: a Jupyter-shaped Python notebook for the pi agent.
 *
 * Four agent tools (nb_cell, nb_run, nb_notebook, nb_install) over a
 * long-lived Python subprocess, plus /nb slash commands so the human can
 * poke the same namespace. Cells are an ordered list over one mutable
 * dict, exactly as in Jupyter; what the kernel adds is a report, on every
 * response, of which cells an edit left behind.
 *
 * No logic lives here. An extension only exists inside a running pi
 * session, so this file's only coverage is a real model driving it —
 * everything worth testing is in src/ and py/.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Kernel, pinPython, STATE_DIR, type KernelResponse } from "../src/kernel.ts";
import {
	formatEval,
	formatInspect,
	formatRead,
	formatRun,
	imagesOf,
	type InspectResponse,
	type ReadResponse,
	type RunResponse,
} from "../src/format.ts";

const LOST_STATE_NOTE =
	"\n\nNOTE: the kernel process was restarted; all Python state was lost. " +
	'Every cell is unrun — nb_run {op: "all"} to rebuild.';

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

export default function (pi: ExtensionAPI) {
	const kernel = new Kernel(undefined, process.cwd());

	// Where the kernel is in its own history. Stamped onto every result so a
	// later context filter can tell a current output from one that has been
	// superseded; `mut` counts the /nb commands too, which is the only way to
	// notice state that moved with no message in the transcript to show for it.
	let gen = 0;
	let mut = 0;

	async function call(req: Record<string, unknown>): Promise<KernelResponse> {
		const resp = await kernel.call(req);
		if (MUTATING.has(req.tool as string)) mut++;
		if (kernel.lostState) {
			kernel.lostState = false;
			gen++;
			return { ...resp, _lostState: true };
		}
		return resp;
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
	function runReply(resp: KernelResponse) {
		const response = resp as RunResponse;
		const note = (resp as Record<string, unknown>)._lostState ? LOST_STATE_NOTE : "";
		return reply(formatRun(response) + note, "nb.run", response, imagesOf(response));
	}

	// ── nb_cell: write a cell ───────────────────────────────────────
	pi.registerTool({
		name: "nb_cell",
		label: "Notebook Cell",
		description:
			"Create or edit a cell in a persistent Python notebook, and run it. Cells are an ordered " +
			"list over one shared namespace and execute top to bottom, exactly as in Jupyter. Omit " +
			"`id` to create a cell (the generated id comes back; quote it to edit that cell later); " +
			"pass `after` to insert somewhere other than the end. Set `run: false` to write without " +
			"executing. Prefer this over running python in bash: the namespace persists between calls.",
		// pi renders this as `- nb_cell: <snippet>`, so the name is already there.
		promptSnippet: "create or edit a cell in a persistent Python notebook and run it.",
		// Every guideline names the tool it is about. pi concatenates each
		// active tool's guidelines into one flat list alongside its own
		// bash/edit/write advice, deduped and bulleted, with nothing recording
		// whose is whose.
		promptGuidelines: [
			"Give nb_cell one coherent step per cell — a load, a transform, a plot — rather than one enormous cell: small cells are what make re-running a single step cheap.",
			"In nb_cell, a cell whose last line is an expression displays that value, and that is how to show a result. print() also works and its output is captured, but the trailing expression is what summarises a value's shape.",
			"nb_cell reports `stale` cells: ones that ran before something above them changed. Their variables are still in the namespace but the notebook no longer reproduces them — re-run with nb_run before trusting those values.",
			"Editing a cell with nb_cell discards its previous output, because that output belonged to code the cell no longer contains. The cell comes back as `unrun`.",
			"On ImportError, use nb_install rather than pip or uv from bash, so the package lands in the interpreter the kernel is actually running.",
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
			name: Type.Optional(
				Type.String({ description: "Optional display name. Metadata, not a lookup key." }),
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
								name: params.name,
								kind: params.kind,
								run: params.run ?? true,
							}
						: {
								tool: "add_cell",
								src: params.src,
								after: params.after,
								kind: params.kind ?? "code",
								name: params.name,
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
			"top, into a fresh namespace by default — the Restart & Run All button), above (every " +
			"cell before the given one), below (the given cell and everything after it). A run stops " +
			"at the first cell that raises.",
		promptSnippet: "run one notebook cell, everything, or everything above or below a cell.",
		promptGuidelines: [
			'`nb_run {op: "all"}` restarts the namespace and replays the notebook as a program. It is the way to clear a `stale` report, and the only run that proves the notebook reproduces.',
			'After editing a cell in the middle, `nb_run {op: "below", id: <that cell>}` is usually what you want: it re-runs the edited cell and everything that could depend on it, without redoing the expensive setup above.',
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("cell"),
					Type.Literal("all"),
					Type.Literal("above"),
					Type.Literal("below"),
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
		}),
		async execute(_id, params) {
			if (params.op === "all") {
				return runReply(await call({ tool: "run_all", restart: params.restart ?? true }));
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
			"it to orient), read (full source of one cell or all), delete, move, restart (throw the " +
			"namespace away), save (write the notebook to a percent-format .py), open (read one back). " +
			"The file format is jupytext `# %%` blocks, so it opens in Jupyter and VS Code and diffs " +
			"like source — but it stores no outputs, so an opened notebook has code and no results.",
		promptSnippet: "list, read, delete, move, restart, save or open the notebook.",
		promptGuidelines: [
			'Call `nb_notebook {op: "list"}` to orient before editing cells you did not create — the user may have added their own via /nb, or opened a notebook from disk.',
			'`nb_notebook {op: "save"}` writes a percent-format .py that stores source but no outputs. Say so when handing the file to the user, and re-run after opening one.',
			'Deleting a cell with nb_notebook does NOT remove the variables it defined — they stay in the namespace until a restart. Use `nb_run {op: "all"}` if you need the namespace to match the notebook.',
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
				],
				{ description: "Notebook operation." },
			),
			id: Type.Optional(Type.String({ description: "Cell id (read, delete, move)." })),
			after: Type.Optional(
				Type.String({ description: 'Where to move the cell: a cell id, "start", or "end".' }),
			),
			path: Type.Optional(Type.String({ description: "File path (save, open)." })),
			overwrite: Type.Optional(
				Type.Boolean({
					description:
						"Only for save: replace a file that is not already a notebook. Without it, saving over a plain .py is refused.",
				}),
			),
			run: Type.Optional(
				Type.Boolean({ description: "Only for open: run every cell after loading (default false)." }),
			),
		}),
		async execute(_id, params) {
			switch (params.op) {
				case "list": {
					const response = (await call({ tool: "inspect" })) as InspectResponse;
					return reply(formatInspect(response), "nb.list", response);
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
					return runReply(await call({ tool: "restart" }));
				case "save":
					if (!params.path) return reply("Error: path required for save", "nb.error");
					return runReply(
						await call({ tool: "save", path: params.path, overwrite: params.overwrite ?? false }),
					);
				case "open":
					if (!params.path) return reply("Error: path required for open", "nb.error");
					return runReply(
						await call({ tool: "load", path: params.path, run: params.run ?? false }),
					);
			}
		},
	});

	// ── nb_install: packages into the kernel's own interpreter ──────
	pi.registerTool({
		name: "nb_install",
		label: "Notebook Install",
		description:
			"Install Python packages INTO the notebook kernel's interpreter. Use this instead of pip " +
			"or uv in bash, which install somewhere the kernel is not looking. A package that was " +
			"already imported keeps its old code until the namespace is restarted; the result says so " +
			"when that happens.",
		promptSnippet: "pip-install packages into the notebook kernel's own interpreter.",
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

	// ── /nb-python: pin the interpreter the kernel runs under ───────
	pi.registerCommand("nb-python", {
		description:
			"Pin which python the notebook kernel uses: /nb-python /path/to/venv (or .../bin/python). " +
			"Restarts the kernel — python state is lost.",
		handler: async (args, ctx) => {
			const target = args.trim();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			if (!target) {
				notify(`Usage: /nb-python /path/to/venv-or-python (pinned in ${STATE_DIR}/python-pin)`);
				return;
			}
			pinPython(process.cwd(), target);
			kernel.kill(); // next tool call respawns under the pinned interpreter
			// State changed with nothing in the transcript to show for it. `gen`
			// follows on the next call, when the respawn reports the loss.
			mut++;
			notify(`Notebook python pinned to ${target}; kernel will restart (python state lost).`);
		},
	});

	// ── /nb: the human shares the namespace ─────────────────────────
	pi.registerCommand("nb", {
		description:
			"Poke the notebook kernel: /nb lists cells, /nb add [name] <src>, /nb run <id>, " +
			"/nb run-all, /nb read <id>, /nb save <path>, /nb open <path>, /nb <expr> evaluates.",
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
				notify(formatInspect(resp as InspectResponse), resp.ok ? "info" : "error");
				return;
			}
			if (input === "run-all") return show(await call({ tool: "run_all" }));

			const run = input.match(/^run\s+(\S+)/);
			if (run) return show(await call({ tool: "run_cell", id: run[1] }));

			const read = input.match(/^read(?:\s+(\S+))?$/);
			if (read) {
				const resp = await call({ tool: "read", id: read[1] });
				notify(formatRead(resp as ReadResponse), resp.ok ? "info" : "error");
				return;
			}
			const save = input.match(/^save\s+(\S+)/);
			if (save) return show(await call({ tool: "save", path: save[1] }));

			const open = input.match(/^open\s+(\S+)/);
			if (open) return show(await call({ tool: "load", path: open[1] }));

			const add = input.match(/^add\s+(?:(\w+)\s+)?([\s\S]+)/);
			if (add) {
				const [, name, src] = add;
				return show(await call({ tool: "add_cell", src, name: name || undefined }));
			}
			// Anything else is an expression to evaluate without creating a cell.
			const resp = await call({ tool: "eval", src: input });
			notify(
				formatEval(resp as { ok: boolean; value?: string | null; error?: string | null }),
				resp.ok ? "info" : "error",
			);
		},
	});
}
