// The contract between a test and the scripted model it drives.
//
// Deliberately free of pi imports: faux-model.ts is loaded *by pi*, which
// supplies @earendil-works/* at runtime; the test process is plain node with
// no node_modules, and importing anything that reaches pi-ai from a test would
// fail before the first case ran. Same split as pi-notebook-py/test/tui.

import { join } from "node:path";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux";
/** Where the script is read from and the turns are written, under the fixture. */
export const FAUX_DIR = ".faux";
export const SCRIPT_FILE = "script.json";

/**
 * One scripted turn: call a tool, or answer with text and end the run. A
 * script that runs out repeats its last step, which is what an autoprove loop
 * of unknown length needs ("say nothing useful, forever").
 */
export type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string };

export function turnFile(dir: string, turn: number): string {
	return join(dir, FAUX_DIR, `turn-${turn}.json`);
}
