# ADR-051: Instance Modeling

**Status:** proposed  
**Date:** 2025-07-19  
**Supersedes:** none  
**Related:** ADR-016 (catalog-overlay), ADR-049 (chat vs sync boundary, §1 mutation model)  

---

## Context

Overlay tables (`officer_overlay`, `ship_overlay`) use composite primary key `(user_id, ref_id)`. This enforces exactly one overlay row per player per catalog entity. A player who owns two copies of the same ship (e.g., two K'Vort birds-of-prey at different tiers) cannot represent both — the second upsert overwrites the first.

ADR-049 introduced the ownership confirmation split (#259), ensuring that "I got the Vidar" goes through a confirmation step. But the underlying schema still collapses multiple instances into one row. "I got another K'Vort" either silently overwrites the existing data or must be rejected.

### Current Schema

```sql
-- officer_overlay
PRIMARY KEY (user_id, ref_id)

-- ship_overlay
PRIMARY KEY (user_id, ref_id)
```

All SQL paths — upserts, bulk ownership, sync import — assume this two-column key. Changing it to a three-column key touches the full mutation stack.

### Why Now

1. **Player expectations:** STFC players routinely own multiple copies of the same ship class (especially lower-tier ships used for dailies, events, and faction missions).
2. **Data fidelity:** Majel's fleet advice is only as good as its state model. Collapsing two ships into one produces wrong power totals, wrong dock assignments, and wrong crew recommendations.
3. **ADR-049 dependency:** The chat-vs-sync boundary (#257) is complete. Instance modeling is the next schema evolution called out in ADR-049 §1 ("once ADR-050 lands").

---

## Decision

### Composite Key Expansion

Overlay tables gain a third key column, `instance_id`:

```sql
ALTER TABLE officer_overlay
  ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'primary';

ALTER TABLE ship_overlay
  ADD COLUMN instance_id TEXT NOT NULL DEFAULT 'primary';
```

After backfill, the primary key becomes:

```sql
-- officer_overlay
PRIMARY KEY (user_id, ref_id, instance_id)

-- ship_overlay
PRIMARY KEY (user_id, ref_id, instance_id)
```

### Instance ID Semantics

| Value | Meaning |
|-------|---------|
| `"primary"` | Default instance. All existing rows receive this value during migration. Single-instance entities remain `"primary"` forever. |
| `"inst_<nanoid>"` | Additional instances created after migration. Auto-generated at creation time. |

Instance IDs are opaque strings. The application never parses them — they exist solely for uniqueness within `(user_id, ref_id)`.

### Migration Strategy

**Phase 1 — Schema expansion (non-breaking)**

1. Add `instance_id TEXT NOT NULL DEFAULT 'primary'` to both tables.
2. Drop existing PK constraint, recreate with three columns.
3. Backfill: all existing rows already have `instance_id = 'primary'` from the default.
4. Rebuild indexes to include `instance_id` where needed.

```sql
-- Migration: 0XX_instance_id.sql

-- 1. Add column (all existing rows default to 'primary')
ALTER TABLE officer_overlay
  ADD COLUMN IF NOT EXISTS instance_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE ship_overlay
  ADD COLUMN IF NOT EXISTS instance_id TEXT NOT NULL DEFAULT 'primary';

-- 2. Drop and recreate primary key
ALTER TABLE officer_overlay DROP CONSTRAINT officer_overlay_pkey;
ALTER TABLE officer_overlay
  ADD CONSTRAINT officer_overlay_pkey PRIMARY KEY (user_id, ref_id, instance_id);

ALTER TABLE ship_overlay DROP CONSTRAINT ship_overlay_pkey;
ALTER TABLE ship_overlay
  ADD CONSTRAINT ship_overlay_pkey PRIMARY KEY (user_id, ref_id, instance_id);

-- 3. Update UPSERT conflict targets
-- All ON CONFLICT(user_id, ref_id) clauses become ON CONFLICT(user_id, ref_id, instance_id)
```

**Migration deployment:** Run during Cloud Run deployment (zero-downtime). The migration is additive — existing queries targeting `(user_id, ref_id)` still work during the transition window because every row has `instance_id = 'primary'`. The UPSERT conflict target update must deploy atomically with the schema change (same migration transaction).

**Phase 2 — Application code update**

All overlay store methods gain an optional `instanceId` parameter. The store layer is responsible for defaulting to `'primary'` and generating IDs for new instances.

```typescript
interface OverlayStore {
  // Single-instance reads default to 'primary'
  getOfficerOverlay(refId: string, instanceId?: string): Promise<OfficerOverlay | null>;
  getShipOverlay(refId: string, instanceId?: string): Promise<ShipOverlay | null>;

  // Multi-instance reads: list all instances for a ref
  listOfficerInstances(refId: string): Promise<OfficerOverlay[]>;
  listShipInstances(refId: string): Promise<ShipOverlay[]>;

  // Set methods: instanceId defaults to 'primary', creates instance when new
  setOfficerOverlay(input: SetOfficerOverlayInput): Promise<OfficerOverlay>;
  setShipOverlay(input: SetShipOverlayInput): Promise<ShipOverlay>;

  // Delete: must specify instance
  deleteOfficerOverlay(refId: string, instanceId?: string): Promise<boolean>;
  deleteShipOverlay(refId: string, instanceId?: string): Promise<boolean>;
}

interface SetOfficerOverlayInput {
  refId: string;
  instanceId?: string;  // NEW — omit for primary, provide for additional instances
  ownershipState?: OwnershipState;
  // ... existing fields
}
```

**Phase 3 — Tool declarations + trust updates**

- `set_officer_overlay` / `set_ship_overlay` gain an optional `instance_id` parameter.
- When `instance_id` is omitted, tools operate on the `"primary"` instance (backward compatible).
- When the model passes `instance_id: "new"`, the tool execution path generates `"inst_<nanoid>"` and passes it to the store. This always triggers confirm-trust (ADR-049 Slice 2).

Instance ID generation and trust resolution flow:

```typescript
// In gemini/index.ts handleFunctionCalls(), overlay-specific trust gate:
let instanceId = typeof args.instance_id === "string" ? args.instance_id : undefined;
let isCreate: boolean | undefined;

if (instanceId === "new") {
  // Generate real instance ID; this is always a creation
  instanceId = `inst_${nanoid()}`;
  args.instance_id = instanceId;
  isCreate = true;
} else {
  // Existing instance or default 'primary' — check if overlay row exists
  const effective = instanceId ?? "primary";
  const existing = await overlayStore.getOfficerOverlay(refId, effective);
  isCreate = existing === null;
}

const trustLevel = await getTrustLevel(toolName, userId, userSettingsStore, isCreate);
```

UPSERT SQL template after migration:

```sql
INSERT INTO officer_overlay (user_id, ref_id, instance_id, ownership_state, ...)
  VALUES ($1, $2, $3, $4, ...)
  ON CONFLICT(user_id, ref_id, instance_id) DO UPDATE SET
    ownership_state = excluded.ownership_state,
    ...
```

The store always passes `instanceId` (defaulting to `'primary'`) to the SQL query — the database never infers the instance.

**Phase 4 — Start/Sync import**

- `sync_overlay` must handle multi-instance rows in the export payload.
- Changeset diffing compares `(ref_id, instance_id)` pairs, not just `ref_id`.
- Dry-run preview shows instance counts per entity.

Sync diffing algorithm (high-level):

```
1. Load current overlays: Map<(refId, instanceId), Overlay>
2. For each entity in export payload:
   a. If entity has instanceId → look up (refId, instanceId) in current map
   b. If entity has no instanceId → look up (refId, 'primary') in current map
   c. If found → compute field-level diff (update)
   d. If not found → mark as new instance (create)
3. For each current overlay not matched by export:
   a. Do NOT auto-delete (conservative — user may have intentionally kept it)
   b. Include in dry-run summary as "unmatched instances" for user review
4. Apply: upsert matched/new rows. Skip unmatched (no destructive action).
```

Instance ID in export payloads: the `MajelGameExport` schema gains an optional `instanceId` field on each entity entry. Exports without `instanceId` default to `'primary'` for backward compatibility.

**Phase 5 — Frontend**

- Fleet views render instance badges when `listOfficerInstances(refId).length > 1`.
- Instance picker appears on entity detail cards for multi-instance entities.
- Catalog view shows aggregate owned count (e.g., "K'Vort × 2") instead of a single toggle.
- Bulk operations (`bulkSetOfficerOwnership`, `bulkSetShipOwnership`) apply to all instances of each ref. The user cannot yet selectively target individual instances in bulk flows — that's a future UX enhancement.

### Backward Compatibility

The migration is fully backward-compatible:

1. All existing rows get `instance_id = 'primary'`.
2. All existing code paths that don't pass `instanceId` continue to work against `'primary'`.
3. No data loss — the migration only adds a column and widens the key.
4. Rollback: drop the new column and recreate the two-column PK.

### Anti-Goals

- **Instance naming.** Instances are identified by opaque IDs, not user-chosen names. Naming is a UI concern for a future ADR.
- **Instance merging/dedup.** Out of scope. If a player has two instances and wants to merge, that's a future tool.
- **Cross-user instance sharing.** Overlays remain user-scoped. Instances belong to one user.
- **Selective bulk targeting.** `bulkSetOfficerOwnership` applies to all instances of each ref. Per-instance bulk selection is a future UX enhancement.

### Risk Analysis

**Instance ID collisions.** `nanoid()` with default parameters (21 chars, URL-safe alphabet) has collision probability ~1 in $10^{24}$. Combined with the composite key `(user_id, ref_id, instance_id)`, the collision space is per-user-per-entity, making practical collision impossible. Acceptable risk — no mitigation needed.

**Concurrent instance creation.** Two concurrent requests for the same user creating the same entity produce different nanoid values → different `instance_id` → both INSERT successfully. The user ends up with two instances, which is the correct behavior (they asked twice). If the proposals need approval, the user sees two confirmation cards and can decline one.

**Migration concurrency.** The migration adds a column with DEFAULT and recreates the PK. This runs in a single transaction. During the migration:
- Active reads continue to work (column addition is non-blocking in PostgreSQL).
- Active writes to the old PK fail if they arrive between DROP CONSTRAINT and ADD CONSTRAINT. **Mitigation:** use a single `ALTER TABLE` transaction or run during low-traffic window. Cloud Run deployments naturally provide a brief drain period.

**Instance lifecycle.** Unowning an instance sets `ownership_state = 'unowned'` — the row persists. Deleting an instance removes the row entirely. The `'primary'` instance is never auto-deleted; only additional instances (`inst_*`) can be explicitly deleted.

### Bulk Operation Semantics

`bulkSetOfficerOwnership(refIds, state)` and `bulkSetShipOwnership(refIds, state)` apply the state change to **all instances** of each `refId`. This matches the user intent: "Mark all my K'Vorts as owned" affects every instance.

The SQL becomes:
```sql
UPDATE officer_overlay
  SET ownership_state = $1, updated_at = $2
  WHERE user_id = $3 AND ref_id = $4
-- No instance_id filter → all instances updated
```

Per-instance bulk operations are out of scope (see Anti-Goals).

---

## Impact Analysis

### Overlay Store (`overlay-store.ts`)

| Method | Impact | Effort |
|--------|--------|--------|
| `getOfficerOverlay` | Add optional `instanceId` param, default `'primary'`. WHERE clause adds `AND instance_id = $2`. | Low |
| `getShipOverlay` | Same as above. | Low |
| `setOfficerOverlay` | Input gains `instanceId?`. UPSERT conflict target becomes `(user_id, ref_id, instance_id)`. | Medium |
| `setShipOverlay` | Same as above. | Medium |
| `listOfficerOverlays` | Return all instances. SELECT already covers all rows. Add `instanceId` to result type. | Low |
| `listShipOverlays` | Same as above. | Low |
| `deleteOfficerOverlay` | Add optional `instanceId`, default `'primary'`. | Low |
| `deleteShipOverlay` | Same as above. | Low |
| `bulkSetOfficerOwnership` | Operates on all instances for each `refId` (bulk ownership applies to every instance of a ref). | Low |
| `bulkSetShipOwnership` | Same as above. | Low |
| `counts` | Count distinct `(ref_id, instance_id)` pairs instead of just `ref_id`. | Low |
| **New:** `listOfficerInstances` | `SELECT ... WHERE ref_id = $1` — returns all instances for a single ref. | Low |
| **New:** `listShipInstances` | Same as above. | Low |

### Chat Mutation Tools

| Tool | Impact | Notes |
|------|--------|-------|
| `set_officer_overlay` | Add optional `instance_id` param. Trust gate: `instance_id === "new"` → `isCreate = true`. | Medium |
| `set_ship_overlay` | Same as above. | Medium |
| `sync_overlay` | Instance-aware diffing in changeset computation. Most complex change. | High |

### Frontend Components

| Component | Impact | Notes |
|-----------|--------|-------|
| `CatalogView.svelte` | Show instance count badge, aggregate owned toggle. | Medium |
| `FleetView.svelte` | Render multiple instance cards per ref_id. | Medium |
| `ChatProposalCard.svelte` | No change — proposals already carry tool args including instance_id. | None |

### Tests

| Area | Tests Needed |
|------|-------------|
| Migration | Data preservation: existing rows have `instance_id = 'primary'` after migration. |
| Overlay store | CRUD with explicit instance_id. CRUD without instance_id (defaults to 'primary'). Multi-instance list. Delete specific instance. Counts with multi-instance. |
| Chat tools | `set_ship_overlay` with `instance_id: "new"` → confirm trust. `set_ship_overlay` without `instance_id` → auto trust (existing behavior). |
| Sync import | Multi-instance export payload. Changeset diff with instances. Dry-run preview with instance counts. |
| Frontend | Instance badge rendering. Instance picker interaction. Aggregate counts. |

---

## Implementation Slices

### Slice 0: Migration + Store (foundational)

- SQL migration: add `instance_id` column, expand primary key.
- Update overlay-store.ts: all methods gain `instanceId` support.
- Update types: `OfficerOverlay`, `ShipOverlay`, `SetOfficerOverlayInput`, `SetShipOverlayInput`.
- Tests: CRUD with and without `instanceId`.

### Slice 1: Chat Tool Integration (depends on Slice 0)

- `set_officer_overlay` and `set_ship_overlay` gain `instance_id` parameter in declarations.
- Trust gate: `instance_id === "new"` → `isCreate = true`.
- Generate `inst_<nanoid>` for new instances.
- Tests: confirm trust for new instance, auto trust for primary updates.

### Slice 2: Sync Import (depends on Slice 0, parallel with Slice 1)

- `sync_overlay` changeset diffing becomes instance-aware.
- Export payload schema: entities may have `instanceId` field.
- Receipt recording: include instance IDs in changeset entries.
- Instance generation in sync uses the same `inst_<nanoid>` pattern as Chat tools but does not depend on Chat tool code.
- Tests: multi-instance sync, instance-aware dry-run preview.

### Slice 3: Frontend (depends on Slice 0)

- Fleet view: multiple instance cards per ref_id.
- Catalog view: aggregate owned count, instance badges.
- Detail view: instance picker for multi-instance entities.
