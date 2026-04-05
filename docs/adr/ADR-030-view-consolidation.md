# ADR-030 — View Consolidation: Eliminating Tab Duplication

**Status:** Proposed  
**Date:** 2026-02-17  
**Authors:** Guff, Opie (Claude)  
**References:** ADR-022 (Loadout Architecture), ADR-025 (Crew Composition Model), ADR-023 (Architecture Restructure), ADR-010 (Drydock — superseded)

---

## Context

The application currently ships **10 sidebar views**. Several were built as incremental phases of the ADR-022 → ADR-025 roadmap and were never retired as later, more complete views landed. A site review on 2026-02-17 identified three areas of duplication:

### Problem 1: Crew Builder ≈ Crews

| Feature | Crew Builder | Crews |
|---------|-------------|-------|
| Bridge Cores (CRUD) | **Cores** sub-tab | **Cores** sub-tab |
| Below Deck Policies (CRUD) | **Policies** sub-tab | **Policies** sub-tab |
| Loadout Variants | **Variants** sub-tab (read-only) | Inline in **Loadouts** sub-tab |
| Loadouts (CRUD) | — | **Loadouts** sub-tab |
| Reservations | — | **Reservations** sub-tab |

**Crews is a strict superset of Crew Builder.** Both import from the same API module (`api/crews.js`) and share the same constants. Crew Builder was the Phase B stepping stone; Crews (Phase 4) completed the vision. Shipping both forces the Admiral to guess which one to use.

### Problem 2: Drydock ≈ Crews → Loadouts

Drydock manages crew loadouts — binding a ship + bridge core + below-deck policy + intents. This is the **exact same domain** as the Loadouts sub-tab inside Crews. Drydock was born under ADR-010's dock-centric model and was already marked as superseded by ADR-022. It persists as a standalone view when its functionality is now a sub-tab of Crews.

### Problem 3: Fleet Ops ≈ Plan

| Feature | Fleet Ops | Plan |
|---------|-----------|------|
| Docks (CRUD) | **Docks** sub-tab | Shown in **Effective State** |
| Fleet Presets (CRUD + activate) | **Presets** sub-tab | **Fleet Presets** sub-tab |
| Effective State / Deployment | **Deployment** sub-tab | **Effective State** sub-tab |
| Plan Items (manual assignments) | — | **Plan Items** sub-tab |

Fleet Ops (Phase C) and Plan (Phase 5) fetch the same data (`fetchFleetPresets`, `fetchEffectiveState`, `fetchCrewLoadouts`). The Fleet Presets tab exists in **both** views with identical create/edit/delete/activate capabilities. The Deployment tab (Fleet Ops) and Effective State tab (Plan) render the same resolved state. Plan adds manual plan items — the only unique feature — making Fleet Ops a subset of Plan.

### The cognitive cost

10 sidebar icons is already at the acknowledged cognitive limit (ADR-024). Four of those 10 are duplicates. The Admiral sees two "crew workshop" views, two "fleet deployment" views, and a legacy drydock — and must figure out which to use. This is a UX failure, not a feature.

---

## Decision

### D1 — Retire Crew Builder; Crews is the canonical crew workshop

**Crew Builder** is removed from the sidebar. All its functionality (Cores, Policies, Variants) exists inside **Crews** with additional capabilities (Loadouts, Reservations). No feature is lost.

The view ID `crew-builder` is unregistered. The source files may be kept temporarily for reference but are no longer routable.

### D2 — Retire Drydock; Loadouts live inside Crews

**Drydock** is removed from the sidebar. The Loadouts sub-tab in **Crews** covers the same CRUD (ship + core + policy + intents + priority + active status) with tighter integration — loadouts are composed from siblings (Cores, Policies) in the same view.

Drydock's stats bar (total/active/unique ships) and intent filtering are valuable UX patterns that should be migrated into the Crews → Loadouts sub-tab if not already present.

The view ID `drydock` is unregistered. ADR-010 is already formally superseded; this completes the cleanup.

### D3 — Retire Fleet Ops; Plan is the canonical fleet state view

**Fleet Ops** is removed from the sidebar. **Plan** absorbs its Docks CRUD into a new **Docks** sub-tab (or inline in Effective State). The resulting Plan view has four sub-tabs:

| Sub-tab | Source | Purpose |
|---------|--------|---------|
| **Effective State** | Plan (existing) | `getEffectiveDockState()` — single truth, resolved view |
| **Docks** | Fleet Ops → Docks | Dock metadata CRUD (label, notes, unlocked) |
| **Fleet Presets** | Plan (existing) / Fleet Ops (duplicate) | Preset CRUD + activate |
| **Plan Items** | Plan (existing) | Manual assignment overrides |

The view ID `fleet-ops` is unregistered.

### D4 — Rename "Crews" to "Workshop" (optional, recommended)

With Crews absorbing loadout management from Drydock and the entirety of Crew Builder, the scope is broader than "crews." **Workshop** (⚓ icon) better describes a unified composition space:

| Sub-tab | Domain |
|---------|--------|
| **Cores** | BridgeCore CRUD |
| **Loadouts** | Ship + Core + Policy binding |
| **Policies** | BelowDeckPolicy CRUD |
| **Reservations** | Officer locks |

Alternatively, keep "Crews" — the name is shorter and already established.

### D5 — Final sidebar (7 views, down from 10)

| # | View ID | Icon | Title | Purpose |
|---|---------|------|-------|---------|
| 1 | `chat` | 💬 | Chat | AI fleet advisor |
| 2 | `catalog` | 📋 | Catalog | Reference data browser |
| 3 | `fleet` | 🚀 | Fleet | Owned roster — levels, ranks, power |
| 4 | `crews` | ⚓ | Workshop | Cores, Loadouts, Policies, Reservations |
| 5 | `plan` | 🗺️ | Plan | Effective State, Docks, Presets, Plan Items |
| 6 | `diagnostics` | ⚡ | Diagnostics | System health (admiral-gated) |
| 7 | `admiral` | 🛡️ | Admiral Console | User management (admiral-gated) |

This is a net reduction of **3 views** (Crew Builder, Drydock, Fleet Ops). Every feature survives — nothing is cut, only consolidated.

### D6 — Preservation of Drydock UX patterns

Drydock introduced several strong UX patterns that must survive in the Crews → Loadouts sub-tab:

- **Stats bar**: total loadouts / active loadouts / unique ships at a glance
- **Intent filter**: dropdown to filter loadouts by intent key
- **Active filter**: toggle to show only active loadouts
- **Priority sort**: sort by priority descending for at-a-glance ranking

If any of these are missing from the Crews → Loadouts sub-tab, they should be added as part of this consolidation.

---

## Implementation

### Phase 1: Sidebar cleanup (low risk)

1. Remove `crew-builder`, `drydock`, and `fleet-ops` from the sidebar view registry
2. If view registry uses a whitelist (e.g., `VALID_VIEWS` array), update it
3. Update any router/navigation guards that reference the retired view IDs
4. Remove or redirect any deep links to retired views

### Phase 2: Migrate Docks CRUD into Plan

1. Add a **Docks** sub-tab to the Plan view (or integrate dock metadata inline in Effective State)
2. Port dock CRUD UI from Fleet Ops → Docks into Plan → Docks
3. Verify the Effective State sub-tab still renders correctly with dock labels/notes visible

### Phase 3: Migrate Drydock UX patterns into Crews → Loadouts

1. Audit the Crews → Loadouts sub-tab for stats bar, intent filter, active filter, priority sort
2. Port any missing patterns from `drydock.js`
3. Verify loadout CRUD is feature-complete relative to what Drydock offered

### Phase 4: Cleanup

1. Remove retired view source files (or move to `legacy/`)
2. Update ADR cross-references
3. Update any test fixtures that reference retired view IDs

---

## What This ADR Does NOT Change

- **No schema changes** — all ADR-025 tables, APIs, and endpoints remain identical
- **No API changes** — `/api/bridge-cores`, `/api/loadouts`, `/api/fleet-presets`, etc. are untouched
- **No feature removal** — every capability from the retired views exists in the surviving views
- **No data migration** — all user data (loadouts, cores, presets, etc.) is unaffected
- **No behavioral changes** — `getEffectiveDockState()`, patch merge, manual-wins precedence all unchanged

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Admiral has muscle memory for Drydock/Crew Builder | Temporary confusion | Redirects from old view IDs to new locations; changelog note |
| Plan view gets too many sub-tabs (4) | Cognitive load | 4 sub-tabs is well within standard UX norms; each has a clear purpose |
| Drydock UX patterns lost in migration | Regression in loadout management UX | Explicit audit step in Phase 3 with checklist |
| Deep links break | Bookmarks/shared URLs 404 | Router fallback redirects retired IDs to their successor views |

---

## Consequences

### Positive

- **3 fewer sidebar icons** — 7 views (well under cognitive limit) instead of 10
- **Zero "which tab do I use?" confusion** — one workshop, one plan, no duplicates
- **Aligns with ADR-022/025** — those ADRs described Loadouts and Plan as distinct views; this makes it so
- **Simpler onboarding** — new Admirals see 7 clear-purpose tabs, not 10 overlapping ones
- **Reduced maintenance** — 3 fewer view files to maintain, test, and style

### Negative

- **Migration work** — Docks CRUD and Drydock UX patterns need porting
- **Temporary disruption** — Admiral must learn new tab locations for familiar features
- **Larger Plan and Crews views** — each has 4 sub-tabs (manageable but watch for scroll fatigue)
