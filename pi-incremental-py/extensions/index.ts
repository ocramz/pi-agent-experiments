/**
 * pi-incremental: an incremental Python kernel for the pi agent.
 *
 * Three agent tools (py_cell, py_kernel, py_install) over a long-lived
 * Python subprocess, plus /py slash commands so the human can poke the
 * same namespace. The kernel derives a dependency DAG from each cell's
 * module-level defs/refs (symtable) and recomputes the minimum of the
 * heap on every edit.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Kernel, pinPython, type KernelResponse } from "../src/kernel.ts";
import { resolveContextFilter, resolveMemoBudget } from "../src/config.ts";
import { filterPyContext, type PyDetails, type PyPayload } from "../src/context-filter.ts";
import {
	formatEval,
	formatInspect,
	formatResults,
	formatVariants,
	type CellResult,
	type InspectResponse,
	type MutatingResponse,
	type VariantsResponse,
} from "../src/format.ts";

const LOST_STATE_NOTE =
	"\n\nNOTE: the kernel process was restarted; all Python state was lost. Rebuild with py_cell calls or py_kernel run_all.";

/** Requests that change kernel state. `eval`, `inspect` and `plan_edits` do not. */
const MUTATING = new Set([
	"add_cell",
	"set_cell",
	"delete_cell",
	"rerun_cell",
	"run_all",
	"apply_edits",
	"install",
	// A switch rebuilds part of the namespace, so results above it can be
	// stale. It never loses the *process*, though, so it moves `mut` and
	// not `gen`.
	"fork_variant",
	"switch_variant",
	"drop_variant",
]);

export default function (pi: ExtensionAPI) {
	const kernel = new Kernel(undefined, process.cwd());

	// Where the kernel is in its own history, stamped onto every result so the
	// context filter can tell a current value from one that has been recomputed
	// since. `mut` counts mutations from the /py commands too, which is the only
	// way to notice state that changed with no message in the transcript to
	// show for it.
	let gen = 0;
	let mut = 0;

	// Environment and default only: at load time there is no trust decision yet,
	// and a project's settings are not read before there is one. `session_start`
	// resolves it again with a cwd once there is.
	let contextFilter = resolveContextFilter({});

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
	 * A tool result, with the structured response kept alongside the rendered
	 * text. `details` never reaches the provider, so tagging costs nothing even
	 * when the filter is switched off — and leaving it on means turning the flag
	 * on mid-project works against the transcript already on disk.
	 */
	function text(t: string, payload?: PyPayload) {
		const details: PyDetails | Record<string, never> = payload ? { ...payload, gen, mut } : {};
		return { content: [{ type: "text" as const, text: t }], details };
	}

	// ── py_cell: the everyday verb ──────────────────────────────────
	pi.registerTool({
		name: "py_cell",
		label: "Python Cell",
		description:
			"Execute Python in a persistent, incrementally-recomputed namespace. Code forms cells; " +
			"cells form a dependency graph derived from the globals they define and read, so editing " +
			"a cell re-runs only it and its dependents. Omit `id` to create a cell (the generated id " +
			"is returned — quote it back to modify that cell later). Set `run: false` to stage without " +
			"executing. Prefer this over running python in bash: state persists and recomputation is minimal.",
		promptSnippet:
			"py_cell: run Python in a persistent incremental namespace; cells recompute minimally on edit.",
		promptGuidelines: [
			"Prefer many small cells with one definition each over few big ones: smaller cells mean finer invalidation and less recompute.",
			"A cell whose last line is an expression displays that value. Never print() for the user's benefit — stdout is captured in `output`, but the display value is the trailing expression.",
			"Self-reference is temporal: `x = x + 1` reads the previous committed value. Write accumulators as `try: x = x + 1 / except NameError: x = None` so run_all replays converge (pick the initial value that fits; None means \"nothing yet\"). Rerunning such a stateful cell ADVANCES it — it is not a refresh.",
			"Set `impure: true` on a cell that reads a clock, an RNG, the network or the filesystem. The kernel assumes a cell is a pure function of its source and its inputs, so without this it runs the effect ONCE and reports `cached` forever after — and a variant switch puts the old value back instead of fetching again. Marking it costs only that cell: dependents still skip when the value comes back unchanged.",
			"If a cell fails, its dependents stay pending (not poisoned). Fix the cell and they re-run. Check `failing`/`pending` in the response.",
			"On ImportError, use py_install — never pip/uv from bash, which bypasses the kernel's environment tracking and leaves cached cells stale.",
		],
		parameters: Type.Object({
			id: Type.Optional(
				Type.String({ description: "Existing cell id to modify. Omit to create." }),
			),
			name: Type.Optional(
				Type.String({ description: "Optional display name (create only). Metadata, not a lookup key." }),
			),
			src: Type.String({ description: "Python source for the cell." }),
			run: Type.Optional(
				Type.Boolean({ description: "Execute immediately (default true). False stages the edit." }),
			),
			impure: Type.Optional(
				Type.Boolean({
					description:
						"This cell reads a clock, an RNG, the network or the filesystem, so the same source " +
						"can answer differently. It is then re-run every time instead of cached or restored. " +
						"On modify, omit to leave the cell's current setting alone.",
				}),
			),
		}),
		async execute(_id, params) {
			const resp = params.id
				? await call({
						tool: "set_cell",
						id: params.id,
						src: params.src,
						run: params.run ?? true,
						// Omitted rather than defaulted: the kernel keeps the flag
						// a cell already carries when an edit says nothing about it.
						...(params.impure === undefined ? {} : { impure: params.impure }),
					})
				: await call({
						tool: "add_cell",
						src: params.src,
						name: params.name,
						run: params.run ?? true,
						impure: params.impure ?? false,
					});
			const note = (resp as Record<string, unknown>)._lostState ? LOST_STATE_NOTE : undefined;
			const response = resp as MutatingResponse;
			return text(formatResults(response) + (note ?? ""), {
				kind: "py.cells",
				response,
				note,
			});
		},
	});

	// ── py_kernel: the meta verb ────────────────────────────────────
	pi.registerTool({
		name: "py_kernel",
		label: "Python Kernel",
		description:
			"Kernel-level operations on the incremental Python namespace. Ops: inspect (full cell graph " +
			"and globals summary — cheap, use it to orient), rerun (force re-execute one cell and its " +
			"downstream; advances stateful cells), run_all (replay every cell from scratch — use after " +
			"py_install reports restart_required, or to recover from drift), delete (removes a cell AND " +
			"retracts its globals), plan (blast radius of edits without executing), apply (atomic batch " +
			"of add/set/delete edits).",
		promptSnippet: "py_kernel: inspect, rerun, run_all, delete, plan or batch-apply cells.",
		promptGuidelines: [
			"Use inspect to orient before editing cells you did not create — the user may have added their own via /py.",
			"run_all is the recovery move: it replays the notebook as a program and must converge to the same state. If it does not, a cell is relying on unstaged state.",
			"plan before a multi-cell refactor: it returns exactly which cells would be invalidated, without running anything.",
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("inspect"),
					Type.Literal("rerun"),
					Type.Literal("run_all"),
					Type.Literal("delete"),
					Type.Literal("plan"),
					Type.Literal("apply"),
				],
				{ description: "Kernel operation." },
			),
			id: Type.Optional(Type.String({ description: "Cell id (rerun, delete)." })),
			edits: Type.Optional(
				Type.Array(
					Type.Object({
						op: Type.Union([Type.Literal("add"), Type.Literal("set"), Type.Literal("delete")]),
						id: Type.Optional(Type.String()),
						name: Type.Optional(Type.String()),
						src: Type.Optional(Type.String()),
					}),
					{ description: "Batch edits (plan, apply)." },
				),
			),
			run: Type.Optional(Type.Boolean({ description: "Execute after apply (default true)." })),
		}),
		async execute(_id, params) {
			let req: Record<string, unknown>;
			switch (params.op) {
				case "inspect": {
					const response = (await call({ tool: "inspect" })) as InspectResponse;
					return text(formatInspect(response), { kind: "py.inspect", response });
				}
				case "rerun":
					if (!params.id) return text("Error: id required for rerun");
					req = { tool: "rerun_cell", id: params.id };
					break;
				case "run_all":
					req = { tool: "run_all" };
					break;
				case "delete":
					if (!params.id) return text("Error: id required for delete");
					req = { tool: "delete_cell", id: params.id };
					break;
				case "plan": {
					if (!params.edits) return text("Error: edits required for plan");
					const resp = await call({ tool: "plan_edits", edits: params.edits });
					return text(
						resp.ok
							? `would invalidate: ${(resp.would_invalidate as string[]).join(", ") || "(nothing)"}`
							: `Error: ${resp.error}`,
					);
				}
				case "apply":
					if (!params.edits) return text("Error: edits required for apply");
					req = { tool: "apply_edits", edits: params.edits, run: params.run ?? true };
					break;
			}
			const response = (await call(req)) as MutatingResponse;
			return text(formatResults(response), { kind: "py.cells", response });
		},
	});

	// ── py_variant: alternative programs over one namespace ─────────
	pi.registerTool({
		name: "py_variant",
		label: "Python Variant",
		description:
			"Keep several versions of the program side by side. Ops: fork (name a copy of the " +
			"current program and move onto it), switch (move to a named variant), list (names, " +
			"parents, and which cells differ from the current one), drop (forget a name). Two cells " +
			"cannot both define `model`, so trying an alternative means a variant, not a second cell. " +
			"Switching re-runs only the cells that actually differ; everything upstream stays live, " +
			"and a version you switch away from comes back without recomputing.",
		promptSnippet:
			"py_variant: fork/switch between alternative versions of the program, reusing shared results.",
		promptGuidelines: [
			"Fork before trying an alternative, not after: forking is free, and it is what lets you get the current results back without recomputing them.",
			"Comparing alternatives is switch plus reading the globals — the values of the version you left are kept, so switching back is cheap however long its cells took.",
			"A switch that would re-run a stateful cell is refused by name, because re-running an accumulator advances it instead of restoring it. Use force only if that cell's value is not what you are comparing.",
			"An `impure` cell is not refused: switching re-performs its effect rather than putting the old value back, which is what marking it asked for. Its dependents still come out of the cache when the new value matches the old.",
			"shallow gives you a variant's results without rebuilding what produced them — use it to compare outcomes across many variants. The cells behind those results stay pending and their globals absent, so run_all or any ordinary edit fills them back in.",
		],
		parameters: Type.Object({
			op: Type.Union(
				[
					Type.Literal("fork"),
					Type.Literal("switch"),
					Type.Literal("list"),
					Type.Literal("drop"),
				],
				{ description: "Variant operation." },
			),
			name: Type.Optional(
				Type.String({ description: "Variant name (fork, switch, drop); lowercase, digits and dashes." }),
			),
			force: Type.Optional(
				Type.Boolean({ description: "Switch even across a stateful cell, advancing it." }),
			),
			shallow: Type.Optional(
				Type.Boolean({
					description:
						"Switch (switch only): restore only the results already known, leaving the " +
						"cells behind them unbuilt and pending. For comparing outcomes across many " +
						"variants without materialising each one's intermediates.",
				}),
			),
		}),
		async execute(_id, params) {
			if (params.op === "list") {
				const resp = await call({ tool: "variants" });
				return text(formatVariants(resp as VariantsResponse));
			}
			if (!params.name) return text(`Error: name required for ${params.op}`);
			if (params.op === "drop") {
				const resp = await call({ tool: "drop_variant", name: params.name });
				return text(formatVariants(resp as VariantsResponse));
			}
			const resp = await call(
				params.op === "fork"
					? { tool: "fork_variant", name: params.name }
					: {
							tool: "switch_variant",
							name: params.name,
							force: params.force ?? false,
							shallow: params.shallow ?? false,
						},
			);
			const response = resp as MutatingResponse;
			return text(formatResults(response), { kind: "py.cells", response });
		},
	});

	// ── py_install: package installs with env tracking ──────────────
	pi.registerTool({
		name: "py_install",
		label: "Python Install",
		description:
			"Install Python packages INTO the kernel environment. Always use this instead of running " +
			"pip or uv in bash: the kernel tracks the installed distribution set as a dependency, so " +
			"cells that import anything automatically re-run after an install. If the result lists " +
			"restart_required (already-imported modules cannot be reloaded), follow up with " +
			"py_kernel {op: \"run_all\"}.",
		promptSnippet: "py_install: pip-install packages with dependency-tracked re-runs.",
		parameters: Type.Object({
			packages: Type.Array(Type.String(), { description: "Package specifiers, e.g. [\"pandas\", \"cowsay==6.1\"]." }),
			upgrade: Type.Optional(Type.Boolean({ description: "Pass -U to pip." })),
		}),
		async execute(_id, params) {
			const resp = await call({
				tool: "install",
				packages: params.packages,
				upgrade: params.upgrade ?? false,
			});
			if (!resp.ok) return text(`Error: ${resp.error}`);
			// The header is what the install itself did — a historical fact, kept
			// verbatim on re-render. Only the cell results underneath it go stale.
			const header: string[] = [
				resp.environment_changed ? "installed (environment changed)" : "already up to date",
			];
			const restart = resp.restart_required as string[];
			if (restart?.length) {
				header.push(
					`restart_required: ${restart.join(", ")} — already imported; run py_kernel {op: "run_all"} to pick up the new code`,
				);
			}
			const response = resp as MutatingResponse;
			const body = response.results?.length ? formatResults(response) : "";
			return text([...header, body].filter(Boolean).join("\n"), {
				kind: "py.install",
				header,
				response,
			});
		},
	});

	// ── /py-python: pin the interpreter the kernel runs under ────────
	pi.registerCommand("py-python", {
		description:
			"Pin which python the incremental kernel uses: /py-python /path/to/venv (or .../bin/python). " +
			"With no argument, show the current interpreter. Restarts the kernel — python state is lost.",
		handler: async (args, ctx) => {
			const target = args.trim();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};
			if (!target) {
				notify("Usage: /py-python /path/to/venv-or-python (pinned in .incremental/python-pin)");
				return;
			}
			pinPython(process.cwd(), target);
			kernel.kill(); // next tool call respawns under the pinned interpreter
			// State changed with nothing in the transcript to show for it. `gen`
			// follows on the next call, when the respawn reports the loss.
			mut++;
			notify(`Kernel python pinned to ${target}; kernel will restart (python state lost).`);
		},
	});

	// ── /py commands: the human shares the namespace ────────────────
	pi.registerCommand("py", {
		description:
			"Poke the incremental Python kernel: /py <expr> evaluates, /py add [name] <src>, /py rerun <id>, /py run-all, /py inspect, /py variants, /py variant fork|switch|drop <name>",
		handler: async (args, ctx) => {
			const input = args.trim();
			const notify = (msg: string, level: "info" | "error" = "info") => {
				if (ctx.hasUI) ctx.ui.notify(msg, level);
				else console.log(msg);
			};

			if (!input || input === "inspect") {
				const resp = await call({ tool: "inspect" });
				notify(formatInspect(resp as InspectResponse), resp.ok ? "info" : "error");
				return;
			}
			if (input === "run-all") {
				const resp = await call({ tool: "run_all" });
				notify(formatResults(resp as { results?: CellResult[] } & typeof resp));
				return;
			}
			if (input === "variants") {
				const resp = await call({ tool: "variants" });
				notify(formatVariants(resp as VariantsResponse), resp.ok ? "info" : "error");
				return;
			}
			const variant = input.match(/^variant\s+(fork|switch|drop)\s+(\S+)/);
			if (variant) {
				const [, op, name] = variant;
				const tool = { fork: "fork_variant", switch: "switch_variant", drop: "drop_variant" }[op];
				const resp = await call({ tool, name });
				notify(
					op === "drop"
						? formatVariants(resp as VariantsResponse)
						: formatResults(resp as { results?: CellResult[] } & typeof resp),
					resp.ok ? "info" : "error",
				);
				return;
			}
			const rerun = input.match(/^rerun\s+(\S+)/);
			if (rerun) {
				const resp = await call({ tool: "rerun_cell", id: rerun[1] });
				notify(formatResults(resp as { results?: CellResult[] } & typeof resp), resp.ok ? "info" : "error");
				return;
			}
			const add = input.match(/^add\s+(?:(\w+)\s+)?([\s\S]+)/);
			if (add) {
				const [, name, src] = add;
				const resp = await call({ tool: "add_cell", src, name: name || undefined });
				notify(
					formatResults(resp as { results?: CellResult[] } & typeof resp),
					resp.ok ? "info" : "error",
				);
				return;
			}
			// Anything else is an expression to evaluate without creating a cell.
			const resp = await call({ tool: "eval", src: input });
			notify(
				formatEval(resp as { value?: string | null; error?: string; output?: string; ok: boolean }),
				resp.ok ? "info" : "error",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		// An untrusted project's settings are not honoured — the same rule pi
		// applies to .pi/settings.json before loading anything out of it.
		const cwd = ctx.isProjectTrusted() ? ctx.cwd : undefined;
		contextFilter = resolveContextFilter({ cwd });
		// The kernel spawns lazily, so setting this before the first tool call
		// is enough; it is kept on the Kernel so a respawn is configured too.
		const budget = resolveMemoBudget({ cwd });
		if (budget !== undefined) kernel.env.PI_PY_MEMO_BUDGET = String(budget);
	});

	// ── the context filter ──────────────────────────────────────────
	// Fires before every LLM call, over a deep copy: what the session file
	// records and what the human sees are unaffected either way. Returning
	// undefined is pi's no-op, so switched off this is not merely equivalent
	// to the old behaviour, it is the old behaviour.
	pi.on("context", (event) => {
		if (!contextFilter) return;
		return { messages: filterPyContext(event.messages, { gen, mut }) as typeof event.messages };
	});
}
