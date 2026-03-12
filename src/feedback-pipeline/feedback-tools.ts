/**
 * Feedback Tools — Vercel AI SDK tool() wrappers
 *
 * Exposes loadFeedbackBuffer and saveFeedback as tools the agent can call
 * during its tool loop, just like findNodesByName or getNodeDetails.
 */

import { tool } from "ai";
import { z } from "zod";

import { appendFeedbackToBuffer, loadBuffer } from "./feedback-collection.ts";

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

	return { loadFeedbackBuffer, saveFeedback };
}
