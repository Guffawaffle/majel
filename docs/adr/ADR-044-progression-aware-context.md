# ADR-044 — Progression-Aware Context

**Status:** Accepted  
**Date:** 2026-03-12  
**Authors:** Guff (PM), GitHub Copilot (Senior Architect), Lex (Architecture Review)  
**Program umbrella:** #212  
**Depends on:** ADR-007 (fleet tools), ADR-025 (crew composition), ADR-028 (research/inventory), ADR-039 (tool registry)

---

## Context

Aria currently operates as a capable STFC advisor but is **progression-blind**. She knows an Admiral's ops level, drydock count, and hangar slots (via `[FLEET CONFIG]`), but has no awareness of:

- How many officers, ships, loadouts, or targets the Admiral actually has
- What fraction of research is synced
- What buildings unlock at the next ops level
- Whether faction standings are configured
- Whether the ops level is a real user input or the schema default

This means Aria cannot:

1. Scale advice to fleet maturity (e.g., suggesting T4 officers to a level 15 player)
2. Proactively flag upcoming unlocks ("At Ops 26 you'll unlock the Armory")
3. Distinguish between "hasn't told me their level" and "is genuinely level 1"
4. Notice data gaps that would improve her answers ("You haven't synced research yet")

The data already exists across the overlay, crew, target, research, inventory, user-settings, and reference stores. The problem is assembly and delivery — no single function gathers this cross-store snapshot, and the system prompt has no slot for it.

### What This ADR Does NOT Cover

- **Strategy meta / tier lists** — Aria already has strong training knowledge about STFC strategy. This ADR adds *the Admiral's own state*, not opinionated recommendations.
- **Intent coverage / loop readiness** — Deferred to v1.1 (`check_intent_coverage` tool). v1 only reports loadout intent coverage counts in the brief.
- **Building / research data ingestion** — The CDN ingest pipeline already exists (`syncCdnBuildings`, `syncCdnResearch`). This ADR assumes reference data is populated.

## Decision

### D1: ProgressionContextV1 — Cross-Store Snapshot

Introduce a `getProgressionContext(userId, deps)` function that assembles a read-only snapshot from existing stores. This is a **pure query function**, not a new store — it reads from `ResolvedStores` and returns a typed object.

```typescript
interface ProgressionContextV1 {
  opsLevel: number;
  drydockCount: number;
  ownedOfficerCount: number;
  ownedShipCount: number;
  loadoutCount: number;
  activeTargetCount: number;
  factionStandings: FactionStandingRecord[];
  researchSummary: { completedNodes: number; totalNodes: number; pct: number } | null;
  nextOpsBoundary: { level: number; buildings: { name: string; maxLevel: number | null }[]; buildingCount: number } | null;
  intentCoverage: { covered: string[]; uncovered: string[] };
  dataQuality: {
    hasBuildingData: boolean;
    hasResearchData: boolean;
    hasInventoryData: boolean;
    hasFactionData: boolean;
    opsLevelIsDefault: boolean;
  };
}
```

All fields are **deterministic facts** — counts, presence flags, exact next-level lookups. No heuristics, no scoring, no recommendations.

#### Fact-class boundary (v1)

Progression-aware context in v1 is limited to two classes of data:

1. **Deterministic facts** — exact counts, presence/absence flags, precise unlock-level lookups, verbatim store values.
2. **Inferred configuration/state summaries** — computed from deterministic facts (e.g., research completion percentage, intent coverage from loadout keys vs. seed intents).

v1 explicitly excludes:

- **Heuristic progression scoring** — no "fleet readiness" numbers, no maturity grades, no composite indexes.
- **Meta advice** — no tier lists, no "you should be farming X at your level."
- **Combat readiness judgments** — no power estimates, no "your fleet can/can't handle this."

Future work may introduce scored or heuristic surfaces, but those require their own ADR with explicit justification for each heuristic.

### D2: Prompt Enrichment — Progression Brief

A `formatProgressionBriefBlock(ctx: ProgressionContextV1)` function produces a ~40-60 token context block injected per-message alongside the existing `[FLEET CONFIG]` and `[INTENT CONFIG]` blocks:

```
[PROGRESSION BRIEF]
Fleet: 45 officers, 12 ships, 3 loadouts, 2 active targets
Research: 34% (120/350 nodes)
Intent coverage: mining-gas, pvp, armada
Next unlock: Ops 26 — 3 buildings
Gaps: ops level is default, no research synced
[END PROGRESSION BRIEF]
```

Rules:
- **Research line**: omitted if `researchSummary` is null (shows "not synced" in Gaps instead)
- **Intent coverage line**: shows covered intents only; "none" if empty
- **Next unlock line**: omitted if `nextOpsBoundary` is null; shows "unknown" if no building data
- **Gaps line**: only rendered when at least one `dataQuality` flag is true; omitted entirely when all data is present

This fires on **every message** — the model always has fleet maturity context without needing to decide to call a tool.

### D3: `check_ops_unlocks` Fleet Tool

A read-only fleet tool that answers "what unlocks at my ops level?" or "what unlocks next?":

```typescript
// Declaration
{
  name: "check_ops_unlocks",
  description: "List buildings that unlock at a specific Operations level, or find the next unlock boundary above current level.",
  parameters: {
    type: "OBJECT",
    properties: {
      ops_level: { type: "NUMBER", description: "Specific ops level to query. Omit to find next boundary above current level." }
    }
  }
}
```

Return shape:
```typescript
interface CheckOpsUnlocksResult {
  queryType: "exact_level" | "next_boundary";
  opsLevel: number;
  buildings: { name: string; maxLevel: number | null }[];
  buildingCount: number;
  currentOpsLevel?: number;  // only for next_boundary
  note?: string;             // only for missing data / no boundary
}
```

### D4: `listBuildingsAtOps` Store Query

Add to the `ReferenceStore` interface:

```typescript
listBuildingsAtOps(opts: {
  exactLevel?: number;
  aboveLevel?: number;
  limit?: number;
}): Promise<ReferenceBuilding[]>;
```

SQL: `WHERE unlock_level = $1` (exact) or `WHERE unlock_level > $1 ORDER BY unlock_level ASC, name ASC LIMIT $2` (above). `nextOpsBoundary` semantics: find the lowest `unlock_level` above current, then return all buildings at that level.

### D5: `opsLevelIsDefault` Provenance

Computed inside `getProgressionContext` as `opsEntry.source !== "user"` where `opsEntry` comes from `userSettingsStore.getForUser(userId, "fleet.opsLevel")`. The `UserSettingEntry.source` field already distinguishes `"user"` (explicit override) from `"default"` (schema fallback). No new infrastructure needed.

This provenance check lives in `getProgressionContext`, not in `readFleetConfigForUser` — fleet config plumbing stays focused on its existing responsibility. Only widen `FleetConfig` if a concrete reuse need emerges during implementation.

## Consequences

### Positive
- Aria scales advice to fleet maturity on every message
- Data gaps become visible to the model → it can suggest sync actions
- Building unlocks become queryable without model hallucination
- All new surfaces are read-only — no mutation risk

### Negative
- Per-message cost increases by ~40-60 tokens (progression brief)
- `getProgressionContext` reads from 5-6 stores per message — need to confirm latency is acceptable
- Building data depends on CDN snapshot being ingested — empty ref tables produce degraded but safe output

### Risks
- **Latency**: Multiple store reads per message. Mitigated by `Promise.all` parallelism and the fact that these are simple count/lookup queries, not full scans.
- **Stale data**: Progression brief reflects store state at message time, not real-time game state. This is acceptable — all Majel data has this property.

## Implementation Sequence

1. **Store + function plumbing** (#212): `listBuildingsAtOps` query, `getProgressionContext` function, unit tests
2. **Prompt enrichment** (#213): `formatProgressionBriefBlock`, wire into `buildChatMessage`, integration tests
3. **`check_ops_unlocks` tool** (#214): Declaration, registry entry, implementation, tool tests
