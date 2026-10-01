/**
 * The one error the tools throw on purpose.
 *
 * pi sets `isError` on a tool result only when `execute` throws, and the model
 * is told (tools.md) that `isError` means "the call itself failed" while an
 * empty or partial result is an answer. So the split is: Lean's own verdicts —
 * errors in the file, sorries, a file still elaborating — come back as
 * results; everything that stopped the question from being asked at all is a
 * `LeanToolError`. The message is what the model reads, so it carries the
 * remedy, not a stack.
 */
export class LeanToolError extends Error {
	override name = "LeanToolError";
}

/** An abort, spelled the way `AbortSignal.throwIfAborted` would spell it. */
export class AbortError extends Error {
	override name = "AbortError";
	constructor(message = "the operation was aborted") {
		super(message);
	}
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AbortError();
}

export function isAbortError(err: unknown): boolean {
	return err instanceof Error && err.name === "AbortError";
}

export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
