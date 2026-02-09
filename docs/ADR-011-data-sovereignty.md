# ADR-011: Data Sovereignty — Sheet-as-Bootstrap, App-as-Truth

**Status:** Proposed  
**Date:** 2026-02-09  
**Authors:** Guff, Opie (Claude)

> **Evolution note:** ADR-015 (Canonical Entity Identity) formalizes the identity model for entities across all three tiers defined here. Bootstrap entities get `roster:*` namespaced IDs, reference entities get `wiki:*` IDs with provenance, and the `ref_id` column links roster entities to their canonical reference counterparts. This resolves the "who owns this row?" question at the identity level, not just the data-ownership level.

> **Evolution note (D1 superseded):** ADR-016 (Catalog-Overlay Model) retires Google Sheets as a bootstrap source entirely. The wiki reference catalog (ADR-013) becomes the primary entity source, with user state stored as a thin overlay (`officer_overlay`, `ship_overlay`) on reference entries rather than as imported roster rows. The three-tier model still holds, but Tier 1 (Bootstrap) is now seeded from the wiki catalog, not from Sheets. The `roster:*` namespace from ADR-015 is retired — the overlay on `wiki:*` reference entities replaces it.

## Context

Majel started as a **chat window over a spreadsheet**. Google Sheets held all fleet data, Majel imported it as CSV, injected it into Gemini prompts, and rendered answers. The sheet was the source of truth; the app was read-only.

This worked for the MVP proof-of-concept (v0.1–v0.5), but it creates fundamental limits:

1. **User can't manage fleet state in the app** — dock assignments, crew presets, ship status are all app concepts that don't exist in the sheet
2. **No reference data** — the app doesn't know game rules (officer synergies, ship specs, research trees) beyond what the user typed into their sheet
3. **Re-import destroys app state** — if the user refreshes the roster, app-side edits (crew presets, dock labels, status overrides) could be overwritten
4. **Cross-ship crew optimization requires app-owned state** — the sliding puzzle can't be solved if the truth lives in a sheet column

Meanwhile, Majel's backend already has rich fleet management capabilities (55+ API endpoints, dock/loadout/preset CRUD, conflict detection) with **zero UI exposure**. The Drydock UI (#3) will be the first feature that writes fleet state from the frontend.

This ADR formalizes the shift from "spreadsheet wrapper" to "self-contained fleet manager with AI integration."

## Decision

### D1: Google Sheets Becomes a Bootstrap Import Source

**Before:** Sheet is the source of truth. Every roster refresh re-imports everything.

**After:** Sheet is a **one-time bootstrap** (or periodic sync) that seeds SQLite. After import:
- All fleet management happens in the app (dock assignment, crew presets, ship status, labels)
- "Sync from Sheet" pulls only **new** items (ships/officers not yet in SQLite)
- For items that exist in both, **app-side edits win** (user's status, notes, crew assignments)
- Optional: show import diff before applying ("3 new officers found, 1 ship name changed")

**Rationale:** The app already stores fleet state in SQLite (fleet-store.ts, dock-store.ts). The question is just whether the sheet or the app is authoritative. Once the Drydock UI lets users assign ships and crews, the app must be authoritative or edits are meaningless.

### D2: Three-Tier Data Model

| Tier | What | Owner | Examples |
|------|------|-------|---------|
| **Bootstrap data** | User's specific fleet | Imported from sheet, then app-managed | My ships, my officers, my levels |
| **App-managed state** | Operational decisions | Created/edited in app only | Dock assignments, crew presets, ship status, labels |
| **Reference data** | Game rules & metadata | Seeded from structured sources | Intent catalog, officer synergies, ship specs, research trees |

**Rationale:** Clean separation prevents the "who owns this field?" confusion. A ship's `name` comes from import but its `status` (deployed/ready) is app-managed. Officer `level` comes from import but crew assignment is app-managed.

### D3: Reference Data Layer (New)

A new `reference-data.ts` module will manage game knowledge that isn't user-specific:

- **Intent catalog** (already exists in dock-store.ts — stays there)
- **Officer metadata** (group synergies, ability descriptions, position preferences) — seeded from stfc.space or manual curation
- **Ship specifications** (max crew slots by tier, base stats, class details) — enables the below-deck slot counter
- **Research tree** (future: full tree structure with costs, prerequisites, unlock paths)

This data is:
- Seeded on first run from bundled JSON/SQL
- Updatable via structured import (JSON files, or future web scraper)
- Never user-edited (it's "the game's rules," not the user's choices)
- Version-tracked so updates can be diffed

**Capture strategy for web resources:**
- Phase 1: Manual curation into seed JSON (officer groups, ship specs from stfc.space)
- Phase 2: Structured scraper for stfc.space API/pages (if available)
- Phase 3: Community-contributed data packs (JSON import)

### D4: Import Becomes Upsert-with-Precedence

The existing `importFromFleetData()` in fleet-store.ts currently does blind upserts. This changes to:

```
For each imported row:
  1. If ship/officer doesn't exist in SQLite → INSERT (full import)
  2. If exists AND has no app-side edits → UPDATE from sheet (re-sync)
  3. If exists AND has app-side edits → SKIP (app wins)
     - Optionally: flag for user review in import diff
```

Implementation: Add `imported_at` and `edited_at` timestamps. If `edited_at > imported_at`, the app-side edit wins.

### D5: Below-Deck Slot Count is App-Managed

The number of below-deck slots a ship has depends on its tier/grade (game rule) but the user may need to override it (ship upgrades, special configurations). This is stored as:

- `reference_data.ship_specs` provides the default (e.g., "G4 Survey has 4 below-deck slots at Tier 8")
- `ships.below_deck_override` allows user to set a different number via the +/− stepper
- Effective value: `override ?? reference_default ?? 4`

### D6: Exploration Intent Includes Questing

The existing `exploration` intent in `intent_catalog` is relabeled to **"Exploration / Questing"** in the UI. No schema change needed — just a display label update. The intent key remains `exploration`.

## Consequences

### Positive
- Majel becomes a real fleet manager, not just a chat window
- Users invest in the app (their data lives there), increasing stickiness
- AI can reason about complete operational state, not just roster inventory
- Cross-ship crew optimization becomes possible (the unique value proposition)
- Reference data layer enables "What should I research next?" and similar AI queries

### Negative
- Data loss risk if SQLite is corrupted/deleted — need backup story (export to JSON)
- Import logic becomes more complex (upsert with precedence vs blind overwrite)
- Reference data curation is ongoing work (game updates change stats/trees)

### Risks
- Over-engineering: reference data scraping could become a maintenance burden
- Scope creep: "fully self-contained STFC manager" is ambitious — keep phases tight

## Phases

| Phase | Scope | Depends On |
|-------|-------|------------|
| **v0.6** | Drydock UI (#3) + import-as-bootstrap + below-deck counter | Config SSoT (#5) ✅, Fleet APIs ✅ |
| **v0.7** | Fleet management view + ship/officer inline editing | Drydock UI |
| **v0.8** | Reference data layer + officer meta seed | Fleet view |
| **v0.9** | Research tree structure + web capture scaffolding | Reference data |
| **v1.0** | AI-powered suggestions in Drydock + function calling | All above |
