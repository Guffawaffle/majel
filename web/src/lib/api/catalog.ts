/**
 * Catalog API — ships, officers, overlays.
 */

import type {
  CatalogOfficer,
  CatalogShip,
  CatalogCounts,
  OfficerOverlayPatch,
  ShipOverlayPatch,
  OfficerOverlayResponse,
  ShipOverlayResponse,
  BulkOverlayResponse,
  OwnershipState,
} from "../types.js";
import { apiFetch, apiPatch, apiPost, pathEncode, qs } from "./fetch.js";
import { cachedFetch, invalidateForMutation } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import type { FetchOpts } from "./crews.js";

// ─── Filter shapes ──────────────────────────────────────────

export interface OfficerFilters {
  q?: string;
  rarity?: string;
  group?: string;
  ownership?: string;
  target?: string;
  officerClass?: string;
}

export interface ShipFilters {
  q?: string;
  rarity?: string;
  faction?: string;
  class?: string;
  ownership?: string;
  target?: string;
  hullType?: string;
}

// ─── Read ───────────────────────────────────────────────────

/** Fetch merged officers with optional filters (SWR-cached). */
export async function fetchCatalogOfficers(filters?: OfficerFilters, opts?: FetchOpts): Promise<CatalogOfficer[]> {
  const endpoint = `/api/catalog/officers/merged${qs({ ...filters })}`;
  const key = cacheKey("/api/catalog/officers/merged", filters as Record<string, unknown>);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ officers: CatalogOfficer[] }>(endpoint).then((d) => d.officers),
    TTL.OVERLAY,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

/** Fetch merged ships with optional filters (SWR-cached). */
export async function fetchCatalogShips(filters?: ShipFilters, opts?: FetchOpts): Promise<CatalogShip[]> {
  const endpoint = `/api/catalog/ships/merged${qs({ ...filters })}`;
  const key = cacheKey("/api/catalog/ships/merged", filters as Record<string, unknown>);
  const { data } = await cachedFetch(
    key,
    () => apiFetch<{ ships: CatalogShip[] }>(endpoint).then((d) => d.ships),
    TTL.OVERLAY,
    undefined,
    opts?.forceNetwork,
  );
  return data;
}

/** Fetch catalog counts (SWR-cached). */
export async function fetchCatalogCounts(): Promise<CatalogCounts> {
  const key = cacheKey("/api/catalog/counts");
  const { data } = await cachedFetch(
    key,
    () => apiFetch<CatalogCounts>("/api/catalog/counts"),
    TTL.OVERLAY,
  );
  return data;
}

// ─── Overlays ───────────────────────────────────────────────

/** Set a single officer's overlay. Throws on failure. Invalidates related cache. */
export async function setOfficerOverlay(id: string, overlay: OfficerOverlayPatch): Promise<OfficerOverlayResponse> {
  const result = await apiPatch<OfficerOverlayResponse>(`/api/catalog/officers/${pathEncode(id)}/overlay`, overlay);
  await invalidateForMutation("officer-overlay");
  return result;
}

/** Set a single ship's overlay. Throws on failure. Invalidates related cache. */
export async function setShipOverlay(id: string, overlay: ShipOverlayPatch): Promise<ShipOverlayResponse> {
  const result = await apiPatch<ShipOverlayResponse>(`/api/catalog/ships/${pathEncode(id)}/overlay`, overlay);
  await invalidateForMutation("ship-overlay");
  return result;
}

/** Bulk-set officer overlays. Invalidates related cache. */
export async function bulkSetOfficerOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  const result = await apiPost<BulkOverlayResponse>("/api/catalog/officers/bulk-overlay", { refIds, ...overlay });
  await invalidateForMutation("bulk-officer-overlay");
  return result;
}

/** Bulk-set ship overlays. Invalidates related cache. */
export async function bulkSetShipOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  const result = await apiPost<BulkOverlayResponse>("/api/catalog/ships/bulk-overlay", { refIds, ...overlay });
  await invalidateForMutation("bulk-ship-overlay");
  return result;
}
