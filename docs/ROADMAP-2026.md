# Majel 2026 Roadmap — From Here to There

> **Written:** 2026-04-02 | **Author:** Opie
>
> This is the full "magic wand" plan. Single user, no political constraints.
> Everything here is grounded in the actual codebase state as of commit `d99e36f`.

---

## Current State (Baseline)

| Dimension | Now |
|-----------|-----|
| **Auth** | Bearer token = permanent personal API key. Signup locked (`MAJEL_SIGNUP_OPEN=false`). |
| **Infrastructure** | Cloud Run `us-central1`, Cloud SQL Postgres, min-instances=1 |
| **Tools** | 40+ fleet tools. `search_game_reference` is name ILIKE only — no level/faction/hull filters |
| **Data** | CDN sync from `data.stfc.space`. stfc.space crawler exists at `/srv/crawlers/stfc.space` but is not integrated |
| **UI** | 8 tabs (Chat, Catalog, Fleet, Workshop, Plan, StartSync, Diagnostics, Admiral) |
| **Instance modeling** | Single instance per ship (ADR-051 designed but not implemented) |
| **Lex** | Integrated for chat frame storage; not wired to mutation events |
| **Token budgets** | `token_ledger` table exists; enforcement paused after Phase A |
| **Test count** | 2500 tests |
| **Active sprint** | Codebase Health + Research Path (#282, 5 slices, all unstarted) |

---

## Target State

| Dimension | Target |
|-----------|--------|
| **Interface** | Aria becomes the primary operator surface for a tool-backed reasoning system. 4 active tabs max. |
| **Reference quality** | Aria never falls back to training for hostile/system/research queries |
| **Data** | stfc.space crawler feeds Majel directly, daily cron. CDN sync retired |
| **Fleet depth** | Multi-instance ships, scrap yields, officer sources, armada context |
| **Infrastructure** | Cloud Run (current setup stays) |
| **MCP** | Fleet data queryable from any MCP client (Cursor, Claude Desktop, VS Code Copilot) |
| **Auth** | Google OAuth (no passwords); bearer token retained for API/MCP access |
| **Quality gates** | Prompt regression suite in CI |

---

## Epic 1 — Tool Layer Completion

> **Priority: P0 — Ship first. Without this, Aria always falls back to training for reference queries.**

### E1.1 — `search_game_reference` Level/Faction/Hull filters

**Problem**: `searchHostiles(query: string)` and `searchSystems(query: string)` are name ILIKE only.
Aria has no way to answer "find level 30 Romulan hostiles" without guessing.

**Target**:
```ts
// reference-store-entities.ts
filterHostiles(opts: {
  name?: string;
  minLevel?: number;
  maxLevel?: number;
  faction?: string;   // 'Federation', 'Klingon', 'Romulan', 'Augment', etc.
  hullType?: string;  // 'Explorer', 'Battleship', 'Interceptor', 'Survey'
}): Promise<ReferenceHostile[]>

filterSystems(opts: {
  name?: string;
  minLevel?: number;
  maxLevel?: number;
  faction?: string;
  isDeepSpace?: boolean;
}): Promise<ReferenceSystem[]>
```

**Implementation steps**:
1. Add `filterHostiles()` to `reference-store-entities.ts` — parameterized SQL,
   modeled after existing `searchSystemsByMining()` pattern
2. Add `filterSystems()` to same file
3. Add SQL queries to `reference-store-schema.ts` (parameterized, no interpolation)
4. Add method signatures to `reference-store.ts` interface
5. Extend `search_game_reference` declaration in `declarations.ts`:
   add optional `min_level`, `max_level`, `faction`, `hull_type` params for `hostile` and `system` categories
6. Update `searchGameReference()` in `read-tools-game-reference.ts` to branch on presence of
   filter params — call `filterHostiles()`/`filterSystems()` when any filter is present,
   fall through to existing ILIKE search when only `query` is provided
7. Tests: "level 20 Federation hostiles", "deep space systems level 30-40"

**Files touched**: `reference-store-entities.ts`, `reference-store-schema.ts`,
`reference-store.ts`, `declarations.ts`, `read-tools-game-reference.ts`

**Effort**: ~half day
**Depends on**: nothing
**Blocks**: E1.5, E2 integration quality

---

### E1.2 — `get_research_path` tool (#278) — Active Sprint Slice 5

Already 85% complete per BACKLOG. Finish it.

**Target**: Given `target_node_id`, trace the prerequisite chain from the Admiral's
current research state. Return only the *incomplete* prerequisites in dependency order,
with costs at each step.

**Remaining steps**:
1. Implement prereq traversal in research store (walk `prereqs` array recursively,
   filter against `research_overlays` completed set)
2. Wire result to `get_research_path` tool handler
3. Return: `{ target, chain: [{ node_id, name, currentLevel, requiredLevel, costs }], totalCost }`
4. Tests against real research node IDs

**Effort**: ~1 day (mostly there)

---

### E1.3 — Scrap yields tool (#276)

**Target**: "What do I get if I scrap my T8 Augur?" → resource return list

**Steps**:
1. Audit reference catalog for scrap yield fields — `reference_ships` probably has `scrap_rewards`
   from the CDN/stfc.space data; confirm what's available
2. If missing: add scrap yield to reference schema and fill from stfc.space feed (E2)
3. Add `get_scrap_yields(ship_id, tier)` tool — returns `[{ resource, quantity }]`
4. Declaration in `declarations.ts`

**Effort**: ~half day if data exists; ~1.5 days if schema addition needed
**Depends on**: E2.1 (data availability check)

---

### E1.4 — Armada fleet context tool (#280)

**Target**: "Which ships can I commit to an armada?" → ships not on mission, dock assignments resolved

**Steps**:
1. Gather: current dock assignments (`get_effective_state`), away team locks, reserved ships
2. Compute available vs. locked ships for armada use
3. Return structured availability list with lock reasons
4. Declaration in `declarations.ts`

**Effort**: ~1 day
**Depends on**: nothing (all store reads)

---

### E1.5 — Officer sources tool (#279)

**Target**: "Where do I get Spock?" → store/event/chest/mission source list

**Steps**:
1. Confirm `reference_officers` has source fields from stfc.space data — check `CANONICAL_SCHEMA_MAP.md`
2. If missing: add sources to reference schema after E2.1 feed integration
3. Add `get_officer_sources(officer_id)` tool
4. Declaration in `declarations.ts`

**Effort**: ~1 day
**Depends on**: E2.1 (data availability), E2.2 (ingestor populating source fields)

---

### E1.6 — Regression baseline (minimal, ships with E1)

**Rationale**: M1 claims Aria uses Majel tools for hostile/system/research queries rather than
training memory. Without a harness that detects violations of that claim, M1 is a belief, not
a milestone. This is the minimum — the full CI empire comes in E6.

**Scenarios to pin** (5-8 total):
- `hostile-level-filter`: "find level 30 Romulan hostiles" → must call `search_game_reference`
- `hostile-faction-filter`: "find Klingon hostiles near level 25" → must call `search_game_reference`
- `system-lookup`: "where is the Kronos system?" → must call `search_game_reference(system, ...)`
- `research-path`: "what research do I need for X?" → must call `get_research_path`
- `anti-hallucination`: "what level are Romulan scouts?" → must NOT assert a number from training
- `tool-enforced`: a clearly STFC factual question → must call a tool, not answer from memory

**What "minimal" means here**:

**Layer A — Deterministic routing (cheap, fast, stable; run constantly during development)**:
- Mock tool dispatch: no Gemini SDK call, just verify the harness infrastructure works
- Assert that `expectedToolCalls` and `forbiddenPatterns` checks fire correctly against known fixtures
- Used as the structural skeleton that Layer B scenarios plug into
- These tests are fast (<1s each) and MUST never be flaky

**Layer B — Real-model smoke scenarios (5-8 scenes, real Gemini SDK, no live fleet DB)**:
- Runs against the real Gemini SDK with a mock tool dispatch layer
- Checks `expectedToolCalls` were triggered; checks response text against `forbiddenPatterns`
- Accepts that model responses have some variance — scenarios are written to be robust to phrasing
  variation, not brittle on exact wording
- Does NOT require the full `ax` CI gating yet — that comes in E6
- Kept small on purpose: a regression harness people learn to ignore is worse than none

**Layer B — Next: canary grounding checks (WIP, interrupted 2026-04-04)**:
- `expectedGrounding: string[]` field on `Scenario` — strings that MUST appear in the final answer
- Inject synthetic unfakeable values into `mockDispatch` stubs (e.g. `"XENO_NODE_QK7291"`)
- If model echoes the canary string → grounded on tool result; if absent → hallucinating despite calling the tool
- `assertScenario()` in `harness.ts` gains a third check loop for `expectedGrounding`
- Layer A fixture tests need corresponding cases (grounding pass / grounding miss)
- **Interrupted** to investigate live Aria failures (hallucination on hostile query + tool loop exhaustion)

**Effort**: ~1 day (alongside E1.1/E1.2, not after)
**Depends on**: E1.1, E1.2 (scenarios exercise the new filter params)

---

## Epic 2 — Data Pipeline: stfc.space → Majel

> **Priority: P1 — The data quality revolution. stfc.space already has everything.**

The crawler at `/srv/crawlers/stfc.space` produces 7 entity types from `data.stfc.space`
(officer, ship, research, system, building, hostile, consumable) documented in
`stfc.space/docs/CANONICAL_SCHEMA_MAP.md`.
Majel currently runs a separate CDN sync. The plan: make **versioned ingested snapshots derived
from stfc.space** the authoritative reference. Majel trusts its own ingested snapshots, not upstream
live state. Upstream drift is handled at ingest boundaries, where it can be detected, recorded,
and rolled back.

This is ADR-028 materialized.

### E2.1 — Feed format contract + gap analysis

**Steps**:
1. Compare `stfc.space/docs/CANONICAL_SCHEMA_MAP.md` fields against Majel's
   `reference_hostiles`, `reference_systems`, `reference_officers`, `reference_ships`,
   `reference_research`, `reference_buildings` columns
2. Document schema gaps (fields Majel needs but stfc.space doesn't produce,
   or vice versa — e.g. scrap yield fields)
3. Write a migration for any needed additions to Majel reference tables
4. Define the canonical feed file paths and naming convention:
   `data/feeds/officers.json`, `data/feeds/hostiles.json`, etc.

**Output**: `docs/DATA_PIPELINE_CONTRACT.md` + migration file

**Effort**: ~1 day

---

### E2.2 — Majel ingestor for stfc.space feeds

**Steps**:
1. Create `src/server/services/gamedata-ingest-stfc.ts` (or extend existing `gamedata-ingest.ts`)
2. For each entity type: `ingestFromFeed(feedPath: string, entityType: EntityType): Promise<IngestResult>`
3. Each function: read JSON → validate shape → upsert into Postgres reference table in a transaction
4. Track: rows inserted, rows updated, rows unchanged, errors
5. Add `npm run ingest` CLI command: `node scripts/ingest.js --feed data/feeds/`
6. Admin HTTP endpoint: `POST /api/admin/ingest` (bearer-authenticated) for on-demand trigger
7. Each ingest run records: feed source date, entity counts (inserted/updated/unchanged/errors), run timestamp
8. Store ingest run metadata in a `reference_ingest_runs` table — Aria can answer "when was data last refreshed?"
9. Raw feed snapshots retained for **30 days** minimum. Snapshot path includes source date and ingest run ID
   (e.g. `feeds/snapshots/2026-04-05_run-0042/`). Rollback = re-ingest from a retained snapshot.
   Ingest runs are non-destructive upserts; re-running from any prior snapshot is the recovery path.

**Effort**: ~2 days
**Depends on**: E2.1

---

### E2.3 — Automated daily refresh

**Steps**:
1. Create `scripts/daily-refresh.sh`:
   ```bash
   #!/bin/bash
   set -e
   cd /srv/crawlers/stfc.space && npm run crawl --output gs://majel-feeds/snapshots/$(date +%Y-%m-%d)/
   ```
2. Crawler writes versioned snapshot to GCS bucket `majel-feeds` under path `snapshots/YYYY-MM-DD/`
3. Cloud Scheduler job hits `POST /api/admin/ingest` at 05:00 daily (bearer-authenticated)
4. Ingest endpoint reads from GCS: `gs://majel-feeds/snapshots/<latest>/`, records snapshot ID + date + hash

**Effort**: ~half day
**Depends on**: E2.2

> **Validation**: Run stfc.space pipeline in **parallel** with CDN sync from E2.3 landing until
> E2.4. Compare row counts and spot-check key entities (ships, hostiles, systems) before committing
> to cutover. Do not retire CDN sync on optimism alone — retire it on evidence.

---

### E2.4 — Retire CDN sync

**Steps**:
1. Run stfc.space pipeline in parallel with CDN sync for ~2 weeks — compare output
2. Once validated: remove CDN sync code from `gamedata-ingest.ts` (or equivalent)
3. Remove CDN-related env vars from Cloud Run config
4. Delete dead code

**Effort**: ~half day (the patience is the real cost)
**Depends on**: E2.3 stable for 2 weeks

---

## Epic 3 — Instance Modeling (ADR-051)

> **Priority: P2 — Enables tracking multiple ships of the same type.**

ADR-051 is fully designed. Schema change:
`PK (user_id, ref_id)` → `(user_id, ref_id, instance_id TEXT NOT NULL DEFAULT 'primary')`

> **Trigger condition**: If Aria is already producing ambiguous or wrong answers because it cannot
> distinguish "your T8 Enterprise" from "your T10 Enterprise," move E3 before E4. Identity corruption
> in the domain model is not cosmetic — it poisons upstream reasoning. If multi-instance ships are
> not yet a real ambiguity in actual play, keep E3 at P2 as sequenced.

### E3.1 — Schema migration

**Steps**:
1. Write migration: add `instance_id TEXT NOT NULL DEFAULT 'primary'` to `ship_overlays`
2. Drop old unique constraint on `(user_id, ref_id)`, create new PK on `(user_id, ref_id, instance_id)`
3. Assess `officer_overlays` — multiple of same officer unusual but possible for some event officers;
   apply same pattern for consistency
4. All existing rows get `instance_id = 'primary'` via migration default — zero data loss

**Effort**: ~half day

---

### E3.2 — Mutation stack update

**Steps**:
1. `set_ship_overlay` tool: add optional `instance_id` param, default `'primary'`
2. `sync_overlay` payload schema: add optional `instanceId` field to ship entries, default `'primary'`
3. `get_ship_detail` / `get_ships_detail`: accept optional `instance_id`, default `'primary'`
4. Fleet overview: show multiple instances grouped under the ship name when `count > 1`
5. All store methods that target a single overlay: updated to pass `instance_id` parameter

**Effort**: ~1 day
**Depends on**: E3.1

---

### E3.3 — Instance labels

**Steps**:
1. Add `instance_label TEXT` column to `ship_overlays` (nullable, free text)
2. `set_ship_overlay` + `sync_overlay`: accept optional `instance_label`
3. Aria uses `instance_label` when present: "your T8 Enterprise", "your T10 Enterprise"
4. When no label: fall back to tier ("T8") for disambiguation

**Effort**: ~half day
**Depends on**: E3.2

---

## Epic 4 — Surface Upgrade (After the Reasoning System Earns It)

> **Priority: P2 — The UI should reflect what Aria can actually do. The tool layer, data contracts,
> and fleet model are the product; Aria is the best way to drive them. Surface upgrades follow
> correctness — they do not lead it.**

### E4.1 — Collapse secondary tabs

**Current**: 8 tabs (Chat, Catalog, Fleet, Workshop, Plan, StartSync, Diagnostics, Admiral)
**Target**: 4 active tabs (Chat, Fleet, Catalog, Admiral); secondary tabs demoted or hidden,
not deleted, until Aria has demonstrated parity in real use.

**Steps**:
1. **StartSync → Admiral tab**: Move sync-state panel into Admiral view under a "Data Sync" accordion
2. **Diagnostics → Demote, keep**: Move under Admiral → System accordion. Do **not** remove.
   When chat is vague or wrong, direct inspection saves the session. Remove only after Aria has
   demonstrated sustained correctness over months of real play.
3. **Workshop → Hide/defer**: Workshop functionality (build calc, blueprint math) is largely
   superseded by `calculate_upgrade_path` + `estimate_acquisition_time` tools. Hide from main nav;
   keep accessible via Admiral → Advanced. Do not delete — recovery surface while Aria proves parity.
4. **Plan → Merge into Fleet**: Dock assignment and loadout review belong in Fleet. Merge unique
   Plan views into a Fleet sub-tab. Deactivate the standalone Plan tab once merged.
5. Update `App.svelte` / top nav: 4-5 visible tabs; demoted tabs remain navigable

> **Principle**: Tab retirement follows Aria's demonstrated correctness, not a schedule.
> Demote first. Remove only when a surface has been genuinely redundant in real use for months.

**Effort**: ~2 days
**Depends on**: nothing

---

### E4.2 — Structured response cards for tool output

**Problem**: Tool responses come back as Markdown prose. For structured data (fleet overview,
hostile list, ship comparison), prose is noisy and hard to scan.

**Target**: When Aria returns tool-derived structured data, render as an inline card component.
Markdown prose for conversational responses; card for data views.

**Design**:
- Aria emits a structured marker when returning primarily tool data:
  `<!-- CARD:fleet_overview -->` or via response metadata
- Svelte card components: `FleetCard.svelte`, `ShipCard.svelte`, `HostileCard.svelte`, `ResearchCard.svelte`
- Chat message component detects card type → renders appropriate card component embedded inline

**Steps**:
1. Define card schema interface: `type CardPayload = FleetOverviewCard | ShipCard | HostileListCard | ...`
2. Implement `FleetCard.svelte` — uses data from `get_fleet_overview` response (highest usage)
3. Implement `ShipCard.svelte` — for `get_ship_detail` responses
4. Update chat message renderer: detect card payload, render card + collapsed Markdown
5. Extend incrementally as new card types are needed

**Effort**: ~3 days (initial set); incremental extension is cheap
**Depends on**: E1 stable (cards are useful before tab cleanup, not after)

---

### E4.3 — Slash command palette

**Target**: Type `/` in chat input → autocomplete dropdown of quick commands

**Commands**:
| Command | Wires to |
|---------|----------|
| `/fleet` | `get_fleet_overview` |
| `/targets` | `list_targets` |
| `/sync` | `sync_overlay` |
| `/hostile <level> <faction>` | `search_game_reference(hostile, ...)` |
| `/system <name or level>` | `search_game_reference(system, ...)` |
| `/find officer <name>` | `search_officers` |
| `/find ship <name>` | `search_ships` |
| `/validate` | `validate_plan` |

**Steps**:
1. Add slash-command parser to `ChatInput.svelte` — detect leading `/` on whitespace boundary
2. Show autocomplete dropdown with command descriptions (keyboard navigable)
3. On enter: expand slash command into a structured message or direct tool call
4. Some commands (e.g. `/fleet`) bypass the LLM entirely and call the tool directly → render card

**Effort**: ~2 days
**Depends on**: E4.2 (cards make the direct-tool-call path useful)

---

### E4.4 — Lex as STFC decision memory

**Current state**: Lex stores frames from conversations via `createFrame()`. Not wired to mutations.

**Target**: Key fleet decisions auto-recorded as Lex frames. Aria starts each session with
recent relevant frames surfaced as context.

**Steps**:
1. After each successful mutation response (`set_ship_overlay`, `create_target`, `complete_target`,
   `create_loadout`, `assign_dock`): emit a Lex frame recording the event
   - Frame type: `stfc_fleet_mutation`
   - Frame content: human-readable summary ("Upgraded USS Voyager to T9", "Targeted Spock officer")
   - Tags: `ship_id`, `officer_id`, entity type, etc. for retrieval
2. On session start: retrieve recent **relevant** frames by tag intersection with current query context.
   Summarize/compact before injection — do not dump raw frame text. Hard cap: 3-5 compacted frames
   injected as quiet context, not as a replay log. Stale or irrelevant frames are excluded, not padded.
3. Test: Aria can say "last time we talked you were working on Voyager blueprints (3 weeks ago)"
   without burning session context on every unrelated prior mutation.

**Files**: `src/server/services/lex-client.ts`, `src/server/services/fleet-tools/mutation-*.ts`,
`src/server/services/gemini/system-prompt.ts`

**Effort**: ~2 days
**Depends on**: E1 tool layer stable (mutations are meaningful before E1 lands too)

---

## Epic 5 — MCP Tool Layer

> **Priority: P3 — AI-native access. Query your fleet from Cursor, Claude Desktop, VS Code.**

Lex already exposes an MCP server (`@smartergpt/lex-mcp`). Majel's fleet store is a
natural second surface.

### E5.1 — Majel MCP server

**Design**: `src/mcp/server.ts` — MCP stdio server that proxies a read-only subset of
Majel's fleet tools, authenticated via `MAJEL_ADMIN_TOKEN`.
> **Hard boundary — 2026**: MCP is a **query surface, not a control surface**. No mutation tools
> through MCP this year. The moment external agents can mutate fleet state, you inherit a second
> trust and audit problem. Read-only now; revisit only if there's a specific, justified mutation
> use case with a clear audit trail designed first.
**Tools to expose**:
- `get_fleet_overview` — fleet size, dock counts, power
- `get_effective_state` — fully resolved dock assignments
- `search_ships` / `search_officers` — reference catalog search
- `list_targets` — active acquisition goals
- `list_plan_items` — current dock assignments

**Steps**:
1. Create `src/mcp/server.ts` using `@modelcontextprotocol/sdk`
2. MCP tool handlers call the same store/DB functions as the fleet tools
3. Auth: reuse the existing `MAJEL_ADMIN_TOKEN` bearer auth boundary —
   the same path that already authenticates API calls. No new auth pattern.
4. Add `bin/majel-mcp` entry point: `node dist/mcp/server.js`
5. Add `server.json` for MCP registry format

**Effort**: ~2 days

---

### E5.2 — Wire to MCP clients

**Steps**:
1. Configure Claude Desktop: add Majel MCP server to `claude_desktop_config.json`
2. Configure VS Code Copilot: add to `.mcp.json` in workspace
3. Test: "what ships are docked?" from Claude Desktop → correct answer
4. Optional: publish `@majel/mcp` to npm for easy install by others

**Effort**: ~half day
**Depends on**: E5.1

---

## Epic 6 — Prompt Regression Suite (Full CI)

> **Priority: P4 — Builds on the E1.6 baseline. Full CI integration, growing scenario library.**

**Target**: Complete regression harness with CI gating, building on the minimal baseline shipped
alongside E1. Detects when prompt changes cause Aria to hallucinate or stop using tools correctly.
The E1.6 baseline pins behavior; this epic makes regression a hard deploy gate.

### E6.1 — Full harness + CI integration

**Scenario expansion** (building on E1.6's 5-8 baseline scenarios):
- Grow to 20+ scenarios covering all tool categories: fleet queries, mutation validation,
  officer lookup, research path, battle log analysis, anti-hallucination checks
- Add confidence tracking: what % of the time does Aria call the right tool on first attempt?
- Any scenario that was previously passing and now fails blocks the deploy

**CI integration steps**:
1. Wire E1.6 harness infrastructure to `npm run ax -- prompt-regression`
2. Add `prompt-regression` to `AX-SCHEMA.md` and the CI pipeline
3. Track pass rate per scenario over time (regression history table)
4. Deploy gate: prompt-regression must pass before `cloud:deploy` proceeds
5. Expand: add new scenarios each time a hallucination class is identified in real use

**Effort**: ~2 days CI wiring; ongoing scenario additions are cheap
**Depends on**: E1.6 (baseline harness)

---

## Sequencing Map

```
PHASE A — Truth floor (do this first)
 │
 ├── E1.1  hostile/system filters          ← START HERE
 ├── E1.2  research path (#278)
 ├── E1.6  regression baseline             ← ships alongside E1.1/E1.2, not after
 │
 │   [M1: Reference-Grounded Retrieval — now a testable claim, not a belief]
 │
PHASE B — Data legitimacy
 │
 ├── E1.3  scrap yields     ─── if data exists cleanly; else wait for E2.2
 ├── E2.1  feed contract + gap analysis
 ├── E2.2  ingestor         ─── after E2.1
 ├── E2.3  daily cron       ─── after E2.2
 ├── E1.5  officer sources  ─── after E2.2 (needs source fields from feed)
 ├── E2.4  retire CDN sync  ─── after parallel running confirms parity
 │
 │   [M2: Data Independence — versioned snapshots, not brittle sync assumptions]
 │
PHASE C — Domain honesty
 │
 ├── E3    instance modeling  ─── move here if multi-instance ambiguity is real NOW
 ├── E1.4  armada context     ─── all-store reads, any time after E1
 │
 │   [M3: Fleet Depth — fleet model is honest about what you actually own]
 │
PHASE D — Surface upgrade (after reasoning earns it)
 │
 ├── E4.2  tool cards       ─── before tab retirement, not after
 ├── E4.4  Lex memory       ─── after E1 stable
 ├── E4.3  slash commands   ─── after cards
 ├── E4.1  tab cleanup      ─── last; only remove what Aria has demonstrably replaced
 │
 │   [M4: Surface Upgrade]
 │
PHASE E — Externalization + quality gates
 │
 ├── E5.1  MCP server (read-only)    ─── after E1
 ├── E5.2  wire MCP clients          ─── after E5.1
 └── E6    regression full CI        ─── builds on E1.6 baseline

    [M5, M6: AI-Native + Quality Gates]
```

---

## Milestones

| Milestone | Epics | Signal |
|-----------|-------|--------|
| **M1: Reference-Grounded Retrieval** | E1.1, E1.2, E1.6 | Aria uses Majel tools rather than training memory for hostile, system, and research-path queries, with regression coverage for known failure cases |
| **M2: Data Independence** | E2.1-E2.4 | stfc.space versioned snapshots are the authoritative reference; CDN sync retired |
| **M3: Fleet Depth** | E1.3, E1.4, E1.5, E3 | Scrap yields, armada context, officer sources, honest multi-instance fleet model |
| **M4: Surface Upgrade** | E4.1-E4.4 | Aria presents tool-derived state in scan-friendly forms, supports direct command entry, and coexists with reduced but preserved fallback inspection surfaces |
| **M5: AI-Native** | E5 | Fleet queryable (read-only) from Cursor, Claude Desktop, VS Code Copilot |
| **M6: Quality Gates** | E6 | Full regression CI gate; hallucination regressions caught before deploy |

---

## What Is NOT In This Plan

- **Multi-user support**: Deferred. Single user. When/if multi-user is needed, ADR-019 covers it.
- **Mobile native app**: Chat is mobile-responsive. Native app not needed.
- **ADR-048 Token Budgets enforcement (phases B-D)**: Paused. Single user with known budget = no urgency.
- **Public alpha/beta launch**: Not a goal. This is a personal tool.
- **Google OAuth**: Single user, signup locked, bearer token exists. Not a 2026 priority. Password
  cleanup is maintenance, not roadmap work. Revisit only if sharing Majel with others becomes real.

---

*Next immediate action: E1.1 + E1.6 — add `filterHostiles()` and `filterSystems()` to the reference store, extend `search_game_reference`, and seed the minimal regression baseline simultaneously. M1 becomes testable, not a belief.*
