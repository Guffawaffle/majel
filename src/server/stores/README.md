# stores/

PostgreSQL-backed data stores. Each store manages one domain's schema and queries.

## Interface Contract

Every store exports a `create*Store(pool)` factory function that:
1. Calls `initSchema()` to ensure tables exist (idempotent DDL)
2. Returns an object with query methods

## Files

| Store | Domain | Tables |
|-------|--------|--------|
| `behavior-store.ts` | Behavioral rules | `behavioral_rules` |
| `crew-store.ts` | Crew composition (ADR-025) | `bridge_cores`, `loadouts`, `plan_items`, `docks` |
| `invite-store.ts` | Invite codes | `invites` |
| `overlay-store.ts` | User data overlays | `officer_overlays`, `ship_overlays` |
| `postgres-frame-store.ts` | Lex memory frames | `frames` |
| `reference-store.ts` | Reference data (wiki) | `ref_officers`, `ref_ships` |
| `settings.ts` | Fleet settings | `fleet_settings` |
| `user-store.ts` | Users + sessions | `users`, `user_sessions` |

## SQL Safety

All `db.prepare()` / `pool.query()` calls MUST use parameterized queries.
No string interpolation for SQL. See `TROUBLESHOOTING.md` for examples.
