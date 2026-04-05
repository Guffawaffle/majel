# ADR-016: Catalog-Overlay Model — Reference Catalog as Primary, Sheets Removed

**Status:** Accepted  
**Date:** 2026-02-09  
**Authors:** Guff, Lex (ChatGPT advisor), Opie (Claude)

## Context

Majel's original architecture was "chat window over a spreadsheet." Google Sheets held the user's roster data; the app imported it as CSV, injected it into prompts, and rendered answers. ADR-011 moved toward "Sheets as bootstrap import," making the app the source of truth for operational state while keeping Sheets as the entry point for baseline data.

With ADR-013 (wiki import pipeline) and ADR-015 (canonical entity identity), we now have a **complete reference catalog path**: 174 officers parsed from the STFC wiki with stable, namespaced IDs and full provenance. This changes the architecture fundamentally.

### The Pivot

The ship + crew list is core value. It's acceptable to expect the user to keep it updated — our job is to make that upkeep **cheap and low-friction**. The spreadsheet was originally the only way to get entity data in. Now the wiki reference catalog provides a complete, pre-populated entity catalog. "Initialize" doesn't need to be "paste your Google Sheets ID and set up OAuth" — it becomes "open the catalog, mark what you own."

### Why Sheets Can Go Entirely

The Google Sheets integration exists in **14+ source files** and requires:
- A Google Cloud project with OAuth consent screen
- `credentials.json` downloaded from Google Cloud Console  
- Desktop OAuth loopback flow (opens browser, callback to `localhost`)
- `googleapis` npm dependency (heavy)
- Three env vars (`MAJEL_SPREADSHEET_ID`, `MAJEL_TAB_MAPPING`, `MAJEL_SHEET_RANGE`)

For what? To import a list of officer/ship **names** that the wiki already has. The user's personal data — levels, assignments, what they own — can't come from Sheets anyway (Sheets doesn't track ownership state in a structured way). Users end up maintaining a spreadsheet just to re-import names that exist in a reference catalog.

The only thing Sheets provides that the catalog doesn't is "which officers/ships the user has." An `ownership_state` overlay on the reference catalog solves that more cleanly than any spreadsheet import.

### Project Age Context

Majel is ~24 hours old with zero external users (see ADR-006 "Zero Backwards Compatibility"). We can rip Sheets out entirely without migration concerns. No one has a `credentials.json` or `token.json` to preserve. No one has a workflow built around `GET /api/roster` refresh.

## Decision

### D1: Reference Catalog as the Primary Entity Source

The wiki-imported reference catalog (`reference_officers`, `reference_ships` from ADR-015) becomes the **primary** source of "what entities exist." The user doesn't create entities — they mark ownership on catalog entries.

```
Before (Sheets model):
  User spreadsheet → import → officers table → app state

After (Catalog-overlay model):
  Wiki reference → reference_officers table → user marks ownership → app state
```

The `officers` and `ships` tables in fleet-store.ts cease to be the canonical entity list. Instead, `reference_officers` is the catalog. The user's relationship to each entity is stored as an **overlay** — lightweight state attached to a stable reference key.

### D2: Ownership Overlay Schema

For each reference entity, the user maintains a thin overlay — not a copy of the entity, but their relationship to it:

```sql
CREATE TABLE IF NOT EXISTS officer_overlay (
  ref_id TEXT PRIMARY KEY REFERENCES reference_officers(id) ON DELETE CASCADE,
  ownership_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
  target INTEGER NOT NULL DEFAULT 0,       -- boolean: user is targeting this officer
  level INTEGER,                            -- user's current level for this officer
  rank TEXT,                                -- user's unlock rank (T1, T2, etc.)
  power INTEGER,                            -- user's current power (added by ADR-017)
  target_note TEXT,                         -- optional: "need for Borg armadas"
  target_priority INTEGER,                  -- optional: 1=high, 2=medium, 3=low
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_officer_overlay_state ON officer_overlay(ownership_state);
CREATE INDEX IF NOT EXISTS idx_officer_overlay_target ON officer_overlay(target) WHERE target = 1;
```

**Key design choices:**

- **`ownership_state` is a three-state enum, not a boolean.** `unknown` is the default. We don't silently assume unowned — that would make the initialized state ("I haven't told Majel about this officer yet") indistinguishable from the deliberate state ("I know I don't have this officer"). The MicroRunner must treat `unknown` as unknown, not as a proxy for unowned.
- **`target` is a separate boolean flag, NOT mutually exclusive with ownership.** A user may own an officer AND be targeting them (for shards, rank-up, further investment). Or they may target an officer they don't yet own. The two dimensions are independent.
- **User-specific values (level, rank) live on the overlay, not the reference.** The reference record has canonical game data (abilities, rarity, group). The overlay has the user's personal state (their level, their rank, whether they own it).
- **Overlay rows are created on first interaction.** An officer with no overlay row is `unknown` / not targeted. The overlay row appears when the user first marks a state.

The same pattern applies to ships:

```sql
CREATE TABLE IF NOT EXISTS ship_overlay (
  ref_id TEXT PRIMARY KEY REFERENCES reference_ships(id) ON DELETE CASCADE,
  ownership_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK (ownership_state IN ('unknown', 'owned', 'unowned')),
  target INTEGER NOT NULL DEFAULT 0,
  tier INTEGER,                             -- user's current tier
  level INTEGER,                            -- user's ship level
  power INTEGER,                            -- user's current power (added by ADR-017)
  target_note TEXT,
  target_priority INTEGER,
  updated_at TEXT NOT NULL
);
```

### D3: "Initialize" Becomes Catalog Bulk-Edit Mode

Today, "initialize" means "paste your Google Sheets ID, set up OAuth, import." After this ADR:

**"Initialize" opens the catalog in bulk-edit mode.** The user sees the full officer/ship reference catalog (from their most recent wiki import) and marks entities as owned/unowned/targeted. This is the first-run experience.

But there's no wizard gate. The catalog is **always available** as a grid view. "Initialize" is just an entry point that opens it with the bulk-edit affordance active. A user can come back any time and update their overlay state.

### D4: Catalog Grid UX Requirements

The grid must not become homework. Requirements:

**Navigation:**
- Search-first — global search bar with instant filter. Type "Kh" → catalog filters to "Khan", "Khriss", etc.
- Keyboard-friendly — arrow keys navigate, `Space`/`Enter` toggles ownership, `T` toggles target (or equivalent).
- Focus stays in search after applying a change — enables rapid-fire "search → mark → search → mark" workflow.

**Filters:**
- Ownership: `All` | `Owned` | `Unowned` | `Unknown`
- Target: `Any` | `Target only` | `Not targeted`
- Group / Rarity / Faction (standard catalog filters)
- Filters are chips/tabs, not a dropdown menu. Always visible. Removing filters entirely would just recreate them via search — better to formalize them.

**Bulk actions:**
- "Mark visible as Owned" — applies to the current filtered view. ("Show all Common → mark all owned" is a realistic workflow.)
- "Mark visible as Unowned" — same.
- "Toggle target on visible" — same.
- **Undo is critical.** Bulk actions must be reversible. At minimum, undo-last-action. Full undo stack is a stretch goal.

**Later enhancements (not Phase 1):**
- "Recently changed" surface — shows overlays updated in the last N minutes for quick review.
- Sort by "last updated" to see recent changes at top.
- Import from community-shared overlay files (JSON export/import of overlay state only — no reference data).

### D5: Behavioral Integration — Overlay-Aware Suggestions

Everywhere Aria suggests crews/docks/ships, the overlay status affects behavior:

| Overlay State | AI Behavior |
|---|---|
| `owned` | **Primary suggestions.** Aria recommends these officers/ships as available. |
| `target` (owned or not) | **Highlighted as alternates.** "You're targeting Khan — once acquired, Khan would be an upgrade for this crew." |
| `unowned` | **Excluded from primary suggestions** but available as strategic context. "For future reference, Kirk would be ideal here, but you've marked him as not yet acquired." |
| `unknown` | **Treated as genuinely unknown.** Aria does NOT assume unowned. If a suggestion references an `unknown` officer, append: "I see [Officer] is marked as unknown in your catalog — do you have them?" The UI can surface a one-click "Mark Owned / Mark Unowned" inline with the chat response. |

**One-click overlay updates from chat:** When Aria mentions an officer whose `ownership_state` is `unknown`, the chat UI offers inline buttons to mark it. This keeps the catalog fresh without requiring the user to leave the conversation. Aria becomes a feedback loop for catalog completeness.

### D6: MicroRunner Context Gating with Overlay

The MicroRunner's `reference_lookup` task type gains overlay awareness:

```
User: "What's the best crew for my Botany Bay?"

→ PromptCompiler: dock_planning
→ ContextGate checks:
    - T2 reference data for Botany Bay (ship abilities, crew slots)
    - Officer overlay: filter to ownership_state = 'owned' for primary suggestions
    - Officer overlay: include ownership_state = 'target' for alternate callouts
    - Exclude ownership_state = 'unowned' from primary suggestions
    - Flag ownership_state = 'unknown' officers in the response
→ Context manifest: "Available: T2 ref(botany-bay), owned officers(47), targeted officers(12), unknown(115)"
```

This is clean because the overlay is a thin join — the reference data provides the entity details, the overlay provides the user's relationship. No duplication, no identity collision.

### D7: Google Sheets — Full Removal

The entire Google Sheets subsystem is removed:

**Files to delete:**
- `src/server/sheets.ts` — OAuth flow, fetch functions
- `test/sheets.test.ts` — Sheets unit tests
- `credentials.json`, `token.json` (runtime artifacts, already gitignored)

**Files to modify:**
- `src/server/index.ts` — Remove Sheets imports, boot-time fetch, and re-engine creation after roster load
- `src/server/routes/core.ts` — Remove `GET /api/roster`, Sheets health check, diagnostic fields
- `src/server/config.ts` — Remove `spreadsheetId`, `tabMapping`, `sheetRange` from `AppConfig`
- `src/server/gemini.ts` — Remove FleetData injection path, the "connect your Google Sheets" fallback message
- `src/server/app-context.ts` — Remove `fleetData` and `rosterError` from `AppState`
- `src/server/envelope.ts` — Remove `SHEETS_NOT_CONFIGURED`, `SHEETS_ERROR` error codes
- `src/client/index.html` — Remove Sheets setup section, "Refresh Roster" button
- `.env.example` — Remove `MAJEL_SPREADSHEET_ID`, `MAJEL_SHEET_RANGE`
- `docs/SETUP.md` — Remove Google Sheets OAuth setup guide (entire Section 2 goes)
- `schemas/officer.schema.json`, `schemas/ship.schema.json` — Update `importedFrom` description

**NPM dependency to remove:**
- `googleapis` (and its transitive `google-auth-library`)

**What replaces it:**
- The reference catalog (wiki import) provides entities → `reference_officers`, `reference_ships`
- The overlay tables provide user state → `officer_overlay`, `ship_overlay`
- The prompt builder reads from reference + overlay instead of `FleetData`
- The fleet roster view reads from reference + overlay instead of Sheets CSV

### D8: FleetData Model Transformation

The `FleetData` / `FleetSection` model in fleet-data.ts was designed around Sheets' 2D CSV grid. It no longer fits:

- `FleetSection.rows` is a `string[][]` from `spreadsheets.values.get()` — that's a Sheets-specific shape.
- `FleetSection.csv` is a CSV serialization for prompt injection — we'll want structured injection instead.
- `FleetSection.source` stores the spreadsheet tab name.

**fleet-data.ts is retired.** The prompt builder will read from the reference + overlay tables directly, producing structured context blocks instead of CSV blobs. This aligns with MicroRunner's message-level injection (ADR-014 Approach B) — gated, labeled reference blocks with provenance, not monolithic CSV dumps.

The `importFromFleetData()` function in fleet-store.ts is also retired — there's no `FleetData` to import from. Officers and ships enter the system through the wiki ingest pipeline (ADR-013) and live in `reference_officers` / `reference_ships`.

### D9: The `roster:*` Namespace Simplifies

ADR-015 defined three namespaces: `wiki:*`, `roster:*`, `user:*`. With the catalog-overlay model:

- **`wiki:*` stays.** Reference entities from the wiki ingest.
- **`roster:*` is retired.** There is no separate "roster entity" — the roster IS the overlay on wiki entities. An officer the user owns is `reference_officers` row + `officer_overlay` row with `ownership_state = 'owned'`.
- **`user:*` stays (deferred).** Custom entities that don't exist in any reference catalog. Still needed in principle (what if Scopely adds an officer before the wiki is updated?) but not Phase 1. The catalog-overlay model covers 99% of cases.

The fleet-store's `officers` and `ships` tables are replaced by `reference_officers` + `officer_overlay` and `reference_ships` + `ship_overlay`. The old tables handled both entity identity AND user state in one row. The new model separates them cleanly.

## Consequences

### Positive
- **Zero-friction onboarding.** "Import wiki XML → open catalog → mark what you own" replaces "create Google Cloud project → OAuth consent screen → credentials.json → paste spreadsheet ID → map tabs."
- **No Google Cloud dependency.** Users don't need a Google account, OAuth setup, or cloud project just to use Majel.
- **Lighter dependency tree.** Removing `googleapis` saves ~30MB from `node_modules`.
- **Catalog is always complete.** Every known officer/ship is in the grid from the moment the wiki is imported, whether the user owns them or not. No "I forgot to add Kirk to my spreadsheet" gaps.
- **Three-state ownership prevents false assumptions.** `unknown` ≠ `unowned`. The system knows what it doesn't know.
- **Target tracking is first-class.** "Officers I'm working toward" is a real STFC use case that spreadsheets can't model cleanly.
- **Overlay is thin.** The user's data is a handful of columns per entity — ownership, target, level, rank. The heavy reference data (abilities, groups, provenance) lives in the reference catalog, shared and re-importable.
- **Chat-driven feedback loop.** Inline "mark owned/unowned" in chat responses keeps the catalog current without explicit maintenance sessions.

### Negative
- **Requires wiki import first.** Until the user imports reference data, the catalog is empty. We need good first-run UX that guides them through the wiki import before showing the catalog.
- **Losing Sheets means losing a familiar entry point.** Some users may already have STFC spreadsheets. Mitigation: "Export your Sheets as CSV, we'll map it to catalog entries" could be a future convenience feature — but it's not the primary path.

### Risks
- **Wiki coverage gaps.** If the wiki is missing officers/ships, the catalog has holes. Mitigation: the `user:*` custom entity path (Phase 2) covers this, and the wiki is actively maintained by the STFC community.
- **Bulk-edit UX needs to be genuinely fast.** If marking 50+ officers as owned feels like homework, users won't do it. The keyboard-driven, search-first design is critical — this must be QA'd against a realistic workflow ("mark all my owned Rares").

## Phases

| Phase | Scope | Depends On |
|---|---|---|
| **Phase 1: Schema + Sheets Removal** | Create `officer_overlay`/`ship_overlay` tables, remove Sheets subsystem, update prompt builder to read from reference + overlay | ADR-015 Phase 1 (reference tables exist) |
| **Phase 2: Catalog Grid UI** | Full-screen catalog grid with search, filters, keyboard-driven bulk edit, undo | Phase 1 |
| **Phase 3: Behavioral Integration** | AI suggestions respect overlay state, inline "mark owned?" in chat, one-click overlay updates | Phase 2 |
| **Phase 4: MicroRunner Overlay Gating** | ContextGate filters T2 injection by overlay state, receipts include overlay context | Phase 3 |
| **Phase 5: Advanced Overlay** | Target notes/priority, "recently changed" surface, community overlay sharing | Phase 4 |

## Evolution Notes

> **2025-07-18:** Phases 1 and 2 are complete. D7 (Sheets removal) and D8 (fleet-data retirement) are fully executed — the files are deleted, dependencies removed, and all 14+ references cleaned up. ADR-017 extends the overlay schema with a `power INTEGER` column on both tables. The overlay `set` methods are now wrapped in transactions to prevent TOCTOU races, and PATCH route handlers validate all numeric/string fields server-side.
>
> D3's catalog default was initially set to `'owned'` per this ADR, then reverted to `'all'` because ADR-017's Fleet tab now fills the "owned items view" role — making the duplicate default confusing.

## References

- **ADR-006** — Open Alpha Strategy (zero backwards compatibility policy)
- **ADR-011** — Data Sovereignty (three-tier model — superseded for entity import path by this ADR)
- **ADR-013** — Wiki Data Import (reference catalog ingest pipeline)
- **ADR-014** — MicroRunner (context gating, overlay-aware injection)
- **ADR-015** — Canonical Entity Identity (namespaced IDs, reference table schema)
- [sheets.ts](../src/server/sheets.ts) — ~~Google Sheets OAuth + fetch~~ (removed per D7)
- [fleet-data.ts](../src/server/fleet-data.ts) — ~~FleetData model~~ (retired per D8)
- [fleet-store.ts](../src/server/fleet-store.ts) — ~~Officers/ships tables~~ (replaced by reference-store + overlay-store)
