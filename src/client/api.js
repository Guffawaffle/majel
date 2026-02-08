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
