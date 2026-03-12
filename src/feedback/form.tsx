import { useState, useCallback } from "react";
import type { FeedbackFormProps } from "./globals.ts";
import { saveFeedback } from "./store.ts";

// ────────────────────────────────────────────────────────────────────────────
// Rating selector (1-5 scale, arrow-key navigable)
// ────────────────────────────────────────────────────────────────────────────

function RatingStep({
	question,
	subtitle,
	onSelect,
	onCancel,
}: {
	question: string;
	subtitle: string;
	onSelect: (value: number) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState(3);

	return (
		<box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1} paddingTop={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text bold>Feedback</text>
				<text dim>esc</text>
			</box>

			<text>{question}</text>
			<text dim>{subtitle}</text>

			<box flexDirection="row" gap={1} paddingTop={1}>
				{[1, 2, 3, 4, 5].map((n) => (
					<box
						key={n}
						paddingLeft={1}
						paddingRight={1}
						border={n === value ? undefined : ["top", "bottom", "left", "right"]}
						backgroundColor={n === value ? "#fab283" : undefined}
						onMouseUp={() => onSelect(n)}
						onMouseOver={() => setValue(n)}
					>
						<text bold={n === value}>{String(n)}</text>
					</box>
				))}
			</box>

			<text dim>
				Use left/right arrows to choose, Enter to confirm, Esc to cancel
			</text>

			<input
				onSubmit={() => onSelect(value)}
				onInput={(text: string) => {
					const num = Number.parseInt(text, 10);
					if (num >= 1 && num <= 5) {
						onSelect(num);
					}
				}}
				placeholder=""
				focused
				cursorColor="#fab283"
			/>
		</box>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Free text step
// ────────────────────────────────────────────────────────────────────────────

function TextStep({
	question,
	onSubmit,
	onCancel,
}: {
	question: string;
	onSubmit: (text: string) => void;
	onCancel: () => void;
}) {
	const [value, setValue] = useState("");

	return (
		<box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1} paddingTop={1}>
			<box flexDirection="row" justifyContent="space-between">
				<text bold>Feedback</text>
				<text dim>esc</text>
			</box>

			<text>{question}</text>

			<input
				onSubmit={() => {
					if (value.trim()) onSubmit(value.trim());
				}}
				onInput={(text: string) => setValue(text)}
				placeholder="Type your feedback and press Enter..."
				focused
				cursorColor="#fab283"
			/>

			<text dim>Press Enter to submit, Esc to cancel</text>
		</box>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Saved confirmation
// ────────────────────────────────────────────────────────────────────────────

function SavedStep({ onClose }: { onClose: () => void }) {
	return (
		<box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1} paddingTop={1}>
			<text bold>Feedback</text>
			<text>Thank you! Your feedback has been saved.</text>

			<input
				onSubmit={onClose}
				placeholder=""
				focused
				cursorColor="#fab283"
			/>

			<text dim>Press Enter or Esc to close</text>
		</box>
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Main feedback form (stepped)
// ────────────────────────────────────────────────────────────────────────────

type Step = "accuracy" | "harm" | "freetext" | "saved";

export function FeedbackForm({ onClose }: FeedbackFormProps) {
	const [step, setStep] = useState<Step>("accuracy");
	const [accuracy, setAccuracy] = useState<number>(0);
	const [harm, setHarm] = useState<number>(0);

	const handleAccuracy = useCallback((value: number) => {
		setAccuracy(value);
		setStep("harm");
	}, []);

	const handleHarm = useCallback((value: number) => {
		setHarm(value);
		setStep("freetext");
	}, []);

	const handleFreetext = useCallback(
		(text: string) => {
			const captured = globalThis.__arkCapturedResponse;
			if (captured) {
				saveFeedback({
					query_id: captured.queryId,
					query: captured.query,
					response_text: captured.responseText,
					retrieved_nodes: captured.retrievedNodes,
					user_rating: accuracy,
					user_harm: harm,
					user_feedback: text,
					timestamp: new Date().toISOString(),
				});
			}
			setStep("saved");
		},
		[accuracy, harm],
	);

	switch (step) {
		case "accuracy":
			return (
				<RatingStep
					question="Is this response accurate?"
					subtitle="1 = Not accurate at all, 5 = Very accurate"
					onSelect={handleAccuracy}
					onCancel={onClose}
				/>
			);
		case "harm":
			return (
				<RatingStep
					question="How likely is the response to cause clinical harm?"
					subtitle="1 = Very unlikely, 5 = Very likely"
					onSelect={handleHarm}
					onCancel={onClose}
				/>
			);
		case "freetext":
			return (
				<TextStep
					question="Please provide free text feedback about this response."
					onSubmit={handleFreetext}
					onCancel={onClose}
				/>
			);
		case "saved":
			return <SavedStep onClose={onClose} />;
	}
}
