# ADR-010: Drydock Loadouts — Intent-Based Ship & Crew Rotation Management

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

This is the **drydock loadout** concept: each dock has **intents** (what it does), a **rotation** of ships that serve those intents, and each ship has **crew configurations** that change based on what the dock is doing.

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
- A **visual drydock board** that replaces the chat area when opened
- **Multi-select intent assignment** per dock from a reference data table
- **Ship rotation management** with user-toggled "active" state
- **Crew presets** — Majel's free equivalent of STFC's paid preset slots
- **BASIC vs ADVANCED** progressive disclosure
- Real-time model context injection of loadout state with calculated summaries

## Decisions (from Q&A)

Decisions locked in after initial design review:

### D1: Multi-intent = Multi-select from Reference Table
**Decision:** Docks support **multiple intents** via multi-select. The available intents come from a **reference data table** (`intent_catalog`) seeded with publicly available STFC activity types. Users can add custom intents.

**Rationale:** "Dock 3 does gas/crystal/ore" is natural — the dock just has three intents checked. No need for intent hierarchy; flat multi-select with categories for grouping in the UI.

### D2: Crew Conflicts — Warn but Allow
**Decision:** Officers **can** appear in presets across multiple docks. UI shows a yellow conflict badge. Model is told about conflicts so it can flag them when advising.

**Rationale:** Presets are aspirational — they're "what I'd LIKE to crew." In-game you can only crew one ship at a time per officer, but planning across docks requires the same officer to appear in multiple configurations. The warning helps the Admiral remember they can't literally run both simultaneously.

### D3: UI Location — Left Nav Tool, Replaces Chat Area
**Decision:** The left sidebar gets a new **drydock icon/tool**. Clicking it replaces the main chat content area with the drydock board. Clicking the chat icon returns to chat. Think of it as **view switching**, not a new route.

**Rationale:** The drydock board needs full width. It's too complex for a slide-out panel. But it's part of the same app, not a separate page — view switching keeps context close.

### D4: Active Ship = User-Managed Toggle
**Decision:** The "active" ship in each dock is a **user toggle**, not auto-detected. An **Active Ships slide-out** provides a quick overview:

```
⚓ ACTIVE SHIPS
  Dock 1: Kumari [★]
  Dock 2: ☐ Franklin  ☑ ECS Horizon
  Dock 3: ☑ Botany Bay  ☐ North Star
  Dock 4: ☐ (none assigned)
```

**Rationale:** Auto-detection from Sheets is fragile and adds coupling. The user knows what's in their dock right now. The slide-out gives a quick "cockpit view" without opening the full board.

### D5: Model Context — Calculated Summaries + Conflict Report
**Decision:** The model gets a **calculated summary** in the prompt, not raw table dumps. Prefer derived intelligence over raw data.

**Rationale:** "Calculated data > model-made-up data." The model should receive pre-computed facts it can cite directly, not raw rows it might miscount or hallucinate about.

### D6: Crew Presets — Separate Feature, Aligned with Docks
**Decision:** Crew presets are a **Majel feature** (free, unlimited) distinct from STFC's paid in-game preset slots. Presets are scoped to a **ship + intent combination**. The existing `crew_assignments` table stays for now as "live state"; presets are saved configurations.

**Decision:** Introduce **BASIC vs ADVANCED** mode concept:
- **BASIC:** Pick intents for docks, assign ships, see suggested crews (model training knowledge)
- **ADVANCED:** Build custom crew presets per ship per intent, manage officer conflicts, fine-tune rotation priority

This is Majel's first progressive disclosure pattern and should be reusable across future features.

## Design

### 1. Intent Catalog — Reference Data Table

The intent taxonomy lives in a **seeded SQLite table**, not hardcoded constants. This makes it queryable, extensible, and gives the model a formal vocabulary.

#### Schema

```sql
CREATE TABLE intent_catalog (
  key TEXT PRIMARY KEY,          -- e.g. "mining-gas"
  label TEXT NOT NULL,           -- "Gas Mining"
  category TEXT NOT NULL,        -- grouping: "mining", "combat", "utility", "custom"
  description TEXT,              -- "Collecting raw gas from nodes"
  icon TEXT,                     -- emoji or icon hint: "⛽"
  is_builtin INTEGER NOT NULL DEFAULT 1, -- 0 = user-created
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
```

#### Seed Data

| Key | Label | Category | Icon |
|-----|-------|----------|------|
| `mining-gas` | Gas Mining | mining | ⛽ |
| `mining-crystal` | Crystal Mining | mining | 💎 |
| `mining-ore` | Ore Mining | mining | ⛏️ |
| `mining-tri` | Tritanium Mining | mining | 🔩 |
| `mining-dil` | Dilithium Mining | mining | 🔮 |
| `mining-para` | Parasteel Mining | mining | 🛡️ |
| `mining-lat` | Latinum Mining | mining | 💰 |
| `mining-iso` | Isogen Mining | mining | ☢️ |
| `mining-data` | Data Mining | mining | 📊 |
| `grinding` | Hostile Grinding | combat | ⚔️ |
| `grinding-swarm` | Swarm Grinding | combat | 🐝 |
| `grinding-eclipse` | Eclipse Grinding | combat | 🌑 |
| `armada` | Armada | combat | 🎯 |
| `armada-solo` | Solo Armada | combat | 🎯 |
| `pvp` | PvP/Raiding | combat | 💀 |
| `base-defense` | Base Defense | combat | 🏰 |
| `exploration` | Exploration | utility | 🔭 |
| `cargo-run` | Cargo Run | utility | 📦 |
| `events` | Events | utility | 🎪 |
| `voyages` | Voyages | utility | 🚀 |
| `away-team` | Away Team | utility | 🖖 |

#### Extensibility Rules

- Built-in intents (`is_builtin = 1`) cannot be deleted, only hidden
- Users create custom intents (`is_builtin = 0`) with any key/label
- The model receives the full catalog so it can suggest appropriate intents
- Future: community-maintained intent packs imported via JSON

### 2. Data Model — Full Schema

#### New Tables

```sql
-- Reference catalog of available intents (seeded + user-extensible)
CREATE TABLE intent_catalog ( ... );  -- see above

-- What each drydock is configured to do
CREATE TABLE drydock_loadouts (
  dock_number INTEGER PRIMARY KEY,     -- 1-8, corresponds to drydock A-H
  label TEXT,                          -- user nickname: "My Grinder", "Mining 1"
  notes TEXT,                          -- freeform notes about this dock
  priority INTEGER NOT NULL DEFAULT 0, -- higher = more important dock
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Multi-select: which intents are assigned to which dock
CREATE TABLE dock_intents (
  dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
  intent_key TEXT NOT NULL REFERENCES intent_catalog(key),
  PRIMARY KEY (dock_number, intent_key)
);

-- Ships assigned to a dock rotation (multiple per dock, one active)
CREATE TABLE dock_ships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dock_number INTEGER NOT NULL REFERENCES drydock_loadouts(dock_number) ON DELETE CASCADE,
  ship_id TEXT NOT NULL REFERENCES ships(id),
  is_active INTEGER NOT NULL DEFAULT 0,  -- 1 = currently the one in the dock
  sort_order INTEGER NOT NULL DEFAULT 0, -- display order in rotation
  notes TEXT,                            -- "use when dilithium nodes are up"
  created_at TEXT NOT NULL,
  UNIQUE(dock_number, ship_id)
);

-- Saved crew configuration for a ship + intent combo
CREATE TABLE crew_presets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id TEXT NOT NULL REFERENCES ships(id),
  intent_key TEXT NOT NULL REFERENCES intent_catalog(key),
  preset_name TEXT NOT NULL,             -- "gas mining crew", "armada A crew"
  is_default INTEGER NOT NULL DEFAULT 0, -- auto-select when dock matches intent
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(ship_id, intent_key, preset_name)
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
```

#### Relationship Diagram

```
drydock_loadouts (1-8 docks)
    │
    ├── dock_intents ──▶ intent_catalog (multi-select N:M)
    │
    ├── dock_ships (N ships per dock, one is_active)
    │       │
    │       └── ships (existing table)
    │
    └── (via ships) crew_presets (N presets per ship × intent)
                        │
                        └── crew_preset_members (N officers per preset)
                                │
                                └── officers (existing table)
```

#### Interaction with Existing Tables

- `ships` and `officers` tables are **unchanged** — they remain the roster
- `crew_assignments` table is **kept** as "live state" (what's crewed right now)
- `crew_presets` are "saved configurations" — templates you can apply
- Future tool-use "apply preset" action will copy a preset into `crew_assignments`

### 3. Model Context — Calculated Intelligence

#### Design Principle: Calculated Data > Raw Data

Instead of dumping tables into the prompt, we compute a **structured briefing** that the model can cite directly. This follows the epistemic framework (ADR-003): the model states facts from fleet data, doesn't infer from ambiguous raw rows.

#### Context Structure

The model receives three tiers of loadout intelligence:

**Tier 1 — Dock Status Summary (always in prompt, ~300-500 bytes)**

```
DRYDOCK STATUS (4 active docks):
  D1 "Main Grinder" [grinding] → Kumari (active) | 1 ship in rotation
  D2 "Hostile Swapper" [grinding] → Franklin (active) | 2 ships in rotation
  D3 "Raw Mining" [mining-gas, mining-crystal, mining-ore] → Botany Bay (active) | 2 ships
  D4 "Refined Mining" [mining-tri, mining-dil, mining-para] → ECS Horizon (active) | 1 ship
```

**Tier 2 — Crew Assignment Summary (always in prompt, ~200-400 bytes)**

```
ACTIVE CREW:
  D1 Kumari: Kirk(cpt) · Spock · McCoy
  D2 Franklin: Cadet Uhura(cpt) · Cadet McCoy · T'Laan
  D3 Botany Bay: Stonn(cpt) · [varies by mining type — 2 presets]
  D4 ECS Horizon: Joaquin(cpt) · Khan · Carol

OFFICER CONFLICTS: Kirk [D1 grinding, D3 mining-ore preset], Spock [D1 grinding, D2 backup preset]
```

**Tier 3 — Computed Insights (always in prompt, ~100-300 bytes)**

```
FLEET NOTES:
- 2 of 4 docks assigned to grinding — consider diversifying if mining output is low
- D3 has 2 crew presets (gas, crystal) but no ore preset — ore mining uses default crew
- 3 officers have multi-dock conflicts (see OFFICER CONFLICTS above)
- D4 has no rotation — single point of failure for refined mining
```

**Total prompt addition: ~600-1200 bytes** — well under the concern threshold.

#### Why Not Tool-Calling for This?

For data this small, prompt injection beats on-demand tool-calling because:
- The model can **proactively reference** dock state without the user asking
- "Based on your D3 mining setup..." flows naturally in conversation
- Tool-calling adds latency and the model might forget to call the tool
- We cap at 8 docks × ~150 bytes each = 1.2KB worst case

Tool-calling becomes valuable later for **mutations** (ADR-007 Phase C), not reads.

### 4. Crew Presets — Majel's Free Alternative to Paid Slots

#### The Concept

In STFC, saving crew configurations costs real money (preset slots). Majel offers **unlimited free crew presets** as a planning tool outside the game.

A crew preset is: **"For this ship doing this intent, use these officers."**

```
Preset: "Botany Bay — Gas Mining Crew"
  Ship: Botany Bay
  Intent: mining-gas
  Bridge: Stonn (captain), T'Pring, Helvia
  Below-deck: (none configured)

Preset: "Botany Bay — Crystal Mining Crew"
  Ship: Botany Bay
  Intent: mining-crystal
  Bridge: Stonn (captain), Chen, Brenna
  Below-deck: (none configured)
```

When Botany Bay is active in Dock 3 and Dock 3's intent includes `mining-gas`, Majel knows the correct crew and can remind the Admiral.

#### BASIC vs ADVANCED Mode

This introduces Majel's first **progressive disclosure** pattern:

**BASIC mode (default):**
- Pick intents for your docks
- Assign ships to dock rotations
- Toggle which ship is active
- Majel **suggests crews** based on its training knowledge: "For gas mining with Botany Bay at your level, I'd recommend Stonn, T'Pring, and Helvia."
- No preset management — the model IS the preset
- Perfect for new/casual users who don't want to micromanage

**ADVANCED mode (opt-in via setting):**
- Everything in BASIC, plus:
- Build and save custom crew presets per ship per intent
- View officer conflict matrix
- Fine-tune rotation priority and notes
- Export/import presets
- The model reads your presets instead of suggesting its own

**Implementation:** A `system.uiMode` setting (`"basic"` | `"advanced"`) controls which UI elements render. The data layer supports both — in BASIC mode we just don't show the preset builder.

**Model behavior changes by mode:**
- BASIC: "For grinding with Kumari, I'd recommend Kirk, Spock, and McCoy based on their synergy bonuses."
- ADVANCED: "Your grinding preset for Kumari has Kirk, Spock, and McCoy. That's a solid choice — Kirk's captain bonus stacks well with Spock's science officer ability."

### 5. UI Experience — View Switching Architecture

#### Navigation Model

The left sidebar gains a **view switcher** — icons that control what's in the main content area:

```
┌───┬──────────────────────────────────────┐
│ 💬│  CHAT (current view)                  │
│   │  ... messages ...                    │
│ ⚓│                                      │
│   │                                      │
│ ⚙│                                      │
│   │  [Message Majel...]                  │
└───┴──────────────────────────────────────┘

Click ⚓:

┌───┬──────────────────────────────────────┐
│ 💬│  DRYDOCK LOADOUTS          [BASIC ▾] │
│   │                                      │
│ ⚓│  ┌─ DOCK 1 ──────┐ ┌─ DOCK 2 ─────┐ │
│   │  │ Main Grinder   │ │ Hostile Swap  │ │
│ ⚙│  │ ⚔️ grinding     │ │ ⚔️ grinding   │ │
│   │  │ ★ Kumari       │ │ ★ Franklin    │ │
│   │  │ Kirk·Spock·McCoy│ │ Uhura·McCoy  │ │
│   │  └────────────────┘ └───────────────┘ │
│   │  ┌─ DOCK 3 ──────┐ ┌─ DOCK 4 ─────┐ │
│   │  │ Raw Mining     │ │ Refined Mining │ │
│   │  │ ⛏️ gas,crys,ore │ │ ⛏️ tri,dil,para│ │
│   │  │ ★ Botany Bay   │ │ ★ ECS Horizon │ │
│   │  └────────────────┘ └───────────────┘ │
└───┴──────────────────────────────────────┘
```

#### Active Ships Slide-Out

A quick-access panel (similar to the fleet config panel on the right) showing just the active ship per dock with toggle:

```
⚓ ACTIVE SHIPS              [×]
─────────────────────────────
DOCK 1 — Main Grinder
  ★ Kumari

DOCK 2 — Hostile Swapper
  ○ Franklin
  ★ ECS Horizon        ← toggled active

DOCK 3 — Raw Mining
  ★ Botany Bay
  ○ North Star

DOCK 4 — Refined Mining
  ★ ECS Horizon
─────────────────────────────
```

This gives a quick "cockpit view" without leaving chat. Star = active, circle = in rotation but not active. Click to toggle.

#### Dock Card — Expanded View (ADVANCED)

Clicking a dock card expands it to full-width detail:

```
┌── DOCK 2: "Hostile Swapper" ─────────────────────── [Edit] [×] ──┐
│                                                                   │
│  INTENTS: [⚔️ grinding] [+ add intent]                            │
│                                                                   │
│  ROTATION:                                                        │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐ │
│  │ ★ U.S.S. Franklin          │  │   ECS Horizon               │ │
│  │ Rare · Survey               │  │ Common · Survey              │ │
│  │                             │  │                             │ │
│  │ Crew (grinding):            │  │ Crew (grinding):            │ │
│  │ 🎖 Cadet Uhura (cpt)        │  │ (no preset — Majel will     │ │
│  │ 👤 Cadet McCoy              │  │  suggest when activated)    │ │
│  │ 👤 T'Laan                   │  │                             │ │
│  │                             │  │ "use for lower level"       │ │
│  │ [Edit Crew] [Set Active]   │  │ [Add Crew] [Set Active]     │ │
│  └─────────────────────────────┘  └─────────────────────────────┘ │
│                                                                   │
│  [+ Add Ship to Rotation]                                         │
└───────────────────────────────────────────────────────────────────┘
```

### 6. API Surface

| Method | Path | Description |
|--------|------|-------------|
| **Intents** | | |
| `GET` | `/api/fleet/intents` | List all intents (catalog: builtin + custom) |
| `POST` | `/api/fleet/intents` | Create custom intent |
| `DELETE` | `/api/fleet/intents/:key` | Delete custom intent (builtin = error) |
| **Docks** | | |
| `GET` | `/api/fleet/docks` | List all dock loadouts with ships + crew summary |
| `GET` | `/api/fleet/docks/:num` | Single dock full detail |
| `PUT` | `/api/fleet/docks/:num` | Create or update dock loadout (label, notes, priority) |
| `DELETE` | `/api/fleet/docks/:num` | Clear a dock's loadout |
| `PUT` | `/api/fleet/docks/:num/intents` | Set dock's intents (full replace, array of keys) |
| `POST` | `/api/fleet/docks/:num/ships` | Add ship to dock rotation |
| `DELETE` | `/api/fleet/docks/:num/ships/:shipId` | Remove ship from dock |
| `PATCH` | `/api/fleet/docks/:num/ships/:shipId` | Update (set active, reorder, notes) |
| **Crew Presets** | | |
| `GET` | `/api/fleet/presets` | List all crew presets (filterable by ship, intent) |
| `GET` | `/api/fleet/presets/:id` | Single preset with members |
| `POST` | `/api/fleet/presets` | Create a crew preset (ship + intent + name) |
| `PATCH` | `/api/fleet/presets/:id` | Update preset (name, default status) |
| `DELETE` | `/api/fleet/presets/:id` | Delete a crew preset |
| `PUT` | `/api/fleet/presets/:id/members` | Set preset members (full replace, array of officers) |
| **Computed** | | |
| `GET` | `/api/fleet/docks/summary` | Computed briefing (what goes in the prompt) |
| `GET` | `/api/fleet/docks/conflicts` | Officer conflict report |

### 7. Context Builder — `buildDockBriefing()`

A new function computes the model's loadout context from the database:

```typescript
interface DockBriefing {
  /** Tier 1: one-line per dock */
  statusLines: string[];
  /** Tier 2: active crew per dock + conflicts */
  crewSummary: string[];
  conflictReport: string[];
  /** Tier 3: computed insights */
  insights: string[];
  /** Total character count for prompt budget tracking */
  totalChars: number;
}

function buildDockBriefing(fleetStore: FleetStore): DockBriefing;
```

The insights are computed, not generated by the model:
- "N of M docks assigned to [intent] — consider diversifying"
- "Dock N has no crew preset for [intent] — will rely on model suggestion"
- "N officers appear in presets for multiple docks"
- "Dock N has no rotation — single point of failure"

These give the model **facts to cite** rather than **data to interpret**.

## Phasing

### Phase 1 — Intent Catalog + Dock Data Layer
- `intent_catalog` table with seed data
- `drydock_loadouts`, `dock_intents`, `dock_ships` tables
- CRUD service for docks and intents
- API endpoints for docks + intents
- Tests
- **No UI, no presets yet**

### Phase 2 — Crew Presets
- `crew_presets`, `crew_preset_members` tables
- Preset CRUD service
- Conflict detection query
- API endpoints for presets
- `buildDockBriefing()` context builder
- Inject briefing into system prompt
- Tests

### Phase 3 — MVP UI (BASIC mode)
- Left sidebar view switcher (chat ↔ docks)
- Dock card grid (intent badges, active ship, crew summary)
- Dropdown-based intent multi-select
- Dropdown-based ship assignment
- Active ship toggle (radio)
- Active Ships slide-out panel
- Model suggests crews (no preset builder UI yet)
- Mobile responsive
- `system.uiMode` setting (default: basic)

### Phase 4 — ADVANCED Mode UI
- Crew preset builder (select officers into slots)
- Dock card expanded view with rotation detail
- Officer conflict badges
- Inline label editing
- Priority reordering (up/down arrows)

### Phase 5 — Interactive Polish (Drag & Drop)
- Drag ships between docks
- Drag officers into crew slots
- Sortable rotation order
- Animations and transitions
- Possible: Sortable.js (10KB) or vanilla HTML5 DnD

### Phase 6 — Model Tool Integration
- Model receives loadout context (already done in Phase 2)
- Function calling tools: suggest crew, optimize dock, swap ships
- Confirmation flow before applying changes
- Assignment log records model-initiated modifications

## Consequences

### Positive
- Majel understands fleet **operations**, not just **inventory**
- "What crew should I use for dock 3?" becomes answerable with calculated data
- First view-switching UI — establishes navigation patterns for future features
- Crew presets give users unlimited free crew configs (vs STFC's paid slots)
- BASIC/ADVANCED progressive disclosure is reusable across features
- Calculated briefing keeps prompt lean and factual

### Negative
- Largest feature scope yet — 6 new tables, ~20 API endpoints, full UI
- First view-switcher UI — new navigation paradigm to establish
- Crew presets overlap conceptually with existing crew_assignments
- BASIC/ADVANCED bifurcation adds conditional logic throughout

### Risks
- **UI complexity:** View switching is a bigger architectural shift than it sounds
- **Prompt budget:** Even with summaries, 8 fully-loaded docks add ~1.2KB to every prompt
- **Drag-and-drop (Phase 5):** Cross-browser/mobile DnD is notoriously fiddly
- **Scope creep:** Loadouts could absorb resource tracking, mission planning, etc.
- **Data freshness:** If the Admiral changes their dock in-game, Majel's record drifts until manually updated

## References

- ADR-007 (Fleet Management — parent feature, Phases A/B)
- ADR-001 (Architecture — SQLite-first, modular services)
- ADR-003 (Epistemic Framework — calculated data > model inference)
- ADR-006 (Open Alpha — versioning, progressive disclosure precedent)
- STFC Drydock mechanics: 8 docks (A-H), Ops 1-80, 1 active ship per dock
- STFC Ship classes: Battleship, Explorer, Interceptor, Survey
- STFC Crew system: bridge (3 slots) + below-deck (variable by ship)

---

## Pre-Flight Analysis — Footguns and Mesh Tensions

*Added 2026-02-08 after ADR review with Lex. This section documents structural risks
identified before execution begins. It's here so we never lose the "why" behind
the decisions we make or defer during implementation.*

### 1. ADR Numbering Collision

**Found:** Two files claim ADR-008:
- `ADR-008-image-interpretation.md` (Proposed — multimodal screenshots)
- `ADR-008-drydock-loadouts.md` (this file)

**Fix:** Renumber drydock loadouts to **ADR-010**. Image interpretation was written first and should keep 008. ADR-009 is structured logging (Accepted, already shipped).

**Why it matters:** ADR numbers are referenced in code comments, commit messages, and cross-references. A collision means citations are ambiguous.

### 2. index.ts is a 907-Line Monolith (ADR-005 Phase 2 Never Shipped)

**Found:** `src/server/index.ts` contains 30 route handlers, boot logic, shutdown, AppState, middleware, and all fleet CRUD routes — in one file. ADR-005 Phase 2 planned a route split that was never executed.

**Current state:**
| File | Lines | Responsibility |
|------|-------|----------------|
| `index.ts` | 907 | Everything |
| `fleet-store.ts` | 699 | Fleet data layer (well isolated) |
| `settings.ts` | 402 | Settings store (well isolated) |
| `gemini.ts` | 371 | Gemini engine (well isolated) |
| `app.js` | 948 | Client JS (growing) |
| `styles.css` | 1312 | All styles (single file) |

**Footgun:** ADR-008 adds ~20 new API endpoints. If we bolt them onto index.ts, it hits 1200+ lines — a single file containing 50 route handlers. This is the exact problem ADR-005 identified at 427 lines and now it's doubled.

**Decision:** Execute ADR-005 Phase 2 (route split) BEFORE adding dock endpoints. This is a prerequisite, not a nice-to-have. Extract fleet routes into `routes/fleet.ts`, dock routes go into `routes/docks.ts`. Boot and app factory stay in `index.ts`.

**Cost of deferring:** Every future feature makes the split harder. The fleet routes already have 17 handlers that all close over `appState` — they'll only get more entangled.

### 3. The crew_assignments vs crew_presets Overlap

**Found:** `fleet-store.ts` has a `crew_assignments` table (ADR-007) with `role_type`, `slot`, and `active_for_role` columns. ADR-008 introduces `crew_presets` + `crew_preset_members` with nearly identical structure (`role_type`, `slot`).

**The tension:**
- `crew_assignments` = "what IS crewed right now" (live state)
- `crew_presets` = "what I WANT to crew for this intent" (saved config)

They model the same thing (officers on a ship) at different levels of commitment. But:
- No officer is "actually" crewed right now — STFC is the source of truth for live state
- `crew_assignments` has no first-class consumer yet (no UI, no model tool-use)
- The ADR-007 `assignCrew` / `unassignCrew` API exists but nothing calls it from the frontend

**Footgun:** If we build presets AND keep assignments, we'll have two parallel systems for putting officers on ships, with subtle differences, and the user (and model) have to understand which is which.

**Decision:** Crew presets ARE the assignment system for now. The existing `crew_assignments` table stays in the schema (no destructive migration), but we don't build new features against it. Presets subsume its purpose. When tool-use lands (ADR-007 Phase C), "apply preset" copies a preset into live state — that's when `crew_assignments` gets its consumer.

**Document this in code:** Add a schema comment: `-- crew_assignments: reserved for future live-state tracking (ADR-007 Phase C). Active development uses crew_presets (ADR-010).`

### 4. AX Envelope Debt (ADR-004)

**Found:** ADR-004 specifies a consistent response envelope (`{ ok, data, meta }` / `{ ok, error }`). Current fleet routes return raw objects — no envelope, no error codes, no request IDs.

**Example (current):**
```javascript
// GET /api/fleet/ships
res.json(ships);  // raw array, no envelope
```

**ADR-004 specifies:**
```javascript
res.json({ ok: true, data: ships, meta: { timestamp: ... } });
```

**Footgun:** If dock endpoints use the envelope but fleet endpoints don't, the API is internally inconsistent. The frontend has to handle both shapes. The model can't predict response format.

**Decision:** This is not a blocker for ADR-008, but it IS debt that compounds. When we do the route split (footgun #2), we should add an envelope wrapper middleware. This is a one-time cost that benefits all routes.

### 5. Single-File Client (app.js = 948 Lines)

**Found:** All client JavaScript is in one `app.js` file. It handles chat, sessions, settings, fleet config panel, and DOM management. ADR-008 Phase 3 adds a full drydock board UI with view switching, dock cards, ship management, and crew builders.

**Footgun:** Adding a drydock view to a 948-line file will push it past 1500+ lines. Client-side view switching (chat ↔ docks) in a single file means interleaved state management, growing initialization functions, and fragile event handler cleanup.

**Decision:** Before or during Phase 3 (MVP UI), split the client:
- `app.js` → thin shell: init, view router, shared utilities
- `chat.js` → chat view logic
- `docks.js` → drydock board logic
- `fleet-config.js` → fleet config panel

This mirrors the server-side route split. The HTML can load multiple `<script>` tags or we add a minimal bundler step.

**Note:** This is a Phase 3 concern, not Phase 1. The data layer doesn't touch the client.

### 6. fleet.db Schema Migration Story

**Found:** The current `createFleetStore()` uses `CREATE TABLE IF NOT EXISTS` — it works for first run but has no migration mechanism. ADR-008 adds 5-6 new tables to the same database.

**Footgun:** If we add new tables with the same `IF NOT EXISTS` pattern, it works initially. But if we later need to ALTER existing tables (add columns, change constraints), there's no migration runner. SQLite doesn't support `ALTER TABLE DROP COLUMN` (until 3.35.0, and not for all cases).

**Decision:** For Phase 1, `IF NOT EXISTS` is fine — new tables won't conflict. But we should add a `schema_version` table and a basic migration check:
```sql
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```
This doesn't need a full migration framework — just a version number we check at boot and a set of upgrade functions. This is cheap insurance.

### 7. Prompt Token Budget Pressure

**Found:** Current system prompt structure:
- Layer 1 (identity + epistemic): ~2,500 chars
- Layer 2 (capabilities): ~1,000 chars
- Layer 2b (fleet config): ~300 chars
- Layer 3 (fleet data): variable, up to ~20KB for full roster

ADR-008 adds a dock briefing (~600-1200 chars). Total prompt could reach 25KB+.

**At Flash-Lite rates:** 25KB ≈ ~6,250 tokens. At $0.075/1M tokens input, that's ~$0.0005 per message. Even at 100 messages/day, that's $0.05/day. **Not a cost concern.**

**But it IS a context concern.** Flash-Lite has a 1M token window, but model quality degrades with very long prompts — the "lost in the middle" problem. The roster data (up to 20KB of CSV) is the biggest contributor, not the dock briefing.

**Decision:** The dock briefing's 3-tier summary design (already in the ADR) is the right approach. No action needed here — just confirming the design holds up under scrutiny.

### 8. The 4+D Mesh — Understanding the Dimension Problem

The Admiral called it: this is becoming 4+D. Let's name the dimensions:

| Dimension | What | Example |
|-----------|------|---------|
| **Dock** | Physical slot (1-8) | "Dock 3" |
| **Intent** | What the dock does (N:M) | "mining-gas, mining-crystal" |
| **Ship** | What's in the dock (rotation) | "Botany Bay (active), North Star" |
| **Crew** | Who operates the ship for an intent | "Stonn, T'Pring, Helvia" for gas mining |
| **Time** | When (active now vs saved config) | "active" vs "preset" vs "historical" |

A single query like "What's my best mining setup?" traverses ALL dimensions:
1. Which docks have mining intents?
2. What ships are in those docks?
3. What crew presets exist for those ships + mining intents?
4. Which of those is active right now?
5. Are there officer conflicts with other docks?

**Footgun:** If we're not careful about the query layer, the model context builder will need N+1 queries, or we'll denormalize prematurely, or the API will expose the dimension mesh poorly.

**Decision:** The data service should expose **composed queries** — not just CRUD per table. Key composed queries:
- `getDockWithFullContext(dockNum)` → dock + intents + ships + active crew presets
- `getOfficerConflicts()` → officers appearing in presets across multiple docks
- `getDockBriefing()` → the 3-tier computed summary for the model

Phase 1 builds the tables. Phase 2 builds these composed queries alongside crew presets.

### 9. BASIC Mode Could Be Hollow

**Found:** BASIC mode says "Majel suggests crews based on training knowledge." But the model's crew suggestions are based on:
- Training knowledge of STFC crew synergies (may be outdated)
- The officer roster (from Sheets import)
- The dock's intent

**Footgun:** If BASIC mode doesn't build presets, the model has to suggest crews fresh every time. There's no persistence — ask the same question twice, possibly get different answers. The model might suggest officers the Admiral doesn't own.

**Decision:** Even in BASIC mode, when the model suggests a crew, we should consider letting the user "pin" it (save as a preset behind the scenes). This bridges BASIC → ADVANCED naturally: "Majel suggested Kirk/Spock/McCoy for your grinder. Pin this crew? [Yes]" → silently creates a preset.

This is a Phase 3-4 concern. But it's worth noting in the ADR so we don't design BASIC mode as purely ephemeral.

### Summary: Execution Prerequisites

Before ADR-008 Phase 1 execution:

| # | Action | Priority | Blocks |
|---|--------|----------|--------|
| 1 | Renumber this ADR to 010 | Must | Everything (citation clarity) |
| 2 | Route split (ADR-005 Phase 2) | Should | Phase 1 (prevents 1200-line index.ts) |
| 3 | Schema version table | Should | Phase 1 (future migration safety) |
| 4 | Document crew_assignments freeze | Must | Phase 2 (prevents parallel development) |

Items 1 and 4 are cheap (minutes). Items 2 and 3 are moderate (hours) but prevent real pain later.
