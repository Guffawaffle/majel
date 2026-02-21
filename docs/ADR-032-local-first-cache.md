# ADR-032: Local-First Data Cache — IndexedDB + Stale-While-Revalidate

**Status:** Accepted  
**Date:** 2026-02-20  
**Authors:** Guff, Opie (Claude)  
**References:** ADR-031 (Svelte Migration), ADR-004 (API Envelope)

---

## Context

The Majel Svelte client currently makes **every API call fresh on every view mount**. Because Svelte's hash router uses `{#if}` conditionals, navigating between tabs **destroys and recreates components**, triggering full re-fetches on every navigation. Key observations:

| Problem | Impact |
|---------|--------|
| **Catalog data re-fetched on 4 views** | `CatalogOfficer[]` (~500 items) + `CatalogShip[]` (~200 items) loaded by Catalog, Fleet, Workshop, and Plan views independently |
| **Crew entities fetched 3 times** | `BridgeCores`, `Loadouts`, `Policies`, `Reservations` loaded by Fleet, Workshop, and Plan |
| **Tab switches trigger full refresh** | User tabs from Chat → Fleet → Chat → Fleet = 2 full Fleet data loads, each 8+ parallel API calls |
| **Overlay mutations re-fetch everything** | Toggling one officer's ownership re-fetches the entire 500-item officer list |
| **No offline capability** | App is useless without network, even for viewing already-loaded data |
| **Mobile feels slow** | Repeated 200KB+ JSON payloads on every navigation are noticeable on mobile/cellular |

### Payload Inventory

| Entity | Endpoint | Approx Items | ~JSON Size | Fetch Frequency |
|--------|----------|-------------|------------|-----------------|
| Officers (merged) | `GET /api/catalog/officers/merged` | 500+ | 150–250 KB | 4 views on mount |
| Ships (merged) | `GET /api/catalog/ships/merged` | 200+ | 80–120 KB | 4 views on mount |
| Bridge Cores | `GET /api/bridge-cores` | 20–50 | 5–15 KB | 3 views on mount |
| Loadouts | `GET /api/crew/loadouts` | 30–80 | 10–30 KB | 3 views on mount |
| Below Deck Policies | `GET /api/below-deck-policies` | 10–30 | 3–8 KB | 3 views on mount |
| Reservations | `GET /api/officer-reservations` | 10–40 | 2–5 KB | 3 views on mount |
| Fleet Presets | `GET /api/fleet-presets` | 5–15 | 5–10 KB | 1 view on mount |
| Docks | `GET /api/crew/docks` | 3–10 | 1–3 KB | 2 views on mount |
| Plan Items | `GET /api/crew/plan` | 10–30 | 3–8 KB | 1 view on mount |
| Effective State | `GET /api/effective-state` | 1 | 5–15 KB | 2 views on mount |

**Total per full app session:** ~300–500 KB fetched 3–4× per tab cycle = **1–2 MB wasted bandwidth per typical session**.

---

## Decision

Implement a **local-first data cache** using **IndexedDB** with a **stale-while-revalidate** (SWR) strategy. The cache layer sits between the API modules and `apiFetch()`, intercepting reads and optimistically serving cached data while background-revalidating from the server.

### Architecture: `idb-cache.ts` — The Cache Core

```
┌─────────────────────────────────────────────────────┐
│  Svelte View (e.g., FleetView)                      │
│    calls: fetchCatalogOfficers({ ownership: "owned" })│
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  API Module (catalog.ts)                            │
│    calls: cachedFetch("catalog:officers:owned", ...) │
└──────────────┬──────────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────────┐
│  idb-cache.ts  — IndexedDB + SWR engine             │
│                                                      │
│  1. Check IDB for cache key "catalog:officers:owned" │
│  2a. HIT + fresh → return cached data instantly      │
│  2b. HIT + stale → return cached, start bg revalidate│
│  2c. MISS → await network fetch, store in IDB, return│
│  3. On mutation → invalidate affected cache keys     │
└──────────────┬──────────────────────────────────────┘
               │ (network calls go through)
┌──────────────▼──────────────────────────────────────┐
│  apiFetch() — existing ADR-004 envelope wrapper     │
│  (unchanged)                                         │
└─────────────────────────────────────────────────────┘
```

### Strategy: Stale-While-Revalidate (SWR)

The industry standard for this pattern. Used by:
- **SWR** (Vercel/React) — coined the term
- **TanStack Query** (framework-agnostic) — the gold standard for JS data caching
- **Apollo Client** (GraphQL) — normalized cache with stale policies
- **Workbox** (Google) — service worker SWR strategy

Our implementation is **framework-native** (Svelte 5 runes, no external dependencies) and **IndexedDB-backed** (data survives page refreshes and browser restarts).

```typescript
interface CacheEntry<T> {
  key: string;           // e.g. "catalog:officers:owned"
  data: T;               // the cached response
  fetchedAt: number;     // Date.now() when stored
  maxAge: number;        // ms before considered stale
  etag?: string;         // server ETag for conditional revalidation (future)
}

// Freshness tiers — tuned per entity type
const TTL = {
  REFERENCE:  24 * 60 * 60_000,  // 24h — officer/ship base data rarely changes
  OVERLAY:     5 * 60_000,        //  5m — user's levels, overlay, ownership
  COMPOSITION: 10 * 60_000,       // 10m — bridge cores, loadouts, policies
  VOLATILE:    0,                  //  0s — always revalidate (sessions, health)
} as const;
```

### Cache Key Design

Keys are deterministic, derived from the endpoint + filter parameters:

```
catalog:officers                    → full officer list (no filters)
catalog:officers:owned              → ownership=owned filter
catalog:ships                       → full ship list
crews:bridge-cores                  → all bridge cores
crews:loadouts                      → all loadouts
crews:loadouts:ship=42              → filtered by shipId
crews:policies                      → all below-deck policies
crews:reservations                  → all reservations
crews:docks                         → all docks
crews:presets                       → all fleet presets
crews:plan                          → all plan items
crews:effective-state               → effective dock state
settings:fleet                      → fleet settings
settings:user:*                     → user settings (per key)
```

### Invalidation Rules

Mutations trigger **targeted invalidation**, not global flush:

| Mutation | Invalidates |
|----------|------------|
| `setOfficerOverlay` | `catalog:officers*` |
| `setShipOverlay` | `catalog:ships*` |
| `bulkSetOfficerOverlay` | `catalog:officers*` |
| `bulkSetShipOverlay` | `catalog:ships*` |
| `createBridgeCore` / `updateBridgeCore` / `deleteBridgeCore` | `crews:bridge-cores`, `crews:effective-state` |
| `createCrewLoadout` / `updateCrewLoadout` / `deleteCrewLoadout` | `crews:loadouts*`, `crews:effective-state` |
| `createVariant` / `updateVariant` / `deleteVariant` | `crews:loadouts*` |
| `upsertCrewDock` / `deleteCrewDock` | `crews:docks`, `crews:effective-state`, `crews:plan` |
| `createFleetPreset` / `activateFleetPreset` / etc. | `crews:presets`, `crews:effective-state` |
| `createCrewPlanItem` / `updateCrewPlanItem` / `deleteCrewPlanItem` | `crews:plan`, `crews:effective-state` |
| `setReservation` / `deleteReservation` | `crews:reservations` |
| `saveFleetSetting` | `settings:fleet` |
| `saveUserSetting` | `settings:user:*` |
| Import pipeline `commitImportRows` | `catalog:officers*`, `catalog:ships*`, `crews:*` (full flush) |

### Optimistic Updates (Phase 2)

For high-frequency mutations (overlay edits in FleetView), apply the change to the IDB cache **immediately** before the network call completes:

```typescript
// Phase 2: optimistic overlay update
async function setOfficerOverlayOptimistic(id: string, patch: OfficerOverlayPatch) {
  // 1. Update IDB record in-place
  await idbCache.patchRecord("catalog:officers", id, patch);
  
  // 2. Notify reactive subscribers (Svelte $state updates)
  cacheStore.notify("catalog:officers");
  
  // 3. Fire network call (background)
  try {
    await setOfficerOverlay(id, patch);
  } catch {
    // 4. Rollback on failure — re-fetch from server
    await idbCache.invalidate("catalog:officers*");
    cacheStore.notify("catalog:officers");
  }
}
```

### IndexedDB Schema

Single database `majel-cache`, version 1:

```
Object Store: "cache"
  keyPath: "key"
  Indexes: 
    - "fetchedAt" — for TTL cleanup
    - "prefix" — for wildcard invalidation (e.g., "catalog:officers*")

Object Store: "meta"
  keyPath: "key"
  Records:
    - { key: "userId", value: "u123" }       — partition per user
    - { key: "schemaVersion", value: 1 }      — migration support
    - { key: "lastPurge", value: 1708387200 } — cleanup tracking
```

### User Isolation

Each user gets a **separate IDB database**: `majel-cache-{userId}`. On logout, the database name changes. On `fetchMe()`, the cache initializes with the returned user ID.

This prevents data leakage between users on shared devices and avoids cross-user stale data.

### Reactive Integration with Svelte 5

```typescript
// cacheStore.svelte.ts — reactive cache bridge
import { createCacheStore } from "./idb-cache.js";

const cache = createCacheStore();

// Views consume cached data reactively:
export function useCached<T>(key: string, fetcher: () => Promise<T>, ttl: number) {
  let data = $state<T | null>(null);
  let loading = $state(true);
  let stale = $state(false);

  $effect(() => {
    cache.get<T>(key).then((cached) => {
      if (cached) {
        data = cached.data;
        loading = false;
        stale = Date.now() - cached.fetchedAt > ttl;
      }
      // Always revalidate in background if stale or miss
      if (!cached || stale) {
        fetcher().then((fresh) => {
          data = fresh;
          stale = false;
          cache.set(key, fresh, ttl);
        });
      }
    });
  });

  return { get data() { return data; }, get loading() { return loading; }, get stale() { return stale; } };
}
```

---

## What NOT to Cache

| Data | Reason |
|------|--------|
| Chat messages / sessions | Real-time, streaming, server-authoritative |
| Health checks | Ephemeral, sub-second freshness needed |
| Diagnostic queries | Ad-hoc SQL, results are ephemeral |
| Admin user list | Sensitive, must reflect real-time state |
| Import pipeline state | Transactional, multi-step, server-authoritative |

---

## Implementation Phases

### Phase 1: Cache Infrastructure + Catalog (biggest win)
- `idb-cache.ts` — IndexedDB wrapper (open, get, set, invalidate, purge)
- `cache-keys.ts` — key generation + invalidation mapping
- `cached-fetch.ts` — SWR wrapper for `apiFetch()`
- Wire up `catalog.ts` — officers + ships + counts
- Add `cache-status` indicator to sidebar (shows "cached" / "refreshing" / "offline")
- **Estimated: ~400 LOC, eliminates ~60% of redundant fetches**

### Phase 2: Crew Entities + Cross-View Sharing
- Wire up `crews.ts` — bridge cores, loadouts, policies, reservations, docks, presets, plan items, effective state
- Implement invalidation rules for all mutation endpoints
- **Estimated: ~200 LOC, eliminates remaining ~35% of redundant fetches**

### Phase 3: Optimistic Updates + Offline Indicators
- Optimistic overlay writes (FleetView inline editing)
- Offline detection + "cached data" badge on views
- Background sync queue for mutations made while flaky connection
- **Estimated: ~300 LOC**

### Phase 4: Settings + Refinements
- Cache fleet settings + user settings
- ETag/If-None-Match conditional revalidation (server-side support)
- Cache size monitoring + automatic purge of entries older than 7 days
- Performance metrics (cache hit rate, saved bandwidth)
- **Estimated: ~200 LOC**

---

## Alternatives Considered

### TanStack Query (Svelte adapter)
**Pros:** Battle-tested, rich feature set (pagination, infinite scroll, devtools), large community.  
**Cons:** 18 KB min+gzip, introduces a dependency that duplicates what Svelte 5 runes already provide (reactive state). Also, TanStack Query's Svelte adapter targets SvelteKit and uses Svelte stores (not runes). We'd be fighting the abstraction rather than leveraging it.  
**Decision:** Build native. Our cache is simpler (no pagination, no infinite scroll, no normalized entities) and Svelte 5 runes give us reactivity for free.

### Service Worker + Cache API
**Pros:** Network-level caching, works for all requests including images/fonts.  
**Cons:** Opaque caching — no programmatic control over invalidation per entity, no optimistic updates, can't do targeted record patches. Also complicates debugging (requests succeed from SW cache, hiding stale data bugs).  
**Decision:** IndexedDB gives us entity-level control. We may add a SW later for offline shell caching (HTML/CSS/JS assets), but data caching belongs in application code.

### localStorage
**Pros:** Simpler API, synchronous.  
**Cons:** 5 MB limit (our catalog data alone can be 300+ KB), blocks main thread on read/write, no structured data (everything serialized as strings), no transactions.  
**Decision:** IndexedDB is the correct tool for structured data > 1 MB.

### Dexie.js (IndexedDB wrapper)
**Pros:** Nice API, live queries, good TypeScript support.  
**Cons:** 20 KB dependency for a wrapper we can write in ~200 lines. Our access pattern is simple (key-value with TTL), not the complex querying Dexie excels at.  
**Decision:** Native `idb` API with a thin wrapper. If complexity grows, Dexie is a reasonable future upgrade.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Stale data shown to user** | Visual indicators ("cached" / "refreshing"), aggressive revalidation on mutation, short TTL for overlay data |
| **IDB storage bloated** | Auto-purge entries > 7 days, per-user isolation (logout clears), cache size monitoring |
| **IDB unavailable** | Graceful degradation — if IDB fails, fall back to network-only (current behavior). Cache is always an optimization, never a requirement. |
| **Race condition: stale cache served during mutation** | Invalidation runs synchronously before mutation response is consumed. Optimistic updates (Phase 3) eliminate the window entirely. |
| **Multi-tab consistency** | Use `BroadcastChannel` API to notify other tabs of cache invalidation events |

---

## Success Metrics

| Metric | Target |
|--------|--------|
| **Network calls on tab switch** | 0 (served from cache) for all cacheable data |
| **Time-to-interactive on FleetView** | < 100ms (from ~800ms currently) |
| **Total bandwidth per 30-min session** | < 500 KB (from ~2 MB currently) |
| **Cache hit rate after warm-up** | > 90% |
| **IDB overhead per user** | < 2 MB |

---

## References

- [Stale-While-Revalidate — web.dev](https://web.dev/stale-while-revalidate/)
- [TanStack Query patterns](https://tanstack.com/query/latest/docs/framework/svelte/overview)
- [IndexedDB API — MDN](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [SWR — Vercel](https://swr.vercel.app/)
