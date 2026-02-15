/**
 * crews.js — ADR-025 Crew Composition API Client
 *
 * @module  api/crews
 * @layer   api-client
 * @domain  crews
 * @depends api/_fetch
 *
 * Fetch wrappers for BridgeCores, BelowDeckPolicies, Loadouts (via crew-store),
 * Variants, FleetPresets, OfficerReservations, PlanItems, Docks, and EffectiveState.
 */

import { apiFetch } from 'api/_fetch.js';

// ─── Bridge Cores ───────────────────────────────────────────

export const fetchBridgeCores = () =>
    apiFetch('/api/bridge-cores');

export const fetchBridgeCore = (id) =>
    apiFetch(`/api/bridge-cores/${id}`);

export const createBridgeCore = (name, members, notes) =>
    apiFetch('/api/bridge-cores', {
        method: 'POST',
        body: JSON.stringify({ name, members, notes }),
    });

export const updateBridgeCore = (id, data) =>
    apiFetch(`/api/bridge-cores/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteBridgeCore = (id) =>
    apiFetch(`/api/bridge-cores/${id}`, { method: 'DELETE' });

export const setBridgeCoreMembers = (id, members) =>
    apiFetch(`/api/bridge-cores/${id}/members`, {
        method: 'PUT',
        body: JSON.stringify({ members }),
    });

// ─── Below Deck Policies ────────────────────────────────────

export const fetchBelowDeckPolicies = () =>
    apiFetch('/api/below-deck-policies');

export const fetchBelowDeckPolicy = (id) =>
    apiFetch(`/api/below-deck-policies/${id}`);

export const createBelowDeckPolicy = (name, mode, spec, notes) =>
    apiFetch('/api/below-deck-policies', {
        method: 'POST',
        body: JSON.stringify({ name, mode, spec, notes }),
    });

export const updateBelowDeckPolicy = (id, data) =>
    apiFetch(`/api/below-deck-policies/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteBelowDeckPolicy = (id) =>
    apiFetch(`/api/below-deck-policies/${id}`, { method: 'DELETE' });

// ─── Crew Loadouts (ADR-025 composition model) ─────────────

export function fetchCrewLoadouts(filters = {}) {
    const params = new URLSearchParams();
    if (filters.shipId != null) params.set('shipId', filters.shipId);
    if (filters.intentKey) params.set('intentKey', filters.intentKey);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.active != null) params.set('active', String(filters.active));
    const qs = params.toString();
    return apiFetch(`/api/crew/loadouts${qs ? `?${qs}` : ''}`);
}

export const fetchCrewLoadout = (id) =>
    apiFetch(`/api/crew/loadouts/${id}`);

export const createCrewLoadout = (data) =>
    apiFetch('/api/crew/loadouts', { method: 'POST', body: JSON.stringify(data) });

export const updateCrewLoadout = (id, data) =>
    apiFetch(`/api/crew/loadouts/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteCrewLoadout = (id) =>
    apiFetch(`/api/crew/loadouts/${id}`, { method: 'DELETE' });

// ─── Loadout Variants ───────────────────────────────────────

export const fetchVariants = (loadoutId) =>
    apiFetch(`/api/crew/loadouts/${loadoutId}/variants`);

export const createVariant = (loadoutId, name, patch, notes) =>
    apiFetch(`/api/crew/loadouts/${loadoutId}/variants`, {
        method: 'POST',
        body: JSON.stringify({ name, patch, notes }),
    });

export const updateVariant = (id, data) =>
    apiFetch(`/api/crew/loadouts/variants/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteVariant = (id) =>
    apiFetch(`/api/crew/loadouts/variants/${id}`, { method: 'DELETE' });

export const resolveVariant = (loadoutId, variantId) =>
    apiFetch(`/api/crew/loadouts/${loadoutId}/variants/${variantId}/resolve`);

// ─── Docks (ADR-025 crew-store) ─────────────────────────────

export const fetchCrewDocks = () => apiFetch('/api/crew/docks');

export const fetchCrewDock = (num) => apiFetch(`/api/crew/docks/${num}`);

export const upsertCrewDock = (num, data) =>
    apiFetch(`/api/crew/docks/${num}`, { method: 'PUT', body: JSON.stringify(data) });

export const deleteCrewDock = (num) =>
    apiFetch(`/api/crew/docks/${num}`, { method: 'DELETE' });

// ─── Fleet Presets ──────────────────────────────────────────

export const fetchFleetPresets = () =>
    apiFetch('/api/fleet-presets');

export const fetchFleetPreset = (id) =>
    apiFetch(`/api/fleet-presets/${id}`);

export const createFleetPreset = (name, notes) =>
    apiFetch('/api/fleet-presets', {
        method: 'POST',
        body: JSON.stringify({ name, notes }),
    });

export const updateFleetPreset = (id, data) =>
    apiFetch(`/api/fleet-presets/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteFleetPreset = (id) =>
    apiFetch(`/api/fleet-presets/${id}`, { method: 'DELETE' });

export const setFleetPresetSlots = (id, slots) =>
    apiFetch(`/api/fleet-presets/${id}/slots`, {
        method: 'PUT',
        body: JSON.stringify({ slots }),
    });

export const activateFleetPreset = (id) =>
    apiFetch(`/api/fleet-presets/${id}/activate`, { method: 'POST' });

// ─── Plan Items (ADR-025 crew-store) ────────────────────────

export function fetchCrewPlanItems(filters = {}) {
    const params = new URLSearchParams();
    if (filters.active != null) params.set('active', String(filters.active));
    if (filters.dockNumber != null) params.set('dockNumber', String(filters.dockNumber));
    const qs = params.toString();
    return apiFetch(`/api/crew/plan${qs ? `?${qs}` : ''}`);
}

export const fetchCrewPlanItem = (id) =>
    apiFetch(`/api/crew/plan/${id}`);

export const createCrewPlanItem = (data) =>
    apiFetch('/api/crew/plan', { method: 'POST', body: JSON.stringify(data) });

export const updateCrewPlanItem = (id, data) =>
    apiFetch(`/api/crew/plan/${id}`, { method: 'PATCH', body: JSON.stringify(data) });

export const deleteCrewPlanItem = (id) =>
    apiFetch(`/api/crew/plan/${id}`, { method: 'DELETE' });

// ─── Officer Reservations ───────────────────────────────────

export const fetchReservations = () =>
    apiFetch('/api/officer-reservations');

export const setReservation = (officerId, reservedFor, locked, notes) =>
    apiFetch(`/api/officer-reservations/${encodeURIComponent(officerId)}`, {
        method: 'PUT',
        body: JSON.stringify({ reservedFor, locked, notes }),
    });

export const deleteReservation = (officerId) =>
    apiFetch(`/api/officer-reservations/${encodeURIComponent(officerId)}`, { method: 'DELETE' });

// ─── Effective State (ADR-025 § D6) ─────────────────────────

export const fetchEffectiveState = () =>
    apiFetch('/api/effective-state');
