# ADR-018: Cloud Deployment, Chat Gating & Database Strategy

**Status:** Accepted (revised 2026-02-10 — D1 changed from Turso to Cloud SQL PostgreSQL)  
**Date:** 2026-02-09 (original), 2026-02-10 (revised)  
**Authors:** Guff, Opie (Claude)

## Context

Majel has reached a point where it's worth showing to other people. The current architecture is local-only: SQLite on disk, single process, no auth. To make it deployable — even as a limited "come check this out" demo — three problems need solving:

1. **Chat cost exposure** — Gemini API calls cost money. An open `/api/chat` endpoint is a credit card attached to a URL.
2. **Data isolation** — Visitors shouldn't see (or wreck) the owner's fleet data.
3. **Hosting target** — Cloud Run is the deployment target. SQLite on ephemeral containers doesn't work without a plan.

### Current State (commit `a0c657d`)
- **6 stores**: reference, overlay, dock, session, settings, behavior — all `better-sqlite3`, all synchronous
- **4 SQLite databases**: `reference.db`, `settings.db`, `chat.db`, `behavior.db`
- **Lex memory**: Separate `memory.db` via `@smartergpt/lex` — independent of app stores
- **Store interfaces**: Clean factory functions with TypeScript interfaces (`ReferenceStore`, `OverlayStore`, etc.)
- **`AppState` singleton**: Holds all stores, passed to route factories — already interface-typed, not implementation-typed
- **56 API endpoints** across 7 route modules
- **512 tests** across 13 test files

### Design Pressures

| Pressure | Weight | Notes |
|----------|--------|-------|
| Don't break local dev | High | `npm run dev` must keep working exactly as it does today |
| Protect Gemini quota | Critical | Chat + AI diagnostic queries are the only expensive endpoints |
| Let visitors explore freely | High | Catalog, fleet, drydock, diagnostics (non-AI) should be open |
| Keep costs < $10/mo | High | Cloud SQL db-f1-micro is free for 12mo, then ~$8/mo |
| Support future multi-tenancy | Medium | Tenant isolation should be possible without a rewrite |
| Minimize migration risk | High | 512 tests must pass through every step |

## Decision

### D1: Cloud SQL for PostgreSQL

**Replace SQLite (via `@libsql/client`) with Google Cloud SQL for PostgreSQL.**

> **History:** Phase 1 migrated from `better-sqlite3` (sync) to `@libsql/client` (async).
> That work was NOT wasted — it converted all store interfaces to async, which Postgres
> also requires. Phase 3 replaces the driver and SQL dialect; the async contract stays.

Why Cloud SQL for PostgreSQL:
- **GCP-native** — lives in the same project as Cloud Run. One bill, one IAM, one console.
- **Built-in Cloud Run connector** — Cloud Run has a first-class Unix socket connector to Cloud SQL. Zero network config, zero public IP exposure.
- **Industry standard** — Postgres is the most widely deployed open-source RDBMS. Battle-tested, well-documented, no vendor lock-in risk.
- **Managed backups** — automatic daily backups, point-in-time recovery, IAM-integrated access.
- **Real multi-tenancy** — schemas or row-level isolation. No per-tenant database limits.
- **Free trial** — `db-f1-micro` instance included in GCP free tier for 12 months. After that, ~$8/mo for the smallest instance.
- **Async already done** — Phase 1 converted all stores to async. The Postgres driver (`pg`) is also async. Store interfaces don't change.

Why not Turso (original D1, superseded):
- Vendor dependency on a ~3-year-old startup
- Data lives outside GCP — separate dashboard, separate billing
- If Turso pivots pricing or goes down, we're scrambling
- Embedded replicas are clever but add operational complexity

**Migration scope** (Phase 3 — per store):
1. Replace `@libsql/client` imports with `pg` (node-postgres) `Pool`
2. Replace `?` placeholders with `$1, $2, $3` numbered placeholders (~80 queries)
3. Replace `datetime('now')` → `NOW()` (~25 occurrences)
4. Replace `INSERT OR IGNORE` → `INSERT ... ON CONFLICT DO NOTHING`
5. Replace `REAL` → `DOUBLE PRECISION` (2 columns in behavior-store)
6. Replace integer booleans (`0`/`1`) → proper `BOOLEAN` (12 columns, ~8 arg conversions)
7. Replace `INTEGER PRIMARY KEY AUTOINCREMENT` → `SERIAL PRIMARY KEY` (5 tables)
8. Replace `SELECT last_insert_rowid()` → `INSERT ... RETURNING id` (2 stores)
9. Replace `TEXT` timestamps → `TIMESTAMPTZ` (all stores)
10. Remove `PRAGMA` statements (PG handles WAL/FK by default)
11. Rewrite `diagnostic-query.ts` to use `information_schema` instead of `sqlite_master`
12. Replace `client.batch([...], "write")` → PG transactions (5 uses)
13. Replace `client.transaction("write")` → `pool.connect()` + `BEGIN`/`COMMIT` (10 uses)
14. Replace `LIKE` → `ILIKE` for case-insensitive search (PG `LIKE` is case-sensitive)
15. Update `db.ts` connection layer: single `Pool` instead of per-file `createClient()`

**Preserved from Phase 1:** All async store interfaces, Express route handlers, test structure, auth middleware. The migration is contained to the store/db layer.

**Database topology:**

| Schema | Scope | Tables | Notes |
|--------|-------|--------|-------|
| `public` | All app tables in one schema | All store tables | Single `db-f1-micro` instance. Schemas for isolation if needed later. |
| N/A | Lex memory | `memory.db` stays local | Lex controls its own SQLite DB. Not part of this migration. |

**Local dev:** Docker Compose provides a local Postgres container (`docker compose up -d postgres`). Connection string: `postgres://majel:majel@localhost:5432/majel`. `npm run dev` just works after `docker compose up`.

### D2: Tiered Access Control

Three tiers, progressively gated:

| Tier | Access | Auth Required? | Cost |
|------|--------|----------------|------|
| **Public** | Catalog browse (reference data only), API discovery, health | No | Free (SQLite reads) |
| **Visitor** | Full UI — catalog, fleet, drydock, diagnostics (non-AI). Own ephemeral tenant. | Invite code (one-time) | Free (SQLite reads/writes) |
| **Admiral** | Everything including Chat and AI Diagnostic queries | Bearer token | Gemini API cost |

**Invite code system:**
- Owner generates invite codes (`lex-majel invite create --uses 5 --expires 7d`)
- Visitor enters code once → gets a tenant cookie (UUID, `HttpOnly`, `SameSite=Strict`)
- Code has a use count and expiry — prevents sharing
- All write endpoints + Gemini-calling endpoints check for a valid tenant session
- Admiral token is a separate env var (`MAJEL_ADMIN_TOKEN`), not an invite code

**Implementation:**
- New middleware: `requireVisitor` (checks tenant cookie), `requireAdmiral` (checks bearer token)
- Tenant resolved from cookie → loads per-tenant data (or creates on first visit)
- Reference store is shared (read-only for visitors) — no per-tenant copy needed
- Invite codes stored in the same Cloud SQL instance (Phase 2: local `admin.db`, Phase 3: migrated to PG)

### D3: Cloud Run + Cloud SQL Deployment

**Target:** Google Cloud Run with min-instances=0, connected to Cloud SQL via Unix socket.

```
┌──────────────────────────────────────────────────────────┐
│                    Cloud Run Service                      │
│                                                           │
│  Majel Express Server (single container)                  │
│  ├── Cloud SQL Auth Proxy (sidecar / built-in connector)  │
│  └── Lex memory.db (admiral only, local ephemeral file)   │
│                                                           │
│  DB access: Unix socket to Cloud SQL (~1-5ms)             │
│  Scale: 0-N instances (stateless, DB is external)         │
└─────────────────────┬────────────────────────────────────┘
                      │ Unix socket (private, no public IP)
                      │
              ┌───────▼────────┐
              │  Cloud SQL     │
              │  PostgreSQL 16 │
              │  (db-f1-micro) │
              │                │
              │  majel DB:     │
              │  ├─ officers   │  ← reference data (shared)
              │  ├─ ships      │  ← reference data (shared)
              │  ├─ overlays   │  ← per-tenant fleet data
              │  ├─ docks      │  ← per-tenant drydock
              │  ├─ sessions   │  ← per-tenant chat history
              │  ├─ settings   │  ← per-tenant settings
              │  ├─ behavior   │  ← per-tenant Bayesian priors
              │  └─ invites    │  ← admin: invite codes + sessions
              └────────────────┘
```

**Why this works:**
- Cloud SQL Auth Proxy provides auto-TLS Unix socket connections — no public IP, no password in env vars (IAM auth)
- Cloud Run connects to Cloud SQL natively via `--add-cloudsql-instances` flag
- Multiple Cloud Run instances can share the same Cloud SQL DB (stateless app, stateful DB)
- Scale-to-zero means $0 for compute when idle
- HTTPS is automatic (Cloud Run provides it)
- Custom domain mapping: `aria.smartergpt.dev` → Cloud Run → Cloud SQL

**Cost estimate:**
- Cloud Run: $0 (free tier — 2M requests/mo, 360K vCPU-seconds)
- Cloud SQL (db-f1-micro): $0 first 12mo (free trial), then ~$8/mo
- Gemini: Usage-dependent, gated behind Admiral token
- **Total for demo: $0/mo (year 1), ~$8/mo (year 2+)**

### D4: Phased Rollout

| Phase | Scope | Deliverables | Status |
|-------|-------|-------------|--------|
| **0** | Dockerfile + local Docker | `Dockerfile`, `.dockerignore`, validate app runs in container | ✅ Done (`f66479b`) |
| **1** | Async migration (via libSQL) | Replace `better-sqlite3` with async `@libsql/client`. All stores async. 512 tests pass. | ✅ Done (`65c1471`) |
| **2** | Auth middleware + invite codes | `requireVisitor`, `requireAdmiral` middleware. Invite code CRUD. Tenant cookie. Demo mode. | ✅ Done (`1191d38`) |
| **3** | PostgreSQL migration | Replace `@libsql/client` with `pg`. SQL dialect conversion. Docker Compose for local PG. All tests pass on PG. | Next |
| **4** | Cloud Run + Cloud SQL deployment | Cloud SQL instance, Cloud Run config, `gcloud run deploy` script, DNS mapping. | Blocks on 3 |
| **5** | Reference data seeding | Public catalog endpoints with wiki attribution. Admin sync endpoint. | Blocks on 4 |
| **6** | Polish | Rate limiting on AI endpoints. Visitor analytics. Tenant cleanup cron. | Blocks on 5 |

**Phase 3 detail (PostgreSQL migration):**
1. Add `pg` + `@types/pg` to dependencies, remove `@libsql/client`
2. Create `docker-compose.yml` with local Postgres container
3. Rewrite `db.ts` — `Pool`-based connection, parameterized query helper
4. Migrate stores one at a time (reference → overlay → dock → session → settings → behavior → invite)
5. For each store: convert schema (booleans, timestamps, serial PKs), convert SQL (placeholders, datetime, RETURNING), update tests
6. Rewrite `diagnostic-query.ts` to use `information_schema` + `pg_indexes`
7. Update Dockerfile (remove native build deps for SQLite)
8. Final: `npm test` green on Postgres, `npm run dev` works with `docker compose up`

**Each phase produces a working, tested commit.** No partial states, no "we'll fix it in Phase N."

> **Note (Phase 5 context):** Once deployed, the first operational priority is seeding the Cloud SQL reference tables with wiki data and exposing public GET endpoints that satisfy the wiki's license terms (attribution). After that, an admin mechanism to keep reference data current — `/api/admin/sync` endpoint, CLI command, or scheduled job.

## Consequences

### Positive
- Majel becomes deployable and shareable at `aria.smartergpt.dev`
- GCP-native stack — everything in one project, one bill, one IAM
- Cloud SQL is managed: automatic backups, point-in-time recovery, monitoring
- Postgres is industry-standard — no vendor lock-in risk
- Multi-instance Cloud Run: stateless app can scale horizontally
- Phase 1 async migration is preserved — store interfaces don't change again
- Local dev uses Docker Compose with Postgres — standard, portable

### Negative
- SQL dialect migration is substantial (~80 queries, 9 files, 15 categories of changes)
- Local dev now requires Docker (or local Postgres install) — slightly more friction than `file:local.db`
- Cloud SQL `db-f1-micro` costs ~$8/mo after GCP free trial expires (year 2+)
- `diagnostic-query.ts` needs a full rewrite for `information_schema` instead of `sqlite_master`
- Lex memory stays local (Lex owns its own SQLite DB). Visitors won't have persistent Lex memory unless addressed separately.

### Risks
- **Cloud SQL cold start** — `db-f1-micro` can take 30-60s to wake from a stopped state. Mitigation: keep `activation-policy=ALWAYS` (always-on) for the micro instance.
- **Cost after free trial** — ~$8/mo for Cloud SQL. Mitigation: this is acceptable for a portfolio/demo project.
- **Migration scope** — 9 files, ~80 queries, SQL dialect changes. Mitigation: migrate one store at a time, test at each step. Phase 1's async work means the interface layer doesn't change.

## Alternatives Considered

| Option | Why Not |
|--------|---------|
| **Turso/libSQL** | Same SQL dialect (nice), but vendor dependency on a startup. Data lives outside GCP. Originally chosen in D1, superseded. |
| **Litestream + GCS** | $0 cost, zero code changes, but single-instance only (no horizontal scaling). Good for demos but limited future. |
| **Supabase / Neon** | Postgres-compatible but external vendors. Adds another dashboard and billing. |
| **Cloud Run + Volume Mount** | SQLite works but single-instance only, no multi-tenancy path |
| **Compute Engine VM** | Always-on cost ($5-8/mo), manual HTTPS setup, no scale-to-zero |
| **Stay local-only** | Can't share it. The whole point is showing people. |
| **Cloudflare D1** | SQLite-compatible but locked to Cloudflare Workers, different deployment model |
| **Firestore** | Wrong tool — no SQL, document model doesn't fit relational fleet data |
| **Spanner / AlloyDB** | Absurd overkill and cost for a demo project |

## References

- [Cloud SQL for PostgreSQL](https://cloud.google.com/sql/docs/postgres)
- [Cloud Run + Cloud SQL Quickstart](https://cloud.google.com/sql/docs/postgres/connect-run)
- [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy)
- [Cloud SQL Pricing](https://cloud.google.com/sql/pricing) (free tier: db-f1-micro for 12 months)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- [node-postgres (pg)](https://node-postgres.com/)
- ADR-016 (Catalog-Overlay Model — current store architecture)
- ADR-006 (Open Alpha — shelved features list)
