/**
 * fleet-ops.js — Fleet Ops: Docks, Presets & Deployment (ADR-025 Phase C)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages fleet deployment:
 * - Docks: numbered ship berths to organize your fleet
 * - Fleet Presets: saved configurations assigning loadouts to docks
 * - Deployment: live effective state with officer conflict detection
 *
 * Design goals:
 * - Visual dock grid with loadout assignment
 * - One-click preset activation
 * - Clear conflict alerts (same officer used in multiple seats)
 */

import {
    fetchCrewDocks, upsertCrewDock, deleteCrewDock,
    fetchFleetPresets, createFleetPreset, updateFleetPreset, deleteFleetPreset,
    setFleetPresetSlots, activateFleetPreset,
    fetchCrewLoadouts, fetchEffectiveState,
} from 'api/crews.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let docks = [];
let presets = [];       // FleetPresetWithSlots[]
let loadouts = [];      // for assignment pickers
let effectiveState = null; // { docks, awayTeams, conflicts }
let activeTab = 'docks'; // 'docks' | 'presets' | 'deployment'
let loading = false;
let editingDock = null;   // dock number being edited, or 'new'
let editingPreset = null; // preset id being edited, or 'new'
let editingSlots = null;  // preset id whose slots are being edited
let formError = '';

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('fleet-ops', {
    area: $('#fleet-ops-area'),
    icon: '🎯', title: 'Fleet Ops', subtitle: 'Docks, presets & deployment',
    cssHref: 'views/fleet-ops/fleet-ops.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#fleet-ops-area');
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [dockData, presetData, loadoutData] = await Promise.all([
            fetchCrewDocks(),
            fetchFleetPresets(),
            fetchCrewLoadouts(),
        ]);
        docks = dockData?.docks ?? dockData ?? [];
        presets = presetData?.presets ?? presetData ?? [];
        loadouts = loadoutData?.loadouts ?? loadoutData ?? [];

        // Load effective state for deployment tab
        if (activeTab === 'deployment') {
            await refreshEffectiveState();
        }

        render();
    } catch (err) {
        console.error('Fleet Ops refresh failed:', err);
        const area = $('#fleet-ops-area');
        if (area) area.innerHTML = `<div class="fo-error">Failed to load fleet ops: ${esc(err.message)}</div>`;
    } finally {
        loading = false;
    }
}

async function refreshEffectiveState() {
    try {
        const data = await fetchEffectiveState();
        effectiveState = data ?? null;
    } catch (err) {
        console.error('Effective state fetch failed:', err);
        effectiveState = null;
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $('#fleet-ops-area');
    if (!area) return;

    area.innerHTML = `
        ${renderTabBar()}
        <div class="fo-content">
            ${activeTab === 'docks' ? renderDocksTab() : ''}
            ${activeTab === 'presets' ? renderPresetsTab() : ''}
            ${activeTab === 'deployment' ? renderDeploymentTab() : ''}
        </div>
    `;
    bindEvents();
}

function renderTabBar() {
    return `
        <div class="fo-tabs">
            <button class="fo-tab ${activeTab === 'docks' ? 'active' : ''}" data-tab="docks">
                Docks <span class="fo-tab-count">${docks.length}</span>
            </button>
            <button class="fo-tab ${activeTab === 'presets' ? 'active' : ''}" data-tab="presets">
                Presets <span class="fo-tab-count">${presets.length}</span>
            </button>
            <button class="fo-tab ${activeTab === 'deployment' ? 'active' : ''}" data-tab="deployment">
                Deployment
            </button>
        </div>
    `;
}

// ─── Docks Tab ──────────────────────────────────────────────

function renderDocksTab() {
    const sorted = [...docks].sort((a, b) => a.dockNumber - b.dockNumber);
    return `
        <div class="fo-section">
            <div class="fo-toolbar">
                <h3 class="fo-toolbar-title">Ship Docks</h3>
                <button class="fo-create-btn" data-action="create-dock">+ New Dock</button>
            </div>
            ${editingDock === 'new' ? renderDockForm(null) : ''}
            <div class="fo-grid">
                ${sorted.length === 0
                    ? renderEmpty('No docks configured. Create docks to assign loadouts to numbered berths.')
                    : sorted.map(d => renderDockCard(d)).join('')}
            </div>
        </div>
    `;
}

function renderDockCard(dock) {
    if (editingDock === dock.dockNumber) return renderDockForm(dock);
    const lockIcon = dock.unlocked ? '🔓' : '🔒';
    return `
        <div class="fo-card ${dock.unlocked ? '' : 'fo-card-locked'}" data-dock="${dock.dockNumber}">
            <div class="fo-card-header">
                <div class="fo-card-title">
                    <span class="fo-dock-num">#${dock.dockNumber}</span>
                    <span class="fo-card-name">${esc(dock.label || `Dock ${dock.dockNumber}`)}</span>
                    <span class="fo-lock-icon" title="${dock.unlocked ? 'Unlocked' : 'Locked'}">${lockIcon}</span>
                </div>
                <div class="fo-card-actions">
                    <button class="fo-action-btn" data-action="edit-dock" data-num="${dock.dockNumber}" title="Edit">✎</button>
                    <button class="fo-action-btn fo-action-danger" data-action="delete-dock" data-num="${dock.dockNumber}" title="Delete">✕</button>
                </div>
            </div>
            ${dock.notes ? `<div class="fo-card-notes">${esc(dock.notes)}</div>` : ''}
        </div>
    `;
}

function renderDockForm(dock) {
    const isNew = !dock;
    const d = dock || { dockNumber: nextDockNumber(), label: '', unlocked: true, notes: '' };
    return `
        <div class="fo-form" data-form-id="${isNew ? 'new' : d.dockNumber}">
            <div class="fo-form-header">
                <h3>${isNew ? 'Create Dock' : `Edit Dock #${d.dockNumber}`}</h3>
                <button class="fo-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="fo-form-error">${esc(formError)}</div>` : ''}
            <div class="fo-form-grid">
                <label class="fo-form-field">
                    <span class="fo-form-label">Dock Number *</span>
                    <input type="number" class="fo-form-input" data-form-field="dockNumber"
                           value="${d.dockNumber}" min="1" max="99" ${isNew ? '' : 'disabled'} required />
                </label>
                <label class="fo-form-field">
                    <span class="fo-form-label">Label</span>
                    <input type="text" class="fo-form-input" data-form-field="label"
                           value="${esc(d.label || '')}" placeholder="e.g. Main Warship" maxlength="100" />
                </label>
                <label class="fo-form-field fo-form-checkbox-field">
                    <input type="checkbox" data-form-field="unlocked" ${d.unlocked ? 'checked' : ''} />
                    <span class="fo-form-label">Unlocked</span>
                </label>
                <label class="fo-form-field fo-form-wide">
                    <span class="fo-form-label">Notes</span>
                    <textarea class="fo-form-input fo-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(d.notes || '')}</textarea>
                </label>
            </div>
            <div class="fo-form-actions">
                <button class="fo-btn fo-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="fo-btn fo-btn-primary" data-action="save-dock">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ─── Presets Tab ────────────────────────────────────────────

function renderPresetsTab() {
    return `
        <div class="fo-section">
            <div class="fo-toolbar">
                <h3 class="fo-toolbar-title">Fleet Presets</h3>
                <button class="fo-create-btn" data-action="create-preset">+ New Preset</button>
            </div>
            ${editingPreset === 'new' ? renderPresetForm(null) : ''}
            <div class="fo-list">
                ${presets.length === 0
                    ? renderEmpty('No fleet presets yet. Create one to save dock assignments you can activate with one click.')
                    : presets.map(p => {
                        let html = renderPresetCard(p);
                        if (editingSlots === p.id) html += renderSlotEditor(p.id);
                        return html;
                    }).join('')}
            </div>
        </div>
    `;
}

function renderPresetCard(preset) {
    if (editingPreset === preset.id) return renderPresetForm(preset);

    const slots = preset.slots || [];
    const slotSummary = slots.length > 0
        ? slots.map(s => {
            const lo = loadoutById(s.loadoutId);
            const dockLabel = s.dockNumber != null ? `Dock #${s.dockNumber}` : '—';
            const loName = lo ? lo.name : (s.loadoutId ? `#${s.loadoutId}` : '—');
            return `<div class="fo-slot-row">
                <span class="fo-slot-dock">${esc(dockLabel)}</span>
                <span class="fo-slot-arrow">→</span>
                <span class="fo-slot-loadout">${esc(loName)}</span>
            </div>`;
        }).join('')
        : '<div class="fo-muted">No slots configured</div>';

    const isActive = preset.isActive;

    return `
        <div class="fo-card ${isActive ? 'fo-card-active' : ''}" data-id="${preset.id}">
            <div class="fo-card-header">
                <div class="fo-card-title">
                    <span class="fo-card-name">${esc(preset.name)}</span>
                    ${isActive ? '<span class="fo-badge fo-badge-active">Active</span>' : ''}
                </div>
                <div class="fo-card-actions">
                    ${!isActive ? `<button class="fo-action-btn fo-action-activate" data-action="activate-preset" data-id="${preset.id}" title="Activate">⚡</button>` : ''}
                    <button class="fo-action-btn" data-action="edit-slots" data-id="${preset.id}" title="Edit slots">⚙</button>
                    <button class="fo-action-btn" data-action="edit-preset" data-id="${preset.id}" title="Edit">✎</button>
                    <button class="fo-action-btn fo-action-danger" data-action="delete-preset" data-id="${preset.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="fo-card-body fo-slot-list">
                ${slotSummary}
            </div>
            ${preset.notes ? `<div class="fo-card-notes">${esc(preset.notes)}</div>` : ''}
        </div>
    `;
}

function renderPresetForm(preset) {
    const isNew = !preset;
    const p = preset || { name: '', notes: '' };
    return `
        <div class="fo-form" data-form-id="${isNew ? 'new' : p.id}">
            <div class="fo-form-header">
                <h3>${isNew ? 'Create Fleet Preset' : `Edit: ${esc(p.name)}`}</h3>
                <button class="fo-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="fo-form-error">${esc(formError)}</div>` : ''}
            <div class="fo-form-grid">
                <label class="fo-form-field fo-form-wide">
                    <span class="fo-form-label">Name *</span>
                    <input type="text" class="fo-form-input" data-form-field="name"
                           value="${esc(p.name)}" placeholder="e.g. PvP Armada Setup" maxlength="100" required />
                </label>
                <label class="fo-form-field fo-form-wide">
                    <span class="fo-form-label">Notes</span>
                    <textarea class="fo-form-input fo-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(p.notes || '')}</textarea>
                </label>
            </div>
            <div class="fo-form-actions">
                <button class="fo-btn fo-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="fo-btn fo-btn-primary" data-action="save-preset">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ─── Slot Editor (inline under preset) ──────────────────────

function renderSlotEditor(presetId) {
    const preset = presets.find(p => p.id === presetId);
    if (!preset) return '';
    const slots = preset.slots || [];
    const sortedDocks = [...docks].sort((a, b) => a.dockNumber - b.dockNumber);

    return `
        <div class="fo-slot-editor" data-preset-id="${presetId}">
            <div class="fo-form-header">
                <h3>Slots for: ${esc(preset.name)}</h3>
                <button class="fo-action-btn" data-action="cancel-slots" title="Close">✕</button>
            </div>
            ${formError ? `<div class="fo-form-error">${esc(formError)}</div>` : ''}
            <div class="fo-slot-grid">
                ${sortedDocks.length === 0
                    ? '<div class="fo-muted">Create docks first to assign loadouts.</div>'
                    : sortedDocks.map(dock => {
                        const slot = slots.find(s => s.dockNumber === dock.dockNumber);
                        const selectedLoadout = slot ? slot.loadoutId : '';
                        return `
                        <div class="fo-slot-row-edit">
                            <span class="fo-slot-dock-label">#${dock.dockNumber} ${esc(dock.label || '')}</span>
                            <select class="fo-form-select" data-slot-dock="${dock.dockNumber}">
                                <option value="">— No loadout —</option>
                                ${loadouts.map(lo =>
                                    `<option value="${lo.id}" ${selectedLoadout === lo.id ? 'selected' : ''}>${esc(lo.name)}</option>`
                                ).join('')}
                            </select>
                        </div>`;
                    }).join('')}
            </div>
            <div class="fo-form-actions">
                <button class="fo-btn fo-btn-secondary" data-action="cancel-slots">Cancel</button>
                <button class="fo-btn fo-btn-primary" data-action="save-slots" data-id="${presetId}">Save Slots</button>
            </div>
        </div>
    `;
}

// ─── Deployment Tab ─────────────────────────────────────────

function renderDeploymentTab() {
    if (!effectiveState) {
        return `<div class="fo-section">
            <div class="fo-toolbar"><h3 class="fo-toolbar-title">Effective Deployment</h3></div>
            <div class="fo-muted" style="padding:20px;">Loading deployment state…</div>
        </div>`;
    }

    const { docks: effectiveDocks = [], awayTeams = [], conflicts = [] } = effectiveState;

    return `
        <div class="fo-section">
            <div class="fo-toolbar">
                <h3 class="fo-toolbar-title">Effective Deployment</h3>
                <button class="fo-create-btn" data-action="refresh-deployment">↻ Refresh</button>
            </div>

            ${conflicts.length > 0 ? renderConflicts(conflicts) : ''}

            <div class="fo-deploy-section">
                <h4 class="fo-deploy-heading">Dock Assignments</h4>
                <div class="fo-list">
                    ${effectiveDocks.length === 0
                        ? renderEmpty('No dock assignments active.')
                        : effectiveDocks.map(d => renderEffectiveDock(d)).join('')}
                </div>
            </div>

            ${awayTeams.length > 0 ? `
            <div class="fo-deploy-section">
                <h4 class="fo-deploy-heading">Away Teams</h4>
                <div class="fo-list">
                    ${awayTeams.map(t => renderAwayTeam(t)).join('')}
                </div>
            </div>` : ''}
        </div>
    `;
}

function renderConflicts(conflicts) {
    return `
        <div class="fo-conflicts">
            <div class="fo-conflicts-header">⚠️ Officer Conflicts (${conflicts.length})</div>
            ${conflicts.map(c => `
                <div class="fo-conflict-row">
                    <span class="fo-conflict-officer">${esc(c.officerId)}</span>
                    <span class="fo-conflict-detail">Used in ${c.locations.length} locations: ${
                        c.locations.map(l => `${esc(l.entityName)}${l.slot ? ` (${l.slot})` : ''}`).join(', ')
                    }</span>
                </div>
            `).join('')}
        </div>
    `;
}

function renderEffectiveDock(entry) {
    const lo = entry.loadout;
    return `
        <div class="fo-card">
            <div class="fo-card-header">
                <div class="fo-card-title">
                    <span class="fo-dock-num">#${entry.dockNumber}</span>
                    <span class="fo-card-name">${lo ? esc(lo.name) : '<span class="fo-muted">Empty</span>'}</span>
                    <span class="fo-badge fo-badge-source">${esc(entry.source)}</span>
                </div>
            </div>
            ${lo ? `
            <div class="fo-card-body">
                <div class="fo-deploy-row"><span class="fo-label">Ship</span> <span class="fo-value">${esc(lo.shipId || '—')}</span></div>
                <div class="fo-deploy-row"><span class="fo-label">Captain</span> <span class="fo-value">${esc(lo.bridge?.captain || '—')}</span></div>
                <div class="fo-deploy-row"><span class="fo-label">Bridge 1</span> <span class="fo-value">${esc(lo.bridge?.bridge_1 || '—')}</span></div>
                <div class="fo-deploy-row"><span class="fo-label">Bridge 2</span> <span class="fo-value">${esc(lo.bridge?.bridge_2 || '—')}</span></div>
                ${(entry.intentKeys || []).length > 0 ? `<div class="fo-deploy-row"><span class="fo-label">Intents</span> <span class="fo-value">${esc(entry.intentKeys.join(', '))}</span></div>` : ''}
            </div>` : ''}
        </div>
    `;
}

function renderAwayTeam(team) {
    return `
        <div class="fo-card">
            <div class="fo-card-header">
                <div class="fo-card-title">
                    <span class="fo-card-name">${esc(team.label || 'Away Team')}</span>
                    <span class="fo-badge fo-badge-source">${esc(team.source)}</span>
                </div>
            </div>
            <div class="fo-card-body">
                <div class="fo-deploy-row">
                    <span class="fo-label">Officers</span>
                    <span class="fo-value">${(team.officers || []).map(o => esc(o)).join(', ') || '—'}</span>
                </div>
            </div>
        </div>
    `;
}

function renderEmpty(msg) {
    return `<div class="fo-empty"><p>${msg}</p></div>`;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $('#fleet-ops-area');
    if (!area) return;

    // Tab switching
    area.querySelectorAll('.fo-tab').forEach(btn => {
        btn.addEventListener('click', async () => {
            activeTab = btn.dataset.tab;
            editingDock = null;
            editingPreset = null;
            editingSlots = null;
            formError = '';
            if (activeTab === 'deployment' && !effectiveState) {
                await refreshEffectiveState();
            }
            render();
        });
    });

    // ─── Docks ──────────────────────────────────────────────

    const createDockBtn = area.querySelector('[data-action="create-dock"]');
    if (createDockBtn) {
        createDockBtn.addEventListener('click', () => {
            editingDock = 'new';
            formError = '';
            render();
        });
    }

    area.querySelectorAll('[data-action="edit-dock"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingDock = parseInt(btn.dataset.num, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-dock"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const num = parseInt(btn.dataset.num, 10);
            if (!confirm(`Delete dock #${num}?`)) return;
            try {
                await deleteCrewDock(num);
                docks = docks.filter(d => d.dockNumber !== num);
                render();
            } catch (err) {
                alert(`Failed to delete: ${err.message}`);
            }
        });
    });

    const saveDockBtn = area.querySelector('[data-action="save-dock"]');
    if (saveDockBtn) saveDockBtn.addEventListener('click', () => handleSaveDock());

    // ─── Presets ────────────────────────────────────────────

    const createPresetBtn = area.querySelector('[data-action="create-preset"]');
    if (createPresetBtn) {
        createPresetBtn.addEventListener('click', () => {
            editingPreset = 'new';
            formError = '';
            render();
        });
    }

    area.querySelectorAll('[data-action="edit-preset"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingPreset = parseInt(btn.dataset.id, 10);
            editingSlots = null;
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-preset"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const preset = presets.find(p => p.id === id);
            if (!preset) return;
            if (!confirm(`Delete preset "${preset.name}"?`)) return;
            try {
                await deleteFleetPreset(id);
                presets = presets.filter(p => p.id !== id);
                render();
            } catch (err) {
                alert(`Failed to delete: ${err.message}`);
            }
        });
    });

    area.querySelectorAll('[data-action="activate-preset"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            try {
                await activateFleetPreset(id);
                // Mark all inactive, then this one active
                presets.forEach(p => p.isActive = false);
                const p = presets.find(p => p.id === id);
                if (p) p.isActive = true;
                render();
            } catch (err) {
                alert(`Failed to activate: ${err.message}`);
            }
        });
    });

    area.querySelectorAll('[data-action="edit-slots"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            editingSlots = (editingSlots === id) ? null : id;
            editingPreset = null;
            formError = '';
            render();
        });
    });

    const savePresetBtn = area.querySelector('[data-action="save-preset"]');
    if (savePresetBtn) savePresetBtn.addEventListener('click', () => handleSavePreset());

    // ─── Slot Editor ────────────────────────────────────────

    const saveSlotsBtn = area.querySelector('[data-action="save-slots"]');
    if (saveSlotsBtn) saveSlotsBtn.addEventListener('click', () => handleSaveSlots(parseInt(saveSlotsBtn.dataset.id, 10)));

    area.querySelectorAll('[data-action="cancel-slots"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingSlots = null;
            formError = '';
            render();
        });
    });

    // ─── Deployment ─────────────────────────────────────────

    const refreshBtn = area.querySelector('[data-action="refresh-deployment"]');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', async () => {
            await refreshEffectiveState();
            render();
        });
    }

    // Cancel form (shared)
    area.querySelectorAll('[data-action="cancel-form"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingDock = null;
            editingPreset = null;
            formError = '';
            render();
        });
    });

    // Enter-to-save
    const formEl = area.querySelector('.fo-form');
    if (formEl) {
        formEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                if (editingDock) handleSaveDock();
                else if (editingPreset) handleSavePreset();
            }
        });
    }
}

// ─── Save Handlers ──────────────────────────────────────────

async function handleSaveDock() {
    const area = $('#fleet-ops-area');
    const form = area?.querySelector('.fo-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const num = parseInt(getValue('dockNumber'), 10);
    if (!num || num < 1 || num > 99) { formError = 'Dock number must be 1–99.'; render(); return; }

    const label = (getValue('label') || '').trim() || null;
    const unlocked = getValue('unlocked');
    const notes = (getValue('notes') || '').trim() || null;

    try {
        await upsertCrewDock(num, { label, unlocked, notes });
        const idx = docks.findIndex(d => d.dockNumber === num);
        const now = new Date().toISOString();
        const updated = { dockNumber: num, label, unlocked, notes, createdAt: now, updatedAt: now };
        if (idx !== -1) docks[idx] = { ...docks[idx], ...updated };
        else docks.push(updated);
        editingDock = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Failed to save dock.';
        render();
    }
}

async function handleSavePreset() {
    const area = $('#fleet-ops-area');
    const form = area?.querySelector('.fo-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }
    const notes = (getValue('notes') || '').trim() || null;

    try {
        if (editingPreset === 'new') {
            const resp = await createFleetPreset(name, notes);
            const created = resp?.preset ?? resp;
            presets.push({ ...created, slots: [] });
        } else {
            await updateFleetPreset(editingPreset, { name, notes });
            const idx = presets.findIndex(p => p.id === editingPreset);
            if (idx !== -1) presets[idx] = { ...presets[idx], name, notes };
        }
        editingPreset = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Failed to save preset.';
        render();
    }
}

async function handleSaveSlots(presetId) {
    const area = $('#fleet-ops-area');
    if (!area) return;
    const editor = area.querySelector('.fo-slot-editor');
    if (!editor) return;

    const slots = [];
    editor.querySelectorAll('[data-slot-dock]').forEach(sel => {
        const dockNumber = parseInt(sel.dataset.slotDock, 10);
        const loadoutId = sel.value ? parseInt(sel.value, 10) : null;
        if (loadoutId) {
            slots.push({ dockNumber, loadoutId, priority: 0 });
        }
    });

    try {
        await setFleetPresetSlots(presetId, slots);
        // Update local state
        const preset = presets.find(p => p.id === presetId);
        if (preset) preset.slots = slots;
        editingSlots = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Failed to save slots.';
        render();
    }
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function nextDockNumber() {
    if (docks.length === 0) return 1;
    return Math.max(...docks.map(d => d.dockNumber)) + 1;
}

function loadoutById(id) {
    if (id == null) return null;
    return loadouts.find(l => l.id === id) ?? null;
}
