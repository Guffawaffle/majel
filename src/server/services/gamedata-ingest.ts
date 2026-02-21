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
    return raw.trim() || null;
  } catch {
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
    // Try to load detail file
    let detail: CdnShipDetail | null = null;
    try {
      const detailRaw = await readFile(join(snapshotDir, "ship", `${ship.id}.json`), "utf-8");
      detail = JSON.parse(detailRaw) as CdnShipDetail;
    } catch {
      // Detail not downloaded — use summary-only
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
    } catch {
      // Detail not downloaded — use summary-only
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
