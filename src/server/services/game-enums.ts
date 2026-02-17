/**
 * game-enums.ts — STFC Game Data Enum Maps
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Shared numeric ID → human-readable label maps for STFC game data enums.
 * Sourced from stfc.space frontend bundle analysis (index-BwQsOEx7.js).
 *
 * Used by:
 * - gamedata-ingest.ts (CDN snapshot → reference store)
 * - fleet-tools/read-tools.ts (reference store → AI tool responses)
 * - catalog routes (API responses)
 */

/** Ship hull type ID → label (from stfc.space HullType enum). */
export const HULL_TYPE_LABELS: Record<number, string> = {
  0: "Destroyer",
  1: "Survey",
  2: "Explorer",
  3: "Battleship",
  4: "Defense",
  5: "Armada",
};

/** Officer class ID → label. */
export const OFFICER_CLASS_LABELS: Record<number, string> = {
  1: "Command",
  2: "Science",
  3: "Engineering",
};

/** Rarity numeric ID → label (from stfc.space Rarity enum). */
export const RARITY_LABELS: Record<number, string> = {
  0: "base",
  1: "common",
  2: "uncommon",
  3: "rare",
  4: "epic",
};

/** Faction numeric ID → label (from stfc.space). */
export const FACTION_LABELS: Record<number, string> = {
  2064723306: "Federation",
  4153667145: "Klingon",
  669838839: "Romulan",
  2489857622: "Swarm",
  2943562711: "Borg",
  1750120904: "Eclipse",
  2143656960: "Rogue",
  157476182: "Assimilated",
};

/**
 * Resolve a hull type number to its human-readable label.
 * Returns null if the hull type is null/undefined or not in the map.
 */
export function hullTypeLabel(hullType: number | null | undefined): string | null {
  if (hullType == null) return null;
  return HULL_TYPE_LABELS[hullType] ?? null;
}

/**
 * Resolve an officer class number to its human-readable label.
 * Returns null if the class is null/undefined or not in the map.
 */
export function officerClassLabel(officerClass: number | null | undefined): string | null {
  if (officerClass == null) return null;
  return OFFICER_CLASS_LABELS[officerClass] ?? null;
}
