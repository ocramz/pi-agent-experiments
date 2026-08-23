// Build a throwaway repository in a known state for one interactive case.
//
// Fixtures are built by calling src/ directly — startEpic, commitStory,
// mergeIntoBase — rather than by scripting git in the shell. That costs a little
// indirection and buys the guarantee that a fixture cannot drift from the code
// path it is meant to set up: if startEpic changes what it records, the fixture
// changes with it.
//
// Git config is redirected into the fixture directory exactly as
// test/helpers/repo.ts does, so nothing here depends on the developer's
// ~/.gitconfig — a global commit.gpgsign or init.defaultBranch would otherwise
// make results vary by machine.
//
// Each shape returns its facts — real story ids, branch names, shas — because
// the ids a case needs are only known once the fixture exists.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { resolvePaths } from "../../src/config.ts";
import type { GitResult, TrackerContext } from "../../src/context.ts";
import { createStory, getEpicBranch, getStoryById, openDb, setAppState } from "../../src/database.ts";
import {
	commitStory,
	mergeIntoBase,
	recordStoryStartCommit,
	startEpic,
} from "../../src/epic.ts";
import { createLocalGitRunner, createLocalShellRunner } from "../../src/git.ts";
import { keywordStrategy } from "../../src/related.ts";
import type { Story } from "../../src/types.ts";

export interface Facts {
	shape: string;
	dir: string;
	branch: string | null;
	baseBranch?: string;
	epicId?: number;
	firstId?: number;
	secondId?: number;
	looseId?: number;
	/** A second epic — a parent with children — that is *not* the active one. */
	otherEpicId?: number;
	/** Where a worktree epic's checkout lives. Absolute, as git resolved it. */
	worktreePath?: string;
	dirtyFile?: string;
	conflictFile?: string;
	storyCommit?: string;
	secondCommit?: string;
	backupRef?: string;
	baseTip?: string;
}

export type Shape =
	| "empty"
	| "stories"
	| "storiesWithTop"
	| "dirty"
	| "onMain"
	| "detached"
	| "notRepo"
	| "epicActive"
	| "epicWorktreeActive"
	| "epicWorktreeOneCommit"
	| "twoEpicsOneActive"
	| "epicOneCommit"
	| "epicTwoCommits"
	| "epicBaseMoved"
	| "epicConflict"
	| "epicMerged";

/** The environment a fixture's git commands run under. Also what pi inherits. */
export function fixtureEnv(dir: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: dir,
		GIT_CONFIG_GLOBAL: join(dir, ".gitconfig"),
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_AUTHOR_NAME: "Interactive Test",
		GIT_AUTHOR_EMAIL: "interactive@example.invalid",
		GIT_COMMITTER_NAME: "Interactive Test",
		GIT_COMMITTER_EMAIL: "interactive@example.invalid",
	};
}

export async function buildFixture(shape: Shape, dir: string): Promise<Facts> {
	const build = shapes[shape];
	if (!build) throw new Error(`unknown fixture shape "${shape}"`);
	const env = fixtureEnv(dir);
	const git = createLocalGitRunner({ cwd: dir, env });
	const shell = createLocalShellRunner({ cwd: dir, env });

	const must = async (args: string[]): Promise<GitResult> => {
		const result = await git(args);
		if (result.code !== 0) {
			throw new Error(`git ${args.join(" ")} failed (${result.code}): ${result.stderr || result.stdout}`);
		}
		return result;
	};

	const write = (name: string, contents: string): void => {
		writeFileSync(join(dir, name), contents);
	};

	const commit = async (message: string): Promise<string> => {
		await must(["add", "-A"]);
		await must(["commit", "--quiet", "-m", message]);
		return (await must(["rev-parse", "HEAD"])).stdout.trim();
	};

	/** A repo with one commit on `main`, then switched to `branch`. */
	const initRepo = async ({ branch = "feat/work" }: { branch?: string } = {}): Promise<void> => {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		await must(["init", "--quiet", "-b", "main", "."]);
		// Write the identity into the fixture's own gitconfig, not just into this
		// process's environment. The pi session that follows inherits
		// GIT_CONFIG_GLOBAL but not these variables, and any commit the extension
		// makes there would otherwise die with "Please tell me who you are".
		await must(["config", "--global", "user.name", "Interactive Test"]);
		await must(["config", "--global", "user.email", "interactive@example.invalid"]);
		write("README.md", "# fixture\n");
		await commit("initial");
		if (branch !== "main") await must(["switch", "--quiet", "-c", branch]);
	};

	const tracker = async (): Promise<{ db: DatabaseSync; ctx: TrackerContext }> => {
		const paths = await resolvePaths({ cwd: dir, git, overrides: { repoRoot: dir }, env: {} });
		const db = openDb(paths.dbPath);
		return {
			db,
			ctx: { paths, db, git, shell, related: keywordStrategy, now: () => Date.now(), notify: () => {} },
		};
	};

	let priority = 0;
	const story = (db: DatabaseSync, title: string, subGoal: string, parentId: number | null = null): Story =>
		createStory(db, {
			title,
			sub_goal: subGoal,
			proposed_changes: "",
			status: "draft",
			priority: ++priority,
			parent_id: parentId,
			next_id: null,
			depends_on: [],
		});

	/** One epic parent with two children, plus an unrelated standalone story. */
	const seedStories = (db: DatabaseSync) => {
		const epic = story(db, "Ship the widget", "the whole widget feature");
		const first = story(db, "Add the widget model", "data layer", epic.id);
		const second = story(db, "Render the widget", "ui layer", epic.id);
		const loose = story(db, "Fix the typo in the readme", "unrelated small fix");
		return { epic, first, second, loose };
	};

	const tools = { dir, must, write, commit, initRepo, tracker, seedStories };
	return { shape, dir, ...(await build(tools)) };
}

interface Tools {
	dir: string;
	must(args: string[]): Promise<GitResult>;
	write(name: string, contents: string): void;
	commit(message: string): Promise<string>;
	initRepo(opts?: { branch?: string }): Promise<void>;
	tracker(): Promise<{ db: DatabaseSync; ctx: TrackerContext }>;
	seedStories(db: DatabaseSync): { epic: Story; first: Story; second: Story; loose: Story };
}

type ShapeBuilder = (tools: Tools) => Promise<Omit<Facts, "shape" | "dir">>;

const shapes: Record<Shape, ShapeBuilder> = {
	/** Repo on a working branch, tracker database created, no stories. */
	async empty({ initRepo, tracker }) {
		await initRepo();
		const { db } = await tracker();
		db.close();
		return { branch: "feat/work" };
	},

	/** Stories but no epic: the board, /top-story, /export-stories. */
	async stories({ initRepo, tracker, seedStories }) {
		await initRepo();
		const { db } = await tracker();
		const seeded = seedStories(db);
		db.close();
		return {
			branch: "feat/work",
			epicId: seeded.epic.id,
			firstId: seeded.first.id,
			secondId: seeded.second.id,
			looseId: seeded.loose.id,
		};
	},

	/** Same, plus a top-level story already set. */
	async storiesWithTop({ initRepo, tracker, seedStories }) {
		await initRepo();
		const { db } = await tracker();
		const seeded = seedStories(db);
		setAppState(db, "top_level_story_id", String(seeded.epic.id));
		db.close();
		return { branch: "feat/work", epicId: seeded.epic.id };
	},

	/** Stories, and the working tree is dirty — the carry-changes prompt. */
	async dirty({ initRepo, tracker, seedStories, write }) {
		await initRepo();
		const { db } = await tracker();
		const seeded = seedStories(db);
		db.close();
		write("scratch.txt", "uncommitted work\n");
		return { branch: "feat/work", epicId: seeded.epic.id, dirtyFile: "scratch.txt" };
	},

	/** Sitting on a protected branch. */
	async onMain({ initRepo, tracker, seedStories }) {
		await initRepo({ branch: "main" });
		const { db } = await tracker();
		const seeded = seedStories(db);
		db.close();
		return { branch: "main", epicId: seeded.epic.id };
	},

	/** Detached HEAD. */
	async detached({ initRepo, tracker, seedStories, must }) {
		await initRepo();
		const { db } = await tracker();
		const seeded = seedStories(db);
		db.close();
		const head = (await must(["rev-parse", "HEAD"])).stdout.trim();
		await must(["checkout", "--quiet", head]);
		return { branch: null, epicId: seeded.epic.id };
	},

	/** A directory that is not a repository at all. */
	async notRepo({ dir, write }) {
		rmSync(dir, { recursive: true, force: true });
		mkdirSync(dir, { recursive: true });
		write("README.md", "# not a repo\n");
		return { branch: null };
	},

	/** An epic running on its own branch, nothing committed to it yet. */
	async epicActive({ initRepo, tracker, seedStories }) {
		await initRepo();
		const { db, ctx } = await tracker();
		const seeded = seedStories(db);
		const started = await startEpic(ctx, { story: seeded.epic });
		if (!started.ok || !started.epic) throw new Error(`startEpic failed: ${started.note}`);
		await recordStoryStartCommit(ctx, seeded.first, started.epic);
		db.close();
		return {
			branch: started.epic.branch,
			baseBranch: started.epic.base_branch,
			epicId: seeded.epic.id,
			firstId: seeded.first.id,
			secondId: seeded.second.id,
			looseId: seeded.loose.id,
		};
	},

	/**
	 * An epic running in a worktree of its own, nothing committed to it yet.
	 *
	 * The main checkout stays on the base branch, which is the difference that
	 * matters: a session started here is *not* in the epic, and has to resolve
	 * that from its own directory.
	 */
	async epicWorktreeActive({ initRepo, tracker, seedStories }) {
		await initRepo();
		const { db, ctx } = await tracker();
		const seeded = seedStories(db);
		const started = await startEpic(ctx, { story: seeded.epic, mode: "worktree" });
		if (!started.ok || !started.epic) throw new Error(`startEpic failed: ${started.note}`);
		await recordStoryStartCommit(ctx, seeded.first, started.epic);
		db.close();
		return {
			branch: started.epic.base_branch,
			baseBranch: started.epic.base_branch,
			worktreePath: started.epic.path ?? undefined,
			epicId: seeded.epic.id,
			firstId: seeded.first.id,
			secondId: seeded.second.id,
			looseId: seeded.loose.id,
		};
	},

	/** A worktree epic with one story committed — ready to merge. */
	async epicWorktreeOneCommit(tools) {
		const facts = await shapes.epicWorktreeActive(tools);
		const { db, ctx } = await tools.tracker();
		const epic = getEpicBranch(db, facts.epicId!);
		if (!epic?.path) throw new Error("the worktree fixture recorded no path");

		writeFileSync(join(epic.path, "widget.ts"), "export const widget = true;\n");
		const first = getStoryById(db, facts.firstId!);
		if (!first) throw new Error("the fixture's first story vanished");
		const committed = await commitStory(ctx, first, epic);
		if (!committed.ok) throw new Error(`commitStory failed: ${committed.note}`);
		db.close();
		return { ...facts, storyCommit: committed.sha };
	},

	/**
	 * One epic running, and a *second* epic available to try to start.
	 *
	 * The obvious fixture — `epicActive`, then `/start-epic` on one of the active
	 * epic's own children — does not reach the active-epic refusal at all:
	 * `checkCanStartEpic` tests `childCount` before `activeEpicId`, so a childless
	 * story is turned away as "a unit of work" first. Reaching the refusal needs a
	 * story that is a genuine epic and is not the one already running.
	 */
	async twoEpicsOneActive(tools) {
		const facts = await shapes.epicActive(tools);
		const { db } = await tools.tracker();
		const other = createStory(db, {
			title: "Ship the gadget",
			sub_goal: "a second feature entirely",
			proposed_changes: "",
			status: "draft",
			priority: 10,
			parent_id: null,
			next_id: null,
			depends_on: [],
		});
		createStory(db, {
			title: "Add the gadget model",
			sub_goal: "so the second epic has a child",
			proposed_changes: "",
			status: "draft",
			priority: 11,
			parent_id: other.id,
			next_id: null,
			depends_on: [],
		});
		db.close();
		return { ...facts, otherEpicId: other.id };
	},

	/** An epic with one story committed — /undo-story at the tip. */
	async epicOneCommit(tools) {
		const facts = await shapes.epicActive(tools);
		const { db, ctx } = await tools.tracker();
		const epic = getEpicBranch(db, facts.epicId!)!;
		const first = { id: facts.firstId!, title: "Add the widget model" } as Story;
		tools.write("model.ts", "export const widget = {};\n");
		const committed = await commitStory(ctx, first, epic);
		if (!committed.ok) throw new Error(`commitStory failed: ${committed.note}`);
		db.close();
		return { ...facts, storyCommit: committed.sha };
	},

	/** Two stories committed — /undo-story off the tip takes the revert path. */
	async epicTwoCommits(tools) {
		const facts = await shapes.epicOneCommit(tools);
		const { db, ctx } = await tools.tracker();
		const epic = getEpicBranch(db, facts.epicId!)!;
		const second = { id: facts.secondId!, title: "Render the widget" } as Story;
		await recordStoryStartCommit(ctx, second, epic);
		tools.write("view.ts", "export const view = {};\n");
		const committed = await commitStory(ctx, second, epic);
		if (!committed.ok) throw new Error(`commitStory failed: ${committed.note}`);
		db.close();
		return { ...facts, secondCommit: committed.sha };
	},

	/** Epic active while the base branch has moved on — merge step 1 has work to do. */
	async epicBaseMoved(tools) {
		const facts = await shapes.epicOneCommit(tools);
		await tools.must(["switch", "--quiet", facts.baseBranch!]);
		tools.write("base-change.txt", "landed on the base branch\n");
		await tools.commit("base branch moves on");
		await tools.must(["switch", "--quiet", facts.branch!]);
		return facts;
	},

	/** Epic and base both changed the same lines — merge step 1 conflicts. */
	async epicConflict(tools) {
		const facts = await shapes.epicActive(tools);
		const { db, ctx } = await tools.tracker();
		const epic = getEpicBranch(db, facts.epicId!)!;
		tools.write("contested.txt", "epic version\n");
		await commitStory(ctx, { id: facts.firstId!, title: "Add the widget model" } as Story, epic);
		db.close();
		await tools.must(["switch", "--quiet", facts.baseBranch!]);
		tools.write("contested.txt", "base version\n");
		await tools.commit("base touches the same file");
		await tools.must(["switch", "--quiet", facts.branch!]);
		return { ...facts, conflictFile: "contested.txt" };
	},

	/** One epic already merged — /undo-merge. */
	async epicMerged(tools) {
		const facts = await shapes.epicOneCommit(tools);
		const { db, ctx } = await tools.tracker();
		const epic = getEpicBranch(db, facts.epicId!)!;
		const merged = await mergeIntoBase(ctx, epic);
		if (!merged.ok) throw new Error(`mergeIntoBase failed: ${merged.note}`);
		db.close();
		const baseTip = (await tools.must(["rev-parse", facts.baseBranch!])).stdout.trim();
		return { ...facts, backupRef: merged.backupRef, baseTip };
	},
};
