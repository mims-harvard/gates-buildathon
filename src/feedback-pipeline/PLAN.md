# ARK+ Feedback Pipeline — TypeScript Implementation Plan

## Architecture Decision

Instead of porting the Python pipeline as separate steps (retrieve nodes → separate LLM call → structured output), we integrate feedback directly into the existing TypeScript agent's tool loop.

**Why**: The TypeScript agent already retrieves nodes AND generates answers in one conversation. We don't need to separate them. We just give the agent access to the feedback buffer via tools.

---

## How It Works

### The existing agent loop (no changes):
1. User asks a health question in the terminal UI
2. Claude explores the KG via tool calls (findNodesByName, getNodeDetails, searchInSurroundings, etc.)
3. Claude writes an answer based on the nodes it found

### What we add:
1. **Before exploring**: Claude calls `loadFeedbackBuffer` to read all past clinician feedback
2. **Feedback is in context**: As Claude explores nodes and writes its answer, it has the feedback buffer in its conversation history (just another tool result)
3. **After the answer**: A form pops up (your friend builds this)
4. **Form submits 3 fields**: `{ rating, harm, feedback_to_response_text }`
5. **Code auto-fills 3 fields**: `{ id, question, response_text }` (already known from the conversation)
6. **`saveFeedback` is called**: Appends the full 8-field entry (6 fields + auto-added `round` + `timestamp`) to the JSONL file
7. **Next question**: Claude calls `loadFeedbackBuffer` again → sees the new entry

### Conversation context at answer time:
```
[system] Instructions + "always call loadFeedbackBuffer before answering health questions"
[user] "How does insulin help with diabetes?"
[tool_call] loadFeedbackBuffer()
[tool_result] { entries: [{id: "q0", feedback_to_response_text: "Mention insulin resistance", ...}] }
[tool_call] findNodesByName({ name: "insulin" })
[tool_result] [{ id: "12345", name: "Insulin", ... }]
[tool_call] getNeighborsByNodeId({ nodeId: "12345" })
[tool_result] ["67890", ...]
[tool_call] getNodeDetails({ nodeId: "67890" })
[tool_result] { name: "Insulin resistance", ... }
[assistant] "Insulin helps diabetes by... Importantly, insulin resistance is a key factor..."
            (↑ influenced by feedback entry q0)
```

---

## Files to Create/Modify

### NEW: `src/feedback-pipeline/types.ts`
Shared TypeScript types for the feedback system.

**Types**:
- `FeedbackFormInput` — 3 fields from the user form: `rating`, `harm`, `feedback_to_response_text`
- `FeedbackCodeInput` — 3 fields auto-filled by code: `id`, `question`, `response_text`
- `FeedbackEntry` — combined 6 fields (form + code), before storage
- `StoredFeedbackEntry` — 8 fields (6 + auto-added `round`, `timestamp`)
- `FeedbackSchemaHeader` — the `_schema` / `_guidance` header line
- `AppendResult` — return type of append function: `{ success, message, entryCount }`

---

### NEW: `src/feedback-pipeline/feedback-collection.ts`
JSONL storage backend. Direct port of Python `feedback_collection.py`.

**Functions**:

#### `appendFeedbackToBuffer(entry: FeedbackEntry, bufferPath: string, roundNum: number) → AppendResult`
- If file doesn't exist, writes schema header as first line
- Auto-adds `round` (from argument) and `timestamp` (UTC ISO, auto-generated)
- Appends full entry as new JSONL line
- Returns `{ success: true, message: "...", entryCount: N }`

#### `loadBuffer(bufferPath: string) → { entries: StoredFeedbackEntry[], schemaInfo: FeedbackSchemaHeader | null }`
- Reads the JSONL file
- Skips the schema header line (first line with `_schema` key)
- Returns all feedback entries + the schema header separately
- File doesn't exist → returns `{ entries: [], schemaInfo: null }`

**JSONL file format** (identical to Python version):
```jsonl
{"_schema": "Feedback Buffer", "_guidance": "Each entry contains: id (question id), question (the question text), response_text (the initial LLM response being evaluated), rating (1-10 quality), harm (1-10 harm scale), feedback_to_response_text (guidance for LLM on how to improve answers to similar questions), round (iteration number), timestamp (when feedback was collected). The feedback_to_response_text is ground truth guidance on how the LLM should attend to the question next time, NOT criticism of the response itself."}
{"id": "q0", "question": "How does insulin help?", "response_text": "Insulin regulates...", "rating": 7, "harm": 2, "feedback_to_response_text": "Mention insulin resistance", "round": 1, "timestamp": "2026-03-11T20:00:00Z"}
```

**Dependencies**: Node.js `fs` only.

---

### NEW: `src/feedback-pipeline/feedback-tools.ts`
Wraps the storage functions as Vercel AI SDK `tool()` objects.

**Tools**:

#### `loadFeedbackBuffer` tool
- **Description**: "Load the feedback buffer containing clinician feedback from previous rounds. Call this before answering health questions."
- **Input schema**: `{}` (no parameters — buffer path is configured at creation time)
- **Execute**: Calls `loadBuffer()`, returns the entries array
- **Agent uses this**: At the start of each question, before exploring the KG

#### `saveFeedback` tool
- **Description**: "Save clinician feedback for the current question and response."
- **Input schema**: `{ id: string, question: string, response_text: string, rating: number, harm: number, feedback_to_response_text: string }`
- **Execute**: Calls `appendFeedbackToBuffer()`, returns the result
- **Note**: The agent fills in `id`, `question`, `response_text` from conversation context. The form provides `rating`, `harm`, `feedback_to_response_text`. Your friend's form code will call this tool (or the agent calls it when given the form output).

**Factory function**: `makeFeedbackTools(bufferPath: string, roundNum: number)` → returns `{ loadFeedbackBuffer, saveFeedback }` tools with the path/round baked in.

---

### MODIFY: `src/prompts.ts`
Add feedback-aware instructions to the existing `graphAgentPrompt`.

**What to add to the prompt**:
- "Before answering health questions, call `loadFeedbackBuffer` to check for clinician feedback"
- "If feedback entries exist, consider them when exploring the KG and writing your answer"
- "Pay attention to `feedback_to_response_text` — this is ground truth guidance from clinicians"
- "Consider `rating` and `harm` scores as signals for answer quality and safety"

**What stays the same**: All existing tool descriptions and examples.

---

### MODIFY: `src/index.tsx`
Wire the feedback tools into the agent.

**Changes**:
- Import `makeFeedbackTools` from `./feedback-pipeline/feedback-tools.ts`
- In `createTransport`, create feedback tools: `const feedbackTools = makeFeedbackTools(bufferPath, roundNum)`
- Merge into existing tools: `tools: { ...graphTools, ...feedbackTools }`
- Add feedback prompt to instructions

**Configuration needed**:
- `bufferPath`: Where the JSONL file lives (default: `data/feedback_buffer.jsonl` alongside the KG data)
- `roundNum`: Current round number (could start at 1, increment based on entry count in the buffer)

---

## File Structure

```
src/feedback-pipeline/
├── PLAN.md                    ← this file
├── types.ts                   ← shared types
├── feedback-collection.ts     ← JSONL append/load (storage backend)
└── feedback-tools.ts          ← Vercel AI SDK tool() wrappers

src/prompts.ts                 ← MODIFIED (add feedback instructions)
src/index.tsx                  ← MODIFIED (wire feedback tools into agent)
```

---

## What We Are NOT Building (and why)

| Python component | Why we skip it |
|---|---|
| `run_one_question.py` (node retrieval) | The TypeScript agent already retrieves nodes via tool calls — no separate step needed |
| `ark_nodes_to_natural_language.py` (separate LLM call) | The same agent that finds nodes also writes the answer — no separate LLM call needed |
| `run_ark_plus_with_feedback.py` (CLI orchestrator) | The terminal UI is the orchestrator — no separate script needed |

---

## What Your Friend Needs to Build (the form)

**Input to the form** (what the form displays for review):
- The question that was asked
- The agent's response

**Output of the form** (3 fields the user fills in):
```json
{
  "rating": 8,
  "harm": 2,
  "feedback_to_response_text": "Should mention insulin resistance and glucagon"
}
```

**What happens after form submission**:
- Code auto-fills `id` (e.g. "q0", "q1" — incrementing counter based on buffer entry count)
- Code auto-fills `question` (from conversation context)
- Code auto-fills `response_text` (from the agent's last answer)
- Calls `saveFeedback` tool with all 6 fields
- `saveFeedback` auto-adds `round` and `timestamp`
- Entry appended to JSONL file

---

## Design Decisions Preserved from Python

1. **Feedback buffer is a flat JSONL file** — grows line by line, append-only
2. **First line is schema header** — `_schema` + `_guidance` fields
3. **6 user/code fields + 2 auto fields** — `round` and `timestamp` added by storage function, NOT by form or agent
4. **Feedback entry schema identical** — `id`, `question`, `response_text`, `rating` (1-10), `harm` (1-10), `feedback_to_response_text`
5. **LLM sees all past feedback** — loaded fresh each question via tool call
6. **LLM provider**: Claude via existing `@ai-sdk/anthropic` (already in deps, API key already configured)
