# ADR-026b — Safe Mutation Contract: Proposal → Confirm → Apply

**Status:** Accepted  
**Date:** 2026-02-19 (proposed), 2026-02-21 (accepted — Phase 1 implemented)  
**Authors:** Guff, Copilot (planning pass)  
**Amends:** ADR-026, ADR-026a  
**Related:** ADR-025, ADR-028, #93

---

## Context

Majel now supports increasingly expressive natural-language mutation inputs (including bulk updates). This improves usability but increases risk when model interpretation is stochastic.

Current mutation flows can apply writes directly (`dry_run=false`) when tool calls execute. For high-impact updates, we need an explicit user-confirmation gate that is enforced by backend state, not by model behavior.

Goal: preserve fast AI-assisted planning while making writes deterministic, reviewable, and auditable.

---

## Decision

Adopt a mandatory two-step mutation contract for high-impact tool writes:

1. **Proposal step (non-mutating)**
   - Tool produces normalized changeset preview and risk metadata.
   - Backend stores proposal and returns immutable `proposal_id`.
2. **Apply step (mutating)**
   - UI sends explicit user approval for that exact proposal.
   - Backend validates proposal integrity and applies transaction.

The user interaction contract is always:

- Show modal: **"The following changes will be made"**
- Actions: **Accept** / **Decline**
- No mutation occurs before Accept

---

## Scope (initial)

### In scope (Phase 1)
- `sync_overlay` proposal/apply support.
- Proposal persistence, expiry, and status transitions.
- UI confirm/decline wiring.
- Receipt linkage (`proposal_id` reference).

### Out of scope (Phase 1)
- Full generic abstraction for every mutation tool.
- Auto-approval policy engine.
- Cross-session collaborative approvals.

---

## API Contract

### Option A (preferred): explicit proposal APIs

- `POST /api/mutations/proposals`
  - Input: `{ tool, args, user_context }`
  - Behavior: runs tool in proposal mode only
  - Output: `{ proposal_id, tool, summary, changes_preview, risk, expires_at }`

- `POST /api/mutations/proposals/:id/apply`
  - Input: `{ confirmation_token? }`
  - Behavior: validates + applies transaction
  - Output: `{ applied: true, receipt_id, proposal_id }`

- `POST /api/mutations/proposals/:id/decline`
  - Input: `{ reason? }`
  - Behavior: marks proposal declined; no write
  - Output: `{ declined: true, proposal_id }`

### Option B (compatible): mode in existing tool calls

- Existing mutation tools accept:
  - `mode: "plan" | "apply"`
  - `proposal_id` (required when `mode="apply"`)

Option A is easier to reason about in UI and audit logs. Option B is acceptable for incremental rollout.

---

## Proposal Schema

```json
{
  "proposal_id": "mutp_01K3...",
  "tool": "sync_overlay",
  "tool_args_hash": "sha256:...",
  "status": "proposed",
  "risk": {
    "level": "low|medium|high",
    "bulk_count": 42,
    "high_impact": true,
    "reasons": ["bulk_ship_updates", "manual_text_parse"]
  },
  "summary": {
    "officers": { "changed": 10 },
    "ships": { "changed": 20 },
    "docks": { "changed": 2 }
  },
  "changes_preview": {
    "officers": [],
    "ships": [],
    "docks": []
  },
  "warnings": [],
  "created_at": "2026-02-19T00:00:00Z",
  "expires_at": "2026-02-19T00:15:00Z"
}
```

---

## Persistence Model

Create `mutation_proposals`:

```sql
CREATE TABLE mutation_proposals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  tool TEXT NOT NULL,
  args_json JSONB NOT NULL,
  args_hash TEXT NOT NULL,
  proposal_json JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'applied', 'declined', 'expired')),
  decline_reason TEXT,
  applied_receipt_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  applied_at TIMESTAMPTZ,
  declined_at TIMESTAMPTZ
);

CREATE INDEX idx_mutation_proposals_user_created
  ON mutation_proposals(user_id, created_at DESC);
```

---

## Args Hash Canonicalization

`args_hash` is computed as `sha256:<hex>` over a deterministic JSON serialization of the tool arguments:

```typescript
const canonical = JSON.stringify(args, Object.keys(args).sort());
const hash = `sha256:${crypto.createHash("sha256").update(canonical).digest("hex")}`;
```

Key-ordering via `Object.keys(args).sort()` ensures the hash is stable regardless of property insertion order. Nested objects are serialized as-is (JSON.stringify handles them deterministically when keys are sorted at the top level). If deep key-order stability is needed in the future, use a recursive key-sort utility.

---

## Validation Rules (hard requirements)

- Reject apply if proposal is not `proposed`.
- Reject apply if expired.
- Reject apply if `args_hash` mismatch.
- Reject apply if `schema_version` doesn't match the current handler version.
- Reject apply if proposal belongs to another user.
- Enforce single apply (idempotent against duplicates).
- On successful apply:
  - write receipt
  - set status `applied`
  - store `applied_receipt_id`

---

## UI Contract

For proposal-capable mutation tools:

1. Show preview card + modal with grouped changes.
2. Show risk badge (Low / Medium / High).
3. Accept triggers `apply`.
4. Decline triggers `decline`.
5. Expired proposal shows refresh action (regenerate proposal).

Accessibility and UX constraints:
- No auto-apply for high-risk proposals.
- Confirm buttons require explicit click/tap (no implicit Enter auto-submit on open).
- Display warnings prominently above action buttons.

---

## Model Compatibility

This design is model-agnostic and compatible with fast stochastic models (including Gemini 2.5 Flash class) because mutation safety is enforced by backend validation and explicit UI confirmation.

---

## Rollout Plan

### Phase 1 — `sync_overlay`
- Add proposal generation path.
- Add proposal apply/decline endpoints.
- Wire modal in Start/Sync + chat mutation flows.

### Phase 2 — Generalize
- Move proposal/apply helper into shared mutation service.
- Adopt for other high-impact tools (future inventory sync/import tools).

---

## Acceptance Criteria

- `sync_overlay` supports proposal-only generation with no writes.
- Apply requires valid unexpired proposal ID and user match.
- Decline performs no writes and records status.
- Receipt includes `proposal_id` linkage.
- Tests cover tampered, expired, cross-user, and duplicate-apply scenarios.

---

## References

- ADR-026
- ADR-026a (A5)
- ADR-028
- Issue #93