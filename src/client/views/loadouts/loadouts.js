/**
 * loadouts.js — Loadout Management View (ADR-022, Phase 3)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Three-tab loadout management interface (BASIC mode):
 * 1. Loadouts — Card grid of ship+crew configurations
 * 2. Plan — Active plan items with dock/away assignments
 * 3. Dock Status — Read-only dock dashboard
 *
 * BASIC mode: no manual crew builder. Model assists via chat.
 * ADVANCED mode (Phase 4, #41): adds drag-and-drop crew management.
 */

import {
    fetchLoadouts, fetchLoadout, createLoadout, updateLoadout, deleteLoadout,
    previewDeleteLoadout, setLoadoutMembers,
    fetchPlanItems, createPlanItem, updatePlanItem, deletePlanItem,
    validatePlan, fetchPlanConflicts,
    fetchDocks, upsertDock, deleteDock,
    fetchIntents,
} from 'api/loadouts.js';
import { fetchCatalogShips, fetchCatalogOfficers } from 'api/catalog.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let loadouts = [];
let planItems = [];
let docks = [];
let intents = [];
let ships = [];         // catalog ships for create form
let officers = [];      // catalog officers for reference
let validation = null;  // plan validation result
let activeTab = 'loadouts'; // 'loadouts' | 'plan' | 'docks'
let loading = false;
let editingId = null;   // loadout ID being edited (null = list view)

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('loadouts', {
    area: $('#loadouts-area'),
    icon: '📦', title: 'Loadouts', subtitle: 'Ship configurations & fleet plan',
    cssHref: 'views/loadouts/loadouts.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#loadouts-area');
    if (!area) return;
    render();
}

export async function refresh() {
    if (loading) return;
    loading = true;
    render();
    try {
        const results = await Promise.all([
            fetchLoadouts(),
            fetchPlanItems(),
            fetchDocks(),
            fetchIntents(),
        ]);
        loadouts = results[0];
        planItems = results[1];
        docks = results[2];
        intents = results[3];

        // Lazy-load catalog data for create form (non-blocking)
        if (!ships.length) {
            Promise.all([
                fetchCatalogShips({ ownership: 'owned' }).catch(() => []),
                fetchCatalogOfficers({ ownership: 'owned' }).catch(() => []),
            ]).then(([s, o]) => { ships = s; officers = o; });
        }
    } catch (err) {
        console.error('Loadouts fetch failed:', err);
    } finally {
        loading = false;
        render();
    }
}

// ─── Tab Navigation ─────────────────────────────────────────

function switchTab(tab) {
    activeTab = tab;
    editingId = null;
    render();
}

// ─── Main Render ────────────────────────────────────────────

function render() {
    const area = $('#loadouts-area');
    if (!area) return;

    area.innerHTML = `
        <div class="loadout-tabs">
            <button class="loadout-tab ${activeTab === 'loadouts' ? 'active' : ''}" data-tab="loadouts">📦 Loadouts</button>
            <button class="loadout-tab ${activeTab === 'plan' ? 'active' : ''}" data-tab="plan">🗺️ Plan</button>
            <button class="loadout-tab ${activeTab === 'docks' ? 'active' : ''}" data-tab="docks">🔧 Docks</button>
        </div>
        <div class="loadout-panel">
            ${loading ? '<div class="loadout-loading">Loading…</div>' : renderActiveTab()}
        </div>
    `;

    area.querySelectorAll('.loadout-tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
    wireActions(area);
}

function renderActiveTab() {
    switch (activeTab) {
        case 'loadouts': return editingId ? renderLoadoutDetail() : renderLoadoutList();
        case 'plan': return renderPlan();
        case 'docks': return renderDockStatus();
        default: return '';
    }
}

// ─── Loadouts Tab ───────────────────────────────────────────

function renderLoadoutList() {
    const createBtn = `<button class="loadout-action-btn loadout-create-btn" data-action="create-loadout">+ New Loadout</button>`;

    if (!loadouts.length) {
        return `
            <div class="loadout-empty">
                <p>No loadouts yet. Create your first ship configuration!</p>
                <p class="loadout-hint">💡 Tip: Ask Aria in chat — "What crew should I use for the Enterprise for mining?" — and she'll suggest a loadout you can save.</p>
                ${createBtn}
            </div>`;
    }

    const cards = loadouts.map(lo => {
        const memberCount = lo.members?.length ?? 0;
        const intentLabels = (lo.intentKeys || [])
            .map(k => intents.find(i => i.key === k))
            .filter(Boolean)
            .map(i => `<span class="loadout-intent-tag" title="${esc(i.category)}">${esc(i.icon || '🏷️')} ${esc(i.label)}</span>`)
            .join('');
        const tags = (lo.tags || []).map(t => `<span class="loadout-tag">${esc(t)}</span>`).join('');
        const shipName = lo.shipName || `Ship #${lo.shipId}`;
        const activeClass = lo.isActive ? 'loadout-card-active' : 'loadout-card-inactive';

        return `
            <div class="loadout-card ${activeClass}" data-id="${lo.id}">
                <div class="loadout-card-header">
                    <span class="loadout-card-ship">${esc(shipName)}</span>
                    <button class="loadout-toggle-btn" data-action="toggle-active" data-id="${lo.id}" title="${lo.isActive ? 'Deactivate' : 'Activate'}">
                        ${lo.isActive ? '🟢' : '⚪'}
                    </button>
                </div>
                <div class="loadout-card-name">${esc(lo.name)}</div>
                <div class="loadout-card-crew">👥 ${memberCount} crew${memberCount !== 1 ? '' : ''}</div>
                ${intentLabels ? `<div class="loadout-card-intents">${intentLabels}</div>` : ''}
                ${tags ? `<div class="loadout-card-tags">${tags}</div>` : ''}
                ${lo.notes ? `<div class="loadout-card-notes">${esc(lo.notes)}</div>` : ''}
                <div class="loadout-card-actions">
                    <button class="loadout-action-btn" data-action="view-loadout" data-id="${lo.id}">View</button>
                    <button class="loadout-action-btn loadout-danger-btn" data-action="delete-loadout" data-id="${lo.id}">Delete</button>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="loadout-toolbar">${createBtn}</div>
        <div class="loadout-grid">${cards}</div>`;
}

// ─── Loadout Detail ─────────────────────────────────────────

function renderLoadoutDetail() {
    const lo = loadouts.find(l => l.id === editingId);
    if (!lo) return '<div class="loadout-empty">Loadout not found.</div>';

    const members = lo.members || [];
    const bridgeCrew = members.filter(m => m.roleType === 'bridge');
    const belowDeck = members.filter(m => m.roleType === 'below_deck');
    const intentLabels = (lo.intentKeys || [])
        .map(k => intents.find(i => i.key === k))
        .filter(Boolean)
        .map(i => `<span class="loadout-intent-tag">${esc(i.icon || '🏷️')} ${esc(i.label)}</span>`)
        .join('');

    const renderMemberRow = (m) => {
        const name = m.officerName || `Officer #${m.officerId}`;
        return `<tr><td>${esc(name)}</td><td>${m.roleType}</td><td>${m.slot ?? '—'}</td></tr>`;
    };

    return `
        <div class="loadout-detail">
            <button class="loadout-action-btn" data-action="back-to-list">← Back</button>
            <h2>${esc(lo.name)}</h2>
            <div class="loadout-detail-meta">
                <span>🚀 ${esc(lo.shipName || `Ship #${lo.shipId}`)}</span>
                <span>${lo.isActive ? '🟢 Active' : '⚪ Inactive'}</span>
                <span>Priority: ${lo.priority}</span>
            </div>
            ${intentLabels ? `<div class="loadout-detail-intents">${intentLabels}</div>` : ''}
            ${lo.notes ? `<p class="loadout-detail-notes">${esc(lo.notes)}</p>` : ''}

            <h3>Bridge Crew (${bridgeCrew.length})</h3>
            ${bridgeCrew.length ? `
                <table class="loadout-crew-table">
                    <thead><tr><th>Officer</th><th>Role</th><th>Slot</th></tr></thead>
                    <tbody>${bridgeCrew.map(renderMemberRow).join('')}</tbody>
                </table>` : '<p class="loadout-empty-crew">No bridge crew assigned.</p>'}

            <h3>Below Deck (${belowDeck.length})</h3>
            ${belowDeck.length ? `
                <table class="loadout-crew-table">
                    <thead><tr><th>Officer</th><th>Role</th><th>Slot</th></tr></thead>
                    <tbody>${belowDeck.map(renderMemberRow).join('')}</tbody>
                </table>` : '<p class="loadout-empty-crew">No below-deck crew assigned.</p>'}

            <p class="loadout-hint">💡 To change crew, ask Aria: "Update the crew for ${esc(lo.name)}"</p>
        </div>`;
}

// ─── Plan Tab ───────────────────────────────────────────────

function renderPlan() {
    const createBtn = `<button class="loadout-action-btn loadout-create-btn" data-action="create-plan-item">+ New Plan Item</button>`;
    const validateBtn = `<button class="loadout-action-btn" data-action="validate-plan">✓ Validate Plan</button>`;

    if (!planItems.length) {
        return `
            <div class="loadout-empty">
                <p>No plan items yet. Assign loadouts to docks or away missions.</p>
                ${createBtn}
            </div>`;
    }

    const items = planItems.map(pi => {
        const intent = intents.find(i => i.key === pi.intentKey);
        const intentLabel = intent ? `${intent.icon || '🏷️'} ${esc(intent.label)}` : esc(pi.intentKey);
        const lo = pi.loadoutName || `Loadout #${pi.loadoutId}`;
        const dock = pi.dockNumber != null ? `Dock ${pi.dockNumber}` : 'Unassigned';
        const activeClass = pi.isActive ? 'plan-item-active' : 'plan-item-inactive';
        const awayCount = pi.awayMembers?.length || 0;

        return `
            <div class="plan-item ${activeClass}">
                <div class="plan-item-header">
                    <span class="plan-item-intent">${intentLabel}</span>
                    <span class="plan-item-status">${pi.isActive ? '🟢' : '⚪'}</span>
                </div>
                <div class="plan-item-loadout">📦 ${esc(lo)}</div>
                <div class="plan-item-dock">🔧 ${dock}</div>
                ${awayCount ? `<div class="plan-item-away">🚶 ${awayCount} away team</div>` : ''}
                <div class="plan-item-actions">
                    <button class="loadout-action-btn" data-action="toggle-plan-active" data-id="${pi.id}" title="${pi.isActive ? 'Deactivate' : 'Activate'}">
                        ${pi.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                    <button class="loadout-action-btn loadout-danger-btn" data-action="delete-plan-item" data-id="${pi.id}">Delete</button>
                </div>
            </div>`;
    }).join('');

    return `
        <div class="loadout-toolbar">${createBtn} ${validateBtn}</div>
        ${validation ? renderValidation() : ''}
        <div class="plan-grid">${items}</div>`;
}

function renderValidation() {
    if (!validation) return '';
    const { dockConflicts, officerConflicts, unassignedLoadouts, warnings } = validation;
    const issues = [];
    if (dockConflicts?.length) issues.push(`⚠️ ${dockConflicts.length} dock conflict(s)`);
    if (officerConflicts?.length) issues.push(`⚠️ ${officerConflicts.length} officer conflict(s)`);
    if (unassignedLoadouts?.length) issues.push(`📋 ${unassignedLoadouts.length} unassigned loadout(s)`);
    if (warnings?.length) warnings.forEach(w => issues.push(`💡 ${esc(w)}`));

    if (!issues.length) {
        return '<div class="plan-validation plan-valid">✅ Plan is valid — no conflicts detected.</div>';
    }
    return `<div class="plan-validation plan-invalid">${issues.join('<br>')}</div>`;
}

// ─── Dock Status Tab ────────────────────────────────────────

function renderDockStatus() {
    if (!docks.length) {
        return '<div class="loadout-empty"><p>No docks configured. Docks are created when you add plan items.</p></div>';
    }

    const dockCards = docks.map(d => {
        const assignment = d.assignment;
        const occupied = !!assignment;

        return `
            <div class="dock-card ${occupied ? 'dock-occupied' : 'dock-empty'}">
                <div class="dock-card-header">
                    <span class="dock-card-number">Dock ${d.dockNumber}</span>
                    <span class="dock-card-status">${occupied ? '🟢 Active' : '⚪ Empty'}</span>
                </div>
                ${d.label ? `<div class="dock-card-label">${esc(d.label)}</div>` : ''}
                ${occupied ? `
                    <div class="dock-card-assignment">
                        <div>📦 ${esc(assignment.loadoutName || 'Loadout')}</div>
                        <div>🏷️ ${esc(assignment.intentKey || '—')}</div>
                    </div>` : `
                    <div class="dock-card-empty-msg">No ship assigned</div>`}
                ${d.notes ? `<div class="dock-card-notes">${esc(d.notes)}</div>` : ''}
            </div>`;
    }).join('');

    return `<div class="dock-grid">${dockCards}</div>`;
}

// ─── Actions ────────────────────────────────────────────────

function wireActions(area) {
    area.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;

        const action = btn.dataset.action;
        const id = btn.dataset.id ? Number(btn.dataset.id) : null;

        switch (action) {
            case 'create-loadout': return showCreateForm();
            case 'view-loadout': editingId = id; return render();
            case 'back-to-list': editingId = null; return render();
            case 'toggle-active': return toggleLoadoutActive(id);
            case 'delete-loadout': return handleDeleteLoadout(id);
            case 'create-plan-item': return showCreatePlanForm();
            case 'toggle-plan-active': return togglePlanActive(id);
            case 'delete-plan-item': return handleDeletePlanItem(id);
            case 'validate-plan': return handleValidatePlan();
        }
    });
}

async function toggleLoadoutActive(id) {
    const lo = loadouts.find(l => l.id === id);
    if (!lo) return;
    try {
        await updateLoadout(id, { isActive: !lo.isActive });
        await refresh();
    } catch (err) {
        console.error('Toggle failed:', err);
        alert(`Failed to toggle: ${err.message}`);
    }
}

async function handleDeleteLoadout(id) {
    const lo = loadouts.find(l => l.id === id);
    if (!lo) return;

    try {
        const preview = await previewDeleteLoadout(id);
        const cascades = [];
        if (preview.planItems?.length) cascades.push(`${preview.planItems.length} plan item(s)`);
        const msg = cascades.length
            ? `Delete "${lo.name}"?\n\nThis will also remove: ${cascades.join(', ')}`
            : `Delete "${lo.name}"?`;
        if (!confirm(msg)) return;

        await deleteLoadout(id);
        if (editingId === id) editingId = null;
        await refresh();
    } catch (err) {
        console.error('Delete failed:', err);
        alert(`Delete failed: ${err.message}`);
    }
}

async function togglePlanActive(id) {
    const pi = planItems.find(p => p.id === id);
    if (!pi) return;
    try {
        await updatePlanItem(id, { isActive: !pi.isActive });
        await refresh();
    } catch (err) {
        console.error('Toggle failed:', err);
        alert(`Failed to toggle: ${err.message}`);
    }
}

async function handleDeletePlanItem(id) {
    if (!confirm('Delete this plan item?')) return;
    try {
        await deletePlanItem(id);
        await refresh();
    } catch (err) {
        console.error('Delete failed:', err);
        alert(`Delete failed: ${err.message}`);
    }
}

async function handleValidatePlan() {
    try {
        validation = await validatePlan();
        render();
    } catch (err) {
        console.error('Validation failed:', err);
        alert(`Validation failed: ${err.message}`);
    }
}

// ─── Create Forms ───────────────────────────────────────────

function showCreateForm() {
    const area = $('#loadouts-area');
    if (!area) return;

    const shipOptions = ships.length
        ? ships.map(s => `<option value="${s.id}">${esc(s.name)} (${esc(s.shipClass || '—')})</option>`).join('')
        : '<option value="">— Load catalog first —</option>';

    const intentChecks = intents
        .map(i => `<label class="loadout-intent-check"><input type="checkbox" value="${esc(i.key)}"> ${esc(i.icon || '🏷️')} ${esc(i.label)}</label>`)
        .join('');

    area.querySelector('.loadout-panel').innerHTML = `
        <div class="loadout-form">
            <h3>Create Loadout</h3>
            <form id="create-loadout-form">
                <label>Name <input type="text" name="name" required placeholder="e.g. Mining Crew Alpha" /></label>
                <label>Ship <select name="shipId" required>${shipOptions}</select></label>
                <fieldset><legend>Intents (optional)</legend>${intentChecks || '<p>No intents available</p>'}</fieldset>
                <label>Notes <textarea name="notes" rows="2" placeholder="Optional notes"></textarea></label>
                <div class="loadout-form-actions">
                    <button type="submit" class="loadout-action-btn loadout-create-btn">Create</button>
                    <button type="button" class="loadout-action-btn" data-action="back-to-list">Cancel</button>
                </div>
            </form>
            <p class="loadout-hint">💡 After creating, ask Aria to suggest crew: "What crew for [ship name] for [intent]?"</p>
        </div>`;

    const form = area.querySelector('#create-loadout-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const intentKeys = [...form.querySelectorAll('input[type="checkbox"]:checked')].map(cb => cb.value);
        try {
            await createLoadout({
                name: fd.get('name'),
                shipId: Number(fd.get('shipId')),
                intentKeys,
                notes: fd.get('notes') || undefined,
            });
            await refresh();
        } catch (err) {
            console.error('Create failed:', err);
            alert(`Create failed: ${err.message}`);
        }
    });
}

function showCreatePlanForm() {
    const area = $('#loadouts-area');
    if (!area) return;

    const loadoutOptions = loadouts
        .map(lo => `<option value="${lo.id}">${esc(lo.name)} — ${esc(lo.shipName || 'Ship')}</option>`)
        .join('');
    const intentOptions = intents
        .map(i => `<option value="${esc(i.key)}">${esc(i.icon || '')} ${esc(i.label)}</option>`)
        .join('');
    const dockOptions = [
        '<option value="">— No dock (away mission) —</option>',
        ...docks.map(d => `<option value="${d.dockNumber}">Dock ${d.dockNumber}${d.label ? ` — ${esc(d.label)}` : ''}</option>`),
    ].join('');

    area.querySelector('.loadout-panel').innerHTML = `
        <div class="loadout-form">
            <h3>Create Plan Item</h3>
            <form id="create-plan-form">
                <label>Loadout <select name="loadoutId" required>${loadoutOptions || '<option value="">— Create a loadout first —</option>'}</select></label>
                <label>Intent <select name="intentKey" required>${intentOptions || '<option value="">— No intents —</option>'}</select></label>
                <label>Dock <select name="dockNumber">${dockOptions}</select></label>
                <div class="loadout-form-actions">
                    <button type="submit" class="loadout-action-btn loadout-create-btn">Create</button>
                    <button type="button" class="loadout-action-btn" data-action="back-to-list">Cancel</button>
                </div>
            </form>
        </div>`;

    const form = area.querySelector('#create-plan-form');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        try {
            const dockNum = fd.get('dockNumber');
            await createPlanItem({
                loadoutId: Number(fd.get('loadoutId')),
                intentKey: fd.get('intentKey'),
                dockNumber: dockNum ? Number(dockNum) : undefined,
            });
            await refresh();
        } catch (err) {
            console.error('Create plan item failed:', err);
            alert(`Create failed: ${err.message}`);
        }
    });
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
