// The LSP plumbing on its own: framing, the JSON-RPC connection, positions.
// No process, no Lean — in-memory streams stand in for the server's pipes.

import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { ConnectionClosed, LspConnection, RequestTimeout, ResponseError } from "../src/lsp/connection.ts";
import { MessageReader, encodeMessage } from "../src/lsp/framing.ts";
import { codepointIndex, fromLsp, splitLines, toLsp, utf16Offset } from "../src/lsp/positions.ts";

const SAMPLE = { jsonrpc: "2.0", method: "x", params: { goal: "∀ x : 𝔽, x ⊢ 😀 ℝ" } };

function readAll(chunks: Buffer[]): { messages: unknown[]; errors: string[] } {
	const messages: unknown[] = [];
	const errors: string[] = [];
	const r = new MessageReader(
		(m) => messages.push(m),
		(e) => errors.push(e.message),
	);
	for (const c of chunks) r.push(c);
	return { messages, errors };
}

test("F1: Content-Length counts UTF-8 bytes, not characters", () => {
	const buf = encodeMessage(SAMPLE);
	const header = buf.toString("ascii", 0, buf.indexOf("\r\n\r\n"));
	const declared = Number(header.split(": ")[1]);
	const body = Buffer.from(JSON.stringify(SAMPLE), "utf8");
	assert.equal(declared, body.length);
	assert.notEqual(declared, JSON.stringify(SAMPLE).length, "the sample must contain multi-byte characters");
});

test("F2: a message split at every byte boundary decodes intact", () => {
	const buf = encodeMessage(SAMPLE);
	for (let cut = 1; cut < buf.length; cut++) {
		const { messages, errors } = readAll([buf.subarray(0, cut), buf.subarray(cut)]);
		assert.deepEqual(messages, [SAMPLE], `split at ${cut}`);
		assert.deepEqual(errors, []);
	}
});

test("F3: several messages in one chunk, and one message byte by byte", () => {
	const a = encodeMessage({ id: 1 });
	const b = encodeMessage({ id: 2, result: "⊢" });
	assert.deepEqual(readAll([Buffer.concat([a, b, a])]).messages, [{ id: 1 }, { id: 2, result: "⊢" }, { id: 1 }]);
	const bytes = [...b].map((x) => Buffer.from([x]));
	assert.deepEqual(readAll(bytes).messages, [{ id: 2, result: "⊢" }]);
});

test("F4: extra headers and header-name case are tolerated", () => {
	const body = Buffer.from(JSON.stringify({ id: 7 }));
	const msg = Buffer.concat([
		Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: ${body.length}\r\n\r\n`),
		body,
	]);
	assert.deepEqual(readAll([msg]).messages, [{ id: 7 }]);
});

test("F5: junk before a header is skipped and reported, not fatal", () => {
	const { messages, errors } = readAll([Buffer.from("warning: something on stdout\n"), encodeMessage({ id: 3 })]);
	assert.deepEqual(messages, [{ id: 3 }]);
	assert.ok(errors.length >= 1);
	const bad = Buffer.concat([Buffer.from("Content-Length: 5\r\n\r\n{nope"), encodeMessage({ id: 4 })]);
	const r = readAll([bad]);
	assert.deepEqual(r.messages, [{ id: 4 }]);
	assert.match(r.errors.join(), /malformed JSON/);
});

/** A connection whose "server" is the test: `server.read()` sees what the client sent. */
function pair(opts: { timeoutMs?: number; onRequest?: (m: string, p: unknown) => unknown } = {}) {
	const toServer = new PassThrough();
	const toClient = new PassThrough();
	const notifications: [string, unknown][] = [];
	const conn = new LspConnection({
		input: toClient,
		output: toServer,
		onNotification: (m, p) => notifications.push([m, p]),
		onRequest: opts.onRequest,
		defaultTimeoutMs: opts.timeoutMs ?? 5000,
	});
	const sent: any[] = [];
	const waiters: (() => void)[] = [];
	const reader = new MessageReader(
		(m) => {
			sent.push(m);
			for (const w of waiters.splice(0)) w();
		},
		() => {},
	);
	toServer.on("data", (c: Buffer) => reader.push(c));
	return {
		conn,
		notifications,
		sent,
		reply: (m: unknown) => toClient.write(encodeMessage(m)),
		async next(pred: (m: any) => boolean): Promise<any> {
			for (;;) {
				const hit = sent.find(pred);
				if (hit) return hit;
				await new Promise<void>((r) => waiters.push(r));
			}
		},
		end: () => toClient.end(),
	};
}

test("C1: responses are matched by id, in any order", async () => {
	const p = pair();
	const a = p.conn.request("a", {});
	const b = p.conn.request("b", {});
	const ra = await p.next((m) => m.method === "a");
	const rb = await p.next((m) => m.method === "b");
	p.reply({ jsonrpc: "2.0", id: rb.id, result: "B" });
	p.reply({ jsonrpc: "2.0", id: ra.id, result: "A" });
	assert.deepEqual(await Promise.all([a, b]), ["A", "B"]);
	assert.equal(p.conn.pendingCount, 0);
});

test("C2: a timeout rejects, sends $/cancelRequest, and drops the late answer", async () => {
	const p = pair({ timeoutMs: 50 });
	const r = p.conn.request("slow", {});
	const req = await p.next((m) => m.method === "slow");
	await assert.rejects(r, RequestTimeout);
	const cancel = await p.next((m) => m.method === "$/cancelRequest");
	assert.deepEqual(cancel.params, { id: req.id });
	p.reply({ jsonrpc: "2.0", id: req.id, result: "late" });
	assert.equal(p.conn.pendingCount, 0);
});

test("C3: an abort rejects with AbortError and cancels", async () => {
	const p = pair();
	const ac = new AbortController();
	const r = p.conn.request("x", {}, { signal: ac.signal });
	const req = await p.next((m) => m.method === "x");
	ac.abort();
	await assert.rejects(r, (e: Error) => e.name === "AbortError");
	const cancel = await p.next((m) => m.method === "$/cancelRequest");
	assert.equal(cancel.params.id, req.id);
	await assert.rejects(p.conn.request("y", {}, { signal: ac.signal }), (e: Error) => e.name === "AbortError");
});

test("C4: the server's own requests are answered", async () => {
	const p = pair({ onRequest: (m) => (m === "custom/thing" ? { ok: true } : undefined) });
	p.reply({ jsonrpc: "2.0", id: 100, method: "client/registerCapability", params: { registrations: [] } });
	p.reply({ jsonrpc: "2.0", id: 101, method: "workspace/configuration", params: { items: [{}, {}] } });
	p.reply({ jsonrpc: "2.0", id: 102, method: "custom/thing", params: {} });
	p.reply({ jsonrpc: "2.0", id: 103, method: "unknown/method", params: {} });
	assert.deepEqual((await p.next((m) => m.id === 100 && "result" in m)).result, null);
	assert.deepEqual((await p.next((m) => m.id === 101 && "result" in m)).result, [null, null]);
	assert.deepEqual((await p.next((m) => m.id === 102 && "result" in m)).result, { ok: true });
	assert.equal((await p.next((m) => m.id === 103 && "error" in m)).error.code, -32601);
});

test("C5: notifications reach the handler; a response error carries its code", async () => {
	const p = pair();
	p.reply({ jsonrpc: "2.0", method: "$/lean/fileProgress", params: { processing: [] } });
	const r = p.conn.request("boom", {});
	const req = await p.next((m) => m.method === "boom");
	p.reply({ jsonrpc: "2.0", id: req.id, error: { code: -32902, message: "worker crashed" } });
	await assert.rejects(r, (e: Error) => e instanceof ResponseError && e.code === -32902);
	assert.deepEqual(p.notifications, [["$/lean/fileProgress", { processing: [] }]]);
});

test("C6: the stream ending rejects everything pending, and later requests", async () => {
	const p = pair();
	const reasons: string[] = [];
	p.conn.onClose((r) => reasons.push(r));
	const r = p.conn.request("x", {});
	await p.next((m) => m.method === "x");
	p.end();
	await assert.rejects(r, ConnectionClosed);
	await assert.rejects(p.conn.request("y", {}), ConnectionClosed);
	assert.equal(reasons.length, 1);
	assert.ok(p.conn.closed);
});

test("P1: positions are codepoints for the model and UTF-16 for the server", () => {
	const line = "theorem t (x : 𝔽) : x = x := by rfl";
	const col = [...line].indexOf("=") + 1;
	const pos = toLsp([line], 1, col);
	assert.equal(pos.line, 0);
	assert.equal(pos.character, line.indexOf("="), "𝔽 is two UTF-16 units");
	assert.deepEqual(fromLsp([line], pos), { line: 1, column: col });
});

test("P2: BMP-only text maps identically; emoji round-trip", () => {
	const line = "∀ x, x ⊢ y";
	for (let i = 0; i <= [...line].length; i++) assert.equal(utf16Offset(line, i), i);
	const e = "a😀b😀c";
	for (let i = 0; i <= [...e].length; i++) assert.equal(codepointIndex(e, utf16Offset(e, i)), i);
});

test("P3: past the end of a line clamps; outside the file throws", () => {
	const lines = splitLines("ab\ncd");
	assert.deepEqual(toLsp(lines, 1, 99), { line: 0, character: 2 });
	assert.throws(() => toLsp(lines, 3, 1), /out of range \(the file has 2 lines\)/);
	assert.throws(() => toLsp(lines, 0, 1), /out of range/);
	assert.throws(() => toLsp(lines, 1, 0), /columns start at 1/);
});

test("P4: a trailing \\r stays part of its line", () => {
	const lines = splitLines("ab\r\ncd");
	assert.equal(lines[0], "ab\r");
	assert.deepEqual(toLsp(lines, 1, 3), { line: 0, character: 2 });
});
