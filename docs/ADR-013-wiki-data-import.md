# ADR-013: Wiki Reference Data Import — Attribution, Consent & Ingest Architecture

**Status:** Superseded by CDN ingest pipeline (see ADR-015)  
**Date:** 2026-02-09  
**Authors:** Guff, Opie (Claude), with legal guidance from Lex

> **⚠️ Superseded:** The wiki ingest pipeline described here has been fully removed.
> Reference data is now sourced from the STFC CDN (data.stfc.space) via `gamedata-ingest.ts`.
> Legacy `raw:*` IDs have been replaced by `cdn:officer:<gameId>` / `cdn:ship:<gameId>`.
> This ADR is retained for historical context only.

> **Evolution note:** ADR-015 (Canonical Entity Identity) extends this ADR's provenance tracking into a full namespaced ID system. Wiki-imported entities now get `wiki:officer:<slug>` and `wiki:ship:<slug>` IDs, with provenance metadata (page ID, revision ID, timestamp) stored in `reference_officers` and `reference_ships` tables. The ingest pipeline is now `src/server/wiki-ingest.ts`, exposed as `POST /api/catalog/sync` (one-click UI button) and `scripts/sync-wiki.mjs` (CLI wrapper). The old `scripts/ingest-wiki-officers.mjs` has been removed.

## Context

Majel needs officer and ship reference data (names, groups, rarities, ability descriptions) to power intelligent fleet management. ADR-012 proposed localization templates with manual user input. While that's the right *fallback*, the STFC Fandom Wiki already contains a well-maintained [Officers table](https://star-trek-fleet-command.fandom.com/wiki/Officers) and [Ships table](https://star-trek-fleet-command.fandom.com/wiki/Ships) with exactly the fields we need.

### Legal/Ethical Landscape

Lex researched the licensing and access rules. Two separate gates apply:

1. **Content license (CC BY-SA 3.0).** Fandom wiki text is licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). This permits copying and reuse — including in tools — provided we give **attribution** (credit + link) and apply **ShareAlike** if we distribute derivatives. For local-only use this is straightforward. If we ever publish/distribute the parsed dataset, we must include CC BY-SA attribution in that distribution.

2. **Access method (Fandom Terms of Service).** Fandom's ToS prohibit "unauthorized automated means to gather data." However:
   - Fandom's own `robots.txt` allows `/api.php` endpoints.
   - Fandom wikis provide **Special:Export** — a built-in MediaWiki tool explicitly designed for page export. [Help:Importing and exporting pages](https://community.fandom.com/wiki/Help:Importing_and_exporting_pages) states "anyone can use Special:Export."
   - Using a wiki's own export tool is fundamentally different from HTML scraping.

### Validated Export Path

We tested the Special:Export endpoint and confirmed it works via simple HTTP GET:

```
GET https://star-trek-fleet-command.fandom.com/wiki/Special:Export?pages=Officers&curonly=1&templates=1
→ HTTP 200 | 63KB | application/xml; charset=utf-8
→ MediaWiki XML export v0.11 with full wikitext, page ID, revision ID, timestamp
```

Multi-page export (Officers + Ships in one request) also works:

```
POST https://star-trek-fleet-command.fandom.com/wiki/Special:Export
  pages=Officers\nShips  curonly=1  templates=1
→ HTTP 200 | 74KB | Both pages + shared template
```

Each page includes full provenance: page title, page ID, revision ID, revision timestamp, contributor username.

## Decision

### D1: Two Import Paths — Manual Paste (Production) + Export Download (Local)

| Path | Method | For Production? | Description |
|------|--------|-----------------|-------------|
| **Manual paste** | User visits wiki, copies wikitext, pastes into Majel UI | ✅ Yes | No automated access. User performs the copy. |  
| **Export download** | CLI script fetches via Special:Export URL | ⚠️ Local only | Convenience for development and power users. Not enabled in production UI unless Scopely/Fandom grants explicit permission. |

**Rationale:** The manual paste path is unambiguously clean — the user is reading a public web page and copying text, exactly like copying from any website. The export download path uses Fandom's own export tool with a proper User-Agent but sits in a grey area under ToS until explicit permission is obtained. Guff has Scopely contacts and can pursue approval.

### D2: Attribution Is Non-Negotiable

Every import path MUST record and display attribution. This means:

1. **In-database provenance:** Each imported record stores `imported_from = "wiki:stfc-fandom"` (already exists in the schema) plus source page and revision metadata.

2. **In-app Sources panel:** A visible "Data Sources" section accessible from the UI sidebar that displays:
   - Source name: "STFC Fandom Wiki"
   - Source URL: https://star-trek-fleet-command.fandom.com/wiki/Officers
   - License: CC BY-SA 3.0 with link to https://creativecommons.org/licenses/by-sa/3.0/
   - Contributors: "Community contributors to the Star Trek: Fleet Command Wiki"
   - Import timestamp and revision ID
   
3. **CLI output:** The import script prints attribution notice on every run.

4. **Never bundled:** Parsed wiki data is NEVER committed to the repository. The `.gitignore` already excludes `*.db` files. The import script and parser are committed; the data is not. Users pull their own copy.

### D3: MediaWiki XML Is the Canonical Import Format

Whether the user downloads via Special:Export manually or the CLI script fetches it, the **input format** is always MediaWiki XML export v0.11. This gives us:

- **Page-level provenance:** `<title>`, `<id>` (page ID), `<revision><id>` (rev ID), `<timestamp>`
- **Standard schema:** Same XML structure regardless of wiki
- **Templates included:** `templates=1` pulls embedded templates so content is self-contained
- **Current revision only:** `curonly=1` keeps exports small (no history)

The parser reads XML → extracts wikitext → parses wikitables → produces structured officer/ship records. Same parser for both import paths.

### D4: Manual Paste Path — Wikitext Accepted Directly

For users who don't want to deal with XML files:

1. User navigates to `https://star-trek-fleet-command.fandom.com/wiki/Officers?action=edit` (or clicks "Edit source")
2. Copies the wikitext from the edit box
3. Pastes into Majel's import dialog (a textarea in the Fleet Manager view)
4. Majel parses the wikitext table directly (same parser, just skipping the XML envelope)

This requires **zero automated access** — the user is the one reading and copying.

### D5: Export Download Script Architecture

The sync endpoint (`POST /api/catalog/sync`) and CLI wrapper (`scripts/sync-wiki.mjs`) handle wiki data import:

```
# Via UI: Click "Sync Wiki Data" button in the Catalog view

# Via CLI: Trigger the same sync endpoint
node scripts/sync-wiki.mjs
node scripts/sync-wiki.mjs --officers-only
node scripts/sync-wiki.mjs --ships-only
```

The sync:
- Requires explicit consent (UI button click / `consent: true` in API)
- Fetches from Fandom's Special:Export (one request per entity type)
- Uses a descriptive `User-Agent`
- Records provenance (page ID, revision ID, timestamp) per imported record
- Bulk upserts into the reference store (idempotent)

### D6: No Redistribution of Parsed Data

Majel will **never** commit, bundle, or distribute parsed wiki data:
- No seed JSON files containing wiki-sourced content
- No database snapshots in releases
- No "starter pack" downloads

The import tooling (parser + UI) is the product. The data flows from the wiki through the user to their local database. This keeps us firmly within CC BY-SA personal use and avoids ShareAlike obligations.

## Implementation Plan

### Phase 1: Parser + Sync (done)
- `src/server/wiki-ingest.ts` — XML parser, wikitable parsers (officers + ships), sync orchestrator
- `POST /api/catalog/sync` endpoint with consent gate
- "Sync Wiki Data" button in Catalog UI with spinner + toast feedback
- `scripts/sync-wiki.mjs` CLI wrapper
- Attribution notice in wiki-ingest.ts header
- Provenance stored per record (pageId, revisionId, revisionTimestamp)

### Phase 2: API Endpoint + UI (done)
- `POST /api/catalog/sync` accepts `{ consent: true }` and fetches + parses + upserts
- Catalog view has "Sync Wiki Data" button with progress feedback
- Sources panel shows attribution via provenance fields on each record

### Phase 3: Provenance Tracking
- Add `source_page`, `source_revision`, `source_timestamp` columns to officers/ships tables
- Import records per-item provenance from XML metadata
- Sources panel shows "Last synced: [date] from revision [id]"

## Consequences

### Positive
- Full officer/ship catalog available without manual data entry
- Clean attribution chain — wiki contributors properly credited
- Two-path architecture lets us ship manual paste now and add export download later
- Provenance tracking supports audit trail and future re-sync
- No legal exposure — data is never bundled or redistributed

### Negative
- Manual paste UX is slightly clunky (copy source → paste → import)
- Wikitext parsing is fragile if wiki editors change table format
- Need to maintain parser as wiki evolves

### Risks
- Fandom could change Special:Export behavior (unlikely — it's core MediaWiki)
- Wiki table format could change without notice (parser needs robustness)
- Users may not read attribution panel (but it exists for compliance)

### Open Items
- Guff to contact Scopely re: formal permission for automated export in a distributed tool
- Consider whether ship data warrants a separate parser (different table columns)
- Evaluate community data pack model (users share their own exports, not ours)
