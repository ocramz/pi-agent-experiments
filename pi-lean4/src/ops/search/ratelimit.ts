/**
 * Client-side sliding-window limits for the shared public search services,
 * as lean-lsp-mcp applies them (config.py RATE_LIMITS; MIT, © 2025 Oliver
 * Dressler). They are courtesy to services run for free by their authors,
 * not a quota anyone enforces here — a self-hosted URL is not limited.
 */

export const RATE_LIMITS: Record<RemoteSource, { max: number; perMs: number }> = {
	leansearch: { max: 90, perMs: 30_000 },
	loogle: { max: 3, perMs: 30_000 },
	leanfinder: { max: 10, perMs: 30_000 },
	premises: { max: 6, perMs: 30_000 },
};

export type RemoteSource = "leansearch" | "loogle" | "leanfinder" | "premises";

export class RateLimiter {
	#hits = new Map<RemoteSource, number[]>();
	#now: () => number;

	constructor(now: () => number = Date.now) {
		this.#now = now;
	}

	/** Record a request if allowed; otherwise how long until one would be. */
	take(source: RemoteSource): { ok: true } | { ok: false; retryAfterMs: number } {
		const { max, perMs } = RATE_LIMITS[source];
		const now = this.#now();
		const hits = (this.#hits.get(source) ?? []).filter((t) => now - t < perMs);
		if (hits.length >= max) {
			this.#hits.set(source, hits);
			return { ok: false, retryAfterMs: perMs - (now - hits[0]) };
		}
		hits.push(now);
		this.#hits.set(source, hits);
		return { ok: true };
	}
}
