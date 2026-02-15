/**
 * gamedata-ingest.ts — Structured Game Data Officer Ingest (#55)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Reads `data/raw-officers.json` (extracted from the STFC community cheat sheet)
 * and bulk-upserts into the reference_officers table.
 *
 * Replaces wiki-ingest.ts — no network dependency, no XML/wikitext parsing.
 * Data source: STFC Cheat Sheet (M86 1.4RC), 277 officers with structured
 * ability data, activity tags, and stable numeric game IDs.
 * Also ingests ship data from data/raw-ships.json (1337wiki ship guide).
 */

import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceStore, CreateReferenceOfficerInput, CreateReferenceShipInput } from "../stores/reference-store.js";
import { log } from "../logger.js";

// ─── Types ──────────────────────────────────────────────────

interface RawAbility {
  type: string;
  modifier: string | null;
  conditions: string | null;
  trigger: string | null;
  target: string | null;
  operation: string | null;
  attributes: string | null;
  description: string | null;
  descriptionShort: string | null;
  hasChance: boolean;
  showPercentage: boolean;
  chances: number[];
  values: number[];
}

interface RawOfficer {
  name: string | number;
  officerId: number;
  rarity: string;
  synergy: string | null;
  art: number | null;
  abilities: Record<string, RawAbility>;
  tags: Record<string, { rating: string; reason: string | null }>;
}

// ─── Name Normalization ─────────────────────────────────────

/**
 * Convert ALL CAPS name to Title Case.
 * "KIRK" → "Kirk", "BECKETT MARINER" → "Beckett Mariner", "KHAN" → "Khan"
 * Preserves known abbreviations and numeric names.
 */
function toTitleCase(name: string): string {
  if (!name) return name;
  return name
    .toLowerCase()
    .replace(/(?:^|\s)\S/g, (ch) => ch.toUpperCase());
}

/**
 * Generate a stable ID from the numeric game ID.
 * Format: `raw:officer:<officerId>` (e.g. `raw:officer:988947581`)
 */
function makeOfficerId(officerId: number): string {
  return `raw:officer:${officerId}`;
}

/**
 * Build a plain-text ability description for backward compatibility.
 * Used for the captainManeuver/officerAbility/belowDeckAbility text columns.
 */
function abilityToText(ability: RawAbility | undefined): string | null {
  if (!ability) return null;
  return ability.description ?? ability.descriptionShort ?? null;
}

// ─── Ingest ─────────────────────────────────────────────────

/**
 * Load the bundled raw-officers.json and bulk upsert into the reference store.
 *
 * @returns Summary with counts and metadata.
 */
export async function syncGamedataOfficers(
  store: ReferenceStore,
): Promise<{ officers: { created: number; updated: number; total: number }; source: string }> {
  // Resolve path relative to project root (data/raw-officers.json)
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const dataPath = join(projectRoot, "data", "raw-officers.json");

  log.fleet.info({ path: dataPath }, "loading game data officers");

  const raw = await readFile(dataPath, "utf-8");
  const rawOfficers: RawOfficer[] = JSON.parse(raw);

  const inputs: CreateReferenceOfficerInput[] = rawOfficers
    .filter((o) => o.name && o.officerId)
    .map((o) => {
      const name = typeof o.name === "number" ? String(o.name).padStart(4, "0") : String(o.name);
      const displayName = toTitleCase(name);
      const groupName = o.synergy ? toTitleCase(o.synergy) : null;

      return {
        id: makeOfficerId(o.officerId),
        name: displayName,
        rarity: o.rarity?.toLowerCase() ?? null,
        groupName,
        captainManeuver: abilityToText(o.abilities?.captainManeuver),
        officerAbility: abilityToText(o.abilities?.officerAbility),
        belowDeckAbility: abilityToText(o.abilities?.belowDeckAbility),
        abilities: o.abilities ?? null,
        tags: o.tags ?? null,
        officerGameId: o.officerId,
        source: "gamedata",
        sourceUrl: null,
        sourcePageId: null,
        sourceRevisionId: null,
        sourceRevisionTimestamp: null,
      };
    });

  log.fleet.info({ count: inputs.length }, "parsed game data officers, starting bulk upsert");
  const result = await store.bulkUpsertOfficers(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "game data officer sync complete",
  );

  return {
    officers: { ...result, total: inputs.length },
    source: "STFC Cheat Sheet (M86 1.4RC)",
  };
}

// ═══════════════════════════════════════════════════════════
// Ship Ingest (1337wiki ship guide)
// ═══════════════════════════════════════════════════════════

interface RawShipAbility {
  name: string;
  description: string;
}

interface RawShip {
  name: string;
  link: string | null;
  ability: RawShipAbility;
  grade: number | null;
  shipClass: string;
  faction: string;
  rarity: string;
  warpRange: number[] | null;
}

/**
 * Generate a stable ID from the ship name.
 * Format: `raw:ship:<slug>` (e.g. `raw:ship:uss-enterprise`)
 */
function makeShipId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `raw:ship:${slug}`;
}

/**
 * Load the bundled raw-ships.json and bulk upsert into the reference store.
 *
 * @returns Summary with counts and metadata.
 */
export async function syncGamedataShips(
  store: ReferenceStore,
): Promise<{ ships: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const dataPath = join(projectRoot, "data", "raw-ships.json");

  log.fleet.info({ path: dataPath }, "loading game data ships");

  const raw = await readFile(dataPath, "utf-8");
  const rawShips: RawShip[] = JSON.parse(raw);

  const inputs: CreateReferenceShipInput[] = rawShips
    .filter((s) => s.name)
    .map((s) => ({
      id: makeShipId(s.name),
      name: s.name,
      shipClass: s.shipClass || null,
      grade: s.grade ?? null,
      rarity: s.rarity?.toLowerCase() ?? null,
      faction: s.faction || null,
      tier: null, // tier is per-player progression, not a static property
      ability: (s.ability as unknown as Record<string, unknown>) ?? null,
      warpRange: s.warpRange ?? null,
      link: s.link ?? null,
      source: "1337wiki",
      sourceUrl: s.link ?? "https://star-trek-fleet-command.1337wiki.com/ship-guide/",
      sourcePageId: null,
      sourceRevisionId: null,
      sourceRevisionTimestamp: null,
    }));

  log.fleet.info({ count: inputs.length }, "parsed game data ships, starting bulk upsert");
  const result = await store.bulkUpsertShips(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "game data ship sync complete",
  );

  return {
    ships: { ...result, total: inputs.length },
    source: "1337wiki ship guide",
  };
}
