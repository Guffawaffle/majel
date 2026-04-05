# ADR-022 — Loadout Architecture: Task-First Fleet Management

**Status:** Accepted  
**Date:** 2026-02-12  
**Authors:** Guff, Opie (Claude), with input from Gemini  
**Supersedes:** ADR-010 (Drydock Loadouts — dock-centric hierarchy)  
**References:** ADR-010 (prior art), ADR-003 (Epistemic Framework), ADR-007 (Fleet Management), ADR-012 (Reference Data), ADR-021 (PostgresFrameStore/RLS)

---

## Context

ADR-010 modeled fleet operations as a **dock-centric hierarchy**: docks contain ships, ships have crew presets, and intents are assigned to docks. This mirrored STFC's physical drydock UI and worked for planning at Ops 20-25.

At Ops 29+ with 4 docks, 10+ viable ships, 30+ officers, daily mining rotations, hostile grinding, Borg loops, armada duty, and now **away teams**, the dock-first model breaks down:

1. **The Admiral doesn't think in docks.** The mental model is: "I have a Borg loop (Vi'Dar + 5-of-11 crew). I have a grinding combo (Kumari + Kirk/Spock/McCoy). Put them somewhere." The dock is a resource to fill, not the organizing concept.

2. **Intent is welded to the wrong entity.** In ADR-010, intents attach to docks (`dock_intents`). But "mining-gas" isn't a property of Dock 3 — it's a property of what the Admiral wants to accomplish. If the Admiral swaps their gas mining from Dock 3 to Dock 4, the intent should move with the task, not stay behind on the old dock.

3. **The same crew combo serves multiple intents.** Kirk/Spock/McCoy on Kumari is good for grinding AND solo armada AND PvP. In ADR-010's schema, `crew_presets` has `UNIQUE(ship_id, intent_key, preset_name)` — the same officers on the same ship for different intents are three separate records. That's data duplication masquerading as structure.

4. **Away teams don't fit.** Away teams consume officers but zero docks. ADR-010 has no concept for this. The Admiral's daily routine includes "run crit mining away team" which competes for the same officers as dock loadouts, but the dock-first model can't represent it.

5. **Desired state ≠ running state.** The Admiral might have 6 loadouts they want active but only 4 docks. ADR-010 conflates "what I've configured" with "what's running" because the dock IS the container for both.

### The Insight

This was articulated in a design session on 2026-02-12:

> *"At Level 20 you played by managing Inventory (I have this dock, what do I put in it?). At Level 30+ you're playing by managing Intent (I have this goal, how do I resource it?)."*

The architecture needs **Inversion of Control**: the task defines what it needs; docks are just execution slots.

---

## Decision

### D1 — The Loadout is the primary entity

A **Loadout** is a named Ship + Crew configuration. It exists independently of any dock, intent, or plan. It answers: *"When I use Ship X, what crew do I run?"*

```
Loadout: "Borg Loop"
  Ship: Vi'Dar
  Crew: 5-of-11 (captain), 7-of-11, 8-of-11
  Tags: [borg, daily]
  Suitable intents: [grinding-eclipse]
```

Loadouts are the Admiral's **building blocks**. They are stable configurations that get composed into plans.

Key change from ADR-010: intent is NOT part of the loadout identity. A loadout's suitability for intents is expressed via tags and a JSONB `intent_keys` array, not a unique constraint. The same crew on the same ship is ONE loadout that can serve multiple purposes.

### D2 — The Plan is the scheduling layer

A **Plan** represents what the Admiral wants to run. It maps loadouts to objectives and assigns them to resources (docks or away team slots).

```
Today's Plan:
  1. [P1] Grind hostiles → "Kumari Punch" → Dock 1
  2. [P2] Mine gas overnight → "BB Gas" → Dock 3
  3. [P3] Borg daily → "Borg Loop" → Dock 2
  4. [P4] Mine crystal → "North Star Crystal" → Dock 4
  5. [P5] Crit mining away → [T'Pring, Helvia, Joaquin] → Away Team
```

Plan items replace the `dock_ships.is_active` concept. A loadout is "active" because the plan says so, not because a dock toggle says so.

Away teams are plan items with `dock_number = NULL`. They consume officers, not dock slots.

### D3 — Docks become resource slots, not containers

The `docks` table retains metadata (label, notes) but loses all child relationships. A dock doesn't "have" ships or intents — it hosts whatever the plan assigns to it.

This means:
- No more `dock_intents` join table (intent lives on the plan item)
- No more `dock_ships` join table (ship lives on the loadout, assignment lives on the plan)
- Dock CRUD is trivial — just metadata for the physical slots

### D4 — The Intent Catalog stays as vocabulary

`intent_catalog` is reference data — a taxonomy of STFC activities. It survives as-is. Intents are used as:
- Tags on loadouts (what this loadout is good for)
- Objective labels on plan items (what I'm trying to accomplish)
- Model vocabulary (the model can reference formal intent names)

But intents carry no requirements. The model knows "mining-gas needs a survey ship" from its training data. We don't encode game mechanics in our schema — that's unbounded work that breaks on every game patch.

### D5 — Officer conflicts are warnings, not blocks

Same decision as ADR-010 D2, extended to plans: an officer appearing in multiple active plan items triggers a warning, not a hard error. The Admiral knows they can't crew two ships simultaneously in-game, but they need to plan rotations that reuse officers across time slots.

The conflict report becomes more useful in the plan model: "T'Pring is assigned to both Plan #2 (BB Gas, Dock 3) and Plan #5 (Crit Mining Away Team)."

### D6 — No solver in v1

The plan is manually constructed by the Admiral (with model assistance). The system does NOT auto-assign loadouts to docks. What it DOES do:

- **Validate:** "This plan needs 5 docks but you have 4."
- **Warn:** "Officer X is double-booked between plan items #2 and #5."
- **Suggest:** The model can recommend: "Based on your objectives, consider swapping Dock 2 to the Borg loop after your grind finishes."

The automated solver (constraint satisfaction → optimal assignment) is a future phase. The inversion is valuable even without it because it correctly models the Admiral's mental model.

### D7 — Layers are independently functional

Each layer works without the layers above it:

| Layer | Works alone? | Depends on |
|---|---|---|
| L0: Reference data (ships, officers, intents) | Yes — just a roster | Nothing |
| L1: Player state (what you own) | Yes — fleet inventory | Reference data for details |
| L2: Loadouts (ship + crew configs) | Yes — saved team configs | Player state for validation |
| L3: Plans (what you're running) | Yes — with manual dock picks | Loadouts to assign |
| L4: Solver (auto-assignment) | Optional — plans work without it | Everything |

This means we can build and ship each layer incrementally. Loadouts are useful without plans. Plans are useful without a solver. Each layer adds capability without requiring the next.

### D8 — ADR-010 code is replaced, not refactored

The existing dock-store implementation (681 lines, 7 tables, 27 API routes, 92 tests, 850-line client) is **replaced** with purpose-built loadout-first code. We do not refactor in place — the hierarchy change touches every query, every route, every test.

Files to replace:
- `src/server/dock-store.ts` → `src/server/loadout-store.ts`
- `src/server/dock-briefing.ts` → `src/server/plan-briefing.ts`
- `src/server/routes/docks.ts` → `src/server/routes/loadouts.ts` + simplified `routes/docks.ts`
- `src/client/drydock.js` → `src/client/loadouts.js` (Phase 3+)
- `test/dock-store.test.ts` → `test/loadout-store.test.ts`

Intent catalog seed data and CRUD survive as-is. Reference data tables (`reference_ships`, `reference_officers`) are untouched.

---

## Schema

### Tables kept as-is

```sql
-- From ADR-012 (reference-store.ts) — untouched
-- reference_ships, reference_officers

-- From ADR-010 — kept as-is, it's vocabulary
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
-- 21 seed intents (mining-gas, grinding, armada, etc.)
```

### New tables

```sql
-- ═══════════════════════════════════════════════════════
-- L2: Loadouts — the primary entity
-- ═══════════════════════════════════════════════════════

-- A named Ship + Crew configuration
CREATE TABLE loadouts (
  id SERIAL PRIMARY KEY,
  ship_id TEXT NOT NULL REFERENCES reference_ships(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                              -- "Borg Loop", "Punch Up", "BB Gas"
  priority INTEGER NOT NULL DEFAULT 0,             -- higher = prefer scheduling first
  is_active BOOLEAN NOT NULL DEFAULT TRUE,         -- does the Admiral want this available?
  intent_keys JSONB NOT NULL DEFAULT '[]',         -- intent_catalog keys this loadout suits
  tags JSONB NOT NULL DEFAULT '[]',                -- freeform user tags
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(ship_id, name)
);

CREATE INDEX idx_loadouts_ship ON loadouts(ship_id);
CREATE INDEX idx_loadouts_intent ON loadouts USING GIN (intent_keys);
CREATE INDEX idx_loadouts_tags ON loadouts USING GIN (tags);
CREATE INDEX idx_loadouts_priority ON loadouts(priority DESC);

-- Officers assigned to a loadout
CREATE TABLE loadout_members (
  id SERIAL PRIMARY KEY,
  loadout_id INTEGER NOT NULL REFERENCES loadouts(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
  role_type TEXT NOT NULL CHECK (role_type IN ('bridge', 'below_deck')),
  slot TEXT,                                       -- 'captain', 'officer_1', 'officer_2', 'belowdeck_1', ...
  UNIQUE(loadout_id, officer_id)
);

CREATE INDEX idx_loadout_members_officer ON loadout_members(officer_id);
CREATE INDEX idx_loadout_members_loadout ON loadout_members(loadout_id);

-- ═══════════════════════════════════════════════════════
-- L3: Docks — resource slots (metadata only)
-- ═══════════════════════════════════════════════════════

CREATE TABLE docks (
  dock_number INTEGER PRIMARY KEY CHECK (dock_number >= 1),
  label TEXT,                                      -- user nickname: "Main Grinder"
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════
-- L3: Plan Items — what the Admiral is running
-- ═══════════════════════════════════════════════════════

-- Each row is one assignment: an objective + a loadout/officers + a resource
CREATE TABLE plan_items (
  id SERIAL PRIMARY KEY,
  intent_key TEXT REFERENCES intent_catalog(key) ON DELETE SET NULL,  -- what objective
  label TEXT,                                      -- display name ("Daily Grind", "Overnight Gas")
  loadout_id INTEGER REFERENCES loadouts(id) ON DELETE SET NULL,     -- which loadout (NULL for away teams)
  dock_number INTEGER REFERENCES docks(dock_number) ON DELETE SET NULL, -- which dock (NULL for away teams)
  priority INTEGER NOT NULL DEFAULT 0,             -- scheduling priority
  is_active BOOLEAN NOT NULL DEFAULT TRUE,         -- currently running?
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_plan_items_loadout ON plan_items(loadout_id);
CREATE INDEX idx_plan_items_dock ON plan_items(dock_number);
CREATE INDEX idx_plan_items_intent ON plan_items(intent_key);
CREATE INDEX idx_plan_items_active ON plan_items(is_active) WHERE is_active = TRUE;

-- Away team members (plan items where loadout_id IS NULL)
-- These reserve officers without a ship or dock
CREATE TABLE plan_away_members (
  id SERIAL PRIMARY KEY,
  plan_item_id INTEGER NOT NULL REFERENCES plan_items(id) ON DELETE CASCADE,
  officer_id TEXT NOT NULL REFERENCES reference_officers(id) ON DELETE CASCADE,
  UNIQUE(plan_item_id, officer_id)
);

CREATE INDEX idx_plan_away_members_officer ON plan_away_members(officer_id);
```

### Tables deleted

```sql
-- These are REPLACED — they encode the dock-first hierarchy
DROP TABLE IF EXISTS preset_tags;           -- absorbed into loadouts.tags JSONB
DROP TABLE IF EXISTS crew_preset_members;   -- replaced by loadout_members
DROP TABLE IF EXISTS crew_presets;          -- replaced by loadouts
DROP TABLE IF EXISTS dock_ships;            -- replaced by plan_items.loadout_id + dock_number
DROP TABLE IF EXISTS dock_intents;          -- replaced by plan_items.intent_key + loadouts.intent_keys
DROP TABLE IF EXISTS drydock_loadouts;      -- replaced by docks (simplified)
```

### Entity Relationship

```
reference_ships        reference_officers        intent_catalog
      │                      │                        │
      └──► loadouts ◄────── loadout_members           │
              │                                       │
              └──────────► plan_items ◄───────────────┘
                              │  │
                              │  └──► docks (nullable — away teams have none)
                              │
                              └──► plan_away_members ──► reference_officers
                                   (only when loadout_id IS NULL)
```

---

## API Surface

### Loadouts (`/api/loadouts/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/loadouts` | List loadouts (filter: `?shipId=`, `?intentKey=`, `?tag=`, `?active=`) |
| `GET` | `/api/loadouts/:id` | Single loadout with members |
| `POST` | `/api/loadouts` | Create loadout (ship + name + optional crew) |
| `PATCH` | `/api/loadouts/:id` | Update loadout metadata (name, priority, active, notes, intents, tags) |
| `DELETE` | `/api/loadouts/:id` | Delete loadout (cascades members, nullifies plan refs) |
| `PUT` | `/api/loadouts/:id/members` | Set crew members (full replace) |
| `GET` | `/api/loadouts/conflicts` | Officer conflict report across active loadouts |

### Docks (`/api/docks/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/docks` | List docks with current plan item assignments |
| `GET` | `/api/docks/:num` | Single dock with current assignment |
| `PUT` | `/api/docks/:num` | Create/update dock metadata (label, notes) |
| `DELETE` | `/api/docks/:num` | Delete dock (nullifies plan item dock refs) |

### Plan (`/api/plan/`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/plan` | List all plan items with resolved loadout + dock info |
| `GET` | `/api/plan/:id` | Single plan item with full context |
| `POST` | `/api/plan` | Create plan item (intent + loadout + dock assignment) |
| `PATCH` | `/api/plan/:id` | Update plan item (reassign dock, change loadout, toggle active) |
| `DELETE` | `/api/plan/:id` | Remove plan item |
| `PUT` | `/api/plan/:id/away-members` | Set away team officers (for dock-less plan items) |
| `GET` | `/api/plan/validate` | Validate current plan (dock conflicts, officer conflicts, missing assignments) |
| `GET` | `/api/plan/briefing` | Computed 3-tier briefing for model context |

### Intents (`/api/intents/`) — unchanged from ADR-010

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/intents` | List all intents |
| `POST` | `/api/intents` | Create custom intent |
| `DELETE` | `/api/intents/:key` | Delete custom intent |

**Total: ~22 endpoints** (down from 27 in ADR-010, despite adding the plan layer).

---

## Model Context — Plan Briefing

The briefing builder computes a 3-tier summary from the plan, replacing ADR-010's dock-centric briefing:

**Tier 1 — Active Plan Summary (~300-500 bytes)**
```
ACTIVE PLAN (4 dock items, 1 away team):
  D1 "Daily Grind" → Kumari (Kumari Punch loadout) [grinding]
  D2 "Borg Daily" → Vi'Dar (Borg Loop loadout) [grinding-eclipse]
  D3 "Gas Mining" → Botany Bay (BB Gas loadout) [mining-gas]
  D4 "Crystal Mining" → North Star (NS Crystal loadout) [mining-crystal]
  AWAY "Crit Mining" → T'Pring, Helvia, Joaquin
```

**Tier 2 — Crew Detail + Conflicts (~200-400 bytes)**
```
CREW:
  D1 Kumari: Kirk(cpt) · Spock · McCoy
  D2 Vi'Dar: 5-of-11(cpt) · 7-of-11 · 8-of-11
  D3 Botany Bay: Stonn(cpt) · T'Pring · Helvia
  D4 North Star: Chen(cpt) · Brenna · Arjun
  AWAY: T'Pring, Helvia, Joaquin

CONFLICTS: T'Pring [D3 + AWAY], Helvia [D3 + AWAY]
```

**Tier 3 — Insights (~100-300 bytes)**
```
PLAN NOTES:
- 2 officers double-booked between D3 mining and crit mining away team
- 3 loadouts not assigned to any plan item (Cadet Crew, D'Vor Patrol, Armada B)
- No plan item for mining-dilithium or mining-tritanium
```

---

## What Survives from ADR-010

| ADR-010 Component | Verdict | Notes |
|---|---|---|
| `intent_catalog` table + 21 seeds | **Survives as-is** | Reference vocabulary |
| Intent CRUD (3 endpoints) | **Survives** | Route path changes from `/api/dock/intents` to `/api/intents` |
| `drydock_loadouts` table | **Replaced** by `docks` (simpler, metadata only) | |
| `dock_intents` table | **Deleted** | Intent moves to plan items + loadout tags |
| `dock_ships` table | **Deleted** | Ship lives on loadout, assignment on plan item |
| `crew_presets` table | **Replaced** by `loadouts` (promoted, intent decoupled) | |
| `crew_preset_members` table | **Replaced** by `loadout_members` (structurally similar) | |
| `preset_tags` table | **Deleted** | Absorbed into `loadouts.tags` JSONB |
| BASIC/ADVANCED mode concept | **Survives** | BASIC = model suggests loadouts; ADVANCED = manual crew building |
| `buildDockBriefing()` | **Replaced** by plan-centric briefing | Same 3-tier structure, different data source |
| `getOfficerConflicts()` | **Survives, expanded** | Now covers plan items + away teams too |
| `findPresetsForDock()` | **Replaced** | Inverts to "which loadouts could serve this plan item" |
| `drydock.js` (850 lines) | **Full rewrite** | Loadout-first UI, plan builder view |
| `dock-store.test.ts` (92 tests) | **Full rewrite** | Same thoroughness, new schema |

---

## Phasing

### Phase 1 — Loadout Store (data layer)

Replace the dock-centric data layer with loadout-first tables and store:

- Drop ADR-010 tables (7 tables)
- Create new tables: `loadouts`, `loadout_members`, `docks`, `plan_items`, `plan_away_members`
- `intent_catalog` kept (with seed data migration)
- `LoadoutStore` — CRUD for loadouts, members, docks, plan items, away members
- Officer conflict detection across loadouts and plan away members
- Plan validation (dock over-assignment, officer double-booking)
- Tests: target 90+ integration tests matching dock-store.test.ts coverage
- **No UI, no briefing builder yet**

Deliverables:
- `src/server/loadout-store.ts` (new)
- `test/loadout-store.test.ts` (new)
- Delete `src/server/dock-store.ts`
- Delete `test/dock-store.test.ts`

### Phase 2 — API + Briefing

Wire the store to HTTP endpoints and build the plan briefing:

- `src/server/routes/loadouts.ts` — loadout + plan + dock endpoints (~22 routes)
- `src/server/plan-briefing.ts` — 3-tier computed briefing for model context
- Inject briefing into system prompt (replaces dock briefing injection)
- Route-level tests with supertest
- Delete `src/server/routes/docks.ts`
- Delete `src/server/dock-briefing.ts`

### Phase 3 — Client Rewrite (BASIC mode)

Replace dock-tab UI with loadout-first views:

- **Loadouts view** — card grid of saved loadouts (ship + crew + tags)
- **Plan view** — active plan items with dock/away assignment
- **Dock status** — read-only "what's in each dock" derived from plan
- Left nav view switcher: Chat ↔ Loadouts ↔ Plan
- Model crew suggestions in BASIC mode
- Delete `src/client/drydock.js`
- New `src/client/loadouts.js`

### Phase 4 — ADVANCED Mode + Polish

- Manual crew preset builder (officer slot assignment)
- Officer conflict matrix
- Drag-and-drop plan item ↔ dock assignment
- Loadout priority reordering
- Plan item bulk operations ("clear all dock assignments", "deactivate all mining")

### Phase 5 — Solver (future)

- Constraint satisfaction: given active loadouts + objectives + available docks → optimal assignment
- Greedy priority queue as v1 algorithm
- Solver produces explanations, not just assignments: "Dropped Borg loop (P3) to fit 3 mining rotations"
- Confirmation UX before applying solver output

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Rewrite scope (7 tables, 27 routes, 850-line client) | 5-8 day effort | Phase incrementally; store first, then API, then UI |
| New mental model for users | Confusion if expecting dock-tab UI | BASIC mode hides complexity; dock view still exists as read-only status |
| Plan staleness | Stale plans mislead the model | Model asks "still running yesterday's plan?" on session start; plan items can auto-expire |
| Solver complexity (Phase 5) | Constraint satisfaction is hard | Defer solver; manual assignment works for v1. The inversion is valuable even without it |
| Officer conflict UX | Warnings are annoying if too frequent | Tier conflicts by severity: same-time vs rotation vs theoretical overlap |
| Game mechanic drift | STFC patches change what's optimal | The model handles game knowledge, not the schema. Loadouts are user-authored, not game-encoded |

---

## Consequences

### Positive
- **Matches the Admiral's actual mental model** — tasks first, docks second
- **Away teams are first-class** — same plan items, zero-dock resource consumption
- **Single loadout serves multiple intents** — no data duplication for Kirk/Spock/McCoy across grinding/armada/PvP
- **Desired state vs running state are separated** — loadouts survive independently of what's currently in a dock
- **Each layer is independently useful** — can ship loadouts before plans, plans before solver
- **Fewer tables** — 5 tables (+ intent_catalog) vs 7 in ADR-010, despite adding the plan layer
- **Fewer endpoints** — 22 vs 27, cleaner API surface

### Negative
- **Full rewrite of ADR-010 implementation** — 681-line store, 427-line routes, 1629-line tests, 850-line client
- **New navigation paradigm** — loadout-first is unfamiliar vs dock-tab
- **Plan is a new concept** — users must understand loadouts AND plans (BASIC mode mitigates)
- **No automated scheduling in v1** — manual assignment until solver is built

---

## References

- ADR-010 (Drydock Loadouts) — prior art, now superseded
- ADR-003 (Epistemic Framework) — calculated data > model inference
- ADR-007 (Fleet Management) — fleet config parent feature
- ADR-012 (Reference Data) — ships/officers source of truth
- ADR-021 (PostgresFrameStore) — RLS patterns reusable for multi-tenant loadouts if needed
- Design session 2026-02-12 — "Inversion of Control" insight (Guff + Gemini + Opie)
