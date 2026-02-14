/**
 * sessions.js — Session Management API
 *
 * @module  api/sessions
 * @layer   api-client
 * @domain  sessions
 * @depends api/_fetch
 * @exports fetchSessions, getCachedSessions, restoreSession, deleteSession
 * @emits   none
 * @state   cachedSessions (module-level array)
 */

import { _fetch } from './_fetch.js';

let cachedSessions = [];

/**
 * Fetch list of saved sessions
 * @returns {Promise<Array>} Array of session objects
 */
export async function fetchSessions() {
    try {
        const res = await _fetch("/api/sessions?limit=30");
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
        const res = await _fetch(`/api/sessions/${id}`);
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
        await _fetch(`/api/sessions/${id}`, { method: "DELETE" });
        return true;
    } catch {
        return false;
    }
}
