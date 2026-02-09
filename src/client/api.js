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
 * Refresh fleet roster data from Google Sheets
 * @returns {Promise<Object>} Fleet data response
 */
export async function refreshRoster() {
    const res = await fetch("/api/roster");
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

// ─── Drydock / Fleet APIs ───────────────────────────────────

/**
 * Fetch all drydock loadouts
 * @returns {Promise<Array>} Array of dock objects
 */
export async function fetchDocks() {
    const res = await fetch("/api/fleet/docks");
    const env = await res.json();
    return env.data?.docks || [];
}

/**
 * Fetch a single dock's full detail
 * @param {number} num - Dock number
 * @returns {Promise<Object|null>} Dock detail or null
 */
export async function fetchDock(num) {
    const res = await fetch(`/api/fleet/docks/${num}`);
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
    const res = await fetch(`/api/fleet/docks/${num}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fields),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Set intents for a dock
 * @param {number} num - Dock number
 * @param {string[]} intents - Array of intent keys
 * @returns {Promise<Object>}
 */
export async function saveDockIntents(num, intents) {
    const res = await fetch(`/api/fleet/docks/${num}/intents`, {
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
 * @param {number} shipId - Ship ID
 * @param {boolean} isActive - Whether this is the active ship
 * @returns {Promise<Object>}
 */
export async function addDockShip(num, shipId, isActive = false) {
    const res = await fetch(`/api/fleet/docks/${num}/ships`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ship_id: shipId, is_active: isActive ? 1 : 0 }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Remove a ship from a dock
 * @param {number} num - Dock number
 * @param {number} shipId - Ship ID
 * @returns {Promise<Object>}
 */
export async function removeDockShip(num, shipId) {
    const res = await fetch(`/api/fleet/docks/${num}/ships/${shipId}`, {
        method: "DELETE",
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Set which ship is active in a dock
 * @param {number} num - Dock number
 * @param {number} shipId - Ship ID
 * @returns {Promise<Object>}
 */
export async function setActiveShip(num, shipId) {
    const res = await fetch(`/api/fleet/docks/${num}/ships/${shipId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: 1 }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Fetch intent catalog
 * @returns {Promise<Array>} Array of intent objects
 */
export async function fetchIntents() {
    const res = await fetch("/api/fleet/intents");
    const env = await res.json();
    return env.data?.intents || [];
}

/**
 * Fetch all ships
 * @returns {Promise<Array>} Array of ship objects
 */
export async function fetchShips() {
    const res = await fetch("/api/fleet/ships");
    const env = await res.json();
    return env.data?.ships || [];
}

/**
 * Fetch all officers
 * @returns {Promise<Array>} Array of officer objects
 */
export async function fetchOfficers() {
    const res = await fetch("/api/fleet/officers");
    const env = await res.json();
    return env.data?.officers || [];
}

/**
 * Fetch dock conflict analysis
 * @returns {Promise<Object>} Conflicts data
 */
export async function fetchConflicts() {
    const res = await fetch("/api/fleet/docks/conflicts");
    const env = await res.json();
    return env.data || {};
}

/**
 * Fetch dock summary (all docks with intents, ships, presets)
 * @returns {Promise<Array>} Dock summaries
 */
export async function fetchDockSummary() {
    const res = await fetch("/api/fleet/docks/summary");
    const env = await res.json();
    return env.data?.summary || [];
}
