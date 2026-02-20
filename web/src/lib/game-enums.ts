/**
 * Game enum constants and formatting helpers.
 * Ported from src/client/utils/game-enums.js
 */

// ─── Hull Types ─────────────────────────────────────────────

export const HULL_TYPE_LABELS: Record<number, string> = {
  0: "Destroyer",
  1: "Survey",
  2: "Explorer",
  3: "Battleship",
  4: "Defense Platform",
  5: "Armada",
};

export function hullTypeLabel(id: number | null | undefined): string {
  if (id == null) return "Unknown";
  return HULL_TYPE_LABELS[id] ?? `Hull ${id}`;
}

// ─── Officer Classes ────────────────────────────────────────

export const OFFICER_CLASS_LABELS: Record<number, string> = {
  1: "Command",
  2: "Science",
  3: "Engineering",
};

export const OFFICER_CLASS_SHORT: Record<number, string> = {
  1: "CMD",
  2: "SCI",
  3: "ENG",
};

export function officerClassLabel(id: number | null | undefined): string {
  if (id == null) return "Unknown";
  return OFFICER_CLASS_LABELS[id] ?? `Class ${id}`;
}

export function officerClassShort(id: number | null | undefined): string {
  if (id == null) return "?";
  return OFFICER_CLASS_SHORT[id] ?? `C${id}`;
}

// ─── Officer Class CSS ──────────────────────────────────────

/** Returns a CSS class name for officer class badges. */
export function officerClassCss(id: number | null | undefined): string {
  switch (id) {
    case 1: return "class-cmd";
    case 2: return "class-sci";
    case 3: return "class-eng";
    default: return "";
  }
}

// ─── Rarity ─────────────────────────────────────────────────

export const RARITY_ORDER: Record<string, number> = {
  common: 0,
  uncommon: 1,
  rare: 2,
  epic: 3,
  legendary: 4,
};

export function rarityRank(rarity: string | null | undefined): number {
  if (!rarity) return -1;
  return RARITY_ORDER[rarity.toLowerCase()] ?? -1;
}

// ─── Formatting ─────────────────────────────────────────────

/** Format a seconds duration as "Xd Yh Zm" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Format a large power number as "42.5M", "1.2B", etc. */
export function formatPower(power: number | null | undefined): string {
  if (power == null) return "—";
  if (power >= 1_000_000_000) return `${(power / 1_000_000_000).toFixed(1)}B`;
  if (power >= 1_000_000) return `${(power / 1_000_000).toFixed(1)}M`;
  if (power >= 1_000) return `${(power / 1_000).toFixed(1)}K`;
  return String(power);
}
