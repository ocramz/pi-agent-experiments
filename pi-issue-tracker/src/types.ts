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
