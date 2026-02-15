/**
 * loadouts.js — Loadout Management View (ADR-022, Phases 3–4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Three-tab loadout management interface:
 * 1. Loadouts — Card grid of ship+crew configurations
 * 2. Plan — Active plan items with dock/away assignments
 * 3. Dock Status — Read-only dock dashboard
 *
 * Progressive disclosure via `system.uiMode` setting:
 * - BASIC: read-only detail view, model assists via chat
 * - ADVANCED: inline editing, crew preset builder, officer conflict
 *   matrix, priority reordering, bulk plan operations
 */

import {
    fetchLoadouts, fetchLoadout, createLoadout, updateLoadout, deleteLoadout,
    previewDeleteLoadout, setLoadoutMembers,
    fetchPlanItems, createPlanItem, updatePlanItem, deletePlanItem,
    validatePlan, fetchPlanConflicts, solvePlan,
    fetchDocks, upsertDock, deleteDock,
    fetchIntents,
} from 'api/loadouts.js';
import { fetchCatalogShips, fetchCatalogOfficers } from 'api/catalog.js';
import { loadSetting } from 'api/settings.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let loadouts = [];
let planItems = [];
let docks = [];
let intents = [];
let ships = [];         // catalog ships for create form
let officers = [];      // catalog officers for reference
let validation = null;  // plan validation result
let conflicts = null;   // officer conflict data (ADVANCED)
let activeTab = 'loadouts'; // 'loadouts' | 'plan' | 'docks'
let loading = false;
let editingId = null;   // loadout ID being edited (null = list view)
let editMode = false;   // inline editing active in detail view (ADVANCED)
let uiMode = 'basic';   // 'basic' | 'advanced' — from system.uiMode setting
let solverResult = null; // last solver run result

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
        const [lo, pi, dk, it, mode] = await Promise.all([
            fetchLoadouts(),
            fetchPlanItems(),
            fetchDocks(),
            fetchIntents(),
            loadSetting('system.uiMode', 'basic'),
        ]);
        loadouts = lo;
        planItems = pi;
        docks = dk;
        intents = it;
        uiMode = mode;

        // Lazy-load catalog data for create form + crew builder (non-blocking)
        if (!ships.length) {
            Promise.all([
                fetchCatalogShips({ ownership: 'owned' }).catch(() => []),
                fetchCatalogOfficers({ ownership: 'owned' }).catch(() => []),
            ]).then(([s, o]) => { ships = s; officers = o; });
        }

        // Fetch officer conflicts when in ADVANCED mode (non-blocking)
        if (uiMode === 'advanced') {
            fetchPlanConflicts().then(c => { conflicts = c; }).catch(() => { conflicts = null; });
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
    const isAdv = uiMode === 'advanced';

    if (!loadouts.length) {
        return `
            <div class="loadout-empty">
                <p>No loadouts yet. Create your first ship configuration!</p>
                <p class="loadout-hint">💡 Tip: Ask Aria in chat — "What crew should I use for the Enterprise for mining?" — and she'll suggest a loadout you can save.</p>
                ${createBtn}
            </div>`;
    }

    const sorted = [...loadouts].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const cards = sorted.map((lo, idx) => {
        const memberCount = lo.members?.length ?? 0;
        const intentLabels = (lo.intentKeys || [])
            .map(k => intents.find(i => i.key === k))
            .filter(Boolean)
            .map(i => `<span class="loadout-intent-tag" title="${esc(i.category)}">${esc(i.icon || '🏷️')} ${esc(i.label)}</span>`)
            .join('');
        const tags = (lo.tags || []).map(t => `<span class="loadout-tag">${esc(t)}</span>`).join('');
        const shipName = lo.shipName || `Ship #${lo.shipId}`;
        const activeClass = lo.isActive ? 'loadout-card-active' : 'loadout-card-inactive';

        const priorityControls = isAdv ? `
            <div class="loadout-priority-controls">
                <button class="priority-btn" data-action="priority-up" data-id="${lo.id}" ${idx === 0 ? 'disabled' : ''} title="Move up">▲</button>
                <span class="priority-rank">#${idx + 1}</span>
                <button class="priority-btn" data-action="priority-down" data-id="${lo.id}" ${idx === sorted.length - 1 ? 'disabled' : ''} title="Move down">▼</button>
            </div>` : '';

        return `
            <div class="loadout-card ${activeClass}" data-id="${lo.id}">
                <div class="loadout-card-header">
                    <span class="loadout-card-ship">${esc(shipName)}</span>
                    <div class="loadout-card-header-actions">
                        ${priorityControls}
                        <button class="loadout-toggle-btn" data-action="toggle-active" data-id="${lo.id}" title="${lo.isActive ? 'Deactivate' : 'Activate'}">
                            ${lo.isActive ? '🟢' : '⚪'}
                        </button>
                    </div>
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
    const isAdv = uiMode === 'advanced';

    const renderMemberRow = (m, idx) => {
        const name = m.officerName || `Officer #${m.officerId}`;
        const removeBtn = isAdv && editMode
            ? `<td><button class="loadout-action-btn loadout-danger-btn crew-remove-btn" data-action="remove-crew" data-officer-id="${m.officerId}">✕</button></td>`
            : '';
        return `<tr><td>${esc(name)}</td><td>${m.roleType}</td><td>${m.slot ?? '—'}</td>${removeBtn}</tr>`;
    };

    // ADVANCED: inline editing header
    const header = isAdv && editMode
        ? `<div class="inline-edit-group">
               <label class="inline-edit-label">Name</label>
               <input class="inline-edit-input" type="text" data-field="name" value="${esc(lo.name)}" />
           </div>`
        : `<h2>${esc(lo.name)}</h2>`;

    // ADVANCED: inline notes editing
    const notesSection = isAdv && editMode
        ? `<div class="inline-edit-group">
               <label class="inline-edit-label">Notes</label>
               <textarea class="inline-edit-textarea" data-field="notes" rows="2">${esc(lo.notes || '')}</textarea>
           </div>`
        : (lo.notes ? `<p class="loadout-detail-notes">${esc(lo.notes)}</p>` : '');

    // ADVANCED: inline priority editing
    const priorityDisplay = isAdv && editMode
        ? `<span>Priority: <input class="inline-edit-input inline-edit-small" type="number" data-field="priority" value="${lo.priority}" min="1" /></span>`
        : `<span>Priority: ${lo.priority}</span>`;

    // ADVANCED: edit toggle + save button
    const editControls = isAdv
        ? (editMode
            ? `<div class="inline-edit-actions">
                   <button class="loadout-action-btn loadout-create-btn" data-action="save-inline-edit" data-id="${lo.id}">💾 Save</button>
                   <button class="loadout-action-btn" data-action="cancel-inline-edit">Cancel</button>
               </div>`
            : `<button class="loadout-action-btn" data-action="start-inline-edit">✏️ Edit</button>`)
        : '';

    // ADVANCED: crew builder (add officer form)
    const crewBuilder = isAdv && editMode ? renderCrewBuilder(members) : '';

    // Crew assignment hint (BASIC only)
    const crewHint = !isAdv
        ? `<p class="loadout-hint">💡 To change crew, ask Aria: "Update the crew for ${esc(lo.name)}"</p>`
        : '';

    const removeHeader = isAdv && editMode ? '<th></th>' : '';

    return `
        <div class="loadout-detail">
            <div class="loadout-detail-toolbar">
                <button class="loadout-action-btn" data-action="back-to-list">← Back</button>
                ${editControls}
            </div>
            ${header}
            <div class="loadout-detail-meta">
                <span>🚀 ${esc(lo.shipName || `Ship #${lo.shipId}`)}</span>
                <span>${lo.isActive ? '🟢 Active' : '⚪ Inactive'}</span>
                ${priorityDisplay}
            </div>
            ${intentLabels ? `<div class="loadout-detail-intents">${intentLabels}</div>` : ''}
            ${notesSection}

            <h3>Bridge Crew (${bridgeCrew.length})</h3>
            ${bridgeCrew.length ? `
                <table class="loadout-crew-table">
                    <thead><tr><th>Officer</th><th>Role</th><th>Slot</th>${removeHeader}</tr></thead>
                    <tbody>${bridgeCrew.map(renderMemberRow).join('')}</tbody>
                </table>` : '<p class="loadout-empty-crew">No bridge crew assigned.</p>'}

            <h3>Below Deck (${belowDeck.length})</h3>
            ${belowDeck.length ? `
                <table class="loadout-crew-table">
                    <thead><tr><th>Officer</th><th>Role</th><th>Slot</th>${removeHeader}</tr></thead>
                    <tbody>${belowDeck.map(renderMemberRow).join('')}</tbody>
                </table>` : '<p class="loadout-empty-crew">No below-deck crew assigned.</p>'}

            ${crewBuilder}
            ${crewHint}
        </div>`;
}

// ─── Plan Tab ───────────────────────────────────────────────

function renderPlan() {
    const createBtn = `<button class="loadout-action-btn loadout-create-btn" data-action="create-plan-item">+ New Plan Item</button>`;
    const validateBtn = `<button class="loadout-action-btn" data-action="validate-plan">✓ Validate Plan</button>`;
    const solvePreviewBtn = `<button class="loadout-action-btn" data-action="solve-plan-preview" title="Preview optimal dock assignments (dry run)">🧩 Solve Plan</button>`;
    const isAdv = uiMode === 'advanced';

    // ADVANCED: bulk operations toolbar
    const bulkOps = isAdv ? `
        <div class="bulk-ops-bar">
            <span class="bulk-ops-label">Bulk:</span>
            <select class="bulk-ops-intent-select" id="bulk-intent-filter">
                <option value="">— Select intent —</option>
                ${intents.map(i => `<option value="${esc(i.key)}">${esc(i.icon || '')} ${esc(i.label)}</option>`).join('')}
            </select>
            <button class="loadout-action-btn" data-action="bulk-deactivate-intent" title="Deactivate all plan items with selected intent">⏸ Deactivate by Intent</button>
            <button class="loadout-action-btn" data-action="bulk-clear-docks" title="Unassign all dock assignments">🧹 Clear Docks</button>
        </div>` : '';

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

    // ADVANCED: officer conflict matrix
    const conflictSection = isAdv ? renderConflictMatrix() : '';

    return `
        <div class="loadout-toolbar">${createBtn} ${validateBtn} ${solvePreviewBtn}</div>
        ${bulkOps}
        ${validation ? renderValidation() : ''}
        ${solverResult ? renderSolverResult() : ''}
        <div class="plan-grid">${items}</div>
        ${conflictSection}`;
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

// ─── Solver Result ──────────────────────────────────────────

function renderSolverResult() {
    if (!solverResult) return '';
    const { assignments, applied, summary, warnings } = solverResult;

    const icons = { assigned: '✅', unchanged: '➖', queued: '⏳', conflict: '⚠️' };
    const rows = assignments.map(a => {
        const icon = icons[a.action] || '❓';
        const dock = a.dockNumber != null ? `Dock ${a.dockNumber}` : '—';
        return `<tr class="solver-row-${a.action}">
            <td>${icon}</td>
            <td>${esc(a.planItemLabel || '—')}</td>
            <td>${esc(a.loadoutName || '—')}</td>
            <td>${dock}</td>
            <td class="solver-explanation">${esc(a.explanation)}</td>
        </tr>`;
    }).join('');

    const warnHtml = warnings.length
        ? `<div class="solver-warnings">${warnings.map(w => `<div>⚠️ ${esc(w)}</div>`).join('')}</div>`
        : '';

    const applyBtn = !applied
        ? `<button class="loadout-action-btn loadout-create-btn" data-action="solve-plan-apply">✅ Apply Assignments</button>`
        : '';
    const dismissBtn = `<button class="loadout-action-btn" data-action="solver-dismiss">Dismiss</button>`;

    return `
        <div class="solver-result">
            <div class="solver-header">
                <h3>🧩 ${applied ? 'Solver Applied' : 'Solver Preview'}</h3>
                <div class="solver-actions">${applyBtn} ${dismissBtn}</div>
            </div>
            <p class="solver-summary">${esc(summary)}</p>
            ${warnHtml}
            <table class="loadout-crew-table solver-table">
                <thead><tr><th></th><th>Plan Item</th><th>Loadout</th><th>Dock</th><th>Explanation</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
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
            case 'view-loadout': editingId = id; editMode = false; return render();
            case 'back-to-list': editingId = null; editMode = false; return render();
            case 'toggle-active': return toggleLoadoutActive(id);
            case 'delete-loadout': return handleDeleteLoadout(id);
            case 'create-plan-item': return showCreatePlanForm();
            case 'toggle-plan-active': return togglePlanActive(id);
            case 'delete-plan-item': return handleDeletePlanItem(id);
            case 'validate-plan': return handleValidatePlan();
            // ADVANCED actions
            case 'start-inline-edit': editMode = true; return render();
            case 'cancel-inline-edit': editMode = false; return render();
            case 'save-inline-edit': return handleSaveInlineEdit(id);
            case 'priority-up': return handlePriorityChange(id, -1);
            case 'priority-down': return handlePriorityChange(id, 1);
            case 'add-crew': return handleAddCrew();
            case 'remove-crew': return handleRemoveCrew(Number(btn.dataset.officerId));
            case 'bulk-deactivate-intent': return handleBulkDeactivateByIntent();
            case 'bulk-clear-docks': return handleBulkClearDocks();
            case 'solve-plan-preview': return handleSolvePlan(false);
            case 'solve-plan-apply': return handleSolvePlan(true);
            case 'solver-dismiss': solverResult = null; return render();
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

// ─── Plan Solver ────────────────────────────────────────────

async function handleSolvePlan(apply) {
    try {
        const result = await solvePlan(apply);
        solverResult = result;
        if (apply) {
            await refresh();
        }
        render();
    } catch (err) {
        console.error('Solver failed:', err);
        alert(`Solver failed: ${err.message}`);
    }
}

// ─── Helpers ────────────────────────────────────────────────

// ─── ADVANCED: Crew Builder ─────────────────────────────────

function renderCrewBuilder(currentMembers) {
    const currentIds = new Set(currentMembers.map(m => m.officerId));
    const available = officers.filter(o => !currentIds.has(o.id));

    if (!available.length && !officers.length) {
        return `<div class="crew-builder">
            <h3>Add Crew</h3>
            <p class="loadout-hint">Officer catalog loading… refresh to see available officers.</p>
        </div>`;
    }

    const officerOptions = available
        .map(o => `<option value="${o.id}">${esc(o.name)}${o.rarity ? ` (${esc(o.rarity)})` : ''}</option>`)
        .join('');

    return `
        <div class="crew-builder">
            <h3>Add Crew Member</h3>
            <div class="crew-builder-form">
                <select class="crew-builder-select" id="crew-officer-select">
                    <option value="">— Select officer —</option>
                    ${officerOptions}
                </select>
                <select class="crew-builder-role" id="crew-role-select">
                    <option value="bridge">Bridge</option>
                    <option value="below_deck">Below Deck</option>
                </select>
                <input class="crew-builder-slot" type="text" id="crew-slot-input" placeholder="Slot (e.g. captain)" />
                <button class="loadout-action-btn loadout-create-btn" data-action="add-crew">+ Add</button>
            </div>
            ${!available.length ? '<p class="loadout-hint">All owned officers already assigned to this loadout.</p>' : ''}
        </div>`;
}

// ─── ADVANCED: Officer Conflict Matrix ──────────────────────

function renderConflictMatrix() {
    if (!conflicts) return '';

    const officerConflicts = conflicts.officerConflicts || conflicts || [];
    if (!Array.isArray(officerConflicts) || !officerConflicts.length) {
        return `<div class="conflict-matrix">
            <h3>⚔️ Officer Conflicts</h3>
            <p class="plan-validation plan-valid">No officer conflicts detected.</p>
        </div>`;
    }

    const rows = officerConflicts.map(c => {
        const name = c.officerName || `Officer #${c.officerId}`;
        const appearances = (c.loadoutNames || c.appearances || [])
            .map(a => `<span class="conflict-loadout">${esc(typeof a === 'string' ? a : a.loadoutName || '?')}</span>`)
            .join(' ');
        return `<tr><td>${esc(name)}</td><td>${appearances}</td><td class="conflict-count">${c.count ?? (c.loadoutNames || c.appearances || []).length}</td></tr>`;
    }).join('');

    return `
        <div class="conflict-matrix">
            <h3>⚔️ Officer Conflicts (${officerConflicts.length})</h3>
            <table class="loadout-crew-table conflict-table">
                <thead><tr><th>Officer</th><th>Appears In</th><th>#</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ─── ADVANCED: Inline Edit Save ─────────────────────────────

async function handleSaveInlineEdit(id) {
    const area = $('#loadouts-area');
    if (!area) return;

    const updates = {};
    const nameInput = area.querySelector('[data-field="name"]');
    const notesInput = area.querySelector('[data-field="notes"]');
    const priorityInput = area.querySelector('[data-field="priority"]');

    if (nameInput) updates.name = nameInput.value.trim();
    if (notesInput) updates.notes = notesInput.value.trim();
    if (priorityInput) updates.priority = Number(priorityInput.value);

    if (updates.name === '') {
        alert('Name cannot be empty.');
        return;
    }

    try {
        await updateLoadout(id, updates);
        editMode = false;
        await refresh();
        // Re-open detail view after refresh
        editingId = id;
        render();
    } catch (err) {
        console.error('Save failed:', err);
        alert(`Save failed: ${err.message}`);
    }
}

// ─── ADVANCED: Priority Reorder ─────────────────────────────

async function handlePriorityChange(id, direction) {
    const sorted = [...loadouts].sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    const idx = sorted.findIndex(l => l.id === id);
    if (idx < 0) return;

    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= sorted.length) return;

    const current = sorted[idx];
    const target = sorted[swapIdx];

    try {
        // Swap priorities
        const curPri = current.priority ?? (idx + 1);
        const tarPri = target.priority ?? (swapIdx + 1);
        await Promise.all([
            updateLoadout(current.id, { priority: tarPri }),
            updateLoadout(target.id, { priority: curPri }),
        ]);
        await refresh();
    } catch (err) {
        console.error('Priority change failed:', err);
        alert(`Priority change failed: ${err.message}`);
    }
}

// ─── ADVANCED: Crew Modification ────────────────────────────

async function handleAddCrew() {
    const area = $('#loadouts-area');
    if (!area || !editingId) return;

    const officerId = Number(area.querySelector('#crew-officer-select')?.value);
    const roleType = area.querySelector('#crew-role-select')?.value || 'bridge';
    const slot = (area.querySelector('#crew-slot-input')?.value || '').trim() || null;

    if (!officerId) {
        alert('Please select an officer.');
        return;
    }

    const lo = loadouts.find(l => l.id === editingId);
    if (!lo) return;

    const currentMembers = (lo.members || []).map(m => ({
        officerId: m.officerId,
        roleType: m.roleType,
        slot: m.slot ?? null,
    }));
    currentMembers.push({ officerId, roleType, slot });

    try {
        await setLoadoutMembers(editingId, currentMembers);
        await refresh();
        editingId = editingId; // keep on detail view
        editMode = true;
        render();
    } catch (err) {
        console.error('Add crew failed:', err);
        alert(`Add crew failed: ${err.message}`);
    }
}

async function handleRemoveCrew(officerId) {
    if (!editingId) return;
    const lo = loadouts.find(l => l.id === editingId);
    if (!lo) return;

    const updated = (lo.members || [])
        .filter(m => m.officerId !== officerId)
        .map(m => ({ officerId: m.officerId, roleType: m.roleType, slot: m.slot ?? null }));

    try {
        await setLoadoutMembers(editingId, updated);
        await refresh();
        editingId = editingId;
        editMode = true;
        render();
    } catch (err) {
        console.error('Remove crew failed:', err);
        alert(`Remove crew failed: ${err.message}`);
    }
}

// ─── ADVANCED: Bulk Plan Operations ─────────────────────────

async function handleBulkDeactivateByIntent() {
    const area = $('#loadouts-area');
    if (!area) return;
    const intentKey = area.querySelector('#bulk-intent-filter')?.value;
    if (!intentKey) {
        alert('Select an intent first.');
        return;
    }
    const matching = planItems.filter(pi => pi.intentKey === intentKey && pi.isActive);
    if (!matching.length) {
        alert('No active plan items with that intent.');
        return;
    }
    if (!confirm(`Deactivate ${matching.length} active plan item(s) with intent "${intentKey}"?`)) return;

    try {
        await Promise.all(matching.map(pi => updatePlanItem(pi.id, { isActive: false })));
        await refresh();
    } catch (err) {
        console.error('Bulk deactivate failed:', err);
        alert(`Bulk deactivate failed: ${err.message}`);
    }
}

async function handleBulkClearDocks() {
    const docked = planItems.filter(pi => pi.dockNumber != null);
    if (!docked.length) {
        alert('No plan items are assigned to docks.');
        return;
    }
    if (!confirm(`Unassign ${docked.length} plan item(s) from their docks?`)) return;

    try {
        await Promise.all(docked.map(pi => updatePlanItem(pi.id, { dockNumber: null })));
        await refresh();
    } catch (err) {
        console.error('Bulk clear docks failed:', err);
        alert(`Bulk clear docks failed: ${err.message}`);
    }
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
