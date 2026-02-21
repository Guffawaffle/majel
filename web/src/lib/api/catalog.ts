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
import { cachedFetch } from "../cache/cached-fetch.js";
import { cacheKey, TTL } from "../cache/cache-keys.js";
import type { FetchOpts } from "./crews.js";
import { runLockedMutation } from "./mutation.js";

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
  const path = `/api/catalog/officers/${pathEncode(id)}/overlay`;
  return runLockedMutation({
    label: "Update officer overlay",
    lockKey: `officer-overlay:${id}`,
    mutationKey: "officer-overlay",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Update officer overlay",
      lockKey: `officer-overlay:${id}`,
      method: "PATCH",
      path,
      body: overlay,
      mutationKey: "officer-overlay",
    },
    mutate: () => apiPatch<OfficerOverlayResponse>(path, overlay),
  });
}

/** Set a single ship's overlay. Throws on failure. Invalidates related cache. */
export async function setShipOverlay(id: string, overlay: ShipOverlayPatch): Promise<ShipOverlayResponse> {
  const path = `/api/catalog/ships/${pathEncode(id)}/overlay`;
  return runLockedMutation({
    label: "Update ship overlay",
    lockKey: `ship-overlay:${id}`,
    mutationKey: "ship-overlay",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Update ship overlay",
      lockKey: `ship-overlay:${id}`,
      method: "PATCH",
      path,
      body: overlay,
      mutationKey: "ship-overlay",
    },
    mutate: () => apiPatch<ShipOverlayResponse>(path, overlay),
  });
}

/** Bulk-set officer overlays. Invalidates related cache. */
export async function bulkSetOfficerOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  const path = "/api/catalog/officers/bulk-overlay";
  const body = { refIds, ...overlay };
  return runLockedMutation({
    label: "Bulk update officer overlay",
    lockKey: "bulk-officer-overlay",
    mutationKey: "bulk-officer-overlay",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Bulk update officer overlay",
      lockKey: "bulk-officer-overlay",
      method: "POST",
      path,
      body,
      mutationKey: "bulk-officer-overlay",
    },
    mutate: () => apiPost<BulkOverlayResponse>(path, body),
  });
}

/** Bulk-set ship overlays. Invalidates related cache. */
export async function bulkSetShipOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  const path = "/api/catalog/ships/bulk-overlay";
  const body = { refIds, ...overlay };
  return runLockedMutation({
    label: "Bulk update ship overlay",
    lockKey: "bulk-ship-overlay",
    mutationKey: "bulk-ship-overlay",
    queueOnNetworkError: true,
    replayIntent: {
      label: "Bulk update ship overlay",
      lockKey: "bulk-ship-overlay",
      method: "POST",
      path,
      body,
      mutationKey: "bulk-ship-overlay",
    },
    mutate: () => apiPost<BulkOverlayResponse>(path, body),
  });
}
