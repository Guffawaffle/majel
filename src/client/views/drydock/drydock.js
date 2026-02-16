/**
 * drydock.js — Drydock: Crew Loadout Manager (ADR-025)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages crew loadouts: bridge core + below-deck-policy assignments per ship.
 * Supports create, edit, delete, search, filter by intent/tag, and active toggle.
 *
 * Design goals:
 * - Lists all crew loadouts with ship name, bridge core, intent, tags, status
 * - Create/edit via inline form (expandable panel)
 * - Search + filter toolbar
 * - Bridge core & below-deck policy pickers (dropdowns populated from API)
 * - Active/inactive toggle per loadout
 */

import {
    fetchCrewLoadouts, createCrewLoadout, updateCrewLoadout, deleteCrewLoadout,
    fetchBridgeCores, fetchBelowDeckPolicies,
} from 'api/crews.js';
import { fetchCatalogShips } from 'api/catalog.js';
import { esc } from 'utils/escape.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let loadouts = [];
let bridgeCores = [];
let belowDeckPolicies = [];
let ships = [];          // owned ships from catalog
let searchQuery = '';
let filterIntent = '';   // filter by intent key
let filterActive = '';   // '' | 'true' | 'false'
let sortField = 'name';
let sortDir = 'asc';
let loading = false;
let editingId = null;    // id of loadout being edited, or 'new' for create form
let formError = '';

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('drydock', {
    area: $('#drydock-area'),
    icon: '⚓', title: 'Drydock', subtitle: 'Crew loadouts — assign bridge crews to ships',
    cssHref: 'views/drydock/drydock.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#drydock-area');
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [loadoutData, coreData, bdpData, shipData] = await Promise.all([
            fetchCrewLoadouts(),
            fetchBridgeCores(),
            fetchBelowDeckPolicies(),
            fetchCatalogShips({ ownership: 'owned' }),
        ]);
        loadouts = loadoutData?.loadouts ?? loadoutData ?? [];
        bridgeCores = coreData?.bridgeCores ?? coreData ?? [];
        belowDeckPolicies = bdpData?.belowDeckPolicies ?? bdpData ?? [];
        ships = Array.isArray(shipData) ? shipData : (shipData?.ships ?? []);
        render();
    } catch (err) {
        console.error('Drydock refresh failed:', err);
        const area = $('#drydock-area');
        if (area) area.innerHTML = `<div class="drydock-error">Failed to load drydock: ${esc(err.message)}</div>`;
    } finally {
        loading = false;
    }
}

// ─── Sorting ────────────────────────────────────────────────

function sortItems(items) {
    const sorted = [...items];
    sorted.sort((a, b) => {
        let cmp = 0;
        switch (sortField) {
            case 'ship':
                cmp = (shipName(a.shipId) || '').localeCompare(shipName(b.shipId) || '');
                break;
            case 'priority':
                cmp = (a.priority || 0) - (b.priority || 0);
                break;
            default: // name
                cmp = (a.name || '').localeCompare(b.name || '');
        }
        return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $('#drydock-area');
    if (!area) return;

    // Apply filters
    let filtered = loadouts;
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        filtered = filtered.filter(l =>
            (l.name && l.name.toLowerCase().includes(q)) ||
            (shipName(l.shipId) || '').toLowerCase().includes(q)
        );
    }
    if (filterIntent) {
        filtered = filtered.filter(l =>
            Array.isArray(l.intentKeys) && l.intentKeys.includes(filterIntent)
        );
    }
    if (filterActive === 'true') {
        filtered = filtered.filter(l => l.isActive);
    } else if (filterActive === 'false') {
        filtered = filtered.filter(l => !l.isActive);
    }

    const items = sortItems(filtered);

    area.innerHTML = `
        ${renderStatsBar()}
        ${renderToolbar()}
        ${editingId === 'new' ? renderForm(null) : ''}
        <div class="drydock-list">
            ${items.length === 0 ? renderEmpty() : items.map(l => renderLoadout(l)).join('')}
        </div>
    `;
    bindEvents();
}

function renderStatsBar() {
    const total = loadouts.length;
    const active = loadouts.filter(l => l.isActive).length;
    const uniqueShips = new Set(loadouts.map(l => l.shipId)).size;
    return `
        <div class="drydock-stats">
            <span class="drydock-stat"><strong>${total}</strong> loadout${total !== 1 ? 's' : ''}</span>
            <span class="drydock-stat-sep">·</span>
            <span class="drydock-stat"><strong>${active}</strong> active</span>
            <span class="drydock-stat-sep">·</span>
            <span class="drydock-stat"><strong>${uniqueShips}</strong> ship${uniqueShips !== 1 ? 's' : ''}</span>
        </div>
    `;
}

function renderToolbar() {
    const intentKeys = collectIntentKeys();
    const sortOptions = [
        { value: 'name', label: 'Name' },
        { value: 'ship', label: 'Ship' },
        { value: 'priority', label: 'Priority' },
    ];
    return `
        <div class="drydock-toolbar">
            <div class="drydock-search-wrap">
                <input type="text" class="drydock-search" placeholder="Search loadouts…" value="${esc(searchQuery)}" />
            </div>
            <div class="drydock-filters">
                <select class="drydock-filter-select" data-filter="intent" title="Filter by intent">
                    <option value="">All intents</option>
                    ${intentKeys.map(k => `<option value="${esc(k)}" ${filterIntent === k ? 'selected' : ''}>${esc(k)}</option>`).join('')}
                </select>
                <select class="drydock-filter-select" data-filter="active" title="Filter by status">
                    <option value="" ${filterActive === '' ? 'selected' : ''}>All</option>
                    <option value="true" ${filterActive === 'true' ? 'selected' : ''}>Active</option>
                    <option value="false" ${filterActive === 'false' ? 'selected' : ''}>Inactive</option>
                </select>
            </div>
            <div class="drydock-sort">
                <label class="drydock-sort-label">Sort:</label>
                <select class="drydock-sort-select" data-action="sort-field">
                    ${sortOptions.map(o => `<option value="${o.value}" ${sortField === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <button class="drydock-sort-dir" data-action="sort-dir" title="Toggle sort direction">
                    ${sortDir === 'asc' ? '↑' : '↓'}
                </button>
            </div>
            <button class="drydock-create-btn" data-action="create" title="Create loadout">＋ New Loadout</button>
        </div>
    `;
}

function renderLoadout(l) {
    const sName = shipName(l.shipId) || l.shipId;
    const coreName = bridgeCoreName(l.bridgeCoreId);
    const bdpName = belowDeckPolicyName(l.belowDeckPolicyId);
    const intents = Array.isArray(l.intentKeys) ? l.intentKeys : [];
    const tags = Array.isArray(l.tags) ? l.tags : [];
    const isEditing = editingId === l.id;

    if (isEditing) {
        return renderForm(l);
    }

    return `
        <div class="drydock-card ${l.isActive ? '' : 'drydock-inactive'}" data-id="${l.id}">
            <div class="drydock-card-header">
                <div class="drydock-card-title">
                    <span class="drydock-status-dot ${l.isActive ? 'active' : 'inactive'}" title="${l.isActive ? 'Active' : 'Inactive'}"></span>
                    <span class="drydock-card-name">${esc(l.name)}</span>
                </div>
                <div class="drydock-card-actions">
                    <button class="drydock-action-btn" data-action="edit" data-id="${l.id}" title="Edit">✎</button>
                    <button class="drydock-action-btn drydock-action-danger" data-action="delete" data-id="${l.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="drydock-card-body">
                <div class="drydock-card-row">
                    <span class="drydock-label">Ship</span>
                    <span class="drydock-value">${esc(sName)}</span>
                </div>
                ${coreName ? `
                <div class="drydock-card-row">
                    <span class="drydock-label">Bridge Core</span>
                    <span class="drydock-value">${esc(coreName)}</span>
                </div>` : ''}
                ${bdpName ? `
                <div class="drydock-card-row">
                    <span class="drydock-label">Below Deck</span>
                    <span class="drydock-value">${esc(bdpName)}</span>
                </div>` : ''}
                ${l.priority ? `
                <div class="drydock-card-row">
                    <span class="drydock-label">Priority</span>
                    <span class="drydock-value">${l.priority}</span>
                </div>` : ''}
            </div>
            ${intents.length > 0 || tags.length > 0 ? `
            <div class="drydock-card-tags">
                ${intents.map(k => `<span class="drydock-tag drydock-tag-intent">${esc(k)}</span>`).join('')}
                ${tags.map(t => `<span class="drydock-tag drydock-tag-label">${esc(t)}</span>`).join('')}
            </div>` : ''}
            ${l.notes ? `<div class="drydock-card-notes">${esc(l.notes)}</div>` : ''}
        </div>
    `;
}

function renderForm(loadout) {
    const isNew = !loadout;
    const l = loadout || { name: '', shipId: '', bridgeCoreId: null, belowDeckPolicyId: null, priority: 0, isActive: true, intentKeys: [], tags: [], notes: '' };

    return `
        <div class="drydock-form" data-form-id="${isNew ? 'new' : l.id}">
            <div class="drydock-form-header">
                <h3>${isNew ? 'Create Loadout' : `Edit: ${esc(l.name)}`}</h3>
                <button class="drydock-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="drydock-form-error">${esc(formError)}</div>` : ''}
            <div class="drydock-form-grid">
                <label class="drydock-form-field">
                    <span class="drydock-form-label">Name *</span>
                    <input type="text" class="drydock-form-input" data-form-field="name"
                           value="${esc(l.name)}" placeholder="e.g. Enterprise PvP" maxlength="100" required />
                </label>
                <label class="drydock-form-field">
                    <span class="drydock-form-label">Ship *</span>
                    <select class="drydock-form-input drydock-form-select" data-form-field="shipId" ${isNew ? '' : 'disabled'}>
                        <option value="">— Select ship —</option>
                        ${ships.map(s => `<option value="${esc(s.id)}" ${l.shipId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="drydock-form-field">
                    <span class="drydock-form-label">Bridge Core</span>
                    <select class="drydock-form-input drydock-form-select" data-form-field="bridgeCoreId">
                        <option value="">— None —</option>
                        ${bridgeCores.map(c => `<option value="${c.id}" ${String(l.bridgeCoreId) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="drydock-form-field">
                    <span class="drydock-form-label">Below Deck Policy</span>
                    <select class="drydock-form-input drydock-form-select" data-form-field="belowDeckPolicyId">
                        <option value="">— None —</option>
                        ${belowDeckPolicies.map(p => `<option value="${p.id}" ${String(l.belowDeckPolicyId) === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="drydock-form-field">
                    <span class="drydock-form-label">Priority</span>
                    <input type="number" class="drydock-form-input" data-form-field="priority"
                           value="${l.priority || 0}" min="0" max="999" />
                </label>
                <label class="drydock-form-field drydock-form-check">
                    <input type="checkbox" data-form-field="isActive" ${l.isActive ? 'checked' : ''} />
                    <span class="drydock-form-label">Active</span>
                </label>
                <label class="drydock-form-field drydock-form-wide">
                    <span class="drydock-form-label">Intent Keys <span class="drydock-hint">(comma-separated)</span></span>
                    <input type="text" class="drydock-form-input" data-form-field="intentKeys"
                           value="${esc((l.intentKeys || []).join(', '))}" placeholder="e.g. pvp, armada, mining" />
                </label>
                <label class="drydock-form-field drydock-form-wide">
                    <span class="drydock-form-label">Tags <span class="drydock-hint">(comma-separated)</span></span>
                    <input type="text" class="drydock-form-input" data-form-field="tags"
                           value="${esc((l.tags || []).join(', '))}" placeholder="e.g. meta, daily, event" />
                </label>
                <label class="drydock-form-field drydock-form-wide">
                    <span class="drydock-form-label">Notes</span>
                    <textarea class="drydock-form-input drydock-form-textarea" data-form-field="notes"
                              rows="2" maxlength="500" placeholder="Optional notes…">${esc(l.notes || '')}</textarea>
                </label>
            </div>
            <div class="drydock-form-actions">
                <button class="drydock-btn drydock-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="drydock-btn drydock-btn-primary" data-action="save-form">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

function renderEmpty() {
    if (searchQuery || filterIntent || filterActive) {
        return `<div class="drydock-empty"><p>No loadouts match your filters.</p></div>`;
    }
    return `
        <div class="drydock-empty">
            <p>No crew loadouts yet.</p>
            <p class="hint">Click <strong>＋ New Loadout</strong> to assign a bridge core and below-deck policy to a ship.</p>
        </div>
    `;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $('#drydock-area');
    if (!area) return;

    // Search
    const searchInput = area.querySelector('.drydock-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            render();
            const s = area.querySelector('.drydock-search');
            if (s) { s.focus(); s.selectionStart = s.selectionEnd = s.value.length; }
        });
    }

    // Intent filter
    const intentFilter = area.querySelector('[data-filter="intent"]');
    if (intentFilter) {
        intentFilter.addEventListener('change', (e) => {
            filterIntent = e.target.value;
            render();
        });
    }

    // Active filter
    const activeFilter = area.querySelector('[data-filter="active"]');
    if (activeFilter) {
        activeFilter.addEventListener('change', (e) => {
            filterActive = e.target.value;
            render();
        });
    }

    // Sort controls
    const sortSelect = area.querySelector('[data-action="sort-field"]');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            sortField = e.target.value;
            render();
        });
    }
    const sortBtn = area.querySelector('[data-action="sort-dir"]');
    if (sortBtn) {
        sortBtn.addEventListener('click', () => {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            render();
        });
    }

    // Create button
    const createBtn = area.querySelector('[data-action="create"]');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            editingId = 'new';
            formError = '';
            render();
        });
    }

    // Edit buttons
    area.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    // Delete buttons
    area.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const loadout = loadouts.find(l => l.id === id);
            if (!loadout) return;
            if (!confirm(`Delete loadout "${loadout.name}"?`)) return;
            try {
                await deleteCrewLoadout(id);
                loadouts = loadouts.filter(l => l.id !== id);
                if (editingId === id) editingId = null;
                render();
            } catch (err) {
                console.error('Delete loadout failed:', err);
                alert(`Failed to delete: ${err.message}`);
            }
        });
    });

    // Cancel form
    area.querySelectorAll('[data-action="cancel-form"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingId = null;
            formError = '';
            render();
        });
    });

    // Save form
    const saveBtn = area.querySelector('[data-action="save-form"]');
    if (saveBtn) {
        saveBtn.addEventListener('click', () => handleSave());
    }

    // Form enter-to-save
    const formEl = area.querySelector('.drydock-form');
    if (formEl) {
        formEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
                e.preventDefault();
                handleSave();
            }
        });
    }
}

// ─── Save Handler ───────────────────────────────────────────

async function handleSave() {
    const area = $('#drydock-area');
    if (!area) return;
    const form = area.querySelector('.drydock-form');
    if (!form) return;

    const getValue = (field) => {
        const el = form.querySelector(`[data-form-field="${field}"]`);
        if (!el) return null;
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const name = (getValue('name') || '').trim();
    const shipId = getValue('shipId') || '';
    const bridgeCoreIdRaw = getValue('bridgeCoreId');
    const bridgeCoreId = bridgeCoreIdRaw ? parseInt(bridgeCoreIdRaw, 10) : null;
    const belowDeckPolicyIdRaw = getValue('belowDeckPolicyId');
    const belowDeckPolicyId = belowDeckPolicyIdRaw ? parseInt(belowDeckPolicyIdRaw, 10) : null;
    const priority = parseInt(getValue('priority') || '0', 10) || 0;
    const isActive = getValue('isActive');
    const intentKeysRaw = (getValue('intentKeys') || '').trim();
    const intentKeys = intentKeysRaw ? intentKeysRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const tagsRaw = (getValue('tags') || '').trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const notes = (getValue('notes') || '').trim() || null;

    // Validation
    if (!name) { formError = 'Name is required.'; render(); return; }
    if (!shipId && editingId === 'new') { formError = 'Ship is required.'; render(); return; }

    const data = { name, bridgeCoreId, belowDeckPolicyId, priority, isActive, intentKeys, tags, notes };
    if (editingId === 'new') data.shipId = shipId;

    try {
        if (editingId === 'new') {
            const resp = await createCrewLoadout(data);
            const created = resp?.loadout ?? resp;
            loadouts.push(created);
        } else {
            const resp = await updateCrewLoadout(editingId, data);
            const updated = resp?.loadout ?? resp;
            const idx = loadouts.findIndex(l => l.id === editingId);
            if (idx !== -1) loadouts[idx] = { ...loadouts[idx], ...updated };
        }
        editingId = null;
        formError = '';
        render();
    } catch (err) {
        console.error('Save loadout failed:', err);
        formError = err.message || 'Save failed.';
        render();
    }
}

// ─── Helpers ────────────────────────────────────────────────

function shipName(shipId) {
    if (!shipId) return null;
    const s = ships.find(s => s.id === shipId);
    return s ? s.name : null;
}

function bridgeCoreName(id) {
    if (id == null) return null;
    const c = bridgeCores.find(c => c.id === id);
    return c ? c.name : null;
}

function belowDeckPolicyName(id) {
    if (id == null) return null;
    const p = belowDeckPolicies.find(p => p.id === id);
    return p ? p.name : null;
}

function collectIntentKeys() {
    const keys = new Set();
    for (const l of loadouts) {
        if (Array.isArray(l.intentKeys)) {
            for (const k of l.intentKeys) keys.add(k);
        }
    }
    return [...keys].sort();
}
