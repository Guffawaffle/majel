# ADR-043 — Chat Run Control & Live Status UX

**Status:** Accepted  
**Date:** 2026-03-10  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect), Lex (Architecture Review)  
**Program umbrella:** #209  
**Depends on:** ADR-036 (async chat runs), ADR-037 (realtime event streaming)

---

## Context

The chat system has a fully functional async run queue (ADR-036) and
SSE event stream (ADR-037). The backend emits granular lifecycle events
(`run.queued`, `run.started`, `run.progress`, `run.completed`,
`run.failed`, `run.cancelled`, `run.timed_out`) and supports cancel
via `POST /api/chat/runs/:runId/cancel`.

The frontend ignores almost all of this. It:

- Shows bouncing dots (no text, no phase, no elapsed time)
- Listens only for terminal SSE events (`run.completed`, `run.failed`,
  `run.cancelled`, `run.timed_out`) — ignores `run.progress`
- Has no stop/cancel button despite the backend supporting it
- Has no retry/regenerate button on failed or unsatisfying responses
- Has no client-side wrapper for the cancel API endpoint

The result is an interface that feels like "submit and hope." Users
cannot tell whether a run is queued, actively generating, or stalled.
They cannot abort a wrong prompt, and they cannot retry a failed one
without retyping.

### What This ADR Does NOT Cover

**Token-by-token streaming** — incremental rendering of partial model
output — is explicitly deferred to a future ADR. That requires changes
to provider adapters, event contracts, persistence strategy, partial
markdown rendering, and cancel-after-partial semantics. Those are real
architectural questions that deserve their own design.

This ADR makes the **existing** run lifecycle visible and controllable.
Every feature here operates on infrastructure that already exists and
remains useful after streaming ships.

## Decision

### D1: Stop/Cancel Button

Replace the disabled send button during generation with an active
stop button.

**Behavior:**
- When `isSending()` is true and a `runId` is tracked, the send
  button transforms into a stop button (square icon, red accent)
- Clicking stop calls `POST /api/chat/runs/:runId/cancel`
- UI immediately shows "cancelling" state (optimistic, but reverts
  if server disagrees)
- On `run.cancelled` SSE event, the run resolves with a system
  message: "Generation stopped"

**Client API addition:**
```typescript
async function cancelRun(runId: string): Promise<void>
```

**State machine for the send/stop button:**
```
idle → [send clicked] → sending → [stop clicked] → cancelling → idle
                                 → [completed]    → idle
                                 → [failed]       → idle
```

The UI must reflect **server truth**, not just local optimistic state.
The possible run states visible in the UI are:

| State | Display | Button |
|-------|---------|--------|
| idle | Normal input | Send |
| queued | "Queued..." | Stop |
| running | "Generating..." + elapsed | Stop |
| cancelling | "Stopping..." | Disabled |
| completed | Message rendered | Send |
| failed | Error message | Send + Retry |
| cancelled | "Stopped" system message | Send |
| timed_out | Timeout error message | Send + Retry |

### D2: Live Progress Display

Replace the static bouncing dots with a live status indicator that
consumes `run.progress` SSE events.

**What to show:**
- Run state label: "Queued", "Generating...", "Stopping..."
- Elapsed time: "12s" — updated from `run.progress` event's
  `elapsedMs` field, with local timer interpolation between events
- Model name: which model is generating (useful in multi-model setup)

**What NOT to show:**
- Progress bar / percentage — there is no meaningful denominator for
  LLM generation. A fake progress bar implies predictability we don't
  have. Elapsed time is honest.
- Token count — not available without streaming. Deferred.

**Implementation:**
- `waitForRunCompletion()` gains handlers for `run.queued`,
  `run.started`, and `run.progress` events (currently ignored)
- These events update reactive state consumed by the typing indicator
- `TypingIndicator.svelte` gains props for phase/elapsed/model and
  renders them alongside the existing dots animation

### D3: Elapsed Time on Completed Messages

After a run completes, show the generation time on the message.

**Implementation:**
- `run.completed` event payload already contains timing data
  (or can be derived from `run.started` → `run.completed` delta)
- `ChatMessage.svelte` renders a subtle "8.2s" label below the
  message content for model messages that have timing data
- Only shown for model messages, not user messages or system messages

### D4: Retry / Regenerate

Add a retry button on failed and completed model messages.

**Semantics (per Lex review, pinned here):**
- Retry replays the **same user message** that preceded this response
- Uses the **currently selected model** (not necessarily the model
  that generated the original response)
- Creates a **new run** — does not mutate the old one
- The old response stays visible; the new response appears below it
- No branching, no "1 of N" selector — that's a streaming-era concern
- Retry on a failed message replaces the error with a new attempt

**UI:**
- Failed messages: "↻ Retry" button in the message footer
- Completed messages: "↻ Regenerate" button (subtle, shown on hover)
- Both buttons disabled while `isSending()` is true

### D5: Enhanced Chat State Module

The reactive chat state module (`chat.svelte.ts`) needs to track
additional state to support these features:

```typescript
// New state
let currentRunId: string | null = $state(null);
let runPhase: RunPhase = $state("idle");
let runElapsedMs: number = $state(0);
let runModel: string | null = $state(null);

type RunPhase = "idle" | "queued" | "running" | "cancelling"
              | "completed" | "failed" | "cancelled" | "timed_out";
```

The `waitForRunCompletion()` function updates this state as SSE
events arrive, and the UI components read it reactively.

### Non-Goals

- **Token streaming** — deferred to a future ADR. Explicitly out of
  scope. This ADR makes the existing batch-response lifecycle visible.
- **Message editing** — edit-and-regenerate drags in history branching
  concerns. Deferred.
- **Multi-turn branching** — "1 of N" response selectors. Deferred.
- **Syntax highlighting** — unrelated to run control. Separate issue.
- **Typewriter animation** — cosmetic effect for batch responses.
  Trivially addable later; not worth ADR scope.
- **Message feedback** — thumbs up/down quality signals. Separate
  concern.

## Phased Implementation

### Phase 1 — Stop Button + Run State (#210)

Wire the cancel API client-side, add the stop button, track run
state in the chat module.

**Files:**
- `web/src/lib/api/chat.ts` — add `cancelRun()`, handle progress
  events in `waitForRunCompletion()`
- `web/src/lib/chat.svelte.ts` — add `currentRunId`, `runPhase`,
  `runElapsedMs` state
- `web/src/components/ChatInput.svelte` — send/stop button toggle
- `web/src/components/TypingIndicator.svelte` — accept phase/elapsed
  props, render status text
- `web/src/views/ChatView.svelte` — pass run state to components

### Phase 2 — Retry + Elapsed Time (#211)

Add retry/regenerate buttons and elapsed time on completed messages.

**Files:**
- `web/src/components/ChatMessage.svelte` — retry button, elapsed
  time label
- `web/src/lib/chat.svelte.ts` — `retry(messageIndex)` function
- `web/src/lib/api/chat.ts` — timing data extraction from events

## Consequences

- Users can abort wrong prompts instead of waiting 30+ seconds
- Users can see whether a run is queued, generating, or stalled
- Users can retry failed or unsatisfying responses in one click
- Elapsed time gives operational insight into model performance
- All features use existing backend infrastructure (no new endpoints,
  no new event types, no persistence changes)
- All features remain useful after token streaming is added later
- The chat state module gains proper run lifecycle tracking, which
  streaming will build on

## Related

- ADR-036 — Durable Async Chat Run Queue
- ADR-037 — Realtime Event Streaming (SSE-first)
- ADR-041 — Multi-Provider LLM Engine
- ADR-042 — Model Availability Policy
