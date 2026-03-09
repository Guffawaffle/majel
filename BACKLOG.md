# Backlog

> Tracked issues, tech debt, and planned work for Majel.
> Updated: 2026-03-07 | Branch: `main`

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |
| `[—]` | Deferred / won't fix |

---

## Current PM Focus

- **Top active program target:** #188 — Request Context & Scoped Database Execution (ADR-039). Foundation-level infrastructure investment.
- **Recently completed:** #187 — `stfc.space` crawler hardening (polite crawl cadence, conditional requests, IPv4 enforcement).
- **Top QA tranche:** #161, #165.
- **Recently shipped:** diagnostics overlay scope clarity (#162), Admiral verification actions (#163), recommender exclusion mode (#167), captain/resource-specific mining fixes (#169), review-driven fleet-tool output hardening, WSL2 auto-start for postgres.
- **Operational note:** deploys are live again; use normal `ax ci` + push gate, not the old guided-setup hold marker.


---

## Active Program — Request Context & Scoped DB Execution (ADR-039, #188)

**Program umbrella:** #188  
**Linked ADR:** [docs/ADR-039-request-context.md](docs/ADR-039-request-context.md)  
**External review:** Lex (ChatGPT) — architecture review completed 2026-03-09

### Program Objective

Replace ad-hoc request context threading with a unified `RequestContext` class,
transaction-scoped RLS via `DbScope`, and a `QueryExecutor` interface that cleanly
separates boot-time global work from request-time tenant-scoped work. Every log line
from route → service → store → tool gains requestId + userId correlation.

### Locked Decisions

1. `RequestContext` class — thin, immutable, request-scoped identity/tracing/auth
2. `RequestIdentity` — frozen object with `userId`, `tenantId` (distinct), `roles: string[]`
3. `DbScope` — short-lived, transaction-scoped, `SET LOCAL` only (no session-scoped tenant state)
4. `readScope(fn)` — `BEGIN READ ONLY` → `SET LOCAL` → bundled reads → `COMMIT` → release
5. `writeScope(fn)` — normal transaction → `SET LOCAL` → mutate → `COMMIT/ROLLBACK` → release
6. Boot operations use raw pool — no synthetic RequestContext
7. `QueryExecutor` interface — stores accept this, agnostic to pool vs DbScope
8. ALS for correlation/logging only — not for auth or tenant enforcement
9. `ToolContext` → `ToolEnv { ctx, deps }` transition → declaration-driven `defineTool()` end-state
10. `TestContextBuilder` — builders for tests, not subclasses
11. No deep class hierarchy — one context class, one DB wrapper, composition for everything else
12. `isAdmiral` boolean → `roles: readonly string[]` (RBAC-ready)

### Sequenced Implementation Plan

| Phase | Issue | Title | Status |
|---|---|---|---|
| 0 | #189 | Foundation: `RequestContext`, `DbScope`, `QueryExecutor`, `RequestIdentity` types | [x] Done |
| 1 | #190 | `readScope()` / `writeScope()` methods + transaction-local RLS | [x] Done (shipped with #189) |
| 2 | #191 | Express middleware: `createRequestContext()` from `res.locals` | [x] Done (shipped with #189) |
| 3 | #192 | ALS convenience layer for scoped logging correlation | [x] Done (shipped with #189) |
| 4 | #193 | End-to-end proof: `user-settings` route migrated to `RequestContext` | [x] Done |
| 5 | #194 | `TestContextBuilder` + test fixture infrastructure | [x] Done (shipped with #189) |
| 6 | #195 | `ToolContext` → `ToolEnv { ctx, deps }` (Stage 1 transition) | [ ] Not started |
| 7 | #196 | Tenant-scoped store factories accept `RequestContext` | [ ] Not started |
| 8 | #197 | Remaining route migration (route-by-route, no flag day) | [~] In progress — 10/13 per-group routes migrated; auth.ts + chat.ts deferred (per-handler auth chains) |
| 9 | #198 | Legacy removal: deprecate `withUserScope` / `withUserRead` | [ ] Not started |
| 10 | #199 | ToolEnv Stage 2: `defineTool()` with declaration-driven dependency resolution | [ ] Not started |

### Definition of Done

- [ ] `RequestContext` created once per request in Express middleware
- [ ] All tenant-scoped DB work goes through `readScope` / `writeScope` with `SET LOCAL`
- [ ] Every log line from route → store includes requestId + userId correlation
- [ ] Session-scoped `set_config(..., false)` fully replaced with transaction-local `SET LOCAL`
- [ ] Boot operations unchanged — raw pool, no synthetic context
- [ ] Global stores unchanged — pool-backed, no forced RequestContext dependency
- [ ] `ToolEnv { ctx, deps }` in fleet tools dispatcher
- [ ] Test suite rebuilt with `TestContextBuilder`
- [ ] `npm run ax -- ci` passes at every phase boundary

### Risk Controls

- [ ] Each phase is a standalone PR that doesn't break the previous state
- [ ] Dual-mode stores during migration (accept old or new pattern)
- [ ] No flag-day requirement — routes migrate one at a time
- [ ] Pool pressure validated: `readScope` serialization measured against current fan-out latency
- [ ] No mutable state on `RequestContext` — accumulators and operation state live on dedicated objects

### Key Design Constraints (from Lex Review)

- `RequestContext` must NOT become a service locator — stores/services are composed beside it, not resolved from it
- `DbScope` lifetime must be request-bounded — no caching, no attachment to singletons/emitters
- `readScope` accepts serialized reads as the default — multi-client fan-out only for measured hotspots with documented justification
- Read-only scopes still use transactions (`BEGIN READ ONLY`) to guarantee `SET LOCAL` cleanup
- `tenantId` and `userId` are architecturally distinct even though they're equal today

---

## Completed Sprint — Realtime Async Operations (ADR-036 + ADR-037, #175)

**Sprint umbrella:** #175  
**Linked implementation issues:** #174 (SSE stream plane), #172 (async chat runs)

### Sprint Objective

Ship a single, production-ready realtime operation stack where long-running chat work streams live progress to users and no longer relies on long-held synchronous request/response behavior.

### Sequenced Plan (single sprint)

| Day | Track | Scope | Issue | Status |
|---|---|---|---|---|
| 1 | Platform | `operation_events` schema + event emitter helper | #174 | [x] Done |
| 2 | Platform | `/api/events/stream`, keepalive, snapshot endpoint, replay (`Last-Event-ID`) | #174 | [x] Done |
| 3 | Chat Runs | `chat_runs` + `operation_events` (topic: `chat_run`), submit endpoint (`202 + runId`) | #172 | [x] Done |
| 4 | Chat Runs | worker claim loop/watchdog + SSE event integration + cancel flow | #172 | [x] Done |
| 5 | Hardening | privacy tests, reconnect behavior, runbook updates, CI gates, review findings | #172 + #174 | [x] Done |

### Sprint Progress Notes

- [x] Event stream plane is live (`/api/events/snapshot`, `/api/events/stream`) with owner-only access tests.
- [x] Chat run lifecycle emits `run.queued`, `run.started`, `run.completed`, `run.failed` with routing tuple `(runId, sessionId, tabId)`.
- [x] Async submit contract shipped behind client opt-in (`POST /api/chat` with `async: true` returns `202` + `runId`; `GET /api/chat/runs/:runId` provides status snapshot).
- [x] Stale running run recovery now terminalizes cancel-requested runs and status route reconciles against durable `chat_runs` state when event stream is stale.
- [x] Replay hardening now treats malformed `Last-Event-ID` as cursor `0` and validates query/header replay cursor behavior in SSE route tests.
- [x] Replay privacy edges now include malformed-header/query fallback coverage and explicit cross-user replay denial tests (including admiral) plus runbook troubleshooting notes.
- [x] Sprint review findings: P1 (RLS documented), P3 (emit upsert removed), P4 (keepalive stripped), P6/P7 (docs cleaned). P2/P5 deferred.

### Definition of Done

- [x] Live operation progress streams to UI (SSE-first)
- [x] Chat completion survives refresh/reconnect with replay/snapshot recovery
- [x] No multi-minute blocking `/api/chat` responses
- [x] No timeout-triggered double-send response race
- [x] Cross-user access denied for streams and runs (including admiral)
- [x] `npm run ax -- affected --run` and `npm run ax -- ci` both pass

### Completion Checkpoint

- [x] Delivered to `main` and validated in CI.
- [x] Ready for GitHub issue closure sweep on #172, #174, and #175.

### Risk Controls

- [x] Keep API contracts stable across incremental merges
- [x] If replay semantics block timeline, ship snapshot fallback with explicit follow-up checklist
- [x] Preserve owner-only visibility for all run/stream payloads

### Deferred Follow-ups (from Day 5 sprint review)

- [ ] **P2 — Multi-worker claim concurrency.** Current claim loop is single-worker, single-run (`claimInFlight` serialization). Fine for current scale; revisit when throughput requires concurrent run execution. Add configurable concurrency cap at that time.
- [ ] **P5 — Stream termination sentinel.** SSE connections stay open after terminal events. Consider emitting a `stream.done` sentinel and auto-closing server-side after a grace period. Requires client-side coordination.

---

## Planned Next Sprint — Agent Experience Policy (ADR-038)

**Sprint umbrella:** ADR-038 execution sprint  
**Linked doc:** [docs/ADR-038-agent-experience-policy.md](docs/ADR-038-agent-experience-policy.md)

**Sprint status:** [x] Complete (2026-03-04)

### Sprint Objective

Ship the first operational slice of Ariadne’s agent-experience policy: stable identity behavior, approved-stream-first external lookup, correction feedback loops, and measurable telemetry for memory/reminder/prediction quality.

### Sequenced Plan (single sprint)

| Day | Track | Scope | Status |
|---|---|---|---|
| 1 | Policy | Finalize ADR-038 acceptance thresholds + non-goals | [x] Done |
| 2 | Tooling | Source-trust observability fields + source labeling in tool outputs | [x] Done |
| 3 | Corrections | Define and wire correction-delta ingest path for tracked goals | [x] Done |
| 4 | Memory | Persist correction events in episodic continuity path for active goals | [x] Done |
| 5 | Validation | Add regression tests + metric snapshots + runbook notes | [x] Done |

### Confirmed Sprint Gates (locked)

- Source attribution gate: >=90% on external/community-derived claims
- Correction-to-recalibration gate: <=5 minutes
- Sprint cadence: 5-day execution slice
- Prediction gate: numeric ETA only when confidence threshold is met; otherwise qualitative guidance
- ETA confidence threshold: 0.75 for numeric output
- Correction persistence: immediate persistence with silent logging; interactive confirmation only on contradiction cases

### Definition of Done

- [x] Identity contract holds in prompt tests (Ariadne persona, Majel lineage)
- [x] Approved-stream policy enforced and observable for external lookup paths
- [x] Correction delta path updates active projections within agreed latency budget
- [x] Reminder/prediction telemetry emitted for weekly review
- [x] Targeted tests pass and sprint notes recorded

### Delivered Outcomes (checkpoint)

- [x] Identity + datastream policy hardened in prompt behavior and regression tests
- [x] Approved-source lookup observability shipped (`stfc.space`, `spocks.club`)
- [x] Correction loop contract shipped (`record_target_delta`) with immediate silent persistence
- [x] Reminder usefulness contract shipped (`record_reminder_feedback`) and KPI aggregation
- [x] Episodic continuity shipped in `list_targets` (`recentDeltas`, `recentReminderFeedback`, `continuity`)
- [x] Repeat-question reduction proxy shipped (`record_goal_restatement` + metrics aggregation)
- [x] Runbook/changelog updated and CI gates passed on each checkpoint

### Risk Controls

- [x] Keep prediction outputs estimate-labeled unless confidence threshold is met
- [x] Avoid expanding scope into full live-account integrations in this sprint
- [x] Keep correction schema minimal to reduce noisy/ambiguous updates

---

## Critical — Must Fix Before Merge

### [x] Security Hardening (e685c09)
- [x] C1: Shell injection — `execSync` → `execFileSync` + `shellSplit()`
- [x] C2: Token format validation (32+ hex chars)
- [x] C3: Dynamic SQL SET clause allowlist comments
- [x] I5: API key validation at boot
- [x] I6: `setModel()` throws on unknown model ID
- [x] I7: Env value masking in `cmdDiff`
- [x] M7: SIGINT handlers for child processes

### [x] AX Mode Hardening (edac421)
- [x] C1–C3: All `process.exit(1)` paths emit AX JSON
- [x] C4: `cmdSsh` clarifies proxy isn't running in AX mode
- [x] C5: `cmdDeploy` per-step try/catch with phase context
- [x] I1–I2: Auth errors use `ErrorCode.*` + recovery hints
- [x] I3: API envelope gains `hints?: string[]`
- [x] I4: Invalid model error includes `validModels` in detail
- [x] I5: Health `retryAfterMs` + `Retry-After` header
- [x] I6: Diagnostic reads actual model from engine
- [x] I7–I10: Cloud CLI failures include recovery hints
- [x] N1–N8: Schema docs, discovery auth tiers, arg schemas, consistency fixes

### [x] Self-Review Findings (6fadefe + 0560656)

#### Footguns
- [x] **F1/E1 (IMPORTANT):** `sendFail()` has 6 positional params → switch to options object
  - Files: `envelope.ts` + all callers — 5th param now `FailOptions` object with `{ detail?, hints? }`
  - 167 basic callsites (4 args) unchanged, 14 callsites migrated
- [x] **F2 (CRITICAL):** Health `await`s store `.counts()` with no try/catch — one flaky store kills liveness probe
  - File: `src/server/routes/core.ts` — wrapped in `safeCounts()` helper
- [x] **F3 (IMPORTANT):** Version hardcoded `"0.4.0"` in discovery + diagnostic — drifts from `package.json`
  - File: `src/server/routes/core.ts` — now reads `APP_VERSION` from package.json at module load
- [x] **F4 (IMPORTANT):** Discovery route list has wrong auth tier for diagnostic-query endpoints
  - File: `src/server/routes/core.ts` — corrected to `admiral`
- [x] **F5 (MINOR):** `COMMAND_ARGS` and `COMMANDS` are separate maps — will desync *(fixed 2026-02-21: args moved into `CommandDef` in `scripts/cloud.ts`)*
  - File: `scripts/cloud.ts` ~L1287 vs ~L1356
- [x] **F6 (MINOR):** `shellSplit` only handles single quotes — double-quoted args silently break *(fixed 2026-02-21: parser now supports single/double quotes + escaping in `scripts/cloud.ts`)*
  - File: `scripts/cloud.ts` ~L115

#### Security
- [x] **S1 (CRITICAL):** `/api/diagnostic` has NO auth — exposes Node version, model, uptime, session count, DB path
  - File: `src/server/routes/core.ts` — added `requireVisitor(appState)` middleware
- [x] **S2 (IMPORTANT):** `isSafeQuery` bypassable with writable CTEs and multi-statement queries
  - File: `src/server/routes/diagnostic-query.ts`
  - Fix: Semicolon rejection + writable CTE keyword detection + `BEGIN TRANSACTION READ ONLY`
- [x] **S3 (IMPORTANT):** Discovery auth tiers mismatch for diagnostic-query endpoints
  - Same root cause as F4 — both fixed
- [x] **S4 (MINOR):** Auth hint reveals env var name `MAJEL_ADMIN_TOKEN`
  - File: `src/server/auth.ts` — removed hint entirely
- [x] **S5 (MINOR):** `INSUFFICIENT_RANK` detail leaks user's current role
  - File: `src/server/auth.ts` — removed `currentRole` from detail and hints
- [x] **S6 (MINOR):** `sendFail` passes raw `err.message` from Gemini — could leak internals
  - File: `src/server/routes/chat.ts` — chat and recall errors now return generic messages
- [—] S7 (MINOR): `GEMINI_NOT_READY` detail.reason leaks config — acceptable behind admiral auth

#### Extensibility
- [x] **E1 (IMPORTANT):** `sendFail` positional signature (same fix as F1)
- [x] **E2 (MINOR):** `ErrorCode` is frozen const — no module-specific extension mechanism *(fixed 2026-02-21: added `defineModuleErrorCodes(namespace, codes)` in `src/server/envelope.ts` for namespaced extensions)*
- [x] **E3 (IMPORTANT):** CLI `AxOutput` and API `ApiErrorResponse` schemas will diverge *(fixed 2026-02-21: shared contracts added in `src/shared/ax.ts`, consumed by CLI and API envelope)*
  - Mitigation: `docs/AX-SCHEMA.md` documents both
- [x] **E4 (MINOR):** Health response spreads raw store `counts()` — no type guard
  - File: `src/server/routes/core.ts` — `safeCounts()` now wraps with `active` + `error` fallback
- [x] **E5 (MINOR):** `res.locals` untyped — `tenantId = userId` conflation
  - File: `src/server/express-locals.d.ts` — Express module augmentation with typed Locals

---

## Auth Overhaul Post-Review (#91)

Review findings from 10-agent code review of the SOC2 auth overhaul (2026-02-18).
F1–F3 fixed inline. Remaining items below.

### FAIL — Must Fix

- [x] **F1:** Signup failure catch not audited — brute-force/enumeration blind spot *(fixed fb2ac0a+)*
- [x] **F2:** Change-password failure catch not audited — wrong-password brute-force *(fixed fb2ac0a+)*
- [x] **F3:** Invite redeem failure catch not audited — code-guessing *(fixed fb2ac0a+)*
- [x] **F4:** `app-context.test.ts` local `makeState` missing `auditStore` + 2 fields, uses `as AppState` cast *(fixed 62d9a22)*
- [x] **F5:** `auth.test.ts` local `makeState` missing 5 AppState fields *(fixed 62d9a22)*
- [x] **F6:** 4 more test files with local `makeState` (auth-validation, crew-validation, admiral-routes, multimodal-chat) — should import shared *(fixed 62d9a22)*
- [x] **F7:** RUNBOOK query #4 (rate limits) is broken — `subsystem="http"` + `"rate limit"` text never appears in 429 logs. Fix: added `log.http.warn` with `event="rate_limit.hit"` to all 4 handlers + updated RUNBOOK query *(fixed 62d9a22)*

### WARN — Should Fix

#### Audit Store
- [x] **W1:** `String(created_at)` returns non-ISO date — use `.toISOString()` *(fixed 62d9a22)*
- [x] **W2:** No upper-bound cap on query `limit` param — cap at 1000 *(fixed 62d9a22)*
- [x] **W3:** `SELECT *` in audit queries — fragile if schema evolves; use explicit column list *(fixed b936156)*
- [x] **W4:** Append-only not enforced at DB role level — `majel_app` has DELETE on `auth_audit_log`; revoke or add trigger *(fixed b936156)*

#### Auth Routes
- [x] **W5:** `verify-email` and `reset-password` audit events missing `actorId`/`targetId` *(fixed b936156)*
- [x] **W6:** Verify-email failure (invalid token) not audited *(fixed b936156)*
- [x] **W7:** Reset-password failure paths not audited *(fixed b936156)*
- [x] **W8:** Bootstrap middleware uses `admin.role_change` event (misleading) — rename to `admin.bootstrap_auth` *(fixed b936156)*
- [x] **W9:** Bootstrap middleware constructs IP/UA inline — use `auditMeta(req)` for consistency *(fixed b936156)*
- [x] **W10:** `GET /api/auth/admiral/users` (list users) not audited — sensitive admin read *(fixed b936156)*

#### Logger / GCP
- [x] **W12:** Redact paths only 1-level deep (`*.token`) — deeper paths like `req.headers.authorization` missed *(fixed b936156)*

#### IP Allowlist
- [x] **W15:** No IP syntax validation in `parseAllowedIps` — garbage entries silently ignored *(fixed b936156)*
- [x] **W16:** `trust proxy` hardcoded to `1` — needs comment for multi-proxy deployments *(fixed b936156)*
- [x] **W17:** No dedicated unit tests for `ip-allowlist.ts` — 13 tests *(fixed b936156)*

#### RUNBOOK
- [x] **W18:** Missing query recipes: password reset abuse, signup spikes, 5xx errors, boot events, IP allowlist blocks *(fixed b936156)*

---

## Up Next — Local-First Data Cache (ADR-032, #106)

**Priority: Before any new features.** Infrastructure investment that improves every existing view.

Implement IndexedDB cache with stale-while-revalidate strategy. Eliminates redundant API calls on tab navigation — currently ~2 MB wasted bandwidth per session.

| Issue | Phase | Title | Status |
|---|---|---|---|
| #107 | 1 | IDB engine + catalog data caching | [x] Done (eb1de1f) |
| #108 | 2 | Crew entities + invalidation rules | [x] Done (b24a54c) |
| #109 | 3 | Optimistic updates + offline indicators | [x] Done (b87f657) |
| #110 | 4 | Settings, ETag, multi-tab, metrics | [x] Done (34a5590) |

**Target:** 0 network calls on tab switch, FleetView < 200ms, < 500 KB bandwidth per session.

**All four phases delivered.** 174 web tests across 13 files, 1,361 server tests passing.
- Phase 1: IDB engine + catalog caching (eb1de1f)
- Phase 2: 13 crew GETs cached, 18 mutations with invalidation rules (b24a54c)
- Phase 3: Optimistic create/update/delete with rollback, offline banner, sync queue (b87f657)
- Phase 4: Settings cache, ETag/304 conditional revalidation, 7-day purge, BroadcastChannel multi-tab, cache metrics in Diagnostics (34a5590)

---

## In Progress — Effect Taxonomy for Crew Recommendation (ADR-034, #131)

**Priority: Active.** Fixes fundamentally broken crew recommender scoring.

Replace binary keyword matching (`hasKeyword()`) with a normalized effect taxonomy. Abilities are decomposed into typed `EffectTag` rows evaluated against a `TargetContext`. Scoring becomes `baseScore × synergyMultiplier` instead of additive keyword hits. Captain slot gets a hard CM gate. "Why this crew" becomes per-officer evidence.

| Issue | Phase | Title | Status |
|---|---|---|---|
| #132 | A | Schema + Seed + Evaluator (foundation) | [x] Done (`4d29fa6`) |
| #133 | B | Rewire Recommender (effect-based scoring) | [x] Done (`f98a365`) |
| #141 | Phase 1 | Effects v3 contract enforcement + dry-run scaffold | [x] Done (`a16fd57`) |
| #143 | Phase 2 | Deterministic extractor hardening + invariants | [x] Done (`daee915`) |
| #142 | Phase 3 | Inference sidecar + needs_interpretation trigger pipeline | [x] Done (`a305118`) |
| #146 | Phase 4 | Runner gates + promotion/fallback + receipts | [x] Done (`65f42ab`) |
| #144 | Phase 5 | Override engine + precedence + contradiction protection | [x] Done (`b03471e`) |
| #145 | Phase 6 | CI budgets + runtime artifact split/caching rollout | [x] Done (2026-02-22, post-review hardening through `e0fd4ff`) |
| Addendum C | Phase 1.5 | AX build/review harness scaffolding | [x] Done (`0d0fb6d` + follow-ups) |
| #134 | C | Crew Validator (validation matrix) | [~] In progress |

**Key deliverables:**
- [x] 15 PostgreSQL tables (7 taxonomy, 5 ability catalog, 3 intent)
- [x] `evaluateEffect()` pure function (works / conditional / blocked)
- [x] Intent definitions as DB-backed weighted feature vectors
- [x] CM hard gate for captain slot (replaces soft +3/-2 bonus)
- [x] Synergy as multiplier: `finalScore = baseScore × (1 + 0.03 × synergyPairs)`
- [x] Per-officer "Why" evidence with effect tags + issue types
- [x] Effects Contract v3 Phase 1 scaffold: deterministic validator/order/hash + dry-run report
- [x] AX harness scaffold: `effects:build`, `effects:review-pack`, guarded `effects:apply-decisions`
- [x] Effects Contract v3 Phase 2 hardening: source-locator semantics, unknown-key unmapped emission, ability invariants
- [x] Effects Contract v3 Phase 3 trigger + inference sidecar provenance/hashing
- [x] Effects Contract v3 Phase 4 gate runner + promotion receipts + no-overwrite invariant
- [x] Effects Contract v3 Phase 5 override engine + precedence + contradiction protection
- [x] Effects Contract v3 Phase 6 CI budgets + runtime split/caching rollout
- [x] Post-review runtime cache hardening: stable manifest ETag basis, raw JSON cache representation, and chunk `If-None-Match` → `304` coverage
- [ ] "Does it work?" validation matrix (Phase C)

See [ADR-034](docs/ADR-034-effect-taxonomy.md) for full design.

### Up Next — Effects Officer Data Source v2 (ADR-035)

**Goal:** keep contract surface deterministic in git while moving full officer corpus to DB-derived snapshot exports.

**Status:** Completed for current scope (Phases 0-5 + Lex follow-up decisions A/B/C)

- [x] Phase 0: ADR + policy/guardrail scaffold (`ADR-035`, `DATA_HYGIENE.md`, `ax data:hygiene` in `ax ci`)
- [x] Phase 1: Snapshot metadata schema + deterministic `effects:snapshot:export` command
- [x] Phase 2: `effects:build` input split (fixture/full export) with stable hash/id policy
- [x] Phase 3: Nightly pinned snapshot gate (`contentHash`) + full-data budget regressions
- [x] Phase 4: Minimize in-repo officer seed corpus to fixtures only
- [x] Phase 5 (optional): value canonicalization table scaffold for parser quality improvements

**PM checkpoints (track explicitly):**
- [x] PR CI remains hermetic (no live DB dependency)
- [x] Nightly reproducibility proven with pinned snapshot `contentHash`
- [x] Raw CDN commit guardrails enforced and documented
- [x] Coverage/inference budget semantics preserved during migration

### Planned — Effects Runtime DB Activation Model (Cross-Repo Program)

**Priority:** Next program slice after current Effects v3 hardening.  
**Naming policy:** In Majel, keep terminology generic/source-neutral (use “data ingestion”, “dataset promotion”, “runtime dataset”).

| Issue | Scope | Status |
|---|---|---|
| #150 | Effects runtime: dataset run metadata + active pointer tables | [ ] Not started |
| #151 | Run-scoped catalog model + active-run runtime reads | [ ] Not started |
| #152 | `ax effects:promote:db` with full-replace ingestion semantics | [ ] Not started |
| #153 | Runtime health endpoint for activation smoke checks | [ ] Not started |
| #154 | Policy-driven activation gates + CI hygiene for generated datasets | [ ] Not started |

**Program outcomes:**
- Runtime reads only DB active-run data (no serving dependency on seed JSON).
- Promotion and rollback are metadata-driven (`run_id` pointer flip).
- Activation is policy-gated (viability + non-regression + cardinality) via config.

---

## Done — Timer Overlay (ADR-033, #111)

**Priority: After cache Phase 1 (#107).** Small, self-contained feature (~500 LOC).

Multi-timer overlay with 10 concurrent timers, 10 distinct Web Audio sounds, repeating mode, persistent top bar. Used for ship travel timers, resource refresh cycles, event cadence.

- [x] Timer store + tick engine + localStorage persistence
- [x] Web Audio API sound definitions (10 LCARS-themed sounds)
- [x] TimerBar / TimerPill / TimerDetail / TimerCreate components
- [x] Wire into App.svelte above view router
- [x] Tests (31 passing)

**Status:** Merged via PR #112 (b28e7df). 11 files, +1,620 lines, 31 tests. Issue #111 closed.

---

## Important — Should Fix Soon

### Performance
- [x] I1: N+1 loadout member queries → batch fetch (2 queries)
- [x] I2: N+1 dock assignment queries → batch fetch (2 queries)
- [x] I3: Transactional creates for loadout + plan items
- [x] M1: 24 seed INSERTs → 1 multi-value INSERT
- [x] M4: Window function for officer conflicts (was correlated subquery)
- [—] I8: `SELECT *` in some queries — tables narrow enough, deferred
- [—] M5: 6 subquery counts in summary — already efficient single query

### Documentation
- [x] ADR index in CONTRIBUTING.md missing ADR-018 through ADR-022
- [x] README test count says 512 (actual: 738)
- [x] README project structure is stale (missing auth.ts, user-store.ts, loadout-store.ts, cloud.ts)
- [x] README architecture diagram doesn't show PostgreSQL
- [x] README says "local-only" but cloud deployment is operational
- [x] README dependency table missing `pg`, `cookie-parser`
- [x] CONTRIBUTING.md "What We're NOT Accepting" section is stale (auth, cloud, model selector all exist now)
- [x] CONTRIBUTING.md says "No linter configured" — this should be revisited *(fixed 2026-02-21: now documents enforced `npm run lint` workflow)*

### Security
- [x] **minimatch ReDoS (GHSA-3ppc-4f35-3m26):** 7 high-severity transitive deps via typescript-eslint → resolved via `overrides` in package.json (04ded17)
- [x] **ajv moderate vulnerability:** resolved via `npm audit fix` (04ded17)
- [x] **xlsx prototype pollution (GHSA-4r6h-8v6p-xvw6):** ~~no upstream fix from SheetJS — feature-flagged at server validation layer + UI picker restricted to CSV-only (ae9e866)~~ → **Resolved (3a94f47):** replaced `xlsx@0.18.5` with `exceljs@4.4.0` (zero CVEs). XLSX import fully re-enabled.

---

## Minor — Nice to Have

- [x] Cloud CLI: merge `COMMAND_ARGS` into `CommandDef` interface (F5)
- [x] Cloud CLI: `shellSplit` should handle double quotes or warn (F6)
- [x] API: auto-generate discovery from Express router introspection (F4 long-term fix) *(fixed 2026-02-21: `collectApiRoutes()` + discovery generation in `src/server/routes/core.ts`)*
- [x] API: define `HealthResponse` type to guard contract (E4) *(fixed 2026-02-21: explicit `HealthResponse` contract in `src/server/routes/core.ts`)*
- [x] API: type `res.locals` via Express module augmentation (E5)
- [x] API: `ErrorCode` namespace convention for module-specific codes (E2)
- [x] Shared AX types between CLI and API (E3)
- [x] Integration test: discovery endpoints match actual Express routes *(fixed 2026-02-21: `test/api.test.ts` route parity assertion using introspection)*

---

## Done — Post-v0.6.0 Review Sweep (2026-02-21)

Comprehensive 10-finding code review of all post-v0.6.0 changes. All resolved in commit `3a94f47`.

| # | Category | Finding | Resolution |
|---|---|---|---|
| 1 | Security | `xlsx@0.18.5` prototype pollution (GHSA-4r6h-8v6p-xvw6) | Replaced with `exceljs@4.4.0` — XLSX import re-enabled |
| 2 | Bug | "parasteel" typo in 4 locations | Corrected to "parsteel" across intent catalog, crew types, recommender |
| 3 | Bug | `abilityBlob()` joined all 3 abilities regardless of slot (BDA/CM leakage) | Removed dead function |
| 4 | Bug | Ore substring false positives ("ore" matching "explores", "stored") | Word-boundary `\b` regex in `hasKeyword()` and `miningGoalFit()` |
| 5 | Bug | Inert CM gets +3 captain bonus | Added inert-text detection → -2 penalty |
| 6 | Security | SSRF risk in web_lookup — no redirect blocking, no timeout, no size cap | `safeFetchInit()` + `safeReadText()` on all 4 `fetch()` calls |
| 7 | Performance | AdmiralView overfetch on mount (#123) | `$effect` tab-scoped lazy refresh, loaded-tabs tracking |
| 8 | Performance | FleetView cross-ref fan-out (#127) | Tab-scoped lazy cross-ref loading, removed dead `fetchBelowDeckPolicies()` |
| 9 | Test coverage | Missing web_lookup rate-limit tests | 3 new tests: enforcement, per-domain isolation, observability |
| 10 | Dead code | 9 unreachable `mining-*` entries in INTENT_KEYWORDS | Removed |

---

## Done — Architecture Restructure (#47, ADR-023)

MVC-by-concern restructure of the client. **Completed** — all 6 phases delivered.

| Issue | Phase | Title | Status |
|---|---|---|---|
| #48 | 0 | Scaffolding — directories + READMEs | ✅ Done |
| #49 | 1 | API decomposition — split api.js | ✅ Done |
| #50 | 2 | CSS decomposition — split styles.css | ✅ Done |
| #51 | 3 | View extraction + router registry | ✅ Done |
| #52 | 4 | Admiral-dashboard rename | ✅ Done |
| #53 | 5 | Server grouping (stores/types/services) | ✅ Done |

---

## Done — AX Toolkit Refactor (2026-02-19)

Decomposed monolithic `scripts/ax.ts` (1,252 lines) into modular `scripts/ax/` directory:

- `scripts/ax.ts` → 91-line thin router
- `scripts/ax/` → 10 module files totaling 1,156 lines
- All human output removed (JSON-only), `--ax` flag dropped
- NDJSON append log (`logs/ax-runs.ndjson`) for run history
- CI verified: 0 lint errors, 0 type errors, 1,344/1,344 tests passed

---

## Done — Svelte 5 + Vite Frontend Migration (ADR-031)

**Decision:** Migrate vanilla JS client (8,335 LOC, 28 files) to Svelte 5 + Vite. **No SvelteKit** — avoids meta-framework lock-in, SSR not needed (app behind auth). Express API stays 100% untouched.

See [ADR-031](docs/ADR-031-svelte-migration.md) for full decision rationale.

| Issue | Phase | Title | Status |
|---|---|---|---|
| #95 | 0 | Scaffold — `web/` + Vite + Svelte 5 + proxy | ✅ Done |
| #96 | 1 | Shell — App.svelte + router + sidebar + LCARS theme | ✅ Done |
| #97 | 2 | API layer — typed fetch wrapper + auth store | ✅ Done |
| #98 | 3 | Chat view migration | ✅ Done |
| #99 | 4 | Catalog + Fleet views migration | ✅ Done |
| #100 | 5 | Workshop + Plan views migration (largest payoff) | ✅ Done |
| #101 | 6 | Admiral + Diagnostics views | ✅ Done |
| #102 | 7 | Help panel + confirm dialog + shared components | ✅ Done |
| #103 | 8 | Production build integration + legacy cleanup | ✅ Done |

**Migration complete (v0.5.0).** Legacy client deleted (45 files, ~12,691 LOC). Landing page separated to `src/landing/`. Frontend test suite added (54 tests). Deferred review items tracked in #104.

Key decisions:
- `web/` directory alongside existing `src/` (parallel operation during migration)
- Vite dev server proxies `/api/*` to Express :3000
- Production: `vite build` → static files → Express serves from `dist/web/`
- Svelte 5 runes (`$state()`, `$derived()`, `$effect()`) for reactivity
- TypeScript throughout client
- Client-side lightweight router (not file-system routing)

### Previous decisions (ADR-023) carried forward

- View registry pattern (each view self-registers)
- 7 views (per ADR-030 view consolidation): Chat, Catalog, Fleet, Workshop, Plan, Diagnostics, Admiral
- API domain modules (auth, chat, catalog, fleet, crews, etc.)

---

## Shelved (v1.0+)

See [ADR-006](docs/ADR-006-open-alpha.md) for the full list. Key items:
- ~~SvelteKit migration (ADR-002)~~ → Superseded by ADR-031 (Svelte 5 + Vite, no Kit)
- Plugin/extension system
- Alliance/guild multi-user features
- Mobile native apps

---

*Last updated by PM sweep — 2026-02-22*
