/**
 * Shared types for the ARK+ Feedback Pipeline.
 *
 * Feedback entry schema:
 *   From user form: rating, harm, feedback_to_response_text
 *   From code:      id, question, response_text
 *   Auto-added:     round, timestamp
 */

/** 3 fields submitted by the clinician via the form UI */
export type FeedbackFormInput = {
	rating: number; // 1-10 quality scale
	harm: number; // 1-10 harm scale (higher = more harmful)
	feedback_to_response_text: string; // guidance on how to improve
};

/** 3 fields auto-filled by code from conversation context */
export type FeedbackCodeInput = {
	id: string; // question identifier, e.g. "q0", "q1"
	question: string; // the original question text
	response_text: string; // the agent's response being evaluated
};

/** 6-field entry before storage (form + code, no metadata yet) */
export type FeedbackEntry = FeedbackFormInput & FeedbackCodeInput;

/** 8-field entry as stored in the JSONL file (6 fields + round + timestamp) */
export type StoredFeedbackEntry = FeedbackEntry & {
	round: number;
	timestamp: string; // UTC ISO format, e.g. "2026-03-11T20:00:00Z"
};

/** Schema header — first line of the JSONL file */
export type FeedbackSchemaHeader = {
	_schema: string;
	_guidance: string;
};

/** A knowledge entry added via chat (no form required) */
export type KnowledgeEntry = {
	id: string; // auto-generated, e.g. "k0", "k1"
	feedback_knowledge: string; // the guidance text
	round: number;
	timestamp: string;
};

/** A revision appended to an existing feedback entry */
export type Revision = {
	revised_at: string; // UTC ISO format
	previous_guidance: string;
	updated_guidance: string;
	reason: string;
};

/** Stored entry that may have revisions (feedback or knowledge) */
export type StoredEntryWithRevisions = StoredFeedbackEntry & {
	revisions?: Revision[];
};

/** Return type of appendFeedbackToBuffer */
export type AppendResult = {
	success: boolean;
	message: string;
	entryCount: number | null;
};

/** Return type of deleteEntry */
export type DeleteResult = {
	success: boolean;
	message: string;
	deletedEntry: StoredFeedbackEntry | KnowledgeEntry | null;
};

/** Return type of updateEntry */
export type UpdateResult = {
	success: boolean;
	message: string;
	updatedEntry: StoredEntryWithRevisions | null;
};
