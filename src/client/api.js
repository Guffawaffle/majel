/**
 * api.js — Shared API Helpers
 * 
 * Majel — STFC Fleet Intelligence System
 * Central module for all backend API communication.
 */

let cachedSessions = [];

/**
 * Check the health/status of the backend API
 * @returns {Promise<Object|null>} Health data or null on error
 */
export async function checkHealth() {
    try {
        const res = await fetch("/api/health");
        const data = (await res.json()).data;
        return data;
    } catch {
        return null;
    }
}

/**
 * Send a chat message to the backend
 * @param {string} sessionId - Current session ID
 * @param {string} message - User message text
 * @returns {Promise<Object>} Response envelope with data or error
 */
export async function sendChat(sessionId, message) {
    const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Session-Id": sessionId,
        },
        body: JSON.stringify({ message }),
    });

    return {
        ok: res.ok,
        data: await res.json(),
    };
}

/**
 * Load conversation history from Lex memory
 * @returns {Promise<Object>} History data
 */
export async function loadHistory() {
    const res = await fetch("/api/history?source=lex&limit=20");
    const data = (await res.json()).data || {};
    return data;
}

/**
 * Search past conversations using recall
 * @param {string} query - Search query
 * @returns {Promise<Object>} Search results
 */
export async function searchRecall(query) {
    const res = await fetch(`/api/recall?q=${encodeURIComponent(query)}`);
    const _env = await res.json();
    return {
        ok: res.ok,
        data: _env.data || {},
        error: _env.error,
    };
}

/**
 * Fetch list of saved sessions
 * @returns {Promise<Array>} Array of session objects
 */
export async function fetchSessions() {
    try {
        const res = await fetch("/api/sessions?limit=30");
        const data = (await res.json()).data || {};
        cachedSessions = data.sessions || [];
        return cachedSessions;
    } catch {
        cachedSessions = [];
        return [];
    }
}

/**
 * Get the currently cached sessions (no network call)
 * @returns {Array} Cached sessions array
 */
export function getCachedSessions() {
    return cachedSessions;
}

/**
 * Restore a specific session by ID
 * @param {string} id - Session ID
 * @returns {Promise<Object|null>} Session data or null on error
 */
export async function restoreSession(id) {
    try {
        const res = await fetch(`/api/sessions/${id}`);
        if (!res.ok) return null;
        const session = (await res.json()).data;
        return session;
    } catch {
        return null;
    }
}

/**
 * Delete a session by ID
 * @param {string} id - Session ID to delete
 * @returns {Promise<boolean>} Success status
 */
export async function deleteSession(id) {
    try {
        await fetch(`/api/sessions/${id}`, { method: "DELETE" });
        return true;
    } catch {
        return false;
    }
}

/**
 * Save a fleet config setting
 * @param {string} key - Setting key
 * @param {string|number} value - Setting value
 * @returns {Promise<void>}
 */
export async function saveFleetSetting(key, value) {
    try {
        await fetch("/api/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ [key]: String(value) }),
        });
    } catch (err) {
        console.error("Failed to save fleet setting:", key, err);
    }
}

/**
 * Load fleet settings from API
 * @returns {Promise<Object>} Settings data
 */
export async function loadFleetSettings() {
    try {
        const res = await fetch("/api/settings?category=fleet");
        if (!res.ok) return { settings: [] };
        const data = (await res.json()).data || {};
        return data;
    } catch {
        return { settings: [] };
    }
}

// ─── Drydock / Dock APIs ────────────────────────────────────

/**
 * Fetch all drydock loadouts
 * @returns {Promise<Array>} Array of dock objects
 */
export async function fetchDocks() {
    const res = await fetch("/api/dock/docks");
    const env = await res.json();
    return env.data?.docks || [];
}

/**
 * Fetch a single dock's full detail
 * @param {number} num - Dock number
 * @returns {Promise<Object|null>} Dock detail or null
 */
export async function fetchDock(num) {
    const res = await fetch(`/api/dock/docks/${num}`);
    if (!res.ok) return null;
    const env = await res.json();
    return env.data?.dock || null;
}

/**
 * Update dock metadata (label, notes)
 * @param {number} num - Dock number
 * @param {Object} fields - { label?, notes? }
 * @returns {Promise<Object>} Updated dock
 */
export async function updateDock(num, fields) {
    const res = await fetch(`/api/dock/docks/${num}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Delete a dock and all its associated data (ships, intents, presets)
 * @param {number} num - Dock number
 * @returns {Promise<Object>}
 */
export async function deleteDock(num) {
    const res = await fetch(`/api/dock/docks/${num}`, {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Preview what would be deleted when removing a dock
 * @param {number} num - Dock number
 * @returns {Promise<Object>} - { ships, intents, shipCount, intentCount }
 */
export async function previewDeleteDock(num) {
    const res = await fetch(`/api/dock/docks/${num}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Preview what would be deleted when removing a ship
 * @param {string} id - Ship ID
 * @returns {Promise<Object>} - { dockAssignments, crewPresets, crewAssignments }
 */
export async function previewDeleteShip(id) {
    const res = await fetch(`/api/dock/ships/${encodeURIComponent(id)}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Preview what would be deleted when removing an officer
 * @param {string} id - Officer ID
 * @returns {Promise<Object>} - { presetMemberships, crewAssignments }
 */
export async function previewDeleteOfficer(id) {
    const res = await fetch(`/api/dock/officers/${encodeURIComponent(id)}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Get the next available dock number
 * @returns {Promise<number>}
 */
export async function fetchNextDockNumber() {
    const res = await fetch("/api/dock/docks/next-number");
    const env = await res.json();
    return env.data?.nextDockNumber || 1;
}

/**
 * Set intents for a dock
 * @param {number} num - Dock number
 * @param {string[]} intents - Array of intent keys
 * @returns {Promise<Object>}
 */
export async function saveDockIntents(num, intents) {
    const res = await fetch(`/api/dock/docks/${num}/intents`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intents }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Assign a ship to a dock rotation
 * @param {number} num - Dock number
 * @param {string} shipId - Reference ship ID
 * @param {boolean} isActive - Whether this is the active ship
 * @returns {Promise<Object>}
 */
export async function addDockShip(num, shipId, isActive = false) {
    const res = await fetch(`/api/dock/docks/${num}/ships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipId, isActive }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Remove a ship from a dock
 * @param {number} num - Dock number
 * @param {string} shipId - Reference ship ID
 * @returns {Promise<Object>}
 */
export async function removeDockShip(num, shipId) {
    const res = await fetch(`/api/dock/docks/${num}/ships/${encodeURIComponent(shipId)}`, {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Set which ship is active in a dock
 * @param {number} num - Dock number
 * @param {string} shipId - Reference ship ID
 * @returns {Promise<Object>}
 */
export async function setActiveShip(num, shipId) {
    const res = await fetch(`/api/dock/docks/${num}/ships/${encodeURIComponent(shipId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Fetch intent catalog
 * @returns {Promise<Array>} Array of intent objects
 */
export async function fetchIntents() {
    const res = await fetch("/api/dock/intents");
    const env = await res.json();
    return env.data?.intents || [];
}

/**
 * Fetch all ships (from reference catalog)
 * @returns {Promise<Array>} Array of ship objects
 */
export async function fetchShips() {
    const res = await fetch("/api/catalog/ships/merged");
    const env = await res.json();
    return env.data?.ships || [];
}

/**
 * Fetch all officers (from reference catalog)
 * @returns {Promise<Array>} Array of officer objects
 */
export async function fetchOfficers() {
    const res = await fetch("/api/catalog/officers/merged");
    const env = await res.json();
    return env.data?.officers || [];
}

/**
 * Fetch dock conflict analysis
 * @returns {Promise<Object>} Conflicts data
 */
export async function fetchConflicts() {
    const res = await fetch("/api/dock/docks/conflicts");
    const env = await res.json();
    return env.data || {};
}

/**
 * Fetch dock summary (all docks with intents, ships, presets)
 * @returns {Promise<Array>} Dock summaries
 */
export async function fetchDockSummary() {
    const res = await fetch("/api/dock/docks/summary");
    const env = await res.json();
    return env.data?.summary || [];
}

// ─── Crew Presets API ───────────────────────────────────────

/**
 * Fetch crew presets relevant to a specific dock (matches ship OR intent)
 * @param {number} dockNumber - Dock number
 * @returns {Promise<Array>} Array of preset objects with members and tags
 */
export async function fetchPresetsForDock(dockNumber) {
    const res = await fetch(`/api/dock/docks/${dockNumber}/presets`);
    const env = await res.json();
    return env.data?.presets || [];
}

/**
 * List crew presets with optional filters
 * @param {Object} filters - { shipId?, intentKey?, tag?, officerId? }
 * @returns {Promise<Array>} Array of preset objects
 */
export async function listPresets(filters = {}) {
    const params = new URLSearchParams();
    if (filters.shipId) params.set("shipId", filters.shipId);
    if (filters.intentKey) params.set("intentKey", filters.intentKey);
    if (filters.tag) params.set("tag", filters.tag);
    if (filters.officerId) params.set("officerId", filters.officerId);
    const qs = params.toString();
    const res = await fetch(`/api/dock/presets${qs ? "?" + qs : ""}`);
    const env = await res.json();
    return env.data?.presets || [];
}

/**
 * Create a new crew preset
 * @param {Object} fields - { shipId: string, intentKey: string, presetName: string, isDefault?: boolean }
 * @returns {Promise<Object>} { ok, data, error }
 */
export async function createPreset(fields) {
    const res = await fetch("/api/dock/presets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Delete a crew preset
 * @param {number} id - Preset ID
 * @returns {Promise<Object>} { ok, data, error }
 */
export async function deletePreset(id) {
    const res = await fetch(`/api/dock/presets/${id}`, { method: "DELETE" });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Set the crew members of a preset (replaces all members)
 * @param {number} presetId - Preset ID
 * @param {Array<{officerId: string, roleType: string, slot?: string}>} members
 * @returns {Promise<Object>} { ok, data, error }
 */
export async function setPresetMembers(presetId, members) {
    const res = await fetch(`/api/dock/presets/${presetId}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

// ─── Catalog API (ADR-016 Phase 2) ─────────────────────────

/**
 * Sync reference data from the STFC Fandom Wiki.
 * User-initiated: fetches Officers + Ships via Special:Export.
 * @param {Object} options - { officers?: boolean, ships?: boolean }
 * @returns {Promise<Object>} { ok, data: { officers, ships, provenance } }
 */
export async function syncWikiData(options = {}) {
    const res = await fetch("/api/catalog/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ consent: true, ...options }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

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
    const res = await fetch(`/api/catalog/officers/merged${qs ? "?" + qs : ""}`);
    const env = await res.json();
    return env.data?.officers || [];
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
    const res = await fetch(`/api/catalog/ships/merged${qs ? "?" + qs : ""}`);
    const env = await res.json();
    return env.data?.ships || [];
}

/**
 * Fetch catalog counts (reference + overlay summary)
 * @returns {Promise<Object>} { reference: {officers, ships}, overlay: {...} }
 */
export async function fetchCatalogCounts() {
    const res = await fetch("/api/catalog/counts");
    const env = await res.json();
    return env.data || { reference: { officers: 0, ships: 0 }, overlay: {} };
}

/**
 * Set overlay for a single officer
 * @param {string} id - Reference officer ID
 * @param {Object} overlay - { ownershipState?, target?, level?, rank? }
 * @returns {Promise<Object>}
 */
export async function setOfficerOverlay(id, overlay) {
    const res = await fetch(`/api/catalog/officers/${encodeURIComponent(id)}/overlay`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overlay),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Set overlay for a single ship
 * @param {string} id - Reference ship ID
 * @param {Object} overlay - { ownershipState?, target?, tier?, level? }
 * @returns {Promise<Object>}
 */
export async function setShipOverlay(id, overlay) {
    const res = await fetch(`/api/catalog/ships/${encodeURIComponent(id)}/overlay`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(overlay),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Bulk set officer overlays
 * @param {string[]} refIds - Officer reference IDs
 * @param {Object} overlay - { ownershipState?, target? }
 * @returns {Promise<Object>}
 */
export async function bulkSetOfficerOverlay(refIds, overlay) {
    const res = await fetch("/api/catalog/officers/bulk-overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refIds, ...overlay }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Bulk set ship overlays
 * @param {string[]} refIds - Ship reference IDs
 * @param {Object} overlay - { ownershipState?, target? }
 * @returns {Promise<Object>}
 */
export async function bulkSetShipOverlay(refIds, overlay) {
    const res = await fetch("/api/catalog/ships/bulk-overlay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refIds, ...overlay }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}
