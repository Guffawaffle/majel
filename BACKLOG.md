# Backlog

> Tracked issues, tech debt, and planned work for Majel.
> Updated: 2026-02-14 | Branch: `arch/loadout-inversion`

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

## In Progress — Architecture Restructure (#47, ADR-023)

MVC-by-concern restructure of the client. Inserted between Phase 2 (API, done) and Phase 3 (UI).

| Issue | Phase | Title | Status |
|---|---|---|---|
| #48 | 0 | Scaffolding — directories + READMEs | Not started |
| #49 | 1 | API decomposition — split api.js | Not started |
| #50 | 2 | CSS decomposition — split styles.css | Not started |
| #51 | 3 | View extraction + router registry | Not started |
| #52 | 4 | Admiral-dashboard rename | Not started |
| #53 | 5 | Server grouping (stores/types/services) | Not started |

Key decisions:
- `admin` → `admiral-dashboard` (DOM/CSS/routes) to reduce bot scanning noise
- View registry pattern replaces manual `show*()` coupling in app.js
- Lazy CSS loading per view (no bundler, browser-native)
- `api.js` (51 exports) → `api/` directory with 11 domain modules + shared `_fetch.js`
- File header manifests (`@module`, `@domain`, `@depends`) for agent navigation
- README breadcrumbs per directory

### Loadout Pipeline (updated)

```
ADR-022 ✅ → #42 (store) ✅ → #43 (API) ✅ → #47 (restructure) → #44 (UI) → #41 (ADVANCED) → #45 (solver)
```

---

## Shelved (v1.0+)

See [ADR-006](docs/ADR-006-open-alpha.md) for the full list. Key items:
- SvelteKit migration (ADR-002)
- Plugin/extension system
- Alliance/guild multi-user features
- Mobile native apps

---

*Last updated by PM sweep — 2026-02-14*
