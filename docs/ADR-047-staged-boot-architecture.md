# ADR-047 — Staged Boot Architecture

**Status:** Accepted (all phases shipped)  
**Date:** 2026-03-16  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect)  
**Reviewed by:** Lex (Architecture Review)  
**Program umbrella:** #226  
**Related:** #65 (Startup/Import UX)

---

## Context

Majel's `boot()` function in `src/server/index.ts` initializes ~25 steps
serially before calling `app.listen()`. On Cloud Run with `min-instances=0`,
cold starts produce a 5–10 second delay with no HTTP response until the entire
boot sequence completes.

The serial boot path evolved organically as stores were added. Each store does
its own `CREATE TABLE IF NOT EXISTS` via the admin pool, then binds to the app
pool for runtime queries. Most stores have no inter-dependencies, but two
(crew store, effect store) have FK references to `reference_officers` /
`reference_ships` tables. More stores will likely acquire reference FKs as the
data model matures.

The current boot sequence:

1. Admin pool + role setup
2. Settings store + config resolution
3. App pool + grants + settings re-bind
4. Lex memory (frame store factory)
5. Session store
6. Reference store + conditional CDN sync (7 entity types)
7. Resource definitions (file system, sync)
8. Crew store factory
9. Receipt store factory
10. Behavior store
11. Overlay store factory
12. Invite store
13. User store
14. Audit store
15. User settings store
16. Target store factory
17. Research store factory
18. Inventory store factory
19. Proposal store factory
20. Effect store + seed data
21. Operation event store factory
22. Chat run store
23. Engine construction (Gemini + optional Claude)
24. Close admin pool
25. `app.listen()`

Steps 1–3 are genuinely serial (each needs the prior result). Steps 4–22 are
overwhelmingly independent but run one-at-a-time. Step 23 needs all stores
from 4–22 to exist for the tool context factory.

### Problem Statement

- **User-facing:** 5–10s cold start on Cloud Run with no visual feedback
- **Architectural:** serial boot wastes wall-clock time on independent work
- **Operational:** no per-stage timing data to diagnose startup bottlenecks

### What This ADR Does NOT Cover

- **DDL consolidation** — replacing per-store `CREATE TABLE IF NOT EXISTS` with
  a single migration pass. Separate body of work, backlogged.
- **Lazy engine initialization** — deferring Gemini/Claude construction to
  first chat request. Only worth pursuing if timing data shows engine
  construction is a meaningful startup cost. Decision deferred to data.
- **Early `app.listen()` with 503 readiness** — rejected. Creates a
  partial-readiness contract across health checks, APIs, and HTML responses.
  Shifts the symptom rather than removing it.
- **SPA/frontend loading optimization** — separate concern from server boot.

---

## Decisions

### D1 — Production Mitigation: `min-instances=1` + Startup CPU Boost

Set Cloud Run to maintain one warm instance and enable startup CPU boost.

- Removes cold start as the common-case user experience
- Does not mask the underlying serial boot problem (code improvement follows)
- Cost acceptable at current scale: request-based billing, ~$10/mo for one
  idle instance
- Applied via `gcloud run services update` or the existing
  `npm run cloud:scale -- --min 1` command + a one-time
  `--cpu-boost` flag on the deploy step

### D2 — Staged Boot with Dependency Graph

Refactor `boot()` from a serial checklist into explicit stages with a
documented dependency graph.

**Stage 0 — Foundation (serial)**

Must be serial — each step requires the previous result:

1. Admin pool (`createPool(adminUrl)`)
2. `ensureAppRole(adminPool)`
3. Settings store (`createSettingsStore(adminPool)`)
4. `resolveConfig(settingsStore)` → produces app DB URL
5. App pool (`createPool(appUrl)`) + grants + settings re-bind

**Stage 1 — Reference + Independent Services (parallel, concurrency: 4)**

No FK dependencies on anything from Stage 2+:

| Task | Domain | Notes |
|---|---|---|
| `reference-store` | Game data | Creates FK-target tables (`reference_officers`, `reference_ships`, etc.) |
| `frame-store-factory` | Platform | Lex memory, own tables, no game data FKs |
| `session-store` | Platform | Own tables, no game data FKs |
| `resource-defs` | Game data | File system read, synchronous, no DB |

**Stage 1b — Reference Sync (conditional, after reference store resolves)**

Only fires when reference tables are empty (first boot / fresh deploy).
Already uses `Promise.allSettled` internally for 7 entity types. No-op on
warm boots — just a `counts()` check.

Stage 2 blocks on Stage 1b completion, not just Stage 1. If any Stage 2
store's init or seeding assumes reference rows exist (now or in the future),
this ordering is correct.

**Stage 2 — Game-Domain + Platform Stores (bounded concurrency: 4)**

All stores that depend on reference tables existing, or are treated as
eventually depending on them. Waits for Stage 1b to complete.

| Task | Domain | Current FK to reference? |
|---|---|---|
| `crew-store-factory` | Gameplay | **Yes** (officers, ships) |
| `effect-store` | Gameplay | **Yes** (officers) |
| `effect-seed` | Gameplay | Seed data, follows effect store init |
| `receipt-store-factory` | Gameplay | Not yet |
| `behavior-store` | Gameplay | Not yet |
| `overlay-store-factory` | Gameplay | Overlays reference entities |
| `target-store-factory` | Gameplay | Not yet |
| `research-store-factory` | Gameplay | Not yet |
| `inventory-store-factory` | Gameplay | Not yet |
| `proposal-store-factory` | Gameplay | Not yet |
| `operation-event-store` | Gameplay | Not yet |
| `invite-store` | Auth/Platform | No |
| `user-store` | Auth/Platform | No |
| `audit-store` | Auth/Platform | No |
| `user-settings-store` | Auth/Platform | No (depends on settingsStore from Stage 0) |
| `chat-run-store` | Chat | No |

Domain annotations preserved for future split opportunity:
- **Auth/Platform:** invite, user, audit, user-settings, chat-run
- **Gameplay/Reference-adjacent:** crew, effect, target, research, inventory,
  proposal, overlays, operation-events, receipts, behavior

Note: `effect-seed` has a local dependency on `effect-store` — the
implementation chains them into a single task (`effect-store+seed`) rather
than using a `dependsOn` mechanism. Similarly, `reference-cdn-sync` is chained
into `reference-store+cdn-sync` in Stage 1. This means Stage 1 has 4 tasks
and Stage 2 has 15 tasks (not 16). Per-task timing captures the combined
duration; individual sub-step timing is visible in the structured log lines
within each task.

**Stage 3 — Engines (serial or concurrency: 2, after Stage 2)**

Engine construction references multiple stores via the tool context factory
(reference, overlay, crew, target, research, inventory, proposal,
userSettings). Must wait for all Stage 2 stores.

Sub-steps timed individually:
1. Micro runner construction
2. Tool context factory construction
3. Gemini engine creation
4. Claude engine creation (conditional on Vertex config)
5. Engine manager assembly

**Stage 4 — Finalize (serial)**

1. `state.startupComplete = true`
2. Close admin pool (no more DDL after this point)
3. `app.listen()` — only after all stages succeed

### D3 — Bounded Concurrency, Not Raw `Promise.all()`

Stages with multiple tasks use a concurrency-limited runner (4–6 concurrent),
not unbounded `Promise.all()`.

Rationale:
- Admin pool has a limited connection count; 15 simultaneous DDL initializers
  can saturate it
- Concurrent DDL creates catalog/index lock contention on fresh databases
- Bounded concurrency delivers most of the wall-clock improvement without
  turning startup into a connection storm
- Failures are more diagnosable when tasks run in smaller batches

Stage 1 (4 tasks) runs with concurrency 4 (effectively full parallel — the
set is small enough).

Stage 2 (16 tasks) runs with concurrency 4.

### D4 — Aggregate Failure Reporting, Not Fail-Fast

Each stage collects results from all tasks before deciding whether to abort
boot.

Pattern:
- Run the stage with bounded concurrency
- Capture success/failure per task
- Log per-task duration
- If any required task failed, throw one aggregate startup error and abort

This is better than:
- **Fail-fast `Promise.all()`** — first rejection aborts the await, other
  tasks may still be running in the background, diagnostic output is
  incomplete
- **`Promise.allSettled()` + continue** — boot should not serve requests if
  a required store failed

All Stage 2 members are currently treated as required. The domain annotations
(auth/platform vs. gameplay) preserve the option to make some stores optional
in the future, but that separation is not implemented now.

### D5 — Boot Stage Timing Instrumentation

Every stage and every task within a stage emits structured timing logs:

```
boot.task  { stage: "foundation", task: "admin-pool", durationMs: 42 }
boot.task  { stage: "reference",  task: "reference-store", durationMs: 312 }
boot.stage { stage: "reference",  durationMs: 891, tasks: 4 }
boot.stage { stage: "stores",     durationMs: 1203, tasks: 16 }
boot.total { durationMs: 2323 }
```

Per-task timing enables:
- Identifying which stores are the actual startup bottleneck
- Data-driven decision on lazy engine init (backlogged)
- Before/after comparison for future DDL consolidation
- Baseline for Cloud Run performance tuning

Compound operations are chained into single tasks for dependency safety:
- `reference-store+cdn-sync` — combined task in Stage 1
- `effect-store+seed` — combined task in Stage 2

Sub-step progress is visible via structured log lines within each task.

### D6 — Readiness Invariant

No request-serving readiness until all required stages succeed:

- `state.startupComplete` only flips `true` after Stage 3 (engines) completes
- `app.listen()` only fires after `startupComplete`
- `/api/health` reflects `startupComplete` state
- No partial readiness at the app layer — boot is either ready or not

### D7 — Boot Runner Abstraction

Introduce a small internal `runStage()` helper rather than hand-writing
nested async orchestration in `boot()`.

The helper provides:
- Stage name for logging context
- List of named tasks (name + async function)
- Configurable concurrency limit
- Per-task timing capture
- Aggregate result collection and failure reporting

This is a function, not a framework. It keeps `boot()` readable and makes
future stage edits mechanical.

Conceptual shape:

```typescript
await runStage("foundation", [
  { name: "admin-pool", fn: () => initAdminPool() },
  { name: "ensure-role", fn: () => ensureAppRole(adminPool) },
  // ...
], { concurrency: 1 });

await runStage("reference", [
  { name: "reference-store", fn: () => initReferenceStore() },
  { name: "frame-store-factory", fn: () => initFrameStore() },
  { name: "session-store", fn: () => initSessionStore() },
  { name: "resource-defs", fn: () => loadResourceDefs() },
], { concurrency: 4 });

// ... etc.
```

---

## Consequences

### Positive

- Cold start delay eliminated as common-case UX issue (`min-instances=1`)
- Startup wall-clock time reduced by parallelizing ~16 independent store inits
- Per-task timing data enables evidence-based optimization decisions
- Clean dependency graph is documented and maintainable
- Boot runner pattern is reusable if stages are added/split later
- Aggregate failure reporting gives complete diagnostic picture on boot errors

### Negative

- `min-instances=1` adds ~$10/mo to Cloud Run bill
- Concurrent DDL on fresh databases may produce noisier PG logs
- Boot runner is a new abstraction to maintain (small, but non-zero)
- Effect seed must express a local dependency on effect store within Stage 2

### Neutral

- No store APIs change
- No route changes
- No frontend changes
- Test suite should not require changes (boot is not unit-tested, stores are
  tested individually)
- Refactor is contained to `boot()` in `src/server/index.ts` plus a new
  `src/server/boot-runner.ts` helper

---

## Implementation Plan

| Phase | Issue | Title | Scope |
|---|---|---|---|
| A | #227 | Production mitigation | `min-instances=1`, startup CPU boost, `--cpu-boost` on deploy |
| B | #228 | Boot runner + stage timing | `src/server/boot-runner.ts` — `runStage()` helper with concurrency, timing, aggregate failure. Wire timing logs into current serial boot (no parallelism yet) to get baseline numbers. |
| C | #229 | Staged parallel boot | Refactor `boot()` to use `runStage()` with Stage 0–4 dependency graph. Bounded concurrency (4) on Stages 1 and 2. Aggregate failure reporting. Preserve existing error handling per store. |

### Sequencing

A → B → C (strict serial). A can ship independently and provides immediate
user-facing value. B provides timing data that validates the design before C
changes the boot order. C is the structural refactor.

### Definition of Done

- [x] Cloud Run `min-instances=1` and startup CPU boost active
- [x] `runStage()` helper exists with concurrency control and timing
- [x] `boot()` uses staged execution with documented dependency graph
- [x] All boot stages emit structured timing logs (`boot.task`, `boot.stage`, `boot.total`)
- [x] Aggregate failure reporting: all task results collected before abort
- [x] `state.startupComplete` invariant preserved — no readiness before all stages pass
- [x] Effect seed expressed as local dependency on effect store (chained task)
- [x] Domain annotations on Stage 2 members preserved in code comments
- [x] `npm run ax -- ci` passes (2213/2213)
- [ ] Before/after timing comparison documented (pending first production deploy with timing logs)

---

## Backlog (Deferred)

| Item | Trigger for Revisit |
|---|---|
| DDL consolidation (single migration pass) | If Stage 2 timing shows DDL is the dominant cost |
| Lazy engine init | If Stage 3 timing shows engine construction > 500ms |
| Stage 2 split (required vs. optional stores) | If failure history or timing justifies partial boot |
| Reference bootstrap strategy | If CDN sync on fresh deploy proves painful at scale |
