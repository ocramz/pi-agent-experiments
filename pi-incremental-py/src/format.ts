/**
 * Render kernel JSON responses as compact agent-facing text.
 *
 * Budget: a normal response is under ~10 lines. One line per executed
 * cell; cached cells collapse to a single count line (the agent already
 * knows their values); pending/failing/globals tails appear only when
 * non-empty.
 *
 * The same renderers run a second time from `context-filter.ts`, against
 * the structured copy of a response kept in a tool result's `details`, to
 * re-render an old message with everything the kernel has since recomputed
 * stripped out. That is what `RenderOptions` is for — one renderer in two
 * modes rather than two renderers, so the collapsed view cannot drift from
 * the format the model already learned.
 */

export interface CellResult {
	cell: string;
	/**
	 * `restored` is a value the kernel had computed before under this exact
	 * key and put back without executing anything. Unlike `cached` it is a
	 * claim the transcript may not already carry — the value was displaced
	 * and has returned — so it renders and supersedes like `ran`.
	 */
	status: "ran" | "cached" | "restored" | "error";
	seconds: number;
	value?: string | null;
	error?: string | null;
	output?: string;
	/** Reads something it also defines, so its successive values are a history. */
	stateful?: boolean;
}

export interface MutatingResponse {
	ok: boolean;
	error?: string;
	results?: CellResult[];
	pending?: string[];
	failing?: string[];
	globals?: Record<string, string>;
	id?: string;
	created?: string[];
	/**
	 * Which program these results belong to. A cell id names a different
	 * computation in each variant, so supersession has to be decided within
	 * one variant rather than across them.
	 */
	variant?: string;
}

/**
 * How much of a response is still worth showing.
 *
 * Must stay a pure function of its inputs: re-rendering an old message
 * changes the provider's cached prefix from that point on, so anything
 * that varies between calls (a clock, a live duration) would re-break the
 * cache on every request rather than once per supersession.
 */
export interface RenderOptions {
	/** Cells a later message has since re-run. Their values are stale. */
	superseded?: ReadonlySet<string>;
	/** Include the globals/pending/failing tails. False on all but the newest. */
	tails?: boolean;
}

/** What an older `inspect` becomes once a newer one has replaced it wholesale. */
export const SUPERSEDED_INSPECT = "- inspect (superseded)";

/**
 * How a cell is named for the purpose of deciding what supersedes what.
 *
 * A cell id means a different computation in each variant — that is the
 * whole reason variants exist — so `model` re-run in one variant says
 * nothing about `model` in another, and collapsing across them would
 * delete a value that is still current where it was produced. Both the
 * renderer and the filter have to agree on this, so neither builds the
 * string itself. `:` cannot occur in either half: variant names are
 * lowercase-and-dashes, cell ids are base32.
 */
export function scoped(variant: string | undefined, cell: string): string {
	return `${variant ?? ""}:${cell}`;
}

const MARK: Record<string, string> = { ran: "*", cached: "-", restored: "+", error: "!" };

/** Mirrors `kernel.variants.DEFAULT`: the variant a notebook starts on. */
const DEFAULT_VARIANT = "main";

export function formatResults(resp: MutatingResponse, opts: RenderOptions = {}): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines: string[] = [];
	// Which program these results belong to. Silent on the default, so a
	// notebook that never forks reads exactly as it did; the moment there
	// is more than one program, every result says which one it came from —
	// otherwise two values for one cell id are indistinguishable.
	if (resp.variant && resp.variant !== DEFAULT_VARIANT) lines.push(`variant: ${resp.variant}`);
	if (resp.id) lines.push(`id: ${resp.id}`);
	if (resp.created?.length) lines.push(`created: ${resp.created.join(", ")}`);

	let cached = 0;
	const superseded: string[] = [];
	for (const r of resp.results ?? []) {
		if (r.status === "cached") {
			cached++;
			continue;
		}
		// Two kinds of superseded result keep their line and lose only their
		// stdout. An *error* is a fact about an attempt rather than a snapshot
		// of state: unlike a value, it cannot be recovered by asking the kernel
		// again. A *stateful* cell's old values are the record of an accumulator
		// advancing, which is exactly what the agent asked for by writing one.
		const stale = opts.superseded?.has(scoped(resp.variant, r.cell)) ?? false;
		if (stale && (r.status === "ran" || r.status === "restored") && !r.stateful) {
			superseded.push(r.cell);
			continue;
		}
		const ms = (r.seconds * 1000).toFixed(1);
		const tail = r.status === "error" ? (r.error ?? "") : (r.value ?? "");
		lines.push(`${MARK[r.status]} ${r.cell} ${r.status} ${ms}ms${tail ? `  ${tail}` : ""}`);
		if (!stale && r.output?.trim()) lines.push(indent(r.output.trimEnd()));
	}
	if (cached) lines.push(`- ${cached} cell${cached === 1 ? "" : "s"} cached (unchanged)`);
	// One line for the whole batch: a run_all over a 20-cell notebook that has
	// since been re-run would otherwise leave 20 marker lines behind.
	if (superseded.length) lines.push(`- superseded: ${superseded.join(", ")}`);

	if (opts.tails ?? true) {
		if (resp.failing?.length) lines.push(`failing: ${resp.failing.join(", ")}`);
		if (resp.pending?.length) lines.push(`pending: ${resp.pending.join(", ")}`);
		const globals = Object.entries(resp.globals ?? {});
		if (globals.length) {
			lines.push(`globals: ${globals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
		}
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
	/** Globals the kernel cannot identify; their readers never cache. */
	opaque?: string[];
	variant?: string;
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
	if (resp.variant && resp.variant !== DEFAULT_VARIANT) lines.unshift(`variant: ${resp.variant}`);
	const globals = Object.entries(resp.globals ?? {});
	if (globals.length) {
		lines.push(`globals: ${globals.map(([k, v]) => `${k}=${v}`).join(", ")}`);
	}
	if (resp.failing?.length) lines.push(`failing: ${resp.failing.join(", ")}`);
	if (resp.pending?.length) lines.push(`pending: ${resp.pending.join(", ")}`);
	if (resp.opaque?.length) {
		lines.push(
			`opaque: ${resp.opaque.join(", ")} (cannot be identified; their readers re-run every time)`,
		);
	}
	return lines.join("\n");
}

export interface VariantsResponse {
	ok: boolean;
	error?: string;
	current?: string;
	variants?: { name: string; parent: string | null; cells: number; differs: string[] }[];
}

export function formatVariants(resp: VariantsResponse): string {
	if (!resp.ok) return `Error: ${resp.error ?? "unknown"}`;
	const lines = (resp.variants ?? []).map((v) => {
		const here = v.name === resp.current ? "* " : "  ";
		const from = v.parent ? ` <- ${v.parent}` : "";
		// Against the current variant, so the current one never lists itself.
		const differs = v.differs.length ? `  differs: ${v.differs.join(", ")}` : "";
		return `${here}${v.name}${from}  ${v.cells} cell${v.cells === 1 ? "" : "s"}${differs}`;
	});
	return lines.join("\n") || "(no variants)";
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
