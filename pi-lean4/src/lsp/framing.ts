/**
 * LSP base-protocol framing: `Content-Length: <bytes>\r\n\r\n<json>`.
 *
 * The length is in UTF-8 *bytes*. Lean source is full of ∀, ⊢, ℝ and 𝔽, so a
 * reader that counted characters would cut every goal containing one in half —
 * which is why this works on Buffers end to end and only decodes a body once it
 * is whole.
 */

const SEPARATOR = Buffer.from("\r\n\r\n", "ascii");
const HEADER = "content-length:";

export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/**
 * Accumulates chunks and emits whole messages.
 *
 * A chunk boundary can fall anywhere: inside a header, inside the separator,
 * inside a multi-byte character. Nothing is decoded until a complete body is
 * buffered. Junk before a header (a stray log line on stdout) is skipped up to
 * the next `Content-Length:` and reported once per occurrence, rather than
 * wedging the stream for good.
 */
export class MessageReader {
	#buffer: Buffer = Buffer.alloc(0);
	#onMessage: (message: unknown) => void;
	#onError: (err: Error) => void;

	constructor(onMessage: (message: unknown) => void, onError: (err: Error) => void) {
		this.#onMessage = onMessage;
		this.#onError = onError;
	}

	push(chunk: Buffer): void {
		this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
		for (;;) {
			const end = this.#buffer.indexOf(SEPARATOR);
			if (end < 0) {
				this.#resyncIfJunk();
				return;
			}
			const head = this.#buffer.subarray(0, end).toString("ascii");
			const length = contentLength(head);
			if (length === null) {
				// Not a header block. Drop through to the next plausible header.
				const next = indexOfHeader(this.#buffer, 1);
				this.#onError(new Error(`LSP framing: skipped non-header bytes: ${JSON.stringify(head.slice(0, 80))}`));
				this.#buffer = next < 0 ? Buffer.alloc(0) : this.#buffer.subarray(next);
				continue;
			}
			const start = end + SEPARATOR.length;
			if (this.#buffer.length < start + length) return;
			const body = this.#buffer.subarray(start, start + length).toString("utf8");
			this.#buffer = this.#buffer.subarray(start + length);
			let message: unknown;
			try {
				message = JSON.parse(body);
			} catch (err) {
				this.#onError(new Error(`LSP framing: malformed JSON body: ${(err as Error).message}`));
				continue;
			}
			this.#onMessage(message);
		}
	}

	/** No separator yet: if what is buffered cannot be the start of a header, drop it. */
	#resyncIfJunk(): void {
		if (this.#buffer.length === 0) return;
		const at = indexOfHeader(this.#buffer, 0);
		if (at === 0) return;
		if (at > 0) {
			this.#onError(new Error("LSP framing: skipped bytes before a header"));
			this.#buffer = this.#buffer.subarray(at);
			return;
		}
		// Keep a tail that could still be the start of "Content-Length:".
		const keep = Math.min(this.#buffer.length, HEADER.length - 1);
		const tail = this.#buffer.subarray(this.#buffer.length - keep).toString("latin1").toLowerCase();
		let partial = 0;
		for (let n = keep; n > 0; n--) {
			if (HEADER.startsWith(tail.slice(tail.length - n))) {
				partial = n;
				break;
			}
		}
		if (partial === this.#buffer.length) return;
		this.#onError(new Error("LSP framing: skipped bytes before a header"));
		this.#buffer = this.#buffer.subarray(this.#buffer.length - partial);
	}
}

function contentLength(head: string): number | null {
	for (const line of head.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) return null;
		if (line.slice(0, colon).trim().toLowerCase() === "content-length") {
			const n = Number(line.slice(colon + 1).trim());
			return Number.isInteger(n) && n >= 0 ? n : null;
		}
	}
	return null;
}

function indexOfHeader(buffer: Buffer, from: number): number {
	// Header names are case-insensitive; latin1 keeps byte offsets intact.
	return buffer.toString("latin1").toLowerCase().indexOf(HEADER, from);
}
