// Live cases: a real model drives the kernel through the agent tools.
// These call a LLM API and cost money; PI_TUI_SKIP_LIVE=1 opts out.

import { test } from "node:test";
import { session } from "./session.ts";

const SKIP = !!process.env.PI_TUI_SKIP_LIVE;

// L1: the model should prefer py_cell over bash python, quote the returned
// id when modifying, and land a correct final value in the namespace.
test(
	"L1: model builds cells and modifies one by id",
	{ skip: SKIP },
	async (t) => {
		const s = await session(t, { live: true });
		await s.command(
			"Using the python kernel tools (py_cell), create a cell that sets total = 10, then a second cell that sets doubled = total * 2. Then modify the first cell so total = 21. Finally tell me the value of doubled.",
		);
		await s.expect("doubled", { timeout: 240_000 });
		await s.expect("42", { timeout: 60_000 });
		await s.close();
	},
);

// L2: after an ImportError the model should reach for py_install, not bash.
// Each fixture's kernel runs in a fresh project venv, so cowsay genuinely
// is not installed. The assertion keys on the tool's output text (the word
// restart_required/installed), not the echoed prompt.
test(
	"L2: model installs a package via py_install after ImportError",
	{ skip: SKIP },
	async (t) => {
		const s = await session(t, { live: true });
		await s.command(
			"In the python kernel (py_cell), write a cell that imports the cowsay package and sets have_cowsay = True. The import will fail; install the package into the kernel properly and make sure the cell ends up ran, then confirm have_cowsay is True.",
		);
		// py_install's result text: "installed (environment changed)"
		await s.expect("environment changed", { timeout: 300_000 });
		await s.expect("have_cowsay=True", { timeout: 60_000 });
		await s.close();
	},
);
