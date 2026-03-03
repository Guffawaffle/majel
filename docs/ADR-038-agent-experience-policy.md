# ADR-038: Agent Experience Policy (Identity, Source Trust, Memory, Prediction, Corrections)

**Status:** Accepted  
**Date:** 2026-03-03  
**Authors:** Guff, GitHub Copilot (GPT-5.3-Codex)  
**References:** ADR-003 (epistemic framework), ADR-007 (fleet management), ADR-014 (MicroRunner), ADR-021 (postgres frame store), ADR-024 (lex memory tab), ADR-036 (async chat runs), ADR-037 (SSE)

---

## Context

Majel now supports a strong operational core, but agent experience still has avoidable friction in day-to-day use:

- Identity can drift unless explicitly anchored (Ariadne persona vs Majel project lineage).
- External guidance can over-index on unverified or risky acquisition channels.
- Episodic continuity is useful but still requires too much repeated user context.
- Coaching is mostly static countdowns instead of confidence-based planning.
- Model corrections are accepted conversationally but not yet formalized into recalibration loops.

We need a policy that is product-facing (UX behavior), implementation-facing (tooling and memory semantics), and measurable (acceptance metrics), without overreaching into unrelated architecture.

---

## Decision

Adopt a single **Agent Experience Policy** with five stable modules:

1. **Identity Integrity**
   - Ariadne remains a self-chosen mission name.
   - Majel remains the project lineage tribute.
   - Prompt/runtime behavior must not collapse those into a single claim.

2. **Approved-Stream Intelligence**
   - Prefer approved community streams first (`stfc.space`, `spocks.club`) when external lookup is needed.
   - Treat rumors/leaks as unconfirmed unless corroborated.
   - Do not recommend ToS-risk account instrumentation as a primary pathway.

3. **Lower-Friction Memory**
   - Persist active mission thread state (ops transitions, tracked targets, reminders) across sessions.
   - Reduce repeated user re-entry for recently established goals.

4. **Predictive Coaching**
   - Introduce confidence-based ETA/progress estimates where data quality supports it.
   - Numeric ETA is only emitted when confidence threshold is met; otherwise emit qualitative guidance.
   - Initial numeric ETA threshold: **0.75** confidence score.
   - All predictions are labeled as modeled estimates, not guarantees.

5. **Correction Feedback Loops**
   - User-provided deltas (e.g., unexpected blueprint drops) must trigger fast recalibration.
   - Corrections should update active projections without requiring a full resync workflow.

---

## Scope

### In Scope (Sprint 1)
- Policy codification in prompt + docs
- Source trust behavior in web lookup tooling
- Correction loop contract (delta ingest + recalculation trigger)
- Initial metrics instrumentation and review cadence

### In Scope (Sprint 2)
- Episodic-memory carry-forward for active goals/reminders
- Reminder UX quality loop (helpful/not-helpful signal)
- Prediction model v1 for blueprint-style accumulation goals

### Out of Scope (for this ADR)
- Live direct game-account integrations
- Fully autonomous writeback to user profile/settings without confirmation
- Broad re-architecture of MicroRunner task taxonomy

---

## Policy Contract

### Identity Contract
- Responses must preserve: “Ariadne is the selected persona name; Majel is project lineage.”
- Violations are treated as behavior regressions.

### Source Trust Contract
- External STFC claims should cite source tier when possible.
- Preferred-source ordering is deterministic when tools are available.
- Source attribution target is **>=90%** for external/community-derived claims.

### Uncertainty Contract
- No alarm-style boilerplate prefaces by default.
- Uncertainty should be attached to specific claims, briefly and explicitly.

### Correction Contract
- Correction events are first-class operational inputs.
- Recomputed ETA/state should be reflected in the next relevant response.
- Correction events persist immediately by default with a silent log entry.
- Interactive confirmation is reserved for contradiction cases (identity-integrity or schema conflicts).

---

## Acceptance Metrics

Initial acceptance metrics (reviewed weekly during rollout):

1. **Source Attribution Rate**
   - % of external/community-derived claims that include source labeling.
   - Gate: **>=90%**.

2. **Reminder Usefulness Rate**
   - % of reminders marked useful vs not useful by user signal.

3. **Correction-to-Recalibration Latency**
   - Time from accepted correction delta to updated projection output.
   - Gate: **<=5 minutes**.

4. **Repeat-Question Reduction**
   - Reduction in repeated user restatement of active goals across sessions.

5. **Prediction Label Compliance**
   - % of predictive outputs explicitly marked as estimates.

---

## Implementation Plan

### Phase 1 — Policy + Guardrails (current)
- Prompt policy updates for identity, source trust, uncertainty style.
- Approved-stream support in lookup tooling.
- ADR + backlog alignment.

### Phase 2 — Correction Loop + Memory Continuity
- Add/standardize delta-ingest path for tracked goals (manual correction events).
- Persist correction events into memory context for follow-up turns.
- Recompute tracked target progress from latest known state.

### Phase 3 — Predictive Coaching v1
- Add model for confidence-based ETA on accumulation goals.
- Require estimate labels and confidence bands.
- Add regression tests for drift/recalibration scenarios.

---

## Risks and Controls

- **Risk:** Overconfident predictions with sparse data.
  - **Control:** Require estimate labeling + minimum data threshold before numeric ETA.

- **Risk:** Source-policy drift under prompt/tool changes.
  - **Control:** Prompt tests + declaration/runtime allowlist tests.

- **Risk:** Correction loops become noisy without clear schema.
  - **Control:** Keep delta contract minimal and typed (what changed, when, confidence).

---

## Consequences

### Positive
- More consistent, trusted agent behavior with lower user friction.
- Better tactical coaching quality over time through explicit recalibration.
- Clear PM/governance surface for future prompt/tool adjustments.

### Tradeoffs
- Additional instrumentation and testing overhead.
- Need for explicit metric review cadence to avoid policy drift.

---

## Open Questions

- Reminder usefulness target baseline (proposed: >=70% until recalibrated with observed data).
- Confidence score formula tuning after first sprint telemetry pass.
