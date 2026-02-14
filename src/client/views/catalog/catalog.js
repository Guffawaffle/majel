/**
 * catalog.js — Reference Catalog Grid (ADR-016 Phase 2)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Full-screen catalog view with search, filters, and overlay management.
 * Design goals from ADR-016 D4:
 * - Search-first: global search bar with instant filter
 * - Keyboard-friendly: rapid-fire "search → mark → search → mark"
 * - Bulk actions: mark visible as owned/unowned, toggle targets
 * - Undo support for bulk actions
 */

import {
    fetchCatalogOfficers, fetchCatalogShips, fetchCatalogCounts,
    setOfficerOverlay, setShipOverlay,
    bulkSetOfficerOverlay, bulkSetShipOverlay,
    syncWikiData,
} from 'api/catalog.js';
import { registerView } from 'router';

// ─── State ──────────────────────────────────────────────────
let officers = [];
let ships = [];
let activeTab = 'officers'; // 'officers' | 'ships'
let searchQuery = '';
let filters = { ownership: 'all', target: 'all', rarity: '', group: '', faction: '', class: '' };
let counts = { reference: { officers: 0, ships: 0 }, overlay: {} };
let undoStack = []; // { type, refIds, previousStates }
let loading = false;
let syncing = false;
let letterFilter = ''; // Active letter filter ('A', 'B', ... or '' for all)
let isAdmin = false; // Set by app.js — gates sync button

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ──────────────────────────────────────
registerView('catalog', {
    area: $('#catalog-area'),
    icon: '📋', title: 'Catalog', subtitle: 'Reference data & ownership tracking',
    cssHref: 'views/catalog/catalog.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

/** Called by app.js to enable/disable admin-only features (e.g. wiki sync). */
export function setAdminMode(admin) { isAdmin = !!admin; }

export async function init() {
    const area = $("#catalog-area");
    if (!area) return;
    await refresh();
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const filterArgs = buildFilterArgs();
        const [officerData, shipData, countData] = await Promise.all([
            fetchCatalogOfficers(filterArgs),
            fetchCatalogShips(filterArgs),
            fetchCatalogCounts(),
        ]);
        officers = officerData;
        ships = shipData;
        counts = countData;
        render();
    } catch (err) {
        console.error("Catalog refresh failed:", err);
        const area = $("#catalog-area");
        if (area) area.innerHTML = `<div class="cat-error">Failed to load catalog: ${err.message}</div>`;
    } finally {
        loading = false;
    }
}

// ─── Filter Arguments ───────────────────────────────────────

function buildFilterArgs() {
    const args = {};
    if (searchQuery) args.q = searchQuery;
    if (filters.ownership !== 'all') args.ownership = filters.ownership;
    if (filters.target === 'targeted') args.target = 'true';
    if (filters.target === 'not-targeted') args.target = 'false';
    if (filters.rarity) args.rarity = filters.rarity;
    if (filters.group) args.group = filters.group;
    if (filters.faction) args.faction = filters.faction;
    if (filters.class) args.class = filters.class;
    return args;
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $("#catalog-area");
    if (!area) return;

    const allItems = activeTab === 'officers' ? officers : ships;
    const items = letterFilter
        ? allItems.filter(i => i.name && i.name[0].toUpperCase() === letterFilter)
        : allItems;
    const refCount = activeTab === 'officers' ? counts.reference.officers : counts.reference.ships;
    const hasActiveFilters = filters.ownership !== 'all' || filters.target !== 'all' || filters.rarity || filters.group || filters.faction || filters.class || searchQuery || letterFilter;
    const resultNote = hasActiveFilters ? `Showing ${items.length} of ${refCount} ${activeTab}` : '';

    // ── Fast path: if search input is focused, update dynamic sections only ──
    // This prevents the search input from being destroyed/recreated, eliminating flicker.
    const searchEl = area.querySelector('.cat-search');
    const searchFocused = searchEl && document.activeElement === searchEl;

    if (searchFocused) {
        // Update grid
        const grid = area.querySelector('.cat-grid');
        if (grid) grid.innerHTML = items.length === 0 ? renderEmpty() : renderGrid(items);

        // Update result count in toolbar
        const toolbarCount = area.querySelector('.cat-toolbar .cat-result-count');
        if (toolbarCount) toolbarCount.textContent = `${items.length}${refCount ? ` / ${refCount}` : ''}`;

        // Update letter bar
        replaceSection(area, '.cat-letter-bar', renderLetterBar(allItems));

        // Update result note
        const noteEl = area.querySelector('.cat-result-note');
        if (noteEl) noteEl.innerHTML = resultNote ? `<div class="cat-result-count">${resultNote}</div>` : '';

        // Update bulk actions
        replaceSection(area, '.cat-bulk-wrap', `<div class="cat-bulk-wrap">${renderBulkActions(items)}</div>`);

        // Rebind events only on the new dynamic elements
        bindGridEvents(area);
        bindLetterEvents(area);
        bindBulkEvents(area);
        return;
    }

    // ── Full path: rebuild entire DOM ──
    area.innerHTML = `
        ${renderTabBar()}
        ${renderToolbar(refCount)}
        ${renderLetterBar(allItems)}
        ${renderFilterChips()}
        <div class="cat-result-note">${resultNote ? `<div class="cat-result-count">${resultNote}</div>` : ''}</div>
        <div class="cat-bulk-wrap">${renderBulkActions(items)}</div>
        <div class="cat-grid" role="grid">
            ${items.length === 0 ? renderEmpty() : renderGrid(items)}
        </div>
        ${undoStack.length > 0 ? renderUndoBar() : ''}
    `;
    bindEvents();
}

/** Replace a section's outerHTML by selector, or do nothing if not found */
function replaceSection(area, selector, newHtml) {
    const el = area.querySelector(selector);
    if (el) {
        const temp = document.createElement('div');
        temp.innerHTML = newHtml;
        if (temp.firstElementChild) {
            el.replaceWith(temp.firstElementChild);
        }
    }
}

function renderTabBar() {
    const oCount = counts.reference.officers || 0;
    const sCount = counts.reference.ships || 0;
    const oOverlay = counts.overlay?.officers || {};
    const sOverlay = counts.overlay?.ships || {};
    return `
        <div class="cat-tabs">
            <button class="cat-tab ${activeTab === 'officers' ? 'active' : ''}" data-tab="officers">
                Officers <span class="cat-tab-count">${oCount}</span>
                ${oOverlay.owned ? `<span class="cat-tab-owned">${oOverlay.owned} owned</span>` : ''}
            </button>
            <button class="cat-tab ${activeTab === 'ships' ? 'active' : ''}" data-tab="ships">
                Ships <span class="cat-tab-count">${sCount}</span>
                ${sOverlay.owned ? `<span class="cat-tab-owned">${sOverlay.owned} owned</span>` : ''}
            </button>
        </div>
    `;
}

function renderToolbar(totalRef) {
    const noun = activeTab === 'officers' ? 'officer' : 'ship';
    const items = activeTab === 'officers' ? officers : ships;
    return `
        <div class="cat-toolbar">
            <div class="cat-search-wrap">
                <svg class="cat-search-icon" width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
                <input type="text" class="cat-search" placeholder="Search ${noun}s..." value="${esc(searchQuery)}" data-action="search" autofocus />
                ${searchQuery ? '<button class="cat-search-clear" data-action="clear-search" title="Clear search">✕</button>' : ''}
            </div>
            <span class="cat-result-count">${items.length}${totalRef ? ` / ${totalRef}` : ''}</span>
            ${isAdmin ? `<button class="cat-sync-btn ${syncing ? 'syncing' : ''}" data-action="sync-wiki" title="Sync reference data from STFC Fandom Wiki">
                <svg class="cat-sync-icon" width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M14 8A6 6 0 1 1 8 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                    <path d="M8 0l3 2-3 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                ${syncing ? 'Syncing...' : 'Sync Wiki Data'}
            </button>` : ''}
        </div>
    `;
}

function renderLetterBar(items) {
    // Compute which letters have items
    const available = new Set();
    for (const item of items) {
        if (item.name) available.add(item.name[0].toUpperCase());
    }

    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    const letterBtns = letters.map(l => {
        const has = available.has(l);
        const active = letterFilter === l;
        return `<button class="letter-btn ${active ? 'active' : ''} ${has ? '' : 'disabled'}"
            data-action="filter-letter" data-letter="${l}" ${has ? '' : 'disabled'}>${l}</button>`;
    }).join('');

    return `
        <div class="cat-letter-bar">
            <button class="letter-btn ${letterFilter === '' ? 'active' : ''}"
                data-action="filter-letter" data-letter="">All</button>
            ${letterBtns}
        </div>
    `;
}

function renderFilterChips() {
    const ownershipOpts = [
        { value: 'all', label: 'All' },
        { value: 'owned', label: '✓ Owned' },
        { value: 'unowned', label: '✗ Unowned' },
    ];
    const targetOpts = [
        { value: 'all', label: 'Any' },
        { value: 'targeted', label: '🎯 Targeted' },
        { value: 'not-targeted', label: 'Not targeted' },
    ];

    // Active filter summary
    const activeFilters = [];
    if (filters.ownership !== 'all') activeFilters.push(filters.ownership === 'owned' ? 'Owned' : 'Unowned');
    if (filters.target !== 'all') activeFilters.push(filters.target === 'targeted' ? 'Targeted' : 'Not targeted');
    // Ownership + Target use OR logic on the server; other combos use AND
    const overlayJoiner = activeFilters.length === 2 ? ' or ' : ' + ';
    const filterSummary = activeFilters.length > 0
        ? `<span class="cat-filter-summary">Showing: ${activeFilters.join(overlayJoiner)}</span>`
        : '';

    return `
        <div class="cat-filters">
            <div class="cat-filter-group">
                <span class="cat-filter-label">Ownership:</span>
                ${ownershipOpts.map(o => `
                    <button class="cat-chip ${filters.ownership === o.value ? 'active' : ''}"
                            data-action="filter-ownership" data-value="${o.value}">${o.label}</button>
                `).join('')}
            </div>
            <div class="cat-filter-group">
                <span class="cat-filter-label">Target:</span>
                ${targetOpts.map(o => `
                    <button class="cat-chip ${filters.target === o.value ? 'active' : ''}"
                            data-action="filter-target" data-value="${o.value}">${o.label}</button>
                `).join('')}
            </div>
            ${filterSummary}
        </div>
    `;
}

function renderBulkActions(items) {
    if (items.length === 0) return '';
    return `
        <div class="cat-bulk">
            <span class="cat-bulk-label">Visible (${items.length}):</span>
            <button class="cat-bulk-btn" data-action="bulk-owned" title="Mark all visible as Owned">✓ Mark Owned</button>
            <button class="cat-bulk-btn" data-action="bulk-unowned" title="Mark all visible as Unowned">✗ Mark Unowned</button>
            <button class="cat-bulk-btn" data-action="bulk-target" title="Toggle target on all visible">🎯 Toggle Target</button>
        </div>
    `;
}

function renderGrid(items) {
    if (activeTab === 'officers') {
        return items.map(o => renderOfficerCard(o)).join('');
    } else {
        return items.map(s => renderShipCard(s)).join('');
    }
}

function renderOfficerCard(o) {
    const owned = o.ownershipState === 'owned';
    const unowned = o.ownershipState === 'unowned';
    const unknown = o.ownershipState === 'unknown';
    const targeted = o.target;

    return `
        <div class="cat-card ${owned ? 'cat-owned' : ''} ${unowned ? 'cat-unowned' : ''} ${targeted ? 'cat-targeted' : ''}"
             data-id="${esc(o.id)}" tabindex="0" role="row">
            <div class="cat-card-header">
                <span class="cat-card-name">${esc(o.name)}</span>
                ${o.rarity ? `<span class="cat-badge rarity-${(o.rarity || '').toLowerCase()}">${esc(o.rarity)}</span>` : ''}
                ${o.groupName ? `<span class="cat-badge group">${esc(o.groupName)}</span>` : ''}
            </div>
            <div class="cat-card-abilities">
                ${o.captainManeuver ? `<div class="cat-ability"><span class="cat-ability-label">CM:</span> ${esc(o.captainManeuver)}</div>` : ''}
                ${o.officerAbility ? `<div class="cat-ability"><span class="cat-ability-label">OA:</span> ${esc(o.officerAbility)}</div>` : ''}
            </div>
            <div class="cat-card-overlay">
                <button class="cat-own-btn ${owned ? 'active' : ''}" data-action="toggle-owned" data-id="${esc(o.id)}" title="Toggle owned">
                    ${owned ? '✓ Owned' : '✗ Not Owned'}
                </button>
                <button class="cat-target-btn ${targeted ? 'active' : ''}" data-action="toggle-target" data-id="${esc(o.id)}" title="Toggle target">
                    ${targeted ? '🎯 Targeted' : '○ Target'}
                </button>
                ${o.userLevel ? `<span class="cat-user-level">Lv ${o.userLevel}</span>` : ''}
                ${o.userRank ? `<span class="cat-user-rank">${esc(o.userRank)}</span>` : ''}
            </div>
        </div>
    `;
}

function renderShipCard(s) {
    const owned = s.ownershipState === 'owned';
    const unowned = s.ownershipState === 'unowned';
    const targeted = s.target;

    return `
        <div class="cat-card ${owned ? 'cat-owned' : ''} ${unowned ? 'cat-unowned' : ''} ${targeted ? 'cat-targeted' : ''}"
             data-id="${esc(s.id)}" tabindex="0" role="row">
            <div class="cat-card-header">
                <span class="cat-card-name">${esc(s.name)}</span>
                ${s.rarity ? `<span class="cat-badge rarity-${(s.rarity || '').toLowerCase()}">${esc(s.rarity)}</span>` : ''}
                ${s.faction ? `<span class="cat-badge faction">${esc(s.faction)}</span>` : ''}
                ${s.shipClass ? `<span class="cat-badge ship-class">${esc(s.shipClass)}</span>` : ''}
            </div>
            <div class="cat-card-meta">
                ${s.grade ? `<span>Grade ${s.grade}</span>` : ''}
                ${s.tier ? `<span>T${s.tier}</span>` : ''}
            </div>
            <div class="cat-card-overlay">
                <button class="cat-own-btn ${owned ? 'active' : ''}" data-action="toggle-owned" data-id="${esc(s.id)}" title="Toggle owned">
                    ${owned ? '✓ Owned' : '✗ Not Owned'}
                </button>
                <button class="cat-target-btn ${targeted ? 'active' : ''}" data-action="toggle-target" data-id="${esc(s.id)}" title="Toggle target">
                    ${targeted ? '🎯 Targeted' : '○ Target'}
                </button>
                ${s.userTier ? `<span class="cat-user-level">T${s.userTier}</span>` : ''}
                ${s.userLevel ? `<span class="cat-user-level">Lv ${s.userLevel}</span>` : ''}
            </div>
        </div>
    `;
}

function renderEmpty() {
    if (searchQuery || filters.ownership !== 'all' || filters.target !== 'all') {
        return `<div class="cat-empty"><p>No ${activeTab} match your filters.</p>
                <button class="cat-clear-filters" data-action="clear-all-filters">Clear all filters</button></div>`;
    }
    return `<div class="cat-empty">
        <p>No ${activeTab} in the reference catalog yet.</p>
        <p class="hint">Use the <strong>Sync Wiki Data</strong> button above to import from the STFC Fandom Wiki.</p>
    </div>`;
}

function renderUndoBar() {
    const last = undoStack[undoStack.length - 1];
    return `
        <div class="cat-undo-bar">
            <span>Updated ${last.count} ${activeTab}</span>
            <button class="cat-undo-btn" data-action="undo">↩ Undo</button>
        </div>
    `;
}

// ─── Event Binding ──────────────────────────────────────────

let searchDebounce = null;

function bindEvents() {
    const area = $("#catalog-area");
    if (!area) return;

    // Tab switching
    area.querySelectorAll('.cat-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            searchQuery = '';
            letterFilter = '';
            filters = { ownership: 'all', target: 'all', rarity: '', group: '', faction: '', class: '' };
            undoStack = [];
            refresh();
        });
    });

    // Search input with debounce
    const searchInput = area.querySelector('.cat-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            clearTimeout(searchDebounce);
            searchDebounce = setTimeout(() => {
                searchQuery = e.target.value.trim();
                refresh();
            }, 200);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                searchQuery = '';
                searchInput.value = '';
                refresh();
            }
        });
    }

    // Clear search
    area.querySelectorAll('[data-action="clear-search"]').forEach(btn => {
        btn.addEventListener('click', () => {
            searchQuery = '';
            refresh();
            setTimeout(() => {
                const s = area.querySelector('.cat-search');
                if (s) s.focus();
            }, 50);
        });
    });

    // Filter chips
    area.querySelectorAll('[data-action="filter-ownership"]').forEach(btn => {
        btn.addEventListener('click', () => {
            filters.ownership = btn.dataset.value;
            refresh();
        });
    });
    area.querySelectorAll('[data-action="filter-target"]').forEach(btn => {
        btn.addEventListener('click', () => {
            filters.target = btn.dataset.value;
            refresh();
        });
    });

    // Clear all filters
    area.querySelectorAll('[data-action="clear-all-filters"]').forEach(btn => {
        btn.addEventListener('click', () => {
            searchQuery = '';
            letterFilter = '';
            filters = { ownership: 'all', target: 'all', rarity: '', group: '', faction: '', class: '' };
            refresh();
        });
    });

    // Undo
    area.querySelectorAll('[data-action="undo"]').forEach(btn => {
        btn.addEventListener('click', () => performUndo());
    });

    // Sync Wiki Data
    area.querySelectorAll('[data-action="sync-wiki"]').forEach(btn => {
        btn.addEventListener('click', () => performSync());
    });

    // Bind dynamic sub-sections
    bindLetterEvents(area);
    bindBulkEvents(area);
    bindGridEvents(area);
}

/** Bind click events on letter bar buttons */
function bindLetterEvents(area) {
    area.querySelectorAll('[data-action="filter-letter"]').forEach(btn => {
        btn.addEventListener('click', () => {
            letterFilter = btn.dataset.letter;
            render(); // Client-side filter — no server call needed
        });
    });
}

/** Bind click events on bulk action buttons */
function bindBulkEvents(area) {
    area.querySelectorAll('[data-action="bulk-owned"]').forEach(btn => {
        btn.addEventListener('click', () => bulkAction('owned'));
    });
    area.querySelectorAll('[data-action="bulk-unowned"]').forEach(btn => {
        btn.addEventListener('click', () => bulkAction('unowned'));
    });
    area.querySelectorAll('[data-action="bulk-target"]').forEach(btn => {
        btn.addEventListener('click', () => bulkToggleTarget());
    });
}

/** Bind events on grid cards (toggle owned/target, keyboard nav) */
function bindGridEvents(area) {
    // Single item: toggle ownership
    area.querySelectorAll('[data-action="toggle-owned"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const items = activeTab === 'officers' ? officers : ships;
            const item = items.find(i => i.id === id);
            if (!item) return;

            const next = item.ownershipState === 'owned' ? 'unowned' : 'owned';
            const setFn = activeTab === 'officers' ? setOfficerOverlay : setShipOverlay;
            await setFn(id, { ownershipState: next });
            await refresh();
        });
    });

    // Single item: toggle target
    area.querySelectorAll('[data-action="toggle-target"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            const items = activeTab === 'officers' ? officers : ships;
            const item = items.find(i => i.id === id);
            if (!item) return;

            const setFn = activeTab === 'officers' ? setOfficerOverlay : setShipOverlay;
            await setFn(id, { target: !item.target });
            await refresh();
        });
    });

    // Keyboard navigation on cards
    area.querySelectorAll('.cat-card').forEach(card => {
        card.addEventListener('keydown', (e) => {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                const ownBtn = card.querySelector('[data-action="toggle-owned"]');
                if (ownBtn) ownBtn.click();
            } else if (e.key === 't' || e.key === 'T') {
                e.preventDefault();
                const tgtBtn = card.querySelector('[data-action="toggle-target"]');
                if (tgtBtn) tgtBtn.click();
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                const next = card.nextElementSibling;
                if (next?.classList.contains('cat-card')) next.focus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                const prev = card.previousElementSibling;
                if (prev?.classList.contains('cat-card')) prev.focus();
            }
        });
    });
}

// ─── Bulk Operations ────────────────────────────────────────

async function bulkAction(ownershipState) {
    const items = activeTab === 'officers' ? officers : ships;
    if (items.length === 0) return;

    // Save previous states for undo
    const previousStates = items.map(i => ({ id: i.id, ownershipState: i.ownershipState }));
    const refIds = items.map(i => i.id);

    const bulkFn = activeTab === 'officers' ? bulkSetOfficerOverlay : bulkSetShipOverlay;
    await bulkFn(refIds, { ownershipState });

    undoStack.push({ type: 'ownership', refIds, previousStates, count: refIds.length, tab: activeTab });
    await refresh();
}

async function bulkToggleTarget() {
    const items = activeTab === 'officers' ? officers : ships;
    if (items.length === 0) return;

    // If any are not targeted, target them all; otherwise untarget all
    const anyNotTargeted = items.some(i => !i.target);
    const target = anyNotTargeted;

    const previousStates = items.map(i => ({ id: i.id, target: i.target }));
    const refIds = items.map(i => i.id);

    const bulkFn = activeTab === 'officers' ? bulkSetOfficerOverlay : bulkSetShipOverlay;
    await bulkFn(refIds, { target });

    undoStack.push({ type: 'target', refIds, previousStates, count: refIds.length, tab: activeTab });
    await refresh();
}

async function performUndo() {
    if (undoStack.length === 0) return;
    const action = undoStack.pop();

    const bulkFn = action.tab === 'officers' ? bulkSetOfficerOverlay : bulkSetShipOverlay;

    if (action.type === 'ownership') {
        // Restore each item's previous ownership state individually
        // Group by state to minimize API calls
        const byState = {};
        for (const prev of action.previousStates) {
            if (!byState[prev.ownershipState]) byState[prev.ownershipState] = [];
            byState[prev.ownershipState].push(prev.id);
        }
        for (const [state, ids] of Object.entries(byState)) {
            await bulkFn(ids, { ownershipState: state });
        }
    } else if (action.type === 'target') {
        // Restore each item's previous target state
        const targeted = action.previousStates.filter(p => p.target).map(p => p.id);
        const untargeted = action.previousStates.filter(p => !p.target).map(p => p.id);
        if (targeted.length > 0) await bulkFn(targeted, { target: true });
        if (untargeted.length > 0) await bulkFn(untargeted, { target: false });
    }

    await refresh();
}

// ─── Wiki Sync ──────────────────────────────────────────────

async function performSync() {
    if (syncing) return;
    syncing = true;
    render(); // Show syncing state immediately

    try {
        const result = await syncWikiData();
        if (!result.ok) {
            throw new Error(result.error?.message || 'Sync failed');
        }
        const d = result.data;
        const msg = [
            d.officers ? `Officers: ${d.officers.created} new, ${d.officers.updated} updated (${d.officers.parsed} parsed)` : null,
            d.ships ? `Ships: ${d.ships.created} new, ${d.ships.updated} updated (${d.ships.parsed} parsed)` : null,
        ].filter(Boolean).join(' · ');
        showSyncResult(msg, 'success');
    } catch (err) {
        showSyncResult(`Sync failed: ${err.message}`, 'error');
    } finally {
        syncing = false;
        await refresh();
    }
}

function showSyncResult(message, type) {
    const area = $("#catalog-area");
    if (!area) return;

    // Remove any existing toast
    area.querySelectorAll('.cat-sync-toast').forEach(el => el.remove());

    const toast = document.createElement('div');
    toast.className = `cat-sync-toast cat-sync-${type}`;
    toast.textContent = message;
    area.prepend(toast);

    setTimeout(() => toast.classList.add('visible'), 10);
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 6000);
}

// ─── Helpers ────────────────────────────────────────────────

function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
