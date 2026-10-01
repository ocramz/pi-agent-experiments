/**
 * What every op takes and returns.
 *
 * An op is plain async code over the runtime: no pi types, no schemas. The
 * wiring in extensions/ validates parameters, calls the op, and turns the
 * result into a tool result. Keeping the line there is what lets the unit and
 * Lean tiers exercise every op without a pi session.
 */

import type { ResolvedConfig } from "../config.ts";
import type { DocHandle, LeanServer } from "../lean/server.ts";
import type { LeanRuntime } from "../lean/runtime.ts";
import { displayPath, requireLeanFile, resolveToolPath } from "../lean/project.ts";

export interface OpContext {
	cwd: string;
	cfg: ResolvedConfig;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
	/** Where rg is, if anywhere. */
	rg?: string | null;
	/** Injected so the unit tier never touches the network. */
	fetch?: typeof fetch;
}

export interface OpResult<D = Record<string, unknown>> {
	text: string;
	details: D;
}

/** Resolve a path argument and run `fn` with that file open in the right server. */
export async function withFile<T>(
	rt: LeanRuntime,
	rawPath: string,
	oc: OpContext,
	fn: (doc: DocHandle, server: LeanServer, ctx: { root: string; file: string; shown: string }) => Promise<T>,
): Promise<{ value: T; notes: string[] }> {
	const abs = resolveToolPath(rawPath, oc.cwd);
	const { file, root } = requireLeanFile(abs);
	const shown = displayPath(file, oc.cwd);
	return rt.use(
		root,
		(server) => server.withDocument(file, (doc) => fn(doc, server, { root, file, shown }), { signal: oc.signal }),
		{ signal: oc.signal, onProgress: oc.onProgress },
	);
}

/** Notes (a restart, a switch) go first: they change how the rest should be read. */
export function withNotes(text: string, notes: string[]): string {
	return notes.length ? `${notes.join("\n")}\n\n${text}` : text;
}

/** Seconds from a tool parameter to milliseconds, with a default. */
export function secondsToMs(seconds: number | undefined, fallbackMs: number): number {
	return seconds !== undefined && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : fallbackMs;
}
