# ADR-042 — Model Availability Policy

**Status:** Accepted  
**Date:** 2026-03-10  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect), Lex (Architecture Review)  
**Program umbrella:** #205  
**Depends on:** ADR-041 (multi-provider LLM engine)

---

## Context

ADR-041 introduced multi-provider model support (Gemini + Claude via
Vertex AI). Model visibility is currently controlled by three
independent, scattered mechanisms:

1. **Env-var gate** — `VERTEX_PROJECT_ID` presence determines whether
   Claude models appear in the picker. Requires redeploy to change.
2. **Role gate** — `roleGate: "admiral"` on `ModelDef` hides models
   from non-admirals. Static in code.
3. **Engine fallback** — `EngineManager` silently falls back to Gemini
   if Claude engine isn't initialized.

These checks are duplicated across three locations:

- `GET /api/models` — filters the model list
- `POST /api/models/select` — rejects invalid selections
- `engine-manager.ts` — guards provider routing

This creates drift risk: each path implements slightly different logic,
and there is no single function that answers "can this actor use this
model right now?" Adding a new reason to disable a model (quota
exhaustion, preview regression, cost control) means patching every
check site independently.

### Why This Matters Now

Claude models were purchased in GCP Model Garden but have 0 RPM quota
until Google approves an increase. We need to deploy to cloud with
Gemini working and Claude explicitly unavailable — and later flip
Claude on without redeploying. The env-var gate works for this specific
case, but it's not a general solution for operational model control.

## Decision

Introduce a **Model Availability Policy** — a single authoritative
resolver that composes multiple independent signals into one answer:
"is this model available to this actor right now, and if not, why?"

### D1: Registry gains `defaultEnabled`

`ModelDef` gains a `defaultEnabled: boolean` field. This is the
code-owner's opinion on whether a model should be live by default.

| Model | `defaultEnabled` | Rationale |
|-------|-----------------|-----------|
| gemini-2.5-flash-lite | `true` | Stable, budget |
| gemini-2.5-flash | `true` | Stable workhorse |
| gemini-3-flash-preview | `false` | Preview — opt-in only |
| gemini-2.5-pro | `true` | Stable premium |
| gemini-3-pro-preview | `false` | Preview — opt-in only |
| claude-haiku-4-5 | `false` | New provider, quota pending |
| claude-sonnet-4-6 | `false` | New provider, quota pending |

New models added to the registry **do not auto-surface** unless
`defaultEnabled: true` is explicitly set. This prevents accidental
exposure of preview, expensive, or half-integrated models.

### D2: Admin override via SettingsStore

Admin overrides are stored as a JSON blob in the existing
`SettingsStore` under key `system.modelOverrides`:

```json
{
  "claude-haiku-4-5": { "adminEnabled": true, "reason": "Quota approved" },
  "gemini-3-pro-preview": { "adminEnabled": false, "reason": "Preview quality regression" }
}
```

Semantics:
- **Key absent** → no override, fall back to `defaultEnabled`
- **`adminEnabled: true`** → explicitly enabled by admin
- **`adminEnabled: false`** → explicitly disabled by admin
- **`reason`** → human-readable explanation shown in admin UI

This uses the existing `SettingsStore` infrastructure (PostgreSQL
`settings` table, `get`/`set`/`getAll` API). No new table, no new
migration. The `system.modelOverrides` key is added to
`SETTINGS_SCHEMA` with `type: "json"`, `category: "system"`.

### D3: Centralized `resolveModelAvailability()`

A single pure function computes effective availability by composing
four independent signals:

```typescript
interface ModelAvailability {
  available: boolean;
  registryEnabled: boolean;   // ModelDef.defaultEnabled
  providerCapable: boolean;   // provider infra configured?
  roleAllowed: boolean;       // actor passes roleGate?
  adminEnabled: boolean;      // admin override (or registry default)
  effectiveReason?: string;   // why unavailable, if not
}

function resolveModelAvailability(
  modelId: string,
  actor: { isAdmiral: boolean },
  overrides: Record<string, { adminEnabled: boolean; reason?: string }>,
  providerCapabilities: { gemini: boolean; claude: boolean },
): ModelAvailability
```

Composition rule:
```
available = providerCapable AND roleAllowed AND effectiveEnabled

effectiveEnabled =
  override exists ? override.adminEnabled
                  : model.defaultEnabled
```

Priority chain:
1. **Provider capable** — is the provider's infra configured? (Vertex
   project set, credentials valid)
2. **Role allowed** — does the actor satisfy `roleGate`?
3. **Admin override** — explicit admin enable/disable, if set
4. **Registry default** — `defaultEnabled` from `ModelDef`

Each signal is independently queryable. The function returns all four
plus the composed `available` boolean and a human-readable reason.

### D4: All enforcement paths use the resolver

Every path that gates model access calls `resolveModelAvailability()`:

| Path | Current | After |
|------|---------|-------|
| `GET /api/models` | inline provider filter | `resolveModelAvailability()` per model |
| `POST /api/models/select` | inline provider + role check | `resolveModelAvailability()` then reject |
| `engine-manager.ts setModel()` | inline Claude guard | `resolveModelAvailability()` then reject |
| `executeChatRun()` | none (relies on model already being set) | pre-flight `resolveModelAvailability()` |

This eliminates the current N-place duplication and ensures a model
disabled by admin cannot be reached through any path, including
stale session restore or future background jobs.

### D5: Admin API endpoints

```
GET    /api/admiral/models
       → full model list with availability breakdown per model

PATCH  /api/admiral/models/:id/availability
       → { adminEnabled: boolean, reason?: string }
       → persists to system.modelOverrides in SettingsStore
```

Response shape for each model:
```json
{
  "id": "claude-sonnet-4-6",
  "name": "Claude Sonnet 4.6",
  "provider": "claude",
  "tier": "premium",
  "registryEnabled": false,
  "providerCapable": true,
  "adminEnabled": null,
  "effectiveAvailable": false,
  "effectiveReason": "Not enabled by default (new provider)"
}
```

The `null` for `adminEnabled` means "no override, using registry
default." The UI can distinguish between "admin explicitly disabled
this" and "never been enabled."

### D6: Rich model list in existing GET /api/models

The existing `GET /api/models` endpoint (used by the model picker)
gains the availability fields so the frontend can display meaningful
status for unavailable models rather than simply hiding them:

```json
{
  "id": "claude-sonnet-4-6",
  "name": "Claude Sonnet 4.6",
  "provider": "claude",
  "available": false,
  "unavailableReason": "Quota pending — admin has not enabled",
  "active": false
}
```

Models where `roleAllowed` is false are still omitted entirely (the
user shouldn't know they exist). Models where `available` is false
for other reasons are included but marked unavailable.

### Non-Goals

- **Per-user model entitlements** — beyond `roleGate`, no per-user
  model access lists. Existing role system is sufficient.
- **Automatic health-based disabling** — circuit breakers, auto-disable
  after N failures. Future concern. The resolver's composition model
  leaves room for a `providerHealthy` signal later.
- **Usage analytics / cost tracking** — per-model token metering is a
  separate domain.
- **Audit trail** — the `SettingsStore` records current state only.
  If audit history is needed later, that's a separate append-only log,
  not a `lastModified` column pretending to be an audit trail.
- **Dedicated SQL table** — for 7 models, a JSON blob in the existing
  settings table is the right weight. A dedicated
  `model_availability` table would be over-engineering.

## Phased Implementation

### Phase 1 — Registry + Resolver (#206)

Add `defaultEnabled` to `ModelDef`. Implement
`resolveModelAvailability()` as a pure function. Add the
`system.modelOverrides` setting to the schema (unused yet).
Wire the resolver into existing model list and selection paths,
replacing the scattered inline checks.

**Files:**
- `src/server/services/gemini/model-registry.ts` — add `defaultEnabled`
- `src/server/services/model-availability.ts` — new, resolver function
- `src/server/routes/chat.ts` — use resolver in GET/POST model routes
- `src/server/services/engine-manager.ts` — use resolver in `setModel()`
- `src/server/stores/settings.ts` — add `system.modelOverrides` to schema
- `test/model-availability.test.ts` — resolver unit tests

### Phase 2 — Admin Endpoints + UI (#207)

Add admin model management endpoints. Wire into admin UI panel.

**Files:**
- `src/server/routes/admiral.ts` — add GET/PATCH model routes
- `web/src/components/AdminPanel.svelte` — model availability toggles
- `test/admiral-routes.test.ts` — endpoint tests

### Phase 3 — Frontend Polish (#208)

Update model picker to show unavailable models (greyed out with
reason tooltip) instead of hiding them. Add status indicators.

**Files:**
- `web/src/components/ChatInput.svelte` — unavailable model display
- `web/src/lib/types/shared-core.ts` — availability fields in types

## Consequences

- New models default to off unless explicitly enabled (`defaultEnabled: true`)
- Admin can enable/disable any model at runtime without redeployment
- A single function resolves availability — no enforcement drift
- Existing env-var gate (`VERTEX_PROJECT_ID`) continues to work as the
  provider capability signal, but is no longer the only control
- The resolver is pure and easily testable — no DB calls, no side effects
- Admin UI gains operational control over model exposure
- Future signals (provider health, degradation) can be added as new
  inputs to the resolver without changing the API contract

## Related

- ADR-041 — Multi-Provider LLM Engine (Claude via Vertex AI)
- ADR-038 — Agent Experience Policy (persona/prompt)
- ADR-027 — GenAI SDK Migration (Gemini SDK setup)
