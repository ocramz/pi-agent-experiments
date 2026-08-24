/** How a story left the open set. Refines `status`, which only says that it did. */
export type StoryResolution =
	| "completed"
	| "superseded"
	| "obsolete"
	| "wontfix"
	| "duplicate";

export const STORY_RESOLUTIONS = [
	"completed",
	"superseded",
	"obsolete",
	"wontfix",
	"duplicate",
] as const;

/** A review's outcome. `changes_requested` keeps the gate it guards shut. */
export type ReviewVerdict = "approved" | "changes_requested";

export const REVIEW_VERDICTS = ["approved", "changes_requested"] as const;

/**
 * One recorded review.
 *
 * `by` is what makes the record auditable: `"self"` means the working agent
 * graded its own homework, anything else is the reviewer model's id. A human
 * reading the board can tell a rubber stamp from an independent judgement.
 */
export interface ReviewRecord {
	verdict: ReviewVerdict;
	/** What the reviewer found — mechanical findings plus its own reasoning. */
	findings: string;
	/** Reviewer model id, or "self" when no independent reviewer is configured. */
	by: string;
	at: number;
}

/**
 * Both review gates for a story, stored as JSON in one column.
 *
 * JSON for the same reason `epic_branches.setup` is — new fields land here, not
 * in a migration. See src/README.md.
 */
export interface StoryReview {
	/** Gates `mark_in_progress`: is this story worth starting as written? */
	plan?: ReviewRecord;
	/** Gates `mark_done`: does the work in the tree satisfy the story? */
	work?: ReviewRecord;
}

export interface Story {
	id: number;
	title: string;
	sub_goal: string;
	proposed_changes: string;
	status: "draft" | "ready" | "in_progress" | "done" | "cancelled" | "archived";
	priority: number;
	parent_id: number | null;
	next_id: number | null;
	depends_on: number[];
	/** Why the story closed. Null while it is still open. */
	resolution: StoryResolution | null;
	/** One line of detail on the resolution, e.g. "Merged into #12". */
	resolution_note: string | null;
	/**
	 * Something that contradicted `proposed_changes` during implementation.
	 * Null is the common case — see the `story` tool description.
	 */
	learnings: string | null;
	/** Plan and work review records. `{}` until either gate is reviewed. */
	review: StoryReview;
	/**
	 * What the next person needs to know to pick up from here. Required by
	 * `mark_done`, unlike `learnings` — this is the institutional memory that
	 * gets fed back into later turns and written into the story's commit.
	 */
	handoff_notes: string | null;
	created_at: number;
	updated_at: number;
}

export interface StoryHistoryEntry {
	id: number;
	story_id: number;
	action: string;
	old_value: string | null;
	new_value: string | null;
	timestamp: number;
}

/** Where an epic's work happens: on a branch in place, or in its own worktree. */
export type EpicMode = "branch" | "worktree";

/** How an epic's branch ended. `merged` and `cancelled` are both terminal. */
export type EpicState = "active" | "merged" | "cancelled";

/**
 * What ran the setup manifest, and against what. Stored as JSON so new fields
 * never need a schema migration — see src/README.md.
 */
export interface EpicSetupRecord {
	/** Hash of the manifest's `setup` string. A change re-runs setup. */
	hash?: string;
	exit_code?: number;
	/** Output of the manifest's `versions` command, captured at setup time. */
	versions?: string;
	ran_at?: number;
}

export interface EpicBranch {
	epic_id: number;
	mode: EpicMode;
	branch: string;
	/** The branch the epic started from and merges back into. Never main/master. */
	base_branch: string;
	base_commit: string;
	/** Worktree directory. Null in branch mode. */
	path: string | null;
	state: EpicState;
	setup: EpicSetupRecord;
	created_at: number;
	updated_at: number;
}

export interface StoryCommit {
	story_id: number;
	epic_id: number;
	/** HEAD when the story started — the target when undoing it at the tip. */
	start_commit: string;
	/** The story's own commit. Null until it closes, or if it closed clean. */
	commit_sha: string | null;
	backup_ref: string | null;
	created_at: number;
}
