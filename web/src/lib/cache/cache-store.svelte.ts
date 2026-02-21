/**
 * cache-store.svelte.ts — Reactive Svelte 5 bridge for the cache layer.
 *
 * ADR-032: Local-First Data Cache
 *
 * Provides:
 * - Cache lifecycle management (open/close on user changes)
 * - Cache statistics for UI indicators
 * - `initCache()` / `teardownCache()` for App.svelte integration
 *
 * Uses the same rune pattern as auth.svelte.ts:
 *   private $state → exported getter functions
 */

import { openCache, closeCache, cachePurge, isCacheOpen } from "./idb-cache.js";

// ─── State ──────────────────────────────────────────────────

let cacheReady = $state(false);
let cacheError = $state<string | null>(null);

// 48-hour purge window for stale entries
const PURGE_AGE_MS = 48 * 60 * 60 * 1_000;

// ─── Getters ────────────────────────────────────────────────

/** Whether the cache is open and ready for use. */
export function getCacheReady(): boolean {
  return cacheReady;
}

/** Cache error message, if any. */
export function getCacheError(): string | null {
  return cacheError;
}

// ─── Lifecycle ──────────────────────────────────────────────

/**
 * Initialize the cache for the given user.
 * Call after authentication resolves (user ID is known).
 * Performs startup purge of stale entries.
 */
export async function initCache(userId: string): Promise<void> {
  try {
    await openCache(userId);
    cacheReady = isCacheOpen();
    cacheError = cacheReady ? null : "IndexedDB unavailable";
    // Startup hygiene: purge entries older than 48 hours
    if (cacheReady) {
      await cachePurge(PURGE_AGE_MS);
    }
  } catch (e) {
    cacheReady = false;
    cacheError = e instanceof Error ? e.message : "Cache init failed";
  }
}

/**
 * Tear down the cache (e.g., on logout).
 */
export function teardownCache(): void {
  closeCache();
  cacheReady = false;
  cacheError = null;
}
