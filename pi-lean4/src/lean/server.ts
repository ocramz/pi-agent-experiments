/**
 * One `lake serve` process and the documents open in it.
 *
 * What this class guarantees, and the reason for each:
 *
 *  - **Elaboration happens only when a question needs it.** A file is opened
 *    with `dependencyBuildMode: "never"`, so opening it never runs lake. Its
 *    text is re-sent only when the bytes on disk changed (sha256), and the
 *    "elaboration finished" barrier (`textDocument/waitForDiagnostics`) is
 *    cached per version — asking twice about an unchanged file costs nothing.
 *  - **Stale imports are rebuilt, once, and only for that file.** When the
 *    server reports "Imports are out of date and must/should be rebuilt", or
 *    the file's in-project import closure changed on disk (imports.ts says why
 *    that second check exists), the document is reopened with
 *    `dependencyBuildMode: "once"`: lake rebuilds exactly that file's imports.
 *    At most once per content hash — never a loop.
 *  - **Questions never straddle an edit.** Each document has a mutex held
 *    across sync, barrier and query, so a goal is always computed on the text
 *    whose version it is reported against. Different documents run in parallel.
 *  - **Throwaway text never touches disk.** Scratch documents
 *    (`_PiLean4Scratch<n>.lean` under the root) exist only in the server; they
 *    back tactic attempts, standalone code and axiom checks.
 *  - **Callbacks never call out.** Stream and process callbacks only mutate
 *    this object and settle promises; nothing here can reach pi.
 *
 * The approach — barrier per version, stale-import reopen with "once",
 * server-only scratch documents — follows leanclient as lean-lsp-mcp uses it
 * (MIT, © 2025 Oliver Dressler). The LSP specifics were confirmed against the
 * pinned toolchain; test/lean/contract.test.ts keeps them confirmed.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AbortError, LeanToolError, messageOf } from "../errors.ts";
import { ConnectionClosed, LspConnection, ResponseError, type RequestOptions } from "../lsp/connection.ts";
import { type Point, type Position, type Range, fromLsp, splitLines, toLsp } from "../lsp/positions.ts";
import {
	buildInitializeParams,
	type DependencyBuildMode,
	type Diagnostic,
	type FileProgressParams,
	type PublishDiagnosticsParams,
	type StaleDependencyParams,
	type SymbolInformation,
} from "../lsp/protocol.ts";
import { Mutex, Semaphore } from "../sync.ts";
import { ImportGraph } from "./imports.ts";
import { type GroupHandle, descendants, killGroup, processArgs, spawnGroup } from "./process.ts";

/** What Lean says when a file's imports need lake. "must": it failed; "should": it ran on old imports. */
export const OUT_OF_DATE = /Imports are out of date and (must|should) be rebuilt/;

/** Error codes Lean answers with when a file worker died. */
const WORKER_CRASHED = new Set([-32901, -32902]);

export interface ServerOptions {
	root: string;
	/** The command to run; `lake serve` normally, a fake server in the unit tier. */
	command: { cmd: string; args: string[] };
	env?: NodeJS.ProcessEnv;
	maxOpenFiles: number;
	scratchSlots: number;
	requestTimeoutMs: number;
	elaborationTimeoutMs: number;
	startTimeoutMs: number;
	clientVersion: string;
	log?: (line: string) => void;
}

export interface DiagReport {
	version: number;
	/** False when the soft timeout fired before elaboration finished. */
	complete: boolean;
	items: Diagnostic[];
	/** Ranges still being elaborated (only meaningful when incomplete). */
	processing: Range[];
	/** The server reported a fatal error processing the file. */
	fatal: boolean;
	/** Set when this call reopened the file so lake could rebuild its imports. */
	reopened?: string;
}

export interface DocHandle {
	readonly path: string;
	readonly uri: string;
	readonly scratch: boolean;
	readonly version: number;
	readonly text: string;
	readonly lines: readonly string[];
	/** Wait for elaboration of the current version (or the soft timeout) and report. */
	diagnostics(opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DiagReport>;
	/** Send a request about this document; a stale-import failure is repaired and retried once. */
	request<T>(method: string, params: unknown, opts?: RequestOptions): Promise<T>;
	/** Tool coordinates (1-indexed, codepoint columns) → LSP. */
	pos(line: number, column?: number): Position;
	/** LSP → tool coordinates, against this version's text. */
	point(p: Position): Point;
	/** Diagnostics most recently published for this version, without waiting. */
	current(): Diagnostic[];
}

interface Barrier {
	promise: Promise<void>;
	settled: boolean;
	error: Error | null;
}

interface Doc {
	path: string;
	uri: string;
	scratch: boolean;
	open: boolean;
	version: number;
	text: string;
	lines: string[];
	hash: string;
	closure: string | null;
	diagnostics: Diagnostic[];
	diagnosticsVersion: number;
	processing: Range[];
	fatal: boolean;
	/** "must"/"should" when the server said the imports are out of date for this version. */
	outOfDate: "must" | "should" | null;
	/** The content hash we already reopened with `once` for. */
	reopenedFor: string | null;
	crashed: boolean;
	/** A barrier has completed at least once since the last open: its worker existed. */
	elaborated: boolean;
	/** Set when the last sync found the worker dead and reopened the file. */
	revived: boolean;
	barriers: Map<number, Barrier>;
	lock: Mutex;
	lastUsed: number;
}

export interface ServerStatus {
	root: string;
	pid: number;
	alive: boolean;
	startedAt: number;
	openFiles: { path: string; version: number }[];
	scratchSlots: number;
	stderrTail: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export class LeanServer {
	readonly root: string;
	readonly startedAt = Date.now();
	#opts: ServerOptions;
	#proc: GroupHandle;
	#conn: LspConnection;
	#docs = new Map<string, Doc>();
	#versions = new Map<string, number>();
	#graph: ImportGraph;
	#scratch: Semaphore;
	#freeSlots: number[];
	#stopping: Promise<void> | null = null;
	#exitListeners: ((reason: string) => void)[] = [];
	#exitReason: string | null = null;
	#log: (line: string) => void;

	private constructor(opts: ServerOptions, proc: GroupHandle, conn: LspConnection) {
		this.root = opts.root;
		this.#opts = opts;
		this.#proc = proc;
		this.#conn = conn;
		this.#graph = new ImportGraph(opts.root);
		this.#scratch = new Semaphore(opts.scratchSlots);
		this.#freeSlots = Array.from({ length: Math.max(1, opts.scratchSlots) }, (_, i) => i);
		this.#log = opts.log ?? (() => {});
	}

	/** Spawn the server and complete the LSP handshake. */
	static async start(opts: ServerOptions, signal?: AbortSignal): Promise<LeanServer> {
		const proc = spawnGroup(opts.command.cmd, opts.command.args, { cwd: opts.root, env: opts.env });
		let server: LeanServer | null = null;
		const conn = new LspConnection({
			input: proc.child.stdout!,
			output: proc.child.stdin!,
			defaultTimeoutMs: opts.requestTimeoutMs,
			onNotification: (method, params) => {
				if (server) server.#onNotification(method, params);
			},
			log: opts.log,
		});
		server = new LeanServer(opts, proc, conn);
		const s = server;
		void proc.exited.then(({ code, signal: sig }) => {
			const reason =
				s.#stopping !== null
					? "stopped"
					: `the Lean server exited unexpectedly (${sig ?? `code ${code}`})` +
						(proc.stderrTail().trim() ? `:\n${proc.stderrTail().trim().split("\n").slice(-12).join("\n")}` : "");
			s.#exitReason = reason;
			conn.close(reason);
			for (const l of s.#exitListeners.splice(0)) {
				try {
					l(reason);
				} catch {
					/* never let a listener break the others */
				}
			}
		});
		try {
			const rootUri = pathToFileURL(opts.root).href;
			await conn.request(
				"initialize",
				buildInitializeParams({ root: opts.root, rootUri, name: "pi-lean4", version: opts.clientVersion }),
				{ timeoutMs: opts.startTimeoutMs, signal },
			);
			conn.notify("initialized", {});
			return s;
		} catch (err) {
			await killGroup(proc, { graceMs: 500 });
			if (err instanceof ConnectionClosed || proc.done) {
				const tail = proc.stderrTail().trim();
				throw new LeanToolError(
					`could not start the Lean server in ${opts.root}: ${messageOf(err)}` + (tail ? `\n${tail.split("\n").slice(-12).join("\n")}` : ""),
				);
			}
			throw err;
		}
	}

	get pid(): number {
		return this.#proc.pid;
	}

	get alive(): boolean {
		return this.#stopping === null && this.#exitReason === null && !this.#conn.closed;
	}

	get exitReason(): string | null {
		return this.#exitReason;
	}

	/** Called once if the process exits, with why. Not called for a `stop()`'s exit. */
	onExit(listener: (reason: string) => void): void {
		if (this.#exitReason !== null) listener(this.#exitReason);
		else this.#exitListeners.push(listener);
	}

	status(): ServerStatus {
		return {
			root: this.root,
			pid: this.pid,
			alive: this.alive,
			startedAt: this.startedAt,
			openFiles: [...this.#docs.values()]
				.filter((d) => d.open && !d.scratch)
				.map((d) => ({ path: d.path, version: d.version })),
			scratchSlots: this.#opts.scratchSlots,
			stderrTail: this.#proc.stderrTail(),
		};
	}

	/**
	 * Run `fn` against a file as it is on disk now. The text is (re)sent only
	 * if it changed; the import closure is checked; the document stays locked
	 * until `fn` returns.
	 */
	async withDocument<T>(path: string, fn: (doc: DocHandle) => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
		this.#assertAlive();
		const uri = pathToFileURL(path).href;
		let doc = this.#docs.get(uri);
		if (!doc) {
			doc = this.#newDoc(path, uri, false);
			this.#docs.set(uri, doc);
		}
		const release = await doc.lock.acquire(opts.signal);
		try {
			this.#assertAlive();
			let text: string;
			try {
				text = readFileSync(path, "utf8");
			} catch (err) {
				throw new LeanToolError(`cannot read ${path}: ${messageOf(err)}`);
			}
			await this.#sync(doc, text);
			doc.lastUsed = Date.now();
			this.#evict();
			return await fn(this.#handle(doc));
		} finally {
			doc.lastUsed = Date.now();
			release();
		}
	}

	/** Run `fn` against throwaway text that never reaches the disk. */
	async withScratch<T>(text: string, fn: (doc: DocHandle) => Promise<T>, opts: { signal?: AbortSignal } = {}): Promise<T> {
		this.#assertAlive();
		const releaseSlot = await this.#scratch.acquire(opts.signal);
		const slot = this.#freeSlots.shift() ?? 0;
		try {
			const path = join(this.root, `_PiLean4Scratch${slot}.lean`);
			const uri = pathToFileURL(path).href;
			let doc = this.#docs.get(uri);
			if (!doc) {
				doc = this.#newDoc(path, uri, true);
				this.#docs.set(uri, doc);
			}
			const release = await doc.lock.acquire(opts.signal);
			try {
				this.#assertAlive();
				await this.#sync(doc, text);
				return await fn(this.#handle(doc));
			} finally {
				release();
			}
		} finally {
			this.#freeSlots.push(slot);
			releaseSlot();
		}
	}

	/** `workspace/symbol`, bounded; never waits for the index to warm. */
	async workspaceSymbol(query: string, timeoutMs: number): Promise<SymbolInformation[]> {
		this.#assertAlive();
		const r = await this.#conn.request<SymbolInformation[] | null>("workspace/symbol", { query }, { timeoutMs });
		return r ?? [];
	}

	/** The text of any file, preferring the version open in the server. */
	textOf(path: string): string | null {
		const doc = this.#docs.get(pathToFileURL(path).href);
		if (doc?.open) return doc.text;
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	}

	/** Graceful LSP shutdown, then the process group. Idempotent. */
	stop(reason = "stopped"): Promise<void> {
		if (this.#stopping) return this.#stopping;
		this.#stopping = (async () => {
			if (!this.#proc.done && !this.#conn.closed) {
				await this.#conn.request("shutdown", null, { timeoutMs: 2000 }).catch(() => {});
				this.#conn.notify("exit", null);
				await Promise.race([this.#proc.exited, new Promise((r) => setTimeout(r, 2000).unref?.())]);
			}
			await killGroup(this.#proc, { graceMs: 1000 });
			this.#conn.close(reason);
		})();
		return this.#stopping;
	}

	// ── internals ─────────────────────────────────────────────────────

	#assertAlive(): void {
		if (this.#stopping) throw new LeanToolError("the Lean server is shutting down");
		if (this.#exitReason) throw new LeanToolError(this.#exitReason);
		if (this.#conn.closed) throw new LeanToolError(`the Lean server connection closed: ${this.#conn.closeReason}`);
	}

	#newDoc(path: string, uri: string, scratch: boolean): Doc {
		return {
			path,
			uri,
			scratch,
			open: false,
			version: 0,
			text: "",
			lines: [],
			hash: "",
			closure: null,
			diagnostics: [],
			diagnosticsVersion: -1,
			processing: [],
			fatal: false,
			outOfDate: null,
			reopenedFor: null,
			crashed: false,
			elaborated: false,
			revived: false,
			barriers: new Map(),
			lock: new Mutex(),
			lastUsed: Date.now(),
		};
	}

	#nextVersion(uri: string): number {
		const v = (this.#versions.get(uri) ?? 0) + 1;
		this.#versions.set(uri, v);
		return v;
	}

	#resetForVersion(doc: Doc, version: number): void {
		doc.version = version;
		doc.diagnostics = [];
		doc.diagnosticsVersion = -1;
		doc.processing = [];
		doc.fatal = false;
		doc.outOfDate = null;
		// Barriers for superseded versions are dropped; their requests settle into nothing.
		for (const v of [...doc.barriers.keys()]) if (v !== version) doc.barriers.delete(v);
	}

	#open(doc: Doc, text: string, mode: DependencyBuildMode): void {
		const version = this.#nextVersion(doc.uri);
		doc.text = text;
		doc.lines = splitLines(text);
		doc.hash = sha256(text);
		doc.open = true;
		doc.crashed = false;
		doc.elaborated = false;
		this.#resetForVersion(doc, version);
		this.#conn.notify("textDocument/didOpen", {
			textDocument: { uri: doc.uri, languageId: "lean4", version, text },
			dependencyBuildMode: mode,
		});
	}

	#close(doc: Doc): void {
		if (!doc.open) return;
		doc.open = false;
		doc.barriers.clear();
		this.#conn.notify("textDocument/didClose", { textDocument: { uri: doc.uri } });
	}

	/** Reopen so lake rebuilds this file's imports. Records the hash so it happens once. */
	#reopenOnce(doc: Doc): void {
		doc.reopenedFor = doc.hash;
		const text = doc.text;
		this.#close(doc);
		this.#open(doc, text, "once");
		if (!doc.scratch) doc.closure = this.#graph.closureFingerprint(text).fingerprint;
	}

	async #sync(doc: Doc, text: string): Promise<void> {
		const hash = sha256(text);
		doc.revived = false;
		// Lean says nothing when a file worker dies (killed, out of memory): every
		// later request about that file just hangs. Look for it before using it.
		if (doc.open && !doc.crashed && doc.elaborated && this.#workerAlive(doc) === false) {
			doc.crashed = true;
			doc.revived = true;
		}
		if (!doc.open || doc.crashed) {
			if (doc.open) this.#close(doc);
			// A file whose imports were already found stale for this exact text
			// goes straight to `once`: it would only fail the same way again.
			this.#open(doc, text, doc.reopenedFor === hash ? "once" : "never");
			if (!doc.scratch) doc.closure = this.#graph.closureFingerprint(text).fingerprint;
			return;
		}
		if (hash !== doc.hash) {
			const version = this.#nextVersion(doc.uri);
			doc.text = text;
			doc.lines = splitLines(text);
			doc.hash = hash;
			this.#resetForVersion(doc, version);
			this.#conn.notify("textDocument/didChange", {
				textDocument: { uri: doc.uri, version },
				contentChanges: [{ text }],
			});
			if (!doc.scratch) {
				this.#conn.notify("textDocument/didSave", { textDocument: { uri: doc.uri }, text });
			}
		}
		if (!doc.scratch) {
			const closure = this.#graph.closureFingerprint(text).fingerprint;
			if (closure !== doc.closure) {
				doc.closure = closure;
				// Something this file imports changed since it was elaborated:
				// rebuild those imports now, rather than answer from old .oleans.
				this.#reopenOnce(doc);
			}
		}
	}

	#handle(doc: Doc): DocHandle {
		const self = this;
		return {
			get path() {
				return doc.path;
			},
			get uri() {
				return doc.uri;
			},
			get scratch() {
				return doc.scratch;
			},
			get version() {
				return doc.version;
			},
			get text() {
				return doc.text;
			},
			get lines() {
				return doc.lines;
			},
			diagnostics: (o = {}) => self.#diagnostics(doc, o),
			request: <T>(method: string, params: unknown, o: RequestOptions = {}) => self.#docRequest<T>(doc, method, params, o),
			pos: (line: number, column?: number) => toLsp(doc.lines, line, column),
			point: (p: Position) => fromLsp(doc.lines, p),
			current: () => (doc.diagnosticsVersion === doc.version ? doc.diagnostics : []),
		};
	}

	#barrier(doc: Doc): Barrier {
		let b = doc.barriers.get(doc.version);
		if (b) return b;
		const version = doc.version;
		const barrier: Barrier = { promise: Promise.resolve(), settled: false, error: null };
		barrier.promise = this.#conn
			.request<unknown>(
				"textDocument/waitForDiagnostics",
				{ uri: doc.uri, version },
				{ timeoutMs: this.#opts.elaborationTimeoutMs },
			)
			.then(
				() => {
					barrier.settled = true;
					if (doc.version === version) doc.elaborated = true;
				},
				(err: Error) => {
					barrier.settled = true;
					barrier.error = err;
					// A failed barrier must not be cached: the next call asks again.
					if (doc.barriers.get(version) === barrier) doc.barriers.delete(version);
				},
			);
		doc.barriers.set(version, barrier);
		return barrier;
	}

	async #waitBarrier(doc: Doc, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
		const barrier = this.#barrier(doc);
		if (barrier.settled && !barrier.error) return true;
		let timer: NodeJS.Timeout | undefined;
		let onAbort: (() => void) | undefined;
		const watch = this.#watchWorker(doc);
		try {
			const outcome = await Promise.race([
				watch.promise,
				barrier.promise.then(() => "done" as const),
				new Promise<"timeout">((resolve) => {
					timer = setTimeout(() => resolve("timeout"), timeoutMs);
				}),
				new Promise<"aborted">((resolve) => {
					if (!signal) return;
					if (signal.aborted) return resolve("aborted");
					onAbort = () => resolve("aborted");
					signal.addEventListener("abort", onAbort, { once: true });
				}),
			]);
			if (outcome === "aborted") throw new AbortError();
			if (outcome === "timeout") return false;
			if (barrier.error) throw this.#translate(doc, barrier.error, "waitForDiagnostics");
			return true;
		} finally {
			watch.stop();
			if (timer) clearTimeout(timer);
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	/** Whether the worker for `doc` is running: true, false, or null when that cannot be told. */
	#workerAlive(doc: Doc): boolean | null {
		const kids = descendants(this.pid);
		if (kids.length === 0) return null;
		let path: string;
		try {
			path = decodeURIComponent(doc.uri);
		} catch {
			path = doc.uri;
		}
		for (const pid of kids) {
			const args = processArgs(pid);
			if (args?.includes("--worker") && (args.includes(doc.uri) || args.includes(path))) return true;
		}
		return false;
	}

	/**
	 * While waiting on a document, check its worker every two seconds; if it has
	 * died, fail now rather than at the request timeout. The returned promise
	 * only ever rejects, and is pre-caught so a stopped watch leaks nothing.
	 */
	#watchWorker(doc: Doc): { promise: Promise<never>; stop: () => void } {
		let timer: NodeJS.Timeout | undefined;
		let seen = doc.elaborated;
		const promise = new Promise<never>((_resolve, reject) => {
			timer = setInterval(() => {
				const alive = this.#workerAlive(doc);
				if (alive === true) seen = true;
				else if (alive === false && seen && doc.open) {
					clearInterval(timer);
					doc.crashed = true;
					reject(this.#crashError(doc, "elaboration"));
				}
			}, 2000);
			timer.unref?.();
		});
		promise.catch(() => {});
		return { promise, stop: () => clearInterval(timer) };
	}

	#crashError(doc: Doc, during: string): LeanToolError {
		return new LeanToolError(
			`the Lean worker for ${doc.scratch ? "a scratch document" : doc.path} crashed during ${during} ` +
				"(often memory or a deep recursion). It restarts on the next call; if it keeps crashing, " +
				"narrow what is elaborated (split the file, or check a smaller snippet with lean_attempt).",
		);
	}

	async #diagnostics(doc: Doc, o: { timeoutMs?: number; signal?: AbortSignal }): Promise<DiagReport> {
		const timeoutMs = o.timeoutMs ?? this.#opts.elaborationTimeoutMs;
		const started = Date.now();
		let reopened: string | undefined = doc.revived ? "its Lean worker had died, so the file was reopened" : undefined;
		let complete = await this.#waitBarrier(doc, timeoutMs, o.signal);
		if (complete && doc.outOfDate && doc.reopenedFor !== doc.hash) {
			reopened =
				doc.outOfDate === "must"
					? "its imports were out of date, so lake rebuilt them"
					: "an imported module changed, so lake rebuilt the imports and the file was re-elaborated";
			this.#reopenOnce(doc);
			complete = await this.#waitBarrier(doc, Math.max(1000, timeoutMs - (Date.now() - started)), o.signal);
		}
		return {
			version: doc.version,
			complete,
			items: doc.diagnosticsVersion === doc.version ? doc.diagnostics : [],
			processing: complete ? [] : doc.processing,
			fatal: doc.fatal,
			reopened,
		};
	}

	/** A request about `doc`, failing early if its worker dies while we wait. */
	async #watched<T>(doc: Doc, method: string, params: unknown, o: RequestOptions): Promise<T> {
		const req = this.#conn.request<T>(method, params, { timeoutMs: o.timeoutMs ?? this.#opts.requestTimeoutMs, signal: o.signal });
		req.catch(() => {});
		const watch = this.#watchWorker(doc);
		try {
			return await Promise.race([req, watch.promise]);
		} catch (err) {
			if (err instanceof LeanToolError) throw err;
			throw this.#translate(doc, err as Error, method);
		} finally {
			watch.stop();
		}
	}

	async #docRequest<T>(doc: Doc, method: string, params: unknown, o: RequestOptions): Promise<T> {
		let result = await this.#watched<T>(doc, method, params, o);
		// A file whose header failed answers every positional request with
		// nothing. If that is why, rebuild its imports and ask once more.
		if (doc.outOfDate === "must" && doc.reopenedFor !== doc.hash) {
			this.#reopenOnce(doc);
			await this.#waitBarrier(doc, this.#opts.elaborationTimeoutMs, o.signal);
			result = await this.#watched<T>(doc, method, params, o);
		}
		return result;
	}

	#translate(doc: Doc, err: Error, method: string): Error {
		if (err instanceof ResponseError && (WORKER_CRASHED.has(err.code) || /crashed/i.test(err.message))) {
			doc.crashed = true;
			return this.#crashError(doc, method);
		}
		if (err instanceof ConnectionClosed) return new LeanToolError(err.message);
		return err;
	}

	#onNotification(method: string, params: unknown): void {
		switch (method) {
			case "textDocument/publishDiagnostics": {
				const p = params as PublishDiagnosticsParams;
				const doc = this.#docs.get(p.uri);
				if (!doc || !doc.open) return;
				if (p.version !== undefined && p.version !== null && p.version !== doc.version) return;
				doc.diagnostics = p.diagnostics ?? [];
				doc.diagnosticsVersion = doc.version;
				let outOfDate: "must" | "should" | null = null;
				for (const d of doc.diagnostics) {
					const m = OUT_OF_DATE.exec(d.message);
					if (m) outOfDate = m[1] === "must" ? "must" : outOfDate ?? "should";
				}
				doc.outOfDate = outOfDate;
				return;
			}
			case "$/lean/fileProgress": {
				const p = params as FileProgressParams;
				const doc = this.#docs.get(p.textDocument.uri);
				if (!doc || !doc.open) return;
				if (p.textDocument.version !== undefined && p.textDocument.version !== doc.version) return;
				doc.processing = p.processing.map((x) => x.range);
				if (p.processing.some((x) => x.kind === 2)) doc.fatal = true;
				return;
			}
			case "$/lean/staleDependency": {
				// Not observed from the pinned toolchain (it tags dependents with an
				// out-of-date diagnostic instead), but documented; treat it the same.
				const p = params as StaleDependencyParams;
				for (const doc of this.#docs.values()) {
					if (doc.open && doc.uri !== p.staleDependency) doc.closure = null;
				}
				return;
			}
			case "window/logMessage":
				this.#log(`lean: ${(params as { message?: string })?.message ?? ""}`);
				return;
			default:
				return;
		}
	}

	/** Close least-recently-used real documents beyond the cap. Busy ones are never closed. */
	#evict(): void {
		const open = [...this.#docs.values()].filter((d) => d.open && !d.scratch);
		let excess = open.length - this.#opts.maxOpenFiles;
		if (excess <= 0) return;
		open.sort((a, b) => a.lastUsed - b.lastUsed);
		for (const doc of open) {
			if (excess <= 0) break;
			if (doc.lock.locked) continue;
			this.#close(doc);
			this.#docs.delete(doc.uri);
			excess--;
		}
	}
}
