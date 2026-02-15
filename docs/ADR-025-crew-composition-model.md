# ADR-025 — Crew Composition Model: BridgeCore + BelowDeckPolicy + Variants

**Status:** Accepted  
**Date:** 2026-02-15  
**Authors:** Guff, Opie (Claude), with review from Lex  
**Supersedes:** ADR-022 loadout schema (retains ADR-022's architectural decisions D1–D8)  
**References:** ADR-022 (Loadout Architecture), ADR-010 (legacy, superseded), ADR-012 (Reference Data), ADR-003 (Epistemic Framework)

---

## Context

ADR-022 established the correct **architectural inversion** — task-first, dock-second. Its decisions (D1–D8) and phasing are sound. But its schema models loadout crews as a flat `loadout_members` table with `role_type IN ('bridge', 'below_deck')`. After analyzing the full game data (277 officers, 75 ships) and real play patterns at Ops 29+, three structural problems emerged:

### Problem 1: Bridge crews are the portable unit, not whole loadouts

Real play data shows stable **bridge trios** that move between ships:

- Kirk/Spock/McCoy → Kumari (grinding), Enterprise (armada), ISS Jellyfish (PvP)  
- 5-of-11/7-of-11/8-of-11 → Vi'Dar (Borg), any ship for Borg Probes  
- Uhura/McCoy/Chen → multiple ships for different mining activities

ADR-022's `loadout_members` flattens bridge and below-deck into one table. The same bridge trio on three ships is three separate sets of member records. There's no first-class entity for "Kirk/Spock/McCoy" as a reusable unit.

### Problem 2: Below deck is not "stats only" — BDAs exist

Modern STFC has **Below Deck Abilities (BDAs)**. A significant portion of the officer roster has BDA data, with dozens of distinct modifier types (ApexBarrier, IsolyticDamage, CritDamage, AllDefenses, MiningRate, etc.), many of which are conditional on specific game events. Several synergy groups are BDA-heavy (SNW, Lower Decks, Voyager, Unimatrix Twelve). See **Appendix A** for a point-in-time snapshot.

Below-deck slot counts vary by ship tier (6–10 slots). The optimal below-deck fill depends on the *intent* (mining wants MiningRate BDAs, PvP wants ApexBarrier + CritDamage). This means below-deck composition is **policy-driven**, not an individual officer list to manage manually.

### Problem 3: Situational swaps are deltas, not new loadouts

Real play involves small mutations on stable bases:

- "Swarm mode" = same bridge but swap Chen → T'Laan  
- "Borg mode" = replace entire bridge with "of Eleven" trio  
- "Mining overnight" = same ship + bridge, change below-deck policy to prioritize stats over BDAs

ADR-022 requires duplicating the entire loadout for each variant. The Admiral's mental model is: "take my PvP loadout, but swap one seat for Swarm."

### The Insight

> *Players operate as "stable anchors + situational swap packs", not as unique full-roster crews per activity.*

This ADR decomposes the loadout into composable layers: BridgeCore (the stable anchor), BelowDeckPolicy (the intent-driven recipe), and Variants (the swap packs).

---

## Decisions

### D1 — BridgeCore is a first-class reusable entity

A **BridgeCore** is a named trio of officers: captain + two bridge officers. It exists independently of any ship or loadout.

```
BridgeCore: "Kirk Trio"
  Captain:   Kirk
  Bridge 1:  Spock
  Bridge 2:  McCoy
```

BridgeCores are the Admiral's most stable building blocks. The same BridgeCore appears in multiple loadouts with different ships.

**No hard constraints on officer-to-slot fitness.** Any officer can occupy any bridge slot. An officer with no Captain Maneuver (the 74 BDA-only officers) can be placed in the captain seat — the system scores this as suboptimal and warns, but does not block. This matches the game, which allows arbitrary placement.

### D2 — BelowDeckPolicy is a versioned recipe, not an officer list

A **BelowDeckPolicy** describes *how to fill below-deck slots*, not which specific officers to place. It has three modes:

| Mode | Behavior |
|------|----------|
| `stats_then_bda` | Fill highest-stat officers first, prefer those with matching BDAs. Default mode. |
| `pinned_only` | Only place the explicitly pinned officers. Leave remaining slots empty for manual fill. |
| `stat_fill_only` | Ignore BDAs entirely. Pure stat optimization. |

The policy's `spec` JSONB stores its configuration:

```jsonc
{
  "pinned": ["raw:officer:123456", "raw:officer:789012"],  // always place these (canonical IDs per ADR-015)
  "prefer_modifiers": ["MiningRate", "AllStats"],           // BDA filter
  "avoid_reserved": true,                                   // respect officer_reservations
  "max_slots": 8                                            // optional cap
}
```

BelowDeckPolicies are reusable across loadouts. "Mining Below Deck" policy can serve gas, crystal, and ore loadouts.

The `spec_version` column enables non-breaking evolution: if mode semantics expand (e.g., a future `balanced` mode), the version tells the runtime which spec shape to expect.

### D3 — Loadout = Ship + BridgeCore + BelowDeckPolicy + Intent

A **Loadout** composes the layers:

```
Loadout: "Kumari Grinder"
  Ship:       Kumari
  BridgeCore: Kirk Trio
  BelowDeck:  Combat Below Deck (stats_then_bda, prefer CritDamage)
  Intents:    [grinding, armada-solo]
```

The same BridgeCore or BelowDeckPolicy can be referenced by multiple loadouts. Changing "Kirk Trio" updates every loadout that uses it.

### D4 — Variants are JSONB patches on a base loadout

A **Variant** is a named delta applied to a base loadout. It produces an effective loadout without duplicating the full configuration.

Patch merge semantics (frozen — do not re-interpret later):

| Patch Key | Merge Rule | Example |
|-----------|-----------|---------|
| `bridge.captain` | Replace seat in BridgeCore | `{"bridge": {"captain": "raw:officer:100200"}}` — swap captain only |
| `bridge.bridge_1` | Replace seat in BridgeCore | `{"bridge": {"bridge_1": "raw:officer:300400"}}` |
| `bridge.bridge_2` | Replace seat in BridgeCore | Same pattern |
| `below_deck_policy_id` | Replace entire BelowDeckPolicy reference | `{"below_deck_policy_id": 5}` |
| `below_deck_patch` | Set-diff on policy spec | `{"below_deck_patch": {"pinned_add": ["raw:officer:500600"], "pinned_remove": ["raw:officer:700800"]}}` |
| `intent_keys` | Full replace of intent list | `{"intent_keys": ["grinding-swarm"]}` |

**Merge rule index:**
- `bridge.*` = **replace** — individual seat overrides, does not clone the BridgeCore  
- `below_deck_policy_id` = **replace** — swap to a different policy entirely  
- `below_deck_patch` = **set-diff** — `pinned_add` is union, `pinned_remove` is difference, applied to the base policy's `spec.pinned`  
- `intent_keys` = **replace** — complete replacement of intent list on the effective loadout  

Any key not present in the patch inherits from the base loadout unchanged.

Example: "Swarm Swap" variant on "Kumari Grinder":
```jsonc
{
  "bridge": { "bridge_2": "raw:officer:100200" },  // T'Laan's canonical ID
  "intent_keys": ["grinding-swarm"]
}
```
Effective result: Kumari + Kirk(cpt) + Spock + T'Laan, intents=grinding-swarm. McCoy (the replaced bridge_2) is freed.

### D5 — FleetPreset = dock-number → loadout/variant snapshot

A **FleetPreset** is a saved snapshot of all dock assignments. It answers: "When I activate 'Mining Mode', what goes where?"

Fleet preset slots use **explicit FK columns** with a mutual-exclusion CHECK:

- `loadout_id` → direct loadout reference  
- `variant_id` → variant reference (implies its base loadout)  
- `away_officers` → JSONB array of officer IDs (only for away team slots)

The CHECK constraint enforces exactly one is non-NULL. This preserves referential integrity — if a loadout or variant is deleted, the FK cascade handles it rather than leaving orphaned IDs in a generic `config_id` column.

```
FleetPreset: "Mining Mode"
  Dock 1 → "BB Gas" loadout
  Dock 2 → "NS Crystal" loadout
  Dock 3 → "D'Vor Ore" loadout
  Dock 4 → "Kumari Grinder" (Swarm Swap variant)
  Away   → [T'Pring, Helvia, Joaquin]
```

### D6 — getEffectiveDockState() is the single truth function

The plan layer never reads raw preset slots or raw loadout assignments independently. A single function `getEffectiveDockState()` produces a normalized view:

```typescript
type EffectiveDockState = {
  docks: Array<{
    dock_number: number;
    loadout: ResolvedLoadout;      // with BridgeCore resolved + policy resolved
    variant_patch?: object;        // if a variant was applied
    intent_keys: string[];
    source: 'preset' | 'manual';   // how this assignment was created
  }>;
  away_teams: Array<{
    label: string;
    officers: string[];
    source: 'preset' | 'manual';
  }>;
  conflicts: OfficerConflict[];
};
```

**Precedence rule (frozen):** Manual overrides win over preset defaults.

Rationale: A preset is a starting point — "load Mining Mode." If the Admiral then manually swaps Dock 2 to a PvP loadout, that override persists until the Admiral explicitly re-activates the preset or clears the override. This matches the game's behavior: presets are quick-load, not locks.

The briefing, solver, fleet-tools, and UI all consume `getEffectiveDockState()` as their sole input. No second code path.

### D7 — Officer reservations are first-class

An **OfficerReservation** marks an officer as reserved for a specific purpose:

- `locked = false` (soft): Solver/auto-fill will prefer not to use this officer elsewhere, but can if needed. Displays a warning.  
- `locked = true` (hard): Solver/auto-fill **must never** move this officer unless they are explicitly pinned in the target loadout/variant. No override.

This directly solves: "Don't steal my T'Laan from the Swarm loadout to fill a below-deck slot on my miner."

### D8 — Docks table earns its keep with metadata

The `docks` table stays. It stores:
- `label` — user nickname ("Mining Bay", "PvP Slot", "Borg Bay")
- `notes` — freeform text
- `unlocked` — whether this dock slot is available (tracks game progression)
- Referential integrity for `fleet_preset_slots.dock_number`

At Ops 29 the Admiral has 4 docks. At Ops 40+ they may have 5+. The table validates that dock numbers reference real slots and stores the metadata that makes the plan view useful.

### D10 — Applying presets requires docked state (UX constraint)

In STFC, applying officer or fleet presets requires ships and officers to be **docked and available** — you cannot swap crew on a ship that is out on a mission. Majel does not model mission timers or recall delays, but the UI and tool output must not imply "swap anywhere instantly."

Practically this means:
- Fleet preset activation is a **planning** operation ("this is what I want when everything is home"), not an instant state change
- The plan briefing should note when a preset references ships/officers that may be in-flight
- The `getEffectiveDockState()` output represents **desired** state, not guaranteed current game state

### D9 — Strong-handed migration

All ADR-010 and ADR-022 loadout/fleet/plan tables are **dropped and recreated**. This is a single-user test system; there is no production data to migrate.

**Tables dropped:**

From ADR-010 (dock-store.ts):
- `preset_tags`
- `crew_preset_members`
- `crew_presets`
- `dock_ships`
- `dock_intents`
- `drydock_loadouts`

From ADR-022 (loadout-store.ts):
- `plan_away_members`
- `plan_items`
- `docks`
- `loadout_members`
- `loadouts`

**Tables kept intact:**
- `intent_catalog` — reference vocabulary, kept and reseeded
- `reference_officers` — reference data (no changes needed)
- `reference_ships` — reference data (no changes needed)
- `officer_overlay` — user customizations on reference data
- `ship_overlay` — user customizations on reference data
- All auth/session tables
- `frames` (Lex memory)

---

## Schema

### New tables

```sql
-- ═══════════════════════════════════════════════════════
-- L2a: Bridge Cores — reusable bridge trios
-- ═══════════════════════════════════════════════════════

CREATE TABLE bridge_cores (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                       -- "Kirk Trio", "Borg Bridge"
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bridge_core_members (
  id SERIAL PRIMARY KEY,
  bridge_core_id INTEGER NOT NULL REFERENCES bridge_cores(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
  slot TEXT NOT NULL CHECK (slot IN ('captain', 'bridge_1', 'bridge_2')),
  UNIQUE(bridge_core_id, slot),
  UNIQUE(bridge_core_id, officer_id)
);

CREATE INDEX idx_bcm_officer ON bridge_core_members(officer_id);
CREATE INDEX idx_bcm_core ON bridge_core_members(bridge_core_id);

-- ═══════════════════════════════════════════════════════
-- L2b: Below Deck Policies — intent-driven recipes
-- ═══════════════════════════════════════════════════════

CREATE TABLE below_deck_policies (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                       -- "Combat Below Deck", "Mining Stats"
  mode TEXT NOT NULL DEFAULT 'stats_then_bda'
    CHECK (mode IN ('stats_then_bda', 'pinned_only', 'stat_fill_only')),
  spec_version INTEGER NOT NULL DEFAULT 1,
  spec JSONB NOT NULL DEFAULT '{}',                -- { pinned, prefer_modifiers, avoid_reserved, max_slots }
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- L2c: Loadouts — Ship + BridgeCore + BelowDeckPolicy
-- ═══════════════════════════════════════════════════════

CREATE TABLE loadouts (
  id SERIAL PRIMARY KEY,
  ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
  bridge_core_id INTEGER REFERENCES bridge_cores(id) ON DELETE SET NULL,
  below_deck_policy_id INTEGER REFERENCES below_deck_policies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                              -- "Kumari Grinder", "BB Gas"
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  intent_keys JSONB NOT NULL DEFAULT '[]',
  tags JSONB NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(ship_id, name)
);

CREATE INDEX idx_loadouts_ship ON loadouts(ship_id);
CREATE INDEX idx_loadouts_bridge ON loadouts(bridge_core_id);
CREATE INDEX idx_loadouts_bdp ON loadouts(below_deck_policy_id);
CREATE INDEX idx_loadouts_intent ON loadouts USING GIN (intent_keys);
CREATE INDEX idx_loadouts_tags ON loadouts USING GIN (tags);
CREATE INDEX idx_loadouts_priority ON loadouts(priority DESC);

-- ═══════════════════════════════════════════════════════
-- L2d: Loadout Variants — JSONB patch deltas
-- ═══════════════════════════════════════════════════════

CREATE TABLE loadout_variants (
  id SERIAL PRIMARY KEY,
  base_loadout_id INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                              -- "Swarm Swap", "Borg Mode"
  patch JSONB NOT NULL DEFAULT '{}',               -- merge semantics defined in D4
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(base_loadout_id, name)
);

CREATE INDEX idx_variants_base ON loadout_variants(base_loadout_id);

-- ═══════════════════════════════════════════════════════
-- L3a: Docks — resource slots with metadata
-- ═══════════════════════════════════════════════════════

CREATE TABLE docks (
  dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
  label TEXT,                                      -- "Mining Bay", "PvP Slot"
  unlocked BOOLEAN NOT NULL DEFAULT TRUE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ═══════════════════════════════════════════════════════
-- L3b: Fleet Presets — saved dock assignment snapshots
-- ═══════════════════════════════════════════════════════

CREATE TABLE fleet_presets (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,                       -- "Mining Mode", "PvP Fleet", "Borg Day"
  is_active BOOLEAN NOT NULL DEFAULT FALSE,        -- at most one active at a time
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE fleet_preset_slots (
  id SERIAL PRIMARY KEY,
  preset_id INTEGER NOT NULL REFERENCES fleet_presets(id) ON DELETE CASCADE,
  dock_number INTEGER REFERENCES docks(dock_number) ON DELETE CASCADE,  -- NULL = away team
  loadout_id INTEGER REFERENCES loadouts(id) ON DELETE CASCADE,
  variant_id INTEGER REFERENCES loadout_variants(id) ON DELETE CASCADE,
  away_officers JSONB,                             -- ["raw:officer:123", "raw:officer:456", ...] canonical IDs per ADR-015; only when dock_number IS NULL
  label TEXT,                                      -- display name for away team slots
  priority INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  -- Exactly one of: loadout_id, variant_id, away_officers must be non-NULL
  CHECK (
    (loadout_id IS NOT NULL AND variant_id IS NULL AND away_officers IS NULL) OR
    (loadout_id IS NULL AND variant_id IS NOT NULL AND away_officers IS NULL) OR
    (loadout_id IS NULL AND variant_id IS NULL AND away_officers IS NOT NULL)
  ),
  UNIQUE(preset_id, dock_number)
);

CREATE INDEX idx_fps_preset ON fleet_preset_slots(preset_id);
CREATE INDEX idx_fps_loadout ON fleet_preset_slots(loadout_id);
CREATE INDEX idx_fps_variant ON fleet_preset_slots(variant_id);

-- Enforce at most one active fleet preset at the DB level
CREATE UNIQUE INDEX idx_fleet_preset_one_active
  ON fleet_presets ((TRUE)) WHERE is_active = TRUE;

-- ═══════════════════════════════════════════════════════
-- L3c: Plan Items — what the Admiral is running
-- ═══════════════════════════════════════════════════════

CREATE TABLE plan_items (
  id SERIAL PRIMARY KEY,
  intent_key TEXT REFERENCES intent_catalog(key) ON DELETE SET NULL,
  label TEXT,
  loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES loadout_variants(id) ON DELETE SET NULL,
  dock_number INTEGER REFERENCES docks(dock_number) ON DELETE SET NULL,
  away_officers JSONB,                             -- for away team plan items (canonical IDs per ADR-015)
  priority INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'preset')),        -- tracks origin for precedence
  notes TEXT,
  -- Exactly one of: loadout_id, variant_id, away_officers must be non-NULL
  CHECK (
    (loadout_id IS NOT NULL AND variant_id IS NULL AND away_officers IS NULL) OR
    (loadout_id IS NULL AND variant_id IS NOT NULL AND away_officers IS NULL) OR
    (loadout_id IS NULL AND variant_id IS NULL AND away_officers IS NOT NULL)
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_plan_items_loadout ON plan_items(loadout_id);
CREATE INDEX idx_plan_items_variant ON plan_items(variant_id);
CREATE INDEX idx_plan_items_dock ON plan_items(dock_number);
CREATE INDEX idx_plan_items_intent ON plan_items(intent_key);
CREATE INDEX idx_plan_items_active ON plan_items(is_active) WHERE is_active = TRUE;

-- ═══════════════════════════════════════════════════════
-- L2e: Officer Reservations — protect key officers
-- ═══════════════════════════════════════════════════════

CREATE TABLE officer_reservations (
  officer_id TEXT PRIMARY KEY REFERENCES reference_officers(id) ON DELETE CASCADE,
  reserved_for TEXT NOT NULL,                      -- "Borg Loop", "PvP Anchor", freeform
  locked BOOLEAN NOT NULL DEFAULT FALSE,           -- TRUE = hard lock, solver must never move
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Tables kept as-is (from ADR-022)

```sql
-- intent_catalog — reference vocabulary, unchanged
-- Reseeded on boot with 22 SEED_INTENTS
CREATE TABLE intent_catalog (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  is_builtin BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Entity Relationship

```
reference_ships ──────────────────────────────────────────┐
                                                          │
reference_officers ──┬── bridge_core_members               │
                     │         │                           │
                     │    bridge_cores                     │
                     │         │                           │
                     │    ┌────┘                           │
                     │    │                                │
                     │  loadouts ←── below_deck_policies   │
                     │    │  │                              │
                     │    │  └──── loadout_variants         │
                     │    │              │                  │
                     │    │    fleet_preset_slots           │
                     │    │         │                       │
                     │    │    fleet_presets                │
                     │    │                                │
                     │    └──── plan_items ←── intent_catalog
                     │              │
                     │         docks (nullable)
                     │
                     └── officer_reservations
```

---

## Patch Merge Semantics (Normative)

This section is **normative**. Any runtime that resolves a variant into an effective loadout MUST follow these rules exactly. Changing merge semantics requires a new ADR.

### Resolution algorithm: `resolveVariant(base, variant)`

```
Input:  base: Loadout (with resolved BridgeCore + BelowDeckPolicy)
        variant: LoadoutVariant (with patch JSONB)

Output: EffectiveLoadout

1. Start with a shallow copy of base.

2. For each key in patch:

   a. "bridge" (object):
      For each sub-key in patch.bridge:
        - MUST be one of: "captain", "bridge_1", "bridge_2"
        - Value is an officer reference ID
        - REPLACE that seat in the effective bridge. Other seats unchanged.
      The BridgeCore entity is NOT modified — this is a runtime overlay.

   b. "below_deck_policy_id" (integer):
      REPLACE the effective BelowDeckPolicy reference entirely.
      Mutually exclusive with "below_deck_patch" — if both present, reject as invalid.

   c. "below_deck_patch" (object):
      Applied as set-diff to the base policy's spec.pinned array:
        - "pinned_add": string[]  → UNION with existing pinned
        - "pinned_remove": string[] → DIFFERENCE from existing pinned
      Other spec fields (prefer_modifiers, avoid_reserved, max_slots) are NOT patchable
      via variant. Use "below_deck_policy_id" to swap to a different policy instead.
      Mutually exclusive with "below_deck_policy_id".

   d. "intent_keys" (string[]):
      REPLACE the effective intent list entirely.

   e. Any other key: REJECT as invalid patch. Do not silently ignore.

3. Recompute officer conflicts on the effective loadout.

4. Return EffectiveLoadout.
```

### Validation rules

- A patch MUST NOT contain both `below_deck_policy_id` and `below_deck_patch`
- `bridge.*` values MUST reference valid officer IDs in `reference_officers`
- `below_deck_policy_id` MUST reference a valid `below_deck_policies.id`
- `intent_keys` values MUST reference valid `intent_catalog.key` entries
- Unknown patch keys are rejected, not ignored (fail-fast)

### Canonical ID format (ADR-015)

All officer references in JSONB fields — variant patches (`bridge.*`), below-deck policy specs (`spec.pinned`), plan items (`away_officers`), and fleet preset slots (`away_officers`) — MUST use the canonical `raw:officer:<gameId>` format minted by the game data ingest pipeline (e.g., `raw:officer:988947581`). No short names, no slugs, no alternative prefixes. This is the same format stored in `reference_officers.id`.

---

## Dock-State Precedence (Normative)

This section is **normative**. It defines how `getEffectiveDockState()` resolves the current fleet configuration.

### State sources

1. **Active fleet preset** — `fleet_presets WHERE is_active = TRUE` (at most one)  
2. **Manual plan items** — `plan_items WHERE source = 'manual' AND is_active = TRUE`  
3. **Preset-derived plan items** — `plan_items WHERE source = 'preset' AND is_active = TRUE`

### Resolution order

```
1. If no active preset: dock state = manual plan items only.

2. If active preset exists:
   a. Expand preset slots into plan_items with source='preset'
   b. For each dock_number:
      - If a manual plan item exists for that dock → USE MANUAL (manual wins)
      - Else if a preset plan item exists → USE PRESET
      - Else → dock is unassigned
   c. Away teams: merge both sources (manual + preset). Do NOT deduplicate.
      If the same officer appears in both a manual and preset away team,
      surface it as an officer conflict (same model as bridge conflicts).
      The Admiral resolves conflicts explicitly — no silent auto-resolution.

3. Manual override is persistent until explicitly cleared or preset is re-activated.
   Re-activating a preset removes all source='preset' plan items and regenerates
   from the preset's current slots. Manual items are untouched.
```

### Rule: Manual wins

The Admiral manually swaps Dock 2 to a PvP loadout while "Mining Mode" preset is active. That manual override persists. The Admiral's explicit action always takes priority over automated preset expansion.

To fully re-apply a preset (clearing manual overrides), the Admiral must explicitly "Re-activate" the preset, which is a destructive action (confirmed via UI prompt).

---

## Officer Reservation Semantics (Normative)

### Soft reservation (`locked = false`)

- Solver/auto-fill generates a **warning** when assigning this officer to a loadout/below-deck/away-team that doesn't match `reserved_for`
- The assignment proceeds — the warning is informational
- UI displays a caution badge on the officer card
- BelowDeckPolicy with `avoid_reserved = true` skips soft-reserved officers

### Hard reservation (`locked = true`)

- Solver/auto-fill **must not** assign this officer to any position unless:
  - The officer is explicitly **pinned** in a BelowDeckPolicy's `spec.pinned` array, OR
  - The officer is explicitly placed in a BridgeCore's member slots, OR
  - The officer is explicitly listed in a variant's `bridge.*` patch
- Implicit/automatic placement is forbidden for hard-locked officers
- UI displays a lock icon on the officer card
- Attempting to auto-assign a hard-locked officer produces an error, not a warning

---

## Scoring, Not Constraints (Advisory)

This section defines **scoring guidance** — it is advisory, not enforced by the schema.

The game data reveals three ability archetypes (see Appendix A for exact counts):

| Archetype | Has CM | Has OA | Has BDA | Typical Role |
|-----------|--------|--------|---------|-------------|
| Bridge officer | ✅ | ✅ | ❌ | Captain or bridge seat |
| Below-deck officer | ❌ | ✅ | ✅ | Below deck for BDA + stats |
| Hybrid (rare) | ✅ | ✅ | ✅ | Either role |

The schema imposes **no constraints** based on archetype. Any officer can be placed in any slot. Application-layer scoring will:

1. **Warn** when a BDA-only officer (no CM) occupies the captain seat — their CM is effectively null
2. **Warn** when a CM-only officer (no BDA) is placed below deck — their value is stats only, no BDA contribution
3. **Score** bridge trios higher when synergy groups align (e.g., all three from "Original Series" synergy)
4. **Score** below-deck fills higher when BDA modifiers match the loadout's intent (MiningRate for mining, ApexBarrier for PvP)

This scoring is **out of scope for ADR-025** — it belongs to the solver/recommendation engine (future work). The schema simply preserves the ability data (`reference_officers.abilities` JSONB) for scoring to consume.

---

## What Changes from ADR-022

| ADR-022 Component | ADR-025 Change | Rationale |
|---|---|---|
| `loadout_members` table | **Replaced** by `bridge_cores` + `bridge_core_members` + `below_deck_policies` | Bridge trios are reusable; below deck is policy-driven |
| `loadouts.ship_id + flat members` | `loadouts.ship_id + bridge_core_id + below_deck_policy_id` | Composition over flat list |
| No variant concept | **Added** `loadout_variants` with JSONB patch | Deltas prevent loadout duplication |
| No fleet preset concept | **Added** `fleet_presets` + `fleet_preset_slots` | Dock snapshot for quick fleet swap |
| `plan_away_members` table | **Removed** — away teams use `plan_items.away_officers` JSONB | Simpler; away teams are small (3-5 officers) |
| No reservation concept | **Added** `officer_reservations` | Prevents accidental officer theft |
| Dock has no `unlocked` | **Added** `docks.unlocked` | Tracks progression |
| No variant/patch semantics | **Frozen** merge rules in normative section | Prevents re-refactors |
| No preset precedence rules | **Frozen** manual-wins-over-preset in normative section | Single truth source |

### What survives unchanged from ADR-022

- D1: Loadout is primary entity ✅
- D2: Plan is scheduling layer ✅
- D3: Docks are resource slots ✅
- D4: Intent catalog is vocabulary ✅
- D5: Officer conflicts are warnings ✅
- D6: No solver in v1 ✅ (scoring out of scope)
- D7: Layers independently functional ✅
- D8: Replace, don't refactor ✅
- 3-tier briefing structure ✅ (data source changes, shape stays)
- Phase structure ✅ (schema additions integrate into existing phases)

---

## Layer Independence (updated from ADR-022 D7)

| Layer | Works alone? | Depends on | New in ADR-025 |
|---|---|---|---|
| L0: Reference data (ships, officers, intents) | Yes | Nothing | — |
| L1: Player state (overlays) | Yes | Reference data | — |
| L2a: Bridge Cores | Yes — saved trios | Reference officers | **New** |
| L2b: Below Deck Policies | Yes — saved recipes | Nothing (spec is self-contained) | **New** |
| L2c: Loadouts | Yes — saved configs | Ship + BridgeCore + BDP for full resolution | **Refactored** |
| L2d: Variants | Yes — patch on loadout | Base loadout | **New** |
| L2e: Officer Reservations | Yes — standalone locks | Reference officers | **New** |
| L3a: Docks | Yes — just metadata | Nothing | Unchanged |
| L3b: Fleet Presets | Yes — dock snapshots | Loadouts/variants/docks | **New** |
| L3c: Plan Items | Yes — scheduling | Loadouts/variants/docks/intents | Refactored |
| L4: Solver | Optional | Everything | Future |

---

## API Surface (delta from ADR-022)

### New endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/bridge-cores` | List bridge cores |
| `GET` | `/api/bridge-cores/:id` | Bridge core with members |
| `POST` | `/api/bridge-cores` | Create bridge core |
| `PATCH` | `/api/bridge-cores/:id` | Update name/notes |
| `DELETE` | `/api/bridge-cores/:id` | Delete (nullifies loadout refs) |
| `PUT` | `/api/bridge-cores/:id/members` | Set trio members |
| `GET` | `/api/below-deck-policies` | List policies |
| `GET` | `/api/below-deck-policies/:id` | Single policy |
| `POST` | `/api/below-deck-policies` | Create policy |
| `PATCH` | `/api/below-deck-policies/:id` | Update policy |
| `DELETE` | `/api/below-deck-policies/:id` | Delete (nullifies loadout refs) |
| `GET` | `/api/loadouts/:id/variants` | List variants for loadout |
| `POST` | `/api/loadouts/:id/variants` | Create variant |
| `PATCH` | `/api/loadouts/variants/:id` | Update variant |
| `DELETE` | `/api/loadouts/variants/:id` | Delete variant |
| `GET` | `/api/fleet-presets` | List presets |
| `GET` | `/api/fleet-presets/:id` | Preset with slots |
| `POST` | `/api/fleet-presets` | Create preset |
| `PATCH` | `/api/fleet-presets/:id` | Update preset metadata |
| `DELETE` | `/api/fleet-presets/:id` | Delete preset |
| `PUT` | `/api/fleet-presets/:id/slots` | Set preset slots |
| `POST` | `/api/fleet-presets/:id/activate` | Activate preset (expand to plan items) |
| `GET` | `/api/officer-reservations` | List reservations |
| `PUT` | `/api/officer-reservations/:officerId` | Set/update reservation |
| `DELETE` | `/api/officer-reservations/:officerId` | Clear reservation |
| `GET` | `/api/plan/effective-state` | `getEffectiveDockState()` — the single truth endpoint |

### Modified endpoints (from ADR-022)

| Method | Path | Change |
|--------|------|--------|
| `POST` | `/api/loadouts` | Body now takes `bridge_core_id` + `below_deck_policy_id` instead of inline members |
| `PATCH` | `/api/loadouts/:id` | Can update `bridge_core_id`, `below_deck_policy_id` |
| `DELETE` | `PUT /api/loadouts/:id/members` | **Removed** — members are managed via bridge cores and policies |
| `GET` | `/api/plan/briefing` | Briefing now includes BridgeCore names, policy modes, variant patches |

### Removed endpoints

| Method | Path | Reason |
|--------|------|--------|
| `PUT` | `/api/loadouts/:id/members` | Replaced by bridge core + policy composition |
| `PUT` | `/api/plan/:id/away-members` | Away teams use `plan_items.away_officers` JSONB directly |

---

## Scope

### In scope (this ADR)

- BridgeCore + BelowDeckPolicy as composable entities
- Ability scopes (captain | bridge | below_deck) as scoring metadata — no constraints
- Loadout = Ship + BridgeCore + BelowDeckPolicy + Intent
- Variants as JSONB patches with frozen merge semantics
- FleetPreset = dock snapshot with explicit FK referential integrity
- Dock-state precedence: manual wins over preset
- Officer reservations with locked/soft semantics
- Strong-handed migration (wipe loadout/fleet/preset tables, keep auth + reference + overlay)
- Schema DDL and entity relationships
- Normative merge and precedence rules

### Out of scope (future work)

- Best-crew optimization / scoring engine
- Full stat-cap math per ship tier
- Automatic away team planning beyond conflict warnings
- BDA priority scoring algorithms
- Below-deck auto-fill implementation (policy modes defined, runtime deferred)
- Solver improvements
- Client UI for new entities (follows ADR-023 view architecture)

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| BridgeCore adds a layer of indirection | More entities to manage | UI hides complexity in BASIC mode; bridge core is auto-created from first loadout |
| BelowDeckPolicy modes are premature | Only `pinned_only` may be used initially | Default to `stats_then_bda`, modes are opt-in. `spec_version` allows evolution |
| Patch merge semantics are hard to debug | Variant produces unexpected result | Frozen rules + `GET /api/plan/effective-state` shows resolved state |
| Manual-wins precedence may confuse | "I activated a preset but Dock 2 didn't change" | UI shows override badge; re-activate is explicit action |
| Strong migration loses test data | All loadout/plan configs wiped | Acceptable — single-user test system, rebuilding is fast |
| Many new tables (10 vs ADR-022's 5) | More schema surface | Each table has a clear single purpose; no table exceeds 5 columns of business data |

---

## Consequences

### Positive

- **Bridge trios are reusable** — Kirk/Spock/McCoy defined once, used across Kumari, Enterprise, ISS Jellyfish
- **Below-deck is policy-driven** — "Mining Below Deck" recipe works for gas, crystal, ore without per-ship configuration
- **Variants prevent duplication** — "Swarm mode" is a one-seat delta, not a full loadout clone
- **Fleet presets enable whole-fleet swap** — "switch to Mining Mode" in one action
- **Officer reservations prevent theft** — hard-locked T'Laan stays in Swarm loadout
- **Referential integrity preserved** — explicit FKs on fleet_preset_slots, no orphaned IDs
- **Normative merge rules prevent drift** — patch semantics are frozen, not emergent
- **Reference data untouched** — BDA data already flows; this is pure composition-layer work
- **Each entity is independently useful** — bridge cores work without policies, loadouts work without variants

### Negative

- **More entities** — 10 tables vs ADR-022's 5 (but each is simpler and more focused)
- **More endpoints** — ~48 total vs ADR-022's 22 (composition has a surface cost)
- **BelowDeckPolicy runtime** — modes are defined but auto-fill implementation is deferred
- **Patch complexity** — JSONB patches require careful validation and testing
- **Fleet presets add state** — the preset→plan expansion flow needs careful implementation and testing

---

## References

- ADR-022 (Loadout Architecture) — architectural decisions D1–D8 survive
- ADR-010 (Drydock Loadouts) — legacy, superseded by ADR-022, schema fully dropped
- ADR-012 (Reference Data) — ships/officers source of truth, untouched
- ADR-003 (Epistemic Framework) — calculated data > model inference
- Game data analysis (2026-02-15) — see Appendix A for snapshot counts
- Scopely Help Center — Fleet Preset = dock snapshot confirmation
- Design sessions (2026-02-14, 2026-02-15) — Guff + Opie + Lex feedback

---

## Appendix A — Game Data Ability Snapshot (as of 2026-02-15)

These numbers are a **point-in-time observation** from the game data at the date above. STFC patches regularly add officers, so these counts will drift. The ADR's architectural decisions are grounded in the stable fact that BDAs exist and drive intent-specific below-deck choices — not in the exact tallies.

| Metric | Value |
|--------|-------|
| Total officers | 277 |
| Officers with CM + OA (bridge archetype) | 202 |
| Officers with BDA + OA (below-deck archetype) | 74 |
| Officers with CM + OA + BDA (hybrid) | 1 (Naga Delvos) |
| Distinct BDA modifier types | 31 |
| BDAs with conditions (conditional triggers) | 42 of 75 |
| BDA-heavy synergy groups | SNW(10), Lower Decks(7), Voyager(7), Unimatrix Twelve(5) |
| Top BDA modifiers | ApexBarrier(9), IsolyticDamage(6), IsolyticDefense(6), CritDamage(5), AllDefenses(4), MiningRate(4) |
