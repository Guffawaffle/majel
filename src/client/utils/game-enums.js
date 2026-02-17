/**
 * game-enums.js — Client-side game enum label maps
 *
 * Mirrors src/server/services/game-enums.ts for display in the UI.
 * Hull types, officer classes, rarity tiers, and factions from data.stfc.space CDN.
 */

/** @type {Record<number, string>} */
export const HULL_TYPE_LABELS = {
  0: 'Destroyer',
  1: 'Survey',
  2: 'Explorer',
  3: 'Battleship',
  4: 'Defense Platform',
  5: 'Armada',
};

/** @type {Record<number, string>} */
export const OFFICER_CLASS_LABELS = {
  1: 'Command',
  2: 'Science',
  3: 'Engineering',
};

/** @type {Record<number, string>} */
export const OFFICER_CLASS_SHORT = {
  1: 'CMD',
  2: 'SCI',
  3: 'ENG',
};

/** @param {number|null|undefined} id */
export function hullTypeLabel(id) {
  if (id == null) return '';
  return HULL_TYPE_LABELS[id] || `Hull ${id}`;
}

/** @param {number|null|undefined} id */
export function officerClassLabel(id) {
  if (id == null) return '';
  return OFFICER_CLASS_LABELS[id] || `Class ${id}`;
}

/** @param {number|null|undefined} id */
export function officerClassShort(id) {
  if (id == null) return '';
  return OFFICER_CLASS_SHORT[id] || `C${id}`;
}

/**
 * Format seconds into a human-readable duration.
 * @param {number} seconds
 * @returns {string} e.g. "2h 30m", "45m", "1d 4h"
 */
export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0 || parts.length === 0) parts.push(`${m}m`);
  return parts.join(' ');
}
