# ADR-026 — Startup + Import UX Contract: Parse Preview + Intuitive Fix

**Status:** Accepted  
**Date:** 2026-02-15  
**Authors:** Guff, Opie (Claude), with review from Lex  
**Supersedes:** None (pairs with ADR-025; ingestion not part of ADR-025 scope)  
**Amended by:** ADR-026a (Guided Setup, Aria Gating, Layer Boundary, Resolve Persistence)  
**References:** ADR-025 (Crew Composition), ADR-012 (Reference Data), ADR-013 (Wiki Import, superseded flow), ADR-015 (Canonical Identity)

---

## Context

Majel must support multiple user entry paths:
- Users who want to click-select owned items from a canonical catalog (no files).
- Users with spreadsheets (inconsistent formats).
- Users importing from community tools (known export schemas).
- Developers/testing users who will intentionally break import and need safe reset + diagnostics.

We want a consistent experience regardless of source. The key insight:
> The core product is not "import." The core product is **reviewable parsing** with **small, intuitive fixes** and a **reversible commit**.

AI assistance can accelerate mapping/repair, but must not be required to complete setup.

### Current State

Reference data is **bundled** in the repo (`data/raw-officers.json`, `data/raw-ships.json`) and loaded via `syncGamedataOfficers/Ships()` into `reference_officers`/`reference_ships`. This replaced the wiki ingest path (ADR-013). The sync is admin-gated (`POST /api/catalog/sync`) but has **no UI trigger** and **no auto-seed on first boot** — a new user sees empty catalog and fleet views with no way to populate them.

Ownership is tracked via overlay tables (`officer_overlay`, `ship_overlay`) with a three-state model: `unknown` (no row / default) → `owned` → `unowned`. The catalog view supports click-to-own with bulk operations and an in-memory undo stack, but no persistent receipts.

There is **no file import, CSV paste, or upload UI** anywhere in the client today.

---

## Decisions

### D1 — Two distinct import layers: Reference vs Ownership

All import operations target one of two layers:

| Layer | Target Tables | What It Means | Who Can Do It |
|-------|--------------|---------------|---------------|
| **Reference** | `reference_officers`, `reference_ships` | "What exists in the game" | Admin only |
| **Ownership** | `officer_overlay`, `ship_overlay` | "What I own and at what level/tier" | Any user |

Each of the 4 entry paths (D3) must declare which layer it targets:

| Path | Reference? | Ownership? |
|------|-----------|-----------|
| Quick Setup (catalog clicks) | No (pre-seeded) | **Yes** |
| Import a file (spreadsheet) | Possibly (new officers) | **Yes** |
| Community export (known schema) | Possibly | **Yes** |
| Developer/Sandbox | Both | Both |

Commit/receipt semantics differ per layer: reference commits are admin-gated and affect the shared catalog; ownership commits are per-instance.

### D2 — One canonical pipeline across all entry paths

All startup/ingestion paths MUST funnel into the same pipeline:

**Source → Parse/Detect → Preview → Mapping + Confidence → Resolve Queue → Commit → Receipt + Undo**

Where "Source" can be:
- Catalog selection ("no file" path)
- Known community export (schema-backed)
- Arbitrary spreadsheet/CSV (unknown schema)
- Dev fixtures/fuzz inputs (sandbox)

### D3 — Multi-path startup is explicit, always accessible

Provide a persistent "Start / Sync" hub (available on first run and later) with:
- **Quick Setup (No file)** — catalog-first ownership selection.
- **Import a file** — file picker (primary), paste CSV (secondary), drag/drop (optional).
- **Import from supported community export** — source picker with schema-based mapping.
- **Developer / Sandbox** — fixtures, reset, logs, fuzz tests.

Known community export schemas (initial list):
- **STFC Cheat Sheet M86** — a supported community export schema (deterministic mapping)

Even one concrete schema makes the "deterministic mapping" claim testable. Additional schemas added as discovered.

### D4 — UX invariant: "Parse Preview + Intuitive Fix" at every stage

Every stage MUST present:
1. **What we think we have** — parsed data in table/card form
2. **Confidence** — per-field confidence indicator (✓ high / ⚠ medium / ✗ low)
3. **The smallest, intuitive fix UI** — inline edit, dropdown swap, drag-drop column remap
4. **The resulting changes if committed** — changeset preview (adds / updates / removals)

No stage may require the user to "go figure it out in settings."

### D5 — AI assistance is optional and never a blocker

AI (Aria) may assist in:
- guessing column mappings
- normalizing messy names
- suggesting repairs

But the user MUST be able to complete setup without AI by using manual mapping + resolve tools.

Aria is a helper, not the onboarding gate:
- Free baseline includes: catalog browsing, preview, mapping UI, resolve queue, commit, receipt/undo.
- Aria-assisted actions are metered (subscription/tokens), but MUST always have a manual fallback.
- First run introduces Aria non-blocking (a small panel/tooltip), not a required chat step.

### D6 — Import never auto-creates composition without explicit opt-in

Import MUST default to:
- canonical catalog-backed ownership + overlays

If we can infer composition (BridgeCores/Loadouts/Presets per ADR-025), it must be a **separate opt-in step**:
- "Also create crews/loadouts from this import?" with preview + edit.

This pairs with ADR-025's conversational composition building — Aria can suggest BridgeCores from ownership data, but only when the user asks.

### D7 — Commit is transactional and produces a receipt

Every commit MUST:
- show a "changeset preview" (adds/updates/removals)
- apply changes transactionally (all-or-nothing)
- write an **Import Receipt** containing:
  - source metadata (path, format, schema version)
  - mapping used (for file imports)
  - unresolved items list  
  - applied changes summary
  - timestamp + version

Receipts MUST support "Undo last import" (rollback via inverse changeset).

**Undo scope rules:**
- Ownership undo → reverse overlay upserts. Straightforward.
- Reference undo → blocked if downstream composition entities (BridgeCores, Loadouts per ADR-025) reference the imported officers/ships. Show which entities depend on the targeted records.
- Composition undo (D6 opt-in) → cascade-check before delete. Show impact preview.

### D8 — Reference data auto-seeds on first boot

On startup, if `reference_officers` is empty, the server automatically runs game data ingest from bundled `data/raw-*.json` files. No user action required. The catalog is pre-populated before the user ever sees it.

This eliminates the current dead-end where catalog and fleet views show "no data" with no discoverable fix.

The client `setup` state detection (currently Gemini API key only) is extended to check for empty reference catalog as an additional setup condition.

### D9 — Ownership state machine is canonical

The overlay store's three-state model is the canonical ownership model:

```
unknown (no row) → owned → unowned
                 ↗         ↘
              (toggle)   (toggle)
```

Import targets the `ownership_state` field plus optional metadata (`level`, `rank`, `tier`, `power`, `target`, `target_note`, `target_priority`). Any import source that provides richer data (level/tier from a spreadsheet) writes directly to overlay fields.

### D10 — Developer/Sandbox connects to ADR-025 D9 (strong migration)

The Sandbox path provides:
- **Reset composition** — executes ADR-025 D9 (drop and recreate all composition tables). Confirmed via UI prompt.
- **Reset overlays** — wipe all ownership/target data. Confirmed via UI prompt.
- **Reset reference** — re-run game data ingest from bundled files. Safe (idempotent upsert).
- **Fixtures** — load test data sets (named fixture files).
- **Parse logs** — view last import's parse/map/resolve diagnostics.

These operations are admin-gated and display an environment badge ("sandbox mode").

---

## User Flows (Contracted)

### First Boot
1. Server starts → detects empty `reference_officers` → auto-seeds from `data/raw-*.json` (D8)
2. User opens Majel → setup guide shows if Gemini key missing (existing behavior)
3. If catalog populated but no owned items → Aria (or hub notification) prompts: "Head to the Catalog to mark your officers, or import a roster file"
4. User proceeds via any D3 path

### Quick Setup (No file)
- User selects owned ships/officers from canonical catalog (existing catalog view)
- System shows "Parsed Ownership" preview (counts, missing essentials)
- User can fix via search/filter + bulk toggles (existing bulk operations)
- Commit writes overlays + receipt

### Import a File (unknown schema)
- User uploads/pastes via Start/Sync hub
- System detects candidate tables/columns → shows data preview
- System proposes column mapping with per-field confidence
- User fixes mapping via drag/drop field mapper + per-column transforms
- Resolve queue handles ambiguous names (fuzzy match against reference catalog) and duplicates
- Commit + receipt + undo

### Supported Community Export (known schema)
- User selects exporter type (e.g., "STFC Cheat Sheet M86")
- Deterministic mapping applied — all columns auto-mapped
- Any deviation falls back to the same mapping + resolve UI
- Commit + receipt + undo

### Developer / Sandbox
- Safe mode with environment badge
- Fixtures, fuzz inputs, reset overlays/composition/reference, parse logs
- Never the default path
- Reset composition = ADR-025 D9 migration

---

## Receipt Schema (Advisory)

```sql
CREATE TABLE import_receipts (
  id SERIAL PRIMARY KEY,
  source_type TEXT NOT NULL
    CHECK (source_type IN ('catalog_clicks', 'file_import', 'community_export', 'sandbox', 'auto_seed')),
  source_meta JSONB NOT NULL DEFAULT '{}',    -- filename, schema version, row counts, format
  mapping JSONB,                               -- column mapping used (file imports only)
  layer TEXT NOT NULL
    CHECK (layer IN ('reference', 'ownership', 'composition')),
  changeset JSONB NOT NULL DEFAULT '{}',       -- { added: [...], updated: [...], removed: [...] }
  inverse JSONB NOT NULL DEFAULT '{}',         -- reverse changeset for undo
  unresolved JSONB,                            -- items that couldn't be mapped/resolved
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## What Changes from Current State

| Current | ADR-026 Change | Rationale |
|---------|---------------|-----------|
| Empty catalog on first boot | **Auto-seed** from bundled game data (D8) | Eliminate dead-end first-run |
| No import UI | **Start/Sync hub** with 4 paths (D3) | Multiple entry points, one pipeline |
| Catalog bulk ops with in-memory undo | **Persistent receipts** with stored inverse (D7) | Surviving page refreshes, audit trail |
| No file import path | **File picker + paste + mapper** (D2, D4) | Support spreadsheet users |
| Sync button hidden/missing | **Always discoverable** in hub | No undiscoverable admin-only endpoints |
| No first-run detection for data | **Setup state extended** to check catalog (D8) | Guide user to next step |
| Import = everything at once | **Layer separation** (D1) + **composition opt-in** (D6) | Don't auto-create ADR-025 entities from raw import |

---

## Scope

### In scope (this ADR)
- Pipeline invariant (D2): parse → preview → map → resolve → commit → receipt
- Multi-path hub (D3) with 4 entry paths
- UX contract (D4): confidence + fix UI + changeset at every stage
- AI-optional guarantee (D5)
- Reference vs ownership layer separation (D1)
- Receipt table + undo (D7)
- Auto-seed on first boot (D8)
- Sandbox/reset connection to ADR-025 D9 (D10)

### Out of scope (future work)
- Specific file format parsers (implementation detail)
- AI-powered column mapping algorithms
- Google Sheets live sync integration
- Image-to-data pipeline (ADR-008, #10 — feeds into this same pipeline at the Parse stage)
- Composition inference from import data (D6 defines the opt-in gate; implementation deferred)

---

## Non-goals
- Best crew optimization / solver logic (ADR-025 scope)
- Continuous scraping or backend API dependence on third-party sites
- Forcing AI usage as a requirement for setup
- Multi-user ownership (overlay is per-instance; user scoping is a future concern)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Auto-seed adds boot time | Slower first start | Only runs when tables empty; subsequent boots skip |
| Receipt table grows indefinitely | Storage | Prune receipts older than N days (configurable) |
| File import parser complexity | Large surface area | Start with CSV/TSV only; Excel via library; schema-backed mappers |
| Undo of reference data blocked by composition deps | User frustration | Show clear dependency tree; suggest removing deps first |
| Confidence scoring is subjective | User confusion | Deterministic for known schemas; transparent heuristic for unknown |

---

## Consequences

### Positive
- Consistent mental model across all import paths
- Users always see "what Majel believes" and can correct it
- Trust increases via confidence + resolve + undo
- AI adds acceleration without creating lock-in
- First-boot dead-end eliminated
- Receipt trail enables debugging and rollback

### Negative
- More UI surface (mapper, resolve queue, receipts, hub)
- Needs careful transactional design + testing
- Auto-seed means bundled data must stay current with game patches

---

## References
- ADR-025 (Crew Composition Model) — D6 composition opt-in gate, D9 strong migration
- ADR-012 (Reference Data) — original template model, superseded for officers/ships by game data
- ADR-013 (Wiki Import) — established attribution requirements, ingest flow superseded by game data
- ADR-015 (Canonical Entity Identity) — `raw:officer:<gameId>` format for all imported IDs
- ADR-008 (Image Interpretation) — screenshot scan feeds into the same parse pipeline
