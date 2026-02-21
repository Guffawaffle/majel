/**
 * cache/index.ts — Barrel export for the cache layer.
 *
 * ADR-032: Local-First Data Cache
 */

// Core engine
export {
  openCache,
  closeCache,
  destroyCache,
  cacheGet,
  cacheSet,
  cacheDelete,
  cacheInvalidate,
  cachePurge,
  cacheClear,
  isFresh,
  isCacheOpen,
} from "./idb-cache.js";
export type { CacheEntry } from "./idb-cache.js";

// Key construction + TTLs
export { cacheKey, TTL, INVALIDATION_MAP } from "./cache-keys.js";
export type { TtlTier } from "./cache-keys.js";

// SWR fetch wrapper
export { cachedFetch, networkFetch, invalidateForMutation } from "./cached-fetch.js";
export type { CachedResult, RevalidateCallback } from "./cached-fetch.js";

// Svelte reactive store
export { initCache, teardownCache, getCacheReady, getCacheError } from "./cache-store.svelte.js";
