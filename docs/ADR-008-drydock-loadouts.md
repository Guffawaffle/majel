# ADR-008: Drydock Loadouts — Intent-Based Ship & Crew Rotation Management

**Status:** Proposed (planning only — not yet approved for execution)  
**Date:** 2026-02-08  
**Authors:** Guff, Opie (Claude)

## Context

With fleet config (ADR-007 Phase A) landed, Majel knows the Admiral has 4 drydocks at Ops 29. But it doesn't know **what each dock is for** or **which ships rotate through it**.

In STFC, drydocks aren't just parking spots — each one typically serves a **purpose** in the Admiral's daily workflow:

- Dock 1: "My main grinder" — always the same combat ship
- Dock 2: "Swap between Franklin for hostiles and Kumari for grinding"
- Dock 3: "Gas/crystal/ore mining — rotate survey ships by node type"
- Dock 4: "Tri/dilithium/parasteel mining — dedicated refinery ship"

This is the **drydock loadout** concept: each dock has an **intent** (what it does), a **rotation** of ships that serve that intent, and each ship has **crew configurations** that change based on what the dock is doing.

### Why This Matters for the Model

Without loadout context, Majel can answer "what ships do I have?" but not:
- "What should I put in dock 3 right now?" (needs to know dock 3 is for mining)
- "Optimize my grinding dock" (needs to know which dock grinds and what crew it uses)
- "I just unlocked a new ship — where does it fit?" (needs to understand the rotation logic)
- "I'm switching dock 2 to armada duty" (needs to update intent + rotation)

With loadouts in context, the model can reason about fleet **operations**, not just fleet **inventory**.

### Scale of This Feature

This is the largest UI lift Majel has attempted. The current UI is:
- Chat panel (left sidebar + main)
- Fleet config panel (right-side slide-out with number inputs)

This feature requires:
- A **visual drydock board** — N docks rendered as slots/cards
- **Drag-and-drop** or select-based ship assignment
- **Intent selectors** with standardized + custom categories
- **Crew configuration** per ship per intent
- **Multi-ship rotation** display per dock
- Real-time model context injection of the full loadout state

## Design

### 1. Intent Taxonomy

Intents should be **standardized but extensible**. A curated set covers 90% of use cases; custom intents handle the rest.

#### Standard Intents

| Intent Key | Label | Description |
|-----------|-------|-------------|
| `mining-gas` | Gas Mining | Collecting raw gas resources |
| `mining-crystal` | Crystal Mining | Collecting raw crystal resources |
| `mining-ore` | Ore Mining | Collecting raw ore resources |
| `mining-tri` | Tritanium Mining | Refined resource mining |
| `mining-dil` | Dilithium Mining | Refined resource mining |
| `mining-para` | Parasteel Mining | Refined resource mining |
| `mining-lat` | Latinum Mining | Special resource mining |
| `mining-iso` | Isogen Mining | Special/event resources |
| `grinding` | Hostile Grinding | Killing NPCs for XP/loot |
| `armada` | Armada | Multi-player boss battles |
| `pvp` | PvP/Raiding | Player vs player combat |
| `base-defense` | Base Defense | Stationed for station protection |
| `events` | Events | Rotating event-specific duties |
| `exploration` | Exploration | Away missions, dark space, etc. |
| `cargo-run` | Cargo Run | Hauling between stations |
| `custom` | Custom | User-defined intent |

#### Extensibility

- Standard intents ship with the app and are versioned
- Users can create custom intents with a key/label/description
- The model receives both standard and custom intent definitions so it can reason about them
- Future: community-contributed intent packs?

### 2. Data Model

#### New Tables

```sql
-- What each drydock is configured to do
CREATE TABLE drydock_loadouts (
  dock_number INTEGER PRIMARY KEY,     -- 1-8, corresponds to drydock A-H
  label TEXT,                          -- user nickname: "My Grinder", "Mining 1"
  intent TEXT NOT NULL DEFAULT 'custom', -- FK to intent taxonomy
  intent_detail TEXT,                  -- freeform: "dilithium fields in Rator"
  priority INTEGER NOT NULL DEFAULT 0, -- higher = more important dock
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Ships assigned to a dock (supports rotation — multiple per dock)
CREATE TABLE dock_ships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number),
  ship_id TEXT NOT NULL REFERENCES ships(id),
  is_active INTEGER NOT NULL DEFAULT 0,  -- 1 = currently the one in the dock
  sort_order INTEGER NOT NULL DEFAULT 0, -- display order in rotation
  notes TEXT,                            -- "use when dilithium nodes are up"
  created_at TEXT NOT NULL,
  UNIQUE(dock_number, ship_id)
);

-- Crew preset per ship per intent context
CREATE TABLE crew_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id TEXT NOT NULL REFERENCES ships(id),
  intent TEXT NOT NULL,                  -- what this crew config is for
  preset_name TEXT NOT NULL,             -- "mining crew", "armada crew"
  is_default INTEGER NOT NULL DEFAULT 0, -- auto-select when dock matches intent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ship_id, intent, preset_name)
);

-- Officers in a crew preset
CREATE TABLE crew_preset_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  preset_id INTEGER NOT NULL REFERENCES crew_presets(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES officers(id),
  role_type TEXT NOT NULL,               -- 'bridge' or 'below_deck'
  slot TEXT,                             -- 'captain', 'officer_1', 'belowdeck_1'
  UNIQUE(preset_id, officer_id)
);

-- Custom intents defined by the user
CREATE TABLE custom_intents (
  key TEXT PRIMARY KEY,                  -- e.g. "swarm-hunting"
  label TEXT NOT NULL,
  description TEXT,
  icon TEXT,                             -- emoji or icon class
  created_at TEXT NOT NULL
);
```

#### Relationship Diagram

```
drydock_loadouts (1-8 docks)
    │
    ├── dock_ships (N ships per dock, one active)
    │       │
    │       └── ships (existing table)
    │               │
    │               └── crew_presets (N presets per ship × intent)
    │                       │
    │                       └── crew_preset_members (N officers per preset)
    │                               │
    │                               └── officers (existing table)
    │
    └── intent taxonomy (standard + custom_intents table)
```

### 3. Model Context Injection

The drydock loadout state gets injected into the system prompt alongside fleet config:

```
DRYDOCK LOADOUTS (from Admiral's configuration):

DOCK 1 "Main Grinder" [grinding] Priority: HIGH
  ▸ Active: Kumari (Common, Battleship)
    Crew: Kirk (cpt), Spock, McCoy
  ▸ Rotation: (none — dedicated ship)

DOCK 2 "Hostile Swapper" [grinding] Priority: MEDIUM
  ▸ Active: U.S.S. Franklin (Rare, Survey → used for hostiles)
    Crew: Cadet Uhura (cpt), Cadet McCoy, T'Laan
  ▸ Rotation: ECS Horizon (Common, Survey) — "use for lower level grinding"

DOCK 3 "Raw Mining" [mining-gas, mining-crystal, mining-ore] Priority: MEDIUM
  ▸ Active: Botany Bay (Uncommon, Survey)
    Crew (mining-gas): Stonn (cpt), T'Pring, Helvia
    Crew (mining-crystal): Stonn (cpt), Chen, Brenna
  ▸ Rotation: North Star (Rare, Survey) — "better for protected cargo"

DOCK 4 "Refined Mining" [mining-tri, mining-dil, mining-para] Priority: LOW
  ▸ Active: ECS Horizon (Common, Survey)
    Crew (mining-dil): Joaquin (cpt), Khan, Carol
  ▸ Rotation: (none)
```

This gives the model:
- What each dock **does** (intent)
- What's **in** each dock right now (active ship)
- What **could go** in each dock (rotation)
- What **crew** to use for each combination
- **Priority** for resource allocation decisions

### 4. UI Experience — The Drydock Board

This is the first graphical, interactive UI component beyond chat + config panels.

#### Layout Concept

```
┌──────────────────────────────────────────────────┐
│ ⚓ DRYDOCK LOADOUTS                    [+ Add Dock] │
├──────────────────────────────────────────────────┤
│                                                  │
│  ┌─── DOCK 1 ──────────┐  ┌─── DOCK 2 ──────────┐ │
│  │ "Main Grinder"       │  │ "Hostile Swapper"    │ │
│  │ Intent: ⚔️ Grinding   │  │ Intent: ⚔️ Grinding   │ │
│  │                      │  │                      │ │
│  │ ┌──────────────────┐ │  │ ┌──────────────────┐ │ │
│  │ │ ★ Kumari         │ │  │ │ ★ Franklin       │ │ │
│  │ │   Kirk·Spock·McCoy│ │  │ │   Uhura·McCoy·T'L│ │ │
│  │ └──────────────────┘ │  │ ├──────────────────┤ │ │
│  │                      │  │ │   ECS Horizon    │ │ │
│  │                      │  │ │   (backup)       │ │ │
│  │                      │  │ └──────────────────┘ │ │
│  └──────────────────────┘  └──────────────────────┘ │
│                                                  │
│  ┌─── DOCK 3 ──────────┐  ┌─── DOCK 4 ──────────┐ │
│  │ "Raw Mining"         │  │ "Refined Mining"     │ │
│  │ Intent: ⛏ Mining      │  │ Intent: ⛏ Mining      │ │
│  │ ...                  │  │ ...                  │ │
│  └──────────────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────┘
```

#### Interaction Model

1. **Dock cards** are arranged in a grid (2-wide on desktop, 1-wide on mobile)
2. **Click dock card** → expands to show full rotation + crew details
3. **Intent selector** → dropdown of standard intents + custom
4. **Add ship to rotation** → search/select from ship inventory, drag to reorder
5. **Star icon** on a ship → marks it as the active ship in the dock
6. **Crew preset selector** → per ship, pick or create a crew preset for the dock's intent
7. **Drag officers** into crew slots (bridge: 3 slots, below-deck: variable)
8. **Dock label** → click to edit inline
9. **Priority** → drag to reorder docks, or simple up/down arrows

#### Progressive Complexity

**Phase 1 (MVP):** Static dock cards with select dropdowns. No drag-and-drop.
- Select intent from dropdown
- Select ships from dropdown (add to rotation)
- Select officers from dropdown (assign to crew)
- Toggle active ship with radio button
- Works, just not flashy

**Phase 2:** Drag-and-drop ships between docks and into rotation slots.
- HTML5 drag & drop or a lightweight library (Sortable.js is 10KB)
- Visual feedback: ghost, hover targets, snap-to-slot

**Phase 3:** Full crew builder with drag-and-drop officer cards.
- Officer pool panel (sidebar or bottom drawer)
- Drag officers into bridge/below-deck slots
- Conflict detection: "Kirk is already on Dock 1's Kumari"
- Animated reassignment

### 5. API Surface

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/fleet/docks` | List all dock loadouts with ships + crew |
| `GET` | `/api/fleet/docks/:num` | Single dock with full detail |
| `PUT` | `/api/fleet/docks/:num` | Create or update a dock loadout |
| `DELETE` | `/api/fleet/docks/:num` | Clear a dock's loadout |
| `POST` | `/api/fleet/docks/:num/ships` | Add ship to dock rotation |
| `DELETE` | `/api/fleet/docks/:num/ships/:shipId` | Remove ship from dock |
| `PATCH` | `/api/fleet/docks/:num/ships/:shipId` | Update (set active, reorder, notes) |
| `GET` | `/api/fleet/presets` | List all crew presets |
| `POST` | `/api/fleet/presets` | Create a crew preset |
| `PATCH` | `/api/fleet/presets/:id` | Update preset name, default status |
| `DELETE` | `/api/fleet/presets/:id` | Delete a crew preset |
| `POST` | `/api/fleet/presets/:id/members` | Add officer to preset |
| `DELETE` | `/api/fleet/presets/:id/members/:officerId` | Remove officer from preset |
| `GET` | `/api/fleet/intents` | List all intents (standard + custom) |
| `POST` | `/api/fleet/intents` | Create custom intent |
| `DELETE` | `/api/fleet/intents/:key` | Delete custom intent |

### 6. What the Model Gets (Prompt Context)

At engine creation, `buildSystemPrompt` receives a new `DrydockLoadout[]` alongside `FleetConfig` and `FleetData`. The model's instructions include:

```
You understand the Admiral's drydock rotation system:
- Each dock has a PURPOSE (intent) — mining, grinding, armada, etc.
- Each dock has a ROTATION of ships — one active, others on standby
- Each ship has CREW PRESETS per intent — different crews for different jobs
- When advising on crew or ship assignments, consider the dock's intent
- When the Admiral asks "what should I do with dock 3?", you know dock 3's purpose
- Cross-reference: if an officer is in a preset for dock 1 AND dock 3, flag the conflict
```

## Open Questions

These need answers before execution begins:

### Q1: Multi-intent docks
The Admiral's example: "dock 3 is gas/crystal/ore mining." That's **three intents** on one dock. Options:
- **A)** Docks have a single primary intent, with sub-categories (mining → gas/crystal/ore)
- **B)** Docks support multiple intents, each with their own crew preset
- **C)** Intents are hierarchical: `mining` is a parent, `mining-gas` is a child — dock has parent intent, presets are per child

Recommendation: **Option C** — hierarchical intents. The dock's intent is `mining`, and crew presets are tagged `mining-gas`, `mining-crystal`, etc. This keeps the dock card simple (one intent badge) while supporting granular crew configs.

### Q2: Crew conflict resolution
If Kirk is in dock 1's crew preset AND dock 3's preset, what happens?
- **A)** Allow it — presets are templates, not active assignments. Only one dock is actually crewed at a time in-game.
- **B)** Warn but allow — show a conflict indicator in UI
- **C)** Prevent — officer can only be in one preset at a time

Recommendation: **Option B** — presets are aspirational (what you'd LIKE to crew), not literal (what's crewed right now). Warn in UI with a yellow badge: "Kirk also in Dock 1 preset." The model can flag this when advising.

### Q3: Where does this UI live?
- **A)** New full-page view (replace chat temporarily)
- **B)** Slide-out panel from chat (like fleet config but bigger)
- **C)** Split view — chat on left, docks on right
- **D)** New tab/route (`/docks` or `/#docks`)

This is a big enough UI that it probably needs **its own view** rather than being crammed into the chat page.

### Q4: Active ship tracking
Is the "active" ship in a dock just a user toggle, or should Majel try to detect it from Sheets data? (The drydock tabs in Sheets already show which ship is in each dock.)

### Q5: How much data in the prompt?
With 4-8 docks × 2-4 ships each × crew presets, the loadout context could be 2-5KB of text in the system prompt. At what point do we:
- Summarize instead of enumerate?
- Use tool-calling to query loadouts on demand instead of prompt injection?
- Both? (Summary in prompt, detail via tool call)

### Q6: Interaction with existing fleet store
The current `fleet-store.ts` has `crew_assignments` tied to ships directly. Crew presets are a new parallel concept — a preset is a *saved configuration*, while an assignment is the *current state*. Do we:
- **A)** Replace crew_assignments with the preset system entirely
- **B)** Keep both — presets are templates, assignments are live state
- **C)** Presets replace assignments for now (we don't have tool-use to apply them yet anyway)

Recommendation: **Option C** for now. Crew presets replace the current crew_assignments table conceptually. When tool-use lands (Phase C of ADR-007), "applying a preset" becomes an assignment operation.

## Phasing

### Phase 1 — Data Layer + Context Injection
- Schema: `drydock_loadouts`, `dock_ships`, `crew_presets`, `crew_preset_members`, `custom_intents`
- CRUD service functions
- API endpoints
- System prompt injection of loadout state
- Tests

### Phase 2 — MVP UI (Static)
- Dock cards in grid layout
- Dropdown-based intent selection
- Dropdown-based ship assignment to rotation
- Simple crew preset builder (select officers from list)
- Active ship toggle
- Mobile responsive

### Phase 3 — Interactive UI (Drag & Drop)
- Drag ships between docks
- Drag officers into crew slots
- Visual conflict warnings
- Animations and transitions
- Sortable rotation order

### Phase 4 — Model Integration
- Model receives loadout context
- Tool-use: model can suggest loadout changes
- "Optimize my mining dock" → model proposes crew + ship swaps
- Confirmation flow before applying changes

## Consequences

### Positive
- Majel understands fleet **operations**, not just **inventory**
- "What crew should I use for dock 3?" becomes answerable
- First graphical UI — establishes patterns for future interactive features
- Standardized intents create a shared vocabulary between user and model

### Negative
- Largest feature scope yet — 6 new tables, ~20 API endpoints, full UI component
- First drag-and-drop UI — new technical territory for the project
- Crew presets overlap with existing crew_assignments — needs careful migration

### Risks
- UI complexity could outpace backend readiness
- Prompt size growth with full loadout enumeration
- Drag-and-drop cross-browser/mobile behavior is notoriously fiddly
- Scope creep: loadouts could absorb resource tracking, mission planning, etc.

## References

- ADR-007 (Fleet Management — parent feature, Phase A done)
- ADR-001 (Architecture — SQLite-first, modular services)
- ADR-003 (Epistemic Framework — model knows what it knows)
- STFC Drydock mechanics: 8 docks (A-H), Ops 1-80, 1 active ship per dock
