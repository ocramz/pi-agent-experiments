// The contract between a test and the scripted model it drives.
//
// Deliberately free of pi imports. `faux-model.ts` is loaded *by pi*, which
// supplies @earendil-works/* at runtime; the test process is plain node with no
// node_modules at all, and importing the extension from a test would fail on
// pi-ai before the first case ran. Same reason src/config.ts spells out `.pi`
// rather than importing CONFIG_DIR_NAME.

import { join } from "node:path";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux";
/** Where the script is read from and the turns are written, under the fixture. */
export const FAUX_DIR = ".faux";
export const SCRIPT_FILE = "script.json";

/** One scripted turn: call a tool, or answer with text and end the run. */
export type ScriptStep =
	| { tool: string; args: Record<string, unknown> }
	| { text: string };

/**
 * Stands in for the id of the most recently created cell.
 *
 * A script is written before any cell exists, but editing a cell needs the id
 * the kernel minted for it. Resolved per turn against the transcript the faux
 * provider is being handed, which is the only place that id has ever been.
 */
export const LAST_ID = "@lastId";

/** The id of the nth cell the script created, counting from 1. */
export function nthId(n: number): string {
	return `@id:${n}`;
}

export function turnFile(dir: string, turn: number): string {
	return join(dir, FAUX_DIR, `turn-${turn}.json`);
}
