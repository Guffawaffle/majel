# Backlog

> Tracked issues, tech debt, and planned work for Majel.
> Updated: 2026-02-21 | Branch: `main`

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |
| `[—]` | Deferred / won't fix |

---

## Next Cloud Deploy Marker (Queued)

- **Do not deploy yet.**
- **Deploy checkpoint:** after ADR-026a A1 Guided Setup Templates (#70) is complete and validated.
- **Validation gate:** targeted tests for Start/Sync guided setup + catalog bulk receipt behavior pass.

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

## Up Next — Timer Overlay (ADR-033, #111)

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
- [x] **xlsx prototype pollution (GHSA-4r6h-8v6p-xvw6):** no upstream fix from SheetJS — feature-flagged at server validation layer + UI picker restricted to CSV-only (ae9e866)

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

*Last updated by PM sweep — 2026-02-20*
