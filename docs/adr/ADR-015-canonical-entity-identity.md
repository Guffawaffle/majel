# ADR-015: Canonical Entity Identity — Namespaced IDs, Reference Anchors & the "Custom Entity" Trap

**Status:** Proposed  
**Date:** 2026-02-09  
**Authors:** Guff, Lex (ChatGPT advisor), Opie (Claude)

## Context

With the wiki import pipeline landing (ADR-013, commit `1dc8743`) and MicroRunner wired into production (ADR-014, commit `632d093`), Majel has a real source-of-truth path for "what is an officer/ship" — names, metadata, provenance — without shipping a dataset. This changes the shape of the "add officer / add ship" problem significantly.

### The Current ID Scheme Is Fragile

Today, entity IDs are **slugified names** (`slugify()` in fleet-store.ts):

```
"USS Saladin" → "uss-saladin"
"Khan"        → "khan"
"Spock"       → "spock"
```

The `id` column is `TEXT PRIMARY KEY` on both the `ships` and `officers` tables. The `imported_from` field is a flat string (`"wiki:stfc-fandom"` or the Sheets section label). There is no namespace, no ref_id, no structured provenance chain in the fleet schema.

This works today because the roster is small and user-imported. It will break as the system matures:

- **Identity collisions:** "Spock" vs "Spock (TOS)" vs "Spock (SNW)" vs typos vs nicknames. The wiki lists ~174 officers; STFC has variants. Name-as-key stops being reliable.
- **Search & typeahead becomes untrustworthy:** The moment custom entries exist alongside reference entities, any "lookup by name" must handle ambiguity, duplicates, and merges.
- **Future reference packs can't join cleanly:** Once T2 reference packs are fully online, we want deterministic joins like `roster_officer.ref_id → reference.officers.id`. Custom entries without stable IDs make that messy.
- **MicroRunner context gating wants stable keys:** `reference_lookup` is clean if it can resolve "Khan" → `wiki:officer:khan:12345` and attach provenance in receipts. That falls apart if "Khan" might be a user-invented row with no backing reference.

The wiki ingest script already captures pageId, revisionId, and timestamp in its provenance output — but **doesn't store any of it** in the fleet database. The `ReferenceEntry` interface in MicroRunner has `id`, `name`, `source`, `importedAt` but no structured provenance chain. And `lookupOfficer()` in app-context.ts does a case-insensitive name match — exactly the fragility this ADR addresses.

### The Core Risk: "Custom Officers" in the Canonical Bucket

If we let users type arbitrary officers/ships into the **same conceptual bucket** as reference entities, we create long-term pain:

1. **Identity collisions** — "Khan" the reference officer vs "Khan" the user's custom entry. Now `id = "khan"` points at two different concepts.
2. **Unreliable lookups** — Every name-based search must handle duplicates, merges, spelling variants. MicroRunner's `compileTask()` keyword matching becomes ambiguous.
3. **Reference pack joins break** — When we have T2 reference packs with deterministic IDs, custom entries without stable anchors can't participate in joins.
4. **Receipt provenance lies** — If a receipt says `t2:officer:khan`, does that mean "the wiki-imported Khan reference" or "the user's manually created Khan"?

So: if "custom officers" means "free text that behaves like canonical reference," we'll have big problems. The solution is to make the namespace explicit.

### Three-Tier Alignment

This directly extends ADR-011's three-tier data model:

| ADR-011 Tier | Entity Identity Role |
|---|---|
| **Bootstrap data** (user's fleet from Sheets) | `roster:officer:<slugified-name>` — initial import, may later resolve to a reference entity |
| **App-managed state** (operational decisions) | Crew assignments, dock configs — references entities by stable ID, doesn't create identity |
| **Reference data** (game knowledge) | `wiki:officer:<pageId>` — canonical identity with provenance, non-user-editable |

## Decision

### D1: Namespaced ID Strategy

Every entity in the system gets an ID that encodes its **origin namespace**:

| Namespace | Format | Source | Editable? |
|---|---|---|---|
| `wiki:officer:<pageId>` | Wiki-imported reference | ADR-013 ingest pipeline | **No** — ID is immutable once created |
| `wiki:ship:<pageId>` | Wiki-imported reference | ADR-013 ingest pipeline | **No** |
| `user:officer:<uuid>` | User-created local-only | Manual entry UI | **No** — minted at creation, never changes |
| `user:ship:<uuid>` | User-created local-only | Manual entry UI | **No** |

> **Evolution note:** ADR-016 (Catalog-Overlay Model) retires the `roster:*` namespace. With the wiki catalog as the primary entity source and user state stored as an overlay (`officer_overlay`, `ship_overlay`), there is no separate "roster entity" — an owned officer is a `wiki:*` reference entry with an overlay row. The `user:*` namespace remains for entities not yet in any reference catalog.

**Key invariant:** IDs are non-user-editable once created. The display name can change; the identity anchor cannot. This is the same principle as database surrogate keys — the ID is for the system, the name is for the human.

**Namespace semantics:**
- `wiki:*` — Backed by a reference record with full provenance. MicroRunner can resolve these deterministically for T2 context injection. These are the "canonical" entities.
- `roster:*` — Imported from the user's spreadsheet without reference backing. May later be **linked** to a `wiki:*` identity when reference data becomes available.
- `user:*` — Explicitly user-created. Never pretends to be T2 reference data. Clearly local-only.

### D2: Reference Entity Schema

A new `reference_officers` table (and eventually `reference_ships`) stores the canonical reference data imported from the wiki. This is the T2 reference tier — separate from the user's roster.

```sql
CREATE TABLE IF NOT EXISTS reference_officers (
  id TEXT PRIMARY KEY,                    -- 'wiki:officer:<pageId>'
  name TEXT NOT NULL,
  rarity TEXT,
  group_name TEXT,
  captain_maneuver TEXT,
  officer_ability TEXT,
  below_deck_ability TEXT,

  -- Provenance chain (from wiki export metadata)
  source TEXT NOT NULL,                   -- 'stfc-fandom-wiki'
  source_url TEXT,                        -- 'https://star-trek-fleet-command.fandom.com/wiki/Officers'
  source_page_id TEXT,                    -- MediaWiki page ID
  source_revision_id TEXT,               -- MediaWiki revision ID
  source_revision_timestamp TEXT,        -- ISO timestamp of the revision

  -- CC BY-SA 3.0 compliance
  license TEXT NOT NULL DEFAULT 'CC BY-SA 3.0',
  attribution TEXT NOT NULL DEFAULT 'Community contributors to the Star Trek: Fleet Command Wiki',

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ref_officers_name ON reference_officers(name);
```

**Why a separate table?** The `officers` table in fleet-store.ts holds the user's roster — their specific officers, levels, crew assignments. The `reference_officers` table holds canonical game knowledge. These are fundamentally different concerns:
- Roster: "My Khan is level 45, assigned to Dock 3"
- Reference: "Khan's Captain Maneuver is 'Fury of the Augment' — increases attack damage by X%"

Keeping them separate prevents the "who owns this row?" confusion and lets reference data be wiped/re-imported without touching the user's operational state.

### D3: Roster-to-Reference Entity Linking

When both roster and reference data exist for the same entity, they should be linked:

```sql
ALTER TABLE officers ADD COLUMN ref_id TEXT REFERENCES reference_officers(id);
ALTER TABLE ships ADD COLUMN ref_id TEXT REFERENCES reference_ships(id);
```

The `ref_id` column on the roster entity is nullable — not every roster officer will have a reference match (the user might have officers the wiki doesn't cover). When present, it enables:

- **MicroRunner T2 injection:** `lookupOfficer("Khan")` → finds roster officer → follows `ref_id` → injects canonical reference data with full provenance.
- **UI enrichment:** Display reference data (ability descriptions, group info) alongside the user's roster data (level, crew assignment).
- **Deterministic joins:** `SELECT r.*, ref.captain_maneuver FROM officers r JOIN reference_officers ref ON r.ref_id = ref.id`

**Link resolution strategy:**
1. **On wiki import:** After inserting reference records, scan the roster for name matches and offer to link them.
2. **On Sheets import:** After creating roster entries, check for reference matches and auto-link where the name match is unambiguous (exact case-insensitive match, single result).
3. **Manual linking:** UI allows the user to manually link/unlink a roster officer to a reference entity.
4. **Ambiguity handling:** If multiple reference entities match (e.g., "Spock" matches "Spock" and "Spock (SNW)"), do NOT auto-link. Present a disambiguation UI.

### D4: Provenance Flows Into the Reference Entry

The wiki ingest script already captures `pageId`, `revisionId`, and `revisionTimestamp`. These must flow into `reference_officers` at import time:

```
Wiki Special:Export XML
  → parseExportXml() extracts provenance: { pageId, revisionId, revisionTimestamp }
  → parseOfficerTable() produces officers with id = slugify(name)
  → upsertOfficer() stores with:
      id = `wiki:officer:${pageId}`
      source_page_id = pageId
      source_revision_id = revisionId
      source_revision_timestamp = revisionTimestamp
```

**ID derivation:** For wiki-imported entities, the ID uses the **MediaWiki page ID** (not the slugified name). Page IDs are numeric, stable, and assigned by MediaWiki. Even if the wiki page is renamed, the page ID persists. This gives us an immutable anchor.

**Fallback for non-XML imports:** When the user pastes raw wikitext (no XML envelope), there is no page ID. In this case, the ID falls back to `wiki:officer:<slug>` with a `source_page_id = NULL` provenance marker. The next XML-sourced import can upgrade this to the proper page ID.

### D5: MicroRunner Integration — Deterministic Reference Resolution

The MicroRunner's `ContextSources.lookupOfficer()` currently does a name match against the roster. With canonical reference entities, the lookup chain becomes:

```
User says "Tell me about Khan"
  → PromptCompiler detects "Khan" via knownOfficerNames
  → contract.requiredTiers.t2_referencePack = ["khan"]
  → ContextGate calls lookupOfficer("Khan")
    → Step 1: Search reference_officers by name → found wiki:officer:12345
    → Step 2: Also check officers roster for ref_id match → found roster entry with level, assignment
    → Step 3: Return merged ReferenceEntry with full provenance
  → Inject REFERENCE block: 'Officer "Khan" (source: STFC wiki, page 12345, rev 67890, imported 2026-02-09)'
  → Receipt: t2Provenance[0] = { id: "wiki:officer:12345", source: "stfc-fandom-wiki", revision: "67890" }
```

The `ReferenceEntry` interface expands to include provenance:

```typescript
export interface ReferenceEntry {
  id: string;                    // e.g. 'wiki:officer:12345'
  name: string;
  rarity: string | null;
  groupName: string | null;
  captainManeuver?: string | null;
  officerAbility?: string | null;
  belowDeckAbility?: string | null;
  source: string;                // 'stfc-fandom-wiki'
  sourcePageId?: string | null;
  sourceRevisionId?: string | null;
  importedAt: string;
  // Roster data (if linked)
  rosterLevel?: number | null;
  rosterAssignment?: string | null;
}
```

This is clean because the namespace tells the system exactly what kind of entity it's dealing with. A `wiki:*` ID has full T2 provenance. A `roster:*` ID has user data. A `user:*` ID has neither — it's explicitly local.

### D6: The "Add Officer/Ship" UX Changes Shape

With reference entities available locally, the "add officer/ship" UI stops being "manual entry" and becomes:

1. **Search/typeahead from available reference entities (T2):** User types "Kh..." → dropdown shows "Khan", "Khriss", etc. from reference_officers.
2. **Select → prefill known metadata:** Selecting "Khan" prefills name, rarity, group, ability descriptions from the reference record.
3. **Store stable ref_id behind the scenes:** The new roster entry gets `ref_id = 'wiki:officer:12345'` — not editable by the user.
4. **Manual creation in a clearly separate lane:** If the user needs an officer not in the reference data (unlikely for production, useful during early alpha), offer a visually distinct "Create Custom Officer" path that:
   - Mints a `user:officer:<uuid>` ID
   - Cannot set a ref_id (no reference exists)
   - Is clearly labeled in the UI as "Custom (local only)"
   - Does NOT appear in reference_lookup T2 injection (it's not reference data)

This means the common path (adding a known officer to your roster) is fast and correct — no typos, no ambiguity, stable identity from day one.

### D7: About the "Scopely ID" Dream

If the XML export or a future API ever exposes a Scopely/internal ID, treat it as an **optional external_id field** that can be backfilled:

```sql
ALTER TABLE reference_officers ADD COLUMN external_id TEXT;
ALTER TABLE reference_ships ADD COLUMN external_id TEXT;
-- e.g. external_id = 'scopely:officer:a1b2c3d4'
```

This is additive — don't block on it. The wiki-provenance IDs already give us stable identity right now. If Scopely IDs arrive later, they slot in as a higher-authority external key without disrupting the existing namespace.

### D8: Clean Break from Slugified IDs

> **Project age context:** Majel is ~24 hours old. There are zero external users, zero production databases, and zero backwards compatibility obligations. We do not write migration code for a schema that has never shipped. We just build it right.

Existing data uses slugified name IDs (`khan`, `uss-saladin`). The implementation:

1. **Rewrite the schema directly.** The `officers` and `ships` tables get `ref_id` columns and namespaced IDs from the start. No `ALTER TABLE`, no migration scripts, no version checks — just the correct `CREATE TABLE`.
2. **Create `reference_officers` table** alongside the existing roster tables.
3. **Update `importFromFleetData()`** to mint `roster:officer:<slug>` IDs instead of bare slugs.
4. **Wiki sync module** (`src/server/wiki-ingest.ts`) mints `wiki:officer:<slug>` and `wiki:ship:<slug>` IDs and writes to reference tables.
5. **Drop and re-import** any test data. There is nothing to preserve.

If anyone has a local `.smartergpt/lex/fleet.db` from development testing, they delete it and re-import. That's the entire migration story.

## Consequences

### Positive
- **Identity is stable from day one.** No "rename Khan and everything breaks" scenarios.
- **MicroRunner gets deterministic resolution.** `reference_lookup` resolves to a canonical ID with provenance, not a name-match guess.
- **Reference packs join cleanly.** `ref_id` gives a FK into T2 reference data for any roster entity.
- **Custom entities are clearly scoped.** A `user:*` ID can never be confused with a `wiki:*` reference.
- **Open alpha data hygiene.** Early adopters' SQLite databases won't accumulate irreversible identity weirdness that we have to untangle later.
- **Provenance auditable end-to-end.** From wiki XML export → reference table → ref_id link → MicroRunner receipt — the chain is unbroken.

### Negative
- **Two-table model for officers/ships.** Developers must understand "roster officer" vs "reference officer" — more concepts to hold in memory.
- **Wiki sync is built-in.** `POST /api/catalog/sync` handles wiki import directly — no external script dependency.
- **Typeahead UX requires reference data.** If the user hasn't imported wiki data yet, the "pick from reference" flow has nothing to offer — falls back to the custom entry lane.

### Risks
- **Page ID stability assumption:** We assume MediaWiki page IDs are stable. They are in practice (they're database PKs) but could theoretically change if a wiki is rebuilt. The `source_revision_id` provides a secondary anchor.

## Phases

| Phase | Scope | Depends On |
|---|---|---|
| **Phase 1: Schema** | Rewrite `officers`/`ships` tables with namespaced IDs + `ref_id` column, create `reference_officers` table. No migration — clean break. | This ADR accepted |
| **Phase 2: Ingest Update** | Wiki sync module stores provenance in reference tables, uses slug-based namespaced IDs | Phase 1 |
| **Phase 3: Linking** | Auto-link roster entities to reference entities on import, manual link/unlink UI | Phase 2 |
| **Phase 4: MicroRunner Upgrade** | `lookupOfficer()` resolves via `ref_id` chain, enriched `ReferenceEntry` with full provenance | Phase 2 |
| **Phase 5: UX — Reference Typeahead** | "Add officer" becomes search-from-reference with prefill, separate custom lane | Phase 3 |

## References

- **ADR-003** — Epistemic Framework (authority ladder that MicroRunner enforces)
- **ADR-011** — Data Sovereignty (three-tier model: bootstrap vs app-managed vs reference)
- **ADR-012** — Reference Data (localization template approach — superseded for officers/ships by wiki import, still valid for research trees)
- **ADR-013** — Wiki Data Import (ingest pipeline, provenance tracking, attribution)
- **ADR-014** — MicroRunner (reference_lookup task type, T2 context gating, receipts)
- [fleet-store.ts](../src/server/fleet-store.ts) — Current `slugify()` ID generation, `officers`/`ships` schema
- [app-context.ts](../src/server/app-context.ts) — `lookupOfficer()` name-match implementation
- [micro-runner.ts](../src/server/micro-runner.ts) — `ReferenceEntry` interface, `ContextSources`, T2 provenance
- [wiki-ingest.ts](../src/server/wiki-ingest.ts) — Wiki parser with provenance extraction, sync orchestrator
- [sync-wiki.mjs](../scripts/sync-wiki.mjs) — CLI wrapper for wiki sync
