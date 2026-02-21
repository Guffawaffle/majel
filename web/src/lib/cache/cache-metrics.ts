/**
 * cache-metrics.ts — Performance counters for the cache layer.
 *
 * ADR-032 Phase 4: Track hit/miss/revalidate rates and estimated bandwidth savings.
 * Counters are in-memory (reset on page reload) — intentionally lightweight.
 */

// ─── Counters ───────────────────────────────────────────────

let hits = 0;
let misses = 0;
let revalidations = 0;
let bytesSaved = 0;

// ─── Recording ──────────────────────────────────────────────

export function recordHit(estimatedBytes = 0): void {
  hits++;
  bytesSaved += estimatedBytes;
}

export function recordMiss(): void {
  misses++;
}

export function recordRevalidation(): void {
  revalidations++;
}

// ─── Queries ────────────────────────────────────────────────

export interface CacheMetrics {
  hits: number;
  misses: number;
  revalidations: number;
  total: number;
  hitRate: number;        // 0.0–1.0
  bytesSaved: number;
}

export function getCacheMetrics(): CacheMetrics {
  const total = hits + misses;
  return {
    hits,
    misses,
    revalidations,
    total,
    hitRate: total > 0 ? hits / total : 0,
    bytesSaved,
  };
}

export function resetCacheMetrics(): void {
  hits = 0;
  misses = 0;
  revalidations = 0;
  bytesSaved = 0;
}
