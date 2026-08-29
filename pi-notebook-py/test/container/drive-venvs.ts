/**
 * The driver behind test_venv_isolation_in_image.sh.
 *
 * Runs inside the image, against a real git repository at /tmp/proj, and
 * prints `KEY=value` lines for the suite to assert on. It does what the
 * extension does — including the checkpoint write after a mutation — without
 * needing pi, which is not installed in this image and would not be the thing
 * under test if it were.
 */

import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Kernel, notebookFile, venvDir, type KernelResponse } from "../../src/kernel.ts";

const PROJECT = "/tmp/proj";
const WHEEL = "/tmp/nbprobe-1.0-py3-none-any.whl";
const REUSE_MARKER = ".built-once";

function say(key: string, value: string | number | boolean): void {
	console.log(`${key}=${value}`);
}

/** Exactly the write `extensions/index.ts` makes after every mutation. */
async function checkpoint(kernel: Kernel): Promise<KernelResponse> {
	return kernel.call({
		tool: "save",
		path: kernel.checkpoint,
		overwrite: true,
		remember: false,
		notebook: kernel.notebook,
	});
}

const kernel = new Kernel(undefined, PROJECT);
try {
	say("USER_ID", process.getuid?.() ?? -1);
	say("HOME_IS", process.env.HOME ?? "");

	// ---- notebook "a": build its environment from nothing
	kernel.useNotebook("a");
	const first = await kernel.call({ tool: "add_cell", src: "1 + 1" });
	if (!first.ok) throw new Error(`the first cell failed: ${first.error}`);

	const venvA = venvDir(PROJECT, "a");
	say("VENV_BUILT", existsSync(join(venvA, "bin", "python")) ? "yes" : `no (${venvA})`);
	say("VENV_UNDER_HOME", venvA.startsWith(homedir() + "/") && !venvA.startsWith(PROJECT) ? "yes" : "no");
	const pythonA = kernel.interpreter;

	// ---- the venv survives a respawn rather than being rebuilt
	writeFileSync(join(venvA, REUSE_MARKER), "");
	kernel.kill();
	const afterRespawn = await kernel.call({ tool: "inspect" });
	say(
		"VENV_REUSED",
		afterRespawn.ok && existsSync(join(venvA, REUSE_MARKER)) && kernel.interpreter === pythonA
			? "yes"
			: "no",
	);

	// ---- install into "a" only. A local wheel: no index, no build backend.
	const installed = await kernel.call({ tool: "install", packages: [WHEEL] });
	if (!installed.ok) throw new Error(`install failed: ${installed.error}`);
	const inA = await kernel.call({ tool: "eval", src: "import nbprobe; nbprobe.MARKER" });
	say("IMPORT_IN_A", inA.ok && inA.value === "'installed-in-a'" ? "ok" : `no (${inA.error ?? inA.value})`);

	await kernel.call({ tool: "add_cell", src: "import nbprobe" });
	await checkpoint(kernel);

	// ---- notebook "b": a different interpreter, so a different site-packages
	kernel.useNotebook("b");
	const inB = await kernel.call({ tool: "eval", src: "import nbprobe" });
	say("IMPORT_IN_B", inB.ok ? "unexpectedly-importable" : String(inB.error ?? "").split(":")[0]);

	await kernel.call({ tool: "add_cell", src: "b = 1" });
	await checkpoint(kernel);
	say("SAME_INTERPRETER", kernel.interpreter === pythonA ? "yes" : "no");

	say("CHECKPOINTS", readdirSync(join(PROJECT, ".pi", "notebooks")).sort().join(","));
	say("CHECKPOINT_PATH_B", notebookFile(PROJECT, "b"));
} catch (err) {
	console.log(`DRIVER_FAILED=${(err as Error).message}`);
	process.exitCode = 1;
} finally {
	kernel.kill();
}
