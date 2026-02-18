/**
 * fleet.js — Fleet Roster Manager (ADR-017)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Focused view for owned ships and officers with inline editing
 * of player-specific fields: level, rank, tier, power.
 *
 * Design goals:
 * - Shows ONLY owned items (pre-filtered from merged catalog)
 * - Inline editable fields with debounced auto-save
 * - Sort by name, level, power, rarity
 * - Stats summary bar (counts, average level, total power)
 * - Target notes visible inline for targeted items
 */

import { fetchCatalogOfficers, fetchCatalogShips, setOfficerOverlay, setShipOverlay } from 'api/catalog.js';
import {
    fetchBridgeCores, fetchCrewLoadouts, fetchBelowDeckPolicies,
    fetchReservations, setReservation, deleteReservation,
    fetchEffectiveState, fetchCrewDocks,
} from 'api/crews.js';
import { esc } from 'utils/escape.js';
import { hullTypeLabel, officerClassShort } from 'utils/game-enums.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let officers = [];
let ships = [];
let activeTab = 'officers'; // 'officers' | 'ships'
let viewMode = 'cards';  // 'list' | 'cards' — default grid (#87)
let searchQuery = '';
let sortField = 'name'; // 'name' | 'level' | 'power' | 'rarity'
let sortDir = 'asc';    // 'asc' | 'desc'
let loading = false;
let saveTimers = {};     // { refId: timeoutId } for debounced saves
let noteTimers = {};     // { refId: timeoutId } for debounced note saves

// ─── Cross-Reference State (ADR-025 / #63) ──────────────────
let reservationMap = {};    // { officerId: { reservedFor, locked, notes } }
let officerUsedIn = {};     // { officerId: [{ type, name, slot? }] }
let shipUsedIn = {};        // { shipId: [{ name, priority? }] }
let officerConflicts = {};  // { officerId: locations[] }
let shipDockMap = {};       // { shipId: dockNumber }

const $ = (sel) => document.querySelector(sel);

/** Cancel all pending debounced saves to prevent stale writes after tab/view switch */
function clearPendingTimers() {
    for (const key of Object.keys(saveTimers)) { clearTimeout(saveTimers[key]); }
    for (const key of Object.keys(noteTimers)) { clearTimeout(noteTimers[key]); }
    for (const key of Object.keys(resvTimers)) { clearTimeout(resvTimers[key]); }
    saveTimers = {};
    noteTimers = {};
    resvTimers = {};
}

// ─── View Registration ──────────────────────────────────────
registerView('fleet', {
    area: $('#fleet-area'),
    icon: '🚀', title: 'Fleet', subtitle: 'Your owned roster — levels, ranks & power',
    cssHref: 'views/fleet/fleet.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $("#fleet-area");
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [officerData, shipData, cores, loadouts, policies, reservations, effectiveState, docks] = await Promise.all([
            fetchCatalogOfficers({ ownership: 'owned' }),
            fetchCatalogShips({ ownership: 'owned' }),
            fetchBridgeCores().catch(() => []),
            fetchCrewLoadouts().catch(() => []),
            fetchBelowDeckPolicies().catch(() => []),
            fetchReservations().catch(() => []),
            fetchEffectiveState().catch(() => ({ docks: [], conflicts: [] })),
            fetchCrewDocks().catch(() => []),
        ]);
        officers = Array.isArray(officerData) ? officerData : (officerData?.officers ?? []);
        ships = Array.isArray(shipData) ? shipData : (shipData?.ships ?? []);
        buildCrossRefs(cores, loadouts, policies, reservations, effectiveState, docks);
        render();
    } catch (err) {
        console.error("Fleet refresh failed:", err);
        const area = $("#fleet-area");
        if (area) area.innerHTML = `<div class="fleet-error">Failed to load fleet: ${esc(err.message)}</div>`;
    } finally {
        loading = false;
    }
}

// ─── Cross-Reference Builder (ADR-025 / #63) ────────────────

function buildCrossRefs(cores, loadouts, policies, reservations, effectiveState, docks) {
    // 1. Reservations
    reservationMap = {};
    const resvArr = Array.isArray(reservations) ? reservations : (reservations?.reservations ?? []);
    for (const r of resvArr) {
        reservationMap[r.officerId ?? r.officer_id] = {
            reservedFor: r.reservedFor ?? r.reserved_for ?? '',
            locked: r.locked ?? false,
            notes: r.notes ?? '',
        };
    }

    // 2. Officer "used in" map
    officerUsedIn = {};
    const addOfficerRef = (id, ref) => {
        if (!id) return;
        (officerUsedIn[id] ??= []).push(ref);
    };

    const coreArr = cores?.bridgeCores ?? cores ?? [];
    for (const c of coreArr) {
        const members = c.members ?? [];
        for (const m of members) {
            addOfficerRef(m.officerId ?? m.officer_id, { type: 'bridge_core', name: c.name, slot: m.slot });
        }
    }

    // Raw loadouts have bridgeCoreId, not a bridge object.
    // Cross-refs from loadouts handled via bridgeCore lookup above.

    const loadoutArr = Array.isArray(loadouts) ? loadouts : (loadouts?.loadouts ?? []);
    const policyArr = Array.isArray(policies) ? policies : (policies?.belowDeckPolicies ?? []);
    for (const p of policyArr) {
        const pinned = p.spec?.pinned ?? p.pinnedOfficers ?? [];
        for (const officerId of pinned) {
            addOfficerRef(officerId, { type: 'policy', name: p.name });
        }
    }

    // 3. Officer conflicts from effective state
    officerConflicts = {};
    const conflicts = effectiveState?.conflicts ?? [];
    for (const c of conflicts) {
        officerConflicts[c.officerId] = c.locations;
    }

    // 4. Ship "used in" map
    shipUsedIn = {};
    for (const l of loadoutArr) {
        const sid = l.shipId ?? l.ship_id;
        if (!sid) continue;
        (shipUsedIn[sid] ??= []).push({
            name: l.name,
            priority: l.priority,
        });
    }

    // 5. Ship → dock map
    shipDockMap = {};
    const dockArr = docks?.docks ?? docks ?? [];
    for (const d of dockArr) {
        if (d.shipId ?? d.ship_id) {
            shipDockMap[d.shipId ?? d.ship_id] = d.dockNumber ?? d.dock_number;
        }
    }
    // Also use effective state dock entries for ship→dock
    const dockEntries = effectiveState?.docks ?? [];
    for (const entry of dockEntries) {
        if (entry.loadout?.shipId) {
            shipDockMap[entry.loadout.shipId] = entry.dockNumber;
        }
    }
}

// ─── Sorting ────────────────────────────────────────────────

const RARITY_ORDER = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

function sortItems(items) {
    const sorted = [...items];
    sorted.sort((a, b) => {
        let cmp;
        switch (sortField) {
            case 'level':
                cmp = (a.userLevel || 0) - (b.userLevel || 0);
                break;
            case 'power':
                cmp = (a.userPower || 0) - (b.userPower || 0);
                break;
            case 'rarity':
                cmp = (RARITY_ORDER[(a.rarity || '').toLowerCase()] || 0) -
                    (RARITY_ORDER[(b.rarity || '').toLowerCase()] || 0);
                break;
            default: // name
                cmp = (a.name || '').localeCompare(b.name || '');
        }
        return sortDir === 'desc' ? -cmp : cmp;
    });
    return sorted;
}

// ─── Stats ──────────────────────────────────────────────────

function computeStats(items) {
    const count = items.length;
    const withLevel = items.filter(i => i.userLevel != null && i.userLevel > 0);
    const avgLevel = withLevel.length > 0
        ? Math.round(withLevel.reduce((s, i) => s + i.userLevel, 0) / withLevel.length)
        : 0;
    const totalPower = items.reduce((s, i) => s + (i.userPower || 0), 0);
    const targeted = items.filter(i => i.target).length;
    return { count, avgLevel, totalPower, targeted };
}

function formatPower(n) {
    if (!n) return '—';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $("#fleet-area");
    if (!area) return;

    // Clear pending debounced saves before re-rendering DOM (H5)
    clearPendingTimers();

    const allItems = activeTab === 'officers' ? officers : ships;
    const filtered = searchQuery
        ? allItems.filter(i => i.name && i.name.toLowerCase().includes(searchQuery.toLowerCase()))
        : allItems;
    const items = sortItems(filtered);
    const stats = computeStats(allItems);

    area.innerHTML = `
        ${renderTabBar()}
        ${renderStatsBar(stats)}
        ${renderToolbar()}
        <div class="fleet-grid ${viewMode === 'cards' ? 'fleet-grid-cards' : ''}">
            ${items.length === 0 ? renderEmpty() : renderGrid(items)}
        </div>
    `;
    bindEvents();
}

function renderTabBar() {
    return `
        <div class="fleet-tabs">
            <button class="fleet-tab ${activeTab === 'officers' ? 'active' : ''}" data-tab="officers">
                Officers <span class="fleet-tab-count">${officers.length}</span>
            </button>
            <button class="fleet-tab ${activeTab === 'ships' ? 'active' : ''}" data-tab="ships">
                Ships <span class="fleet-tab-count">${ships.length}</span>
            </button>
        </div>
    `;
}

function renderStatsBar(stats) {
    const noun = activeTab === 'officers' ? 'officers' : 'ships';
    return `
        <div class="fleet-stats">
            <span class="fleet-stat"><strong>${stats.count}</strong> ${noun} owned</span>
            <span class="fleet-stat-sep">·</span>
            <span class="fleet-stat">Avg level <strong>${stats.avgLevel}</strong></span>
            <span class="fleet-stat-sep">·</span>
            <span class="fleet-stat">Total power <strong>${formatPower(stats.totalPower)}</strong></span>
            ${stats.targeted > 0 ? `<span class="fleet-stat-sep">·</span><span class="fleet-stat">🎯 <strong>${stats.targeted}</strong> targeted</span>` : ''}
        </div>
    `;
}

function renderToolbar() {
    const noun = activeTab === 'officers' ? 'officer' : 'ship';
    const sortOptions = [
        { value: 'name', label: 'Name' },
        { value: 'level', label: 'Level' },
        { value: 'power', label: 'Power' },
        { value: 'rarity', label: 'Rarity' },
    ];
    return `
        <div class="fleet-toolbar">
            <div class="fleet-search-wrap">
                <input type="text" class="fleet-search" placeholder="Search ${noun}s..." value="${esc(searchQuery)}" />
            </div>
            <div class="fleet-sort">
                <label class="fleet-sort-label">Sort:</label>
                <select class="fleet-sort-select" data-action="sort-field">
                    ${sortOptions.map(o => `<option value="${o.value}" ${sortField === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
                </select>
                <button class="fleet-sort-dir" data-action="sort-dir" title="Toggle sort direction">
                    ${sortDir === 'asc' ? '↑' : '↓'}
                </button>
            </div>
            <div class="fleet-view-toggle">
                <button class="fleet-view-btn ${viewMode === 'list' ? 'active' : ''}" data-action="view-list" title="List view">☰</button>
                <button class="fleet-view-btn ${viewMode === 'cards' ? 'active' : ''}" data-action="view-cards" title="Card view">▦</button>
            </div>
        </div>
    `;
}

function renderGrid(items) {
    if (viewMode === 'cards') {
        if (activeTab === 'officers') {
            return items.map(o => renderOfficerCard(o)).join('');
        } else {
            return items.map(s => renderShipCard(s)).join('');
        }
    }
    if (activeTab === 'officers') {
        return items.map(o => renderOfficerRow(o)).join('');
    } else {
        return items.map(s => renderShipRow(s)).join('');
    }
}

function renderOfficerRow(o) {
    const targeted = o.target;
    const resv = reservationMap[o.id];
    const conflict = officerConflicts[o.id];
    const refs = officerUsedIn[o.id];
    const classShort = officerClassShort(o.officerClass);
    const factionName = typeof o.faction === 'object' && o.faction?.name ? o.faction.name : (typeof o.faction === 'string' ? o.faction : '');
    return `
        <div class="fleet-row ${targeted ? 'fleet-targeted' : ''} ${conflict ? 'fleet-conflict' : ''}" data-id="${esc(o.id)}">
            <div class="fleet-row-header">
                <span class="fleet-row-name">${esc(o.name)}</span>
                ${classShort ? `<span class="cat-badge officer-class officer-class-${classShort.toLowerCase()}">${esc(classShort)}</span>` : ''}
                ${o.rarity ? `<span class="cat-badge rarity-${(o.rarity || '').toLowerCase()}">${esc(o.rarity)}</span>` : ''}
                ${o.groupName ? `<span class="cat-badge group">${esc(o.groupName)}</span>` : ''}
                ${factionName ? `<span class="cat-badge faction">${esc(factionName)}</span>` : ''}
                ${targeted ? '<span class="fleet-target-badge">🎯</span>' : ''}
                ${conflict ? '<span class="fleet-conflict-badge" title="Officer assigned to multiple docks">⚠️</span>' : ''}
                ${renderReservationBadge(o.id, resv)}
            </div>
            ${renderAbilities(o)}
            <div class="fleet-row-fields">
                <label class="fleet-field">
                    <span class="fleet-field-label">Level</span>
                    <input type="number" class="fleet-input" data-field="level" data-id="${esc(o.id)}"
                           value="${o.userLevel ?? ''}" min="1" max="200" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Rank</span>
                    <input type="text" class="fleet-input" data-field="rank" data-id="${esc(o.id)}"
                           value="${esc(o.userRank ?? '')}" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Power</span>
                    <input type="number" class="fleet-input fleet-input-power" data-field="power" data-id="${esc(o.id)}"
                           value="${o.userPower ?? ''}" min="0" placeholder="—" />
                </label>
            </div>
            ${renderOfficerUsedIn(refs)}
            ${renderReservationForm(o.id, resv)}
            ${renderNoteField(o)}
        </div>
    `;
}

function renderShipRow(s) {
    const targeted = s.target;
    const dock = shipDockMap[s.id];
    const refs = shipUsedIn[s.id];
    const hull = hullTypeLabel(s.hullType);
    return `
        <div class="fleet-row ${targeted ? 'fleet-targeted' : ''}" data-id="${esc(s.id)}">
            <div class="fleet-row-header">
                <span class="fleet-row-name">${esc(s.name)}</span>
                ${hull ? `<span class="cat-badge hull-type">${esc(hull)}</span>` : ''}
                ${s.rarity ? `<span class="cat-badge rarity-${(s.rarity || '').toLowerCase()}">${esc(s.rarity)}</span>` : ''}
                ${s.faction ? `<span class="cat-badge faction">${esc(s.faction)}</span>` : ''}
                ${s.shipClass ? `<span class="cat-badge ship-class">${esc(s.shipClass)}</span>` : ''}
                ${targeted ? '<span class="fleet-target-badge">🎯</span>' : ''}
                ${dock != null ? `<span class="fleet-dock-badge">Dock ${dock}</span>` : ''}
            </div>
            <div class="fleet-row-fields">
                <label class="fleet-field">
                    <span class="fleet-field-label">Tier</span>
                    <input type="number" class="fleet-input" data-field="tier" data-id="${esc(s.id)}"
                           value="${s.userTier ?? ''}" min="1" max="10" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Level</span>
                    <input type="number" class="fleet-input" data-field="level" data-id="${esc(s.id)}"
                           value="${s.userLevel ?? ''}" min="1" max="200" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Power</span>
                    <input type="number" class="fleet-input fleet-input-power" data-field="power" data-id="${esc(s.id)}"
                           value="${s.userPower ?? ''}" min="0" placeholder="—" />
                </label>
            </div>
            ${renderShipUsedIn(refs)}
            ${renderNoteField(s)}
        </div>
    `;
}

// ─── Card Renderers (QA-001-8) ──────────────────────────────

function renderOfficerCard(o) {
    const targeted = o.target;
    const resv = reservationMap[o.id];
    const conflict = officerConflicts[o.id];
    const refs = officerUsedIn[o.id];
    const classShort = officerClassShort(o.officerClass);
    return `
        <div class="fleet-card ${targeted ? 'fleet-targeted' : ''} ${conflict ? 'fleet-conflict' : ''}" data-id="${esc(o.id)}">
            <div class="fleet-card-header">
                <span class="fleet-row-name">${esc(o.name)}</span>
                ${conflict ? '<span class="fleet-conflict-badge" title="Officer assigned to multiple docks">⚠️</span>' : ''}
                ${targeted ? '<span class="fleet-target-badge">🎯</span>' : ''}
            </div>
            <div class="fleet-card-badges">
                ${classShort ? `<span class="cat-badge officer-class officer-class-${classShort.toLowerCase()}">${esc(classShort)}</span>` : ''}
                ${o.rarity ? `<span class="cat-badge rarity-${(o.rarity || '').toLowerCase()}">${esc(o.rarity)}</span>` : ''}
                ${o.groupName ? `<span class="cat-badge group">${esc(o.groupName)}</span>` : ''}
                ${renderReservationBadge(o.id, resv)}
            </div>
            ${renderAbilities(o)}
            <div class="fleet-card-fields">
                <label class="fleet-field">
                    <span class="fleet-field-label">Level</span>
                    <input type="number" class="fleet-input" data-field="level" data-id="${esc(o.id)}"
                           value="${o.userLevel ?? ''}" min="1" max="200" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Rank</span>
                    <input type="text" class="fleet-input" data-field="rank" data-id="${esc(o.id)}"
                           value="${esc(o.userRank ?? '')}" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Power</span>
                    <input type="number" class="fleet-input fleet-input-power" data-field="power" data-id="${esc(o.id)}"
                           value="${o.userPower ?? ''}" min="0" placeholder="—" />
                </label>
            </div>
            ${renderOfficerUsedIn(refs)}
            ${renderReservationForm(o.id, resv)}
            ${renderNoteField(o)}
        </div>
    `;
}

function renderShipCard(s) {
    const targeted = s.target;
    const dock = shipDockMap[s.id];
    const refs = shipUsedIn[s.id];
    const hull = hullTypeLabel(s.hullType);
    return `
        <div class="fleet-card ${targeted ? 'fleet-targeted' : ''}" data-id="${esc(s.id)}">
            <div class="fleet-card-header">
                <span class="fleet-row-name">${esc(s.name)}</span>
                ${targeted ? '<span class="fleet-target-badge">🎯</span>' : ''}
                ${dock != null ? `<span class="fleet-dock-badge">Dock ${dock}</span>` : ''}
            </div>
            <div class="fleet-card-badges">
                ${hull ? `<span class="cat-badge hull-type">${esc(hull)}</span>` : ''}
                ${s.rarity ? `<span class="cat-badge rarity-${(s.rarity || '').toLowerCase()}">${esc(s.rarity)}</span>` : ''}
                ${s.faction ? `<span class="cat-badge faction">${esc(s.faction)}</span>` : ''}
                ${s.shipClass ? `<span class="cat-badge ship-class">${esc(s.shipClass)}</span>` : ''}
            </div>
            <div class="fleet-card-fields">
                <label class="fleet-field">
                    <span class="fleet-field-label">Tier</span>
                    <input type="number" class="fleet-input" data-field="tier" data-id="${esc(s.id)}"
                           value="${s.userTier ?? ''}" min="1" max="10" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Level</span>
                    <input type="number" class="fleet-input" data-field="level" data-id="${esc(s.id)}"
                           value="${s.userLevel ?? ''}" min="1" max="200" placeholder="—" />
                </label>
                <label class="fleet-field">
                    <span class="fleet-field-label">Power</span>
                    <input type="number" class="fleet-input fleet-input-power" data-field="power" data-id="${esc(s.id)}"
                           value="${s.userPower ?? ''}" min="0" placeholder="—" />
                </label>
            </div>
            ${renderShipUsedIn(refs)}
            ${renderNoteField(s)}
        </div>
    `;
}

// ─── Shared Rendering Helpers ───────────────────────────────

/** Render CM/OA abilities for officers (QA-001-10) */
function renderAbilities(o) {
    if (!o.captainManeuver && !o.officerAbility) return '';
    return `
        <div class="fleet-abilities">
            ${o.captainManeuver ? `<div class="fleet-ability"><span class="fleet-ability-label">CM:</span> ${esc(o.captainManeuver)}</div>` : ''}
            ${o.officerAbility ? `<div class="fleet-ability"><span class="fleet-ability-label">OA:</span> ${esc(o.officerAbility)}</div>` : ''}
        </div>
    `;
}

/** Render inline note textarea (QA-001-8) */
function renderNoteField(item) {
    const note = item.targetNote || '';
    return `
        <div class="fleet-note-wrap">
            <textarea class="fleet-note-input" data-id="${esc(item.id)}" data-field="targetNote"
                      placeholder="Add a note… e.g. farm X for this, comes from Borg daily loop"
                      rows="1">${esc(note)}</textarea>
        </div>
    `;
}

// ─── Cross-Reference Renderers (ADR-025 / #63) ─────────────

const SLOT_LABELS = { captain: 'Captain', bridge_1: 'Bridge 1', bridge_2: 'Bridge 2' };
const REF_TYPE_LABELS = { bridge_core: 'Bridge Core', loadout: 'Loadout', policy: 'Policy' };

function renderReservationBadge(officerId, resv) {
    if (!resv) return '';
    const icon = resv.locked ? '🔒' : '🔓';
    const label = resv.reservedFor || 'Reserved';
    return `<span class="fleet-resv-badge ${resv.locked ? 'locked' : 'soft'}" title="${resv.locked ? 'Hard' : 'Soft'} reservation: ${esc(label)}">${icon} ${esc(label)}</span>`;
}

function renderReservationForm(officerId, resv) {
    const reservedFor = resv?.reservedFor ?? '';
    const locked = resv?.locked ?? false;
    return `
        <div class="fleet-resv-form" data-officer-id="${esc(officerId)}">
            <span class="fleet-field-label">Reserve</span>
            <div class="fleet-resv-controls">
                <input type="text" class="fleet-resv-input" data-action="resv-for"
                       value="${esc(reservedFor)}" placeholder="e.g. Swarm, PvP Anchor" />
                <button class="fleet-resv-toggle ${locked ? 'locked' : ''}" data-action="resv-lock"
                        title="${locked ? 'Hard lock (click to soften)' : 'Soft (click to hard-lock)'}">
                    ${locked ? '🔒' : '🔓'}
                </button>
                ${resv ? `<button class="fleet-resv-clear" data-action="resv-clear" title="Clear reservation">✕</button>` : ''}
            </div>
        </div>
    `;
}

function renderOfficerUsedIn(refs) {
    if (!refs || refs.length === 0) return '';
    const items = refs.map(r => {
        const typeLabel = REF_TYPE_LABELS[r.type] || r.type;
        const slotLabel = r.slot ? ` (${SLOT_LABELS[r.slot] || r.slot})` : '';
        return `<span class="fleet-xref-item">${esc(typeLabel)}: ${esc(r.name)}${slotLabel}</span>`;
    });
    return `
        <div class="fleet-xref">
            <span class="fleet-xref-label">Used in:</span>
            ${items.join('')}
        </div>
    `;
}

function renderShipUsedIn(refs) {
    if (!refs || refs.length === 0) return '';
    const items = refs.map(r => {
        const priority = r.priority != null ? ` (priority ${r.priority})` : '';
        return `<span class="fleet-xref-item">${esc(r.name)}${priority}</span>`;
    });
    return `
        <div class="fleet-xref">
            <span class="fleet-xref-label">Used in:</span>
            ${items.join('')}
        </div>
    `;
}

function renderEmpty() {
    if (searchQuery) {
        return `<div class="fleet-empty"><p>No owned ${activeTab} match "${esc(searchQuery)}".</p></div>`;
    }
    return `<div class="fleet-empty">
        <p>No owned ${activeTab} yet.</p>
        <p class="hint">Head to the <strong>Catalog</strong> tab and mark items as owned, then come back here to manage your roster.</p>
    </div>`;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    const area = $("#fleet-area");
    if (!area) return;

    // Tab switching
    area.querySelectorAll('.fleet-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            searchQuery = '';
            render();
        });
    });

    // Search
    const searchInput = area.querySelector('.fleet-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            searchQuery = e.target.value.trim();
            render();
            // Re-focus after render
            const s = area.querySelector('.fleet-search');
            if (s) {
                s.focus();
                s.selectionStart = s.selectionEnd = s.value.length;
            }
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

    // View toggle (QA-001-8)
    const listBtn = area.querySelector('[data-action="view-list"]');
    if (listBtn) {
        listBtn.addEventListener('click', () => {
            if (viewMode !== 'list') { viewMode = 'list'; render(); }
        });
    }
    const cardsBtn = area.querySelector('[data-action="view-cards"]');
    if (cardsBtn) {
        cardsBtn.addEventListener('click', () => {
            if (viewMode !== 'cards') { viewMode = 'cards'; render(); }
        });
    }

    // Inline field editing with debounced save
    // Capture activeTab at bind time to prevent stale-closure data corruption
    // if the user switches tabs before the 600ms debounce fires.
    const boundTab = activeTab;
    area.querySelectorAll('.fleet-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const id = e.target.dataset.id;
            const field = e.target.dataset.field;
            const rawValue = e.target.value.trim();

            // Debounce saves per-field-per-entity
            const key = `${id}:${field}`;
            if (saveTimers[key]) clearTimeout(saveTimers[key]);
            saveTimers[key] = setTimeout(() => {
                saveField(id, field, rawValue, boundTab);
                delete saveTimers[key];
            }, 600);
        });

        // Save immediately on blur (cancel pending debounce to avoid double-fire)
        input.addEventListener('blur', (e) => {
            const id = e.target.dataset.id;
            const field = e.target.dataset.field;
            const rawValue = e.target.value.trim();
            const key = `${id}:${field}`;
            if (saveTimers[key]) {
                clearTimeout(saveTimers[key]);
                delete saveTimers[key];
                // Only save on blur if there was a pending debounce (user was typing)
                saveField(id, field, rawValue, boundTab);
            }
        });

        // Enter to move to next row's same field
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                const row = e.target.closest('.fleet-row, .fleet-card');
                const field = e.target.dataset.field;
                const nextRow = row?.nextElementSibling;
                if (nextRow) {
                    const nextInput = nextRow.querySelector(`.fleet-input[data-field="${CSS.escape(field)}"]`);
                    if (nextInput) nextInput.focus();
                }
            }
        });
    });

    // Inline note editing with debounced save (QA-001-8)
    area.querySelectorAll('.fleet-note-input').forEach(textarea => {
        // Auto-resize textarea
        autoResizeTextarea(textarea);

        textarea.addEventListener('input', (e) => {
            autoResizeTextarea(e.target);
            const id = e.target.dataset.id;
            const rawValue = e.target.value;

            const key = `note:${id}`;
            if (noteTimers[key]) clearTimeout(noteTimers[key]);
            noteTimers[key] = setTimeout(() => {
                saveNote(id, rawValue, boundTab);
                delete noteTimers[key];
            }, 800);
        });

        textarea.addEventListener('blur', (e) => {
            const id = e.target.dataset.id;
            const rawValue = e.target.value;
            const key = `note:${id}`;
            if (noteTimers[key]) {
                clearTimeout(noteTimers[key]);
                delete noteTimers[key];
                saveNote(id, rawValue, boundTab);
            }
        });
    });

    // ── Reservation Controls (ADR-025 / #63) ────────────────
    bindReservationEvents(area);
}

// ─── Reservation Events (#63) ───────────────────────────────

let resvTimers = {};

function bindReservationEvents(area) {
    // Debounced save on reservation text input
    area.querySelectorAll('.fleet-resv-input').forEach(input => {
        input.addEventListener('input', (e) => {
            const form = e.target.closest('.fleet-resv-form');
            const officerId = form?.dataset.officerId;
            if (!officerId) return;
            const key = `resv:${officerId}`;
            if (resvTimers[key]) clearTimeout(resvTimers[key]);
            resvTimers[key] = setTimeout(() => {
                const lockBtn = form.querySelector('[data-action="resv-lock"]');
                const locked = lockBtn?.classList.contains('locked') ?? false;
                saveReservation(officerId, e.target.value.trim(), locked);
                delete resvTimers[key];
            }, 800);
        });

        // Save on blur if pending
        input.addEventListener('blur', (e) => {
            const form = e.target.closest('.fleet-resv-form');
            const officerId = form?.dataset.officerId;
            if (!officerId) return;
            const key = `resv:${officerId}`;
            if (resvTimers[key]) {
                clearTimeout(resvTimers[key]);
                delete resvTimers[key];
                const lockBtn = form.querySelector('[data-action="resv-lock"]');
                const locked = lockBtn?.classList.contains('locked') ?? false;
                saveReservation(officerId, e.target.value.trim(), locked);
            }
        });
    });

    // Toggle lock (soft ↔ hard)
    area.querySelectorAll('[data-action="resv-lock"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const form = btn.closest('.fleet-resv-form');
            const officerId = form?.dataset.officerId;
            if (!officerId) return;
            const input = form.querySelector('.fleet-resv-input');
            const reservedFor = input?.value.trim() || '';
            const wasLocked = btn.classList.contains('locked');
            saveReservation(officerId, reservedFor, !wasLocked);
        });
    });

    // Clear reservation
    area.querySelectorAll('[data-action="resv-clear"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const form = btn.closest('.fleet-resv-form');
            const officerId = form?.dataset.officerId;
            if (!officerId) return;
            clearReservation(officerId);
        });
    });
}

async function saveReservation(officerId, reservedFor, locked) {
    try {
        await setReservation(officerId, reservedFor || 'Reserved', locked);
        reservationMap[officerId] = { reservedFor: reservedFor || 'Reserved', locked, notes: '' };
        render();
    } catch (err) {
        console.error(`Failed to save reservation for ${officerId}:`, err);
    }
}

async function clearReservation(officerId) {
    try {
        await deleteReservation(officerId);
        delete reservationMap[officerId];
        render();
    } catch (err) {
        console.error(`Failed to clear reservation for ${officerId}:`, err);
    }
}

// ─── Save Field ─────────────────────────────────────────────

async function saveField(id, field, rawValue, tab) {
    const isOfficer = tab === 'officers';
    const setFn = isOfficer ? setOfficerOverlay : setShipOverlay;

    let value;
    if (field === 'rank') {
        value = rawValue || null;
    } else {
        // Numeric fields: level, tier, power — validate and clamp
        value = rawValue ? parseInt(rawValue, 10) : null;
        if (value !== null && isNaN(value)) value = null;
        if (value !== null) {
            // Enforce sane ranges matching server-side validation
            if (field === 'level') value = Math.max(1, Math.min(200, value));
            else if (field === 'tier') value = Math.max(1, Math.min(10, value));
            else if (field === 'power') value = Math.max(0, Math.min(999_999_999, value));
        }
    }

    const overlay = { [field]: value };

    try {
        await setFn(id, overlay);
        // Flash save indicator (use data-attribute selector to handle IDs with special chars)
        const input = document.querySelector(`.fleet-input[data-id="${CSS.escape(id)}"][data-field="${CSS.escape(field)}"]`);
        if (input) {
            input.classList.add('fleet-saved');
            setTimeout(() => input.classList.remove('fleet-saved'), 800);
        }
        // Update local state without full re-render
        const items = isOfficer ? officers : ships;
        const item = items.find(i => i.id === id);
        if (item) {
            if (field === 'level') item.userLevel = value;
            else if (field === 'rank') item.userRank = value;
            else if (field === 'tier') item.userTier = value;
            else if (field === 'power') item.userPower = value;
            // Update stats bar without full re-render
            updateStatsBar();
        }
    } catch (err) {
        console.error(`Failed to save ${field} for ${id}:`, err);
        const input = document.querySelector(`.fleet-input[data-id="${CSS.escape(id)}"][data-field="${CSS.escape(field)}"]`);
        if (input) {
            input.classList.add('fleet-save-error');
            setTimeout(() => input.classList.remove('fleet-save-error'), 1500);
        }
    }
}

function updateStatsBar() {
    const allItems = activeTab === 'officers' ? officers : ships;
    const stats = computeStats(allItems);
    const statsEl = document.querySelector('.fleet-stats');
    if (statsEl) {
        const noun = activeTab === 'officers' ? 'officers' : 'ships';
        statsEl.innerHTML = `
            <span class="fleet-stat"><strong>${stats.count}</strong> ${noun} owned</span>
            <span class="fleet-stat-sep">·</span>
            <span class="fleet-stat">Avg level <strong>${stats.avgLevel}</strong></span>
            <span class="fleet-stat-sep">·</span>
            <span class="fleet-stat">Total power <strong>${formatPower(stats.totalPower)}</strong></span>
            ${stats.targeted > 0 ? `<span class="fleet-stat-sep">·</span><span class="fleet-stat">🎯 <strong>${stats.targeted}</strong> targeted</span>` : ''}
        `;
    }
}

// ─── Helpers ────────────────────────────────────────────────

/** Save inline note via overlay API (QA-001-8) */
async function saveNote(id, rawValue, tab) {
    const isOfficer = tab === 'officers';
    const setFn = isOfficer ? setOfficerOverlay : setShipOverlay;
    const value = rawValue.trim().slice(0, 500) || null;
    const overlay = { targetNote: value };

    try {
        await setFn(id, overlay);
        const textarea = document.querySelector(`.fleet-note-input[data-id="${CSS.escape(id)}"]`);
        if (textarea) {
            textarea.classList.add('fleet-saved');
            setTimeout(() => textarea.classList.remove('fleet-saved'), 800);
        }
        // Update local state
        const items = isOfficer ? officers : ships;
        const item = items.find(i => i.id === id);
        if (item) item.targetNote = value;
    } catch (err) {
        console.error(`Failed to save note for ${id}:`, err);
        const textarea = document.querySelector(`.fleet-note-input[data-id="${CSS.escape(id)}"]`);
        if (textarea) {
            textarea.classList.add('fleet-save-error');
            setTimeout(() => textarea.classList.remove('fleet-save-error'), 1500);
        }
    }
}

/** Auto-grow textarea to content */
function autoResizeTextarea(el) {
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}
