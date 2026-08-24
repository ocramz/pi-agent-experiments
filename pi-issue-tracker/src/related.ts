import type { DatabaseSync } from "node:sqlite";
import type { Story } from "./types.ts";
import { getAllStories, getStoriesWithHandoffNotes, getStoriesWithLearnings } from "./database.ts";

/**
 * Strategy interface for finding stories related to a given story.
 * This is intentionally modular so we can swap in vector embeddings,
 * graph traversal, or other approaches later.
 */
export interface RelatedStoriesStrategy {
	name: string;
	/** Open stories most related to `story`. */
	findRelated(db: DatabaseSync, story: Story, limit: number): Story[];
	/**
	 * Closed stories whose recorded learnings are most relevant to `story`.
	 * Separate from findRelated because that one deliberately excludes closed work.
	 */
	findLearnings(db: DatabaseSync, story: Story, limit: number): Story[];
	/**
	 * Stories whose handoff notes are most relevant to `story`.
	 *
	 * Distinct from `findLearnings`: a learning is something that contradicted a
	 * plan, and most stories have none. A handoff note is what the next person
	 * needs to pick up the work, and every closed story has one.
	 */
	findHandoffs(db: DatabaseSync, story: Story, limit: number): Story[];
}

const CLOSED = ["done", "cancelled", "archived"];

/** Distinct words longer than 3 chars, across a story's text fields. */
function keywords(story: Story): string[] {
	const text = `${story.title} ${story.sub_goal} ${story.proposed_changes}`.toLowerCase();
	return [...new Set(text.split(/\W+/).filter((w) => w.length > 3))];
}

function overlapScore(words: string[], candidate: Story): number {
	return overlapScoreOn(words, `${candidate.title} ${candidate.sub_goal} ${candidate.proposed_changes}`);
}

function overlapScoreOn(words: string[], text: string): number {
	if (!text) return 0;
	const haystack = text.toLowerCase();
	let score = 0;
	for (const w of words) {
		if (haystack.includes(w)) score += 1;
	}
	return score;
}

/**
 * Simple keyword overlap strategy.
 * Extracts words >3 chars from the target story and scores other
 * stories by how many of those words they share. Boosts existing
 * graph neighbours (parent, child, sibling, dependency).
 */
export const keywordStrategy: RelatedStoriesStrategy = {
	name: "keyword",

	findRelated(db, story, limit) {
		const allOpen = getAllStories(db).filter(
			(s) => s.id !== story.id && !CLOSED.includes(s.status),
		);

		if (allOpen.length === 0) return [];

		const words = keywords(story);

		const scored = allOpen.map((s) => {
			let score = overlapScore(words, s);
			// Boost structural neighbours already in the graph
			if (s.parent_id === story.id || story.parent_id === s.id) score += 5;
			if (story.depends_on.includes(s.id) || s.depends_on.includes(story.id)) score += 5;
			return { story: s, score };
		});

		scored.sort((a, b) => b.score - a.score);
		return scored.slice(0, limit).map((x) => x.story);
	},

	findLearnings(db, story, limit) {
		return rankConnected(getStoriesWithLearnings(db), story, limit);
	},

	findHandoffs(db, story, limit) {
		// Scored on the note itself, not only the story's plan text: a handoff
		// note names the things that were not obvious from the plan, which is
		// exactly what makes it worth retrieving.
		return rankConnected(getStoriesWithHandoffNotes(db), story, limit, (s) => s.handoff_notes ?? "");
	},
};

/**
 * Score candidates by keyword overlap plus structural proximity, keeping only
 * those with *some* connection.
 *
 * The `score > 0` filter is the whole point: this rides on every turn's context,
 * and injecting an unrelated note is pure noise. Shared by `findLearnings` and
 * `findHandoffs`, which differ only in which text they match against.
 */
function rankConnected(
	candidates: Story[],
	story: Story,
	limit: number,
	extraText: (s: Story) => string = () => "",
): Story[] {
	const pool = candidates.filter((s) => s.id !== story.id);
	if (pool.length === 0) return [];

	const words = keywords(story);

	const scored = pool.map((s) => {
		let score = overlapScore(words, s) + overlapScoreOn(words, extraText(s));
		// A sibling under the same epic is relevant even with no word overlap.
		const isSibling = story.parent_id !== null && s.parent_id === story.parent_id;
		if (isSibling) score += 5;
		if (s.parent_id === story.id || story.parent_id === s.id) score += 5;
		if (story.depends_on.includes(s.id) || s.depends_on.includes(story.id)) score += 5;
		return { story: s, score };
	});

	return scored
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score || a.story.id - b.story.id)
		.slice(0, limit)
		.map((x) => x.story);
}
