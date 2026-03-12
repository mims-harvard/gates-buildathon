/**
 * Feedback Collection — JSONL Storage Backend
 *
 * TypeScript port of Python feedback_collection.py.
 * Appends/loads feedback entries to a flat JSONL file.
 * First line is a schema header, subsequent lines are feedback entries.
 */

import {
	existsSync,
	readFileSync,
	appendFileSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { dirname } from "node:path";

import type {
	AppendResult,
	DeleteResult,
	FeedbackEntry,
	FeedbackSchemaHeader,
	KnowledgeEntry,
	StoredFeedbackEntry,
	StoredEntryWithRevisions,
	UpdateResult,
} from "./types.ts";

const SCHEMA_HEADER: FeedbackSchemaHeader = {
	_schema: "Feedback Buffer",
	_guidance:
		"Each entry contains: query_id (question id), query (the question text), response_text (the initial LLM response being evaluated), user_rating (1-5 quality), user_harm (1-5 harm scale), user_feedback (guidance for LLM on how to improve answers to similar questions), round (iteration number), timestamp (when feedback was collected). The user_feedback is ground truth guidance on how the LLM should attend to the question next time, NOT criticism of the response itself.",
};

/**
 * Append a feedback entry to the JSONL buffer.
 *
 * - Creates the file (with schema header) if it doesn't exist.
 * - Auto-adds `round` and `timestamp` fields.
 * - Returns success status and current entry count.
 */
export function appendFeedbackToBuffer(
	entry: FeedbackEntry,
	bufferPath: string,
	roundNum: number,
	timestamp?: string,
): AppendResult {
	try {
		const isNewFile = !existsSync(bufferPath);

		// Ensure parent directory exists
		if (isNewFile) {
			mkdirSync(dirname(bufferPath), { recursive: true });
		}

		let data = "";

		// Write schema header on first entry
		if (isNewFile) {
			data += JSON.stringify(SCHEMA_HEADER) + "\n";
		}

		// Build stored entry with auto-added metadata
		const storedEntry: StoredFeedbackEntry = {
			...entry,
			round: roundNum,
			timestamp: timestamp || new Date().toISOString(),
		};
		data += JSON.stringify(storedEntry) + "\n";

		appendFileSync(bufferPath, data, "utf-8");

		// Count entries (lines minus schema header)
		const content = readFileSync(bufferPath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);
		const entryCount = lines.length - 1; // -1 for schema header

		return {
			success: true,
			message: `Feedback appended to ${bufferPath}`,
			entryCount,
		};
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		return {
			success: false,
			message: `Error appending feedback: ${errMsg}`,
			entryCount: null,
		};
	}
}

/**
 * Load all feedback entries from the JSONL buffer.
 *
 * - Skips the schema header (first line with `_schema` key).
 * - Returns entries + schema info separately.
 * - Returns empty if file doesn't exist.
 */
export function loadBuffer(bufferPath: string): {
	entries: (StoredFeedbackEntry | KnowledgeEntry)[];
	schemaInfo: FeedbackSchemaHeader | null;
} {
	if (!existsSync(bufferPath)) {
		return { entries: [], schemaInfo: null };
	}

	const content = readFileSync(bufferPath, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim().length > 0);

	const entries: (StoredFeedbackEntry | KnowledgeEntry)[] = [];
	let schemaInfo: FeedbackSchemaHeader | null = null;

	for (let i = 0; i < lines.length; i++) {
		const parsed = JSON.parse(lines[i]!);
		// First line with _schema key is the header
		if (i === 0 && "_schema" in parsed) {
			schemaInfo = parsed as FeedbackSchemaHeader;
		} else {
			entries.push(parsed as StoredFeedbackEntry | KnowledgeEntry);
		}
	}

	return { entries, schemaInfo };
}

/**
 * Helper: rewrite the entire JSONL file from a list of entries.
 * Preserves the schema header as the first line.
 */
function rewriteBuffer(
	bufferPath: string,
	entries: Record<string, unknown>[],
): void {
	let data = JSON.stringify(SCHEMA_HEADER) + "\n";
	for (const entry of entries) {
		data += JSON.stringify(entry) + "\n";
	}
	writeFileSync(bufferPath, data, "utf-8");
}

/**
 * Delete a feedback entry by id.
 *
 * Reads the file, filters out the matching entry, rewrites the file.
 * Returns the deleted entry so the LLM can show it to the user.
 */
export function deleteEntry(
	id: string,
	bufferPath: string,
): DeleteResult {
	try {
		if (!existsSync(bufferPath)) {
			return { success: false, message: "Feedback buffer file does not exist.", deletedEntry: null };
		}

		const content = readFileSync(bufferPath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);

		const kept: Record<string, unknown>[] = [];
		let deleted: StoredFeedbackEntry | KnowledgeEntry | null = null;

		for (let i = 0; i < lines.length; i++) {
			const parsed = JSON.parse(lines[i]!);
			if (i === 0 && "_schema" in parsed) continue; // skip schema header, rewriteBuffer adds it back
			if (parsed.id === id && !deleted) {
				deleted = parsed;
			} else {
				kept.push(parsed);
			}
		}

		if (!deleted) {
			return { success: false, message: `No entry found with id "${id}".`, deletedEntry: null };
		}

		rewriteBuffer(bufferPath, kept);
		return { success: true, message: `Deleted entry "${id}".`, deletedEntry: deleted };
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		return { success: false, message: `Error deleting entry: ${errMsg}`, deletedEntry: null };
	}
}

/**
 * Add a knowledge entry (no form required).
 *
 * Auto-generates id (k0, k1, ...), round, and timestamp.
 */
export function addKnowledgeEntry(
	feedbackKnowledge: string,
	bufferPath: string,
	roundNum: number,
): AppendResult {
	try {
		const isNewFile = !existsSync(bufferPath);
		if (isNewFile) {
			mkdirSync(dirname(bufferPath), { recursive: true });
		}

		// Generate next knowledge id (use max existing id + 1 to avoid collisions after deletes)
		const { entries } = loadBuffer(bufferPath);
		let maxKId = -1;
		for (const e of entries) {
			if ("id" in e && e.id.startsWith("k")) {
				const num = parseInt(e.id.slice(1), 10);
				if (!isNaN(num) && num > maxKId) maxKId = num;
			}
		}
		const nextId = `k${maxKId + 1}`;

		const knowledgeEntry: KnowledgeEntry = {
			id: nextId,
			feedback_knowledge: feedbackKnowledge,
			round: roundNum,
			timestamp: new Date().toISOString(),
		};

		let data = "";
		if (isNewFile) {
			data += JSON.stringify(SCHEMA_HEADER) + "\n";
		}
		data += JSON.stringify(knowledgeEntry) + "\n";
		appendFileSync(bufferPath, data, "utf-8");

		// Count total entries
		const afterContent = readFileSync(bufferPath, "utf-8");
		const afterLines = afterContent.split("\n").filter((l) => l.trim().length > 0);
		const entryCount = afterLines.length - 1;

		return { success: true, message: `Knowledge entry "${nextId}" added.`, entryCount };
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		return { success: false, message: `Error adding knowledge: ${errMsg}`, entryCount: null };
	}
}

/**
 * Update an existing entry by appending a revision.
 *
 * Reads the file, finds the entry by id, appends a revision object,
 * then rewrites the file. Does NOT overwrite the original guidance.
 */
export function updateEntry(
	id: string,
	revision: string,
	reason: string,
	bufferPath: string,
): UpdateResult {
	try {
		if (!existsSync(bufferPath)) {
			return { success: false, message: "Feedback buffer file does not exist.", updatedEntry: null };
		}

		const content = readFileSync(bufferPath, "utf-8");
		const lines = content.split("\n").filter((l) => l.trim().length > 0);

		const allEntries: Record<string, unknown>[] = [];
		let updatedEntry: StoredEntryWithRevisions | null = null;

		for (let i = 0; i < lines.length; i++) {
			const parsed = JSON.parse(lines[i]!);
			if (i === 0 && "_schema" in parsed) continue;

			if (parsed.id === id && !updatedEntry) {
				// Get the current guidance text (works for both feedback and knowledge entries)
				const previousGuidance =
					parsed.feedback_to_response_text ?? parsed.feedback_knowledge ?? "";

				const newRevision = {
					revised_at: new Date().toISOString(),
					previous_guidance: previousGuidance,
					updated_guidance: revision,
					reason,
				};

				// Append to existing revisions array or create one
				const revisions = Array.isArray(parsed.revisions) ? [...parsed.revisions, newRevision] : [newRevision];
				const updated = { ...parsed, revisions };
				updatedEntry = updated as StoredEntryWithRevisions;
				allEntries.push(updated);
			} else {
				allEntries.push(parsed);
			}
		}

		if (!updatedEntry) {
			return { success: false, message: `No entry found with id "${id}".`, updatedEntry: null };
		}

		rewriteBuffer(bufferPath, allEntries);
		return { success: true, message: `Updated entry "${id}" with new revision.`, updatedEntry };
	} catch (e) {
		const errMsg = e instanceof Error ? e.message : String(e);
		return { success: false, message: `Error updating entry: ${errMsg}`, updatedEntry: null };
	}
}
