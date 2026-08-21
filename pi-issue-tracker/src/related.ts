import type { DatabaseSync } from "node:sqlite";
import type { Story } from "./types.ts";
import { getAllStories, getStoriesWithLearnings } from "./database.ts";

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
}

const CLOSED = ["done", "cancelled", "archived"];

/** Distinct words longer than 3 chars, across a story's text fields. */
function keywords(story: Story): string[] {
	const text = `${story.title} ${story.sub_goal} ${story.proposed_changes}`.toLowerCase();
	return [...new Set(text.split(/\W+/).filter((w) => w.length > 3))];
}

function overlapScore(words: string[], candidate: Story): number {
	const text = `${candidate.title} ${candidate.sub_goal} ${candidate.proposed_changes}`.toLowerCase();
	let score = 0;
	for (const w of words) {
		if (text.includes(w)) score += 1;
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
		const candidates = getStoriesWithLearnings(db).filter((s) => s.id !== story.id);
		if (candidates.length === 0) return [];

		const words = keywords(story);

		const scored = candidates.map((s) => {
			let score = overlapScore(words, s);
			// A sibling under the same epic is relevant even with no word overlap.
			const isSibling = story.parent_id !== null && s.parent_id === story.parent_id;
			if (isSibling) score += 5;
			if (s.parent_id === story.id || story.parent_id === s.id) score += 5;
			if (story.depends_on.includes(s.id) || s.depends_on.includes(story.id)) score += 5;
			return { story: s, score };
		});

		// Require *some* connection — injecting unrelated learnings is just noise.
		return scored
			.filter((x) => x.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((x) => x.story);
	},
};
