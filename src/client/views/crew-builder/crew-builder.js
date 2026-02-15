/**
 * crew-builder.js — Crew Builder: Officer Composition (ADR-025 Phase B)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Manages bridge crew composition:
 * - Create/edit bridge cores (captain, bridge_1, bridge_2 slots)
 * - Manage below-deck policies (pinned, selection mode)
 * - Test crew composition for conflicts
 * - Create load-out variants for different intents
 *
 * Design goals:
 * - Select owned officers for each bridge slot
 * - Pin officers to below-deck crew
 * - Show conflict detection results
 * - Manage multiple variants per loadout
 */

import {
    fetchBridgeCores, createBridgeCore, updateBridgeCore, deleteBridgeCore, setBridgeCoreMembers,
    fetchBelowDeckPolicies, createBelowDeckPolicy, updateBelowDeckPolicy, deleteBelowDeckPolicy,
    fetchCrewLoadouts,
} from 'api/crews.js';
import { fetchCatalogOfficers } from 'api/catalog.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let bridgeCores = [];
let belowDeckPolicies = [];
let loadouts = [];
let officers = [];  // owned officers only
let activeTab = 'cores'; // 'cores' | 'policies' | 'variants'
let searchQuery = '';
let sortField = 'name'; // 'name' | 'level'
let sortDir = 'asc';
let loading = false;
let editingCoreId = null;  // id of core being edited, or 'new'
let editingPolicyId = null; // id of policy being edited, or 'new'
let formError = '';

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('crew-builder', {
    area: $('#crew-builder-area'),
    icon: '👥', title: 'Crew Builder', subtitle: 'Compose bridge crews and manage policies',
    cssHref: 'views/crew-builder/crew-builder.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#crew-builder-area');
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [coresData, policiesData, loadoutsData, officerData] = await Promise.all([
            fetchBridgeCores(),
            fetchBelowDeckPolicies(),
            fetchCrewLoadouts(),
            fetchCatalogOfficers({ ownership: 'owned' }),
        ]);
        bridgeCores = coresData?.bridgeCores ?? coresData ?? [];
        belowDeckPolicies = policiesData?.belowDeckPolicies ?? policiesData ?? [];
        loadouts = loadoutsData?.loadouts ?? loadoutsData ?? [];
        officers = Array.isArray(officerData) ? officerData : (officerData?.data ?? []);
        render();
    } catch (err) {
        console.error('Crew builder refresh failed:', err);
        const area = $('#crew-builder-area');
        if (area) area.innerHTML = `<div class="crew-builder-error">Failed to load crew builder: ${esc(err.message)}</div>`;
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
            case 'level':
                cmp = (a.userLevel || 0) - (b.userLevel || 0);
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
    const area = $('#crew-builder-area');
    if (!area) return;

    area.innerHTML = `
        ${renderTabBar()}
        <div class="crew-builder-content">
            ${activeTab === 'cores' ? renderCoresTab() : ''}
            ${activeTab === 'policies' ? renderPoliciesTab() : ''}
            ${activeTab === 'variants' ? renderVariantsTab() : ''}
        </div>
    `;
    bindEvents();
}

function renderTabBar() {
    const coreCount = bridgeCores.length;
    const policyCount = belowDeckPolicies.length;
    return `
        <div class="crew-builder-tabs">
            <button class="crew-builder-tab ${activeTab === 'cores' ? 'active' : ''}" data-tab="cores">
                Bridge Cores <span class="crew-builder-tab-count">${coreCount}</span>
            </button>
            <button class="crew-builder-tab ${activeTab === 'policies' ? 'active' : ''}" data-tab="policies">
                Below Deck <span class="crew-builder-tab-count">${policyCount}</span>
            </button>
            <button class="crew-builder-tab ${activeTab === 'variants' ? 'active' : ''}" data-tab="variants">
                Variants
            </button>
        </div>
    `;
}

function renderCoresTab() {
    return `
        <div class="crew-builder-section">
            ${renderToolbar('Bridge Cores')}
            ${editingCoreId === 'new' ? renderCoreForm(null) : ''}
            <div class="crew-builder-list">
                ${bridgeCores.length === 0 ? renderEmpty('No bridge cores yet. Click + New to create one.') : bridgeCores.map(c => renderCoreCard(c)).join('')}
            </div>
        </div>
    `;
}

function renderPoliciesTab() {
    return `
        <div class="crew-builder-section">
            ${renderToolbar('Below Deck Policies')}
            ${editingPolicyId === 'new' ? renderPolicyForm(null) : ''}
            <div class="crew-builder-list">
                ${belowDeckPolicies.length === 0 ? renderEmpty('No below deck policies yet. Click + New to create one.') : belowDeckPolicies.map(p => renderPolicyCard(p)).join('')}
            </div>
        </div>
    `;
}

function renderVariantsTab() {
    return `
        <div class="crew-builder-section">
            <div class="crew-builder-toolbar" style="margin-bottom: 16px;">
                <div class="crew-builder-search-wrap">
                    <input type="text" class="crew-builder-search" placeholder="Search loadouts…" value="${esc(searchQuery)}" />
                </div>
                <select class="crew-builder-sort" data-action="sort-field">
                    <option value="name" ${sortField === 'name' ? 'selected' : ''}>Name</option>
                </select>
                <button class="crew-builder-sort-dir-btn" data-action="sort-dir" title="Toggle sort">
                    ${sortDir === 'asc' ? '↑' : '↓'}
                </button>
            </div>
            <div class="crew-builder-list">
                ${loadouts.length === 0 ? renderEmpty('No crew loadouts. Create some in Drydock first!') : loadouts.map(l => renderLoadoutVariantsCard(l)).join('')}
            </div>
        </div>
    `;
}

function renderToolbar(title) {
    return `
        <div class="crew-builder-toolbar" style="margin-bottom: 16px;">
            <h3 style="margin: 0; flex: 1; font-size: 0.95rem; color: var(--text-primary);">${title}</h3>
            <button class="crew-builder-create-btn" data-action="create" title="Create new">+ New</button>
        </div>
    `;
}

function renderCoreCard(core) {
    const isEditing = editingCoreId === core.id;
    if (isEditing) return renderCoreForm(core);

    const membersBySlot = {};
    for (const m of core.members || []) {
        membersBySlot[m.slot] = m.officerId;
    }

    const slotNames = { captain: 'Captain', bridge_1: 'Bridge 1', bridge_2: 'Bridge 2' };
    const slots = Object.entries(membersBySlot)
        .map(([slot, officerId]) => {
            const off = officers.find(o => o.id === officerId);
            const level = off ? ` (L${off.userLevel || '?'})` : '';
            return `<div class="crew-builder-slot"><strong>${slotNames[slot]}:</strong> ${esc(officerId)}${level}</div>`;
        })
        .join('');

    return `
        <div class="crew-builder-card" data-id="${core.id}">
            <div class="crew-builder-card-header">
                <div class="crew-builder-card-title">
                    <span class="crew-builder-card-name">${esc(core.name)}</span>
                </div>
                <div class="crew-builder-card-actions">
                    <button class="crew-builder-action-btn" data-action="edit-core" data-id="${core.id}" title="Edit">✎</button>
                    <button class="crew-builder-action-btn crew-builder-action-danger" data-action="delete-core" data-id="${core.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crew-builder-card-body">
                ${slots || '<p style="color: var(--text-muted);">No officers assigned</p>'}
            </div>
            ${core.notes ? `<div class="crew-builder-card-notes">${esc(core.notes)}</div>` : ''}
        </div>
    `;
}

function renderCoreForm(core) {
    const isNew = !core;
    const c = core || { name: '', members: [], notes: '' };
    const membersBySlot = {};
    for (const m of c.members || []) {
        membersBySlot[m.slot] = m.officerId;
    }

    const slotNames = { captain: 'Captain', bridge_1: 'Bridge 1', bridge_2: 'Bridge 2' };
    const slotInputs = ['captain', 'bridge_1', 'bridge_2']
        .map(slot => `
        <label class="crew-builder-form-field">
            <span class="crew-builder-form-label">${slotNames[slot]} *</span>
            <select class="crew-builder-form-select" data-form-field="slot_${slot}" required>
                <option value="">— Select officer —</option>
                ${officers.map(off => `<option value="${esc(off.id)}" ${membersBySlot[slot] === off.id ? 'selected' : ''}>${esc(off.name)} (L${off.userLevel || '?'})</option>`).join('')}
            </select>
        </label>
        `)
        .join('');

    return `
        <div class="crew-builder-form" data-form-id="${isNew ? 'new' : c.id}">
            <div class="crew-builder-form-header">
                <h3>${isNew ? 'Create Bridge Core' : `Edit: ${esc(c.name)}`}</h3>
                <button class="crew-builder-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crew-builder-form-error">${esc(formError)}</div>` : ''}
            <div class="crew-builder-form-grid">
                <label class="crew-builder-form-field">
                    <span class="crew-builder-form-label">Name *</span>
                    <input type="text" class="crew-builder-form-input" data-form-field="name"
                           value="${esc(c.name)}" placeholder="e.g. Armada Crew" maxlength="100" required />
                </label>
                ${slotInputs}
                <label class="crew-builder-form-field crew-builder-form-wide">
                    <span class="crew-builder-form-label">Notes</span>
                    <textarea class="crew-builder-form-input" style="resize: vertical; min-height: 48px;" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(c.notes || '')}</textarea>
                </label>
            </div>
            <div class="crew-builder-form-actions">
                <button class="crew-builder-btn crew-builder-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crew-builder-btn crew-builder-btn-primary" data-action="save-core">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

function renderPolicyCard(policy) {
    const isEditing = editingPolicyId === policy.id;
    if (isEditing) return renderPolicyForm(policy);

    const spec = policy.spec || {};
    const pinned = Array.isArray(spec.pinned) ? spec.pinned : [];

    return `
        <div class="crew-builder-card" data-id="${policy.id}">
            <div class="crew-builder-card-header">
                <div class="crew-builder-card-title">
                    <span class="crew-builder-card-name">${esc(policy.name)}</span>
                </div>
                <div class="crew-builder-card-actions">
                    <button class="crew-builder-action-btn" data-action="edit-policy" data-id="${policy.id}" title="Edit">✎</button>
                    <button class="crew-builder-action-btn crew-builder-action-danger" data-action="delete-policy" data-id="${policy.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crew-builder-card-body">
                <div class="crew-builder-policy-row">
                    <span class="crew-builder-label">Mode:</span>
                    <span class="crew-builder-value">${esc(policy.mode)}</span>
                </div>
                ${pinned.length > 0 ? `
                <div class="crew-builder-policy-row">
                    <span class="crew-builder-label">Pinned:</span>
                    <span class="crew-builder-value">${pinned.map(id => esc(id)).join(', ')}</span>
                </div>` : ''}
            </div>
            ${policy.notes ? `<div class="crew-builder-card-notes">${esc(policy.notes)}</div>` : ''}
        </div>
    `;
}

function renderPolicyForm(policy) {
    const isNew = !policy;
    const p = policy || { name: '', mode: 'stats_then_bda', spec: {}, notes: '' };
    const spec = p.spec || {};
    const pinned = Array.isArray(spec.pinned) ? spec.pinned : [];

    return `
        <div class="crew-builder-form" data-form-id="${isNew ? 'new' : p.id}">
            <div class="crew-builder-form-header">
                <h3>${isNew ? 'Create Below Deck Policy' : `Edit: ${esc(p.name)}`}</h3>
                <button class="crew-builder-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crew-builder-form-error">${esc(formError)}</div>` : ''}
            <div class="crew-builder-form-grid">
                <label class="crew-builder-form-field">
                    <span class="crew-builder-form-label">Name *</span>
                    <input type="text" class="crew-builder-form-input" data-form-field="name"
                           value="${esc(p.name)}" placeholder="e.g. Science Crew" maxlength="100" required />
                </label>
                <label class="crew-builder-form-field">
                    <span class="crew-builder-form-label">Mode *</span>
                    <select class="crew-builder-form-select" data-form-field="mode" required>
                        <option value="stats_then_bda" ${p.mode === 'stats_then_bda' ? 'selected' : ''}>Stats then BDA</option>
                        <option value="pinned_only" ${p.mode === 'pinned_only' ? 'selected' : ''}>Pinned Only</option>
                        <option value="stat_fill_only" ${p.mode === 'stat_fill_only' ? 'selected' : ''}>Stats Fill Only</option>
                    </select>
                </label>
                <label class="crew-builder-form-field crew-builder-form-wide">
                    <span class="crew-builder-form-label">Pinned Officers <span style="opacity: 0.6;">(comma-separated IDs)</span></span>
                    <input type="text" class="crew-builder-form-input" data-form-field="pinned"
                           value="${esc(pinned.join(', '))}" placeholder="e.g. off-1, off-2" />
                </label>
                <label class="crew-builder-form-field crew-builder-form-wide">
                    <span class="crew-builder-form-label">Notes</span>
                    <textarea class="crew-builder-form-input" style="resize: vertical; min-height: 48px;" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(p.notes || '')}</textarea>
                </label>
            </div>
            <div class="crew-builder-form-actions">
                <button class="crew-builder-btn crew-builder-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crew-builder-btn crew-builder-btn-primary" data-action="save-policy">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

function renderLoadoutVariantsCard(loadout) {
    return `
        <div class="crew-builder-card" data-id="${loadout.id}">
            <div class="crew-builder-card-header">
                <div class="crew-builder-card-title">
                    <span class="crew-builder-card-name">${esc(loadout.name)}</span>
                </div>
                <div class="crew-builder-card-actions">
                    <button class="crew-builder-action-btn" data-action="view-variants" data-loadout-id="${loadout.id}" title="View/create variants">▶</button>
                </div>
            </div>
            <div class="crew-builder-card-body">
                <div class="crew-builder-policy-row">
                    <span class="crew-builder-label">Bridge Core:</span>
                    <span class="crew-builder-value">${getBridgeCoreName(loadout.bridgeCoreId) || '—'}</span>
                </div>
                <div class="crew-builder-policy-row">
                    <span class="crew-builder-label">Below Deck:</span>
                    <span class="crew-builder-value">${getBelowDeckPolicyName(loadout.belowDeckPolicyId) || '—'}</span>
                </div>
                <div class="crew-builder-policy-row">
                    <span class="crew-builder-label">Intents:</span>
                    <span class="crew-builder-value">${(loadout.intentKeys || []).join(', ') || '—'}</span>
                </div>
            </div>
        </div>
    `;
}

function renderEmpty(msg) {
    return `
        <div class="crew-builder-empty">
            <p>${msg}</p>
        </div>
    `;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $('#crew-builder-area');
    if (!area) return;

    // Tab switching
    area.querySelectorAll('.crew-builder-tab').forEach(btn => {
        btn.addEventListener('click', (e) => {
            activeTab = e.currentTarget.dataset.tab;
            render();
        });
    });

    // Create button
    const createBtn = area.querySelector('[data-action="create"]');
    if (createBtn) {
        createBtn.addEventListener('click', () => {
            if (activeTab === 'cores') {
                editingCoreId = 'new';
            } else if (activeTab === 'policies') {
                editingPolicyId = 'new';
            }
            formError = '';
            render();
        });
    }

    // Edit core
    area.querySelectorAll('[data-action="edit-core"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingCoreId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    // Delete core
    area.querySelectorAll('[data-action="delete-core"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const core = bridgeCores.find(c => c.id === id);
            if (!core) return;
            if (!confirm(`Delete bridge core "${core.name}"?`)) return;
            try {
                await deleteBridgeCore(id);
                bridgeCores = bridgeCores.filter(c => c.id !== id);
                render();
            } catch (err) {
                console.error('Delete failed:', err);
                alert(`Failed to delete: ${err.message}`);
            }
        });
    });

    // Edit policy
    area.querySelectorAll('[data-action="edit-policy"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingPolicyId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    // Delete policy
    area.querySelectorAll('[data-action="delete-policy"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const policy = belowDeckPolicies.find(p => p.id === id);
            if (!policy) return;
            if (!confirm(`Delete below deck policy "${policy.name}"?`)) return;
            try {
                await deleteBelowDeckPolicy(id);
                belowDeckPolicies = belowDeckPolicies.filter(p => p.id !== id);
                render();
            } catch (err) {
                console.error('Delete failed:', err);
                alert(`Failed to delete: ${err.message}`);
            }
        });
    });

    // Cancel form
    area.querySelectorAll('[data-action="cancel-form"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCoreId = null;
            editingPolicyId = null;
            formError = '';
            render();
        });
    });

    // Save core
    const saveCoreBtn = area.querySelector('[data-action="save-core"]');
    if (saveCoreBtn) {
        saveCoreBtn.addEventListener('click', () => handleSaveCore());
    }

    // Save policy
    const savePolicyBtn = area.querySelector('[data-action="save-policy"]');
    if (savePolicyBtn) {
        savePolicyBtn.addEventListener('click', () => handleSavePolicy());
    }

    // View variants
    area.querySelectorAll('[data-action="view-variants"]').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = 'variants';
            render();
        });
    });

    // Search (variants tab)
    const searchInput = area.querySelector('.crew-builder-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            render();
        });
    }

    // Sort field
    const sortSelect = area.querySelector('[data-action="sort-field"]');
    if (sortSelect) {
        sortSelect.addEventListener('change', (e) => {
            sortField = e.target.value;
            render();
        });
    }

    // Sort direction
    const sortDir = area.querySelector('[data-action="sort-dir"]');
    if (sortDir) {
        sortDir.addEventListener('click', () => {
            sortDir = sortDir === 'asc' ? 'desc' : 'asc';
            render();
        });
    }
}

// ─── Save Handlers ──────────────────────────────────────────

async function handleSaveCore() {
    const area = $('#crew-builder-area');
    if (!area) return;
    const form = area.querySelector('.crew-builder-form');
    if (!form) return;

    const getValue = (field) => {
        const el = form.querySelector(`[data-form-field="${field}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) {
        formError = 'Name is required.';
        render();
        return;
    }

    const members = [];
    for (const slot of ['captain', 'bridge_1', 'bridge_2']) {
        const officerId = getValue(`slot_${slot}`);
        if (officerId) {
            members.push({ officerId, slot });
        }
    }
    if (members.length === 0) {
        formError = 'Assign at least one officer.';
        render();
        return;
    }

    const notes = getValue('notes') || null;

    try {
        if (editingCoreId === 'new') {
            const resp = await createBridgeCore(name, members, notes);
            const created = resp?.bridgeCore ?? resp;
            bridgeCores.push(created);
        } else {
            const resp = await updateBridgeCore(editingCoreId, { name, notes });
            await setBridgeCoreMembers(editingCoreId, members);
            const idx = bridgeCores.findIndex(c => c.id === editingCoreId);
            if (idx !== -1) bridgeCores[idx] = { ...bridgeCores[idx], name, notes, members };
        }
        editingCoreId = null;
        formError = '';
        render();
    } catch (err) {
        console.error('Save failed:', err);
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSavePolicy() {
    const area = $('#crew-builder-area');
    if (!area) return;
    const form = area.querySelector('.crew-builder-form');
    if (!form) return;

    const getValue = (field) => {
        const el = form.querySelector(`[data-form-field="${field}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) {
        formError = 'Name is required.';
        render();
        return;
    }

    const mode = getValue('mode') || 'stats_then_bda';
    const pinnedRaw = (getValue('pinned') || '').trim();
    const pinned = pinnedRaw ? pinnedRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
    const notes = getValue('notes') || null;

    const spec = { pinned: pinned.length > 0 ? pinned : undefined };

    try {
        if (editingPolicyId === 'new') {
            const resp = await createBelowDeckPolicy(name, mode, spec, notes);
            const created = resp?.belowDeckPolicy ?? resp;
            belowDeckPolicies.push(created);
        } else {
            const resp = await updateBelowDeckPolicy(editingPolicyId, { name, mode, spec, notes });
            const updated = resp?.belowDeckPolicy ?? resp;
            const idx = belowDeckPolicies.findIndex(p => p.id === editingPolicyId);
            if (idx !== -1) belowDeckPolicies[idx] = { ...belowDeckPolicies[idx], name, mode, spec, notes };
        }
        editingPolicyId = null;
        formError = '';
        render();
    } catch (err) {
        console.error('Save failed:', err);
        formError = err.message || 'Save failed.';
        render();
    }
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getBridgeCoreName(id) {
    if (id == null) return null;
    const core = bridgeCores.find(c => c.id === id);
    return core ? core.name : null;
}

function getBelowDeckPolicyName(id) {
    if (id == null) return null;
    const policy = belowDeckPolicies.find(p => p.id === id);
    return policy ? policy.name : null;
}
