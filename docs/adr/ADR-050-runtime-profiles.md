# ADR-050: Runtime Profiles & Cloud-Parity Local Dev

**Status:** revised  
**Date:** 2026-03-22  
**Revised:** 2026-03-22  
**Supersedes:** none  
**Related:** ADR-005 (config resolution), ADR-018 (auth), ADR-049 (chat/sync boundary)  
**Depends on:** none (this is a prerequisite for further product-boundary work)

---

## Context

Majel's local dev environment is close to functional but not close enough. The boot sequence has implicit ordering dependencies (e.g., `purgeLegacyEntries` queries `ship_overlay` before the overlay store creates it on a fresh DB). Dev-mode behavior is gated by scattered `NODE_ENV` checks and computed booleans (`isDev`, `isTest`). There is no formal concept of a runtime profile, no startup validation that catches misconfiguration before the server starts serving requests, and no dev-only inspection endpoints for agent-driven testing.

The result: we keep learning through Cloud Run — the noisiest, most expensive, hardest-to-debug environment. Smoke testing requires deploying. Debugging requires Cloud Logging. The tool-mode classifier bug from the prior session could not be conclusively diagnosed locally because the local dev path was not trustworthy enough.

This ADR establishes a runtime profile model so that local dev is the **primary development and testing surface** — cloud-parity in app behavior, with explicit infrastructure adapter boundaries and dev-only capabilities that are impossible to enable in production.

---

## Decision

### Runtime Profiles

Three profiles, set via `MAJEL_PROFILE` env var:

| Profile | `MAJEL_PROFILE` | Purpose | Provider | Auth |
|---------|-----------------|---------|----------|------|
| `dev_local` | `dev_local` (or unset when `NODE_ENV !== "production"`) | Local development, agent testing, smoke tests | `stub` by default; `real` opt-in | Disabled (admiral bypass) |
| `cloud_prod` | `cloud_prod` (or inferred when `NODE_ENV === "production"`) | Cloud Run production | `real` (required) | Enforced |
| `test` | `test` (or inferred when `VITEST === "true"`) | Vitest unit/integration tests | `off` | Disabled |

The profile is resolved once at startup and is immutable for the lifetime of the process.

### Profile Resolution

```typescript
export type RuntimeProfile = "dev_local" | "cloud_prod" | "test";

export function resolveProfile(): RuntimeProfile {
  // Explicit profile always wins
  const explicit = process.env.MAJEL_PROFILE;
  if (explicit === "dev_local" || explicit === "cloud_prod" || explicit === "test") {
    return explicit;
  }

  // Infer from existing env signals
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    return "test";
  }
  if (process.env.NODE_ENV === "production") {
    return "cloud_prod";
  }
  return "dev_local";
}
```

**Why not just `NODE_ENV`?** `NODE_ENV` conflates too many things (dependency optimization, logging, error handling). A runtime profile is about which capabilities are available and what startup invariants are validated. `NODE_ENV=development` could mean "local dev" or "staging" or "docker compose test." `MAJEL_PROFILE=dev_local` means exactly one thing.

### Backward Compatibility

When `MAJEL_PROFILE` is unset, the profile is inferred from existing signals (`NODE_ENV`, `VITEST`). This means:
- `npm run dev` → `dev_local` (no change to existing scripts)
- `npm test` → `test` (no change)
- Cloud Run Dockerfile already sets `NODE_ENV=production` → `cloud_prod` (no change)

Existing `isDev` / `isTest` / `nodeEnv` fields on `AppConfig` are preserved and derived from the profile. No breaking changes.

---

## 1. Profile Contract: Invariants, Capabilities, and Provider Mode

The profile contract is split into three distinct layers:

1. **Boot invariants** — what must exist for the process to start. Validated once at boot; failure is fatal.
2. **Runtime capabilities** — what the running process is allowed to do. Derived from the profile, immutable after boot, checked at call sites.
3. **Adapters / config** — how the process connects to infrastructure. Normal `AppConfig` via `resolveConfig()`, safe in any profile.

This separation matters because the concepts serve different purposes: a boot invariant is "do we have a database connection string?" A runtime capability is "are we allowed to register dev endpoints?" Putting both into a flat struct creates a junk drawer that gets harder to reason about as surfaces grow.

### Boot Invariants

```typescript
export interface BootInvariants {
  requireDatabase: boolean;         // Must connect to Postgres or fail to start
  requireProvider: boolean;         // Must have GEMINI_API_KEY or fail to start
  requireAuth: boolean;             // Must have auth tokens configured or fail to start
}
```

### Runtime Capabilities

```typescript
export interface RuntimeCapabilities {
  // Provider
  providerMode: ProviderMode;       // How the chat engine behaves (see below)

  // Auth
  authEnforced: boolean;            // Whether auth middleware checks tokens/sessions
  bootstrapAdmiral: boolean;        // Whether dev admiral bypass is active

  // Dev-only surfaces
  devEndpoints: boolean;            // Whether /api/dev/* routes are registered
  devInspection: boolean;           // Whether state inspection tools are available
  devSeed: boolean;                 // Whether seed/reset helpers are available

  // Observability
  prettyLogs: boolean;              // Pretty-printed structured logs
  gcpLogFormat: boolean;            // GCP Cloud Logging severity format
  verboseTraces: boolean;           // Extra-detailed operation event payloads
}
```

### Provider Mode

Provider access is not a boolean. It has three explicit states:

```typescript
export type ProviderMode = "real" | "stub" | "off";
```

| Mode | Engine initialized? | Calls real model? | Use case |
|------|-------------------|------------------|----------|
| `real` | Yes (Gemini/Claude SDK) | Yes | Production; local when `MAJEL_DEV_PROVIDER=real` |
| `stub` | Yes (stub adapter) | No — returns canned/echo responses | Default local dev: full chat UX flow without token spend |
| `off` | No | No | Tests: engine is absent, chat route returns structured error |

**Why `stub` is the default for `dev_local`, not `off`:**
A dev environment where chat is disabled is not "fully functional." With `stub` as the default, an agent or developer gets a working end-to-end chat path — route → classifier → engine → tool declarations → response rendering — on first boot, without spending tokens and without flipping env vars. The stub adapter returns deterministic responses that are useful for smoke testing, UI iteration, and verifying the mutation/proposal pipeline.

Real provider access is opt-in:
```bash
MAJEL_DEV_PROVIDER=real npm run dev    # Uses real Gemini SDK
MAJEL_DEV_PROVIDER=off npm run dev     # Disables engine entirely
```

### Combined Profile Contract

```typescript
export interface ProfileContract {
  invariants: BootInvariants;
  capabilities: RuntimeCapabilities;
}
```

### Profile → Contract Mapping

```typescript
const PROFILE_CONTRACTS: Record<RuntimeProfile, ProfileContract> = {
  dev_local: {
    invariants: {
      requireDatabase: true,
      requireProvider: false,        // Provider is opt-in for local
      requireAuth: false,
    },
    capabilities: {
      providerMode: "stub",          // Full chat UX by default, no token spend
      authEnforced: false,
      bootstrapAdmiral: true,
      devEndpoints: true,
      devInspection: true,
      devSeed: true,
      prettyLogs: true,
      gcpLogFormat: false,
      verboseTraces: true,
    },
  },
  cloud_prod: {
    invariants: {
      requireDatabase: true,
      requireProvider: true,         // Chat is the product — must have provider
      requireAuth: true,
    },
    capabilities: {
      providerMode: "real",
      authEnforced: true,
      bootstrapAdmiral: false,
      devEndpoints: false,
      devInspection: false,
      devSeed: false,
      prettyLogs: false,
      gcpLogFormat: true,
      verboseTraces: false,
    },
  },
  test: {
    invariants: {
      requireDatabase: false,        // See "Test profile and database" below
      requireProvider: false,
      requireAuth: false,
    },
    capabilities: {
      providerMode: "off",
      authEnforced: false,
      bootstrapAdmiral: true,
      devEndpoints: false,           // Tests use stores directly, not HTTP
      devInspection: false,
      devSeed: false,
      prettyLogs: false,
      gcpLogFormat: false,
      verboseTraces: false,
    },
  },
};
```

### Test Profile and Database

The `test` profile sets `requireDatabase: false`. This means:

- **Unit tests** (pure functions, classifiers, parsers, config resolution) run without Postgres. No pool created, no connection attempted. This is the majority of tests and the cheapest CI signal.
- **Integration tests** that need stores create their own pool via the existing shared test pool helper (`test/helpers/pool.ts`). The pool helper checks for `DATABASE_URL` at setup time and skips the suite if Postgres is unavailable.

This avoids the antipattern of requiring Postgres for every test file. The profile says "you may or may not have a database"; individual test files declare their own dependency:

```typescript
// Integration test — needs DB
const pool = await getTestPool(); // skips suite if no Postgres
const store = OverlayStoreFactory(pool);

// Unit test — no DB needed
import { classifyToolMode } from "../src/server/services/gemini/tool-mode.js";
// just call functions directly
```

The `ax test` and `ax ci` commands still start Postgres first (via `npm run pg`) because the full suite includes integration tests. But an agent running a single unit-test file or a quick classifier check does not need to wait for Postgres.

### Provider Mode Resolution in `dev_local`

```typescript
// In dev_local, provider defaults to stub.
// Override with: MAJEL_DEV_PROVIDER=real  (uses real Gemini SDK)
// Override with: MAJEL_DEV_PROVIDER=off   (disables engine entirely)

function resolveProviderMode(
  profile: RuntimeProfile,
  baseMode: ProviderMode,
): ProviderMode {
  if (profile !== "dev_local") return baseMode;

  const override = process.env.MAJEL_DEV_PROVIDER;
  if (override === "real" || override === "stub" || override === "off") {
    return override;
  }
  return baseMode; // "stub"
}
```

---

## 2. Startup Validation

At boot, before any store initialization, the profile validates its invariants. Fail fast, fail loud.

```typescript
export function validateProfile(
  profile: RuntimeProfile,
  contract: ProfileContract,
  env: NodeJS.ProcessEnv,
): void {
  const errors: string[] = [];

  // Database required for dev_local and cloud_prod (not test)
  if (contract.invariants.requireDatabase) {
    if (profile === "cloud_prod" && !env.DATABASE_URL) {
      errors.push("DATABASE_URL must be set in cloud_prod profile");
    }
    // For dev_local: fall through to hardcoded defaults (already handled by config.ts)
  }

  // Provider required in cloud_prod
  if (contract.invariants.requireProvider && !env.GEMINI_API_KEY) {
    errors.push("GEMINI_API_KEY must be set in cloud_prod profile");
  }

  // Auth requirements
  if (contract.invariants.requireAuth && !env.MAJEL_ADMIN_TOKEN && !env.MAJEL_INVITE_SECRET) {
    errors.push("MAJEL_ADMIN_TOKEN or MAJEL_INVITE_SECRET must be set when auth is required");
  }

  // Dev capabilities must never be available in cloud_prod
  if (profile === "cloud_prod" && contract.capabilities.devEndpoints) {
    errors.push("FATAL: devEndpoints capability is true in cloud_prod — this is a configuration error");
  }

  // Contradictory config: explicit dev profile with production NODE_ENV
  if (env.MAJEL_PROFILE === "dev_local" && env.NODE_ENV === "production") {
    errors.push("MAJEL_PROFILE=dev_local conflicts with NODE_ENV=production");
  }

  if (errors.length > 0) {
    console.error(`\n❌ Profile validation failed [${profile}]:\n${errors.map(e => `  • ${e}`).join("\n")}\n`);
    process.exit(1);
  }
}
```

### Boot Banner

After validation passes, print a clear boot banner so it's immediately obvious what profile is active:

```
┌─────────────────────────────────────────┐
│  MAJEL  dev_local                       │
│  Provider: stub (MAJEL_DEV_PROVIDER=real for live) │
│  Auth: disabled (admiral bypass)        │
│  Dev endpoints: enabled (/api/dev/*)    │
│  Database: postgres://localhost:5432/majel │
└─────────────────────────────────────────┘
```

---

## 3. Infrastructure Adapter Boundaries

### What Already Exists

The codebase already has clean adapter boundaries for most infrastructure:

| Component | Adapter Pattern | Swappable? |
|-----------|----------------|-----------|
| Database pools | `createPool(connectionString)` | Yes — URL from env |
| Store factories | `Factory(pool)` with `forUser()` / `forContext()` | Yes — pool injected |
| Auth | `requireRole(appState, role)` with dev bypass | Yes — `authEnabled` flag |
| Logging | Pino with conditional GCP format | Yes — conditional on env |
| Email | SMTP transport or dev-mode console log | Yes — transport presence |

### What Needs Work

| Component | Current | Target |
|-----------|---------|--------|
| Provider initialization | Hard-fails silently if no API key, logs warning | Three-mode gate: `real` (SDK), `stub` (echo adapter), `off` (absent) |
| Boot ordering | Implicit staging, fragile if tables don't exist | Explicit validation that required tables exist before dependent stages |
| Schema initialization | Each store runs `initSchema()` independently | Boot stage validates schema completeness before services start |
| Dev-mode auth | `!appState.config.authEnabled` → bypass | `capabilities.bootstrapAdmiral` → bypass (same behavior, clearer name) |

### Infra Surfaces That Differ Between Local and Cloud

At the application level, five infra adapters differ and are already handled by env vars:

1. **Database URL** — Docker Postgres vs Cloud SQL socket
2. **Provider API key** — optional locally, required in cloud
3. **Secrets/auth tokens** — optional locally (bootstrap bypass), required in cloud
4. **Log format** — pretty-print vs GCP JSON
5. **Email transport** — console log vs SMTP

Application-level routes, stores, mutations, proposals, events, and auth middleware logic use the same codepaths in both environments. There are no local-only fake execution paths.

**However**, local cannot validate every cloud runtime characteristic. Cloud Run introduces behaviors that have no local analog:

- **Process lifecycle** — cold starts, instance scaling, request-scoped container recycling
- **Request concurrency** — Cloud Run's concurrency model vs single-threaded local dev
- **Network topology** — VPC connector, Cloud SQL Auth Proxy sockets vs localhost TCP
- **Secret loading** — Secret Manager injection vs `.env` file
- **Outbound latency** — provider calls from GCP egress vs local ISP; retry characteristics differ

The profile model does not attempt to simulate these. Local dev validates app behavior and persistence flows; cloud validates infrastructure glue. The boundary is honest about this: same application logic, different infrastructure substrate.

---

## 4. Dev-Only Testing Points

### Route Surface: `/api/dev/*`

Registered only when `capabilities.devEndpoints === true`. The module is dynamically imported — not loaded in `cloud_prod`, not just guarded at runtime.

```typescript
// In src/server/index.ts boot:
if (capabilities.devEndpoints) {
  const { registerDevRoutes } = await import("./routes/dev.js");
  registerDevRoutes(app, state);
  log.boot.info("dev endpoints registered (/api/dev/*)");
}
```

### Safety Model

The real safety boundary is the **runtime profile validation**, not the dynamic import. The trust chain is:

1. **Profile resolved once at startup** — immutable for process lifetime
2. **Contradictory prod/dev config fails hard** — `MAJEL_PROFILE=dev_local` + `NODE_ENV=production` → fatal error
3. **Capabilities derived only from that profile** — no separate code paths can enable dev surfaces
4. **Dev route registration is impossible unless the profile says so** — the import gate is a consequence of the profile, not an independent control

The dynamic import is belt-and-suspenders: it keeps the dev routes module out of the `cloud_prod` module graph entirely (useful for dead-code elimination and reducing attack surface), but the profile validation is what you should trust. A middleware inside the dev routes module double-checks `capabilities.devEndpoints` at request time as defense in depth.

### Planned Dev Endpoints

| Endpoint | Purpose | Category |
|----------|---------|----------|
| `GET /api/dev/state` | Dump current AppState summary (store counts, engine status, profile, capabilities) | Inspection |
| `GET /api/dev/run/:requestId` | Full operation event stream for a chat run by requestId | Inspection |
| `GET /api/dev/overlay/:userId` | Dump all overlay rows for a user | Inspection |
| `GET /api/dev/proposals/:userId` | List all proposals with status for a user | Inspection |
| `POST /api/dev/seed` | Seed reference catalog + sample overlays for testing | Seed |
| `POST /api/dev/reset` | Truncate all user-scoped tables (overlays, proposals, receipts, events) while preserving reference catalog | Seed |
| `POST /api/dev/provider/echo` | Return a canned chat response without calling the real provider. Accepts `response` in body. | Provider stub |
| `GET /api/dev/tool-mode?message=...&hasImage=bool` | Run the classifier on a message and return the result (mode + bulkDetected) | Inspection |
| `GET /api/dev/trust/:toolName` | Return the resolved trust level for a tool (checks user overrides + defaults) | Inspection |

### What Is a Runtime Capability vs Normal Config

| Kind | Examples | How gated |
|------|----------|-----------|
| **Boot invariant** | `requireDatabase`, `requireProvider`, `requireAuth` | Profile → invariants object, validated at boot, fatal if unmet |
| **Runtime capability** | `devEndpoints`, `devInspection`, `providerMode`, `verboseTraces` | Profile → capabilities object, checked at call sites, immutable after boot |
| **Normal config** | Port, log level, database URL, API key | `AppConfig` via `resolveConfig()`, can change via settings store |

Rule: if its absence should prevent the process from starting, it's an invariant. If enabling it in prod would be a security or correctness risk, it's a capability. If it's just a preference, it's config.

---

## 5. Local Persistence Strategy

### Already Solved

Local persistence already works via Docker Compose Postgres with a named volume (`pgdata`). Data survives container restarts. The dual-pool pattern (`majel` superuser + `majel_app` runtime user) works identically in local and cloud.

### What Needs Fixing

1. **Fresh DB boot failure**: On a brand-new database, `purgeLegacyEntries()` in Stage 1 queries `ship_overlay` / `officer_overlay` / `targets` before Stage 2 creates those tables. Fix: either move purge to Stage 2, or make it tolerant of missing tables (catch `relation does not exist` and skip).

2. **No one-command seed**: There's no `npm run seed` or `ax seed` that populates a fresh local DB with reference catalog data and sample overlays. An agent or developer starting fresh has to figure out what to do.

3. **No one-command reset**: There's no clean way to wipe user-scoped data (overlays, proposals, receipts) while preserving the reference catalog for re-testing.

### Target State

```bash
# Start everything
npm run pg && npm run dev

# Fresh start (wipe + seed)
npm run ax -- dev:reset && npm run ax -- dev:seed

# Or via HTTP (when server is running)
curl -X POST http://localhost:3000/api/dev/reset
curl -X POST http://localhost:3000/api/dev/seed
```

---

## 6. Local Observability Strategy

### Principle: Local Should Be the Easiest Place to Debug

| Question | Cloud answer | Local answer (target) |
|----------|-------------|----------------------|
| What happened in this run? | Cloud Logging → filter by requestId | `GET /api/dev/run/:requestId` → full event stream |
| What tool mode was used? | Grep structured logs | `GET /api/dev/tool-mode?message=...` → instant classifier result |
| What mutation/proposal occurred? | Query Cloud SQL | `GET /api/dev/proposals/:userId` → full proposal list |
| What DB state changed? | Connect to Cloud SQL proxy | `GET /api/dev/overlay/:userId` → instant dump |
| What provider attempt happened? | Cloud Logging → filter by requestId + subsystem=gemini | `GET /api/dev/run/:requestId` → includes attempt info, tool mode, token usage |

### Verbose Traces

When `capabilities.verboseTraces === true` (dev_local only), operation events include extra payload fields:

- Full tool declarations sent to the model (tool names + parameter schema)
- Raw classifier signals (structured, transform intent, fleet intent, large payload, bulk detected)
- Request/response token counts per attempt
- System prompt addendum (if any, e.g., the bulk-commit gate instruction from ADR-049)

These fields are omitted in `cloud_prod` to keep event payloads lean and avoid logging sensitive context.

---

## 7. AX-First Developer Workflow

### New AX Commands

| Command | Purpose |
|---------|---------|
| `npm run ax -- dev:boot` | Validate profile, check Postgres, report capability summary |
| `npm run ax -- dev:seed` | Seed reference catalog + sample overlays (idempotent) |
| `npm run ax -- dev:reset` | Truncate user-scoped tables, preserve catalog |
| `npm run ax -- dev:smoke` | Run a smoke test suite against running local server |
| `npm run ax -- dev:inspect` | Dump current server state (profile, capabilities, store counts) |

### Agent Workflow

```bash
# 1. Boot
npm run pg
npm run ax -- dev:boot       # Validates profile, Postgres, config
npm run dev                  # Server starts with dev_local profile + stub provider

# 2. Seed (one-time or after reset)
npm run ax -- dev:seed

# 3. Exercise
# Chat uses stub provider by default — full UX flow, no token spend
# For real provider: MAJEL_DEV_PROVIDER=real npm run dev
# Inspect state: npm run ax -- dev:inspect
# Smoke test: npm run ax -- dev:smoke

# 4. Validate
npm run ax -- ci
```

### Documented Local URLs

| URL | Purpose |
|-----|---------|
| `http://localhost:3000/api/health` | Health check |
| `http://localhost:3000/api/dev/state` | Profile + capability + store summary |
| `http://localhost:3000/api/dev/overlay/local` | User "local" overlay state |
| `http://localhost:3000/api/dev/proposals/local` | User "local" proposals |
| `http://localhost:3000/api/dev/tool-mode?message=...` | Classifier test |

---

## Implementation Slices

### Slice 1: Runtime Profile + Startup Validation

**Goal:** Introduce the runtime profile model, wire it through config, validate at boot, print the boot banner.

Changes:
1. **New file `src/server/runtime-profile.ts`**: `RuntimeProfile` type, `resolveProfile()`, `BootInvariants` & `RuntimeCapabilities` interfaces, `ProfileContract`, `PROFILE_CONTRACTS` map, `resolveProviderMode()`, `validateProfile()`, boot banner printer
2. **`src/server/config.ts`**: Add `profile: RuntimeProfile`, `contract: ProfileContract` to `AppConfig`. Derive `isDev`/`isTest`/`authEnabled` from the profile+contract instead of computing them independently.
3. **`src/server/index.ts`**: Call `resolveProfile()` + `validateProfile()` before Stage 0. Log the boot banner.
4. **`src/server/logger.ts`**: Use `capabilities.prettyLogs` and `capabilities.gcpLogFormat` instead of raw `IS_DEV`/`IS_TEST` checks.
5. **Tests**: Profile resolution, provider mode resolution, validation (contradictory config, missing invariants), contract derivation

**Why first:** Everything else depends on having a formal profile to gate against. Without this, dev endpoints and capability checks have nothing to attach to.

### Slice 2: Fix Fresh DB Boot + Dev Seed/Reset

**Goal:** A fresh database boots cleanly without manual table creation. One-command seed and reset.

Changes:
1. **`reference-store-bulk.ts`**: Make `purgeLegacyEntries()` tolerate missing tables (catch `42P01` error code, log info, return `{ ships: 0, officers: 0 }`)
2. **New ax command `dev:seed`**: Insert reference catalog snapshot + sample overlays for user "local"
3. **New ax command `dev:reset`**: Truncate user-scoped tables via selective truncation (preserve reference catalog)
4. **New ax command `dev:boot`**: Profile validation + Postgres connectivity check + schema status report

### Slice 3: Dev Endpoints + Inspection (`/api/dev/*`)

**Goal:** Inspection and testing endpoints available only in `dev_local`. This is critical for local observability and should land early — the inspection endpoints are what make the local runtime valuable for debugging, not a nice-to-have.

Changes:
1. **New file `src/server/routes/dev.ts`**: All dev endpoints (state, run, overlay, proposals, tool-mode, trust, provider/echo, seed, reset)
2. **`src/server/index.ts`**: Conditional dynamic import of dev routes when `capabilities.devEndpoints`
3. **Tests**: Verify dev routes are NOT registered when profile is `cloud_prod` or `test`

### Slice 4: Provider Mode Gate + Stub Adapter

**Goal:** Three-mode provider initialization: `real` (SDK), `stub` (echo adapter), `off` (absent). Default `dev_local` to `stub` so chat works end-to-end without tokens.

Changes:
1. **New stub adapter**: Implements the same engine interface as the real Gemini adapter, returns deterministic canned responses, supports tool call echo
2. **Engine initialization**: Branch on `providerMode` — `real` → existing Gemini/Claude init, `stub` → stub adapter, `off` → skip
3. **Chat route**: Works normally with stub adapter; returns structured error only when `providerMode === "off"`
4. **Health endpoint**: Reports provider status as `real`, `stub`, or `not configured` based on mode

### Slice 5: Verbose Traces + AX Smoke

**Goal:** Rich operation event payloads in dev_local, plus a smoke test ax command.

Changes:
1. **Operation event emission**: When `capabilities.verboseTraces`, include classifier signals, tool declarations, token counts in event payloads
2. **New ax command `dev:smoke`**: Scripted smoke test against running server (health check, seed if needed, exercise key routes, validate responses)

---

## What Carries Forward

| Existing pattern | Status | Change |
|-----------------|--------|--------|
| `isDev` / `isTest` on AppConfig | Preserved | Derived from profile instead of raw NODE_ENV |
| `NODE_ENV` checks in logger | Replaced | Uses `capabilities.prettyLogs` / `capabilities.gcpLogFormat` |
| `authEnabled` computation | Replaced | Uses `capabilities.authEnforced` |
| Dev-only auth bypass | Preserved | Reframed as `capabilities.bootstrapAdmiral` |
| Dev email verification | Preserved | Gated by `capabilities.devEndpoints` instead of `NODE_ENV` check |
| Store factory pattern | Unchanged | Same dual-pool, same `forUser()` / `forContext()` |
| `.env.example` | Updated | Add `MAJEL_PROFILE` and `MAJEL_DEV_PROVIDER` examples |
| `npm run dev` workflow | Unchanged | Default behavior is identical (infers `dev_local`, stub provider) |

---

## Answers to Specific Questions

### 1. What are the minimum infra surfaces that must differ between local and cloud?

At the application level, five infra adapters differ and are already handled by env vars:
1. **Database URL** — Docker Postgres vs Cloud SQL socket
2. **Provider API key** — optional locally, required in cloud
3. **Auth tokens** — optional locally (bootstrap bypass), required in cloud
4. **Log format** — pretty-print vs GCP JSON
5. **Email transport** — console log vs SMTP

Application-level routes, stores, mutations, proposals, events, and auth middleware logic use the same codepaths. Beyond these five, Cloud Run introduces runtime characteristics (cold starts, concurrency model, VPC networking, Secret Manager integration, outbound latency profiles) that have no local analog. Local validates app behavior; cloud validates infrastructure glue.

### 2. What should be a boot invariant vs a runtime capability vs normal config?

**Boot invariant**: its absence should prevent the process from starting (database connection, provider API key in prod, auth tokens in prod). Validated once at boot; failure is fatal.

**Runtime capability**: enabling it in prod would be a security or correctness risk (dev endpoints, verbose traces, auth bypass, provider stubs). Derived from the profile, immutable after boot, checked at call sites.

**Normal config**: preferences and connection parameters that are safe in any profile (port, log level, database URL, API key value). Resolved through the existing `AppConfig` chain.

### 3. Where should dev-only testing points live so they stay clean and safe?

In a single file (`src/server/routes/dev.ts`) that is dynamically imported only when `capabilities.devEndpoints === true`. The real safety boundary is the profile validation chain: profile → contract → capabilities → route registration. The dynamic import is belt-and-suspenders that keeps the module out of the prod module graph. A middleware inside the module double-checks the capability at request time as defense in depth.

### 4. What is the best local persistence setup for Majel right now?

Docker Compose Postgres with a named volume (`pgdata`), which is already in place. Data persists across container restarts. The only gap is: (a) fresh-DB boot ordering bug, and (b) no seed/reset commands. Both are fixed in Slice 2.

### 5. What are the minimum AX commands/scripts for a high-signal local workflow?

Five new commands:
- `ax dev:boot` — validate profile + Postgres + schema
- `ax dev:seed` — populate reference data + sample overlays
- `ax dev:reset` — wipe user state, keep catalog
- `ax dev:smoke` — exercise key routes against running server
- `ax dev:inspect` — dump server state

Plus the existing `ax status`, `ax test`, `ax ci`.

### 6. What dangerous assumption am I making if I say "local should do everything cloud does"?

Two risks:

**Provider token cost.** If local dev defaults to real provider calls, every smoke test spends real tokens. This is why `dev_local` defaults to `providerMode: "stub"` — the stub adapter gives you the full chat UX flow (route → classifier → engine → tool declarations → response rendering) without spending tokens. Real access is explicit: `MAJEL_DEV_PROVIDER=real`.

**Assuming cloud infrastructure is invisible.** Cloud SQL connection pooling, Cloud Run cold start behavior, concurrency limits, VPC networking, Secret Manager integration, and GCP IAM auth don't exist locally. The profile model makes this explicit: local uses Docker Postgres with the same schemas and pool settings, but Cloud Run-specific runtime behavior is not something the local profile claims to reproduce. Local dev validates the application; cloud validates the platform.

---

## Anti-Goals

1. **No scattered `if (isDev)` checks.** All dev-specific behavior is gated by capabilities, not raw environment checks. Existing `isDev` checks are migrated to capability references.
2. **No local-only fake execution paths.** Chat, mutations, proposals, overlays, events — all use the same codepaths as cloud. The stub provider is a real engine adapter that goes through the same pipeline; it just returns deterministic responses instead of calling the model.
3. **No implicit profile inference in production.** If `NODE_ENV=production` and `MAJEL_PROFILE` is unset, the profile resolves to `cloud_prod`. But if `MAJEL_PROFILE=dev_local` and `NODE_ENV=production`, validation fails. Contradictory config is an error, not a guess.
4. **No runtime profile changes.** The profile is resolved once at startup. There is no API to change it, no hot-reload, no "switch to dev mode." Restart with different env vars.
5. **No dev endpoints behind a password.** Dev endpoints are absent from the cloud_prod module graph, not hidden behind authentication. You cannot access them by guessing a URL or knowing a secret — they do not exist.
6. **No database requirement for unit tests.** The `test` profile does not require Postgres. Integration tests that need stores declare their own dependency. A quick classifier check or config resolution test runs without waiting for a database.
