import {
	createUIMessageStream,
	type ChatTransport,
	type UIMessage,
	type UIMessageChunk,
} from "ai";

import {
	generateQueryId,
	saveFeedback,
	type RetrievedNode,
} from "./store.ts";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

type FeedbackState =
	| "normal"
	| "awaiting_feedback_choice"
	| "awaiting_accuracy"
	| "awaiting_harm"
	| "awaiting_freetext";

/** Data captured from the most recent agent response. */
type CapturedResponse = {
	queryId: string;
	query: string;
	responseText: string;
	retrievedNodes: RetrievedNode[];
};

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Extract the plain text typed by the user from the last message in the
 * conversation history.
 */
function extractUserText(messages: UIMessage[]): string {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "user") return "";
	return last.parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text")
		.map((p) => p.text)
		.join("")
		.trim();
}

/**
 * Build a ReadableStream<UIMessageChunk> containing a single plain-text
 * assistant message. Used for synthetic feedback-mode responses.
 */
function createTextStream(text: string): ReadableStream<UIMessageChunk> {
	return createUIMessageStream({
		execute: ({ writer }) => {
			const partId = `feedback-${Date.now()}`;
			writer.write({ type: "start" });
			writer.write({ type: "start-step" });
			writer.write({ type: "text-start", id: partId });
			writer.write({ type: "text-delta", id: partId, delta: text });
			writer.write({ type: "text-end", id: partId });
			writer.write({ type: "finish-step" });
			writer.write({ type: "finish", finishReason: "stop" });
		},
	});
}

// ────────────────────────────────────────────────────────────────────────────
// FeedbackChatTransport
// ────────────────────────────────────────────────────────────────────────────

/**
 * A ChatTransport wrapper that adds post-response feedback collection.
 *
 * Normal flow:
 *   1. Forward user message to the wrapped transport (the real agent).
 *   2. Pipe the response stream through a TransformStream that captures
 *      response text & tool I/O, and appends a feedback prompt.
 *   3. Store captured data so it is available when the user opts in.
 *
 * Feedback flow (triggered by typing "/feedback"):
 *   1. "Is this response accurate? (1-5)"
 *   2. "How likely is the response to cause clinical harm? (1-5)"
 *   3. "Please provide free text feedback about this response."
 *   4. Save feedback JSON to disk and confirm.
 */
export class FeedbackChatTransport implements ChatTransport<UIMessage> {
	private wrapped: ChatTransport<UIMessage>;
	private state: FeedbackState = "normal";

	/** Most recent agent response data (populated after each normal turn). */
	private captured: CapturedResponse | null = null;

	/** In-progress feedback values collected across turns. */
	private pendingRating: number | undefined;
	private pendingHarm: number | undefined;

	constructor(wrapped: ChatTransport<UIMessage>) {
		this.wrapped = wrapped;
	}

	// ── ChatTransport interface ──────────────────────────────────────────

	async sendMessages(
		options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
	): Promise<ReadableStream<UIMessageChunk>> {
		const userText = extractUserText(options.messages);

		// ── Feedback state machine ───────────────────────────────────────
		switch (this.state) {
			case "awaiting_feedback_choice":
				return this.handleFeedbackChoice(userText, options);

			case "awaiting_accuracy":
				return this.handleAccuracyRating(userText);

			case "awaiting_harm":
				return this.handleHarmRating(userText);

			case "awaiting_freetext":
				return this.handleFreetext(userText);

			case "normal":
			default:
				break;
		}

		// ── Check for /feedback while in normal state ────────────────────
		if (userText.toLowerCase() === "/feedback") {
			if (!this.captured) {
				return createTextStream(
					"No previous response to provide feedback on. Ask a question first.",
				);
			}
			this.state = "awaiting_accuracy";
			return createTextStream(
				"Is this response accurate? Please rate on a scale from 1 to 5\n" +
					"(1 = Not accurate at all, 5 = Very accurate)",
			);
		}

		// ── Normal agent turn ────────────────────────────────────────────
		const innerStream = await this.wrapped.sendMessages(options);
		return this.wrapAgentStream(innerStream, userText);
	}

	reconnectToStream(
		options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
	) {
		return this.wrapped.reconnectToStream(options);
	}

	// ── Stream wrapping ──────────────────────────────────────────────────

	/**
	 * Pipe the agent response stream through a transform that:
	 *   - passes every chunk through unchanged
	 *   - captures text-delta content and tool I/O
	 *   - injects a feedback prompt just before the "finish" chunk
	 */
	private wrapAgentStream(
		inner: ReadableStream<UIMessageChunk>,
		queryText: string,
	): ReadableStream<UIMessageChunk> {
		let responseText = "";
		const nodes: RetrievedNode[] = [];
		const toolCallMap = new Map<
			string,
			{ toolName: string; input: unknown }
		>();

		const self = this;
		const queryId = generateQueryId();

		const transform = new TransformStream<UIMessageChunk, UIMessageChunk>({
			transform(chunk, controller) {
				// Accumulate text deltas
				if (chunk.type === "text-delta") {
					responseText += chunk.delta;
				}

				// Track tool inputs
				if (chunk.type === "tool-input-available") {
					toolCallMap.set(chunk.toolCallId, {
						toolName: chunk.toolName,
						input: chunk.input,
					});
				}

				// Track tool outputs, pairing with their inputs
				if (chunk.type === "tool-output-available") {
					const call = toolCallMap.get(chunk.toolCallId);
					nodes.push({
						toolName: call?.toolName ?? "unknown",
						input: call?.input ?? null,
						output: chunk.output,
					});
				}

				// Inject feedback prompt just before the stream finishes
				if (chunk.type === "finish") {
					const promptId = `feedback-prompt-${Date.now()}`;
					controller.enqueue({ type: "text-start", id: promptId });
					controller.enqueue({
						type: "text-delta",
						id: promptId,
						delta: "\n\n---\nType **/feedback** to rate this response.",
					});
					controller.enqueue({ type: "text-end", id: promptId });

					// Store captured data for potential feedback
					self.captured = {
						queryId,
						query: queryText,
						responseText,
						retrievedNodes: nodes,
					};
					self.state = "awaiting_feedback_choice";
				}

				// Always forward the original chunk
				controller.enqueue(chunk);
			},
		});

		return inner.pipeThrough(transform);
	}

	// ── Feedback state handlers ──────────────────────────────────────────

	private handleFeedbackChoice(
		text: string,
		options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
	): Promise<ReadableStream<UIMessageChunk>> {
		const lower = text.toLowerCase();

		if (lower === "/feedback") {
			this.state = "awaiting_accuracy";
			return Promise.resolve(
				createTextStream(
					"Is this response accurate? Please rate on a scale from 1 to 5\n" +
						"(1 = Not accurate at all, 5 = Very accurate)",
				),
			);
		}

		// User chose to keep chatting -- forward to the agent normally.
		this.state = "normal";
		return this.sendMessages(options);
	}

	private handleAccuracyRating(
		text: string,
	): Promise<ReadableStream<UIMessageChunk>> {
		const rating = Number.parseInt(text, 10);

		if (Number.isNaN(rating) || rating < 1 || rating > 5) {
			return Promise.resolve(
				createTextStream(
					"Please enter a number from 1 to 5.\n\n" +
						"Is this response accurate?\n" +
						"(1 = Not accurate at all, 5 = Very accurate)",
				),
			);
		}

		this.pendingRating = rating;
		this.state = "awaiting_harm";
		return Promise.resolve(
			createTextStream(
				"How likely is the response to cause clinical harm? Please rate on a scale from 1 to 5\n" +
					"(1 = Very unlikely to cause harm, 5 = Very likely to cause harm)",
			),
		);
	}

	private handleHarmRating(
		text: string,
	): Promise<ReadableStream<UIMessageChunk>> {
		const harm = Number.parseInt(text, 10);

		if (Number.isNaN(harm) || harm < 1 || harm > 5) {
			return Promise.resolve(
				createTextStream(
					"Please enter a number from 1 to 5.\n\n" +
						"How likely is the response to cause clinical harm?\n" +
						"(1 = Very unlikely to cause harm, 5 = Very likely to cause harm)",
				),
			);
		}

		this.pendingHarm = harm;
		this.state = "awaiting_freetext";
		return Promise.resolve(
			createTextStream(
				"Please provide free text feedback about this response.",
			),
		);
	}

	private handleFreetext(
		text: string,
	): Promise<ReadableStream<UIMessageChunk>> {
		if (!this.captured) {
			this.state = "normal";
			return Promise.resolve(
				createTextStream(
					"Something went wrong. No response data found.",
				),
			);
		}

		saveFeedback({
			query_id: this.captured.queryId,
			query: this.captured.query,
			response_text: this.captured.responseText,
			retrieved_nodes: this.captured.retrievedNodes,
			user_rating: this.pendingRating!,
			user_harm: this.pendingHarm!,
			user_feedback: text,
			timestamp: new Date().toISOString(),
		});

		// Reset state
		this.pendingRating = undefined;
		this.pendingHarm = undefined;
		this.state = "normal";

		return Promise.resolve(
			createTextStream(
				"Thank you for your feedback! It has been saved.\n\n" +
					"You can continue asking questions.",
			),
		);
	}
}
