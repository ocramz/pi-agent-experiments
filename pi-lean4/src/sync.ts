/**
 * The three locks the runtime is built from. Small on purpose: everything here
 * is a promise queue, and the interesting part is which lock guards what (see
 * lean/runtime.ts and lean/server.ts), not how a lock works.
 *
 * Every waiter can be abandoned through an AbortSignal, which matters because
 * the tool that is waiting may be cancelled by the human pressing Esc while a
 * build holds the exclusive lease for minutes.
 */

import { AbortError } from "./errors.ts";

type Waiter = { grant: () => void; fail: (err: Error) => void };

function enqueue(queue: Waiter[], signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) return reject(new AbortError());
		const waiter: Waiter = {
			grant: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			fail: reject,
		};
		const onAbort = () => {
			const i = queue.indexOf(waiter);
			if (i >= 0) queue.splice(i, 1);
			reject(new AbortError());
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		queue.push(waiter);
	});
}

/** One holder at a time, FIFO. */
export class Mutex {
	#locked = false;
	#queue: Waiter[] = [];

	get locked(): boolean {
		return this.#locked;
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (!this.#locked) {
			this.#locked = true;
		} else {
			await enqueue(this.#queue, signal);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#queue.shift();
			if (next) next.grant();
			else this.#locked = false;
		};
	}

	async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const release = await this.acquire(signal);
		try {
			return await fn();
		} finally {
			release();
		}
	}
}

/**
 * Shared leases for tool calls, an exclusive one for whatever replaces the
 * server under them (a project switch, a build, a restart). Writer-preferring:
 * once an exclusive request is queued, new shared requests queue behind it, so
 * a steady stream of tool calls cannot starve a build.
 */
export class RwLock {
	#readers = 0;
	#writer = false;
	#readQueue: Waiter[] = [];
	#writeQueue: Waiter[] = [];

	async shared(signal?: AbortSignal): Promise<() => void> {
		if (!this.#writer && this.#writeQueue.length === 0) {
			this.#readers++;
		} else {
			await enqueue(this.#readQueue, signal);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#readers--;
			this.#drain();
		};
	}

	async exclusive(signal?: AbortSignal): Promise<() => void> {
		if (!this.#writer && this.#readers === 0) {
			this.#writer = true;
		} else {
			await enqueue(this.#writeQueue, signal);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#writer = false;
			this.#drain();
		};
	}

	#drain(): void {
		if (this.#writer) return;
		if (this.#writeQueue.length > 0) {
			if (this.#readers === 0) {
				this.#writer = true;
				this.#writeQueue.shift()!.grant();
			}
			return;
		}
		while (this.#readQueue.length > 0) {
			this.#readers++;
			this.#readQueue.shift()!.grant();
		}
	}
}

/** At most `size` holders at a time. */
export class Semaphore {
	#free: number;
	#queue: Waiter[] = [];

	constructor(size: number) {
		this.#free = Math.max(1, size);
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (this.#free > 0) {
			this.#free--;
		} else {
			await enqueue(this.#queue, signal);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#queue.shift();
			if (next) next.grant();
			else this.#free++;
		};
	}
}
