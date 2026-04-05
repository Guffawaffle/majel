# ADR-049: Chat vs Start/Sync Boundary

**Status:** Accepted (all slices shipped, #257 closed)  
**Date:** 2025-07-19  
**Supersedes:** none  
**Related:** ADR-016 (catalog-overlay), ADR-026b (safe mutation proposal-apply), Launch-Contract v0.1  

---

## Context

Following the tool-mode classifier work (30 tests, deployed `majel-00117-w6r`), local smoke testing exposed a secondary integration path where the classifier's `"none"` return was not reliably reaching the engine trace. Rather than continue heuristic tuning, we are redefining the product boundary to eliminate the failure class entirely.

The core insight: **the classifier was solving the wrong problem.** Instead of asking "should this pasted data get tools?", we should be asking "should Chat ever be the place where bulk data commits happen?"

The answer is no.

---

## Decision

### Boundary Rule

| Surface | Handles | Examples |
|---------|---------|----------|
| **Chat** | Atomic, user-confirmed fleet mutations against known entities. Advisory queries. Transient analysis of pasted data. | "My Enterprise is level 45" (auto), "I got the Vidar" (confirm), "Who should I crew the Botany Bay with?", "Parse this roster and show me what you see" |
| **Start/Sync** | Bulk, dataset-shaped, reconciliation-heavy updates. Import artifacts. | CSV upload, roster screenshot scan, pasted officer list → commit, spreadsheet import |

Chat may *read and analyze* pasted data transiently (e.g., "what's in this roster?"). Chat must **never silently commit bulk data** to the fleet overlay. If a user pastes 50 officers into Chat, Majel can discuss them, but writing them to owned state belongs to Start/Sync.

### Governing Principles

1. **Chat does not become a second bulk import lane.** No hidden second importer.
2. **Ambiguity defaults to safe.** If it's unclear whether a request is atomic or bulk, Chat should not mutate state.
3. **Explicit rules, not vibes.** The boundary is defined by countable signals, not sentiment analysis.
4. **Atomic means one entity, one field, user-initiated.** "My Enterprise is level 45" = one mutation. "Update all my officers" = not atomic.
5. **The classifier simplifies, not complicates.** The tool-mode heuristic becomes narrower because we've removed bulk-commit from Chat's responsibility.
6. **Enforcement is server-side, not model-side.** Boundaries that matter must be enforced in code, not by prompt instructions the model may ignore.

---

## 1. Mutation Model

### Current State

The mutation surface today has three layers:

- **Auto-trust tools** (`set_officer_overlay`, `set_ship_overlay`, `create_target`, etc.): Execute immediately during Chat. No preview, no confirmation.
- **Approve-trust tools** (`sync_overlay`, `create_loadout`, `create_bridge_core`, etc.): Staged as `MutationProposal` → user confirms → apply.
- **Block-trust tools** (`activate_preset`): Require explicit unlock before use.

### Proposed Change

Under the new boundary, **Chat mutations are split into two tiers based on risk**:

```
Tier 1 — Safe auto-apply (Chat, no confirmation):
  - Exactly 1 entity that already exists in the user's fleet
  - Mutation is a property update on a known field (level, tier, rank, power)
  - Entity is already in owned state — no ownership transition
  - Examples: "My Enterprise is level 45", "Set my Vidar tier to 4", "My Chen is rank 5"

Tier 2 — Lightweight confirm/apply (Chat, single-step confirmation):
  - Ownership creation: "I got the Vidar", "I got officer Chen"
  - Instance creation: "I got another K'Vort" (once ADR-050 lands)
  - These create owned-state or new instances — not just property updates
  - Uses the existing proposal-apply flow (ADR-026b) with approve-trust
  - Engine stages as proposal → response includes confirmation card → user confirms

Batch mutation (Start/Sync only):
  - 2+ entities from a single user action
  - Data is dataset-shaped (tabular, list, CSV)
  - Operation is reconciliation (diffing user state against pasted/uploaded data)
  - Examples: "Here's my roster", "Import this CSV", screenshot scan

Structural mutation (proposal-required, either surface):
  - BridgeCore, Loadout, Variant, Dock assignments
  - Remain approve-trust with proposal-apply flow (ADR-026b)
  - Chat generates proposal → user confirms → apply
```

### Why Two Tiers for Chat Atomics

"I got the Vidar" is not a property update — it creates owned-state. "I got another K'Vort" creates an entirely new instance. These deserve a confirmation step because:
- The user might have misspoken or Majel might have misheard the entity name
- Ownership creation is harder to undo than a level change (it affects fleet advice immediately)
- Instance creation (post ADR-050) produces a new persistent record, not a field update

Property updates on already-owned entities ("my Enterprise is level 45") are safe to auto-apply because the entity is known, the field is bounded, and the worst case is a correctable number.

### Proposal Envelope

No change to the existing `MutationProposal` shape. The envelope already supports batch items and receipt linkage. The boundary change is about **which surface can create proposals containing bulk items**, not the proposal format itself.

```typescript
// Existing — unchanged
interface MutationProposal {
  id: string;
  userId: string;
  tool: string;
  argsJson: unknown;
  argsHash: string;
  proposalJson: unknown;
  batchItems?: BatchItem[];
  status: "proposed" | "applied" | "declined" | "expired";
  expiresAt: string;
  appliedAt?: string;
  appliedReceiptId?: number;
}
```

Chat-originated proposals are limited to single-item structural mutations. Bulk proposals are created only by Start/Sync routes (`/api/fleet/scan/commit`, `/api/import/commit`).

---

## 2. Confirmation Model

### Three Confirmation Tiers

| Tier | Trust | Confirmation | Example |
|------|-------|--------------|---------|
| Safe auto-apply | auto | None — conversational ack is the confirmation | "My Enterprise is level 45" → Majel updates and confirms inline |
| Lightweight confirm | approve | Single-step proposal card | "I got the Vidar" → Majel shows "Add Vidar to your fleet?" card → user confirms |
| Structural mutation | approve | Proposal preview + modal (ADR-026b) | "Create a loadout for my Botany Bay" → full preview card → confirm |
| Bulk commit | N/A | Not available in Chat — Start/Sync only | "Import this roster" → handoff card |

**Safe auto-apply** uses the current auto-trust path. The conversational context *is* the confirmation: the user stated a fact, Majel updated a known field on a known entity, response confirms what happened. No new UX needed.

**Lightweight confirm** reuses the existing proposal-apply flow from ADR-026b but with a lighter-weight presentation. The engine stages the ownership/instance creation as a proposal instead of executing immediately. The response includes a compact confirmation card (not a full preview modal). This prevents:
- Accidental owned-state creation from a misheard entity name
- Silent instance creation once ADR-050 lands
- The "I got the Vidar" → immediate execution path that skips any verification

The proposal-apply flow is already built. The only change is moving `set_officer_overlay` and `set_ship_overlay` from auto-trust to approve-trust **when the operation creates new owned-state** (i.e., when the overlay row does not already exist for that user+ref).

**Structural mutations** use the full ADR-026b proposal-apply flow unchanged.

### Trust Reclassification

```typescript
// Current: set_officer_overlay and set_ship_overlay are always auto-trust.
// Proposed: auto-trust for updates, approve-trust for creation.
//
// The trust resolver needs one additional signal: is this an update or a create?
// The tool execution path already knows this (it checks for existing overlay).
// If no existing overlay → stage as proposal instead of executing.
```

### What about "update all my Klingon officers to owned"?

This is a gray area under the old design. Under the new boundary: Chat can *describe* what would change ("I see 12 Klingon officers you haven't marked as owned"), but the actual commit is handed off to Start/Sync via a structured handoff (see Section 6). Chat generates a handoff card, not a proposal.

---

## 3. Boundary Classifier

### Replacing the Heuristic with Explicit Rules

The current `classifyToolMode()` function tries to decide fleet vs. none based on regex patterns. Under the new boundary, the classifier's job simplifies:

**Chat tool mode is always "fleet"** for normal messages. The classifier's bulkdetection logic (`hasStructuredData`, `LARGE_PAYLOAD_THRESHOLD`) becomes a **commit-gate**, not a tool-mode gate.

Revised classification:

```
Input signals:
  S = hasStructuredData(message)     // 5+ CSV-like lines
  T = TRANSFORM_INTENT.test(message) // parse, extract, import, etc.
  I = hasImage                       // screenshot attached
  L = message.length > 2000          // large payload

Decision:
  1. Image + transform intent (I ∧ T)  → toolMode = "none"
     Reason: screenshot extraction, no fleet lookups needed

  2. Structured + large (S ∧ L)         → toolMode = "none"
     Additionally: set chatContext.bulkDetected = true
     Reason: pasted roster/CSV — Chat can analyze but not commit

  3. Structured + transform (S ∧ T)     → toolMode = "none"
     Additionally: set chatContext.bulkDetected = true
     Reason: explicit extraction/transform request

  4. Everything else                    → toolMode = "fleet"
     Reason: normal advisory query or atomic mutation
```

When `bulkDetected` is true, the engine enforces the boundary **server-side**:

1. **Tool stripping**: Mutation tool declarations (`set_officer_overlay`, `set_ship_overlay`, `sync_overlay`, and any tool matching `isMutationTool()`) are removed from the tool config passed to the model. The model literally cannot call them — they do not exist in its tool list for this request.
2. **System prompt addendum**: The system prompt also gets an instruction explaining why and offering the handoff:
   > "The user has pasted structured fleet data. Analyze and discuss it freely. Mutation tools are not available for this request. If the user wants to save this data to their fleet, direct them to the Import feature in Start/Sync."

The prompt instruction is belt; the tool stripping is suspenders. Either one alone would probably work, but a boundary this central should not depend on model obedience.

This is more reliable than a prompt-only gate because:
- Server-side tool stripping is deterministic — no model can cross a boundary that isn't in its tool list
- The prompt instruction provides the model with a helpful explanation so its response is coherent
- The bulk-commit gate is a separate, testable flag — not tangled into the tool-mode decision

### Explicit Rules (the user asked for these, not vibes)

| User says | Structured? | Transform? | Result | Why |
|-----------|------------|------------|--------|-----|
| "I got the Vidar" | No | No | fleet, no bulk flag | Atomic mutation, 1 entity (Tier 2: lightweight confirm) |
| "My Enterprise is level 45" | No | No | fleet, no bulk flag | Atomic property update |
| "Who should I crew the Botany Bay with?" | No | No | fleet, no bulk flag | Advisory query |
| "Parse this: [50 officers CSV]" | Yes | Yes | none, bulk=true | Transform request with structured data |
| "Here are my officers: [20 rows]" | Yes | No | fleet if <2000 chars / none+bulk if ≥2000 | Depends on size — small lists stay in fleet for discussion |
| [screenshot] "extract my officers" | Image | Yes | none | Multimodal extraction |
| "Update all my officers from this list" | Yes | Yes | none, bulk=true | Bulk intent — Chat analyzes, Start/Sync commits |
| "Tell me about the USS Franklin" | No | No | fleet, no bulk flag | Knowledge query |
| "Compare the K'Vort and the Vi'dar" | No | No | fleet, no bulk flag | Advisory query |

---

## 4. Instance Modeling

### The Gap

Launch-Contract v0.1 §3 requires: "a player can own two copies of the same ship type". The current overlay schema uses `PRIMARY KEY (user_id, ref_id)` — one instance per ship per user. "I got another K'Vort" should create a new owned instance, not increment a fuzzy count.

### Impact on This ADR

Instance modeling is **orthogonal to the Chat/Sync boundary** but will affect both surfaces when implemented:

- **Chat atomic mutation**: "I got another K'Vort" must create a *new* instance, not upsert the existing one. This requires the chat mutation tools to accept an optional `instance_id` or auto-generate one.
- **Start/Sync**: Bulk import must reconcile against existing instances without collapsing duplicates. The scan/commit flow already writes `ON CONFLICT(user_id, ref_id) DO UPDATE` — this must change to allow conflict-free insert of new instances.

### Recommended Schema Direction

```sql
-- Migration: add instance_id to overlay tables
ALTER TABLE ship_overlay
  DROP CONSTRAINT ship_overlay_pkey,
  ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'primary',
  ADD CONSTRAINT ship_overlay_pkey PRIMARY KEY (user_id, ref_id, instance_id);

-- Existing rows get instance_id = 'primary' (the default)
-- New instances get a generated ID: 'inst_' + nanoid(8)
```

This is a separate ADR (ADR-051 candidate) and a separate implementation slice. Mentioned here because it affects the mutation tools Chat will call.

---

## 5. Catalog vs Fleet Boundary

### Current State (from ADR-016)

- **Catalog** = `reference_officers`, `reference_ships` — static game data, versioned bulk-load, not user-owned
- **Fleet** = `officer_overlay`, `ship_overlay` — per-user owned state layered on catalog
- **Joined view** = catalog ∪ overlay, assembled at query time

### What This ADR Clarifies

Chat tools operate on the **fleet layer only**. Chat never modifies the catalog. This is already true in practice but worth stating explicitly:

- `set_officer_overlay` / `set_ship_overlay` → fleet layer (auto-trust)
- `sync_overlay` → fleet layer (approve-trust, bulk)
- `get_officer` / `get_ship` / `search_officers` → catalog+fleet joined view (read-only)

Start/Sync also operates on fleet only. Catalog updates are an admin-only operation via the reference store bulk loader.

No change needed here — just documenting the existing boundary for clarity.

---

## 6. Failure/Recovery for Bulk-in-Chat

### The Eliminated Failure Class

Under the old design, pasting 50 officers into Chat could:
1. Trigger fleet tool mode → model tries to serialize entire roster as tool args → `MALFORMED_FUNCTION_CALL`
2. Trigger toolless mode via classifier → model processes fine but has no way to commit results
3. On retry, the malformed fallback strips tools and succeeds — but the user experience is degraded

Under the new boundary, case (1) is still prevented by the classifier (structured+large → none), but **case (2) is now the correct and complete behavior**. Chat analyzes and discusses. There is no "now how do I commit this?" problem because Chat was never going to commit it.

### Remaining Failure Modes

- **Atomic mutation fails** (e.g., `set_ship_overlay` → DB error): Existing retry + error reporting. No change.
- **User pastes data and asks to commit it via Chat**: Mutation tools are already stripped (Section 3). Majel's response includes a **structured handoff payload** — not just generated prose. See below.
- **Malformed function call on a non-bulk request**: The existing retry-with-stripped-tools fallback (from the tool-mode work) is preserved as a safety net.

### Structured Handoff (not prose)

When `bulkDetected` is true and the model's response discusses pasted data, the engine appends a structured handoff card to the response payload:

```typescript
interface HandoffCard {
  type: "sync_handoff";
  target: "start_sync";        // which surface to link to
  route: "/start/import";       // deeplink path
  summary: string;              // e.g., "47 officers detected in pasted data"
  detectedEntityCount?: number; // from the classifier or model response
}
```

The frontend renders this as a card with a link/button to Start/Sync import. This is a **code path**, not a model behavior:
- The engine always appends the handoff card when `bulkDetected && toolMode === "none"`
- The model does not need to "remember" to suggest Start/Sync — the card is injected server-side
- The model's prose response provides analysis; the handoff card provides the action

This eliminates the risk of the model forgetting to mention Start/Sync, giving a vague suggestion, or inventing a non-existent route.

### What Carries Forward

The malformed-function-call fallback (`isMalformed → retryToolMode = "none"`) is still valuable as a second line of defense for edge cases that slip through the classifier. Keep it.

---

## 7. Community Mod Relationship

### Current State

Community mods (e.g., STFC roster export tools) produce structured data in known formats. The current import routes (`/api/import/analyze`, `/parse`, `/resolve`, `/commit`) handle this.

### Under the New Boundary

Community mod data is always a **Start/Sync concern**:
- It's bulk, dataset-shaped, requires reconciliation
- Import routes remain the ingestion path
- Chat never processes community mod data for commit

Chat's role with community mod data is limited to:
- "What format does [mod name] export?" (advisory, catalog knowledge)
- "I pasted my mod export — what do you see?" (transient analysis, no commit)

### Community Mod Import as Launch Accelerator

Per Launch-Contract v0.1 §Should-have-1: community mod ingestion is an "optional accelerator, not the backbone." This ADR doesn't change that status. Start/Sync owns the import path; Chat stays out of it.

---

## Implementation Slices

### Slice 0: Cleanup (immediate) ✅

1. Remove 9 lines of debug logging from `chat.ts`, `index.ts`, `tool-mode.ts` — done
2. The classifier code, malformed-function-call fallback, and 30 tests from the prior session are **kept** — they are correct and carry forward under the new boundary

### Slice 1: Server-Side Bulk-Commit Gate (smallest high-value step)

**Goal:** When Chat detects bulk structured data, enforce the boundary in code: strip mutation tools from the model's tool list and append a structured handoff card to the response.

Changes:
1. **`tool-mode.ts`**: Widen classifier return type to include `bulkDetected`
   ```typescript
   interface ToolModeResult {
     mode: ToolMode;
     bulkDetected: boolean;
   }
   ```
2. **`chat.ts`**: Pass `bulkDetected` through to engine
3. **`index.ts` (engine)**: When `bulkDetected`:
   - Filter mutation tools out of the tool declarations passed to `generateContent` / `sendMessage` (use existing `isMutationTool()` as the filter predicate)
   - Append system prompt addendum explaining why and mentioning Start/Sync
   - After model response, append `HandoffCard` to the `ChatResult` payload
4. **`ChatResult` type**: Add optional `handoff?: HandoffCard` field
5. **Tests**: Cases for tool stripping (mutation tools absent from config), handoff card presence, and model receiving only read-only tools when `bulkDetected`

**Why this is the right first slice:**
- Server-side enforcement — the model cannot call tools that aren't in its tool list
- Structured handoff — frontend gets a typed card, not model-generated prose
- Small surface area — `isMutationTool()` already exists, just need to use it as a filter
- Fully testable without model calls (tool list filtering is deterministic)

### Slice 2: Ownership Confirmation Split

**Goal:** `set_officer_overlay` and `set_ship_overlay` become approve-trust when creating new owned-state (overlay row does not exist for user+ref). Remain auto-trust for property updates on existing overlays.

Changes:
1. **`trust.ts`**: `getTrustLevel` accepts an optional `isCreate` flag. When `isCreate && toolName ∈ {set_officer_overlay, set_ship_overlay}`, return `"approve"` instead of `"auto"`
2. **Tool execution path**: Before executing `set_*_overlay`, check whether the overlay exists. Pass `isCreate` to trust resolution.
3. **Frontend**: Render lightweight confirmation card for ownership creation proposals (reuse existing proposal card, lighter styling)
4. **Tests**: Cases for update-vs-create trust resolution

### Slice 3: Instance Modeling (separate ADR)

`(user_id, ref_id, instance_id)` composite key migration. Affects both Chat mutation tools and Start/Sync import. Should be its own ADR (ADR-051 candidate) with its own migration and test plan. Until this lands, "I got another K'Vort" will upsert the existing instance — the trust split from Slice 2 at least ensures the user confirms before that happens.

---

## What Carries Forward From the Tool-Mode Work

| Artifact | Status | Action |
|----------|--------|--------|
| `classifyToolMode()` function | Correct | Keep — classifier logic is sound, boundary just layered on top |
| `hasStructuredData()` | Correct | Keep — used by both tool-mode and bulk-detect |
| 30 tool-mode tests | Passing | Keep — they validate the classifier behavior we're building on |
| Malformed-function-call fallback | Correct | Keep — second line of defense |
| Debug logs (9 lines, 3 files) | Dirty | Remove in Slice 0 |
| Classifier-to-engine trace bug | Unresolved | Deprioritized — the server-side tool stripping (Slice 1) makes this less critical because even if the classifier-to-engine path has an execution inconsistency, mutation tools are physically absent from bulk-detected requests. If it recurs as a user-facing issue on non-bulk requests, investigate then. |

---

## Anti-Goals

1. **No giant UI toggle** between "Chat mode" and "Import mode" — the boundary is enforced server-side by the classifier + tool stripping.
2. **No hidden second importer** — Start/Sync owns import, Chat owns conversation.
3. **No complex NLP intent classification** — the boundary is defined by structural signals (CSV rows, message length, image presence), not by parsing natural language intent.
4. **No retroactive commits** — Chat cannot "remember" a pasted roster from a previous message and commit it later. Each message is classified independently.
5. **No prompt-only enforcement for structural boundaries.** Prompt instructions explain behavior to the model; server-side tool stripping enforces it. Both are present, but enforcement does not depend on model compliance.
