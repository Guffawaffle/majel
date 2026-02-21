# AI UX Review Checklist (Reusable)

Use this checklist for any feature that includes AI-assisted actions.

## Scope

- Applies to setup/import/onboarding and similar task flows.
- Goal: AI remains helpful but never required to complete core tasks.

## Checklist

Mark each item as **Pass** / **Fail** during UX review.

1. **AI optional path is non-blocking**
   - Pass if a user can complete the full target flow with AI disabled or unavailable.
   - Pass if no required step depends on AI output.

2. **Manual fallback exists adjacent to each AI action**
   - Pass if every AI-triggered control has a nearby manual alternative for the same job.
   - Pass if fallback is visible without navigation to another screen.

3. **No-key behavior degrades gracefully**
   - Pass if missing API key shows an informational inline state (not an error wall).
   - Pass if message includes a clear Settings link/action to configure AI.
   - Pass if user can continue the active flow without configuring a key.

4. **No upsell modal during active setup/import flow**
   - Pass if AI pricing/upgrade prompts do not interrupt active setup/import steps.
   - Pass if monetization messaging is deferred to non-blocking UI (inline/help/settings).

5. **Intro is dismissible and non-blocking**
   - Pass if first-time AI intro (panel/tooltip) can be dismissed immediately.
   - Pass if dismissing intro does not block flow progression.
   - Pass if intro does not reappear repeatedly in the same session after dismissal.

6. **Optional metering guardrails are inline and non-blocking**
   - Pass if remaining allowance/quota is shown inline near relevant AI actions.
   - Pass if exhausted quota disables only AI actions, not manual completion paths.
   - Pass if quota exhaustion message points to fallback or settings without modal lock.

## Release Gate

- Feature is ready only when all checklist items are **Pass**.
- Any **Fail** must include a tracked follow-up issue before release.
