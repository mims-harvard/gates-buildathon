import { createAnthropic } from "@ai-sdk/anthropic";
import {
	Agent,
	type ConfigInput,
	type HexColor,
	TerminalUI,
	type ToolComponentsMap,
} from "@ai-tui/core";
import { createEnv } from "@t3-oss/env-core";
import type { ChatTransport, ToolSet, UIMessage } from "ai";
import { DirectChatTransport, stepCountIs, ToolLoopAgent } from "ai";
import { join } from "node:path";
import { z } from "zod";

import { makeFeedbackTools } from "./feedback-pipeline/index.ts";
import { FeedbackChatTransport, FeedbackForm } from "./feedback/index.ts";
import { GraphLoader, makeParquetGraphTools } from "./parquet-tools/index.ts";
import {
	feedbackPrompt,
	graphAgentPrompt,
	regularPrompt,
} from "./prompts.ts";
import { GetNodeDetailsTool } from "./tool-renderers/index.ts";

export const env = createEnv({
	server: {
		ANTHROPIC_API_KEY: z.string().min(1),
	},
	runtimeEnv: process.env,
	emptyStringAsUndefined: true,
});

// Discover graph metadata instantly; parquet data loads lazily per agent
const DATA_DIR = join(import.meta.dir, "..", "data");
const FEEDBACK_BUFFER_PATH = join(DATA_DIR, "feedback_buffer.jsonl");
const loader = new GraphLoader(DATA_DIR);

const anthropic = createAnthropic({
	apiKey: env.ANTHROPIC_API_KEY,
});

/**
 * Custom tool component renderers for graph agent tools.
 */
const graphToolComponents: ToolComponentsMap = {
	getNodeDetails: GetNodeDetailsTool,
};

const configValue: ConfigInput = {
	id: "ark-agent-cli",
	agents: loader.graphsMeta.map(
		(meta) =>
			new Agent({
				id: meta.slug,
				name: meta.name,
				model: { providerName: "Anthropic", name: "Claude Opus 4.5" },
				color: meta.color as HexColor,
				toolComponents: graphToolComponents,
				createTransport: async ({ transportOptions }) => {
					const graphTools = (await makeParquetGraphTools(
						[meta.id],
						loader,
					)) as ToolSet;

					// Create feedback tools — round 1 for now, can be dynamic later
					const feedbackTools = makeFeedbackTools(FEEDBACK_BUFFER_PATH, 1);

					const agent = new ToolLoopAgent({
						model: anthropic("claude-opus-4-5"),
						tools: { ...graphTools, ...feedbackTools } as ToolSet,
						instructions: `${regularPrompt}\n\n${feedbackPrompt}\n\n${graphAgentPrompt}`,
						stopWhen: stepCountIs(50),
					});

				const inner = new DirectChatTransport({
					agent,
					...transportOptions,
				}) as ChatTransport<UIMessage>;

				return new FeedbackChatTransport(inner);
				},
			}),
	) as ConfigInput["agents"],
	appName: {
		sections: [
			{
				text: "ARK",
				style: "gradient" as const,
				gradient: ["#fcb69f", "#f8b878"],
			},
			{ text: "Agent" },
		],
	},
};

// Register the feedback form so the patched /feedback slash command can find it
globalThis.__arkFeedbackForm = FeedbackForm;

const tui = new TerminalUI(configValue);
await tui.run();
