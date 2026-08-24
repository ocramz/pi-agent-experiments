/**
 * Render kernel JSON responses as compact agent-facing text.
 *
 * Budget: a normal response is under ~10 lines. One line per executed
 * cell; cached cells collapse to a single count line (the agent already
 * knows their values); pending/failing/globals tails appear only when
 * non-empty.
 */

export interface CellResult {
	cell: string;
	status: "ran" | "cached" | "error";
	seconds: number;
	value?: string | null;
	error?: string | null;
	output?: string;
}

interface MutatingResponse {
	ok: boolean;
	error?: string;
	results?: CellResult[];
	pending?: string[];
	failing?: string[];
	globals?: Record<string, string>;
	id?: string;
	created?: string[];
}

const MARK: Record<string, string> = { ran: "*", cached: "-", error: "!" };

export function formatResults(resp: MutatingResponse): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines: string[] = [];
	if (resp.id) lines.push(`id: ${resp.id}`);
	if (resp.created?.length) lines.push(`created: ${resp.created.join(", ")}`);

	let cached = 0;
	for (const r of resp.results ?? []) {
		if (r.status === "cached") {
			cached++;
			continue;
		}
		const ms = (r.seconds * 1000).toFixed(1);
		const tail = r.status === "error" ? (r.error ?? "") : (r.value ?? "");
		lines.push(`${MARK[r.status]} ${r.cell} ${r.status} ${ms}ms${tail ? `  ${tail}` : ""}`);
		if (r.output?.trim()) lines.push(indent(r.output.trimEnd()));
	}
	if (cached) lines.push(`- ${cached} cell${cached === 1 ? "" : "s"} cached (unchanged)`);

	if (resp.failing?.length) lines.push(`failing: ${resp.failing.join(", ")}`);
	if (resp.pending?.length) lines.push(`pending: ${resp.pending.join(", ")}`);
	const globals = Object.entries(resp.globals ?? {});
	if (globals.length) {
		lines.push(`globals: ${globals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	}
	return lines.join("\n") || "ok (nothing to run)";
}

export interface InspectResponse {
	ok: boolean;
	error?: string;
	cells?: {
		id: string;
		name: string | null;
		defines: string[];
		depends_on: string[];
		stateful: boolean;
		failing: boolean;
	}[];
	globals?: Record<string, string>;
	pending?: string[];
	failing?: string[];
}

export function formatInspect(resp: InspectResponse): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines: string[] = [];
	for (const c of resp.cells ?? []) {
		const label = c.name ? `${c.id} (${c.name})` : c.id;
		const flags = [c.stateful ? "stateful" : "", c.failing ? "FAILING" : ""]
			.filter(Boolean)
			.join(" ");
		const deps = c.depends_on.length ? ` <- ${c.depends_on.join(", ")}` : "";
		lines.push(
			`${label}: defines [${c.defines.join(", ")}]${deps}${flags ? `  ${flags}` : ""}`,
		);
	}
	if (!lines.length) lines.push("(no cells)");
	else lines.unshift(`${resp.cells!.length} cell${resp.cells!.length === 1 ? "" : "s"}:`);
	const globals = Object.entries(resp.globals ?? {});
	if (globals.length) {
		lines.push(`globals: ${globals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	}
	if (resp.failing?.length) lines.push(`failing: ${resp.failing.join(", ")}`);
	if (resp.pending?.length) lines.push(`pending: ${resp.pending.join(", ")}`);
	return lines.join("\n");
}

export function formatEval(resp: {
	ok: boolean;
	value?: string | null;
	error?: string;
	output?: string;
}): string {
	const lines: string[] = [];
	if (resp.ok) lines.push(resp.value ?? "None");
	else lines.push(`Error: ${resp.error ?? "unknown"}`);
	if (resp.output?.trim()) lines.push(indent(resp.output.trimEnd()));
	return lines.join("\n");
}

function indent(text: string): string {
	return text
		.split("\n")
		.map((l) => `  | ${l}`)
		.join("\n");
}
