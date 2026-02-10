/**
 * drydock.js — Drydock Management Module
 *
 * Majel — STFC Fleet Intelligence System
 * Tab-per-dock UI for ship assignment, intent selection, and crew management.
 * Docks are dynamically created/deleted — no fixed count.
 */

import * as api from './api.js';
import { showConfirmDialog } from './confirm-dialog.js';

// ─── State ──────────────────────────────────────────────────
let docks = [];
let allShips = [];
let allOfficers = [];
let allIntents = [];
let conflicts = {};
let activeDockNum = null;
let dockPresets = [];       // presets for current active dock
let activePresetId = null;  // currently selected preset ID

// ─── DOM Refs ───────────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ─── Public API ─────────────────────────────────────────────

/**
 * Initialize the drydock module — load data and render
 */
export async function init() {
    const area = $("#drydock-area");
    if (!area) return;
    await refresh();
}

/**
 * Full data refresh and re-render
 */
export async function refresh() {
    try {
        const [docksData, shipsData, officersData, intentsData, conflictsData] = await Promise.all([
            api.fetchDocks(),
            api.fetchShips(),
            api.fetchOfficers(),
            api.fetchIntents(),
            api.fetchConflicts(),
        ]);

        docks = docksData;
        allShips = shipsData;
        allOfficers = officersData;
        allIntents = intentsData;
        conflicts = conflictsData;

        // Set active dock to first if current is invalid
        if (!activeDockNum || !docks.find(d => d.dockNumber === activeDockNum)) {
            activeDockNum = docks.length > 0 ? docks[0].dockNumber : null;
        }

        // Load crew presets for active dock
        if (activeDockNum) {
            try {
                dockPresets = await api.fetchPresetsForDock(activeDockNum);
            } catch {
                dockPresets = [];
            }
            // Validate active preset still exists
            if (activePresetId && !dockPresets.find(p => p.id === activePresetId)) {
                activePresetId = null;
            }
            // Auto-select first preset if none selected
            if (!activePresetId && dockPresets.length > 0) {
                activePresetId = dockPresets[0].id;
            }
        } else {
            dockPresets = [];
            activePresetId = null;
        }

        render();
    } catch (err) {
        console.error("Drydock refresh failed:", err);
        const area = $("#drydock-area");
        if (area) {
            area.innerHTML = `<div class="dock-error">Failed to load drydock data: ${err.message}</div>`;
        }
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $("#drydock-area");
    if (!area) return;

    const activeDock = activeDockNum ? docks.find(d => d.dockNumber === activeDockNum) || null : null;

    area.innerHTML = `
        ${renderIntelSection()}
        ${renderTabHeader()}
        <div class="dock-content">
            ${docks.length === 0
            ? renderEmptyState()
            : renderDockPanel(activeDock)}
        </div>
    `;

    bindEvents();
}

/**
 * Collapsible Dock Intel — conflicts and insights
 */
function renderIntelSection() {
    const conflictList = conflicts.conflicts || [];
    const warningCount = conflictList.length;
    const hasWarnings = warningCount > 0;

    const badgeHtml = hasWarnings
        ? `<span class="intel-badge warn">⚠ ${warningCount}</span>`
        : `<span class="intel-badge ok">✅</span>`;

    let intelBody = '';
    if (hasWarnings) {
        intelBody = conflictList.map(c => {
            const dockNums = c.appearances.map(a => a.dockNumbers.join(', D')).join('; ');
            return `<div class="intel-item warn">
                <span class="intel-icon">⚠</span>
                <span><strong>${c.officerName}</strong> assigned to multiple docks (D${dockNums})</span>
            </div>`;
        }).join('');
    } else {
        intelBody = `<div class="intel-item ok">
            <span class="intel-icon">✅</span>
            <span>No officer conflicts detected</span>
        </div>`;
    }

    return `
        <div class="dock-intel">
            <button class="dock-intel-toggle" data-action="toggle-intel">
                Dock Intel ${badgeHtml}
                <span class="intel-chevron">▸</span>
            </button>
            <div class="dock-intel-body collapsed">
                ${intelBody}
            </div>
        </div>
    `;
}

/**
 * Tab header: dock tabs + add button
 */
function renderTabHeader() {
    let tabs = '';
    for (const dock of docks) {
        const label = dock.label || `Dock ${dock.dockNumber}`;
        const isActive = dock.dockNumber === activeDockNum;
        const hasShips = dock.ships?.length > 0;
        const indicator = hasShips ? ' •' : '';
        tabs += `<button class="dock-tab ${isActive ? 'active' : ''}" data-dock="${dock.dockNumber}">
            <span class="dock-tab-num">D${dock.dockNumber}</span>
            <span class="dock-tab-label">${escHtml(label)}${indicator}</span>
        </button>`;
    }

    const addBtn = `<button class="dock-tab dock-tab-add" data-action="add-dock" title="Add a new dock">+</button>`;

    return `<div class="dock-tabs">${tabs}${addBtn}</div>`;
}

/**
 * Empty state — no docks yet
 */
function renderEmptyState() {
    return `
        <div class="dock-panel-empty">
            <p>No drydocks configured yet.</p>
            <p class="hint">Click the <strong>+</strong> button above to add your first dock.</p>
        </div>
    `;
}

/**
 * Main dock panel — name, ships, intents
 */
function renderDockPanel(dock) {
    if (!dock) {
        return `
            <div class="dock-panel-empty">
                <p>Select a dock tab above.</p>
            </div>
        `;
    }

    return `
        ${renderDockHeader(dock)}
        <div class="dock-columns">
            <div class="panel">
                <div class="panel-header">Ships</div>
                <div class="panel-body">${renderShipSection(dock)}</div>
            </div>
            <div class="panel">
                <div class="panel-header">Intents</div>
                <div class="panel-body">${renderIntentSection(dock.intents || [])}</div>
            </div>
        </div>
        ${renderCrewSection(dock)}
    `;
}

/**
 * Dock header with editable label and delete button
 */
function renderDockHeader(dock) {
    return `
        <div class="dock-header">
            <div class="dock-name-row">
                <span class="dock-number">D${dock.dockNumber}</span>
                <input type="text" class="dock-label-input" data-dock="${dock.dockNumber}"
                    value="${escHtml(dock.label || '')}"
                    placeholder="Name this dock..." />
                <button class="dock-delete-btn" data-action="delete-dock" data-dock="${dock.dockNumber}"
                    title="Delete this dock">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                </button>
            </div>
            ${dock.notes ? `<p class="dock-notes">${escHtml(dock.notes)}</p>` : ''}
        </div>
    `;
}

/**
 * Ship assignment — list of ships with radio buttons for active
 */
function renderShipSection(dock) {
    const dockShips = dock?.ships || [];
    const activeShipId = dockShips.find(s => s.isActive)?.shipId;

    // Available ships = owned ships minus those already in this dock
    const assignedIds = new Set(dockShips.map(s => s.shipId));
    const availableShips = allShips.filter(s => !assignedIds.has(s.id) && s.ownershipState === 'owned');

    let shipRows = '';
    for (const ds of dockShips) {
        const ship = allShips.find(s => s.id === ds.shipId);
        const shipName = ship ? ship.name : ds.shipId;
        const isActive = ds.shipId === activeShipId;
        shipRows += `
            <div class="ship-radio-row ${isActive ? 'active' : ''}">
                <label>
                    <input type="radio" name="active-ship" data-action="set-active-ship"
                        data-ship="${ds.shipId}" ${isActive ? 'checked' : ''} />
                    <span class="ship-name">${escHtml(shipName)}</span>
                </label>
                <button class="ship-remove-btn" data-action="remove-ship" data-ship="${ds.shipId}" title="Remove">×</button>
            </div>
        `;
    }

    const selectHtml = availableShips.length > 0
        ? `<select class="ship-add-select" data-action="add-ship-select">
            <option value="">+ Assign ship...</option>
            ${availableShips.map(s => `<option value="${s.id}">${escHtml(s.name)}</option>`).join('')}
           </select>`
        : '';

    return `
        <div class="dock-ship-list">
            ${shipRows || '<p class="hint">No ships assigned to this dock.</p>'}
        </div>
        ${selectHtml ? `<div class="ship-add-row">${selectHtml}</div>` : ''}
    `;
}

/**
 * Intent checkboxes grouped by category
 */
function renderIntentSection(dockIntents) {
    const activeKeys = new Set(dockIntents.map(i => i.key));

    // Group by category
    const groups = {};
    for (const intent of allIntents) {
        const cat = intent.category || 'other';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(intent);
    }

    const categoryOrder = ['combat', 'mining', 'utility', 'custom'];
    const categoryLabels = {
        combat: '⚔️ Combat',
        mining: '⛏️ Mining',
        utility: '🔧 Utility',
        custom: '🏷️ Custom',
        other: '📋 Other',
    };

    let html = '';
    for (const cat of categoryOrder) {
        const items = groups[cat];
        if (!items || items.length === 0) continue;

        html += `<div class="intent-group">
            <div class="intent-group-label">${categoryLabels[cat] || cat}</div>
            <div class="intent-group-items">
                ${items.map(intent => `
                    <label class="intent-checkbox ${activeKeys.has(intent.key) ? 'checked' : ''}">
                        <input type="checkbox" data-action="toggle-intent" data-key="${intent.key}"
                            ${activeKeys.has(intent.key) ? 'checked' : ''} />
                        <span class="intent-label">${intent.icon || ''} ${escHtml(intent.label)}</span>
                    </label>
                `).join('')}
            </div>
        </div>`;
    }

    // Handle any remaining categories
    for (const cat of Object.keys(groups)) {
        if (categoryOrder.includes(cat)) continue;
        const items = groups[cat];
        html += `<div class="intent-group">
            <div class="intent-group-label">${categoryLabels[cat] || cat}</div>
            <div class="intent-group-items">
                ${items.map(intent => `
                    <label class="intent-checkbox ${activeKeys.has(intent.key) ? 'checked' : ''}">
                        <input type="checkbox" data-action="toggle-intent" data-key="${intent.key}"
                            ${activeKeys.has(intent.key) ? 'checked' : ''} />
                        <span class="intent-label">${intent.icon || ''} ${escHtml(intent.label)}</span>
                    </label>
                `).join('')}
            </div>
        </div>`;
    }

    if (allIntents.length === 0) {
        html = `<p class="hint">No intents available.</p>`;
    }

    return `
        <div class="dock-intent-grid">
            ${html}
        </div>
    `;
}

/**
 * Crew section — preset selector + bridge slots with officer assignment
 */
function renderCrewSection(dock) {
    const dockShips = dock?.ships || [];
    const activeShip = dockShips.find(s => s.isActive);

    if (!activeShip) {
        return `
            <div class="dock-section">
                <h3 class="dock-section-title">Crew</h3>
                <p class="hint">Select an active ship to manage crew assignments.</p>
            </div>
        `;
    }

    const activePreset = activePresetId ? dockPresets.find(p => p.id === activePresetId && p.shipId === activeShip.shipId) : null;
    const hasIntents = (dock.intents || []).length > 0;

    return `
        <div class="dock-section">
            <h3 class="dock-section-title">Crew</h3>
            ${renderPresetSelector(dock, activeShip)}
            ${activePreset ? renderBridgeSlots(activePreset) : ''}
        </div>
    `;
}

/**
 * Preset selector — dropdown of existing presets + create new
 */
function renderPresetSelector(dock, activeShip) {
    const shipPresets = dockPresets.filter(p => p.shipId === activeShip.shipId);
    const intentKeys = (dock.intents || []).map(i => i.key);
    const hasIntents = intentKeys.length > 0;

    if (shipPresets.length === 0) {
        // No presets for this ship — show create prompt
        if (!hasIntents) {
            return `<p class="hint">Select at least one intent to create crew presets.</p>`;
        }
        return `
            <div class="preset-bar">
                <span class="preset-bar-empty">No crew presets for this ship yet.</span>
                <button class="btn btn-sm btn-accent" data-action="create-preset"
                    data-ship="${activeShip.shipId}" data-intent="${intentKeys[0]}">
                    + New Preset
                </button>
            </div>
        `;
    }

    // Build dropdown options
    const options = shipPresets.map(p => {
        const memberCount = (p.members || []).length;
        const intentLabel = p.intentLabel || p.intentKey;
        const label = `${escHtml(p.presetName)} (${intentLabel}) · ${memberCount}/3`;
        return `<option value="${p.id}" ${p.id === activePresetId ? 'selected' : ''}>${label}</option>`;
    }).join('');

    return `
        <div class="preset-bar">
            <select class="preset-select" data-action="select-preset">
                ${options}
            </select>
            ${hasIntents ? `
                <button class="btn btn-sm btn-ghost" data-action="create-preset"
                    data-ship="${activeShip.shipId}" data-intent="${intentKeys[0]}"
                    title="New preset">+</button>
            ` : ''}
            <button class="btn btn-sm btn-ghost btn-danger" data-action="delete-preset"
                data-preset="${activePresetId}" title="Delete this preset">🗑</button>
        </div>
    `;
}

/**
 * Bridge slots — captain + 2 officers, populated from preset members
 */
function renderBridgeSlots(preset) {
    const members = preset.members || [];

    // Map members to slots
    const captain = members.find(m => m.slot === 'captain');
    const officers = members.filter(m => m.slot !== 'captain');
    const officer1 = officers[0] || null;
    const officer2 = officers[1] || null;

    // Get IDs already assigned in this preset (to exclude from dropdowns)
    const assignedIds = new Set(members.map(m => m.officerId));

    return `
        <div class="crew-section">
            <div class="crew-zone-label">Bridge</div>
            <div class="bridge-slots">
                ${renderSlot('captain', 'Captain', captain, assignedIds, preset.id)}
                ${renderSlot('officer-1', 'Officer', officer1, assignedIds, preset.id)}
                ${renderSlot('officer-2', 'Officer', officer2, assignedIds, preset.id)}
            </div>
        </div>
    `;
}

/**
 * Single bridge slot — filled or empty with officer picker
 */
function renderSlot(slotKey, label, member, assignedIds, presetId) {
    const isCaptain = slotKey === 'captain';
    const slotClass = isCaptain ? 'captain' : 'officer';

    if (member) {
        // Filled slot
        const officer = allOfficers.find(o => o.id === member.officerId);
        const name = officer?.name || member.officerName || member.officerId;
        const rarity = officer?.rarity || '';
        const initial = name.charAt(0).toUpperCase();

        return `
            <div class="bridge-slot ${slotClass} filled" data-slot="${slotKey}">
                <button class="slot-remove" data-action="remove-crew"
                    data-preset="${presetId}" data-slot="${slotKey}"
                    data-officer="${member.officerId}" title="Remove">×</button>
                <div class="bridge-slot-label">${label}</div>
                <div class="slot-avatar">${initial}</div>
                <div class="slot-officer-name">${escHtml(name)}</div>
                ${rarity ? `<div class="slot-officer-rank">${escHtml(rarity)}</div>` : ''}
            </div>
        `;
    }

    // Empty slot — show officer picker
    const ownedOfficers = allOfficers.filter(o =>
        o.ownershipState === 'owned' && !assignedIds.has(o.id)
    );

    const optionsHtml = ownedOfficers.map(o =>
        `<option value="${o.id}">${escHtml(o.name)}${o.rarity ? ` (${o.rarity})` : ''}</option>`
    ).join('');

    return `
        <div class="bridge-slot ${slotClass}" data-slot="${slotKey}">
            <div class="bridge-slot-label">${label}</div>
            ${ownedOfficers.length > 0 ? `
                <select class="slot-officer-select" data-action="assign-crew"
                    data-preset="${presetId}" data-slot="${slotKey}">
                    <option value="">— Assign —</option>
                    ${optionsHtml}
                </select>
            ` : `
                <div class="bridge-slot-empty">— Unassigned —</div>
                ${allOfficers.filter(o => o.ownershipState === 'owned').length === 0
                    ? '<div class="slot-hint">Mark officers as owned in the Catalog</div>'
                    : ''}
            `}
        </div>
    `;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $("#drydock-area");
    if (!area) return;

    // Dock tab switching
    area.querySelectorAll(".dock-tab:not(.dock-tab-add)").forEach(tab => {
        tab.addEventListener("click", () => switchDock(parseInt(tab.dataset.dock, 10)));
    });

    // Add dock button
    const addBtn = area.querySelector("[data-action='add-dock']");
    if (addBtn) {
        addBtn.addEventListener("click", async () => {
            const nextNum = await api.fetchNextDockNumber();
            await api.updateDock(nextNum, { label: `Dock ${nextNum}` });
            activeDockNum = nextNum;
            await refresh();
        });
    }

    // Delete dock button
    const deleteBtn = area.querySelector("[data-action='delete-dock']");
    if (deleteBtn) {
        deleteBtn.addEventListener("click", async () => {
            const num = parseInt(deleteBtn.dataset.dock, 10);
            const dock = docks.find(d => d.dockNumber === num);
            const label = dock?.label || `Dock ${num}`;

            // Fetch cascade preview from backend
            const preview = await api.previewDeleteDock(num);
            const sections = [];
            if (preview.ships?.length > 0) {
                sections.push({ label: "Ship assignments", items: preview.ships.map(s => s.shipName) });
            }
            if (preview.intents?.length > 0) {
                sections.push({ label: "Intent selections", items: preview.intents.map(i => i.label) });
            }

            const confirmed = await showConfirmDialog({
                title: `Delete Dock ${num}?`,
                subtitle: label !== `Dock ${num}` ? label : undefined,
                sections,
                approveLabel: "Delete dock",
            });
            if (!confirmed) return;

            await api.deleteDock(num);
            activeDockNum = null;
            await refresh();
        });
    }

    // Intel toggle
    const intelToggle = area.querySelector("[data-action='toggle-intel']");
    if (intelToggle) {
        intelToggle.addEventListener("click", () => {
            const body = area.querySelector(".dock-intel-body");
            const chevron = area.querySelector(".intel-chevron");
            if (body) {
                body.classList.toggle("collapsed");
                if (chevron) chevron.textContent = body.classList.contains("collapsed") ? "▸" : "▾";
            }
        });
    }

    // Dock label editing
    const labelInput = area.querySelector(".dock-label-input");
    if (labelInput) {
        let debounceTimer;
        labelInput.addEventListener("input", () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(async () => {
                const num = parseInt(labelInput.dataset.dock, 10);
                await api.updateDock(num, { label: labelInput.value.trim() });
                // Update local cache
                const dock = docks.find(d => d.dockNumber === num);
                if (dock) dock.label = labelInput.value.trim();
                // Re-render just the tabs
                const tabBar = area.querySelector(".dock-tabs");
                if (tabBar) {
                    tabBar.outerHTML = renderTabHeader();
                    bindTabEvents();
                }
            }, 600);
        });

        labelInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                e.preventDefault();
                labelInput.blur();
            }
        });
    }

    // Active ship radio
    area.querySelectorAll("[data-action='set-active-ship']").forEach(radio => {
        radio.addEventListener("change", async () => {
            const shipId = radio.dataset.ship;
            await api.setActiveShip(activeDockNum, shipId);
            await refresh();
        });
    });

    // Remove ship
    area.querySelectorAll("[data-action='remove-ship']").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const shipId = btn.dataset.ship;
            await api.removeDockShip(activeDockNum, shipId);
            await refresh();
        });
    });

    // Add ship from select
    const addSelect = area.querySelector("[data-action='add-ship-select']");
    if (addSelect) {
        addSelect.addEventListener("change", async () => {
            const shipId = addSelect.value;
            if (!shipId) return;
            const dock = docks.find(d => d.dockNumber === activeDockNum);
            const isFirst = !dock || (dock.ships || []).length === 0;
            await api.addDockShip(activeDockNum, shipId, isFirst);
            await refresh();
        });
    }

    // Intent checkbox toggle
    area.querySelectorAll("[data-action='toggle-intent']").forEach(cb => {
        cb.addEventListener("change", async () => {
            const checked = [];
            area.querySelectorAll("[data-action='toggle-intent']").forEach(el => {
                if (el.checked) checked.push(el.dataset.key);
            });
            await api.saveDockIntents(activeDockNum, checked);
            const dock = docks.find(d => d.dockNumber === activeDockNum);
            if (dock) {
                dock.intents = allIntents.filter(i => checked.includes(i.key));
            }
        });
    });

    // ── Crew Preset Events ─────────────────────────────────

    // Select preset from dropdown
    const presetSelect = area.querySelector("[data-action='select-preset']");
    if (presetSelect) {
        presetSelect.addEventListener("change", () => {
            activePresetId = parseInt(presetSelect.value, 10);
            render();
        });
    }

    // Create new preset
    area.querySelectorAll("[data-action='create-preset']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const shipId = btn.dataset.ship;
            const intentKey = btn.dataset.intent;
            const shipName = allShips.find(s => s.id === shipId)?.name || 'Ship';
            const intentLabel = allIntents.find(i => i.key === intentKey)?.label || intentKey;
            const presetName = `${shipName} — ${intentLabel}`;

            const result = await api.createPreset({ shipId, intentKey, presetName });
            if (result.ok && result.data) {
                activePresetId = result.data.id;
            }
            await refresh();
        });
    });

    // Delete preset
    area.querySelectorAll("[data-action='delete-preset']").forEach(btn => {
        btn.addEventListener("click", async () => {
            const presetId = parseInt(btn.dataset.preset, 10);
            const preset = dockPresets.find(p => p.id === presetId);
            const presetName = preset?.presetName || `Preset #${presetId}`;

            const confirmed = await showConfirmDialog({
                title: "Delete Crew Preset?",
                subtitle: presetName,
                sections: preset?.members?.length > 0
                    ? [{ label: "Assigned officers", items: preset.members.map(m => m.officerName || m.officerId) }]
                    : [],
                approveLabel: "Delete preset",
            });
            if (!confirmed) return;

            await api.deletePreset(presetId);
            activePresetId = null;
            await refresh();
        });
    });

    // Assign officer to slot
    area.querySelectorAll("[data-action='assign-crew']").forEach(sel => {
        sel.addEventListener("change", async () => {
            const officerId = sel.value;
            if (!officerId) return;
            const presetId = parseInt(sel.dataset.preset, 10);
            const slotKey = sel.dataset.slot;
            await saveSlotAssignment(presetId, slotKey, officerId);
        });
    });

    // Remove officer from slot
    area.querySelectorAll("[data-action='remove-crew']").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const presetId = parseInt(btn.dataset.preset, 10);
            const slotKey = btn.dataset.slot;
            await saveSlotAssignment(presetId, slotKey, null);
        });
    });
}

/**
 * Re-bind just the tab events after a partial re-render
 */
function bindTabEvents() {
    const area = $("#drydock-area");
    if (!area) return;
    area.querySelectorAll(".dock-tab:not(.dock-tab-add)").forEach(tab => {
        tab.addEventListener("click", () => switchDock(parseInt(tab.dataset.dock, 10)));
    });
    const addBtn = area.querySelector("[data-action='add-dock']");
    if (addBtn) {
        addBtn.addEventListener("click", async () => {
            const nextNum = await api.fetchNextDockNumber();
            await api.updateDock(nextNum, { label: `Dock ${nextNum}` });
            activeDockNum = nextNum;
            await refresh();
        });
    }
}

// ─── Helpers ────────────────────────────────────────────────

/**
 * Switch to a different dock — loads presets for the new dock and re-renders.
 * Lighter than full refresh() since it reuses already-loaded ships/officers/intents.
 */
async function switchDock(dockNum) {
    activeDockNum = dockNum;
    activePresetId = null;
    try {
        dockPresets = await api.fetchPresetsForDock(dockNum);
        if (dockPresets.length > 0) {
            activePresetId = dockPresets[0].id;
        }
    } catch {
        dockPresets = [];
    }
    render();
}

/**
 * Save a crew slot assignment by rebuilding the full members array
 * and calling setPresetMembers. Handles add/replace/remove for a slot.
 *
 * @param {number} presetId - The preset to update
 * @param {string} slotKey - 'captain', 'officer-1', or 'officer-2'
 * @param {string|null} officerId - Officer to assign, or null to clear
 */
async function saveSlotAssignment(presetId, slotKey, officerId) {
    const preset = dockPresets.find(p => p.id === presetId);
    if (!preset) return;

    const currentMembers = preset.members || [];

    // Build the 3-slot member array from current state
    const captain = currentMembers.find(m => m.slot === 'captain');
    const officers = currentMembers.filter(m => m.slot !== 'captain');
    const officer1 = officers[0] || null;
    const officer2 = officers[1] || null;

    // Apply the change
    const slots = {
        'captain': captain?.officerId || null,
        'officer-1': officer1?.officerId || null,
        'officer-2': officer2?.officerId || null,
    };
    slots[slotKey] = officerId;

    // Build members array for the API
    const members = [];
    if (slots['captain']) {
        members.push({ officerId: slots['captain'], roleType: 'bridge', slot: 'captain' });
    }
    if (slots['officer-1']) {
        members.push({ officerId: slots['officer-1'], roleType: 'bridge', slot: 'officer' });
    }
    if (slots['officer-2']) {
        members.push({ officerId: slots['officer-2'], roleType: 'bridge', slot: 'officer' });
    }

    await api.setPresetMembers(presetId, members);
    await refresh();
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
