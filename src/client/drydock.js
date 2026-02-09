/**
 * drydock.js — Drydock Management Module
 *
 * Majel — STFC Fleet Intelligence System
 * Tab-per-dock UI for ship assignment, intent selection, and crew management.
 * Docks are dynamically created/deleted — no fixed count.
 */

import * as api from './api.js';

// ─── State ──────────────────────────────────────────────────
let docks = [];
let allShips = [];
let allOfficers = [];
let allIntents = [];
let conflicts = {};
let activeDockNum = null;
let opsLevel = 1;

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

    // Load ops level from settings
    const settings = await api.loadFleetSettings();
    if (settings.settings) {
        const ol = settings.settings.find(s => s.key === "fleet.opsLevel");
        if (ol) opsLevel = parseInt(ol.value, 10) || 1;
    }

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
 * Tab header: ops level badge + dock tabs + add button
 */
function renderTabHeader() {
    const opsDisplay = `
        <button class="ops-level-badge" data-action="edit-ops" title="Click to edit Ops Level">
            <span class="ops-label">OPS</span>
            <span class="ops-value">${opsLevel}</span>
        </button>
    `;

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

    return `
        <div class="dock-tab-header">
            ${opsDisplay}
            <div class="dock-tabs">${tabs}${addBtn}</div>
        </div>
    `;
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
        ${renderShipSection(dock)}
        ${renderIntentSection(dock.intents || [])}
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

    // Available ships = all ships minus those already in this dock
    const assignedIds = new Set(dockShips.map(s => s.shipId));
    const availableShips = allShips.filter(s => !assignedIds.has(s.id));

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
        <div class="dock-section">
            <h3 class="dock-section-title">Ships</h3>
            ${shipRows || '<p class="hint">No ships assigned to this dock.</p>'}
            ${selectHtml}
        </div>
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
        <div class="dock-section">
            <h3 class="dock-section-title">Intents</h3>
            <div class="dock-intent-grid">
                ${html}
            </div>
        </div>
    `;
}

/**
 * Crew section — bridge slots + below-deck (Phase 1: display only)
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

    // Bridge slots: captain + 2 officers (placeholder for now)
    return `
        <div class="dock-section">
            <h3 class="dock-section-title">Crew</h3>
            <div class="crew-bridge">
                <div class="bridge-slot captain">
                    <div class="bridge-slot-label">Captain</div>
                    <div class="bridge-slot-empty">— Unassigned —</div>
                </div>
                <div class="bridge-slot officer">
                    <div class="bridge-slot-label">Officer</div>
                    <div class="bridge-slot-empty">— Unassigned —</div>
                </div>
                <div class="bridge-slot officer">
                    <div class="bridge-slot-label">Officer</div>
                    <div class="bridge-slot-empty">— Unassigned —</div>
                </div>
            </div>
            <p class="hint">Crew preset management coming soon. Use chat to ask Majel for crew recommendations.</p>
        </div>
    `;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $("#drydock-area");
    if (!area) return;

    // Dock tab switching
    area.querySelectorAll(".dock-tab:not(.dock-tab-add)").forEach(tab => {
        tab.addEventListener("click", () => {
            activeDockNum = parseInt(tab.dataset.dock, 10);
            render();
        });
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
            const shipCount = dock?.ships?.length || 0;
            const intentCount = dock?.intents?.length || 0;

            let warning = `Delete "${label}"?`;
            if (shipCount > 0 || intentCount > 0) {
                warning += `\n\nThis will also remove:\n`;
                if (shipCount > 0) warning += `• ${shipCount} ship assignment${shipCount > 1 ? 's' : ''}\n`;
                if (intentCount > 0) warning += `• ${intentCount} intent${intentCount > 1 ? 's' : ''}\n`;
                warning += `\nThis cannot be undone.`;
            }

            if (!confirm(warning)) return;

            await api.deleteDock(num);
            activeDockNum = null;
            await refresh();
        });
    }

    // Ops level edit
    const opsBtn = area.querySelector("[data-action='edit-ops']");
    if (opsBtn) {
        opsBtn.addEventListener("click", () => {
            const input = prompt("Enter your Ops Level (1-80):", opsLevel);
            if (input === null) return;
            const val = parseInt(input, 10);
            if (isNaN(val) || val < 1 || val > 80) {
                alert("Ops level must be between 1 and 80.");
                return;
            }
            opsLevel = val;
            api.saveFleetSetting("fleet.opsLevel", val);
            render();
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
                const tabHeader = area.querySelector(".dock-tab-header");
                if (tabHeader) {
                    tabHeader.outerHTML = renderTabHeader();
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
            const shipId = parseInt(radio.dataset.ship, 10);
            await api.setActiveShip(activeDockNum, shipId);
            await refresh();
        });
    });

    // Remove ship
    area.querySelectorAll("[data-action='remove-ship']").forEach(btn => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const shipId = parseInt(btn.dataset.ship, 10);
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
            await api.addDockShip(activeDockNum, parseInt(shipId, 10), isFirst);
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
}

/**
 * Re-bind just the tab events after a partial re-render
 */
function bindTabEvents() {
    const area = $("#drydock-area");
    if (!area) return;
    area.querySelectorAll(".dock-tab:not(.dock-tab-add)").forEach(tab => {
        tab.addEventListener("click", () => {
            activeDockNum = parseInt(tab.dataset.dock, 10);
            render();
        });
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

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
