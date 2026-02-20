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

/** Fetch merged officers with optional filters. */
export async function fetchCatalogOfficers(filters?: OfficerFilters): Promise<CatalogOfficer[]> {
  const data = await apiFetch<{ officers: CatalogOfficer[] }>(`/api/catalog/officers/merged${qs({ ...filters })}`);
  return data.officers;
}

/** Fetch merged ships with optional filters. */
export async function fetchCatalogShips(filters?: ShipFilters): Promise<CatalogShip[]> {
  const data = await apiFetch<{ ships: CatalogShip[] }>(`/api/catalog/ships/merged${qs({ ...filters })}`);
  return data.ships;
}

/** Fetch catalog counts (reference + overlay tallies). */
export async function fetchCatalogCounts(): Promise<CatalogCounts> {
  return apiFetch<CatalogCounts>("/api/catalog/counts");
}

// ─── Overlays ───────────────────────────────────────────────

/** Set a single officer's overlay. Throws on failure. */
export async function setOfficerOverlay(id: string, overlay: OfficerOverlayPatch): Promise<OfficerOverlayResponse> {
  return apiPatch<OfficerOverlayResponse>(`/api/catalog/officers/${pathEncode(id)}/overlay`, overlay);
}

/** Set a single ship's overlay. Throws on failure. */
export async function setShipOverlay(id: string, overlay: ShipOverlayPatch): Promise<ShipOverlayResponse> {
  return apiPatch<ShipOverlayResponse>(`/api/catalog/ships/${pathEncode(id)}/overlay`, overlay);
}

/** Bulk-set officer overlays. */
export async function bulkSetOfficerOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  return apiPost<BulkOverlayResponse>("/api/catalog/officers/bulk-overlay", { refIds, ...overlay });
}

/** Bulk-set ship overlays. */
export async function bulkSetShipOverlay(
  refIds: string[],
  overlay: { ownershipState?: OwnershipState; target?: boolean },
): Promise<BulkOverlayResponse> {
  return apiPost<BulkOverlayResponse>("/api/catalog/ships/bulk-overlay", { refIds, ...overlay });
}
