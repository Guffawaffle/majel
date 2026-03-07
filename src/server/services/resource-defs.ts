/**
 * resource-defs.ts — Resource Definition Loader (Phase 1, #183)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Loads resource definitions from `.stfc-resources.json` and resolves
 * human-readable names via materials translations. Exposes an immutable
 * `Map<number, ResourceDef>` keyed by game ID.
 *
 * Category derivation from `resource_id` string keys is best-effort v1.
 * Raw `resourceKey` and `gameId` are preserved as source of truth.
 *
 * @see docs/ADR-028-data-pipeline-roadmap.md
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// ─── Types ──────────────────────────────────────────────────

export type ResourceCategory = "ore" | "gas" | "crystal" | "parts" | "currency" | "other";

export interface ResourceDef {
  /** Stable numeric game ID (e.g., 2964093937). Primary key / truth. */
  gameId: number;
  /** Raw resource_id string from game data (e.g., "Resource_G4_Hydrocarbon_Raw"). Truth. */
  resourceKey: string;
  /** Human-readable name from materials translation (e.g., "4★ Raw Gas"). */
  name: string;
  /** Resource grade (0-6). From game data. */
  grade: number;
  /** Rarity tier (1-4). From game data. */
  rarity: number;
  /** Best-effort category derived from resourceKey. Not authoritative. */
  category: ResourceCategory;
  /** Translation loca_id. Preserved for diagnostics. */
  locaId: number;
}

// ─── Raw JSON shape ─────────────────────────────────────────

interface RawResourceEntry {
  id: number;
  grade: number;
  rarity: number;
  resource_id: string;
  art_id: number;
  loca_id: number;
  sorting_index: number;
}

interface TranslationEntry {
  id: number | string | null;
  key: string;
  text: string;
}

// ─── Category Derivation ────────────────────────────────────

/**
 * Best-effort category derivation from the `resource_id` string key.
 * Conservative: only matches known patterns, defaults to "other".
 */
export function deriveCategory(resourceKey: string): ResourceCategory {
  // Normalise to lower for matching
  const lk = resourceKey.toLowerCase();

  if (lk.includes("_ore_")) return "ore";
  if (lk.includes("hydrocarbon")) return "gas";
  if (lk.includes("_crystal_") || lk.endsWith("_crystal")) return "crystal";
  // Careful: "Parts" appears in ship parts too — anchor to mining context
  if (/resource_g\d+_parts_raw/i.test(resourceKey)) return "parts";
  if (lk.includes("latinum") || lk.includes("_token") || lk.includes("_xp")) return "currency";
  return "other";
}

// ─── Loader ─────────────────────────────────────────────────

/**
 * Build a name map from materials translations.
 * Filters to `resource_name` keys and indexes by numeric loca_id.
 */
function buildResourceNameMap(translationEntries: TranslationEntry[]): Map<number, string> {
  const map = new Map<number, string>();
  for (const e of translationEntries) {
    if (e.id != null && e.key === "resource_name") {
      const numId = typeof e.id === "string" ? Number(e.id) : e.id;
      if (!Number.isNaN(numId)) {
        map.set(numId, e.text);
      }
    }
  }
  return map;
}

/**
 * Load resource definitions from snapshot data on disk.
 *
 * @param snapshotDir Absolute path to `data/.stfc-snapshot` (or equivalent).
 *   Expected layout:
 *   - `../../.stfc-resources.json` (relative to snapshotDir → `data/.stfc-resources.json`)
 *   - `translations/en/materials.json`
 *
 * @returns Immutable map of gameId → ResourceDef. Empty map on load failure (never throws).
 */
export function loadResourceDefs(snapshotDir: string): Map<number, ResourceDef> {
  const map = new Map<number, ResourceDef>();

  // Resolve file paths
  const resourcesPath = join(snapshotDir, "..", ".stfc-resources.json");
  const materialsPath = join(snapshotDir, "translations", "en", "materials.json");

  let rawResources: RawResourceEntry[];
  let rawTranslations: TranslationEntry[];

  try {
    const parsed = JSON.parse(readFileSync(resourcesPath, "utf-8"));
    if (!Array.isArray(parsed)) return map;
    rawResources = parsed as RawResourceEntry[];
  } catch {
    // Graceful degradation — return empty map, caller handles guardrail
    return map;
  }

  try {
    const parsed = JSON.parse(readFileSync(materialsPath, "utf-8"));
    rawTranslations = Array.isArray(parsed) ? (parsed as TranslationEntry[]) : [];
  } catch {
    rawTranslations = [];
  }

  const nameMap = buildResourceNameMap(rawTranslations);

  for (const r of rawResources) {
    const name = nameMap.get(r.loca_id) ?? r.resource_id; // fallback to raw key, never null
    map.set(r.id, {
      gameId: r.id,
      resourceKey: r.resource_id,
      name,
      grade: r.grade,
      rarity: r.rarity,
      category: deriveCategory(r.resource_id),
      locaId: r.loca_id,
    });
  }

  return map;
}

// ─── Resolution Helper ──────────────────────────────────────

/** Shape returned by resolveResourceId — safe for JSON serialisation in tool output. */
export interface ResolvedResource {
  id: number;
  name: string;
  grade: number;
  category: ResourceCategory;
  resourceKey: string;
}

/**
 * Resolve a raw numeric resource ID to a human-readable object.
 * Returns a safe fallback for unknown IDs — never throws, never guesses.
 */
export function resolveResourceId(
  gameId: number,
  defs: Map<number, ResourceDef>,
): ResolvedResource {
  const def = defs.get(gameId);
  if (def) {
    return {
      id: def.gameId,
      name: def.name,
      grade: def.grade,
      category: def.category,
      resourceKey: def.resourceKey,
    };
  }
  // Unknown ID — conservative fallback, no guessing
  return {
    id: gameId,
    name: `Unknown resource (${gameId})`,
    grade: -1,
    category: "other",
    resourceKey: `unknown:${gameId}`,
  };
}
