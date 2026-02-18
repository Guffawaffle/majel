# ADR-028: Data Pipeline Roadmap — From Overlay to CIC

**Status:** Accepted  
**Date:** 2026-02-17 (accepted 2026-02-19)  
**Author:** Admiral (with self-assessment input from Aria/Gemini 3 Flash Preview)

### Implementation Progress

| Work | Issue | Status | Notes |
|------|-------|--------|-------|
| **CDN Reference Enrichment** | #83 | ✅ Complete | `data.stfc.space` static snapshot — 112 ships, 278 officers, hull_type/officerClass/faction/grade from game files. Enriches T2 reference catalog. |
| **CDN UI Surfacing** | #84 | ✅ Complete | Catalog & fleet views display CDN-sourced badges (hull type, officer class, faction). Filter dropdowns for officer class and hull type. |
| **Ship Class Audit** | #79 | ✅ Complete | Resolved by CDN hull_type enum — authoritative game-file classification. |
| **Legacy JSON Deprecation** | — | ✅ Complete | Boot no longer syncs reference data. `syncGamedataOfficers`/`syncGamedataShips` removed from boot path. |
| **External DB Seeding** | — | ✅ Complete | CDN data seeded via `scripts/seed-cloud-db.ts` running locally against cloud DB via Cloud SQL proxy. No runtime CDN fetch, no bundled JSON in Docker image. |
| Phase 1: Game State Sync | #73 | Not started | `sync_overlay` JSON import |
| Phase 2: Research Trees | #74 | Not started | Research tree ingestion |
| Phase 3: Inventory | — | Not started | Resource planning |
| Phase 4: Events/Away Teams | — | Not started | Dynamic game state |
| Phase 5: Battle Logs | — | Not started | Combat analysis |

## Context

Majel currently operates on a three-tier intelligence model:

| Tier | Source | Freshness | Coverage |
|------|--------|-----------|----------|
| **T1** — User Overlays | Manual input via UI + AI chat | Stale until user updates | Officers (65), Ships (20), Loadouts, Targets |
| **T2** — Reference Catalog | External seed from `data.stfc.space` snapshot via `scripts/seed-cloud-db.ts` | Static until re-seeded | 278 officers, 112 ships, abilities, hull types, build costs |
| **T3** — Training Knowledge | Gemini's training data | Frozen at training cutoff | Meta strategies, game mechanics, community wisdom |

This architecture means Aria is a **tactical advisor who remembers what you told her**, not a real-time Combat Information Center (CIC). The gap between T1 (what the Admiral tells Aria) and ground truth (what's actually happening in-game) creates "narrative drift" — Aria may suggest crews based on stale ship tiers or missing officer upgrades.

## Decision Drivers

During live testing (2026-02-17), Aria self-identified capability gaps when asked how she could improve beyond community tools like STFC.space. A follow-up conversation expanded these into five concrete data domains:

### Identified Capability Gaps

1. **Narrative Drift** — If you upgrade a ship in-game but don't tell Aria, `suggest_crew` uses outdated stats.
2. **Research Blindness** — No `list_research` tool exists. Hidden percentage buffs from the Combat/Galaxy research trees are invisible, making power calculations approximate.
3. **Inventory Blindness ("The War Chest")** — No material/parts awareness. `suggest_targets` gives general advice but can't say "you need 200 more 3★ Ore to tier up the Bortas." Extends to currencies (Faction Credits, Latinum) and ship-specific parts.
4. **Event Blindness ("The Mission Board")** — STFC is event-driven (Faction Hunts, Mining Monday, Incursions). Without visibility into active events and their scoring parameters, Aria can't proactively optimize: *"The 'Klingon Separatists' event is active — switch Dock 1 to the Saladin Grinder to maximize points-per-hull."*
5. **Away Team Conflicts** — Officer pool is shared between ship crews and Away Team missions. Aria doesn't know if a suggested officer is currently locked into a 12-hour Away Team mission.
6. **Faction & Syndicate Standing** — Without knowing reputation levels with the three main factions and Syndicate/Rogue tiers, store advice is potentially inaccurate ("buy the B'Rel blueprints" — but can you actually access that store?).
7. **Battle Log Analysis ("The Black Box")** — The ultimate evolution: post-mission analysis from combat logs. Instead of guessing why a fight was lost, Aria could identify the exact round where shield mitigation failed and suggest officer swaps to address the gap.

### Sensor Package Architecture

Aria proposed a tiered data model framed as "Sensor Packages" — users opt into the level of data integration they're comfortable with:

| Package | Source | Safety | Coverage |
|---------|--------|--------|----------|
| **Standard** | Native JSON export (manual or structured chat input) | 100% safe, no 3rd party | Roster, ships, docks, basic station stats (~80% of daily needs) |
| **Advanced** | 3rd party tools (e.g. Ripper's STFC Command Center) | User-accepted risk | Research trees, detailed materials, battle logs, events |
| **Hybrid** | Graceful degradation across both | User chooses per domain | Full CIC when available, honest "Unknown" when not |

**Key architectural principle:** The Advanced package doesn't require Majel to know *where* the data came from. A **Translator layer** maps external tool schemas (e.g. Ripper's `officer_id: 123`) to Majel's internal reference IDs (`wiki:officer:james-t-kirk`). This lets Aria consume the data without coupling to any specific mod.

**Hybrid UX pattern:**
> *"Admiral, I see your B'Rel blueprints via the Standard scan. For a detailed resource-required calculation, please upload an Advanced inventory scan or manually input your 3★ Ore count."*

### 3rd Party Considerations

- **Ripper's Mod (STFC Command Center)** is the community's primary deep-data extraction tool (research, battle logs, detailed inventories)
- Majel cannot *depend* on a 3rd party mod — but ignoring the most detailed data stream available to the community would be a missed opportunity
- Solution: treat 3rd party data as an **optional overlay**, never a requirement
- Users who don't use mods get Standard coverage; users who do get Advanced — the same codebase handles both via the Translator pattern

## Proposed Phases

### Phase 1: Game State Sync (`sync_overlay`) — Standard Package

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

### Phase 2: Research Tree Ingestion — Advanced Package

**Goal:** Let Aria see the Admiral's research levels so she can calculate *true* ship power and officer effectiveness.

**Impact:** Transforms `suggest_crew` from "general meta advice" to "mathematically certain tactical orders." Research tree buffs (combat damage, mining speed, hull strength) are percentage multipliers that stack — without them, all crew/ship power calculations are approximate.

**New tools:**
- `list_research` — Show current research levels by tree (Combat, Galaxy, Station, etc.)
- `calculate_true_power` — Compute actual ship stats including research buffs
- Enhanced `suggest_crew` — Factor in research-buffed officer abilities

**Data requirement:** Research tree structure + Admiral's completion state per node.

### Phase 3: Inventory & Resource Planning — Standard/Advanced Hybrid

**Goal:** Material and parts awareness for concrete upgrade paths.

**Impact:** Moves from "you should upgrade the Bortas" to "upgrading Bortas to T8 costs 450 3★ Ore, 300 3★ Crystal, 12 Bortas blueprints — you have 280 Ore, 150 Crystal, 8 BPs. Estimated 3 days of mining to close the gap."

**New tools:**
- `list_inventory` — Show material counts by category (Ore, Gas, Crystal, Parts, Currencies)
- `calculate_upgrade_path` — Specific resource requirements with gap analysis
- `estimate_acquisition_time` — Based on mining rates, daily rewards, event projections

**Standard mode:** Manual entry ("I have 280 3★ Ore") stored as user overlay.  
**Advanced mode:** Full inventory import from Ripper's/Command Center via Translator.

### Phase 4: Events, Away Teams & Faction Standing — Advanced Package

**Goal:** Contextual awareness of the game's dynamic state.

**New tools & data:**
- `list_active_events` — Ingest active events with scoring parameters to enable proactive dock/crew optimization
- `list_away_teams` — Track which officers are locked into Away Team missions (prevents suggesting unavailable officers for ship crews)
- `get_faction_standing` — Reputation levels with Federation, Klingon, Romulan factions + Syndicate/Rogue tiers (unlocks accurate store advice)

**Impact:** Eliminates "invisible officer conflicts" — Aria won't suggest an officer for a ship crew if they're currently on a 12-hour Away Team mission. Event awareness enables proactive advice instead of reactive.

### Phase 5: Battle Log Analysis ("The Black Box") — Advanced Package

**Goal:** Post-mission combat analysis from detailed battle logs.

**New tools:**
- `analyze_battle_log` — Consume a battle log JSON, identify the failure round, and correlate with officer abilities and ship stats
- `suggest_counter` — Given a lost battle, recommend specific crew/ship changes to address the identified weakness

**Impact:** The ultimate evolution from advisor to CIC. Instead of guessing why a fight was lost, Aria could tell you: *"Your Shield Mitigation failed in Round 4 because your Defense stat wasn't high enough for Spock's ability to keep up. I suggest swapping Bones for an officer with higher base Defense."*

**Prerequisite:** Research tree data (Phase 2) for accurate stat calculations.

### Cross-Cutting: External Overlay Translator

**Goal:** A schema-mapping layer that lets Majel consume data from any external tool without coupling to a specific mod's data format.

**Approach:**
- Define a `TranslatorConfig` per external source (e.g. `ripper-v3.translator.json`)
- Map external IDs to Majel's internal reference IDs (e.g. `officer_id: 123` → `wiki:officer:james-t-kirk`)
- Validate translated data against `MajelGameExport` schema before ingestion
- Log translation results for debugging without exposing source-specific details

**Benefit:** Having the capability to calculate with external data means the tool becomes exponentially more powerful the moment that data becomes available — whether from a mod or a future native export.

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
| 3rd party mod discontinued or broken | Translator layer decouples; Standard package always works without it |
| Mod usage violates Scopely ToS | Majel never requires mod data; Advanced is opt-in with clear user consent |
| Schema drift between Ripper's versions | Translator configs are versioned; validation catches mismatches |
| Officer pool conflicts (ship vs Away Team) | Away Team data is optional enhancement; without it, Aria discloses uncertainty |

## Success Criteria

- Phase 1: Admiral can paste a JSON export and see "12 officers updated, 3 ships added, 1 dock reassigned"
- Phase 2: `suggest_crew` output includes research-adjusted power calculations
- Phase 3: `suggest_targets` includes "resource gap" analysis with concrete numbers
- Phase 4: Aria proactively mentions active events and avoids suggesting locked officers
- Phase 5: Admiral can upload a battle log and receive round-by-round failure analysis
- Translator: At least one external source (Ripper's or Command Center) can be ingested without code changes — config only

## References

- ADR-011: Data Sovereignty
- ADR-012: Reference Data
- ADR-013: Wiki Data Import
- ADR-025: Crew Composition Model
- ADR-026: Startup Import UX
- ADR-027: GenAI SDK Migration (Phase 2 — web lookup)
- Aria self-assessment transcript (2026-02-17 live session)
