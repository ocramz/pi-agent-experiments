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

export type StoryAction =
	| "create"
	| "update"
	| "delete"
	| "list"
	| "mark_done"
	| "reorder"
	| "simplify"
	| "get_next"
	| "search";

export interface StoryContextPayload {
	stories: Story[];
	in_progress: Story | null;
	top_ready: Story | null;
}
