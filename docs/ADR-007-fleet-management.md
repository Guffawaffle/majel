# ADR-007: Fleet Management — Dry Dock, Crew Assignments, and Model-Writable Data

**Status:** Proposed  
**Date:** 2026-02-08  
**Authors:** Guff, Majel (Gemini advisor), Opie (Claude)

## Context

Majel currently ingests fleet data **read-only** from Google Sheets. The data flows one way:

```
Google Sheets → fetchFleetData() → FleetData → system prompt → Gemini context
```

This works for roster queries ("who are my officers?") but breaks down for **operational tracking** — the kind of questions an Admiral actually asks day-to-day:

- "Which ships are in dry dock and why?"
- "Move the Saladin to mining duty with Crew B"
- "What's my best crew for a combat mission right now?"
- "Put the D3 in maintenance — the warp core upgrade finishes Thursday"

These require **mutable state** that Sheets can't provide efficiently – and more importantly, they require the model to be able to **write back** when the Admiral gives orders.

### The Core Insight

The Admiral said it plainly: "It would be REALLY cool to get an interface right so the model can CRUD it AND the user can CRUD it."

This means Majel needs a local data layer that:
1. **Imports** baseline data from Sheets (officers, ships)
2. **Extends** it with operational state (assignments, statuses, roles)
3. **Exposes** CRUD operations via API
4. **Grants** the model tool-use access to those same operations
5. **Lets** the user manage it via UI as well

### Current Limitations

| Capability | Status |
|-----------|--------|
| View officer roster | ✅ Read from Sheets |
| View ship data | ✅ Read from Sheets |
| Track ship assignments | ❌ Not tracked |
| Track crew assignments | ❌ Not tracked |
| Ship status (active/docked) | ❌ Not tracked |
| Crew specializations (bridge/below-deck) | ❌ Not tracked |
| Model modifies fleet state | ❌ Read-only context injection |
| Historical assignment logs | ❌ Nothing persisted |

## Decision

### 1. The "Dry Dock" Category System

Ships need more than "active" or "not active." The real operational states:

| Status | Meaning |
|--------|---------|
| `deployed` | Actively on a mission (mining, combat, questing, etc.) |
| `ready` | Fully crewed, awaiting assignment |
| `maintenance` | Undergoing repairs or upgrades — estimated completion date |
| `training` | Dedicated to crew training rotations |
| `reserve` | Available but not prioritized — resource stockpile, backup |
| `awaiting-crew` | Ship is available but needs crew assignment |

Each ship carries:
- Current status (one of the above)
- Current role (mining, combat, exploring, hauling, etc.) — only meaningful when `deployed`
- Assigned bridge crew
- Assigned specialist crew (below-deck)
- Status notes (free text — "warp core upgrade ETA 2026-02-10")
- Last status change timestamp

### 2. Dynamic Crew Management

Officers have **dual roles** in STFC — their bridge position and their below-deck contribution. Majel needs to model both:

**Bridge Crew:** The primary command team on a ship. These are the officers actively running the vessel. Fixed slots (captain, bridge officers — game determines count).

**Specialist Crew (Below-Deck):** Officers whose abilities activate based on the ship's role. A mining specialist boosts yield even when not on the bridge. These are associated with a ship+role combination, not just the ship.

```
Ship: USS Saladin
  Status: deployed
  Role: mining (dilithium)
  Bridge Crew: [Kirk (captain), Spock, McCoy]
  Specialist Crew: [Scotty (mining yield +15%), Keenser (mining speed +8%)]
```

When the same ship switches to combat:
```
Ship: USS Saladin
  Status: deployed
  Role: combat (armada)
  Bridge Crew: [Kirk (captain), Spock, McCoy]
  Specialist Crew: [Uhura (shield boost +12%), Sulu (weapon calibration +10%)]
```

The bridge crew may stay, but specialist crew rotates by role.

### 3. Data Architecture — Local SQLite, Not Sheets

Fleet management state lives in **local SQLite**, not Google Sheets.

**Why not write back to Sheets?**
- Sheets API is rate-limited and slow for CRUD
- OAuth scope would need `spreadsheets` (read/write) instead of `spreadsheets.readonly`
- Sheets is a data *source*, not a *database* — row ordering, cell types, and multi-user edits make it unreliable for state management
- Local SQLite is instant, offline-capable, and already proven (settings store, Lex memory)

**Data flow becomes:**

```
Google Sheets ──import──▶ SQLite (fleet.db)
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
               API CRUD   Model Tools   UI
                    │         │         │
                    └─────────┼─────────┘
                              ▼
                     Gemini context
                    (query at prompt time)
```

Sheets remains the **import source** for baseline roster data. SQLite is the **operational database** where assignments, statuses, and crew configurations live.

### 4. Schema Design

```sql
-- Ships with operational status
CREATE TABLE ships (
  id TEXT PRIMARY KEY,          -- e.g. "uss-saladin"
  name TEXT NOT NULL,
  tier INTEGER,
  class TEXT,                   -- explorer, interceptor, battleship, survey
  status TEXT NOT NULL DEFAULT 'ready',
  role TEXT,                    -- mining, combat, exploring, hauling, etc.
  role_detail TEXT,             -- "dilithium", "armada", "away mission"
  notes TEXT,
  imported_from TEXT,           -- sheets tab this came from
  status_changed_at TEXT,       -- ISO 8601
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Officers with capabilities
CREATE TABLE officers (
  id TEXT PRIMARY KEY,          -- e.g. "kirk"
  name TEXT NOT NULL,
  rarity TEXT,                  -- common, uncommon, rare, epic, legendary
  level INTEGER,
  rank TEXT,
  group_name TEXT,              -- "command", "engineering", "science"
  imported_from TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Crew assignments — bridge and specialist
CREATE TABLE crew_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id TEXT NOT NULL REFERENCES ships(id),
  officer_id TEXT NOT NULL REFERENCES officers(id),
  role_type TEXT NOT NULL,      -- 'bridge' or 'specialist'
  slot TEXT,                    -- 'captain', 'bridge_1', 'specialist_1', etc.
  active_for_role TEXT,         -- NULL = always active, or 'mining', 'combat', etc.
  created_at TEXT NOT NULL,
  UNIQUE(ship_id, officer_id, role_type, active_for_role)
);

-- Assignment history for operational analysis
CREATE TABLE assignment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id TEXT,
  officer_id TEXT,
  action TEXT NOT NULL,         -- 'assigned', 'unassigned', 'status_change', 'role_change'
  detail TEXT,                  -- JSON: what changed
  timestamp TEXT NOT NULL
);
```

### 5. API Surface

Following the AX-first pattern (ADR-004), fleet management gets its own route group:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/fleet/ships` | List all ships with current status and crew |
| `GET` | `/api/fleet/ships/:id` | Single ship detail with full crew assignments |
| `POST` | `/api/fleet/ships` | Add a ship (or import triggers this) |
| `PATCH` | `/api/fleet/ships/:id` | Update ship status, role, notes |
| `GET` | `/api/fleet/officers` | List all officers with current assignments |
| `GET` | `/api/fleet/officers/:id` | Single officer detail |
| `POST` | `/api/fleet/officers` | Add an officer |
| `PATCH` | `/api/fleet/officers/:id` | Update officer data |
| `POST` | `/api/fleet/ships/:id/crew` | Assign officer to ship (bridge or specialist) |
| `DELETE` | `/api/fleet/ships/:id/crew/:officerId` | Remove officer from ship |
| `GET` | `/api/fleet/log` | Assignment history (filterable by ship/officer/action) |
| `POST` | `/api/fleet/import` | Re-import from Sheets, merge with existing state |

### 6. Model Tool-Use — Majel as Fleet Manager

This is the key differentiator. Gemini supports **function calling** (tool use). Instead of just reading fleet data in the prompt, Majel can **act on orders**:

```
Admiral: "Move the Saladin to mining duty with Kirk's crew"

Majel (internally):
  1. Call tool: updateShipStatus("uss-saladin", { status: "deployed", role: "mining" })
  2. Call tool: assignCrew("uss-saladin", "kirk", "bridge", "captain")
  3. Call tool: assignCrew("uss-saladin", "spock", "bridge", "bridge_1")
  4. Respond: "Acknowledged. USS Saladin is now deployed for mining operations.
     Bridge crew: Kirk (captain), Spock. Ready for departure."
```

**Tool definitions** registered with Gemini:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `listShips` | `status?`, `role?` | Query ships by filter |
| `getShip` | `shipId` | Get ship detail with crew |
| `updateShip` | `shipId`, `fields` | Change status, role, notes |
| `listOfficers` | `group?`, `available?` | Query officers |
| `assignCrew` | `shipId`, `officerId`, `roleType`, `slot?` | Put officer on ship |
| `removeCrew` | `shipId`, `officerId` | Remove officer from ship |
| `getFleetOverview` | — | Summary: ships by status, unassigned officers |

The model **proposes** actions, the system **executes** them, and the response confirms what happened. This is the same pattern as ChatGPT plugins or Claude computer-use — the model gets tools, not raw SQL.

**Safety:** The model can only use the defined tools. No raw DB access, no arbitrary writes. Each tool validates inputs and returns structured results. The assignment log captures who (or what) made each change.

### 7. Import Strategy — Sheets as Seed Data

The existing Sheets import (`fetchFleetData`) becomes a **seeding mechanism**:

1. On first run or `/api/fleet/import`: Fetch Sheets data → upsert into `ships` and `officers` tables
2. Merge logic: If a ship/officer already exists locally with modifications, **keep the local state** (assignments, status) and update only the imported fields (name, level, tier, etc.)
3. New entries in Sheets → auto-created locally with `ready` status
4. Entries removed from Sheets → **not** auto-deleted (flag as `imported_from: null` for review)

This preserves the "Sheets is the roster, Majel is the ops layer" separation.

### 8. UI — Fleet Dashboard

The UI needs a fleet management view alongside the chat. Design principles:

- **Ships grid/list** with status badges (color-coded by status)
- **Drag-and-drop** crew assignment (or simple select menus for MVP)
- **Quick actions:** Change status, switch role, reassign crew
- **Chat integration:** User can ask Majel to make changes ("dock the Saladin") and the UI updates live
- **History panel:** Recent assignment changes with timestamps

For v0.4 MVP: a basic table view with status dropdowns and crew assignment selects. Drag-and-drop and live chat-driven updates are v1.0 polish.

## Phasing

This is too large for one release. Proposed phases:

### Phase A — Data Layer (v0.4)
- SQLite schema (`fleet.db`) with ships, officers, crew_assignments, assignment_log
- Fleet data service with CRUD operations
- Sheets import → SQLite seeding
- API endpoints for ships and officers (CRUD)
- Tests for all CRUD operations and import merge logic

### Phase B — Crew Management (v0.4)
- Crew assignment endpoints
- Bridge vs. specialist crew distinction
- Assignment log recording
- Crew validation (officer can't be on two ships as bridge crew simultaneously)
- Fleet overview endpoint

### Phase C — Model Tool-Use (v0.5)
- Gemini function calling integration
- Tool definitions registered with model
- Confirmation flow (model proposes → system executes → response confirms)
- Prompt update: Majel knows she can manage fleet state, not just read it
- Assignment log records model-initiated changes distinctly

### Phase D — Fleet UI (v0.5)
- Ships list/grid with status and crew
- Crew assignment interface
- Status change controls
- Assignment history view
- Live updates when model makes changes

## Consequences

### Positive
- Majel becomes an **operational tool**, not just a query interface
- "Talk to your fleet" — natural language fleet management is the killer feature
- Local SQLite keeps everything fast, offline-capable, and private
- Sheets remains the import source — no workflow disruption
- Assignment log provides operational analytics
- Both human and AI can manage the same data through the same API

### Negative
- Significant new surface area — schema, API, service, UI, tool-use
- Schema migrations will be needed as the model evolves
- Model tool-use adds complexity to the Gemini integration (function calling, error handling)
- Officer/ship identification by natural language requires fuzzy matching

### Risks
- **Model reliability with tools:** Gemini function calling may misinterpret ambiguous orders. Mitigation: confirmation prompts for destructive actions and the epistemic framework (ADR-003) — Majel asks for clarification rather than guessing.
- **Data drift from Sheets:** If Sheets is edited and re-imported, merge conflicts are possible. Mitigation: import preserves local operational state, only updates roster fields.
- **Scope creep:** Fleet management could grow indefinitely (events, alliances, resource tracking). Mitigation: strict phasing, each phase delivers value independently.

## References

- ADR-001 (Architecture — local-first, SQLite precedent)
- ADR-003 (Epistemic Framework — model asks for clarification, doesn't guess)
- ADR-004 (AX-First API — consistent envelope, discovery)
- ADR-005 (v0.3 Hardening — prerequisite: session isolation, route split)
- ADR-006 (Open Alpha — versioning, shelved vs. shipped features)
- [Gemini Function Calling](https://ai.google.dev/gemini-api/docs/function-calling) — tool-use mechanism
