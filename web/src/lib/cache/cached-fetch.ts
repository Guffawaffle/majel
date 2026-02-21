/**
 * cached-fetch.ts — Stale-While-Revalidate (SWR) fetch wrapper.
 *
 * ADR-032: Local-First Data Cache
 *
 * Strategy:
 *   HIT + fresh  → return cached data immediately
 *   HIT + stale  → return cached data, revalidate in background
 *   MISS         → fetch from network, store, return
 *
 * Falls back transparently to network-only when IDB is unavailable.
 */

import { cacheGet, cacheSet, isFresh, isCacheOpen } from "./idb-cache.js";
import { cacheInvalidate } from "./idb-cache.js";
import { INVALIDATION_MAP } from "./cache-keys.js";
import { recordHit, recordMiss, recordRevalidation } from "./cache-metrics.js";
import { broadcastInvalidation } from "./broadcast.js";

// ─── Types ──────────────────────────────────────────────────

export interface CachedResult<T> {
  data: T;
  /** Whether the returned data came from cache. */
  fromCache: boolean;
  /** Whether the cached data was stale (background revalidation triggered). */
  stale: boolean;
}

/**
 * Subscriber callback for background revalidation.
 * Called when stale data has been served and a fresh fetch completes.
 */
export type RevalidateCallback<T> = (data: T) => void;

// ─── In-flight dedup ────────────────────────────────────────

const inflight = new Map<string, Promise<unknown>>();

// ─── Core SWR Fetch ─────────────────────────────────────────

/**
 * Fetch data with stale-while-revalidate caching.
 *
 * @param key       — Cache key (from cacheKey())
 * @param fetcher   — Network fetch function
 * @param ttl       — TTL in ms (from TTL constants)
 * @param onRevalidate — Optional callback when background revalidation completes
 * @param forceNetwork — If true, bypass cache entirely and fetch fresh from network
 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  onRevalidate?: RevalidateCallback<T>,
  forceNetwork?: boolean,
): Promise<CachedResult<T>> {
  // Skip cache entirely for VOLATILE (ttl=0), forced network, or if cache unavailable
  if (forceNetwork || ttl === 0 || !isCacheOpen()) {
    // For forced network, clear any stale in-flight dedup to guarantee a fresh request
    if (forceNetwork) inflight.delete(key);
    const data = await dedupFetch(key, fetcher);
    if (forceNetwork && ttl > 0 && isCacheOpen()) await cacheSet(key, data, ttl);
    return { data, fromCache: false, stale: false };
  }

  // Try cache lookup
  const entry = await cacheGet<T>(key);

  if (entry) {
    // Estimate cached data size for bandwidth tracking
    const estimatedBytes = JSON.stringify(entry.data).length;

    if (isFresh(entry)) {
      // HIT + fresh
      recordHit(estimatedBytes);
      return { data: entry.data, fromCache: true, stale: false };
    }

    // HIT + stale → serve stale, revalidate in background
    recordRevalidation();
    revalidateBackground(key, fetcher, ttl, onRevalidate);
    return { data: entry.data, fromCache: true, stale: true };
  }

  // MISS → fetch, store, return
  recordMiss();
  const data = await dedupFetch(key, fetcher);
  await cacheSet(key, data, ttl);
  return { data, fromCache: false, stale: false };
}

/**
 * Perform a network fetch only (bypass cache) and update the cache entry.
 * Useful for explicit refresh actions.
 */
export async function networkFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
): Promise<T> {
  const data = await fetcher();
  if (ttl > 0 && isCacheOpen()) {
    await cacheSet(key, data, ttl);
  }
  return data;
}

/**
 * Invalidate cache entries for a named mutation.
 * Uses the INVALIDATION_MAP to determine which keys to invalidate.
 *
 * Also clears any in-flight dedup promises for the invalidated keys
 * to prevent background revalidations from returning stale data.
 */
export async function invalidateForMutation(mutation: string): Promise<void> {
  const patterns = INVALIDATION_MAP[mutation];
  if (!patterns) return;

  // Clear in-flight fetches that might return pre-mutation data (dedup race fix)
  for (const pattern of patterns) {
    const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : null;
    for (const key of inflight.keys()) {
      if (prefix ? key.startsWith(prefix) : key === pattern) {
        inflight.delete(key);
      }
    }
  }

  await Promise.all(patterns.map((p) => cacheInvalidate(p)));
  // Broadcast invalidation to other tabs (ADR-032 Phase 4)
  broadcastInvalidation(patterns);
}

// ─── Internals ──────────────────────────────────────────────

/**
 * Dedup concurrent fetches for the same key.
 * If a fetch is already in-flight, return its promise instead of starting another.
 */
async function dedupFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const promise = fetcher().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Background revalidation: fetch fresh data, update cache, notify subscriber.
 * Errors are silently swallowed (stale data is already served).
 */
function revalidateBackground<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number,
  onRevalidate?: RevalidateCallback<T>,
): void {
  dedupFetch(key, fetcher)
    .then(async (data) => {
      await cacheSet(key, data, ttl);
      onRevalidate?.(data);
    })
    .catch(() => {
      // Stale data already served — swallow revalidation errors
    });
}
