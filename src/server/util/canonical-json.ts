/**
 * canonical-json.ts — Deterministic JSON serialization
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Produces canonical JSON strings by recursively sorting object keys.
 * Used for tamper-detection hashing where the same logical value must
 * always produce the same string, even after a PostgreSQL JSONB round-trip
 * (which does not preserve key order).
 */

/**
 * Serialize a value to JSON with object keys sorted alphabetically at every
 * nesting level. Array element order is preserved.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object" && !Array.isArray(val)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(val).sort()) {
        sorted[k] = val[k];
      }
      return sorted;
    }
    return val;
  });
}
