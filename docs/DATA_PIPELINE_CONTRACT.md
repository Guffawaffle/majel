# Data Pipeline Contract — stfc.space Feed v1

> **Date:** 2026-04-05  
> **Author:** Gap analysis from live feed `stfc-en-20260403` (2026-04-03T07:01:57Z)  
> **Scope:** Maps every field from the stfc.space entity feed to `reference_*` table columns, identifies gaps, and records the unblocking decision for each capability slice.

---

## Feed Envelope Format

All entity files share a common envelope:

```json
{
  "schemaVersion": "1.0.0",
  "entityType": "ship",
  "generatedAt": "2026-04-03T07:01:57Z",
  "count": 113,
  "hash": "...",
  "records": [...]
}
```

Feed lives at:  
`/srv/crawlers/stfc.space/data/feeds/stfc-en-{locale}-{date}/{timestamp}/entities/{type}.json`

Locale used for Majel ingest: `stfc-en`

---

## Entity Counts (2026-04-03 feed)

| Entity | Count |
|--------|-------|
| ships | 113 |
| hostiles | 4 968 |
| systems | (see below) |
| officers | (all officers) |
| research | 2 318 |
| buildings | 107 |
| consumables | 2 528 |

---

## 1. Ships

### Feed fields
`id, max_tier, grade, rarity, scrap_level, build_time_in_seconds, faction, blueprints_required, hull_type, max_level, build_cost, build_requirements, art_id, loca_id, game_id, blueprint_costs, repair_cost, repair_time, officer_bonus, crew_slots, tiers, levels, ability, scrap, base_scrap, refits, xp_amount, asa`

**Note:** `scrap[]` is present on 45 of 113 ships. Ships without scrap have a null/empty array.

### `reference_ships` columns
`id, name, ship_class, grade, rarity, faction, tier, hull_type, ability (JSONB), warp_range (JSONB), link, build_time_in_seconds, max_tier, max_level, officer_bonus (JSONB), crew_slots (JSONB), build_cost (JSONB), levels (JSONB), game_id, tiers (JSONB), build_requirements (JSONB), blueprints_required`

### Gap table

| Feed field | reference_ships | Status | Priority |
|------------|-----------------|--------|----------|
| `scrap[]` | missing | ❌ gap | **HIGH — blocks E1.3** |
| `base_scrap` | missing | ❌ gap | Medium |
| `scrap_level` | missing | ❌ gap | Medium |
| `repair_cost` | missing | ❌ gap | Low |
| `repair_time` | missing | ❌ gap | Low |
| `refits[]` | missing | ❌ gap | Low |
| `xp_amount` | missing | ❌ gap | Low |
| `blueprint_costs` | missing | ❌ gap | Low |
| `asa` | missing | ❌ gap | Unknown (sparse field) |
| `art_id`, `loca_id` | not stored | ℹ️ intentional | — |
| `name` | ✅ present | translated from loca_id | — |

### Columns in reference_ships with no feed equivalent
- `ship_class` — not in feed; may come from translations or be a Majel classification
- `tier` — current tier state (vs `max_tier`); computed or user-supplied
- `warp_range` — computed or sourced elsewhere
- `link` — Majel-managed URL

### Decision for E1.3
`scrap` data **is in the feed** for 45 ships. Add `scrap JSONB` column to `reference_ships`, update CDN ingest to populate it, then implement `get_scrap_yields` tool. **E1.3 is unblocked.**

---

## 2. Hostiles

### Feed fields
`id, faction, level, ship_type, is_scout, is_outpost, loca_id, hull_type, rarity, count, strength, systems, warp, warp_with_superhighway, resources, game_id`

**Note:** `xp_amount` is **NOT present** in this feed. Not available from stfc.space CDN at feed level.

### `reference_hostiles` columns
`id, name, faction, level, ship_type, hull_type, rarity, strength, systems (TEXT[]), warp, resources (JSONB), game_id`

### Gap table

| Feed field | reference_hostiles | Status | Priority |
|------------|--------------------|--------|----------|
| `is_scout` | missing | ❌ gap | Medium |
| `is_outpost` | missing | ❌ gap | Medium |
| `warp_with_superhighway` | missing | ❌ gap | Medium |
| `count` | missing | ❌ gap | Low |
| `xp_amount` | **not in feed** | 🚫 not available | — |
| `art_id`, `loca_id` | not stored | ℹ️ intentional | — |

### Columns in reference_hostiles with no feed equivalent
- `name` — translated from loca_id

### Decision for E1.5 (hostile xp)
`xp_amount` is not in the CDN feed. Cannot be populated from the pipeline. May be sourced from community wikis (web_lookup) if needed. **E1.x hostile xp tool blocked at data layer.**

---

## 3. Systems

### Feed fields
`id, est_warp, est_warp_with_superhighways, is_deep_space, is_mirror_universe, faction, level, coords_x, coords_y, has_mines, has_planets, has_player_containers, has_missions, has_outpost, mine_resources, hostiles, node_sizes, hazard_level, hazards, is_wave_defense, is_surge_system, hazards_enabled, is_regional_space, game_id, mines, planets, player_container, missions, game_activity, wave_defense_challenge_id, max_active_mining_nodes, entry_cost`

**Note:** 195 wave defense systems in feed.

### `reference_systems` columns
`id, name, est_warp, is_deep_space, factions (TEXT[]), level, coords_x, coords_y, has_mines, has_planets, has_missions, mine_resources (JSONB), hostile_count, node_sizes (JSONB), hazard_level, game_id`

### Gap table

| Feed field | reference_systems | Status | Priority |
|------------|-------------------|--------|----------|
| `est_warp_with_superhighways` | missing | ❌ gap | High |
| `is_wave_defense` | missing | ❌ gap | High |
| `is_surge_system` | missing | ❌ gap | High |
| `is_regional_space` | missing | ❌ gap | Medium |
| `is_mirror_universe` | missing | ❌ gap | Medium |
| `has_outpost` | missing | ❌ gap | Medium |
| `hazards_enabled` | missing | ❌ gap | Low |
| `has_player_containers` | missing | ❌ gap | Low |
| `max_active_mining_nodes` | missing | ❌ gap | Low |
| `wave_defense_challenge_id` | missing | ❌ gap | Low |
| `entry_cost` | missing | ❌ gap | Low |
| `hostiles` | partially covered | ℹ️ denormalized in reference_hostiles.systems | — |
| `mines`, `planets`, `missions` | partially covered | ℹ️ in mine_resources/has_* flags | — |
| `faction` | ✅ present as `factions TEXT[]` | — | — |

### Columns in reference_systems with no feed equivalent
- `name` — translated from loca_id  
- `hostile_count` — derived (count of `hostiles[]` array)
- `factions` — in feed as `faction` (same data)

### Decision
System flag gaps (`is_wave_defense`, `is_surge_system`, etc.) are straightforward column additions. These should be added alongside the E1.x hostile filter work or as a standalone systems enrichment migration.

---

## 4. Research

### Feed fields
`id, loca_id, unlock_level, art_id, view_level, max_level, research_tree, buffs, first_level_requirements, row, column, game_id, levels, generation`

### `reference_research` columns
`id, name, research_tree, unlock_level, max_level, buffs (JSONB), requirements (JSONB), row, col, game_id`

### Gap table

| Feed field | reference_research | Status | Priority |
|------------|--------------------|--------|----------|
| `view_level` | missing | ℹ️ gap | Low |
| `generation` | missing | ℹ️ gap | Low |
| `art_id` | not stored | ℹ️ intentional | — |
| `column` | ✅ present as `col` | renamed | — |

**Verdict:** No blocking gaps for current research capabilities. `get_research_path` tool is functional.

---

## 5. Buildings

### Feed fields
`id, max_level, unlock_level, first_level_requirements, buffs, section, game_id, levels`

### `reference_buildings` columns
`id, name, max_level, unlock_level, buffs (JSONB), requirements (JSONB), game_id`

### Gap table

| Feed field | reference_buildings | Status | Priority |
|------------|---------------------|--------|----------|
| `section` | missing | ℹ️ gap | Low |

**Verdict:** No blocking gaps.

---

## 6. Officers

### Feed fields
`id, art_id, loca_id, faction, rarity, synergy_id, max_rank, ability, captain_ability, below_decks_ability, class, game_id, levels, stats, ranks, trait_config`

### `reference_officers` columns
`id, name, rarity, group_name, captain_maneuver, officer_ability, below_deck_ability, abilities (JSONB), tags (JSONB), officer_game_id (BIGINT), officer_class, faction (JSONB), synergy_id, max_rank, trait_config (JSONB)`

### Field name mapping

| Feed field | reference_officers column |
|------------|--------------------------|
| `captain_ability` | `captain_maneuver` |
| `ability` | `officer_ability` (primary) + `abilities` (full JSONB) |
| `below_decks_ability` | `below_deck_ability` |
| `class` | `officer_class` |
| `game_id` (INT) | `officer_game_id` (BIGINT) |
| `synergy_id` | `synergy_id` ✅ |
| `max_rank` | `max_rank` ✅ |
| `trait_config` | `trait_config` ✅ |

### Critical finding — officer sources

**`sources` (where to obtain an officer) is NOT in the CDN feed and never has been.** This is a confirmed gap in the stfc.space data model. The feed has no acquisition/source data for officers.

**Decision for #279 (officer sources):** Feed pipeline cannot deliver this. Options:
1. Web scrape community wiki (Memory Alpha / STFCSpace wiki / STFC Blog)
2. Manual curation / user-contributed data via a `reference_officer_sources` table
3. Defer entirely

**E1.5 (`get_officer_sources` tool) is blocked at the data layer — not a pipeline issue.**

---

## 7. Consumables

### Feed fields
`id, rarity, grade, requires_slot, buff, duration_seconds, category, art_id, loca_id, game_id`

### `reference_consumables` columns
`id, name, rarity, grade, requires_slot, buff (JSONB), duration_seconds, category, game_id`

### Gap table

| Feed field | reference_consumables | Status |
|------------|-----------------------|--------|
| `art_id`, `loca_id` | not stored | ℹ️ intentional |
| all others | ✅ covered | — |

**Verdict:** No gaps. Consumables are fully covered.

---

## 8. Canonical Schema vs Feed

The `migrations/canonical/001_canonical_schema.sql` (30 tables) covers officers, ships, research, buildings, and systems in normalized form. **Missing canonical tables:**

| Feed entity | canonical.* table | Status |
|-------------|-------------------|--------|
| `hostile` | none | ❌ not implemented |
| `consumable` | none | ❌ not implemented |
| `hostile_stats` | none | ❌ not implemented |
| `system.hostiles[]` | via reference_hostiles | ℹ️ flat reference only |

**Decision:** The canonical schema is not actively used by the current ingest pipeline (which writes to `reference_*` flat tables). Canonical hostile/consumable tables can be added when the full normalized pipeline is implemented. Not blocking for Phase B.

---

## 9. Unblocking Summary

| Capability | Issue | Feed data available? | Decision |
|-----------|-------|---------------------|----------|
| **E1.3 — scrap yields** | #276 | ✅ `scrap[]` on 45/113 ships | **UNBLOCKED — add column + ingest + tool** |
| **E1.5 — officer sources** | #279 | 🚫 not in feed | Blocked at data layer; defer or wiki scrape |
| **Hostile xp** | (new) | 🚫 not in feed | Not available from CDN |
| **System wave defense flags** | (new) | ✅ `is_wave_defense`, `is_surge_system`, etc. | Add columns in enrichment migration |
| **System superhighway warp** | (new) | ✅ `est_warp_with_superhighways` | Add column in enrichment migration |
| **Hostile scout/outpost flags** | (new) | ✅ `is_scout`, `is_outpost` | Add columns in enrichment migration |

---

## 10. Recommended Column Additions (Priority Order)

### P1 — Unblocks E1.3

```sql
ALTER TABLE reference_ships
  ADD COLUMN IF NOT EXISTS scrap JSONB,
  ADD COLUMN IF NOT EXISTS base_scrap JSONB,
  ADD COLUMN IF NOT EXISTS scrap_level INTEGER;
```

### P2 — System enrichment (high player value)

```sql
ALTER TABLE reference_systems
  ADD COLUMN IF NOT EXISTS est_warp_with_superhighways INTEGER,
  ADD COLUMN IF NOT EXISTS is_wave_defense BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_surge_system BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_regional_space BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_mirror_universe BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS has_outpost BOOLEAN NOT NULL DEFAULT FALSE;
```

### P3 — Hostile enrichment (medium player value)

```sql
ALTER TABLE reference_hostiles
  ADD COLUMN IF NOT EXISTS is_scout BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_outpost BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warp_with_superhighway INTEGER,
  ADD COLUMN IF NOT EXISTS hostile_count INTEGER;
```

---

*End of contract. Update this document when the feed schema version advances or new entity types are added.*
