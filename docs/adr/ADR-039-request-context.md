# ADR-039: Request Context & Scoped Database Execution

**Status:** Accepted  
**Date:** 2026-03-09  
**Authors:** Guff, GitHub Copilot (Claude Opus 4.6), Lex (ChatGPT)  
**References:** ADR-004 (ax-first API), ADR-018 (PostgreSQL), ADR-019 (user system / RBAC), ADR-021 (RLS frame store), ADR-023 (architecture restructure), ADR-025 (crew composition)

---

## Context

Majel's backend has grown to 18 stores, 17 route files, 20+ services, and 60+ LLM tool
declarations. Request-scoped context — identity, tracing, role, and logging — is threaded
through the codebase via four incompatible mechanisms:

- **Routes:** `res.locals` (userId, userRole, requestId, startTime)
- **Stores:** Factory closures: `.forUser(userId)` captures userId at construction
- **Fleet Tools:** `ToolContext` plain interface with userId + 10 optional store references
- **Services:** Explicit function parameters (or nothing)

This creates three concrete problems:

1. **No request-level tracing.** A requestId exists in the HTTP layer (envelope middleware)
   but cannot be correlated through store queries, service calls, or tool executions.
   Debugging production issues requires manual log correlation by timestamp.

2. **Inconsistent tenant scoping.** User-scoped stores use `withUserScope()` with
   transaction-local `set_config()` (safe). But `withUserRead()` uses session-scoped
   `set_config(..., false)` with a RESET in a finally block — a timing-leak risk if
   the RESET fails or is skipped, since the next query on that pooled connection would
   run with the wrong tenant identity.

3. **Ad-hoc context assembly.** Every route handler manually reads `res.locals`, resolves
   store factories, and threads userId to downstream calls. This is ~200 lines of
   boilerplate across 17 route files with no shared contract.

---

## Decision

Introduce a minimal request-scoped context model with two classes and one interface.

### D1: `RequestContext` — Thin, Immutable, Request-Scoped

```typescript
type RequestIdentity = Readonly<{
  requestId: string;
  userId: string;
  tenantId: string;       // Distinct from userId (may diverge for org tenancy)
  roles: readonly string[]; // ["ensign" | "lieutenant" | "captain" | "admiral"]
}>;

class RequestContext {
  readonly identity: RequestIdentity;   // Frozen at construction
  readonly startedAtMs: number;         // performance.now() — monotonic, for latency
  readonly timestamp: string;           // ISO 8601 wall-clock — for logs/audit
  readonly log: Logger;                 // Child logger with userId + requestId baked in
  readonly pool: Pool;                  // Reference to app-level pool (not owned)

  hasRole(role: string): boolean;
  elapsed(): number;                    // performance.now() - startedAtMs

  readScope<T>(fn: (db: DbScope) => Promise<T>): Promise<T>;
  writeScope<T>(fn: (db: DbScope) => Promise<T>): Promise<T>;
}
```

**Created once per HTTP request** from Express middleware. All fields are `readonly`.
`RequestIdentity` is `Object.freeze()`-d at construction.

**`RequestContext` is NOT created for:**
- Boot-time operations (migrations, seeding, reference ingest)
- Background jobs that outlive requests (use explicit pool access)

### D2: `DbScope` — Short-Lived, Transaction-Scoped

```typescript
class DbScope implements QueryExecutor {
  readonly ctx: RequestContext;         // Back-reference for logging
  private readonly client: PoolClient;  // Private, single transaction

  query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}
```

**Created inside `readScope()` or `writeScope()`.** Dies when the scope callback
returns. The transaction boundary guarantees tenant isolation:

- `readScope()`: `BEGIN READ ONLY` → `SET LOCAL app.current_user_id` → callback → `COMMIT` → release
- `writeScope()`: `BEGIN` → `SET LOCAL app.current_user_id` → callback → `COMMIT/ROLLBACK` → release

**`SET LOCAL` is used exclusively.** Session-scoped `set_config(..., false)` (the current
`withUserRead` pattern) is deprecated. `SET LOCAL` / `set_config(..., true)` dies with the
transaction — no cleanup needed, no cross-tenant leakage possible.

### D3: `QueryExecutor` Interface — Boot/Global Store Compatibility

```typescript
interface QueryExecutor {
  query<T>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}
```

Both `Pool` and `DbScope` satisfy this interface. Global/reference stores accept a
`QueryExecutor` and don't care whether the caller is boot-time (pool-backed) or
request-time (DbScope-backed). This avoids forcing boot operations through
`RequestContext`.

### D4: Two Database Lanes

| Lane | Scope | RLS | Created | Lifetime |
|------|-------|-----|---------|----------|
| **Global/System** | Boot, reference data, cross-tenant | No | App startup | App lifetime |
| **Tenant/Request** | User-scoped stores | Yes (`SET LOCAL`) | Per request | Request lifetime |

Global stores (reference, effect, behavior, settings) remain boot-created, pool-backed
singletons. They do NOT require `RequestContext`. They MAY receive call metadata
(requestId, userId) for logging correlation when invoked from request paths.

Tenant-scoped stores (crew, overlay, target, receipt, research, inventory, proposal,
operation-event) require `DbScope` with transaction-local RLS setup.

### D5: `AsyncLocalStorage` for Correlation Only

Node's `AsyncLocalStorage` is used as a **read-only convenience layer** for logging and
tracing correlation. It is NOT used for:
- Authorization decisions
- Tenant scoping
- Database identity

Auth and tenant scoping remain explicit in the call path via `RequestContext` parameter.

### D6: Bundled Read Scopes

A `readScope()` checks out ONE client and runs all queries within the callback on that
client. Queries serialize on the single client (one PG client processes queries FIFO).

**This is the correct default for Majel's infrastructure profile:**
Cloud SQL db-f1-micro supports ~25 connections. With `max: 5` per instance and 3 Cloud Run
instances, pool pressure is real. One-client-per-read-bundle preserves pool health.

Multi-client fan-out (parallel reads across multiple pool connections) is permitted
**only for measured hotspots**, documented with a comment explaining why the hotspot
justifies the pool cost.

### D7: ToolContext Transition

Fleet tool interface transitions in two stages:

**Stage 1 (immediate):** Separate request metadata from store dependencies.
```typescript
interface ToolEnv {
  ctx: RequestContext;
  deps: ResolvedStores;   // Optional bag, same shape as today's ToolContext stores
}
```
Tool functions change from `tool(args, ctx: ToolContext)` to `tool(args, env: ToolEnv)`.

**Stage 2 (end-state):** Declaration-driven dependency resolution.
```typescript
const tool = defineTool({
  name: "list_loadouts",
  deps: ["crewStore", "referenceStore"] as const,
  async run(args, { ctx, deps }) { ... },
});
```
The dispatcher resolves only declared deps per tool. No more permanent optional-store bag.

### D8: Test Infrastructure

Tests use a **builder pattern**, not test subclasses:

```typescript
class TestContextBuilder {
  withUser(userId: string): this;
  withRoles(...roles: string[]): this;
  withPool(pool: Pool): this;
  build(): RequestContext;
}
```

This avoids production-divergent test subclasses while allowing per-test overrides
of individual fields.

---

## Store Categories

### A. Global Reference/System Stores

| Store | RLS | Context Requirement |
|-------|-----|---------------------|
| reference-store | No | `QueryExecutor` (pool at boot, DbScope at request time) |
| effect-store | No | `QueryExecutor` |
| behavior-store | No | `QueryExecutor` |
| settings | No | `QueryExecutor` |
| chat-run-store | No | `QueryExecutor` (system work queue) |

These stores are created at boot with an admin pool (for schema) and a runtime pool
(for queries). They live for the app's lifetime. No factory pattern needed.

### B. Actor-Aware Non-RLS Stores

| Store | RLS | Context Requirement |
|-------|-----|---------------------|
| audit-store | No | `QueryExecutor` + actor metadata (userId, ip, userAgent) |
| user-store | No | `QueryExecutor` + userId for lookups |
| invite-store | No | `QueryExecutor` |
| user-settings-store | No | `QueryExecutor` + userId parameter |

These don't use RLS but benefit from request correlation in logs. They receive call
metadata explicitly — not the full `RequestContext`.

### C. Tenant-Isolated Stores (RLS Required)

| Store | Factory Pattern |
|-------|----------------|
| crew-store | `.forUser(userId)` → scoped store |
| overlay-store | `.forUser(userId)` → scoped store |
| target-store | `.forUser(userId)` → scoped store |
| receipt-store | `.forUser(userId)` → scoped store |
| research-store | `.forUser(userId)` → scoped store |
| inventory-store | `.forUser(userId)` → scoped store |
| proposal-store | `.forUser(userId)` → scoped store |
| operation-event-store | `.forUser(userId)` → scoped store |
| postgres-frame-store | `.forUser(userId)` → scoped store |

These stores require `DbScope` for all operations. Their factory pattern evolves to
accept `RequestContext`, and internal methods use `ctx.readScope()` / `ctx.writeScope()`
instead of calling `withUserScope(pool, userId, fn)` directly.

---

## Tradeoffs

### Accepted: Read serialization within readScope

`readScope` serializes queries on one client. Routes that currently fan out via
`Promise.all([store.a(), store.b(), store.c()])` will execute those reads serially
at the DB level. This is accepted because:
- Most reads are fast (sub-ms indexed lookups)
- Pool health on a 5-connection/instance pool matters more than read parallelism
- Endpoints that consistently need the same data bundle should consolidate queries

### Accepted: Dual-mode stores during migration

During the transition, tenant-scoped stores accept either the new `DbScope` pattern
or the legacy `pool + userId` closure. This dual-mode is temporary; legacy paths are
removed once all routes create `RequestContext`.

### Rejected: Deep context class hierarchy

`FleetContext`, `ConversationContext`, `IngestContext` as subclasses of a `StoreContext`
were proposed and rejected after external review. Rationale:
- Deep hierarchies push toward god-objects where everything can reach everything
- `FleetContext` that "resolves all fleet stores" becomes a service locator
- Mutable operational state (ingest stats, conversation history) does not belong on
  an immutable request context — use dedicated operation objects
- Composition (services beside context) is preferred over inheritance (services beneath)

### Rejected: AsyncLocalStorage as enforcement layer

ALS was considered for threading tenant identity implicitly. Rejected because Node.js
documents rare context-loss cases with custom thenables and callback-driven APIs.
Tenant isolation is a security boundary — it must be explicit in the call path, not
dependent on implicit async propagation.

### Rejected: Session-scoped set_config for reads

The current `withUserRead()` pattern uses `set_config(..., false)` (session-scoped)
with a RESET in finally. This is deprecated in favor of `SET LOCAL` inside a read-only
transaction. The transaction boundary is the safety guarantee, not application-layer
cleanup code.

---

## Migration Path

The migration is additive and incremental. No big-bang rewrite.

| Phase | Scope | Breaking Changes |
|-------|-------|-----------------|
| 0 | Foundation files (`RequestContext`, `DbScope`, `QueryExecutor`, `TestContextBuilder`) | None — new files only |
| 1 | `readScope()` / `writeScope()` on RequestContext | None — new methods |
| 2 | `createRequestContext()` middleware in Express pipeline | None — additive |
| 3 | ALS convenience layer for scoped logging | None — additive |
| 4 | One route end-to-end proof (simplest CRUD) | One route migrated |
| 5 | ToolContext → ToolEnv transition (Stage 1) | Fleet tool signatures change |
| 6 | Tenant-scoped store factories accept RequestContext | Store factory signatures change |
| 7 | Remaining routes migrate to RequestContext | Route-by-route, no flag day |
| 8 | Legacy `withUserScope` / `withUserRead` removed | Breaking — all stores must be migrated |
| 9 | ToolEnv Stage 2: declaration-driven deps | Tool declaration format evolves |

**All 10 migration phases (0–9) are complete.** Phase 9 shipped as #198 with `defineTool()` registry, explicit deps, and switch-to-map dispatch refactor.

### Phase 7 Deferred Routes

Two route files require per-handler middleware insertion rather than per-group wiring:

- **auth.ts:** Mixed public/authenticated endpoints with per-handler `requireRole`.
  Must insert `createContextMiddleware` into each handler's middleware array after auth.
  Scheduled with Phase 8 once remaining per-group routes are validated in production.

- **chat.ts:** Per-handler chains include `attachScopedMemory`, `chatRateLimiter`,
  and `createTimeoutMiddleware`. The POST `/api/chat` handler constructs `ToolContext`,
  making it the natural coupling point for Phase 5 (ToolEnv). Migrate chat.ts and
  `attachScopedMemory` together with the ToolContext → ToolEnv transition.

---

## Consequences

- Every log line from route → service → store → tool can include requestId + userId
- Tenant isolation guaranteed by PostgreSQL transaction scope, not application cleanup
- Connection pool pressure managed by design (bundled reads, one client per scope)
- Boot operations unaffected — no synthetic request context required
- Global stores unaffected — continue using pool directly
- Test fixtures use builder pattern with sane defaults
- Future org-level multi-tenancy has a clean seam (tenantId ≠ userId)
- Future RBAC extensions use roles array, not boolean flags
