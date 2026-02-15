/**
 * @deprecated Replaced by gamedata-ingest.ts (#55).
 * This module is retained for reference only and is no longer imported by any route.
 * The wiki ingest pipeline was replaced by a structured game data source (raw-officers.json)
 * which provides 277 officers with structured ability data, activity tags, and game IDs.
 *
 * wiki-ingest.ts — Wiki Data Sync (ADR-015 / ADR-016)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * User-initiated sync from the STFC Fandom Wiki via MediaWiki's
 * Special:Export tool. This is NOT a scraper or crawler — it uses
 * the wiki's official export mechanism, triggered by explicit user
 * action (UI button or CLI command).
 *
 * ┌─────────────────────────────────────────────────────────────────┐
 * │  DATA ATTRIBUTION                                              │
 * │                                                                │
 * │  Star Trek: Fleet Command Wiki (Fandom)                        │
 * │  https://star-trek-fleet-command.fandom.com/wiki/Officers      │
 * │  https://star-trek-fleet-command.fandom.com/wiki/Ships          │
 * │                                                                │
 * │  Wiki text is licensed under CC BY-SA 3.0 by its contributors  │
 * │  https://creativecommons.org/licenses/by-sa/3.0/               │
 * │                                                                │
 * │  This tool does NOT bundle or redistribute wiki data.          │
 * │  Data flows: Wiki → User → Local database (never committed).   │
 * │  See ADR-013 for full legal/ethical analysis.                  │
 * └─────────────────────────────────────────────────────────────────┘
 */

import type { ReferenceStore, CreateReferenceOfficerInput, CreateReferenceShipInput } from "../stores/reference-store.js";
import { log } from "../logger.js";

// ─── Constants ──────────────────────────────────────────────

const VERSION = "0.4";
const EXPORT_BASE = "https://star-trek-fleet-command.fandom.com/wiki/Special:Export";
const WIKI_OFFICER_URL = "https://star-trek-fleet-command.fandom.com/wiki/Officers";
const WIKI_SHIP_URL = "https://star-trek-fleet-command.fandom.com/wiki/Ships";
const USER_AGENT = `Majel/${VERSION} (STFC Fleet Tool; local use; github.com/Guffawaffle/majel)`;
const SOURCE_TAG = "stfc-fandom-wiki";

// ─── Types ──────────────────────────────────────────────────

export interface WikiProvenance {
  source: string;
  pageTitle: string;
  pageId: string | null;
  revisionId: string | null;
  revisionTimestamp: string | null;
  sourceUrl: string;
}

export interface ParsedOfficer {
  name: string;
  rarity: string | null;
  group: string | null;
  captainManeuver: string | null;
  officerAbility: string | null;
  belowDeckAbility: string | null;
}

export interface ParsedShip {
  name: string;
  rarity: string | null;
  shipClass: string | null;
  grade: number | null;
}

export interface SyncResult {
  officers: { created: number; updated: number; total: number; parsed: number };
  ships: { created: number; updated: number; total: number; parsed: number };
  provenance: {
    officers: WikiProvenance | null;
    ships: WikiProvenance | null;
  };
}

// ─── Wiki Text Helpers ──────────────────────────────────────

/** Strip wikitext markup — images, links, formatting */
export function cleanWikitext(text: string): string {
  if (!text) return "";
  let s = text;
  // Remove [[File:...]] and image markup (contains | inside brackets)
  s = s.replace(/\[\[File:[^\]]*\]\]/gi, "");
  // Remove style attributes
  s = s.replace(/style="[^"]*"\s*\|/g, "");
  // Remove data- attributes
  s = s.replace(/data-[a-z-]+="[^"]*"\s*\|?/g, "");
  // Simplify [[links]] — [[Page|Display]] → Display, [[Page]] → Page
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2");
  s = s.replace(/\[\[([^\]]*)\]\]/g, "$1");
  // Remove bold/italic markup
  s = s.replace(/'{2,}/g, "");
  // Remove <br> / <br/> tags
  s = s.replace(/<br\s*\/?>/gi, " ");
  // Remove remaining HTML tags
  s = s.replace(/<[^>]*>/g, "");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Generate a stable slug from a name (lowercase, hyphens) */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Normalize rarity strings to Majel's canonical values */
export function normalizeRarity(raw: string): string | null {
  if (!raw) return null;
  const r = raw.trim().toLowerCase();
  // Strip star characters, pipes, wiki markup remnants
  const cleaned = r.replace(/[☆★⭐\|\[\]\s]/g, "").trim();
  if (!cleaned) return null;

  // Exact match
  const map: Record<string, string> = {
    common: "common",
    uncommon: "uncommon",
    rare: "rare",
    epic: "epic",
    legendary: "legendary",
  };
  if (map[cleaned]) return map[cleaned];

  // Partial / prefix match (handles "Uncommon ☆☆" → "uncommon", "Epic" → "epic", etc.)
  for (const [key, value] of Object.entries(map)) {
    if (cleaned.startsWith(key) || cleaned.includes(key)) return value;
  }

  return null;
}

/** Count star characters in a rarity cell to derive grade */
function countStars(raw: string): number | null {
  const stars = (raw.match(/[☆★⭐]/g) || []).length;
  return stars > 0 ? stars : null;
}

// ─── XML Parsing ────────────────────────────────────────────

/**
 * Parse a MediaWiki Special:Export XML document.
 * Extracts wikitext + provenance from the named page.
 */
export function parseExportXml(xmlContent: string, pageName: string): { wikitext: string; provenance: WikiProvenance } {
  const pages: Array<{
    title: string;
    pageId: string;
    revId: string;
    timestamp: string;
    wikitext: string;
  }> = [];

  const pageRegex = /<page>([\s\S]*?)<\/page>/g;
  let match;
  while ((match = pageRegex.exec(xmlContent)) !== null) {
    const block = match[1];
    const title = block.match(/<title>(.*?)<\/title>/)?.[1] || "";
    const pageId = block.match(/<id>(\d+)<\/id>/)?.[1] || "";
    const revId = block.match(/<revision>\s*<id>(\d+)<\/id>/)?.[1] || "";
    const timestamp = block.match(/<timestamp>(.*?)<\/timestamp>/)?.[1] || "";
    const text = block.match(/<text[^>]*>([\s\S]*?)<\/text>/)?.[1] || "";
    // Unescape XML entities
    const wikitext = text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&").replace(/&quot;/g, "\"");
    pages.push({ title, pageId, revId, timestamp, wikitext });
  }

  const targetPage = pages.find(p => p.title === pageName);
  if (!targetPage) {
    const titles = pages.map(p => p.title).join(", ");
    throw new Error(`No "${pageName}" page found in export. Found: ${titles || "(empty)"}`);
  }

  const sourceUrl = pageName === "Officers" ? WIKI_OFFICER_URL : WIKI_SHIP_URL;

  return {
    wikitext: targetPage.wikitext,
    provenance: {
      source: SOURCE_TAG,
      pageTitle: targetPage.title,
      pageId: targetPage.pageId || null,
      revisionId: targetPage.revId || null,
      revisionTimestamp: targetPage.timestamp || null,
      sourceUrl,
    },
  };
}

// ─── Officer Table Parser ───────────────────────────────────

/**
 * Parse the wikitable from the Officers page wikitext.
 * Table columns: Name | Captain Maneuver | Officer Ability | Below Deck Ability | Group | Rarity
 */
export function parseOfficerTable(wikitext: string): ParsedOfficer[] {
  const officers: ParsedOfficer[] = [];

  const tableStart = wikitext.indexOf('{| class="wikitable');
  const tableEnd = wikitext.indexOf("|}", tableStart);
  if (tableStart < 0 || tableEnd < 0) {
    throw new Error("Could not locate officer wikitable in page source");
  }

  const tableText = wikitext.slice(tableStart, tableEnd);
  const rawRows = tableText.split(/\n\|-\s*\n/);

  // First row is the header — skip it
  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i].trim();
    if (!row) continue;

    const cells = row.split(/\n\|/).map(c => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    // Name: first cell. Remove [[File:...]] FIRST (contains | chars)
    let nameCell = cells[0];
    if (nameCell.startsWith("|")) nameCell = nameCell.slice(1);
    nameCell = nameCell.replace(/\[\[File:[^\]]*\]\]/gi, "");
    if (nameCell.includes("|")) {
      const parts = nameCell.split("|");
      nameCell = parts[parts.length - 1];
    }
    const name = cleanWikitext(nameCell).trim();
    if (!name || name.length < 2) continue;

    const rarityRaw = cleanWikitext(cells[cells.length - 1]);
    const groupRaw = cleanWikitext(cells[cells.length - 2]);
    const captainManeuver = cells.length > 2 ? cleanWikitext(cells[1]) : "";
    const officerAbility = cells.length > 3 ? cleanWikitext(cells[2]) : "";
    const belowDeckAbility = cells.length > 5 ? cleanWikitext(cells[3]) : "";

    const rarity = normalizeRarity(rarityRaw);
    const group = groupRaw || null;

    // Skip if rarity couldn't be parsed (probably not an officer row)
    if (!rarity && rarityRaw.toLowerCase() !== "legendary") continue;

    officers.push({
      name,
      rarity,
      group,
      captainManeuver: captainManeuver || null,
      officerAbility: officerAbility || null,
      belowDeckAbility: belowDeckAbility || null,
    });
  }

  // Deduplicate by name (keep first occurrence)
  const seen = new Set<string>();
  return officers.filter(o => {
    const key = slugify(o.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Ship Table Parser ──────────────────────────────────────

/**
 * Parse the wikitable from the Ships page wikitext.
 * Table columns: Ship | Rarity | Shipyard Level | Avg Start Strength | Weapon Type | Type | Best Opponent
 * We extract: name, rarity, shipClass (from "Type"), grade (from star count in rarity)
 */
export function parseShipTable(wikitext: string): ParsedShip[] {
  const ships: ParsedShip[] = [];

  // Find ALL wikitables and parse each (some pages split ships across tables)
  let searchPos = 0;
  while (true) {
    const tableStart = wikitext.indexOf('{| class="wikitable', searchPos);
    if (tableStart < 0) break;
    const tableEnd = wikitext.indexOf("|}", tableStart);
    if (tableEnd < 0) break;

    const tableText = wikitext.slice(tableStart, tableEnd);
    parseShipTableBlock(tableText, ships);
    searchPos = tableEnd + 2;
  }

  if (ships.length === 0) {
    throw new Error("Could not locate ship wikitable in page source");
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return ships.filter(s => {
    const key = slugify(s.name);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Parse a single wikitable block for ship rows */
function parseShipTableBlock(tableText: string, ships: ParsedShip[]): void {
  const rawRows = tableText.split(/\n\|-\s*\n/);

  for (let i = 1; i < rawRows.length; i++) {
    const row = rawRows[i].trim();
    if (!row) continue;

    const cells = row.split(/\n\|/).map(c => c.trim()).filter(Boolean);
    if (cells.length < 5) continue;

    // Ship name: first cell
    let nameCell = cells[0];
    if (nameCell.startsWith("|")) nameCell = nameCell.slice(1);
    nameCell = nameCell.replace(/\[\[File:[^\]]*\]\]/gi, "");
    if (nameCell.includes("|")) {
      const parts = nameCell.split("|");
      nameCell = parts[parts.length - 1];
    }
    const name = cleanWikitext(nameCell).trim();
    if (!name || name.length < 2) continue;

    // Rarity: second cell (e.g., "Common ☆", "Rare ☆☆☆")
    const rarityRaw = cleanWikitext(cells[1]);
    const rarity = normalizeRarity(rarityRaw);
    if (!rarity) continue; // Skip non-ship rows (header remnants, empty rows)

    // Grade from star count
    const grade = countStars(cells[1]);

    // Ship class (Type): typically column index 5
    // Try to find known class names in later columns
    let shipClass: string | null = null;
    const classNames = ["explorer", "interceptor", "battleship", "survey", "armada"];
    for (let c = 2; c < cells.length; c++) {
      const cellText = cleanWikitext(cells[c]).trim().toLowerCase();
      if (classNames.includes(cellText)) {
        shipClass = cellText.charAt(0).toUpperCase() + cellText.slice(1);
        break;
      }
    }

    ships.push({ name, rarity, shipClass, grade });
  }
}

// ─── Fetch from Wiki ────────────────────────────────────────

/**
 * Download a page from Fandom's Special:Export tool.
 * This is the wiki's official data export mechanism.
 */
export async function fetchWikiExport(pageName: string): Promise<string> {
  const url = `${EXPORT_BASE}?pages=${encodeURIComponent(pageName)}&curonly=1&templates=1`;
  log.fleet.info({ url, userAgent: USER_AGENT }, `fetching wiki export: ${pageName}`);

  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT },
  });

  if (!res.ok) {
    throw new Error(`Special:Export returned HTTP ${res.status} for page "${pageName}"`);
  }

  return res.text();
}

// ─── Sync Orchestrator ──────────────────────────────────────

/**
 * Sync reference data from the STFC Fandom Wiki.
 *
 * Fetches Officers and Ships pages via Special:Export, parses the
 * wikitables, and bulk-upserts into the reference store.
 *
 * @param store - The reference store to write into
 * @param options - Which entities to sync (default: both)
 */
export async function syncWikiData(
  store: ReferenceStore,
  options: { officers?: boolean; ships?: boolean } = {}
): Promise<SyncResult> {
  const syncOfficers = options.officers !== false;
  const syncShips = options.ships !== false;

  const result: SyncResult = {
    officers: { created: 0, updated: 0, total: 0, parsed: 0 },
    ships: { created: 0, updated: 0, total: 0, parsed: 0 },
    provenance: { officers: null, ships: null },
  };

  // ── Officers ──────────────────────────────────────────
  if (syncOfficers) {
    log.fleet.info("wiki sync: fetching officers...");
    const xml = await fetchWikiExport("Officers");
    const { wikitext, provenance } = parseExportXml(xml, "Officers");
    result.provenance.officers = provenance;

    const parsed = parseOfficerTable(wikitext);
    result.officers.parsed = parsed.length;
    log.fleet.info({ count: parsed.length, rev: provenance.revisionId }, "wiki sync: parsed officers");

    // Map to CreateReferenceOfficerInput
    const inputs: CreateReferenceOfficerInput[] = parsed.map(o => ({
      id: `wiki:officer:${slugify(o.name)}`,
      name: o.name,
      rarity: o.rarity,
      groupName: o.group,
      captainManeuver: o.captainManeuver,
      officerAbility: o.officerAbility,
      belowDeckAbility: o.belowDeckAbility,
      source: SOURCE_TAG,
      sourceUrl: provenance.sourceUrl,
      sourcePageId: provenance.pageId,
      sourceRevisionId: provenance.revisionId,
      sourceRevisionTimestamp: provenance.revisionTimestamp,
    }));

    const upsertResult = await store.bulkUpsertOfficers(inputs);
    result.officers.created = upsertResult.created;
    result.officers.updated = upsertResult.updated;
    result.officers.total = inputs.length;
  }

  // ── Ships ─────────────────────────────────────────────
  if (syncShips) {
    log.fleet.info("wiki sync: fetching ships...");
    const xml = await fetchWikiExport("Ships");
    const { wikitext, provenance } = parseExportXml(xml, "Ships");
    result.provenance.ships = provenance;

    const parsed = parseShipTable(wikitext);
    result.ships.parsed = parsed.length;
    log.fleet.info({ count: parsed.length, rev: provenance.revisionId }, "wiki sync: parsed ships");

    // Map to CreateReferenceShipInput
    const inputs: CreateReferenceShipInput[] = parsed.map(s => ({
      id: `wiki:ship:${slugify(s.name)}`,
      name: s.name,
      shipClass: s.shipClass,
      grade: s.grade,
      rarity: s.rarity,
      faction: null,  // Not available in the main ships table
      tier: null,      // Not available in the main ships table
      source: SOURCE_TAG,
      sourceUrl: provenance.sourceUrl,
      sourcePageId: provenance.pageId,
      sourceRevisionId: provenance.revisionId,
      sourceRevisionTimestamp: provenance.revisionTimestamp,
    }));

    const upsertResult = await store.bulkUpsertShips(inputs);
    result.ships.created = upsertResult.created;
    result.ships.updated = upsertResult.updated;
    result.ships.total = inputs.length;
  }

  log.fleet.info({
    officers: result.officers,
    ships: result.ships,
  }, "wiki sync complete");

  return result;
}
