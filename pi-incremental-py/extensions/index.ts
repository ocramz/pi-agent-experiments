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
import { resolveContextFilter } from "../src/config.ts";
import { filterPyContext, type PyDetails, type PyPayload } from "../src/context-filter.ts";
import {
	formatEval,
	formatInspect,
	formatResults,
	type CellResult,
	type InspectResponse,
	type MutatingResponse,
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
			"If a cell fails, its dependents stay pending (not poisoned). Fix the cell and they re-run. Check `failing`/`pending` in the response.",
			"On ImportError, use py_install — never pip/uv from bash, which bypasses the kernel's environment tracking and leaves cached cells stale.",
			"Set volatile: true when the cell's value depends on something the kernel cannot digest — the clock, an RNG, an environment variable, a network response. Such a cell is never served from cache, and neither is anything downstream of it. Do NOT set it for file reads or imports: files are digested automatically and package installs are already tracked, so declaring those only throws away caching you would otherwise get.",
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
			volatile: Type.Optional(
				Type.Boolean({
					description:
						"Declare that this cell reads something the kernel cannot digest (clock, RNG, env var, network), so it must never be served from cache. Files and imports are tracked automatically and do NOT need this. On modify, omitting it keeps the current setting; pass false to clear.",
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
						volatile: params.volatile,
					})
				: await call({
						tool: "add_cell",
						src: params.src,
						name: params.name,
						run: params.run ?? true,
						volatile: params.volatile ?? false,
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
						volatile: Type.Optional(
							Type.Boolean({
								description:
									"Never serve this cell from cache: it reads something undigestible (clock, RNG, network). Omit on `set` to keep the current setting.",
							}),
						),
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
			"Poke the incremental Python kernel: /py <expr> evaluates, /py add [name] <src>, /py rerun <id>, /py run-all, /py inspect",
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
		contextFilter = resolveContextFilter({
			// An untrusted project's settings are not honoured — the same rule pi
			// applies to .pi/settings.json before loading anything out of it.
			cwd: ctx.isProjectTrusted() ? ctx.cwd : undefined,
		});
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
