# ADR-018: Cloud Deployment, Chat Gating & Database Strategy

**Status:** Proposed  
**Date:** 2026-02-09  
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
| Keep costs < $10/mo | High | Free tier where possible, Turso free tier is generous |
| Support future multi-tenancy | Medium | Tenant isolation should be possible without a rewrite |
| Minimize migration risk | High | 512 tests must pass through every step |

## Decision

### D1: Turso/libSQL as Database Backend

**Replace `better-sqlite3` with `@libsql/client`.**

Why Turso over Postgres:
- **Same SQL dialect** — queries, schemas, `ON CONFLICT` upserts, partial indexes all carry over with minimal changes
- **Local file mode** — `createClient({ url: "file:local.db" })` works identically to SQLite for local dev
- **Embedded replicas** — Cloud Run can read from a local replica file with microsecond reads, writes go to Turso's remote primary
- **Free tier** — 500M rows read/mo, 10M rows written/mo, 5GB storage, 100 databases. More than enough.
- **No sync→async cascade** — libSQL's `execute()` is async but returns `ResultSet` with `.rows`, `.columns`, `.lastInsertRowid`. The mechanical conversion from `db.prepare().all()` → `client.execute()` is straightforward and the interface change is contained within each store.

Why not Postgres:
- Different SQL dialect (no `INSERT OR IGNORE`, different `PRAGMA` replacement, boolean types, `NOW()` vs `datetime('now')`)
- Requires a managed instance ($5+/mo minimum) or Cloud SQL ($$$)
- Overkill for the data volumes — we have 228 reference entities and personal overlay data

**Migration path** (per store):
1. Replace `better-sqlite3` import with `@libsql/client`
2. Replace `db.prepare(sql).run(params)` → `await client.execute({ sql, args: [...] })`
3. Replace `db.prepare(sql).get(params)` → `await client.execute(...)` + extract `.rows[0]`
4. Replace `db.prepare(sql).all(params)` → `await client.execute(...)` + extract `.rows`
5. Replace `db.transaction(() => { ... })()` → `const tx = await client.transaction("write"); ... await tx.commit()`
6. Replace `PRAGMA journal_mode = WAL` → not needed (Turso handles this)
7. Replace `PRAGMA foreign_keys = ON` → `await client.execute("PRAGMA foreign_keys = ON")`
8. Store methods become `async` — callers updated accordingly
9. `diagnostic-query.ts` introspection rewired to use `sqlite_master` via libSQL (still works — it's still SQLite under the hood)

**Database topology:**

| Database | Scope | Turso DB | Notes |
|----------|-------|----------|-------|
| `reference.db` | Global (shared) | `majel-reference` | Wiki data. Same for all users. Read-heavy. |
| Per-tenant data | Per user | `majel-tenant-{id}` | Overlays, docks, sessions, settings, behavior. One DB per tenant on Turso free tier (100 DBs). |
| `memory.db` | Per user | Stays local / Lex-managed | Lex controls its own DB. Not part of this migration. |

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
- Tenant resolved from cookie → loads per-tenant stores (or creates them on first visit)
- Reference store is shared (read-only for visitors) — no per-tenant copy needed
- Invite codes stored in a `majel-admin` Turso database (or a simple JSON file for v1)

### D3: Cloud Run Deployment

**Target:** Google Cloud Run with min-instances=0 (scale-to-zero for cost).

```
┌──────────────────────────────────────────────────────────┐
│                    Cloud Run Service                      │
│                                                           │
│  Majel Express Server (single container)                  │
│  ├── Embedded replica: reference.db (read-only, shared)   │
│  ├── Embedded replica: tenant-{id}.db (per visitor)       │
│  └── Lex memory.db (admiral only, local file)             │
│                                                           │
│  Reads: local file (microseconds)                         │
│  Writes: Turso primary (10-50ms)                          │
└─────────────────────┬────────────────────────────────────┘
                      │ HTTPS (managed by Cloud Run)
                      │
              ┌───────▼────────┐
              │   Turso Edge   │
              │                │
              │  majel-ref     │  ← shared reference data
              │  majel-t-abc   │  ← visitor tenant
              │  majel-t-def   │  ← visitor tenant  
              │  majel-admin   │  ← invite codes, admin state
              └────────────────┘
```

**Why this works on Cloud Run:**
- Embedded replicas give local-speed reads even on ephemeral containers
- Writes go to Turso's primary (durable, survives container recycling)
- On cold start: `client.sync()` pulls latest state in ~100ms
- Scale-to-zero means $0 when nobody's using it
- HTTPS is automatic (Cloud Run provides it)

**Cost estimate:**
- Cloud Run: $0 (free tier — 2M requests/mo, 360K vCPU-seconds)
- Turso: $0 (free tier — 500M reads, 10M writes, 5GB, 100 DBs)
- Gemini: Usage-dependent, but gated behind Admiral token
- **Total for demo: $0/mo** (free tiers cover a demo workload easily)

### D4: Phased Rollout

| Phase | Scope | Deliverables | Blocks |
|-------|-------|-------------|--------|
| **0** | Dockerfile + local Docker | `Dockerfile`, `.dockerignore`, validate app runs in container | Nothing |
| **1** | libSQL migration (local mode) | Replace `better-sqlite3` with `@libsql/client` using `file:` URLs. All 512 tests pass. No cloud yet. `npm run dev` still works. | Phase 0 |
| **2** | Auth middleware + invite codes | `requireVisitor`, `requireAdmiral` middleware. Invite code CRUD. Tenant cookie. Demo mode env flag. | Phase 1 |
| **3** | Tenant isolation | Per-tenant store resolution. Shared reference store. Tenant lifecycle (create on invite, expire after N days). | Phase 2 |
| **4** | Cloud Run deployment | Turso remote DBs, embedded replicas, Cloud Run config, `gcloud run deploy` script. | Phase 3 |
| **5** | Polish | Rate limiting on AI endpoints. Visitor analytics. Tenant cleanup cron. | Phase 4 |

**Each phase produces a working, tested commit.** No partial states, no "we'll fix it in Phase N."

## Consequences

### Positive
- Majel becomes deployable and shareable
- Visitors can explore the full fleet management UI for free (no Gemini cost)
- Turso free tier means $0/mo for demo workloads
- Local dev experience preserved (`file:` URLs behave like SQLite)
- Multi-tenancy is architected in, not bolted on
- The sync→async conversion is contained (store methods become async, callers update)

### Negative
- `better-sqlite3` synchronous API was a genuine advantage — simple, fast, no promises. Losing it adds complexity.
- libSQL is a younger ecosystem than `better-sqlite3` — potential rough edges
- Per-tenant databases on Turso free tier caps at 100 DBs — fine for demo, needs paid tier ($5/mo) if it grows
- `diagnostic-query.ts` raw SQL endpoint needs rework — less SQLite-introspection-friendly over the network
- Lex memory stays local (Lex owns its own storage). Visitors won't have persistent Lex memory unless we address this separately.

### Risks
- **Turso availability** — if Turso has an outage, the app is down. Mitigation: embedded replicas serve reads from local cache.
- **Cost creep** — if the app gets popular, Turso paid tier ($5/mo) + Cloud Run scaling costs could grow. Mitigation: invite codes limit user count.
- **Migration scope** — 6 stores × async conversion × caller updates is mechanical but substantial. Mitigation: migrate one store at a time, test at each step.

## Alternatives Considered

| Option | Why Not |
|--------|---------|
| **Postgres (Supabase/Neon)** | Different SQL dialect, $5+/mo minimum, overkill for data volumes |
| **Cloud Run + Volume Mount** | SQLite works but single-instance only, no multi-tenancy path |
| **Compute Engine VM** | Always-on cost ($5-8/mo), manual HTTPS setup, no scale-to-zero |
| **Stay local-only** | Can't share it. The whole point is showing people. |
| **Cloudflare D1** | SQLite-compatible but different SDK, no embedded replicas, locked to Cloudflare Workers |

## References

- [Turso TypeScript SDK](https://docs.turso.tech/sdk/ts/reference)
- [Turso Embedded Replicas](https://docs.turso.tech/features/embedded-replicas)
- [Turso Pricing (free tier)](https://turso.tech/pricing)
- [Cloud Run Documentation](https://cloud.google.com/run/docs)
- ADR-016 (Catalog-Overlay Model — current store architecture)
- ADR-006 (Open Alpha — shelved features list)
