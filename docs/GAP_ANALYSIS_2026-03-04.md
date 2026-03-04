# Gap Analysis — Full-Scale STFC AI Computer

> **Date:** 2026-03-04  
> **Context:** Strategic feature audit against the vision: "an STFC AI computer like on the show, with as much knowledge as possible and admitting where gaps lie."  
> **Repo:** v0.6.0 alpha | 1,930 tests | 56+ endpoints | 42 fleet tools | 8 views

---

## The Vision

The Star Trek computer isn't a chatbot — it's an **omniscient ship system**. It knows every star system, every officer, every ship specification, every research path, every resource deposit. When the Captain says "Computer, where can I mine dilithium?" it doesn't say "I don't have that data." It _answers_.

Majel should be the STFC equivalent:  
- **Ask anything, get an answer** — officers, ships, hostiles, systems, mining, research, buildings, resources  
- **Know your fleet** — what you own, what you're targeting, what's next  
- **Cross-reference everything** — "Where do I mine the resources I need for my next research?"  
- **Proactive when useful** — suggest, warn, remind  
- **Admit gaps honestly** — "I know X from game data; Y may have shifted with recent patches"

---

## What Exists Today (Strong Foundation)

| Layer | Coverage | Confidence |
|-------|----------|------------|
| **AI Chat + Persona** | Ariadne w/ configurable personality, 5 Gemini models, Lex episodic memory | High |
| **Officer Knowledge** | 278+ officers — stats, abilities, faction, rarity, class, synergy, traits | High |
| **Ship Knowledge** | 530+ ships — hull type, class, grade, faction, build costs, tier/level curves, crew slots | High |
| **Crew Composition** | Bridge cores, loadouts, below-deck policies, variants, docks, presets, fleet planning | High |
| **Effect Taxonomy** | 49+ effects, 32+ target tags, intent-based scoring, CM hard gate | High |
| **Target/Goal Tracking** | Structured goals with deltas, correction loops, reminder feedback, agent experience | High |
| **Data Import** | CSV/XLSX/JSON import with receipt tracking, undo, translator configs | High |
| **User System** | 4-tier RBAC, email verification, invite codes, session management, audit logging | High |
| **Frontend** | 8 views (Chat, Catalog, Fleet, Workshop, Plan, StartSync, Diagnostics, Admiral), LCARS theme | High |
| **Infrastructure** | Cloud Run, PostgreSQL 16, SSE streaming, IndexedDB cache, rate limiting, structured logging | High |

---

## TIER 1 — Knowledge Holes (The Computer Should KNOW This)

These are domains where the data **exists** (crawler collects it, canonical schema supports it) but is **not ingested or queryable**. This is the biggest gap: Aria literally cannot answer questions about these topics with real data.

### 1. Hostiles Database — NO COVERAGE

**Impact: Critical.** "What hostiles should I fight for tritanium?" and "What level hostiles can my ship handle?" are daily STFC questions.

- **Crawler:** Collects `hostile` entities from `data.stfc.space`
- **Canonical schema:** None — no tables for hostiles
- **Majel store:** None  
- **Fleet tools:** None  
- **What's needed:** Schema design → migration → ingestion pipeline → store → fleet tools (`search_hostiles`, `get_hostile_detail`, `suggest_hostiles_for_resources`) → system prompt awareness

### 2. Systems/Galaxy Data — SCHEMA EXISTS, NOT POPULATED

**Impact: Critical.** "Where can I mine parsteel at Ops 28?" requires knowing which systems have which mines at which levels.

- **Canonical schema:** Full coverage — `systems` (coords, level, deep_space, mirror_universe, hazards), `system_factions`, `system_mines` (resource, rate, amount), `system_planets`, `system_missions`  
- **Crawler:** Collects `system` entities  
- **Majel store:** None  
- **Fleet tools:** None  
- **What's needed:** Ingestion pipeline → store → fleet tools (`search_systems`, `find_mining_systems`, `find_systems_by_hostile`, `get_system_detail`) → optional systems browser view

### 3. Buildings/Starbase Data — SCHEMA EXISTS, NOT POPULATED

**Impact: High.** "What does upgrading my Ops center to 35 cost?" "What building gives me the mining rate buff?"

- **Canonical schema:** Full coverage — `buildings` (section, max_level, unlock_level), `building_buffs`, `building_buff_levels`, `building_levels` (build_time, strength), `building_level_resources`, `building_requirements`
- **Crawler:** Collects `building` entities  
- **Majel store:** None  
- **Fleet tools:** None  
- **What's needed:** Ingestion pipeline → store → fleet tools (`search_buildings`, `get_building_detail`, `calculate_building_upgrade`)

### 4. Research Tree Content — SCHEMA EXISTS, NOT POPULATED

**Impact: High.** "What research do I need for the Saladin?" "How much does Combat Research tier 28 cost?"

- **Canonical schema:** Full coverage — `research_trees`, `research_nodes` (row, column, unlock_level, generation), `research_buffs`, `research_buff_levels`, `research_levels` (time, cost), `research_level_resources`, `research_requirements`, `research_rewards`
- **Crawler:** Collects `research` entities  
- **User overlay:** `sync_research` tool and `research-store` exist for user-reported progression  
- **What's missing:** The canonical _reference_ data (what research exists, costs, prerequisites, buffs) is NOT ingested. Users can report their progression but Aria can't look up what a research node does or costs.
- **What's needed:** Ingestion pipeline → query tools (`search_research`, `get_research_detail`, `find_research_for_buff`, `calculate_research_path`)

### 5. Consumables — NO COVERAGE

**Impact: Medium.** Speed-ups, chests, tokens, etc. Less critical than hostiles/systems but still asked about.

- **Crawler:** Collects `consumable` entities  
- **Canonical schema:** None  
- **Majel store:** None  
- **What's needed:** Schema design → everything else. Lowest priority in this tier.

---

## TIER 2 — Missing UI Surfaces (Backend Exists, No Frontend)

### 6. Research View

The `research-store`, `list_research`, and `sync_research` tools all exist. Users can only interact with research through chat. A dedicated view with:
- Visual research tree browser (nodes, dependencies, levels)
- User progression overlay (current level per node)
- Cost/time calculator for next levels
- "What does this buff do?" tooltips

### 7. Inventory/Resources View

The `inventory-store`, `list_inventory`, and `update_inventory` tools all exist. No dedicated UI. A view showing:
- Resource totals by category
- What's needed for current targets  
- "What should I farm?" recommendations

### 8. Systems/Galaxy Browser View

Once systems data is ingested (Tier 1 #2), a browser view for:
- Search/filter systems by level, faction, resources, hazards
- Mining spots by resource type and ops level
- Which systems have which hostiles
- Even a simple grid/map visualization

### 9. Hostiles Browser View

Once hostile data exists (Tier 1 #1):
- Browse hostiles by type, level, loot
- "What crew do I use against X hostile?"
- Cross-reference with systems data

---

## TIER 3 — Experience & Quality Gaps

### 10. Crawler → Majel Data Pipeline

The crawler and Majel are completely disconnected. Data sync is manual (`data/.stfc-snapshot/`). Should be:
- One-click admin action: "Sync Game Data" button in Admiral view
- Or scheduled nightly refresh
- With ingestion receipts and diff reporting

### 11. README/Landing Page Stale

- README says v0.5.0, says 5 views (there are 8), missing many features
- Architecture diagram doesn't show SSE, effects, targets, the full scope
- Production URL is correct but feature list is incomplete

### 12. No Data Export

Users can import CSV/XLSX/JSON but cannot export their fleet state. Should offer:
- Export fleet roster (officers + ships with overlays)
- Export loadouts/crew compositions
- Export targets/goals

### 13. Effects Runtime DB (#150-154)

Already planned. Production still serves from git-committed seed JSON. Runtime should read from DB with promotion/rollback semantics. Tracked in backlog.

### 14. Crew Validator Phase C (#134)

Already in progress. "Does this crew actually work?" validation matrix. Tracked in backlog.

---

## TIER 4 — Aspirational (Enhance the "Computer" Feel)

| Feature | Impact | Effort | Notes |
|---------|--------|--------|-------|
| **Voice I/O** | Medium | Medium | Web Speech API for voice input → STT → Aria → TTS. Very Star Trek. |
| **Proactive Notifications** | Medium | Medium | Push notifications for timer expiry, target milestones, "your research completes today" |
| **Galaxy Map Visualization** | High | High | Canvas/SVG map with system dots, faction colors, mine markers, hostile areas |
| **Battle Simulator** | Medium | High | "Computer, simulate my Saladin vs a level 34 hostile" using combat formulas |
| **Keyboard Shortcuts** | Low | Low | Ctrl+K → chat, keyboard nav between views |
| **Mobile Layout** | Medium | High | LCARS responsive for phones — shelved for v1.0+ |
| **Alliance/Guild Features** | Medium | High | Multi-user fleet coordination — shelved for v1.0+ |

---

## Strategic Priority Matrix

```
                    HIGH IMPACT
                        │
    ┌───────────────────┼───────────────────┐
    │                   │                   │
    │  Hostiles DB (1)  │  Systems Data (2) │
    │  Research Ref (4) │  Systems View (8) │
    │  Data Pipeline(10)│  Hostiles View(9) │
    │                   │                   │
LOW ├───────────────────┼───────────────────┤ HIGH
EFFORT                  │                    EFFORT
    │                   │                   │
    │  README Fix (11)  │  Galaxy Map (T4)  │
    │  Research View(6) │  Battle Sim (T4)  │
    │  Inventory View(7)│  Voice I/O (T4)   │
    │  Data Export (12) │  Mobile (T4)      │
    │  Keyboard (T4)    │                   │
    │                   │                   │
    └───────────────────┼───────────────────┘
                        │
                    LOW IMPACT
```

---

## Recommended Execution Sequence

### Phase A — "The Computer Knows" (Data Foundation)

**Goal:** Ingest all available game data so Aria can answer questions about hostiles, systems, buildings, and research from actual data — not just training knowledge.

1. Build canonical data ingestion pipeline (crawler output → canonical DB tables)
2. Ingest systems, buildings, research reference data (schemas already exist)
3. Design + add hostile schema, then ingest hostile data
4. Add fleet tools for each domain: `search_systems`, `search_hostiles`, `search_buildings`, `search_research`
5. Update system prompt to reference new canonical data availability

### Phase B — "Show Me" (UI Surfaces)

**Goal:** Users shouldn't need to chat to browse game data. Add dedicated views.

1. Research View (store + tools already exist; add visual tree browser)
2. Inventory View (store + tools already exist; add resource dashboard)
3. Systems Browser (post-Phase A; search/filter mining spots, hostiles, factions)
4. Hostiles Browser (post-Phase A; browse by type/level/loot)

### Phase C — "Keep It Fresh" (Pipeline & Quality)

**Goal:** Data stays current without manual intervention.

1. Admin-triggered game data sync (crawler → ingest in one click)
2. Data diff/receipt reporting for syncs
3. Effects runtime DB activation (#150-154)
4. Crew validator Phase C (#134)

### Phase D — "Computer, Listen" (Experience Polish)

**Goal:** Make it feel like a starship computer.

1. README + landing page refresh
2. Data export (fleet state → CSV/JSON)
3. Keyboard shortcuts
4. Voice I/O (Web Speech API)
5. Proactive notifications (timer → push, target → reminder)

---

## Honest Gaps We Should Admit

Aria's system prompt already handles uncertainty well (authority ladder, confidence signaling). But we should explicitly acknowledge to users:

1. **Game data has a freshness date.** STFC is a live game; our snapshot may be weeks old. We display the sync date and Aria notes potential staleness.
2. **No live account connection.** We can't pull your fleet state from the game automatically. All fleet data is user-reported or imported from approved community streams.
3. **Event data is ephemeral.** We don't track current in-game events (arc rewards, monthly events, battle passes). These change weekly.
4. **PvP meta is model knowledge.** Current PvP meta comes from Aria's training data, not live telemetry. May be outdated.
5. **Some game mechanics are opaque.** Exact combat formulas, hidden stat multipliers, and server-side logic aren't publicly documented.

---

*This analysis captures the current state as of 2026-03-04. Update as phases complete.*
