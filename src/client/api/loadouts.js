/**
 * loadouts.js — Loadout, Plan, Intent & Dock API Client
 *
 * @module  api/loadouts
 * @layer   api-client
 * @domain  loadouts
 * @depends api/_fetch
 * @exports see below
 *
 * Fetch wrappers for the loadout management endpoints (ADR-022).
 * Uses apiFetch for CSRF, credentials, and envelope unwrapping.
 */

import { apiFetch } from 'api/_fetch.js';

// ─── Intents ────────────────────────────────────────────────

/** @returns {Promise<import("../../server/types/loadout-types.js").Intent[]>} */
export const fetchIntents = (category) =>
    apiFetch(`/api/intents${category ? `?category=${category}` : ''}`);

export const createIntent = (key, label, category) =>
    apiFetch('/api/intents', { method: 'POST', body: JSON.stringify({ key, label, category }) });

export const deleteIntent = (key) =>
    apiFetch(`/api/intents/${encodeURIComponent(key)}`, { method: 'DELETE' });

// ─── Loadouts ───────────────────────────────────────────────

/**
 * @param {Object} [filters]
 * @param {number} [filters.shipId]
 * @param {string} [filters.intentKey]
 * @param {string} [filters.tag]
 * @param {boolean} [filters.active]
 */
export function fetchLoadouts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.shipId != null) params.set('shipId', filters.shipId);
    if (filters.intentKey) params.set('intentKey', filters.intentKey);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.active != null) params.set('active', filters.active);
    const qs = params.toString();
    return apiFetch(`/api/loadouts${qs ? `?${qs}` : ''}`);
}

export const fetchLoadout = (id) =>
    apiFetch(`/api/loadouts/${id}`);

export const createLoadout = (data) =>
    apiFetch('/api/loadouts', { method: 'POST', body: JSON.stringify(data) });

export const updateLoadout = (id, data) =>
    apiFetch(`/api/loadouts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteLoadout = (id) =>
    apiFetch(`/api/loadouts/${id}`, { method: 'DELETE' });

export const previewDeleteLoadout = (id) =>
    apiFetch(`/api/loadouts/${id}/preview-delete`);

export const setLoadoutMembers = (id, members) =>
    apiFetch(`/api/loadouts/${id}/members`, { method: 'PUT', body: JSON.stringify({ members }) });

export const fetchLoadoutsByIntent = (intentKey) =>
    apiFetch(`/api/loadouts/by-intent/${encodeURIComponent(intentKey)}`);

// ─── Docks ──────────────────────────────────────────────────

/** @returns {Promise<import("../../server/types/loadout-types.js").DockWithAssignment[]>} */
export const fetchDocks = () => apiFetch('/api/docks');

export const fetchDock = (num) => apiFetch(`/api/docks/${num}`);

export const upsertDock = (num, data) =>
    apiFetch(`/api/docks/${num}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteDock = (num) =>
    apiFetch(`/api/docks/${num}`, { method: 'DELETE' });

// ─── Plan ───────────────────────────────────────────────────

/**
 * @param {Object} [filters]
 * @param {boolean} [filters.active]
 * @param {number} [filters.dockNumber]
 * @param {string} [filters.intentKey]
 */
export function fetchPlanItems(filters = {}) {
    const params = new URLSearchParams();
    if (filters.active != null) params.set('active', filters.active);
    if (filters.dockNumber != null) params.set('dockNumber', filters.dockNumber);
    if (filters.intentKey) params.set('intentKey', filters.intentKey);
    const qs = params.toString();
    return apiFetch(`/api/plan${qs ? `?${qs}` : ''}`);
}

export const fetchPlanItem = (id) => apiFetch(`/api/plan/${id}`);

export const createPlanItem = (data) =>
    apiFetch('/api/plan', { method: 'POST', body: JSON.stringify(data) });

export const updatePlanItem = (id, data) =>
    apiFetch(`/api/plan/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deletePlanItem = (id) =>
    apiFetch(`/api/plan/${id}`, { method: 'DELETE' });

export const validatePlan = () => apiFetch('/api/plan/validate');

export const fetchPlanConflicts = () => apiFetch('/api/plan/conflicts');

export const fetchPlanBriefing = (tier = 1) =>
    apiFetch(`/api/plan/briefing?tier=${tier}`);

export const solvePlan = (apply = false) =>
    apiFetch('/api/plan/solve', { method: 'POST', body: JSON.stringify({ apply }) });

export const setPlanAwayMembers = (id, members) =>
    apiFetch(`/api/plan/${id}/away-members`, { method: 'PUT', body: JSON.stringify({ members }) });
