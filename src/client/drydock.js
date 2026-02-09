/**
 * drydock.js — Drydock Management Module
 *
 * Majel — STFC Fleet Intelligence System
 * Tab-per-dock UI for ship assignment, intent selection, and crew management.
 * Mirrors the wireframe design from .research/wireframes/drydock-ui-mockup-v2.html
 */

import * as api from './api.js';

// ─── State ──────────────────────────────────────────────────
let docks = [];
let allShips = [];
let allOfficers = [];
let allIntents = [];
let conflicts = {};
let activeDockNum = 1;
let dockCount = 5; // default, updated from fleet settings

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

    // Load fleet settings first to get dock count
    const settings = await api.loadFleetSettings();
    if (settings.settings) {
        const dc = settings.settings.find(s => s.key === "fleet.drydockCount");
        if (dc) dockCount = parseInt(dc.value, 10) || 5;
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

    // Ensure active dock is valid
    if (activeDockNum < 1 || activeDockNum > dockCount) activeDockNum = 1;

    const activeDock = docks.find(d => d.dockNumber === activeDockNum) || null;

    area.innerHTML = `
        ${renderIntelSection()}
        ${renderDockTabs()}
        <div class="dock-content">
            ${renderDockPanel(activeDock)}
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
 * Tab strip — one tab per dock
 */
function renderDockTabs() {
    let tabs = '';
    for (let i = 1; i <= dockCount; i++) {
        const dock = docks.find(d => d.dockNumber === i);
        const label = dock?.label || `Dock ${i}`;
        const isActive = i === activeDockNum;
        const hasShips = dock?.ships?.length > 0;
        const indicator = hasShips ? ' •' : '';
        tabs += `<button class="dock-tab ${isActive ? 'active' : ''}" data-dock="${i}">
            <span class="dock-tab-num">D${i}</span>
            <span class="dock-tab-label">${escHtml(label)}${indicator}</span>
        </button>`;
    }
    return `<div class="dock-tabs">${tabs}</div>`;
}

/**
 * Main dock panel — name, ships, intents
 */
function renderDockPanel(dock) {
    if (!dock) {
        return `
            <div class="dock-panel-empty">
                <p>Dock ${activeDockNum} is not configured yet.</p>
                <p class="hint">Assign a ship below to activate this dock.</p>
                ${renderShipSection(null)}
                ${renderIntentSection([])}
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
 * Dock header with editable label
 */
function renderDockHeader(dock) {
    return `
        <div class="dock-header">
            <div class="dock-name-row">
                <span class="dock-number">D${dock.dockNumber}</span>
                <input type="text" class="dock-label-input" data-dock="${dock.dockNumber}"
                    value="${escHtml(dock.label || '')}"
                    placeholder="Name this dock..." />
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

    // Ships already assigned to this dock
    const assignedIds = new Set(dockShips.map(s => String(s.shipId)));

    // Ships assigned to OTHER docks (show as unavailable)
    const otherDockShipIds = new Set();
    for (const d of docks) {
        if (d.dockNumber !== activeDockNum) {
            for (const s of (d.ships || [])) {
                otherDockShipIds.add(String(s.shipId));
            }
        }
    }

    // Assigned ships in this dock — shown first with radio for active selection
    let assignedHtml = '';
    if (dockShips.length > 0) {
        assignedHtml = dockShips.map(ds => {
            const ship = allShips.find(s => String(s.id) === String(ds.shipId));
            const name = ship?.name || ds.shipName || `Ship #${ds.shipId}`;
            const cls = ship?.shipClass || '';
            const isActive = ds.isActive;
            return `
                <label class="ship-radio-row ${isActive ? 'active' : ''}">
                    <input type="radio" name="active-ship-${activeDockNum}"
                        value="${ds.shipId}" ${isActive ? 'checked' : ''}
                        data-action="set-active-ship" data-ship="${ds.shipId}" />
                    <span class="ship-name">${escHtml(name)}</span>
                    ${cls ? `<span class="ship-class-badge">${escHtml(cls)}</span>` : ''}
                    <button class="ship-remove-btn" data-action="remove-ship" data-ship="${ds.shipId}" title="Remove from dock">✕</button>
                </label>
            `;
        }).join('');
    }

    // Available ships (not assigned to any dock)
    const availableShips = allShips.filter(s =>
        !assignedIds.has(String(s.id)) && !otherDockShipIds.has(String(s.id))
    );

    let availableHtml = '';
    if (availableShips.length > 0) {
        const options = availableShips.map(s =>
            `<option value="${s.id}">${escHtml(s.name)}${s.shipClass ? ` (${s.shipClass})` : ''}</option>`
        ).join('');
        availableHtml = `
            <div class="ship-add-row">
                <select class="ship-add-select" data-action="add-ship-select">
                    <option value="">+ Add ship to dock...</option>
                    ${options}
                </select>
            </div>
        `;
    } else if (allShips.length === 0) {
        availableHtml = `<p class="hint">No ships in fleet yet. Import from Google Sheets or add manually.</p>`;
    }

    return `
        <div class="dock-section">
            <h3 class="dock-section-title">Ships</h3>
            <div class="dock-ship-list">
                ${assignedHtml}
                ${availableHtml}
            </div>
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
    area.querySelectorAll(".dock-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            activeDockNum = parseInt(tab.dataset.dock, 10);
            render();
        });
    });

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
                const tabsEl = area.querySelector(".dock-tabs");
                if (tabsEl) {
                    tabsEl.outerHTML = renderDockTabs();
                    // Re-bind tab events
                    area.querySelectorAll(".dock-tab").forEach(tab => {
                        tab.addEventListener("click", () => {
                            activeDockNum = parseInt(tab.dataset.dock, 10);
                            render();
                        });
                    });
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
            // If no ships yet, make first one active
            const dock = docks.find(d => d.dockNumber === activeDockNum);
            const isFirst = !dock || (dock.ships || []).length === 0;
            await api.addDockShip(activeDockNum, parseInt(shipId, 10), isFirst);
            await refresh();
        });
    }

    // Intent checkbox toggle
    area.querySelectorAll("[data-action='toggle-intent']").forEach(cb => {
        cb.addEventListener("change", async () => {
            // Gather all checked intents
            const checked = [];
            area.querySelectorAll("[data-action='toggle-intent']").forEach(el => {
                if (el.checked) checked.push(el.dataset.key);
            });
            await api.saveDockIntents(activeDockNum, checked);
            // Update local cache
            const dock = docks.find(d => d.dockNumber === activeDockNum);
            if (dock) {
                dock.intents = allIntents.filter(i => checked.includes(i.key));
            }
        });
    });
}

// ─── Helpers ────────────────────────────────────────────────

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
