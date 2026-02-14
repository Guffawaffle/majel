/**
 * docks.js — Drydock, Ship Assignment, Preset & Intent API
 *
 * @module  api/docks
 * @layer   api-client
 * @domain  docks
 * @depends api/_fetch
 * @exports fetchDocks, fetchDock, updateDock, deleteDock,
 *          previewDeleteDock, previewDeleteShip, previewDeleteOfficer,
 *          fetchNextDockNumber, saveDockIntents, addDockShip,
 *          removeDockShip, setActiveShip, fetchIntents,
 *          fetchConflicts, fetchDockSummary,
 *          fetchPresetsForDock, listPresets, createPreset,
 *          deletePreset, setPresetMembers
 * @emits   none
 * @state   none
 */

import { _fetch } from './_fetch.js';

// ─── Dock CRUD ──────────────────────────────────────────────

/**
 * Fetch all drydock loadouts
 * @returns {Promise<Array>} Array of dock objects
 */
export async function fetchDocks() {
    const res = await _fetch("/api/dock/docks");
    const env = await res.json();
    return env.data?.docks || [];
}

/**
 * Fetch a single dock's full detail
 * @param {number} num - Dock number
 * @returns {Promise<Object|null>} Dock detail or null
 */
export async function fetchDock(num) {
    const res = await _fetch(`/api/dock/docks/${num}`);
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
    const res = await _fetch(`/api/dock/docks/${num}`, {
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
    const res = await _fetch(`/api/dock/docks/${num}`, {
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
    const res = await _fetch(`/api/dock/docks/${num}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Preview what would be deleted when removing a ship
 * @param {string} id - Ship ID
 * @returns {Promise<Object>} - { dockAssignments, crewPresets, crewAssignments }
 */
export async function previewDeleteShip(id) {
    const res = await _fetch(`/api/dock/ships/${encodeURIComponent(id)}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Preview what would be deleted when removing an officer
 * @param {string} id - Officer ID
 * @returns {Promise<Object>} - { presetMemberships, crewAssignments }
 */
export async function previewDeleteOfficer(id) {
    const res = await _fetch(`/api/dock/officers/${encodeURIComponent(id)}/cascade-preview`);
    const env = await res.json();
    return env.data || {};
}

/**
 * Get the next available dock number
 * @returns {Promise<number>}
 */
export async function fetchNextDockNumber() {
    const res = await _fetch("/api/dock/docks/next-number");
    const env = await res.json();
    return env.data?.nextDockNumber || 1;
}

// ─── Dock Intents ───────────────────────────────────────────

/**
 * Set intents for a dock
 * @param {number} num - Dock number
 * @param {string[]} intents - Array of intent keys
 * @returns {Promise<Object>}
 */
export async function saveDockIntents(num, intents) {
    const res = await _fetch(`/api/dock/docks/${num}/intents`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intents }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

/**
 * Fetch intent catalog
 * @returns {Promise<Array>} Array of intent objects
 */
export async function fetchIntents() {
    const res = await _fetch("/api/dock/intents");
    const env = await res.json();
    return env.data?.intents || [];
}

// ─── Dock Ship Assignment ───────────────────────────────────

/**
 * Assign a ship to a dock rotation
 * @param {number} num - Dock number
 * @param {string} shipId - Reference ship ID
 * @param {boolean} isActive - Whether this is the active ship
 * @returns {Promise<Object>}
 */
export async function addDockShip(num, shipId, isActive = false) {
    const res = await _fetch(`/api/dock/docks/${num}/ships`, {
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
    const res = await _fetch(`/api/dock/docks/${num}/ships/${encodeURIComponent(shipId)}`, {
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
    const res = await _fetch(`/api/dock/docks/${num}/ships/${encodeURIComponent(shipId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}

// ─── Dock Conflicts & Summary ───────────────────────────────

/**
 * Fetch dock conflict analysis
 * @returns {Promise<Object>} Conflicts data
 */
export async function fetchConflicts() {
    const res = await _fetch("/api/dock/docks/conflicts");
    const env = await res.json();
    return env.data || {};
}

/**
 * Fetch dock summary (all docks with intents, ships, presets)
 * @returns {Promise<Array>} Dock summaries
 */
export async function fetchDockSummary() {
    const res = await _fetch("/api/dock/docks/summary");
    const env = await res.json();
    return env.data?.summary || [];
}

// ─── Crew Presets ───────────────────────────────────────────

/**
 * Fetch crew presets relevant to a specific dock (matches ship OR intent)
 * @param {number} dockNumber - Dock number
 * @returns {Promise<Array>} Array of preset objects with members and tags
 */
export async function fetchPresetsForDock(dockNumber) {
    const res = await _fetch(`/api/dock/docks/${dockNumber}/presets`);
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
    const res = await _fetch(`/api/dock/presets${qs ? "?" + qs : ""}`);
    const env = await res.json();
    return env.data?.presets || [];
}

/**
 * Create a new crew preset
 * @param {Object} fields - { shipId: string, intentKey: string, presetName: string, isDefault?: boolean }
 * @returns {Promise<Object>} { ok, data, error }
 */
export async function createPreset(fields) {
    const res = await _fetch("/api/dock/presets", {
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
    const res = await _fetch(`/api/dock/presets/${id}`, { method: "DELETE" });
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
    const res = await _fetch(`/api/dock/presets/${presetId}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ members }),
    });
    const env = await res.json();
    return { ok: res.ok, data: env.data, error: env.error };
}
