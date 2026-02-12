# ADR-021 — Postgres FrameStore with Row-Level Security

**Status:** Accepted  
**Date:** 2026-02-11  
**Supersedes:** SQLite-based Lex memory in Majel (implicit, never ADR'd)  
**References:** ADR-018 (Cloud Deployment), ADR-019 D6 (Data Isolation), Lex FrameStore interface (v2.4.0)

---

## Context

Majel uses `@smartergpt/lex` as its episodic memory engine. Today, Lex frames are stored in a **local SQLite file** (`/srv/majel/.smartergpt/lex/memory.db`) via Lex's built-in `SqliteFrameStore`. This creates three problems:

1. **No multi-tenant isolation.** All users' conversation frames share one SQLite file. The userId-parameter approach (caller-enforced) is opt-in — forgetting a parameter leaks data. TypeScript's `userId?: string` won't catch omissions at compile time.

2. **Two databases to manage.** Majel already runs PostgreSQL (Cloud SQL) for all operational data. A second SQLite file adds deployment complexity, backup procedures, and a data sovereignty split.

3. **SQLite limits at scale.** Single-writer concurrency, no native full-text search weighting (FTS5 is coarse), no row-level security, no connection pooling across workers.

Meanwhile, Lex's `FrameStore` interface is **already driver-agnostic** — 13 async methods, no SQLite types in the contract. Lex ships a `MemoryFrameStore` (in-memory) as proof. The interface explicitly says: *"Other drivers (if any) live out-of-tree or in higher layers."*

---

## Decision

### D1 — Majel implements `PostgresFrameStore` against Lex's `FrameStore` interface

A new `PostgresFrameStore` class in Majel implements all 13 `FrameStore` methods using Majel's existing `pg.Pool`. No changes to Lex required (except exporting a few missing return types — see D6).

| Lex SQLite idiom | Postgres equivalent |
|---|---|
| `TEXT` columns with JSON strings | `JSONB` columns |
| FTS5 virtual table + triggers | `tsvector` generated column + GIN index |
| `json_extract()` in triggers | `GENERATED ALWAYS AS (to_tsvector(...)) STORED` |
| File-per-workspace isolation | Row-Level Security per user |
| `better-sqlite3` sync API | `pg` async Pool |

### D2 — Row-Level Security enforces tenant isolation

Every row in `lex_frames` has a `NOT NULL user_id` column. PostgreSQL RLS policies ensure:

- **Reads:** A query can only see rows where `user_id = current_setting('app.current_user_id')`.
- **Writes:** Inserts/updates must match the same session variable.
- **FORCE ROW LEVEL SECURITY** — applies even to the table owner role, so a superuser connection without the session variable set sees zero rows (fail-closed).

This means **application code cannot leak data across tenants**, even with bugs. The database is the enforcement point, not the app.

### D3 — `withUserScope()` transaction helper

A new helper wraps every request's memory operations in a transaction that sets `app.current_user_id`:

```typescript
async function withUserScope<T>(
  pool: Pool,
  userId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T>;
```

This is the **single point of identity binding**. Route handlers never see userId for memory operations.

### D4 — Scoped MemoryService via middleware

Instead of passing `userId` as a parameter on every `recall()`/`timeline()`/`remember()` call, middleware creates a **pre-scoped** `MemoryService` bound to the authenticated user:

```
Auth Middleware → res.locals.userId
Memory Middleware → res.locals.memory = factory.forUser(userId)
Route Handler → res.locals.memory.recall(query)  // no userId param
```

This eliminates the class of bugs where a developer forgets to pass userId.

### D5 — Schema lives in Majel, not Lex

The `lex_frames` table DDL, RLS policies, indexes, and `tsvector` configuration are defined in Majel's `db.ts` schema initialization — the same `CREATE TABLE IF NOT EXISTS` pattern used by all other stores. No migration scripts; we are in alpha with zero production users (ADR-006).

### D6 — Lex type export gap

Lex v2.4.0 exports `FrameStore`, `FrameSearchCriteria`, `FrameListOptions`, and `SaveResult` — but not `FrameListResult`, `StoreStats`, `TurnCostMetrics`. Majel needs these to implement the interface correctly. Resolution: submit a one-line PR to Lex adding the missing exports, and use type inference (`Awaited<ReturnType<...>>`) as a stopgap until it merges.

### D7 — Revert caller-enforced userId threading

The recently added `userId` parameters on `ConversationTurn`, `recall()`, `timeline()`, and the route-level `res.locals.userId` threading for memory calls are reverted. RLS makes them unnecessary and their presence would be misleading (suggesting the app layer handles isolation when the DB actually does).

---

## Schema

```sql
CREATE TABLE lex_frames (
  id               TEXT PRIMARY KEY,
  user_id          TEXT NOT NULL,
  timestamp        TIMESTAMPTZ NOT NULL,
  branch           TEXT NOT NULL DEFAULT 'majel-chat',
  jira             TEXT,
  module_scope     JSONB NOT NULL DEFAULT '[]',
  summary_caption  TEXT NOT NULL,
  reference_point  TEXT NOT NULL,
  status_snapshot  JSONB NOT NULL,
  keywords         JSONB DEFAULT '[]',
  atlas_frame_id   TEXT,
  feature_flags    JSONB DEFAULT '[]',
  permissions      JSONB DEFAULT '[]',
  run_id           TEXT,
  plan_hash        TEXT,
  spend            JSONB,
  superseded_by    TEXT,
  merged_from      JSONB,
  search_vector    tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(reference_point, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(summary_caption, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(branch, '')), 'C')
  ) STORED
);

-- RLS: fail-closed isolation
ALTER TABLE lex_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE lex_frames FORCE ROW LEVEL SECURITY;
CREATE POLICY lex_frames_user_isolation ON lex_frames
  USING (user_id = current_setting('app.current_user_id', true))
  WITH CHECK (user_id = current_setting('app.current_user_id', true));

-- Indexes
CREATE INDEX idx_lex_frames_user_ts ON lex_frames (user_id, timestamp DESC);
CREATE INDEX idx_lex_frames_branch ON lex_frames (branch);
CREATE INDEX idx_lex_frames_search ON lex_frames USING GIN (search_vector);
CREATE INDEX idx_lex_frames_module ON lex_frames USING GIN (module_scope);
CREATE INDEX idx_lex_frames_jira ON lex_frames (jira) WHERE jira IS NOT NULL;
CREATE INDEX idx_lex_frames_superseded ON lex_frames (superseded_by) WHERE superseded_by IS NOT NULL;
```

---

## Consequences

### Pros
- **Impossible cross-tenant data leaks** — enforced by PostgreSQL, not application code
- **Single database** — eliminates SQLite file management, backup complexity
- **Native JSONB** — proper array/object storage instead of JSON-in-TEXT
- **Weighted full-text search** — `tsvector` with field weighting (A/B/C) is superior to FTS5
- **Connection pooling** — shares Majel's existing `pg.Pool`
- **Fail-closed** — no session variable = no rows visible (FORCE RLS)
- **Clean MemoryService API** — no userId params to forget

### Cons
- **PostgresFrameStore maintenance** — Majel now owns a FrameStore implementation that must stay compatible with Lex's interface as it evolves
- **No offline/local mode** — requires a running PostgreSQL instance (acceptable: Majel already requires PG since ADR-018 Phase 3)
- **RLS performance** — negligible overhead on indexed columns, but worth monitoring

### Migration Path
1. Wipe existing SQLite memory DB (zero production users)
2. Create `lex_frames` table via `initSchema()`
3. Swap `createFrameStore()` for `new PostgresFrameStore(pool)`
4. Revert userId parameter threading
5. Verify via tests: isolation, CRUD, search, RLS enforcement

---

## References

- Lex `FrameStore` interface: `@smartergpt/lex/store` (v2.4.0)
- PostgreSQL RLS docs: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- ADR-018 D3: PostgreSQL migration
- ADR-019 D6: Data isolation pattern (RLS + `SET LOCAL`)
