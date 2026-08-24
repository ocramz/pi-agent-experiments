import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { GitRunner, TrackerPaths } from "./context.ts";
import { resolveRepoRoot } from "./git.ts";

/**
 * Where the tracker keeps its state.
 *
 * Every path is overridable, which is what makes the extension testable: a test
 * points `repoRoot` at a `mkdtemp` directory and nothing else has to change. In
 * the container the same lever handles read-only fixture mounts — copy the
 * seeded repo to /tmp and set PI_TRACKER_REPO_ROOT at it.
 */

export interface PathOverrides {
	repoRoot?: string;
	dbPath?: string;
	worktreeRoot?: string;
	manifestPath?: string;
}

/** Which model reviews stories. Both unset means self-review. */
export interface ReviewerOverrides {
	reviewProvider?: string;
	reviewModel?: string;
}

/** Everything the `tracker` key in `.pi/settings.json` may carry. */
export type TrackerSettings = PathOverrides & ReviewerOverrides;

/** Project-local `.pi/settings.json`, under a `tracker` key. Absent or malformed is fine. */
function readSettings(repoRoot: string): TrackerSettings {
	try {
		const raw = readFileSync(join(repoRoot, ".pi", "settings.json"), "utf-8");
		const parsed = JSON.parse(raw) as { tracker?: TrackerSettings };
		return parsed.tracker ?? {};
	} catch {
		return {};
	}
}

const absolute = (base: string, value: string) => (isAbsolute(value) ? value : resolve(base, value));

/**
 * Resolution order, first match wins per field:
 *   1. explicit overrides   (tests)
 *   2. environment          (containers, CI)
 *   3. .pi/settings.json    (per project)
 *   4. derived from the repo
 */
export async function resolvePaths(opts: {
	cwd: string;
	git: GitRunner;
	overrides?: PathOverrides;
	env?: NodeJS.ProcessEnv;
}): Promise<TrackerPaths> {
	const { cwd, git, overrides = {}, env = process.env } = opts;

	// The common git dir, not the current directory: called from inside a linked
	// worktree this still resolves to the main working tree, so every worktree
	// shares one stories.db instead of opening an empty one of its own.
	const repoRoot =
		overrides.repoRoot ??
		env.PI_TRACKER_REPO_ROOT ??
		(await resolveRepoRoot(git, cwd)) ??
		cwd;

	const settings = readSettings(repoRoot);

	const dbPath =
		overrides.dbPath ??
		env.PI_TRACKER_DB ??
		(settings.dbPath && absolute(repoRoot, settings.dbPath)) ??
		join(repoRoot, ".pi", "stories.db");

	// Outside the repo on purpose: a worktree under <repo>/ makes every rg, tsc
	// and test glob descend into a second full copy of the tree.
	const worktreeRoot =
		overrides.worktreeRoot ??
		env.PI_TRACKER_WORKTREE_ROOT ??
		(settings.worktreeRoot && absolute(repoRoot, settings.worktreeRoot)) ??
		join(dirname(repoRoot), ".pi-worktrees", basename(repoRoot));

	const manifestPath =
		overrides.manifestPath ??
		env.PI_TRACKER_MANIFEST ??
		(settings.manifestPath && absolute(repoRoot, settings.manifestPath)) ??
		join(repoRoot, ".pi", "epic.json");

	return { repoRoot, dbPath, worktreeRoot, manifestPath };
}

/** Which model to review with. Null when none is configured — the self-review default. */
export interface ReviewerChoice {
	provider: string;
	modelId: string;
}

/**
 * Resolve the reviewer model, same precedence as `resolvePaths`:
 *   1. explicit overrides   (tests)
 *   2. environment          (containers, CI)
 *   3. .pi/settings.json    (per project)
 *
 * Synchronous, unlike `resolvePaths`, because nothing here needs git.
 *
 * Both halves are required together. A provider with no model (or the reverse)
 * is a half-finished configuration, and silently falling back to self-review
 * would hide it — `describeReviewerConfig` reports that case so `session_start`
 * can say so out loud.
 */
export function resolveReviewer(opts: {
	repoRoot: string;
	overrides?: ReviewerOverrides;
	env?: NodeJS.ProcessEnv;
}): ReviewerChoice | null {
	const { provider, modelId } = readReviewerFields(opts);
	if (!provider || !modelId) return null;
	return { provider, modelId };
}

/** Why there is no reviewer, when the configuration looks like there should be one. */
export function describeReviewerConfig(opts: {
	repoRoot: string;
	overrides?: ReviewerOverrides;
	env?: NodeJS.ProcessEnv;
}): { ok: true } | { ok: false; reason: string } {
	const { provider, modelId } = readReviewerFields(opts);
	if (provider && modelId) return { ok: true };
	if (!provider && !modelId) return { ok: true };
	const missing = provider ? "reviewModel / PI_TRACKER_REVIEW_MODEL" : "reviewProvider / PI_TRACKER_REVIEW_PROVIDER";
	return { ok: false, reason: `${missing} is not set — a reviewer needs both a provider and a model` };
}

function readReviewerFields(opts: {
	repoRoot: string;
	overrides?: ReviewerOverrides;
	env?: NodeJS.ProcessEnv;
}): { provider: string | undefined; modelId: string | undefined } {
	const { repoRoot, overrides = {}, env = process.env } = opts;
	const settings = readSettings(repoRoot);
	const blank = (value: string | undefined) => (value && value.trim() ? value.trim() : undefined);
	return {
		provider: blank(overrides.reviewProvider) ?? blank(env.PI_TRACKER_REVIEW_PROVIDER) ?? blank(settings.reviewProvider),
		modelId: blank(overrides.reviewModel) ?? blank(env.PI_TRACKER_REVIEW_MODEL) ?? blank(settings.reviewModel),
	};
}

/** The declared setup manifest. Every field is optional; a missing file is an empty manifest. */
export interface EpicManifest {
	/** Run once per epic, re-run when this string changes. */
	setup?: string;
	/** Checked before a story is committed. */
	verify?: string;
	/** Recorded against the epic so environment drift is detectable. */
	versions?: string;
	/** Worktree mode: gitignored files to carry over. */
	copy?: string[];
	/** Env vars pointed at a shared cache dir before setup runs. */
	caches?: string[];
}

export function readManifest(manifestPath: string): EpicManifest {
	try {
		return JSON.parse(readFileSync(manifestPath, "utf-8")) as EpicManifest;
	} catch {
		return {};
	}
}
