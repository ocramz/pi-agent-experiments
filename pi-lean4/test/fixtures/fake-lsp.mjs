#!/usr/bin/env node
// A scripted stand-in for `lake serve`, for the unit tier.
//
// It speaks LSP with its own framing code (not src/lsp/framing.ts — a shared
// bug would cancel out), logs every message it receives to $FAKE_LSP_LOG as
// JSON lines, and behaves according to $FAKE_LSP_SCENARIO (JSON):
//
//   outOfDate      "must" | "should": the first open of each document with
//                  dependencyBuildMode "never" reports stale imports
//   ignoreShutdown answer nothing to `shutdown` and ignore `exit` and stdin EOF,
//                  so only signals can stop it
//   grandchild     spawn a process in its own process group that ignores EOF,
//                  as `lean --worker` runs in its own group; its pid is logged
//   crashOn        a request method that makes the fake exit with code 3
//   workerCrashOn  a request method answered with error -32902 (worker crashed)
//   barrierDelayMs delay before answering waitForDiagnostics
//   diagnostics    extra diagnostics published for every version
//
// The real server is covered by test/lean/; this exists so the client's
// bookkeeping (what is sent, when, how often) can be asserted exactly.

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const scenario = JSON.parse(process.env.FAKE_LSP_SCENARIO || "{}");
const logFile = process.env.FAKE_LSP_LOG;
const log = (entry) => {
	if (logFile) appendFileSync(logFile, JSON.stringify(entry) + "\n");
};

if (scenario.grandchild) {
	const g = spawn(process.execPath, ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"], {
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
	});
	log({ grandchild: g.pid });
}

if (scenario.ignoreShutdown) {
	process.on("SIGTERM", () => log({ ignored: "SIGTERM" }));
}

let buffer = Buffer.alloc(0);
const docs = new Map(); // uri → { version, text, opens }

function send(message) {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
	process.stdout.write(body);
}

function publish(uri, version, diagnostics) {
	send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, version, diagnostics } });
}

const range = (line) => ({ start: { line, character: 0 }, end: { line, character: 1 } });

function diagnosticsFor(doc, mode) {
	const out = [];
	if (scenario.outOfDate && mode === "never" && doc.opens === 1) {
		out.push({
			range: range(0),
			severity: scenario.outOfDate === "must" ? 1 : 3,
			message: `Imports are out of date and ${scenario.outOfDate} be rebuilt; use the "Restart File" command in your editor.`,
		});
	}
	const lines = doc.text.split("\n");
	lines.forEach((l, i) => {
		if (/\bsorry\b/.test(l)) out.push({ range: range(i), severity: 2, message: "declaration uses 'sorry'" });
		if (/\bboom\b/.test(l)) out.push({ range: range(i), severity: 1, message: "unknown identifier 'boom'" });
	});
	for (const d of scenario.diagnostics ?? []) out.push(d);
	return out;
}

function handle(m) {
	log(m);
	if (m.method && m.id !== undefined) {
		if (scenario.crashOn === m.method) process.exit(3);
		if (scenario.workerCrashOn === m.method) {
			send({ jsonrpc: "2.0", id: m.id, error: { code: -32902, message: "Server process for file crashed" } });
			return;
		}
		switch (m.method) {
			case "initialize":
				send({ jsonrpc: "2.0", id: m.id, result: { capabilities: { textDocumentSync: { change: 2 } }, serverInfo: { name: "fake" } } });
				send({ jsonrpc: "2.0", id: 9000, method: "client/registerCapability", params: { registrations: [] } });
				return;
			case "shutdown":
				if (!scenario.ignoreShutdown) send({ jsonrpc: "2.0", id: m.id, result: null });
				return;
			case "textDocument/waitForDiagnostics": {
				const answer = () => send({ jsonrpc: "2.0", id: m.id, result: {} });
				if (scenario.barrierDelayMs) setTimeout(answer, scenario.barrierDelayMs);
				else answer();
				return;
			}
			case "$/lean/plainGoal": {
				const doc = docs.get(m.params.textDocument.uri);
				const line = doc?.text.split("\n")[m.params.position.line] ?? "";
				send({ jsonrpc: "2.0", id: m.id, result: { goals: [`⊢ goal at ${m.params.position.line}:${m.params.position.character} ${line.trim()}`], rendered: "" } });
				return;
			}
			case "workspace/symbol":
				send({ jsonrpc: "2.0", id: m.id, result: [] });
				return;
			default:
				send({ jsonrpc: "2.0", id: m.id, result: null });
				return;
		}
	}
	switch (m.method) {
		case "exit":
			if (!scenario.ignoreShutdown) process.exit(0);
			return;
		case "textDocument/didOpen": {
			const { uri, version, text } = m.params.textDocument;
			const prev = docs.get(uri);
			const doc = { version, text, opens: (prev?.opens ?? 0) + 1 };
			docs.set(uri, doc);
			publish(uri, version, diagnosticsFor(doc, m.params.dependencyBuildMode));
			return;
		}
		case "textDocument/didChange": {
			const { uri, version } = m.params.textDocument;
			const doc = docs.get(uri);
			if (!doc) return;
			doc.version = version;
			doc.text = m.params.contentChanges[0].text;
			publish(uri, version, diagnosticsFor(doc, "change"));
			return;
		}
		default:
			return;
	}
}

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const end = buffer.indexOf("\r\n\r\n");
		if (end < 0) return;
		const header = buffer.subarray(0, end).toString("ascii");
		const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1]);
		if (buffer.length < end + 4 + length) return;
		const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
		buffer = buffer.subarray(end + 4 + length);
		handle(JSON.parse(body));
	}
});
process.stdin.on("end", () => {
	if (!scenario.ignoreShutdown) process.exit(0);
});
