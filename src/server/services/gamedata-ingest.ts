/**
 * gamedata-ingest.ts — Reference Data Ingest (ADR-028)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Source: data/.stfc-snapshot/ (local game data snapshot)
 * CDN data is authoritative: hull types, officer bonuses, build costs, tier/level curves,
 * crew slots, trait configs, ability values. Uses `cdn:ship:<gameId>` and `cdn:officer:<gameId>` IDs.
 */

import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReferenceStore, CreateReferenceOfficerInput, CreateReferenceShipInput } from "../stores/reference-store.js";
import { log } from "../logger.js";
import {
  toTitleCase as sharedToTitleCase,
  formatAbilityDescription,
  mapCdnShipToReferenceInput,
  mapCdnOfficerToReferenceInput,
  mapCdnResearchToReferenceInput,
  mapCdnBuildingToReferenceInput,
  mapCdnHostileToReferenceInput,
  mapCdnConsumableToReferenceInput,
  mapCdnSystemToReferenceInput,
  type CdnResearchSummary,
  type CdnBuildingSummary,
  type CdnHostileSummary,
  type CdnConsumableSummary,
  type CdnSystemSummary,
  type CreateReferenceResearchInput,
  type CreateReferenceBuildingInput,
  type CreateReferenceHostileInput,
  type CreateReferenceConsumableInput,
  type CreateReferenceSystemInput,
} from "./cdn-mappers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..", "..", "..");

/**
 * Read the CDN snapshot version identifier (UUID from data/.stfc-snapshot/version.txt).
 * Returns null if no snapshot exists.
 */
export async function getCdnVersion(): Promise<string | null> {
  const versionPath = join(projectRoot, "data", ".stfc-snapshot", "version.txt");
  try {
    await access(versionPath);
    const raw = await readFile(versionPath, "utf-8");
    const version = raw.trim();
    if (!version) return null;
    // Validate UUID format — reject untrusted/malformed content
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version)) {
      log.fleet.warn({ version: version.slice(0, 80) }, "CDN version.txt is not a valid UUID — ignoring");
      return null;
    }
    return version;
  } catch (err) {
    log.fleet.warn({ err }, "Failed to read CDN version.txt");
    return null;
  }
}

// ─── Name Normalization ─────────────────────────────────────

export const toTitleCase = sharedToTitleCase;

// ═══════════════════════════════════════════════════════════
// CDN Ingest (local snapshot)
// ═══════════════════════════════════════════════════════════

// ─── Enum Maps ──────────────────────────────────────────────

import { HULL_TYPE_LABELS, OFFICER_CLASS_LABELS, RARITY_LABELS, FACTION_LABELS } from "./game-enums.js";

const HULL_TYPE_NAMES = HULL_TYPE_LABELS;
const RARITY_NAMES = RARITY_LABELS;
const OFFICER_CLASS_NAMES = OFFICER_CLASS_LABELS;
const FACTION_NAMES = FACTION_LABELS;

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
  max_level: number;
  rarity: string;
  grade: number;
  hull_type: number;
  blueprints_required: number;
  build_requirements: Array<{ requirement_type: string; requirement_id: number; requirement_level: number }>;
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
  tiers: Array<{
    tier: number;
    buffs: Record<string, number>;
    duration: number;
    components: Array<{
      id: number;
      data: Record<string, unknown>;
      build_cost: Array<{ resource_id: number; amount: number }>;
      build_time_in_seconds: number;
    }>;
  }>;
  blueprints_required: number;
  build_requirements: Array<{ requirement_type: string; requirement_id: number; requirement_level: number }>;
  ability: Array<{ id: number; value_is_percentage: boolean; values: Array<{ value: number; chance: number }> }>;
  scrap?: Array<{ hull_id: number; scrap_time_seconds: number; level: number; resources: Array<{ resource_id: number; amount: number }> }>;
  base_scrap?: Array<{ resource_id: number; amount: number }>;
  scrap_level?: number;
}

interface CdnOfficerSummary {
  id: number;
  art_id: number;
  loca_id: number;
  faction: number | { id: number; loca_id: number } | null;
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
    // Try to load detail file
    let detail: CdnShipDetail | null = null;
    try {
      const detailRaw = await readFile(join(snapshotDir, "ship", `${ship.id}.json`), "utf-8");
      detail = JSON.parse(detailRaw) as CdnShipDetail;
    } catch (err) {
      log.fleet.debug({ err, shipId: ship.id }, "Ship detail not available — using summary only");
    }

    inputs.push(mapCdnShipToReferenceInput({
      ship,
      detail,
      shipNameMap: nameMap,
      shipAbilityNameMap: abilityNameMap,
      shipAbilityDescMap: abilityDescMap,
      hullTypeLabels: HULL_TYPE_NAMES,
      rarityLabels: RARITY_NAMES,
      factionLabels: FACTION_NAMES,
    }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN ships, starting bulk upsert");
  const result = await store.bulkUpsertShips(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN ship sync complete",
  );

  return {
    ships: { ...result, total: inputs.length },
    source: "game-data-cdn",
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
    // Try to load detail file for trait config
    let detail: CdnOfficerDetail | null = null;
    try {
      const detailRaw = await readFile(join(snapshotDir, "officer", `${officer.id}.json`), "utf-8");
      detail = JSON.parse(detailRaw) as CdnOfficerDetail;
    } catch (err) {
      log.fleet.debug({ err, officerId: officer.id }, "Officer detail not available — using summary only");
    }

    inputs.push(mapCdnOfficerToReferenceInput({
      officer,
      detail,
      rarityLabels: RARITY_NAMES,
      officerClassLabels: OFFICER_CLASS_NAMES,
      factionLabels: FACTION_NAMES,
      officerNameMap: nameMap,
      officerAbilityTextMap: abilityTextMap,
      factionNameMap,
      traitNameMap,
      formatAbilityDescription,
    }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN officers, starting bulk upsert");
  const result = await store.bulkUpsertOfficers(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN officer sync complete",
  );

  return {
    officers: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}

// ─── CDN Research Ingest ────────────────────────────────────

/**
 * Sync research from CDN snapshot (data/.stfc-snapshot/).
 * Uses `cdn:research:<gameId>` as the entity ID.
 */
export async function syncCdnResearch(
  store: ReferenceStore,
): Promise<{ research: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  try {
    await access(join(snapshotDir, "research", "summary.json"));
  } catch {
    log.fleet.warn("CDN research snapshot not found, skipping CDN research sync");
    return { research: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN research snapshot");

  const summaryRaw = await readFile(join(snapshotDir, "research", "summary.json"), "utf-8");
  const summary: CdnResearchSummary[] = JSON.parse(summaryRaw);

  const researchTrans = await loadTranslationPack(snapshotDir, "research");
  const nameMap = buildNameMap(researchTrans, "research_project_name");
  const treeNameMap = buildNameMap(researchTrans, "research_tree_name");

  const inputs: CreateReferenceResearchInput[] = [];
  for (const research of summary) {
    inputs.push(mapCdnResearchToReferenceInput({ research, nameMap, treeNameMap }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN research, starting bulk upsert");
  const result = await store.bulkUpsertResearch(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN research sync complete",
  );

  return {
    research: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}

// ─── CDN Building Ingest ────────────────────────────────────

/**
 * Sync buildings from CDN snapshot (data/.stfc-snapshot/).
 * Uses `cdn:building:<gameId>` as the entity ID.
 */
export async function syncCdnBuildings(
  store: ReferenceStore,
): Promise<{ buildings: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  try {
    await access(join(snapshotDir, "building", "summary.json"));
  } catch {
    log.fleet.warn("CDN building snapshot not found, skipping CDN building sync");
    return { buildings: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN building snapshot");

  const summaryRaw = await readFile(join(snapshotDir, "building", "summary.json"), "utf-8");
  const summary: CdnBuildingSummary[] = JSON.parse(summaryRaw);

  const buildingTrans = await loadTranslationPack(snapshotDir, "starbase_modules");
  const nameMap = buildNameMap(buildingTrans, "starbase_module_name");

  const inputs: CreateReferenceBuildingInput[] = [];
  for (const building of summary) {
    inputs.push(mapCdnBuildingToReferenceInput({ building, nameMap }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN buildings, starting bulk upsert");
  const result = await store.bulkUpsertBuildings(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN building sync complete",
  );

  return {
    buildings: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}

// ─── CDN Hostile Ingest ─────────────────────────────────────

/**
 * Sync hostiles from CDN snapshot (data/.stfc-snapshot/).
 * Uses `cdn:hostile:<gameId>` as the entity ID.
 */
export async function syncCdnHostiles(
  store: ReferenceStore,
): Promise<{ hostiles: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  try {
    await access(join(snapshotDir, "hostile", "summary.json"));
  } catch {
    log.fleet.warn("CDN hostile snapshot not found, skipping CDN hostile sync");
    return { hostiles: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN hostile snapshot");

  const summaryRaw = await readFile(join(snapshotDir, "hostile", "summary.json"), "utf-8");
  const summary: CdnHostileSummary[] = JSON.parse(summaryRaw);

  const hostileTrans = await loadTranslationPack(snapshotDir, "navigation");
  const nameMap = buildNameMap(hostileTrans, "marauder_name_only");

  const inputs: CreateReferenceHostileInput[] = [];
  for (const hostile of summary) {
    inputs.push(mapCdnHostileToReferenceInput({ hostile, nameMap, factionLabels: FACTION_NAMES }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN hostiles, starting bulk upsert");
  const result = await store.bulkUpsertHostiles(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN hostile sync complete",
  );

  return {
    hostiles: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}

// ─── CDN Consumable Ingest ──────────────────────────────────

/**
 * Sync consumables from CDN snapshot (data/.stfc-snapshot/).
 * Uses `cdn:consumable:<gameId>` as the entity ID.
 */
export async function syncCdnConsumables(
  store: ReferenceStore,
): Promise<{ consumables: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  try {
    await access(join(snapshotDir, "consumable", "summary.json"));
  } catch {
    log.fleet.warn("CDN consumable snapshot not found, skipping CDN consumable sync");
    return { consumables: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN consumable snapshot");

  const summaryRaw = await readFile(join(snapshotDir, "consumable", "summary.json"), "utf-8");
  const summary: CdnConsumableSummary[] = JSON.parse(summaryRaw);

  const consumableTrans = await loadTranslationPack(snapshotDir, "consumables");
  const nameMap = buildNameMap(consumableTrans, "consumable_name");

  const inputs: CreateReferenceConsumableInput[] = [];
  for (const consumable of summary) {
    inputs.push(mapCdnConsumableToReferenceInput({ consumable, nameMap }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN consumables, starting bulk upsert");
  const result = await store.bulkUpsertConsumables(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN consumable sync complete",
  );

  return {
    consumables: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}

// ─── CDN System Ingest ──────────────────────────────────────

/**
 * Sync systems from CDN snapshot (data/.stfc-snapshot/).
 * Uses `cdn:system:<gameId>` as the entity ID.
 */
export async function syncCdnSystems(
  store: ReferenceStore,
): Promise<{ systems: { created: number; updated: number; total: number }; source: string }> {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const projectRoot = join(moduleDir, "..", "..", "..");
  const snapshotDir = join(projectRoot, "data", ".stfc-snapshot");

  try {
    await access(join(snapshotDir, "system", "summary.json"));
  } catch {
    log.fleet.warn("CDN system snapshot not found, skipping CDN system sync");
    return { systems: { created: 0, updated: 0, total: 0 }, source: "cdn (not available)" };
  }

  log.fleet.info("loading CDN system snapshot");

  const summaryRaw = await readFile(join(snapshotDir, "system", "summary.json"), "utf-8");
  const summary: CdnSystemSummary[] = JSON.parse(summaryRaw);

  const systemTrans = await loadTranslationPack(snapshotDir, "systems");
  const nameMap = buildNameMap(systemTrans, "title");

  const inputs: CreateReferenceSystemInput[] = [];
  for (const system of summary) {
    inputs.push(mapCdnSystemToReferenceInput({ system, nameMap, factionLabels: FACTION_NAMES }));
  }

  log.fleet.info({ count: inputs.length }, "parsed CDN systems, starting bulk upsert");
  const result = await store.bulkUpsertSystems(inputs);

  log.fleet.info(
    { created: result.created, updated: result.updated, total: inputs.length },
    "CDN system sync complete",
  );

  return {
    systems: { ...result, total: inputs.length },
    source: "game-data-cdn",
  };
}
