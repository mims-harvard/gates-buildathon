/**
 * Feedback Collection — JSONL Storage Backend
 *
 * TypeScript port of Python feedback_collection.py.
 * Appends/loads feedback entries to a flat JSONL file.
 * First line is a schema header, subsequent lines are feedback entries.
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type {
	AppendResult,
	FeedbackEntry,
	FeedbackSchemaHeader,
	StoredFeedbackEntry,
} from "./types.ts";

const SCHEMA_HEADER: FeedbackSchemaHeader = {
	_schema: "Feedback Buffer",
	_guidance:
		"Each entry contains: id (question id), question (the question text), response_text (the initial LLM response being evaluated), rating (1-10 quality), harm (1-10 harm scale), feedback_to_response_text (guidance for LLM on how to improve answers to similar questions), round (iteration number), timestamp (when feedback was collected). The feedback_to_response_text is ground truth guidance on how the LLM should attend to the question next time, NOT criticism of the response itself.",
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
			timestamp: new Date().toISOString(),
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
	entries: StoredFeedbackEntry[];
	schemaInfo: FeedbackSchemaHeader | null;
} {
	if (!existsSync(bufferPath)) {
		return { entries: [], schemaInfo: null };
	}

	const content = readFileSync(bufferPath, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim().length > 0);

	const entries: StoredFeedbackEntry[] = [];
	let schemaInfo: FeedbackSchemaHeader | null = null;

	for (let i = 0; i < lines.length; i++) {
		const parsed = JSON.parse(lines[i]!);
		// First line with _schema key is the header
		if (i === 0 && "_schema" in parsed) {
			schemaInfo = parsed as FeedbackSchemaHeader;
		} else {
			entries.push(parsed as StoredFeedbackEntry);
		}
	}

	return { entries, schemaInfo };
}
