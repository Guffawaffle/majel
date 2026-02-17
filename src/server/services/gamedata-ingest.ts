/**
 * gamedata-ingest.ts — Structured Game Data Ingest (#55, #74)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Reads from two sources:
 * 1. data/raw-officers.json + data/raw-ships.json (legacy cheat-sheet/wiki data)
 * 2. data/.stfc-snapshot/ (CDN snapshot from data.stfc.space — full game data)
 *
 * CDN data is richer: hull types, officer bonuses, build costs, tier/level curves,
 * crew slots, trait configs, ability values. CDN entities use `cdn:ship:<gameId>`
 * and `cdn:officer:<gameId>` IDs to coexist with legacy `raw:*` entries.
 */

import { readFile, access } from "node:fs/promises";
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

// ═══════════════════════════════════════════════════════════
// CDN Ingest (data.stfc.space snapshot — ADR-028 Phase 1)
// ═══════════════════════════════════════════════════════════

// ─── Enum Maps ──────────────────────────────────────────────

const HULL_TYPE_NAMES: Record<number, string> = {
  0: "Destroyer",
  1: "Survey",
  2: "Explorer",
  3: "Battleship",
  4: "Defense",
  5: "Armada",
};

const RARITY_NAMES: Record<number, string> = {
  0: "base",
  1: "common",
  2: "uncommon",
  3: "rare",
  4: "epic",
};

const OFFICER_CLASS_NAMES: Record<number, string> = {
  1: "Command",
  2: "Science",
  3: "Engineering",
};

const FACTION_NAMES: Record<number, string> = {
  2064723306: "Federation",
  4153667145: "Klingon",
  669838839: "Romulan",
  2489857622: "Swarm",
  2943562711: "Borg",
  1750120904: "Eclipse",
  2143656960: "Rogue",
  157476182: "Assimilated",
};

// ─── CDN Translation Helpers ────────────────────────────────

interface TranslationEntry {
  id: number | null;
  key: string;
  text: string;
}

/**
 * Load a translation pack from the CDN snapshot.
 * Returns a map of (loca_id, key) → text.
 */
async function loadTranslationPack(
  snapshotDir: string,
  pack: string,
): Promise<TranslationEntry[]> {
  const path = join(snapshotDir, "translations", "en", `${pack}.json`);
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as TranslationEntry[];
  } catch {
    log.fleet.warn({ pack, path }, "CDN translation pack not found, skipping");
    return [];
  }
}

/**
 * Build a name lookup: loca_id → translated name.
 */
function buildNameMap(entries: TranslationEntry[], nameKey: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const e of entries) {
    if (e.id != null && e.key === nameKey) {
      map.set(e.id, e.text);
    }
  }
  return map;
}

/**
 * Build an ability text lookup: loca_id → { name, description, shortDescription }.
 */
function buildAbilityTextMap(entries: TranslationEntry[]): Map<number, { name: string; description: string; shortDescription: string }> {
  const map = new Map<number, { name: string; description: string; shortDescription: string }>();
  for (const e of entries) {
    if (e.id == null) continue;
    const existing = map.get(e.id) ?? { name: "", description: "", shortDescription: "" };
    if (e.key === "officer_ability_name") existing.name = e.text;
    else if (e.key === "officer_ability_desc") existing.description = stripColorTags(e.text);
    else if (e.key === "officer_ability_short_desc") existing.shortDescription = stripColorTags(e.text);
    map.set(e.id, existing);
  }
  return map;
}

/** Strip <color=...>...</color> tags from translated text. */
function stripColorTags(text: string): string {
  return text.replace(/<\/?color[^>]*>/gi, "").trim();
}

// ─── CDN Types ──────────────────────────────────────────────

interface CdnShipSummary {
  id: number;
  art_id: number;
  loca_id: number;
  max_tier: number;
  rarity: string;
  grade: number;
  hull_type: number;
  faction: { id: number; loca_id: number } | null;
}

interface CdnShipDetail {
  id: number;
  art_id: number;
  loca_id: number;
  max_tier: number;
  rarity: string;
  grade: number;
  hull_type: number;
  max_level: number;
  build_time_in_seconds: number;
  faction: { id: number; loca_id: number } | null;
  build_cost: Array<{ resource_id: number; amount: number }>;
  officer_bonus: Record<string, Array<{ value: number; bonus: number }>>;
  crew_slots: Array<{ slots: string; unlock_level: number }>;
  levels: Array<{ level: number; xp: number; shield: number; health: number }>;
  ability: Array<{ id: number; value_is_percentage: boolean; values: Array<{ value: number; chance: number }> }>;
}

interface CdnOfficerSummary {
  id: number;
  art_id: number;
  loca_id: number;
  faction: { id: number; loca_id: number } | null;
  rarity: number;
  synergy_id: number;
  max_rank: number;
  ability: { id: number; loca_id: number; value_is_percentage: boolean; values: Array<{ value: number; chance: number }> } | null;
  captain_ability: { id: number; loca_id: number; value_is_percentage: boolean; values: Array<{ value: number; chance: number }> } | null;
  below_decks_ability: { id: number; loca_id: number; value_is_percentage: boolean; values: Array<{ value: number; chance: number }> } | null;
  class: number;
}

interface CdnOfficerDetail extends CdnOfficerSummary {
  levels: Array<{ level: number; xp: number }>;
  stats: Array<{ level: number; attack: number; defense: number; health: number }>;
  ranks: Array<{ rank: number; max_level: number; shards_required: number }>;
  trait_config: { progression: Array<{ required_rank: number; trait_id: number }>; traits: unknown[] } | null;
}

// ─── CDN Ship Ingest ────────────────────────────────────────

/**
 * Sync ships from CDN snapshot (data/.stfc-snapshot/).
 * Reads summary.json + optional detail files + translations.
 * Uses `cdn:ship:<gameId>` as the entity ID.
 */
export async function syncCdnShips(
  store: ReferenceStore,
): Promise<{ ships: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  // Check snapshot exists
  try {
    await access(join(snapshotDir, "ship", "summary.json"));
  } catch {
    log.fleet.warn("CDN ship snapshot not found, skipping CDN ship sync");
    return { ships: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN ship snapshot");

  // Load summary + translations
  const summaryRaw = await readFile(join(snapshotDir, "ship", "summary.json"), "utf-8");
  const summary: CdnShipSummary[] = JSON.parse(summaryRaw);

  const shipTranslations = await loadTranslationPack(snapshotDir, "ships");
  const nameMap = buildNameMap(shipTranslations, "ship_name");
  const abilityNameMap = buildNameMap(shipTranslations, "ship_ability_name");
  const abilityDescMap = buildNameMap(shipTranslations, "ship_ability_desc");

  const inputs: CreateReferenceShipInput[] = [];

  for (const ship of summary) {
    const name = nameMap.get(ship.loca_id) ?? `Ship ${ship.id}`;
    const factionId = ship.faction?.id ?? null;
    const factionName = factionId != null ? (FACTION_NAMES[factionId] ?? null) : null;
    const hullTypeName = HULL_TYPE_NAMES[ship.hull_type] ?? null;
    const rarityStr = typeof ship.rarity === "string" ? ship.rarity.toLowerCase() : (RARITY_NAMES[ship.rarity as unknown as number] ?? null);

    // Try to load detail file
    let detail: CdnShipDetail | null = null;
    try {
      const detailRaw = await readFile(join(snapshotDir, "ship", `${ship.id}.json`), "utf-8");
      detail = JSON.parse(detailRaw) as CdnShipDetail;
    } catch {
      // Detail not downloaded — use summary-only
    }

    // Build ability object with translated names
    let ability: Record<string, unknown> | null = null;
    if (detail?.ability?.[0]) {
      const a = detail.ability[0];
      ability = {
        name: abilityNameMap.get(ship.loca_id) ?? null,
        description: abilityDescMap.get(ship.loca_id) ?? null,
        valueIsPercentage: a.value_is_percentage,
        values: a.values,
      };
    }

    inputs.push({
      id: `cdn:ship:${ship.id}`,
      name,
      shipClass: hullTypeName,
      grade: ship.grade,
      rarity: rarityStr,
      faction: factionName,
      tier: null,
      ability,
      warpRange: null,
      link: `https://stfc.space/ships/${ship.id}`,
      hullType: ship.hull_type,
      buildTimeInSeconds: detail?.build_time_in_seconds ?? null,
      maxTier: detail?.max_tier ?? ship.max_tier,
      maxLevel: detail?.max_level ?? null,
      officerBonus: detail?.officer_bonus ?? null,
      crewSlots: detail?.crew_slots ?? null,
      buildCost: detail?.build_cost ?? null,
      levels: detail?.levels ?? null,
      gameId: ship.id,
      source: "cdn:data.stfc.space",
      sourceUrl: `https://data.stfc.space/ship/${ship.id}.json`,
      sourcePageId: null,
      sourceRevisionId: null,
      sourceRevisionTimestamp: null,
    });
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN ships, starting bulk upsert");
  const result = await store.bulkUpsertShips(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN ship sync complete",
  );

  return {
    ships: { ...result, total: inputs.length },
    source: "data.stfc.space CDN",
  };
}

// ─── CDN Officer Ingest ─────────────────────────────────────

/**
 * Sync officers from CDN snapshot (data/.stfc-snapshot/).
 * Reads summary.json + optional detail files + translations.
 * Uses `cdn:officer:<gameId>` as the entity ID.
 */
export async function syncCdnOfficers(
  store: ReferenceStore,
): Promise<{ officers: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  // Check snapshot exists
  try {
    await access(join(snapshotDir, "officer", "summary.json"));
  } catch {
    log.fleet.warn("CDN officer snapshot not found, skipping CDN officer sync");
    return { officers: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN officer snapshot");

  // Load summary + translations
  const summaryRaw = await readFile(join(snapshotDir, "officer", "summary.json"), "utf-8");
  const summary: CdnOfficerSummary[] = JSON.parse(summaryRaw);

  const officerNames = await loadTranslationPack(snapshotDir, "officer_names");
  const officerBuffs = await loadTranslationPack(snapshotDir, "officer_buffs");
  const nameMap = buildNameMap(officerNames, "officer_name");
  const abilityTextMap = buildAbilityTextMap(officerBuffs);

  // Load faction translations for names
  const factionTrans = await loadTranslationPack(snapshotDir, "factions");
  const factionNameMap = buildNameMap(factionTrans, "faction_name");

  // Load trait translations
  const traitTrans = await loadTranslationPack(snapshotDir, "traits");
  const traitNameMap = buildNameMap(traitTrans, "trait_name");

  const inputs: CreateReferenceOfficerInput[] = [];

  for (const officer of summary) {
    const name = nameMap.get(officer.loca_id) ?? `Officer ${officer.id}`;
    const factionId = officer.faction?.id ?? null;
    const factionName = factionId != null ? (FACTION_NAMES[factionId] ?? factionNameMap.get(officer.faction!.loca_id) ?? null) : null;
    const rarityStr = RARITY_NAMES[officer.rarity] ?? String(officer.rarity);
    const className = OFFICER_CLASS_NAMES[officer.class] ?? null;

    // Get ability text from translations
    const cmText = officer.captain_ability?.loca_id != null ? abilityTextMap.get(officer.captain_ability.loca_id) : null;
    const oaText = officer.ability?.loca_id != null ? abilityTextMap.get(officer.ability.loca_id) : null;
    const bdText = officer.below_decks_ability?.loca_id != null ? abilityTextMap.get(officer.below_decks_ability.loca_id) : null;

    // Try to load detail file for trait config
    let detail: CdnOfficerDetail | null = null;
    try {
      const detailRaw = await readFile(join(snapshotDir, "officer", `${officer.id}.json`), "utf-8");
      detail = JSON.parse(detailRaw) as CdnOfficerDetail;
    } catch {
      // Detail not downloaded — use summary-only
    }

    // Build structured abilities object
    const abilities: Record<string, unknown> = {};
    if (officer.captain_ability) {
      abilities.captainManeuver = {
        name: cmText?.name ?? null,
        description: cmText?.description ?? null,
        shortDescription: cmText?.shortDescription ?? null,
        valueIsPercentage: officer.captain_ability.value_is_percentage,
        values: officer.captain_ability.values,
      };
    }
    if (officer.ability) {
      abilities.officerAbility = {
        name: oaText?.name ?? null,
        description: oaText?.description ?? null,
        shortDescription: oaText?.shortDescription ?? null,
        valueIsPercentage: officer.ability.value_is_percentage,
        values: officer.ability.values,
      };
    }
    if (officer.below_decks_ability) {
      abilities.belowDeckAbility = {
        name: bdText?.name ?? null,
        description: bdText?.description ?? null,
        shortDescription: bdText?.shortDescription ?? null,
        valueIsPercentage: officer.below_decks_ability.value_is_percentage,
        values: officer.below_decks_ability.values,
      };
    }

    // Build trait config with resolved names
    let traitConfig: Record<string, unknown> | null = null;
    if (detail?.trait_config) {
      traitConfig = {
        progression: detail.trait_config.progression.map(p => ({
          requiredRank: p.required_rank,
          traitId: p.trait_id,
          traitName: traitNameMap.get(p.trait_id) ?? null,
        })),
      };
    }

    inputs.push({
      id: `cdn:officer:${officer.id}`,
      name,
      rarity: rarityStr,
      groupName: className,
      captainManeuver: cmText?.shortDescription ?? cmText?.description ?? null,
      officerAbility: oaText?.shortDescription ?? oaText?.description ?? null,
      belowDeckAbility: bdText?.shortDescription ?? bdText?.description ?? null,
      abilities,
      tags: null, // CDN doesn't have activity tags (those come from the cheat sheet)
      officerGameId: officer.id,
      officerClass: officer.class,
      faction: factionId != null ? { id: factionId, name: factionName } : null,
      synergyId: officer.synergy_id,
      maxRank: officer.max_rank ?? detail?.max_rank ?? null,
      traitConfig,
      source: "cdn:data.stfc.space",
      sourceUrl: `https://data.stfc.space/officer/${officer.id}.json`,
      sourcePageId: null,
      sourceRevisionId: null,
      sourceRevisionTimestamp: null,
    });
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN officers, starting bulk upsert");
  const result = await store.bulkUpsertOfficers(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN officer sync complete",
  );

  return {
    officers: { ...result, total: inputs.length },
    source: "data.stfc.space CDN",
  };
}
