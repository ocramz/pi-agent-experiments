/**
 * Token accounting for the model calls this extension makes itself.
 *
 * `/plan-stories` is a *command* and the reviewer runs inside a *tool*, so
 * neither produces session entries. pi's footer counter sums
 * `sessionManager.getEntries()` and therefore cannot see either. We total them
 * ourselves and render onto the footer's extension-status line via `setStatus`.
 *
 * `UsageDelta` is structural rather than pi's own `Usage`: `src/` may not import
 * from `@earendil-works/*`, and pi's type satisfies this shape. See
 * src/context.ts for the same technique applied to the runners.
 */

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** The shape of one model response's usage. pi's `Usage` is assignable to it. */
export interface UsageDelta {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number };
}

export function emptyUsage(): TokenUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(total: TokenUsage, delta: UsageDelta | undefined): void {
	if (!delta) return;
	total.input += delta.input ?? 0;
	total.output += delta.output ?? 0;
	total.cacheRead += delta.cacheRead ?? 0;
	total.cacheWrite += delta.cacheWrite ?? 0;
	total.cost += delta.cost?.total ?? 0;
}

/**
 * Whether anything is worth displaying.
 *
 * Deliberately ignores `cost`: a provider that reports a price but no tokens has
 * told us nothing we can put on a status line, and every provider that reports
 * a cost reports tokens too.
 */
export function hasUsage(u: TokenUsage): boolean {
	return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheWrite > 0;
}

/** Same thresholds as the built-in footer's formatTokens. */
export function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

/** Mirrors the footer's `↑ ↓ R W $` idiom so both lines read as one display. */
export function formatUsage(u: TokenUsage): string {
	const parts: string[] = [];
	if (u.input) parts.push(`↑${formatTokens(u.input)}`);
	if (u.output) parts.push(`↓${formatTokens(u.output)}`);
	if (u.cacheRead) parts.push(`R${formatTokens(u.cacheRead)}`);
	if (u.cacheWrite) parts.push(`W${formatTokens(u.cacheWrite)}`);
	if (u.cost) parts.push(`$${u.cost.toFixed(3)}`);
	return parts.join(" ");
}
