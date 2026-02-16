/**
 * catalog.js — Reference Data & Overlay API
 *
 * @module  api/catalog
 * @layer   api-client
 * @domain  catalog
 * @depends api/_fetch
 * @exports fetchCatalogOfficers, fetchCatalogShips,
 *          fetchCatalogCounts, setOfficerOverlay, setShipOverlay,
 *          bulkSetOfficerOverlay, bulkSetShipOverlay,
 *          fetchShips, fetchOfficers
 * @emits   none
 * @state   none
 */

import { apiFetch } from './_fetch.js';

// ─── Merged Lookups (used by docks, fleet) ──────────────────

/**
 * Fetch all ships (merged reference + overlay)
 * @returns {Promise<Array>} Array of ship objects
 */
export async function fetchShips() {
    const data = await apiFetch("/api/catalog/ships/merged");
    return data?.ships || [];
}

/**
 * Fetch all officers (merged reference + overlay)
 * @returns {Promise<Array>} Array of officer objects
 */
export async function fetchOfficers() {
    const data = await apiFetch("/api/catalog/officers/merged");
    return data?.officers || [];
}

// ─── Filtered Catalog Queries ───────────────────────────────

/**
 * Fetch merged catalog officers (reference + overlay)
 * @param {Object} filters - { q?, rarity?, group?, ownership?, target? }
 * @returns {Promise<Array>} Merged officer records
 */
export async function fetchCatalogOfficers(filters = {}) {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.rarity) params.set("rarity", filters.rarity);
    if (filters.group) params.set("group", filters.group);
    if (filters.ownership) params.set("ownership", filters.ownership);
    if (filters.target !== undefined) params.set("target", String(filters.target));
    const qs = params.toString();
    const data = await apiFetch(`/api/catalog/officers/merged${qs ? "?" + qs : ""}`);
    return data?.officers || [];
}

/**
 * Fetch merged catalog ships (reference + overlay)
 * @param {Object} filters - { q?, rarity?, faction?, class?, ownership?, target? }
 * @returns {Promise<Array>} Merged ship records
 */
export async function fetchCatalogShips(filters = {}) {
    const params = new URLSearchParams();
    if (filters.q) params.set("q", filters.q);
    if (filters.rarity) params.set("rarity", filters.rarity);
    if (filters.faction) params.set("faction", filters.faction);
    if (filters.class) params.set("class", filters.class);
    if (filters.ownership) params.set("ownership", filters.ownership);
    if (filters.target !== undefined) params.set("target", String(filters.target));
    const qs = params.toString();
    const data = await apiFetch(`/api/catalog/ships/merged${qs ? "?" + qs : ""}`);
    return data?.ships || [];
}

/**
 * Fetch catalog counts (reference + overlay summary)
 * @returns {Promise<Object>} { reference: {officers, ships}, overlay: {...} }
 */
export async function fetchCatalogCounts() {
    const data = await apiFetch("/api/catalog/counts");
    return data || { reference: { officers: 0, ships: 0 }, overlay: {} };
}

// ─── Overlay Mutations ──────────────────────────────────────

/**
 * Set overlay for a single officer
 * @param {string} id - Reference officer ID
 * @param {Object} overlay - { ownershipState?, target?, level?, rank? }
 * @returns {Promise<Object>}
 */
export async function setOfficerOverlay(id, overlay) {
    return apiFetch(`/api/catalog/officers/${encodeURIComponent(id)}/overlay`, {
        method: "PATCH",
        body: JSON.stringify(overlay),
    });
}

/**
 * Set overlay for a single ship
 * @param {string} id - Reference ship ID
 * @param {Object} overlay - { ownershipState?, target?, tier?, level? }
 * @returns {Promise<Object>}
 */
export async function setShipOverlay(id, overlay) {
    return apiFetch(`/api/catalog/ships/${encodeURIComponent(id)}/overlay`, {
        method: "PATCH",
        body: JSON.stringify(overlay),
    });
}

/**
 * Bulk set officer overlays
 * @param {string[]} refIds - Officer reference IDs
 * @param {Object} overlay - { ownershipState?, target? }
 * @returns {Promise<Object>}
 */
export async function bulkSetOfficerOverlay(refIds, overlay) {
    return apiFetch("/api/catalog/officers/bulk-overlay", {
        method: "POST",
        body: JSON.stringify({ refIds, ...overlay }),
    });
}

/**
 * Bulk set ship overlays
 * @param {string[]} refIds - Ship reference IDs
 * @param {Object} overlay - { ownershipState?, target? }
 * @returns {Promise<Object>}
 */
export async function bulkSetShipOverlay(refIds, overlay) {
    return apiFetch("/api/catalog/ships/bulk-overlay", {
        method: "POST",
        body: JSON.stringify({ refIds, ...overlay }),
    });
}

// ─── Wiki Sync ──────────────────────────────────────────────

/**
 * Sync reference data from the STFC Fandom Wiki.
 * User-initiated: fetches Officers + Ships via Special:Export.
 * @param {Object} options - { officers?: boolean, ships?: boolean }
 * @returns {Promise<Object>} Sync results
 */
export async function syncWikiData(options = {}) {
    return apiFetch("/api/catalog/sync", {
        method: "POST",
        body: JSON.stringify({ consent: true, ...options }),
    });
}
