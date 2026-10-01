/**
 * JSON-RPC 2.0 over an LSP byte stream: requests matched by id, notifications,
 * and the server's own requests answered.
 *
 * Deliberately transport-agnostic — it takes a Readable and a Writable — so the
 * unit tier drives it over in-memory streams and the server owns the process.
 *
 * Three rules this file exists to keep:
 *
 *  - A request that times out or is aborted sends `$/cancelRequest` and is
 *    forgotten; its late response is dropped, never delivered to the next
 *    caller that happens to reuse nothing (ids only ever increase).
 *  - Nothing here may produce an unhandled rejection. Node 24 exits the process
 *    on one, and the process is pi. Every promise handed out is the caller's to
 *    observe; nothing internal is left dangling.
 *  - The server's requests to us (`client/registerCapability`,
 *    `window/workDoneProgress/create`, `workspace/configuration`) are answered,
 *    because an unanswered one can stall the server waiting for us.
 */

import type { Readable, Writable } from "node:stream";
import { AbortError } from "../errors.ts";
import { MessageReader, encodeMessage } from "./framing.ts";

export class RequestTimeout extends Error {
	override name = "RequestTimeout";
}

export class ConnectionClosed extends Error {
	override name = "ConnectionClosed";
}

/** An error the server answered with (`{error: {code, message, data}}`). */
export class ResponseError extends Error {
	override name = "ResponseError";
	readonly code: number;
	readonly data: unknown;
	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.code = code;
		this.data = data;
	}
}

export interface RequestOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
}

export interface ConnectionOptions {
	input: Readable;
	output: Writable;
	onNotification?: (method: string, params: unknown) => void;
	/** Answer a server→client request. Return `undefined` to fall back to the defaults. */
	onRequest?: (method: string, params: unknown) => unknown;
	defaultTimeoutMs?: number;
	log?: (line: string) => void;
}

interface Pending {
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	cleanup: () => void;
}

const METHOD_NOT_FOUND = -32601;

export class LspConnection {
	#output: Writable;
	#onNotification: (method: string, params: unknown) => void;
	#onRequest: ((method: string, params: unknown) => unknown) | undefined;
	#defaultTimeoutMs: number;
	#log: (line: string) => void;
	#nextId = 1;
	#pending = new Map<number, Pending>();
	#closed: string | null = null;
	#closeListeners: ((reason: string) => void)[] = [];

	constructor(opts: ConnectionOptions) {
		this.#output = opts.output;
		this.#onNotification = opts.onNotification ?? (() => {});
		this.#onRequest = opts.onRequest;
		this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? 120_000;
		this.#log = opts.log ?? (() => {});
		const reader = new MessageReader(
			(m) => this.#dispatch(m),
			(err) => this.#log(err.message),
		);
		opts.input.on("data", (chunk: Buffer) => reader.push(chunk));
		opts.input.on("end", () => this.close("the server closed its output stream"));
		opts.input.on("close", () => this.close("the server closed its output stream"));
		opts.input.on("error", (err: Error) => this.close(`the server's output stream failed: ${err.message}`));
		opts.output.on("error", (err: Error) => this.close(`the server's input stream failed: ${err.message}`));
	}

	get closed(): boolean {
		return this.#closed !== null;
	}

	get closeReason(): string | null {
		return this.#closed;
	}

	/** Called once, with the reason, when the connection closes. */
	onClose(listener: (reason: string) => void): void {
		if (this.#closed !== null) listener(this.#closed);
		else this.#closeListeners.push(listener);
	}

	get pendingCount(): number {
		return this.#pending.size;
	}

	request<T>(method: string, params: unknown, opts: RequestOptions = {}): Promise<T> {
		if (this.#closed !== null) return Promise.reject(new ConnectionClosed(this.#closed));
		if (opts.signal?.aborted) return Promise.reject(new AbortError());
		const id = this.#nextId++;
		return new Promise<T>((resolve, reject) => {
			const timeoutMs = opts.timeoutMs ?? this.#defaultTimeoutMs;
			const timer =
				timeoutMs > 0 && Number.isFinite(timeoutMs)
					? setTimeout(() => {
							this.#abandon(id, new RequestTimeout(`${method} did not answer within ${Math.round(timeoutMs / 1000)}s`));
						}, timeoutMs)
					: undefined;
			const onAbort = () => this.#abandon(id, new AbortError(`${method} was aborted`));
			opts.signal?.addEventListener("abort", onAbort, { once: true });
			this.#pending.set(id, {
				method,
				resolve: resolve as (value: unknown) => void,
				reject,
				cleanup: () => {
					if (timer) clearTimeout(timer);
					opts.signal?.removeEventListener("abort", onAbort);
				},
			});
			this.#send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		if (this.#closed !== null) return;
		this.#send({ jsonrpc: "2.0", method, params });
	}

	/** Reject everything outstanding. Idempotent. */
	close(reason: string): void {
		if (this.#closed !== null) return;
		this.#closed = reason;
		const pending = [...this.#pending.values()];
		this.#pending.clear();
		for (const p of pending) {
			p.cleanup();
			p.reject(new ConnectionClosed(`${reason} (while waiting for ${p.method})`));
		}
		for (const listener of this.#closeListeners.splice(0)) {
			try {
				listener(reason);
			} catch {
				/* a close listener must not break the others */
			}
		}
	}

	#abandon(id: number, err: Error): void {
		const p = this.#pending.get(id);
		if (!p) return;
		this.#pending.delete(id);
		p.cleanup();
		this.notify("$/cancelRequest", { id });
		p.reject(err);
	}

	#send(message: unknown): void {
		try {
			this.#output.write(encodeMessage(message));
		} catch (err) {
			this.close(`could not write to the server: ${(err as Error).message}`);
		}
	}

	#dispatch(raw: unknown): void {
		if (typeof raw !== "object" || raw === null) return;
		const m = raw as { id?: number | string | null; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string; data?: unknown } };
		if (typeof m.method === "string") {
			if (m.id !== undefined && m.id !== null) this.#answer(m.id, m.method, m.params);
			else this.#safeNotify(m.method, m.params);
			return;
		}
		if (typeof m.id !== "number") return;
		const p = this.#pending.get(m.id);
		if (!p) return; // abandoned: timed out, aborted, or never ours
		this.#pending.delete(m.id);
		p.cleanup();
		if (m.error) p.reject(new ResponseError(m.error.code, `${p.method}: ${m.error.message}`, m.error.data));
		else p.resolve(m.result ?? null);
	}

	#safeNotify(method: string, params: unknown): void {
		try {
			this.#onNotification(method, params);
		} catch (err) {
			this.#log(`notification handler for ${method} threw: ${(err as Error).message}`);
		}
	}

	#answer(id: number | string, method: string, params: unknown): void {
		let result: unknown;
		try {
			result = this.#onRequest?.(method, params);
		} catch (err) {
			this.#log(`request handler for ${method} threw: ${(err as Error).message}`);
		}
		if (result === undefined) result = defaultAnswer(method, params);
		if (result === METHOD_NOT_FOUND_SENTINEL) {
			this.#send({ jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `unhandled method ${method}` } });
			return;
		}
		this.#send({ jsonrpc: "2.0", id, result });
	}
}

const METHOD_NOT_FOUND_SENTINEL = Symbol("method-not-found");

function defaultAnswer(method: string, params: unknown): unknown {
	switch (method) {
		case "client/registerCapability":
		case "client/unregisterCapability":
		case "window/workDoneProgress/create":
		case "window/showMessageRequest":
			return null;
		case "workspace/applyEdit":
			// The tools never apply a server edit; code actions are reported, not done.
			return { applied: false, failureReason: "pi-lean4 does not apply server edits" };
		case "workspace/configuration": {
			const items = (params as { items?: unknown[] } | null)?.items ?? [];
			return items.map(() => null);
		}
		default:
			return METHOD_NOT_FOUND_SENTINEL;
	}
}
