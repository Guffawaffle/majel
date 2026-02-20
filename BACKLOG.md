# Backlog

> Tracked issues, tech debt, and planned work for Majel.
> Updated: 2026-02-19 | Branch: `main`

---

## Status Legend

| Symbol | Meaning |
|--------|---------|
| `[ ]` | Not started |
| `[~]` | In progress |
| `[x]` | Done |
| `[—]` | Deferred / won't fix |

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
- [ ] **F5 (MINOR):** `COMMAND_ARGS` and `COMMANDS` are separate maps — will desync
  - File: `scripts/cloud.ts` ~L1287 vs ~L1356
- [ ] **F6 (MINOR):** `shellSplit` only handles single quotes — double-quoted args silently break
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
- [ ] **E2 (MINOR):** `ErrorCode` is frozen const — no module-specific extension mechanism
- [ ] **E3 (IMPORTANT):** CLI `AxOutput` and API `ApiErrorResponse` schemas will diverge
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
- [ ] **W3:** `SELECT *` in audit queries — fragile if schema evolves; use explicit column list
- [ ] **W4:** Append-only not enforced at DB role level — `majel_app` has DELETE on `auth_audit_log`; revoke or add trigger

#### Auth Routes
- [ ] **W5:** `verify-email` and `reset-password` audit events missing `actorId`/`targetId`
- [ ] **W6:** Verify-email failure (invalid token) not audited
- [ ] **W7:** Reset-password failure paths not audited
- [ ] **W8:** Bootstrap middleware uses `admin.role_change` event (misleading) — rename to `admin.bootstrap_auth`
- [ ] **W9:** Bootstrap middleware constructs IP/UA inline — use `auditMeta(req)` for consistency
- [ ] **W10:** `GET /api/auth/admiral/users` (list users) not audited — sensitive admin read

#### Logger / GCP
- [ ] **W12:** Redact paths only 1-level deep (`*.token`) — deeper paths like `req.headers.authorization` missed

#### IP Allowlist
- [ ] **W15:** No IP syntax validation in `parseAllowedIps` — garbage entries silently ignored
- [ ] **W16:** `trust proxy` hardcoded to `1` — needs comment for multi-proxy deployments
- [ ] **W17:** No dedicated unit tests for `ip-allowlist.ts`

#### RUNBOOK
- [ ] **W18:** Missing query recipes: password reset abuse, signup spikes, 5xx errors, boot events, IP allowlist blocks

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
- [ ] CONTRIBUTING.md says "No linter configured" — this should be revisited

---

## Minor — Nice to Have

- [ ] Cloud CLI: merge `COMMAND_ARGS` into `CommandDef` interface (F5)
- [ ] Cloud CLI: `shellSplit` should handle double quotes or warn (F6)
- [ ] API: auto-generate discovery from Express router introspection (F4 long-term fix)
- [ ] API: define `HealthResponse` type to guard contract (E4)
- [x] API: type `res.locals` via Express module augmentation (E5)
- [ ] API: `ErrorCode` namespace convention for module-specific codes (E2)
- [ ] Shared AX types between CLI and API (E3)
- [ ] Integration test: discovery endpoints match actual Express routes

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

## In Progress — Svelte 5 + Vite Frontend Migration (ADR-031)

**Decision:** Migrate vanilla JS client (8,335 LOC, 28 files) to Svelte 5 + Vite. **No SvelteKit** — avoids meta-framework lock-in, SSR not needed (app behind auth). Express API stays 100% untouched.

See [ADR-031](docs/ADR-031-svelte-migration.md) for full decision rationale.

| Issue | Phase | Title | Status |
|---|---|---|---|
| #95 | 0 | Scaffold — `web/` + Vite + Svelte 5 + proxy | ✅ Done |
| #96 | 1 | Shell — App.svelte + router + sidebar + LCARS theme | ✅ Done |
| #97 | 2 | API layer — typed fetch wrapper + auth store | ✅ Done |
| #98 | 3 | Chat view migration | ✅ Done |
| #99 | 4 | Catalog + Fleet views migration | ✅ Done |
| #100 | 5 | Crews + Plan views migration (largest payoff) | Not started |
| #101 | 6 | Admiral + Diagnostics + Settings views | Not started |
| #102 | 7 | Help panel + shared components | Not started |
| #103 | 8 | Production build integration + legacy cleanup | 🚧 Build wired, cleanup blocked on Phases 4–7 |

Build pipeline + Express serving + Dockerfile already wired (done during Phase 3 wiring). Legacy cleanup deferred until all views migrated.
Deferred review items tracked in #104.

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

*Last updated by PM sweep — 2026-02-19*
