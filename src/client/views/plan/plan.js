/**
 * plan.js — Plan: Fleet State Dashboard (ADR-025 Phase 5)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Fleet state dashboard showing current dock assignments with preset management:
 * - Effective State: resolved dock assignments (the single truth)
 * - Fleet Presets: saved mode snapshots (mining, pvp, borg day, etc.)
 * - Plan Items (ADVANCED): individual manual assignments
 *
 * @module  views/plan
 * @layer   view
 * @domain  plan
 * @depends api/crews, utils/escape, router, components/confirm-dialog
 */

import {
    fetchFleetPresets, createFleetPreset, updateFleetPreset, deleteFleetPreset,
    setFleetPresetSlots, activateFleetPreset,
    fetchCrewPlanItems, createCrewPlanItem, updateCrewPlanItem, deleteCrewPlanItem,
    fetchEffectiveState, fetchCrewLoadouts, fetchBridgeCores, fetchBelowDeckPolicies,
    fetchVariants,
} from 'api/crews.js';
import { fetchCatalogOfficers } from 'api/catalog.js';
import { esc } from 'utils/escape.js';
import { registerView } from 'router';
import { showConfirmDialog } from 'components/confirm-dialog.js';

// ─── Constants ──────────────────────────────────────────────

const SLOT_NAMES = { captain: 'Captain', bridge_1: 'Bridge 1', bridge_2: 'Bridge 2' };
const SOURCE_LABELS = { manual: '🟡 Manual', preset: '🟢 Preset' };
const SOURCE_ICONS = { manual: '🟡', preset: '🟢' };

// ─── State ──────────────────────────────────────────────────

let effectiveState = { docks: [], awayTeams: [], conflicts: [] };
let fleetPresets = [];
let planItems = [];
let loadouts = [];
let bridgeCores = [];
let belowDeckPolicies = [];
let officers = [];
let activeTab = 'state';  // 'state' | 'presets' | 'items'
let loading = false;
let formError = '';

// Editing state
let editingPresetId = null;     // preset id or 'new'
let editingPresetSlots = null;  // slot editing state for a preset
let overrideDock = null;        // dock number being overridden
let editingPlanItemId = null;   // plan item id or 'new'

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ─────────────────────────────────────

registerView('plan', {
    area: $('#plan-area'),
    icon: '🗺️', title: 'Plan', subtitle: 'Fleet state dashboard — docks, presets & assignments',
    cssHref: 'views/plan/plan.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#plan-area');
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [stateData, presetsData, itemsData, loadoutsData, coresData, policiesData, officerData] = await Promise.all([
            fetchEffectiveState(),
            fetchFleetPresets(),
            fetchCrewPlanItems(),
            fetchCrewLoadouts(),
            fetchBridgeCores(),
            fetchBelowDeckPolicies(),
            fetchCatalogOfficers({ ownership: 'owned' }),
        ]);
        const state = stateData?.effectiveState ?? stateData ?? {};
        effectiveState = {
            docks: Array.isArray(state.docks) ? state.docks : [],
            awayTeams: Array.isArray(state.awayTeams) ? state.awayTeams : [],
            conflicts: Array.isArray(state.conflicts) ? state.conflicts : [],
        };
        fleetPresets = Array.isArray(presetsData) ? presetsData : (presetsData?.fleetPresets ?? []);
        planItems = Array.isArray(itemsData) ? itemsData : (itemsData?.planItems ?? []);
        loadouts = Array.isArray(loadoutsData) ? loadoutsData : (loadoutsData?.loadouts ?? []);
        bridgeCores = Array.isArray(coresData) ? coresData : (coresData?.bridgeCores ?? []);
        belowDeckPolicies = Array.isArray(policiesData) ? policiesData : (policiesData?.belowDeckPolicies ?? []);
        officers = Array.isArray(officerData) ? officerData : (officerData?.officers ?? []);
        render();
    } catch (err) {
        console.error('Plan refresh failed:', err);
        const area = $('#plan-area');
        if (area) area.innerHTML = `<div class="plan-error">Failed to load plan: ${esc(err.message)}</div>`;
    } finally {
        loading = false;
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $('#plan-area');
    if (!area) return;

    area.innerHTML = `
        ${renderTabBar()}
        ${renderContent()}
    `;
    bindEvents();
}

function renderTabBar() {
    const tabs = [
        { key: 'state', label: 'Effective State', icon: '📊' },
        { key: 'presets', label: 'Fleet Presets', icon: '💾' },
        { key: 'items', label: 'Plan Items', icon: '📋' },
    ];
    return `
        <div class="plan-tabs">
            ${tabs.map(t => `
                <button class="plan-tab ${activeTab === t.key ? 'active' : ''}" data-tab="${t.key}">
                    <span class="plan-tab-icon">${t.icon}</span> ${t.label}
                </button>
            `).join('')}
        </div>
    `;
}

function renderContent() {
    switch (activeTab) {
    case 'state': return renderStateTab();
    case 'presets': return renderPresetsTab();
    case 'items': return renderItemsTab();
    default: return '';
    }
}

// ═══════════════════════════════════════════════════════════
// EFFECTIVE STATE TAB
// ═══════════════════════════════════════════════════════════

function renderStateTab() {
    const activePreset = fleetPresets.find(p => p.isActive);
    const docks = effectiveState.docks;
    const conflicts = effectiveState.conflicts;
    const awayTeams = effectiveState.awayTeams;

    return `
        <div class="plan-section">
            ${activePreset ? `
            <div class="plan-planning-note">
                <span class="plan-note-icon">ℹ️</span>
                <span>This is your <strong>planned</strong> fleet state via <strong>${esc(activePreset.name)}</strong>. Ships and officers must be docked in-game before applying changes.</span>
            </div>` : ''}

            ${conflicts.length > 0 ? renderConflicts(conflicts) : ''}

            <div class="plan-toolbar">
                <h3 class="plan-toolbar-title">Dock Assignments (${docks.length})</h3>
            </div>

            <div class="plan-dock-grid">
                ${docks.length === 0
        ? renderEmpty('No dock assignments yet. Create a fleet preset or add manual plan items.')
        : docks.map(d => renderDockCard(d)).join('')}
            </div>

            ${awayTeams.length > 0 ? `
            <div class="plan-toolbar" style="margin-top: 20px;">
                <h3 class="plan-toolbar-title">Away Teams (${awayTeams.length})</h3>
            </div>
            <div class="plan-away-list">
                ${awayTeams.map(t => renderAwayTeam(t)).join('')}
            </div>` : ''}

            ${overrideDock != null ? renderOverrideForm(overrideDock) : ''}
        </div>
    `;
}

function renderConflicts(conflicts) {
    return `
        <div class="plan-conflicts">
            <div class="plan-conflicts-header">
                <span class="plan-conflicts-icon">⚠️</span>
                <strong>Officer Conflicts (${conflicts.length})</strong>
            </div>
            <div class="plan-conflicts-list">
                ${conflicts.map(c => {
        const name = officerById(c.officerId)?.name || c.officerId;
        const locs = c.locations.map(l =>
            `${esc(l.entityName)}${l.slot ? ` (${esc(SLOT_NAMES[l.slot] || l.slot)})` : ''}`
        ).join(', ');
        return `<div class="plan-conflict-row">
                        <span class="plan-conflict-name">${esc(name)}</span>
                        <span class="plan-conflict-locs">→ ${locs}</span>
                    </div>`;
    }).join('')}
            </div>
        </div>
    `;
}

function renderDockCard(dock) {
    const lo = dock.loadout;
    const source = dock.source || 'manual';
    const sourceLabel = SOURCE_LABELS[source] || source;

    if (!lo) {
        return `
            <div class="plan-dock-card plan-dock-empty" data-dock="${dock.dockNumber}">
                <div class="plan-dock-header">
                    <span class="plan-dock-number">Dock ${dock.dockNumber}</span>
                    <span class="plan-dock-source">${sourceLabel}</span>
                </div>
                <div class="plan-dock-body plan-dock-unassigned">
                    <span>⚪ Unassigned</span>
                    <button class="plan-action-btn" data-action="override-dock" data-dock="${dock.dockNumber}">Assign</button>
                </div>
            </div>
        `;
    }

    const bridgeSlots = lo.bridge || {};
    const bridgeNames = Object.entries(bridgeSlots)
        .filter(([, id]) => id)
        .map(([slot, id]) => `${SLOT_NAMES[slot] || slot}: ${esc(officerById(id)?.name || id)}`);
    const policyName = lo.belowDeckPolicy?.name || '—';
    const shipName = lo.name || '—';
    const intents = dock.intentKeys || lo.intentKeys || [];
    const isManual = source === 'manual';

    return `
        <div class="plan-dock-card ${isManual ? 'plan-dock-manual' : ''}" data-dock="${dock.dockNumber}">
            <div class="plan-dock-header">
                <span class="plan-dock-number">Dock ${dock.dockNumber}</span>
                <span class="plan-dock-source">${sourceLabel}</span>
                ${isManual ? `<button class="plan-action-btn plan-action-sm" data-action="clear-override" data-dock="${dock.dockNumber}" title="Clear manual override">✕</button>` : ''}
            </div>
            <div class="plan-dock-body">
                <div class="plan-dock-loadout">
                    <span class="plan-dock-loadout-name">${esc(shipName)}</span>
                    ${dock.variantPatch ? '<span class="plan-badge plan-badge-variant">Variant</span>' : ''}
                </div>
                ${bridgeNames.length > 0 ? `
                <div class="plan-dock-bridge">
                    ${bridgeNames.map(b => `<span class="plan-dock-officer">${b}</span>`).join('')}
                </div>` : ''}
                <div class="plan-dock-details">
                    <span class="plan-dock-detail"><span class="plan-label">Policy:</span> ${esc(policyName)}</span>
                    ${intents.length > 0 ? `<span class="plan-dock-detail"><span class="plan-label">Intents:</span> ${intents.map(k => esc(k)).join(', ')}</span>` : ''}
                </div>
            </div>
            <div class="plan-dock-actions">
                <button class="plan-action-btn" data-action="override-dock" data-dock="${dock.dockNumber}">Override</button>
            </div>
        </div>
    `;
}

function renderAwayTeam(team) {
    const names = team.officers.map(id => officerById(id)?.name || id);
    const sourceIcon = SOURCE_ICONS[team.source] || '⚪';
    return `
        <div class="plan-away-card">
            <div class="plan-away-header">
                <span class="plan-away-label">${esc(team.label || 'Away Team')}</span>
                <span class="plan-away-source">${sourceIcon}</span>
            </div>
            <div class="plan-away-officers">
                ${names.map(n => `<span class="plan-away-officer">${esc(n)}</span>`).join('')}
            </div>
        </div>
    `;
}

function renderOverrideForm(dockNumber) {
    const existing = effectiveState.docks.find(d => d.dockNumber === dockNumber);

    return `
        <div class="plan-overlay">
            <div class="plan-form" data-form-id="override">
                <div class="plan-form-header">
                    <h3>Override Dock ${dockNumber}</h3>
                    <button class="plan-action-btn" data-action="cancel-override" title="Cancel">✕</button>
                </div>
                ${formError ? `<div class="plan-form-error">${esc(formError)}</div>` : ''}
                <div class="plan-form-grid">
                    <label class="plan-form-field">
                        <span class="plan-form-label">Loadout *</span>
                        <select class="plan-form-select" data-form-field="loadoutId">
                            <option value="">— Select loadout —</option>
                            ${loadouts.map(l => `<option value="${esc(String(l.id))}" ${existing?.loadout?.loadoutId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
                        </select>
                    </label>
                    <label class="plan-form-field">
                        <span class="plan-form-label">Label</span>
                        <input type="text" class="plan-form-input" data-form-field="label"
                               value="" placeholder="e.g. Swarm grind dock" maxlength="100" />
                    </label>
                    <label class="plan-form-field">
                        <span class="plan-form-label">Priority</span>
                        <input type="number" class="plan-form-input" data-form-field="priority"
                               value="1" min="1" max="100" />
                    </label>
                </div>
                <div class="plan-form-actions">
                    <button class="plan-btn plan-btn-secondary" data-action="cancel-override">Cancel</button>
                    <button class="plan-btn plan-btn-primary" data-action="save-override">Assign</button>
                </div>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// FLEET PRESETS TAB
// ═══════════════════════════════════════════════════════════

function renderPresetsTab() {
    return `
        <div class="plan-section">
            <div class="plan-toolbar">
                <h3 class="plan-toolbar-title">Fleet Presets</h3>
                <button class="plan-create-btn" data-action="create-preset">+ New Preset</button>
            </div>
            ${editingPresetId === 'new' ? renderPresetForm(null) : ''}
            <div class="plan-list">
                ${fleetPresets.length === 0
        ? renderEmpty('No fleet presets yet. Create one to save a fleet configuration you can activate with one click.')
        : fleetPresets.map(p => renderPresetCard(p)).join('')}
            </div>
        </div>
    `;
}

function renderPresetCard(preset) {
    if (editingPresetId === preset.id) return renderPresetForm(preset);

    const slots = preset.slots || [];
    const dockSlots = slots.filter(s => s.dockNumber != null);
    const awaySlots = slots.filter(s => s.awayOfficers != null);

    return `
        <div class="plan-card ${preset.isActive ? 'plan-card-active' : ''}" data-id="${preset.id}">
            <div class="plan-card-header">
                <div class="plan-card-title">
                    <span class="plan-card-name">${esc(preset.name)}</span>
                    ${preset.isActive ? '<span class="plan-badge plan-badge-active">✅ Active</span>' : ''}
                </div>
                <div class="plan-card-actions">
                    ${preset.isActive
        ? `<button class="plan-action-btn plan-action-warning" data-action="reactivate-preset" data-id="${preset.id}" title="Re-activate (clears manual overrides)">🔄 Re-activate</button>`
        : `<button class="plan-action-btn plan-action-primary" data-action="activate-preset" data-id="${preset.id}" title="Activate this preset">▶ Activate</button>`}
                    <button class="plan-action-btn" data-action="edit-preset" data-id="${preset.id}" title="Edit">✎</button>
                    <button class="plan-action-btn plan-action-danger" data-action="delete-preset" data-id="${preset.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="plan-card-body">
                <div class="plan-row">
                    <span class="plan-label">Dock Slots</span>
                    <span class="plan-value">${dockSlots.length}</span>
                </div>
                ${awaySlots.length > 0 ? `
                <div class="plan-row">
                    <span class="plan-label">Away Teams</span>
                    <span class="plan-value">${awaySlots.length}</span>
                </div>` : ''}
                ${dockSlots.length > 0 ? `
                <div class="plan-preset-slots">
                    ${dockSlots.map(s => {
        const lo = s.loadoutId ? loadouts.find(l => l.id === s.loadoutId) : null;
        const name = lo ? lo.name : (s.variantId ? `Variant #${s.variantId}` : '—');
        return `<span class="plan-slot-chip">Dock ${s.dockNumber}: ${esc(name)}</span>`;
    }).join('')}
                </div>` : ''}
            </div>
            ${preset.notes ? `<div class="plan-card-notes">${esc(preset.notes)}</div>` : ''}
        </div>
    `;
}

function renderPresetForm(preset) {
    const isNew = !preset;
    const p = preset || { name: '', notes: '' };

    return `
        <div class="plan-form" data-form-id="${isNew ? 'new' : p.id}">
            <div class="plan-form-header">
                <h3>${isNew ? 'Create Fleet Preset' : `Edit: ${esc(p.name)}`}</h3>
                <button class="plan-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="plan-form-error">${esc(formError)}</div>` : ''}
            <div class="plan-form-grid">
                <label class="plan-form-field">
                    <span class="plan-form-label">Name *</span>
                    <input type="text" class="plan-form-input" data-form-field="name"
                           value="${esc(p.name)}" placeholder="e.g. Mining Mode" maxlength="100" required />
                </label>
                <label class="plan-form-field plan-form-wide">
                    <span class="plan-form-label">Notes</span>
                    <textarea class="plan-form-input plan-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(p.notes || '')}</textarea>
                </label>
            </div>
            <div class="plan-form-actions">
                <button class="plan-btn plan-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="plan-btn plan-btn-primary" data-action="save-preset">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// PLAN ITEMS TAB
// ═══════════════════════════════════════════════════════════

function renderItemsTab() {
    return `
        <div class="plan-section">
            <div class="plan-toolbar">
                <h3 class="plan-toolbar-title">Plan Items</h3>
                <button class="plan-create-btn" data-action="create-item">+ New Item</button>
            </div>
            ${editingPlanItemId === 'new' ? renderPlanItemForm(null) : ''}
            <div class="plan-list">
                ${planItems.length === 0
        ? renderEmpty('No plan items yet. Plan items are individual dock or away-team assignments.')
        : planItems.map(item => renderPlanItemCard(item)).join('')}
            </div>
        </div>
    `;
}

function renderPlanItemCard(item) {
    if (editingPlanItemId === item.id) return renderPlanItemForm(item);

    const lo = item.loadoutId ? loadouts.find(l => l.id === item.loadoutId) : null;
    const loadoutName = lo ? lo.name : (item.variantId ? `Variant #${item.variantId}` : null);
    const isAway = item.awayOfficers != null;
    const sourceIcon = SOURCE_ICONS[item.source] || '⚪';

    return `
        <div class="plan-card ${item.isActive ? '' : 'plan-card-inactive'}" data-id="${item.id}">
            <div class="plan-card-header">
                <div class="plan-card-title">
                    <span class="plan-card-name">${esc(item.label || loadoutName || (isAway ? 'Away Team' : 'Plan Item'))}</span>
                    <span class="plan-badge plan-badge-source">${sourceIcon} ${esc(item.source)}</span>
                    ${!item.isActive ? '<span class="plan-badge plan-badge-inactive">Inactive</span>' : ''}
                    ${item.dockNumber != null ? `<span class="plan-badge">Dock ${item.dockNumber}</span>` : ''}
                    ${item.priority > 1 ? `<span class="plan-badge plan-badge-priority">P${item.priority}</span>` : ''}
                </div>
                <div class="plan-card-actions">
                    <button class="plan-action-btn" data-action="edit-item" data-id="${item.id}" title="Edit">✎</button>
                    <button class="plan-action-btn plan-action-danger" data-action="delete-item" data-id="${item.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="plan-card-body">
                ${loadoutName ? `
                <div class="plan-row">
                    <span class="plan-label">Loadout</span>
                    <span class="plan-value">${esc(loadoutName)}</span>
                </div>` : ''}
                ${isAway ? `
                <div class="plan-row">
                    <span class="plan-label">Officers</span>
                    <span class="plan-value">${item.awayOfficers.map(id => esc(officerById(id)?.name || id)).join(', ')}</span>
                </div>` : ''}
                ${item.intentKey ? `
                <div class="plan-row">
                    <span class="plan-label">Intent</span>
                    <span class="plan-value">${esc(item.intentKey)}</span>
                </div>` : ''}
            </div>
            ${item.notes ? `<div class="plan-card-notes">${esc(item.notes)}</div>` : ''}
        </div>
    `;
}

function renderPlanItemForm(item) {
    const isNew = !item;
    const pi = item || { label: '', loadoutId: null, dockNumber: null, priority: 1, isActive: true, source: 'manual', intentKey: '', notes: '' };

    return `
        <div class="plan-form" data-form-id="${isNew ? 'new' : pi.id}">
            <div class="plan-form-header">
                <h3>${isNew ? 'Create Plan Item' : `Edit Plan Item`}</h3>
                <button class="plan-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="plan-form-error">${esc(formError)}</div>` : ''}
            <div class="plan-form-grid">
                <label class="plan-form-field">
                    <span class="plan-form-label">Loadout</span>
                    <select class="plan-form-select" data-form-field="loadoutId">
                        <option value="">— Select loadout —</option>
                        ${loadouts.map(l => `<option value="${esc(String(l.id))}" ${pi.loadoutId === l.id ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="plan-form-field">
                    <span class="plan-form-label">Dock Number</span>
                    <input type="number" class="plan-form-input" data-form-field="dockNumber"
                           value="${pi.dockNumber ?? ''}" min="1" max="50" placeholder="e.g. 1" />
                </label>
                <label class="plan-form-field">
                    <span class="plan-form-label">Label</span>
                    <input type="text" class="plan-form-input" data-form-field="label"
                           value="${esc(pi.label || '')}" placeholder="e.g. Mining Dock" maxlength="100" />
                </label>
                <label class="plan-form-field">
                    <span class="plan-form-label">Intent Key</span>
                    <input type="text" class="plan-form-input" data-form-field="intentKey"
                           value="${esc(pi.intentKey || '')}" placeholder="e.g. mining-gas" maxlength="50" />
                </label>
                <label class="plan-form-field">
                    <span class="plan-form-label">Priority</span>
                    <input type="number" class="plan-form-input" data-form-field="priority"
                           value="${pi.priority || 1}" min="1" max="100" />
                </label>
                <label class="plan-form-field plan-form-checkbox-field">
                    <input type="checkbox" data-form-field="isActive" ${pi.isActive ? 'checked' : ''} />
                    <span class="plan-form-label">Active</span>
                </label>
                <label class="plan-form-field plan-form-wide">
                    <span class="plan-form-label">Notes</span>
                    <textarea class="plan-form-input plan-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(pi.notes || '')}</textarea>
                </label>
            </div>
            <div class="plan-form-actions">
                <button class="plan-btn plan-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="plan-btn plan-btn-primary" data-action="save-item">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// SHARED RENDERERS
// ═══════════════════════════════════════════════════════════

function renderEmpty(msg) {
    return `<div class="plan-empty"><p>${msg}</p></div>`;
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════

function bindEvents() {
    const area = $('#plan-area');
    if (!area) return;

    // ─── Tab switching ──────────────────────────────────────
    area.querySelectorAll('.plan-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            editingPresetId = null;
            editingPlanItemId = null;
            overrideDock = null;
            formError = '';
            render();
        });
    });

    // ─── Effective State: Override / Clear ───────────────────

    area.querySelectorAll('[data-action="override-dock"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            overrideDock = parseInt(btn.dataset.dock, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="cancel-override"]').forEach(btn => {
        btn.addEventListener('click', () => {
            overrideDock = null;
            formError = '';
            render();
        });
    });

    bindAction('save-override', () => handleSaveOverride());

    area.querySelectorAll('[data-action="clear-override"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const dockNumber = parseInt(btn.dataset.dock, 10);
            // Find the manual plan item for this dock
            const item = planItems.find(pi => pi.dockNumber === dockNumber && pi.source === 'manual');
            if (!item) return;
            try {
                await deleteCrewPlanItem(item.id);
                await refresh();
            } catch (err) {
                console.error('Clear override failed:', err);
            }
        });
    });

    // ─── Fleet Presets ──────────────────────────────────────

    bindAction('create-preset', () => {
        editingPresetId = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-preset"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingPresetId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-preset"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const preset = fleetPresets.find(p => p.id === id);
            if (!preset) return;
            const confirmed = await showConfirmDialog({
                title: `Delete preset "${preset.name}"?`,
                subtitle: 'This action cannot be undone.',
                severity: preset.isActive ? 'warning' : 'info',
            });
            if (!confirmed) return;
            try {
                await deleteFleetPreset(id);
                fleetPresets = fleetPresets.filter(p => p.id !== id);
                render();
            } catch (err) {
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    area.querySelectorAll('[data-action="activate-preset"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            try {
                await activateFleetPreset(id);
                await refresh();
            } catch (err) {
                console.error('Activate preset failed:', err);
                formError = err.message || 'Activation failed.';
                render();
            }
        });
    });

    area.querySelectorAll('[data-action="reactivate-preset"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const preset = fleetPresets.find(p => p.id === id);
            if (!preset) return;
            const manualCount = planItems.filter(pi => pi.source === 'manual').length;
            const confirmed = await showConfirmDialog({
                title: `Re-activate "${preset.name}"?`,
                subtitle: manualCount > 0
                    ? `This will clear ${manualCount} manual override(s) and re-expand preset slots.`
                    : 'This will re-expand preset slots to plan items.',
                severity: manualCount > 0 ? 'warning' : 'info',
            });
            if (!confirmed) return;
            try {
                await activateFleetPreset(id);
                await refresh();
            } catch (err) {
                console.error('Re-activate failed:', err);
                formError = err.message || 'Re-activation failed.';
                render();
            }
        });
    });

    bindAction('save-preset', () => handleSavePreset());

    // ─── Plan Items ─────────────────────────────────────────

    bindAction('create-item', () => {
        editingPlanItemId = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-item"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingPlanItemId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-item"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const confirmed = await showConfirmDialog({
                title: 'Delete this plan item?',
                subtitle: 'This action cannot be undone.',
                severity: 'info',
            });
            if (!confirmed) return;
            try {
                await deleteCrewPlanItem(id);
                planItems = planItems.filter(pi => pi.id !== id);
                render();
            } catch (err) {
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    bindAction('save-item', () => handleSavePlanItem());

    // ─── Cancel form (shared) ───────────────────────────────

    area.querySelectorAll('[data-action="cancel-form"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingPresetId = null;
            editingPlanItemId = null;
            overrideDock = null;
            formError = '';
            render();
        });
    });
}

/** Bind a single-instance action button by data-action value */
function bindAction(action, handler) {
    const area = $('#plan-area');
    const btn = area?.querySelector(`[data-action="${action}"]`);
    if (btn) btn.addEventListener('click', handler);
}

// ═══════════════════════════════════════════════════════════
// SAVE HANDLERS
// ═══════════════════════════════════════════════════════════

async function handleSaveOverride() {
    const area = $('#plan-area');
    const form = area?.querySelector('.plan-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const loadoutId = getValue('loadoutId') ? parseInt(getValue('loadoutId'), 10) : null;
    if (!loadoutId) { formError = 'Select a loadout.'; render(); return; }

    const label = (getValue('label') || '').trim() || null;
    const priority = parseInt(getValue('priority'), 10) || 1;

    try {
        await createCrewPlanItem({
            loadoutId,
            dockNumber: overrideDock,
            label,
            priority,
            isActive: true,
            source: 'manual',
        });
        overrideDock = null;
        formError = '';
        await refresh();
    } catch (err) {
        formError = err.message || 'Override failed.';
        render();
    }
}

async function handleSavePreset() {
    const area = $('#plan-area');
    const form = area?.querySelector('.plan-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }

    const notes = (getValue('notes') || '').trim() || null;

    try {
        if (editingPresetId === 'new') {
            const resp = await createFleetPreset(name, notes);
            const created = resp?.fleetPreset ?? resp;
            fleetPresets.push(created);
        } else {
            await updateFleetPreset(editingPresetId, { name, notes });
            const idx = fleetPresets.findIndex(p => p.id === editingPresetId);
            if (idx !== -1) fleetPresets[idx] = { ...fleetPresets[idx], name, notes };
        }
        editingPresetId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSavePlanItem() {
    const area = $('#plan-area');
    const form = area?.querySelector('.plan-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const loadoutId = getValue('loadoutId') ? parseInt(getValue('loadoutId'), 10) : null;
    const dockNumber = getValue('dockNumber') ? parseInt(getValue('dockNumber'), 10) : null;
    const label = (getValue('label') || '').trim() || null;
    const intentKey = (getValue('intentKey') || '').trim() || null;
    const priority = parseInt(getValue('priority'), 10) || 1;
    const isActive = getValue('isActive');
    const notes = (getValue('notes') || '').trim() || null;

    if (!loadoutId) { formError = 'Select a loadout.'; render(); return; }

    const data = { loadoutId, dockNumber, label, intentKey, priority, isActive, source: 'manual', notes };

    try {
        if (editingPlanItemId === 'new') {
            const resp = await createCrewPlanItem(data);
            const created = resp?.planItem ?? resp;
            planItems.push(created);
        } else {
            await updateCrewPlanItem(editingPlanItemId, data);
            const idx = planItems.findIndex(pi => pi.id === editingPlanItemId);
            if (idx !== -1) planItems[idx] = { ...planItems[idx], ...data };
        }
        editingPlanItemId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function officerById(id) {
    return officers.find(o => o.id === id) ?? null;
}
