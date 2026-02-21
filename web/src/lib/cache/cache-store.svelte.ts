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

import { openCache, closeCache, cachePurge, cacheClear, destroyCache, isCacheOpen } from "./idb-cache.js";
import { openBroadcast, closeBroadcast } from "./broadcast.js";
import { resetCacheMetrics } from "./cache-metrics.js";

// ─── State ──────────────────────────────────────────────────

let cacheReady = $state(false);
let cacheError = $state<string | null>(null);

// 7-day purge window for stale entries (ADR-032 Phase 4)
const PURGE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

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
 * Performs startup purge of stale entries and opens cross-tab channel.
 */
export async function initCache(userId: string): Promise<void> {
  try {
    await openCache(userId);
    cacheReady = isCacheOpen();
    cacheError = cacheReady ? null : "IndexedDB unavailable";
    if (cacheReady) {
      // Startup hygiene: purge entries older than 7 days
      await cachePurge(PURGE_AGE_MS);
      // Open multi-tab broadcast channel
      openBroadcast();
    }
  } catch (e) {
    cacheReady = false;
    cacheError = e instanceof Error ? e.message : "Cache init failed";
  }
}

/**
 * Tear down the cache (e.g., on component destroy).
 */
export function teardownCache(): void {
  closeBroadcast();
  closeCache();
  cacheReady = false;
  cacheError = null;
}

/**
 * Clear all cached data and reset metrics (e.g., on logout).
 * Ensures no stale user data leaks across sessions.
 */
export async function clearCacheOnLogout(): Promise<void> {
  closeBroadcast();
  await cacheClear();
  resetCacheMetrics();
  closeCache();
  cacheReady = false;
  cacheError = null;
}
