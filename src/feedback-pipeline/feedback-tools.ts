/**
 * Feedback Tools — Vercel AI SDK tool() wrappers
 *
 * Exposes loadFeedbackBuffer and saveFeedback as tools the agent can call
 * during its tool loop, just like findNodesByName or getNodeDetails.
 */

import { tool } from "ai";
import { z } from "zod";

import {
	appendFeedbackToBuffer,
	loadBuffer,
	deleteEntry,
	addKnowledgeEntry,
	updateEntry,
} from "./feedback-collection.ts";

/**
 * Create feedback tools with the buffer path and round number baked in.
 *
 * Usage in index.tsx:
 *   const feedbackTools = makeFeedbackTools("data/feedback_buffer.jsonl", 1);
 *   tools: { ...graphTools, ...feedbackTools }
 */
export function makeFeedbackTools(bufferPath: string, roundNum: number) {
	const loadFeedbackBuffer = tool({
		description:
			"Load the feedback buffer containing clinician feedback from previous rounds. Call this before answering health questions to learn from past feedback.",
		inputSchema: z.object({}),
		execute: async () => {
			const { entries, schemaInfo } = loadBuffer(bufferPath);
			return {
				schemaGuidance: schemaInfo?._guidance ?? null,
				entries,
				totalCount: entries.length,
			};
		},
	});

	const saveFeedback = tool({
		description:
			"Save clinician feedback for the current question and response. The id, question, and response_text are filled from conversation context. The rating, harm, and feedback_to_response_text come from the clinician form.",
		inputSchema: z.object({
			id: z.string().describe("Question identifier, e.g. 'q0', 'q1'"),
			question: z.string().describe("The original question that was asked"),
			response_text: z
				.string()
				.describe("The agent's response being evaluated"),
			rating: z
				.number()
				.min(1)
				.max(10)
				.describe("Quality rating, 1-10 scale (10 = excellent)"),
			harm: z
				.number()
				.min(1)
				.max(10)
				.describe("Harm assessment, 1-10 scale (10 = highly harmful)"),
			feedback_to_response_text: z
				.string()
				.describe(
					"Clinician guidance on how to improve answers to similar questions",
				),
		}),
		execute: async ({
			id,
			question,
			response_text,
			rating,
			harm,
			feedback_to_response_text,
		}) => {
			const result = appendFeedbackToBuffer(
				{ id, question, response_text, rating, harm, feedback_to_response_text },
				bufferPath,
				roundNum,
			);
			return result;
		},
	});

	const deleteFeedback = tool({
		description:
			"Delete a feedback entry from the buffer by its id. IMPORTANT: Before calling this tool, ALWAYS show the user the entry you are about to delete and ask for explicit confirmation.",
		inputSchema: z.object({
			id: z.string().describe("The id of the entry to delete (e.g. 'q3' or 'k1')"),
		}),
		execute: async ({ id }) => {
			return deleteEntry(id, bufferPath);
		},
	});

	const addKnowledge = tool({
		description:
			"Add a knowledge entry to the feedback buffer without needing the full form. Use this when a clinician says something like 'remember that X is important for Y' or 'next time do Z'. The id and timestamp are auto-generated.",
		inputSchema: z.object({
			feedback_knowledge: z
				.string()
				.describe("The clinician's guidance or knowledge to remember"),
		}),
		execute: async ({ feedback_knowledge }) => {
			return addKnowledgeEntry(feedback_knowledge, bufferPath, roundNum);
		},
	});

	const updateFeedback = tool({
		description:
			"Update an existing feedback entry by appending a revision. Use this when a clinician wants to change or correct previous feedback (e.g. 'actually, that advice about X was wrong, change it to Y'). The original entry is preserved with the revision appended. If no matching entry is found, use addKnowledge instead.",
		inputSchema: z.object({
			id: z.string().describe("The id of the entry to update (e.g. 'q1' or 'k0')"),
			revision: z
				.string()
				.describe("The updated guidance (e.g. 'Focus on long-term management, not emergency advice')"),
			reason: z
				.string()
				.describe("Why the guidance changed (e.g. 'Clinician consulted with specialist')"),
		}),
		execute: async ({ id, revision, reason }) => {
			return updateEntry(id, revision, reason, bufferPath);
		},
	});

	return { loadFeedbackBuffer, saveFeedback, deleteFeedback, addKnowledge, updateFeedback };
}
