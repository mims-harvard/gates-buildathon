import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FeedbackData, RetrievedNode } from "./store.ts";

const FEEDBACK_DIR = join(import.meta.dir, "..", "..", "feedback");

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type FeedbackMatch = {
	/** The original user query that received this feedback. */
	query: string;
	/** Accuracy rating (1-5) given by the user. */
	user_rating: number;
	/** Clinical harm likelihood rating (1-5) given by the user. */
	user_harm: number;
	/** Free-text feedback comment from the user. */
	user_feedback: string;
	/** The node IDs that appear in both the current query and this feedback. */
	overlapping_node_ids: string[];
	/** How many node IDs overlap. */
	overlap_count: number;
};

// ────────────────────────────────────────────────────────────────────────────
// Node ID extraction
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract all knowledge-graph node IDs referenced in a single tool call's
 * input and output.  Handles the shapes produced by all five graph tools:
 *
 *   - findNodesByName      → output: Array<{ id }>
 *   - getNodeDetails       → output: Array<{ id }>
 *   - getNeighborsByNodeId → input: { nodeId }, output: string[]
 *   - searchInSurroundings → input: { nodeId }, output: { mainNode.id, neighbors[].id }
 *   - listAvailableGraphs  → (no node IDs)
 */
function extractNodeIds(node: RetrievedNode): string[] {
	const ids: string[] = [];

	// ── Input side ────────────────────────────────────────────────────
	const input = node.input as Record<string, unknown> | null;
	if (input && typeof input.nodeId === "string") {
		ids.push(input.nodeId);
	}

	// ── Output side ──────────────────────────────────────────────────
	const output = node.output;

	// Array of objects with .id  (findNodesByName, getNodeDetails)
	if (Array.isArray(output)) {
		for (const item of output) {
			if (typeof item === "string") {
				// getNeighborsByNodeId returns string[]
				ids.push(item);
			} else if (item && typeof item === "object" && typeof (item as Record<string, unknown>).id === "string") {
				ids.push((item as Record<string, unknown>).id as string);
			}
		}
	}

	// searchInSurroundings returns { mainNode: { id }, neighbors: [{ id }] }
	if (output && typeof output === "object" && !Array.isArray(output)) {
		const obj = output as Record<string, unknown>;

		const mainNode = obj.mainNode as Record<string, unknown> | undefined;
		if (mainNode && typeof mainNode.id === "string") {
			ids.push(mainNode.id);
		}

		const neighbors = obj.neighbors;
		if (Array.isArray(neighbors)) {
			for (const n of neighbors) {
				if (n && typeof n === "object" && typeof (n as Record<string, unknown>).id === "string") {
					ids.push((n as Record<string, unknown>).id as string);
				}
			}
		}
	}

	return ids;
}

/**
 * Collect all unique node IDs from a feedback file's retrieved_nodes array.
 */
function collectNodeIdsFromFeedback(data: FeedbackData): Set<string> {
	const ids = new Set<string>();
	for (const node of data.retrieved_nodes) {
		for (const id of extractNodeIds(node)) {
			ids.add(id);
		}
	}
	return ids;
}

// ────────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────────

/**
 * Search all saved feedback files for entries whose retrieved nodes overlap
 * with the given `nodeIds`.  Returns every match (overlap >= 1), sorted by
 * overlap count descending, so the LLM can judge relevance itself.
 */
export function searchFeedback(nodeIds: string[]): FeedbackMatch[] {
	if (nodeIds.length === 0) return [];
	if (!existsSync(FEEDBACK_DIR)) return [];

	const querySet = new Set(nodeIds);
	const matches: FeedbackMatch[] = [];

	const files = readdirSync(FEEDBACK_DIR).filter((f) => f.endsWith(".json"));

	for (const file of files) {
		try {
			const raw = readFileSync(join(FEEDBACK_DIR, file), "utf-8");
			const data = JSON.parse(raw) as FeedbackData;

			const feedbackNodeIds = collectNodeIdsFromFeedback(data);
			const overlapping: string[] = [];

			for (const id of feedbackNodeIds) {
				if (querySet.has(id)) {
					overlapping.push(id);
				}
			}

			if (overlapping.length > 0) {
				matches.push({
					query: data.query,
					user_rating: data.user_rating,
					user_harm: data.user_harm,
					user_feedback: data.user_feedback,
					overlapping_node_ids: overlapping,
					overlap_count: overlapping.length,
				});
			}
		} catch {
			// Skip malformed files silently
		}
	}

	// Most relevant first
	matches.sort((a, b) => b.overlap_count - a.overlap_count);

	return matches;
}
