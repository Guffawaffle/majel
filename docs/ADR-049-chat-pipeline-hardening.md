# ADR-049: Chat Pipeline Hardening

**Status:** Accepted  
**Date:** 2026-03-21  
**Tracks:** [#250](https://github.com/Guffawaffle/majel/issues/250)

## Context

After the 2026-03-21 production incident (stale Gemini context cache causing 403 on all chats) and the subsequent empty-answer/missing-trace fixes, a full audit of the chat pipeline revealed several additional gaps. These are all variants of the same root theme: **the chat pipeline was built incrementally across many PRs without end-to-end hardening of every code path**.

This ADR documents the issues, organizes them into implementation phases, and records the "what and why" for each fix.

---

## Architecture Overview (for reference)

```
POST /api/chat
  → 202 + runId (queued in chat_runs table)
  → claimAndProcessOne (1s poll, FOR UPDATE SKIP LOCKED)
    → processClaimedRun
      → executeChatRun
        → geminiEngine.chat()
          → sendMessage (initial)           ← cache-retry ✅ (fixed 2026-03-21)
          → handleFunctionCalls (tool loop)  ← cache-retry ❌ (gap #1)
            → sendMessage (tool responses)
            → sendMessage (fallback summary)
          → microRunner.validate → repair   ← cache-retry ❌ (gap #4)
            → sendMessage (repair prompt)
        → emit run.completed / run.failed
  → SSE /api/events/stream (1s poll, 3-min lifetime)
    → client waitForRunCompletion
      → listeners: run.completed, run.failed, run.cancelled, run.timed_out
      → missing: run.budget_exceeded  ← gap #3
      → onerror → readRunSnapshot (single-shot fallback)
```

The numbers on the right correspond to the issue items in #250.

---

## Phase 1 — Cache-Expiry Resilience (Same Root Cause as Outage)

**Priority: High — prevents repeat outages**

### 1a. Tool-loop `sendMessage` calls (#250 item 1)

**What:** `handleFunctionCalls()` calls `chat.sendMessage()` twice — once per tool round (line ~662) and once in the fallback summary path (line ~723). Neither call is wrapped with the `isCacheExpiredError` / `handleCacheExpiry` retry pattern.

**Why it matters:** If the context cache expires mid-tool-loop (e.g., a multi-round tool interaction that starts at minute 59 of the 1-hour TTL), the 403 bubbles up as a generic `GEMINI_ERROR`. The user sees "AI request failed" with no indication that a retry would succeed.

**Fix:** Extract a helper `sendWithCacheRetry(session, chat, messageParts, label)` that wraps `sendMessage` + the cache-expiry catch/retry. Use it in:
- `handleFunctionCalls` tool response send (line ~662)
- `handleFunctionCalls` fallback summary send (line ~723)
- The existing micro-runner and standard entry points (refactor to use the same helper)

**Risk:** Low. The retry simply clears `cachedContentName`, rebuilds config inline, recreates the session `Chat`, and retries once. This is the same pattern already proven in the initial fix.

### 1b. MicroRunner repair `sendMessage` (#250 item 4)

**What:** The repair pass at line ~860 calls `session.chat.sendMessage()` directly — no `withRetry()` wrapper, no cache-expiry handling.

**Why it matters:** A transient 429/503 during repair crashes the entire run. A cache expiry during repair also crashes. Both are fixable with the same `sendWithCacheRetry` helper.

**Fix:** Wrap the repair `sendMessage` with `sendWithCacheRetry`. This is a one-line change once the helper exists from 1a.

**Risk:** Low. Repair is a single-shot call that already tolerates failure (the response is disclaimed if repair fails).

---

## Phase 2 — Client Event Handling Gaps

**Priority: Medium — prevents confusing UX on specific failure modes**

### 2a. Budget enforcement simplified — gate-only, never kill in-flight (#250 item 3)

**What:** The original `checkBudget` had a "cleanup buffer" concept (`getCleanupBufferPct`) that tried to predict whether a message would exceed the budget and allow "one final message" within a buffer zone. This was:
- Broken (the `getCleanupBufferPct` function was never defined — compile error)
- Wrong in principle — you can't predict how many tokens a message will use, and a percentage buffer is arbitrary

**Design principle:** Budget is a **gate on new messages**, never a kill switch on in-flight ones. If the user has budget remaining when they send a message, that message completes — period. Even if it uses 10x the remaining budget. We never waste someone's credits and return nothing.

**Fix:** Simplified `checkBudget` to a pure entry gate:
- `consumed >= dailyLimit` at pre-flight → throw `TokenBudgetExceededError` (blocks the message)
- `consumed < dailyLimit` at pre-flight → let it through, full completion guaranteed
- Removed `lastCall` field from `BudgetStatus` (cleanup buffer concept eliminated)
- Warning zone (`budgetWarning`) retained as a UI hint only

The `run.budget_exceeded` SSE event remains as a diagnostic signal. The `run.failed` event from `executeChatRun`'s catch path already carries the `TokenBudgetExceededError.message` with budget details, so the client gets a descriptive error via the existing `run.failed` listener.

**Risk:** A user right at the limit could send a message that costs 50K tokens on a 50K budget, going 50K over. This is acceptable — the alternative (killing their in-flight chat and wasting the tokens they already spent) is worse. The next message will be blocked.

### 2b. `run.cancelled` and `run.timed_out` don't use `ChatError` (#250 item supplemental)

**What:** The SSE listeners for `run.cancelled` and `run.timed_out` throw plain `Error` objects, not `ChatError`. This means cancelled/timed-out messages won't carry an Admiral trace.

**Why it matters:** Admirals expect trace data on every chat outcome for debugging. Cancelled and timed-out runs have no trace in the error message.

**Fix:** Change the `run.cancelled` and `run.timed_out` listeners to:
1. Parse the event payload for trace data (same pattern as `run.failed`).
2. Throw `ChatError(msg, trace)` instead of `Error(msg)`.

Also update `readRunSnapshot` — it already uses `ChatError` for these paths (good), but verify the trace is extracted from the snapshot response.

**Risk:** Very low. `ChatError` extends `Error`, so all catch blocks that handle `Error` still work.

---

## Phase 3 — Timing & Architectural

**Priority: Low — correctness under edge conditions**

### 3a. SSE 3-minute lifetime vs. 5-minute run timeout (#250 item 5)

**What:** `SSE_MAX_LIFETIME_MS = 3 * 60 * 1000` but `RUN_TIMEOUT_MS = 5 * 60 * 1000`. For runs taking 3-5 minutes (multi-round tool calls on thinking models), the SSE stream is server-terminated before the run completes. The client's `onerror` fires → `readRunSnapshot` is called once → if the run is still `"running"`, the snapshot returns `answer: null` → client throws "Chat run did not return an answer".

**Why it matters:** Legitimate long-running chats (5+ tool rounds on gemini-2.5-pro) will fail at the client even though the server eventually produces a valid answer.

**Fix:** Extend `SSE_MAX_LIFETIME_MS` to `6 * 60 * 1000` (6 minutes) — safely beyond `RUN_TIMEOUT_MS`. This is a one-constant change with no side effects. The SSE stream is already cleaned up on terminal events, so extending the max lifetime only affects the rare case where neither terminal event nor client disconnect happens.

**Risk:** Negligible. Orphaned SSE streams are already cleaned up by `req.on("close")` and `req.on("aborted")`. The lifetime cap is a safety net, not a primary cleanup mechanism.

### 3b. Tool-loop timeout timer (#250 item 6)

**What:** The `Promise.race` pattern in the tool loop creates a `setTimeout` that fires even after `sendMessage` resolves. The reject callback runs on a settled promise (harmless) but the timer stays alive for up to 30 seconds per round.

**Why it matters:** Cosmetic. Not a real leak (timers fire once and are GC'd), but it's a code smell that's trivially fixable.

**Fix:** Clear the timeout on success using `AbortController` or a manual clearTimeout ref.

**Risk:** None.

---

## Phases Not Planned (Documented for Future Reference)

### `processClaimedRun` blocking pattern (#250 item 2)

**What:** `claimAndProcessOne` awaits `processClaimedRun`, which blocks the function for up to 5 minutes. The `claimInFlight` flag is released before the await, so the 1s interval can fire new claims — but each invocation of `claimAndProcessOne` is serialized by the interval (only one runs at a time since it's fire-and-forget via `void claimAndProcessOne()`).

**Why this is OK:** The `RUNNING_RUNS_MAX = 10` cap with the size check at the top of `claimAndProcessOne` means parallel execution IS possible — the interval fires every 1s, and if the previous invocation completed its claim DB ops (releasing `claimInFlight`) but is still awaiting `processClaimedRun`, the next interval invocation can proceed through the capacity check and claim another run. This is actually working as designed.

**Decision:** No change. The pattern is correct. Document it here so future readers don't "fix" it.

### Empty text from tool loop (#250 item 7, history guard)

**What:** `handleFunctionCalls` can return empty text if the model produces no text after tool responses. This cascades into the empty-answer throw in `executeChatRun`.

**Why this is OK now:** The empty-answer throw (added 2026-03-21) catches this case and emits `run.failed` with `EMPTY_ANSWER`. The user gets a clear error. Previously, empty text was stored in history — now it's not (the throw prevents reaching the history recording code).

**Decision:** No additional change needed. The empty-answer guard is sufficient.

---

## Implementation Order

```
Phase 1a → 1b → 2a → 2b → 3a → 3b → CI
```

Phases 1a and 1b are the same pattern, 1b is trivial once 1a introduces the helper.
Phase 2 is client-only changes.
Phase 3 is constant tweaks.

All phases are independent and can be verified incrementally.
