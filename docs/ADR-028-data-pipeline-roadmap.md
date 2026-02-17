# ADR-028: Data Pipeline Roadmap — From Overlay to CIC

**Status:** Proposed  
**Date:** 2026-02-17  
**Author:** Admiral (with self-assessment input from Aria/Gemini 3 Flash Preview)

## Context

Majel currently operates on a three-tier intelligence model:

| Tier | Source | Freshness | Coverage |
|------|--------|-----------|----------|
| **T1** — User Overlays | Manual input via UI + AI chat | Stale until user updates | Officers (65), Ships (20), Loadouts, Targets |
| **T2** — Reference Catalog | One-time JSON import (`gamedata-ingest`) | Static (patch-lagged) | Officer stats, ship stats, abilities |
| **T3** — Training Knowledge | Gemini's training data | Frozen at training cutoff | Meta strategies, game mechanics, community wisdom |

This architecture means Aria is a **tactical advisor who remembers what you told her**, not a real-time Combat Information Center (CIC). The gap between T1 (what the Admiral tells Aria) and ground truth (what's actually happening in-game) creates "narrative drift" — Aria may suggest crews based on stale ship tiers or missing officer upgrades.

## Decision Drivers

During live testing (2026-02-17), Aria self-identified three capability gaps when asked how she could improve beyond community tools like STFC.space:

1. **Narrative Drift** — If you upgrade a ship in-game but don't tell Aria, `suggest_crew` uses outdated stats.
2. **Research Blindness** — No `list_research` tool exists. Hidden percentage buffs from the Combat/Galaxy research trees are invisible, making power calculations approximate.
3. **Inventory Blindness** — No material/parts awareness. `suggest_targets` gives general advice but can't say "you need 200 more 3★ Ore to tier up the Bortas."

## Proposed Phases

### Phase 1: Game State Sync (`sync_overlay`)

**Goal:** A structured import path — JSON export from game client or community tools → Majel ingest.

**Approach:**
- Define a `MajelGameExport` JSON schema covering: officers (with levels, ranks, tiers), ships (with tiers, components), dock assignments
- Build a `sync_overlay` fleet tool that accepts a game export and diffs it against existing overlays
- Detect additions, removals, and level/tier changes — present a summary before applying
- Reuse the ADR-026 receipt system for undo capability

**Data sources to investigate:**
- DJz / "Command Center" team — active STFC data standardization effort
- Scopely native export — the "Holy Grail" (no known API, but game state is serialized)
- Community scrapers (stfc.space data format, wiki exports)
- Manual structured entry via chat ("I just upgraded my Enterprise to Tier 7")

**Schema sketch:**
```json
{
  "version": "1.0",
  "exportDate": "2026-02-17T10:00:00Z",
  "source": "manual|stfc-space|command-center",
  "officers": [
    { "refId": "kirk", "level": 45, "rank": 5, "tier": 3, "owned": true }
  ],
  "ships": [
    { "refId": "uss-enterprise", "tier": 7, "components": {}, "owned": true }
  ],
  "docks": [
    { "number": 1, "shipId": "uss-enterprise", "loadoutId": 2 }
  ]
}
```

### Phase 2: Research Tree Ingestion

**Goal:** Let Aria see the Admiral's research levels so she can calculate *true* ship power and officer effectiveness.

**Impact:** Transforms `suggest_crew` from "general meta advice" to "mathematically certain tactical orders." Research tree buffs (combat damage, mining speed, hull strength) are percentage multipliers that stack — without them, all crew/ship power calculations are approximate.

**New tools:**
- `list_research` — Show current research levels by tree (Combat, Galaxy, Station, etc.)
- `calculate_true_power` — Compute actual ship stats including research buffs
- Enhanced `suggest_crew` — Factor in research-buffed officer abilities

**Data requirement:** Research tree structure + Admiral's completion state per node.

### Phase 3: Inventory & Resource Planning

**Goal:** Material and parts awareness for concrete upgrade paths.

**Impact:** Moves from "you should upgrade the Bortas" to "upgrading Bortas to T8 costs 450 3★ Ore, 300 3★ Crystal, 12 Bortas blueprints — you have 280 Ore, 150 Crystal, 8 BPs. Estimated 3 days of mining to close the gap."

**New tools:**
- `list_inventory` — Show material counts by category
- `calculate_upgrade_path` — Specific resource requirements with gap analysis
- `estimate_acquisition_time` — Based on mining rates, daily rewards, event projections

## Ethical & Legal Constraints

All data access must respect:
- **Scopely ToS:** No scraping of game client or servers. Player-initiated exports only.
- **Community sites:** Respect `robots.txt` and API policies (see ADR-027 Phase 2 web lookup discovery notes)
- **Data sovereignty:** All player data stays in their tenant (ADR-011). No cross-player aggregation without explicit consent.

## Risks

| Risk | Mitigation |
|------|------------|
| Scopely changes data format | Version the import schema; validate before apply |
| No official export API exists | Start with manual + community tool integration |
| Research tree changes per patch | Reference data versioned by game patch |
| Stale imports worse than no data | Track import age; warn when overlay > 7 days old |

## Success Criteria

- Phase 1: Admiral can paste a JSON export and see "12 officers updated, 3 ships added, 1 dock reassigned"
- Phase 2: `suggest_crew` output includes research-adjusted power calculations
- Phase 3: `suggest_targets` includes "resource gap" analysis with concrete numbers

## References

- ADR-011: Data Sovereignty
- ADR-012: Reference Data
- ADR-013: Wiki Data Import
- ADR-025: Crew Composition Model
- ADR-026: Startup Import UX
- ADR-027: GenAI SDK Migration (Phase 2 — web lookup)
- Aria self-assessment transcript (2026-02-17 live session)
