# ADR-017: Fleet Tab Return & Player Data Roadmap

**Status:** Accepted  
**Date:** 2025-07-18  
**Authors:** Guff, Opie (Claude)

## Context

With ADR-016's Catalog-Overlay model stable and the Drydock loadout system operational, the next step is **player-centric data management** — tracking levels, ranks, power, and providing a dedicated view for the user's owned roster.

The original Fleet tab was retired during the Phase 1 "Clean House" sprint (pre-ADR-016) because it referenced the old Sheets-era `fleet-store.ts` roster model. Now that the catalog + overlay architecture is solid, Fleet returns as a **manager for owned items** built on top of the overlay.

### Current State (commit `8440235`)
- **Catalog** (ADR-016): Full reference grid with search, A-Z nav, filters, bulk ownership/target toggles, wiki sync
- **Overlay schema**: `officer_overlay` and `ship_overlay` tables already have `level`, `rank`/`tier`, `target_note`, `target_priority` columns — **none are surfaced in the UI**
- **Missing column**: `power` (INTEGER) on both overlay tables
- **Drydock**: 5-dock loadout system with ship assignment, intent catalog, crew presets
- **Views**: chat, drydock, catalog, diagnostics (4 views in `VALID_VIEWS`)
- **512 tests** passing across 13 test files

### Why Fleet Returns

The Catalog is designed as a **reference browser** — you scroll through everything, mark ownership, toggle targets. It's batch-oriented and discovery-focused. But once you've marked your 40 officers and 15 ships as owned, you need a **focused workspace** for:

1. **Tracking levels/ranks/power** — the overlay columns that exist but have no UI
2. **Quick roster overview** — "what do I own and at what levels?"
3. **Planning upgrades** — seeing all owned items with their current stats at a glance
4. **Targeted items section** — items you're actively pursuing, with notes

The Catalog shouldn't morph into a roster manager. Fleet is the roster manager; Catalog is the reference browser. Clean separation.

## Decisions

### D1: Fleet Tab as Fifth View

Fleet joins the existing view system: `VALID_VIEWS = ['chat', 'drydock', 'catalog', 'fleet', 'diagnostics']`.

- **Sidebar icon**: 🚀 Fleet
- **Title bar**: "Fleet — Your owned roster"
- **Route hash**: `#/fleet`
- **Module**: `src/client/fleet.js`

Fleet shows **only owned items** from the merged catalog, with inline editing for player-specific fields (level, rank, power, target notes).

### D2: Add `power` Column to Overlay Tables

Both `officer_overlay` and `ship_overlay` gain an `INTEGER power` column. Power is the primary progression metric in STFC. The ALTER TABLE approach is safe for a single-user SQLite app with no migration framework yet.

```sql
ALTER TABLE officer_overlay ADD COLUMN power INTEGER;
ALTER TABLE ship_overlay ADD COLUMN power INTEGER;
```

The overlay types, prepared statements, and merge endpoints all need updating to include `power`.

### D3: Catalog Defaults to "All" Filter

> **Evolution (2025-07-18):** Originally defaulted Catalog to `'owned'`. Reverted to `'all'` in the same release because Fleet now serves as the dedicated owned-items view, making the duplicate default confusing and redundant. Catalog returns to its role as a reference browser showing everything.

The Catalog ownership filter defaults to `'all'`, showing the full reference catalog. Fleet handles the "owned items only" view. One click on the ownership filter still narrows to owned/unowned.

### D4: Fleet Tab UI Sections

The Fleet tab renders two sub-tabs (Officers / Ships, matching Catalog pattern), each showing:

1. **Search bar** — filter owned items by name
2. **Stats summary** — "42 officers owned · Avg level 28 · Total power 1.2M"
3. **Roster grid** — cards for each owned item with:
   - Name, rarity badge, group/faction badge
   - Editable fields: level, rank (officers) / tier, level (ships), power
   - Target indicator + target notes (if targeted)
4. **Sort controls** — by name, level, power, rarity

Fields are saved via the existing overlay PATCH endpoints (`/api/catalog/officers/:id/overlay` and `/api/catalog/ships/:id/overlay`). No new server routes needed.

### D5: Canonical ID Anchor

All Fleet tab operations reference entities by their canonical wiki-namespaced IDs (ADR-015): `wiki:officer:<pageId>` / `wiki:ship:<pageId>`. The overlay's `ref_id` column is the FK to the reference table's `id`, ensuring Fleet, Catalog, and Drydock all share the same entity anchor.

### D6: Future — Target Notes Section

The overlay already has `target_note TEXT` and `target_priority INTEGER` (1=high, 2=medium, 3=low). Fleet tab will surface these as a "Targeted" filter that shows items with `target=1`, displaying notes and priority inline. This enables the "what do I need to unlock/upgrade next?" workflow.

### D7: Future — Timer System

Configurable reminder system for timed game events:
- User creates named timers (e.g., "Armada cooldown", "Research complete")
- Duration-based (X minutes/hours), not wall-clock
- Saveable presets for recurring timers
- Separate store (eventually `player.db` or timers table)
- Not part of this ADR's implementation scope

### D8: Future — DB Architecture Evolution

Current: everything in `reference.db` (12 tables across 3 stores).  
Eventually: split into purpose-specific DBs when complexity warrants it:

| DB | Contains | When |
|----|----------|------|
| `reference.db` | Wiki-imported ships + officers (read-only reference data) + overlays + docks | Now |
| `settings.db` | User preferences and configuration | Now |
| `chat.db` | Session/conversation history | Now |
| `behavior.db` | Behavioral rules, Beta-Binomial correction model | Now |
| `player.db` | Timers, player settings, progression tracking | When timer system arrives |
| `loadout.db` | Docks split out when dock system grows | Future |

Not splitting yet — the current single-file approach is perfectly fine for a single-user app. Document the direction for when it matters.

## Consequences

### Positive
- Overlay columns (`level`, `rank`, `tier`, `target_note`, `target_priority`) finally get a UI
- `power` column fills the last missing field for meaningful roster tracking
- Clean separation: Catalog = browse everything, Fleet = manage what you own
- No new server routes needed — reuses existing overlay PATCH endpoints
- Canonical IDs (ADR-015) unify entity references across all views

### Negative
- Fifth view adds complexity to the view switching system (minor — well-patterned)
- `power` ALTER TABLE is a one-off migration (acceptable at this project age)
- ~~Catalog defaulting to "owned" may confuse first-time users~~ — resolved by reverting to `'all'` default

### Risks
- Inline editing UX needs to feel snappy — debounce saves, optimistic UI updates
- Power values in STFC can be very large (millions) — need number formatting

## Implementation Plan

1. ✅ Write ADR-017 (this document)
2. ✅ Add `power` column to overlay tables + types + statements
3. ✅ Update merged endpoints to include `power` in response
4. ✅ Set Catalog default filter to `'owned'` → reverted to `'all'` (see D3 evolution note)
5. ✅ Create `fleet.js` client module (~430 lines)
6. ✅ Wire Fleet into app shell (VALID_VIEWS, sidebar, DOM, routing)
7. ✅ Implement inline editing for level/rank/tier/power
8. ✅ Test suite (512 tests) + commit `028cb27` + hardening pass (input validation, TOCTOU fix, stale-closure fix)

## References

- **ADR-015**: Canonical Entity Identity — wiki:* namespaced IDs
- **ADR-016**: Catalog-Overlay Model — reference catalog + overlay architecture
- **GitHub Issues**: #9 (Fleet UI), #13 (Advanced UI), #16 (Roadmap), #17 (Targets)
