/**
 * fleet-manager.js — Officer & Ship Manager
 *
 * Majel — STFC Fleet Intelligence System
 * Tabbed roster view with inline editing for all officer/ship fields.
 * Everything is user-editable until a solid static data pipeline exists.
 */

import * as api from './api.js';

// ─── State ──────────────────────────────────────────────────
let officers = [];
let ships = [];
let activeTab = 'officers'; // 'officers' | 'ships'
let searchFilter = '';
let editingId = null; // id of item currently in expanded edit mode

// ─── DOM ────────────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $("#fleet-manager-area");
    if (!area) return;
    await refresh();
}

export async function refresh() {
    try {
        const [officerData, shipData] = await Promise.all([
            api.fetchOfficers(),
            api.fetchShips(),
        ]);
        officers = officerData;
        ships = shipData;
        render();
    } catch (err) {
        console.error("Fleet manager refresh failed:", err);
        const area = $("#fleet-manager-area");
        if (area) area.innerHTML = `<div class="fm-error">Failed to load fleet data: ${err.message}</div>`;
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $("#fleet-manager-area");
    if (!area) return;

    area.innerHTML = `
        ${renderTabBar()}
        ${renderToolbar()}
        <div class="fm-list">
            ${activeTab === 'officers' ? renderOfficerList() : renderShipList()}
        </div>
    `;
    bindEvents();
}

function renderTabBar() {
    return `
        <div class="fm-tabs">
            <button class="fm-tab ${activeTab === 'officers' ? 'active' : ''}" data-tab="officers">
                Officers <span class="fm-tab-count">${officers.length}</span>
            </button>
            <button class="fm-tab ${activeTab === 'ships' ? 'active' : ''}" data-tab="ships">
                Ships <span class="fm-tab-count">${ships.length}</span>
            </button>
        </div>
    `;
}

function renderToolbar() {
    const noun = activeTab === 'officers' ? 'officer' : 'ship';
    return `
        <div class="fm-toolbar">
            <div class="fm-search-wrap">
                <svg class="fm-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <input type="text" class="fm-search" placeholder="Filter ${noun}s..." value="${esc(searchFilter)}" data-action="search" />
            </div>
            <button class="fm-add-btn" data-action="add">+ Add ${noun}</button>
        </div>
    `;
}

// ─── Officer List ───────────────────────────────────────────

function renderOfficerList() {
    let list = officers;
    if (searchFilter) {
        const q = searchFilter.toLowerCase();
        list = list.filter(o =>
            o.name.toLowerCase().includes(q) ||
            (o.groupName || '').toLowerCase().includes(q) ||
            (o.rarity || '').toLowerCase().includes(q)
        );
    }

    if (list.length === 0) {
        return officers.length === 0
            ? `<div class="fm-empty">
                <p>No officers yet.</p>
                <p class="hint">Add officers manually or import from Google Sheets via the Refresh Roster tool.</p>
               </div>`
            : `<div class="fm-empty"><p>No officers match "${esc(searchFilter)}"</p></div>`;
    }

    return list.map(o => {
        const isEditing = editingId === o.id;
        return `
            <div class="fm-card ${isEditing ? 'expanded' : ''}" data-id="${esc(o.id)}">
                <div class="fm-card-header" data-action="toggle-edit" data-id="${esc(o.id)}">
                    <div class="fm-card-main">
                        <span class="fm-card-name">${esc(o.name)}</span>
                        ${o.rarity ? `<span class="fm-badge rarity-${(o.rarity || '').toLowerCase()}">${esc(o.rarity)}</span>` : ''}
                        ${o.groupName ? `<span class="fm-badge group">${esc(o.groupName)}</span>` : ''}
                    </div>
                    <div class="fm-card-meta">
                        ${o.level ? `<span>Lv ${o.level}</span>` : ''}
                        ${o.rank ? `<span>${esc(o.rank)}</span>` : ''}
                        <span class="fm-expand-icon">${isEditing ? '▾' : '▸'}</span>
                    </div>
                </div>
                ${isEditing ? renderOfficerEditor(o) : ''}
            </div>
        `;
    }).join('');
}

function renderOfficerEditor(o) {
    const classOpts = ['', 'explorer', 'interceptor', 'battleship', 'survey', 'any'];
    const actOpts = ['', 'pve', 'pvp', 'mining', 'any'];
    const posOpts = ['', 'captain', 'bridge', 'below_deck', 'any'];

    return `
        <div class="fm-editor">
            <div class="fm-field-grid">
                ${field('Name', 'name', o.name, 'text', true)}
                ${field('Rarity', 'rarity', o.rarity, 'text')}
                ${field('Level', 'level', o.level, 'number')}
                ${field('Rank', 'rank', o.rank, 'text')}
                ${field('Group', 'groupName', o.groupName, 'text')}
                ${selectField('Class Pref', 'classPreference', o.classPreference, classOpts)}
                ${selectField('Activity', 'activityAffinity', o.activityAffinity, actOpts)}
                ${selectField('Position', 'positionPreference', o.positionPreference, posOpts)}
            </div>
            <div class="fm-editor-actions">
                <button class="fm-save-btn" data-action="save-officer" data-id="${esc(o.id)}">Save changes</button>
                <button class="fm-delete-btn" data-action="delete-officer" data-id="${esc(o.id)}">Delete</button>
            </div>
        </div>
    `;
}

// ─── Ship List ──────────────────────────────────────────────

function renderShipList() {
    let list = ships;
    if (searchFilter) {
        const q = searchFilter.toLowerCase();
        list = list.filter(s =>
            s.name.toLowerCase().includes(q) ||
            (s.shipClass || '').toLowerCase().includes(q) ||
            (s.faction || '').toLowerCase().includes(q) ||
            (s.rarity || '').toLowerCase().includes(q)
        );
    }

    if (list.length === 0) {
        return ships.length === 0
            ? `<div class="fm-empty">
                <p>No ships yet.</p>
                <p class="hint">Add ships manually or import from Google Sheets via the Refresh Roster tool.</p>
               </div>`
            : `<div class="fm-empty"><p>No ships match "${esc(searchFilter)}"</p></div>`;
    }

    return list.map(s => {
        const isEditing = editingId === s.id;
        return `
            <div class="fm-card ${isEditing ? 'expanded' : ''}" data-id="${esc(s.id)}">
                <div class="fm-card-header" data-action="toggle-edit" data-id="${esc(s.id)}">
                    <div class="fm-card-main">
                        <span class="fm-card-name">${esc(s.name)}</span>
                        ${s.shipClass ? `<span class="fm-badge ship-class">${esc(s.shipClass)}</span>` : ''}
                        ${s.rarity ? `<span class="fm-badge rarity-${(s.rarity || '').toLowerCase()}">${esc(s.rarity)}</span>` : ''}
                        ${s.faction ? `<span class="fm-badge faction">${esc(s.faction)}</span>` : ''}
                    </div>
                    <div class="fm-card-meta">
                        ${s.tier ? `<span>T${s.tier}</span>` : ''}
                        ${s.grade ? `<span>G${s.grade}</span>` : ''}
                        ${s.status ? `<span class="fm-status-${s.status}">${esc(s.status)}</span>` : ''}
                        <span class="fm-expand-icon">${isEditing ? '▾' : '▸'}</span>
                    </div>
                </div>
                ${isEditing ? renderShipEditor(s) : ''}
            </div>
        `;
    }).join('');
}

function renderShipEditor(s) {
    const statusOpts = ['ready', 'deployed', 'maintenance', 'training', 'reserve', 'awaiting-crew'];
    const combatOpts = ['', 'triangle', 'non_combat', 'specialty'];

    return `
        <div class="fm-editor">
            <div class="fm-field-grid">
                ${field('Name', 'name', s.name, 'text', true)}
                ${field('Tier', 'tier', s.tier, 'number')}
                ${field('Grade', 'grade', s.grade, 'number')}
                ${field('Ship Class', 'shipClass', s.shipClass, 'text')}
                ${field('Rarity', 'rarity', s.rarity, 'text')}
                ${field('Faction', 'faction', s.faction, 'text')}
                ${selectField('Combat Profile', 'combatProfile', s.combatProfile, combatOpts)}
                ${field('Specialty Loop', 'specialtyLoop', s.specialtyLoop, 'text')}
                ${selectField('Status', 'status', s.status, statusOpts)}
                ${field('Role', 'role', s.role, 'text')}
                ${field('Role Detail', 'roleDetail', s.roleDetail, 'text')}
                ${field('Notes', 'notes', s.notes, 'text')}
            </div>
            <div class="fm-editor-actions">
                <button class="fm-save-btn" data-action="save-ship" data-id="${esc(s.id)}">Save changes</button>
                <button class="fm-delete-btn" data-action="delete-ship" data-id="${esc(s.id)}">Delete</button>
            </div>
        </div>
    `;
}

// ─── Field Helpers ──────────────────────────────────────────

function field(label, key, value, type = 'text', required = false) {
    return `
        <div class="fm-field">
            <label class="fm-field-label">${esc(label)}${required ? ' *' : ''}</label>
            <input type="${type}" class="fm-field-input" data-key="${key}"
                value="${esc(value ?? '')}" ${required ? 'required' : ''} />
        </div>
    `;
}

function selectField(label, key, value, options) {
    const opts = options.map(o => {
        const display = o || '— none —';
        return `<option value="${esc(o)}" ${value === o ? 'selected' : ''}>${esc(display)}</option>`;
    }).join('');
    return `
        <div class="fm-field">
            <label class="fm-field-label">${esc(label)}</label>
            <select class="fm-field-input" data-key="${key}">${opts}</select>
        </div>
    `;
}

// ─── Add Dialogs ────────────────────────────────────────────

function renderAddDialog() {
    const area = $("#fleet-manager-area");
    if (!area) return;

    if (activeTab === 'officers') {
        const classOpts = ['', 'explorer', 'interceptor', 'battleship', 'survey', 'any'];
        const actOpts = ['', 'pve', 'pvp', 'mining', 'any'];
        const posOpts = ['', 'captain', 'bridge', 'below_deck', 'any'];

        area.insertAdjacentHTML('beforeend', `
            <div class="fm-add-overlay" data-action="close-add">
                <div class="fm-add-form" onclick="event.stopPropagation()">
                    <h3>Add Officer</h3>
                    <div class="fm-field-grid">
                        ${field('ID (unique)', 'id', '', 'text', true)}
                        ${field('Name', 'name', '', 'text', true)}
                        ${field('Rarity', 'rarity', '', 'text')}
                        ${field('Level', 'level', '', 'number')}
                        ${field('Rank', 'rank', '', 'text')}
                        ${field('Group', 'groupName', '', 'text')}
                        ${selectField('Class Pref', 'classPreference', '', classOpts)}
                        ${selectField('Activity', 'activityAffinity', '', actOpts)}
                        ${selectField('Position', 'positionPreference', '', posOpts)}
                    </div>
                    <div class="fm-editor-actions">
                        <button class="fm-save-btn" data-action="confirm-add-officer">Create officer</button>
                        <button class="fm-cancel-btn" data-action="close-add">Cancel</button>
                    </div>
                </div>
            </div>
        `);
    } else {
        const statusOpts = ['ready', 'deployed', 'maintenance', 'training', 'reserve', 'awaiting-crew'];
        const combatOpts = ['', 'triangle', 'non_combat', 'specialty'];

        area.insertAdjacentHTML('beforeend', `
            <div class="fm-add-overlay" data-action="close-add">
                <div class="fm-add-form" onclick="event.stopPropagation()">
                    <h3>Add Ship</h3>
                    <div class="fm-field-grid">
                        ${field('ID (unique)', 'id', '', 'text', true)}
                        ${field('Name', 'name', '', 'text', true)}
                        ${field('Tier', 'tier', '', 'number')}
                        ${field('Grade', 'grade', '', 'number')}
                        ${field('Ship Class', 'shipClass', '', 'text')}
                        ${field('Rarity', 'rarity', '', 'text')}
                        ${field('Faction', 'faction', '', 'text')}
                        ${selectField('Combat Profile', 'combatProfile', '', combatOpts)}
                        ${field('Specialty Loop', 'specialtyLoop', '', 'text')}
                        ${selectField('Status', 'status', 'ready', statusOpts)}
                        ${field('Role', 'role', '', 'text')}
                        ${field('Notes', 'notes', '', 'text')}
                    </div>
                    <div class="fm-editor-actions">
                        <button class="fm-save-btn" data-action="confirm-add-ship">Create ship</button>
                        <button class="fm-cancel-btn" data-action="close-add">Cancel</button>
                    </div>
                </div>
            </div>
        `);
    }

    bindAddDialogEvents();
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $("#fleet-manager-area");
    if (!area) return;

    // Tab switching
    area.querySelectorAll(".fm-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            activeTab = tab.dataset.tab;
            searchFilter = '';
            editingId = null;
            render();
        });
    });

    // Search
    const searchInput = area.querySelector("[data-action='search']");
    if (searchInput) {
        searchInput.addEventListener("input", () => {
            searchFilter = searchInput.value;
            const listEl = area.querySelector(".fm-list");
            if (listEl) {
                listEl.innerHTML = activeTab === 'officers' ? renderOfficerList() : renderShipList();
                bindCardEvents();
            }
        });
    }

    // Add button
    const addBtn = area.querySelector("[data-action='add']");
    if (addBtn) {
        addBtn.addEventListener("click", () => renderAddDialog());
    }

    bindCardEvents();
}

function bindCardEvents() {
    const area = $("#fleet-manager-area");
    if (!area) return;

    // Expand/collapse cards
    area.querySelectorAll("[data-action='toggle-edit']").forEach(header => {
        header.addEventListener("click", () => {
            const id = header.dataset.id;
            editingId = editingId === id ? null : id;
            render();
        });
    });

    // Save officer
    area.querySelectorAll("[data-action='save-officer']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const fields = gatherFields(btn.closest(".fm-editor"));
            btn.textContent = "Saving...";
            btn.disabled = true;
            const result = await api.updateOfficer(id, fields);
            if (result.ok) {
                await refresh();
            } else {
                btn.textContent = "Error — retry";
                btn.disabled = false;
            }
        });
    });

    // Save ship
    area.querySelectorAll("[data-action='save-ship']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const fields = gatherFields(btn.closest(".fm-editor"));
            btn.textContent = "Saving...";
            btn.disabled = true;
            const result = await api.updateShip(id, fields);
            if (result.ok) {
                await refresh();
            } else {
                btn.textContent = "Error — retry";
                btn.disabled = false;
            }
        });
    });

    // Delete officer
    area.querySelectorAll("[data-action='delete-officer']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const name = officers.find(o => o.id === id)?.name || id;
            if (!confirm(`Delete officer "${name}"? This cannot be undone.`)) return;
            await api.deleteOfficer(id);
            editingId = null;
            await refresh();
        });
    });

    // Delete ship
    area.querySelectorAll("[data-action='delete-ship']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const id = btn.dataset.id;
            const name = ships.find(s => s.id === id)?.name || id;
            if (!confirm(`Delete ship "${name}"? This cannot be undone.`)) return;
            await api.deleteShip(id);
            editingId = null;
            await refresh();
        });
    });
}

function bindAddDialogEvents() {
    const area = $("#fleet-manager-area");
    if (!area) return;

    // Close overlay
    area.querySelectorAll("[data-action='close-add']").forEach(el => {
        el.addEventListener("click", (e) => {
            if (e.target === el || el.classList.contains('fm-cancel-btn')) {
                area.querySelector(".fm-add-overlay")?.remove();
            }
        });
    });

    // Confirm add officer
    const confirmOfficer = area.querySelector("[data-action='confirm-add-officer']");
    if (confirmOfficer) {
        confirmOfficer.addEventListener("click", async () => {
            const form = confirmOfficer.closest(".fm-add-form");
            const fields = gatherFields(form);
            if (!fields.id || !fields.name) {
                alert("ID and Name are required.");
                return;
            }
            confirmOfficer.textContent = "Creating...";
            confirmOfficer.disabled = true;
            const result = await api.createOfficer(fields);
            if (result.ok) {
                area.querySelector(".fm-add-overlay")?.remove();
                await refresh();
            } else {
                confirmOfficer.textContent = `Error: ${result.error?.message || 'Failed'}`;
                confirmOfficer.disabled = false;
            }
        });
    }

    // Confirm add ship
    const confirmShip = area.querySelector("[data-action='confirm-add-ship']");
    if (confirmShip) {
        confirmShip.addEventListener("click", async () => {
            const form = confirmShip.closest(".fm-add-form");
            const fields = gatherFields(form);
            if (!fields.id || !fields.name) {
                alert("ID and Name are required.");
                return;
            }
            confirmShip.textContent = "Creating...";
            confirmShip.disabled = true;
            const result = await api.createShip(fields);
            if (result.ok) {
                area.querySelector(".fm-add-overlay")?.remove();
                await refresh();
            } else {
                confirmShip.textContent = `Error: ${result.error?.message || 'Failed'}`;
                confirmShip.disabled = false;
            }
        });
    }
}

// ─── Helpers ────────────────────────────────────────────────

function gatherFields(container) {
    const fields = {};
    if (!container) return fields;
    container.querySelectorAll(".fm-field-input").forEach(input => {
        const key = input.dataset.key;
        let val = input.value.trim();
        // Convert number fields
        if (input.type === 'number' && val !== '') {
            val = parseInt(val, 10);
            if (isNaN(val)) val = null;
        }
        // Convert empty strings to null (server expects null, not "")
        fields[key] = val === '' ? null : val;
    });
    return fields;
}

function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
