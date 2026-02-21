/**
 * cache-keys.ts — Cache key generation and TTL tiers.
 *
 * ADR-032: Local-First Data Cache
 *
 * Keys are deterministic strings built from endpoint + sorted query params.
 * TTL tiers map to data volatility classes.
 */

// ─── TTL Tiers (milliseconds) ───────────────────────────────

export const TTL = {
  /** Reference data: officers, ships, bridge cores — rarely changes. */
  REFERENCE: 24 * 60 * 60 * 1_000,   // 24 h

  /** Overlay data: ownership, targets — user-editable, moderate staleness OK. */
  OVERLAY: 5 * 60 * 1_000,           // 5 min

  /** Composition data: fleet, crew, loadouts — changes with user actions. */
  COMPOSITION: 10 * 60 * 1_000,      // 10 min

  /** Volatile: never cache (effectively skip cache). */
  VOLATILE: 0,
} as const;

export type TtlTier = keyof typeof TTL;

// ─── Key Construction ───────────────────────────────────────

/**
 * Build a deterministic cache key from an endpoint and optional filters.
 *
 *   cacheKey("/api/catalog/officers/merged", { rarity: "epic", q: "kirk" })
 *   → "catalog:officers:merged?q=kirk&rarity=epic"
 *
 * Strips the `/api/` prefix and converts `/` to `:` for readability.
 */
export function cacheKey(endpoint: string, filters?: Record<string, unknown>): string {
  // Normalize endpoint: strip leading /api/, convert slashes to colons
  let base = endpoint.replace(/^\/api\//, "").replace(/\//g, ":");

  // Strip any existing query string (caller should pass filters separately)
  const qIdx = base.indexOf("?");
  if (qIdx !== -1) base = base.slice(0, qIdx);

  // Build sorted query portion
  if (filters && Object.keys(filters).length > 0) {
    const sorted = Object.entries(filters)
      .filter(([, v]) => v != null && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("&");
    if (sorted) return `${base}?${sorted}`;
  }

  return base;
}

// ─── Invalidation Map ───────────────────────────────────────

/**
 * Maps mutation operations to cache key prefixes that should be invalidated.
 * Patterns ending with `*` are treated as prefix matches.
 */
export const INVALIDATION_MAP: Record<string, string[]> = {
  // Officer overlay changes invalidate merged officer lists + counts
  "officer-overlay": [
    "catalog:officers:merged*",
    "catalog:counts",
  ],

  // Ship overlay changes invalidate merged ship lists + counts
  "ship-overlay": [
    "catalog:ships:merged*",
    "catalog:counts",
  ],

  // Bulk overlay changes invalidate both + counts
  "bulk-officer-overlay": [
    "catalog:officers:merged*",
    "catalog:counts",
  ],
  "bulk-ship-overlay": [
    "catalog:ships:merged*",
    "catalog:counts",
  ],
};
