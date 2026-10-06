// The contract between a test and the scripted model it drives.
//
// Deliberately free of pi imports: faux-model.ts is loaded *by pi*, which
// supplies @earendil-works/* at runtime, while the test process is plain node
// with no node_modules at all.

import { join } from "node:path";

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux";
/** Where the script is read from and the turns are written, under the fixture. */
export const FAUX_DIR = ".faux";
export const SCRIPT_FILE = "script.json";

/** One scripted call: use a tool, or answer — optionally after some visible thinking. */
export type ScriptStep = { tool: string; args: Record<string, unknown> } | { text: string; thinking?: string };

export function turnFile(dir: string, turn: number): string {
	return join(dir, FAUX_DIR, `turn-${turn}.json`);
}
