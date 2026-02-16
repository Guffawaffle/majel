/**
 * crews.js — Crews: Composition Workshop (ADR-025 Phase 4)
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Full crew composition management:
 * - Bridge Cores: named officer trios (captain/bridge_1/bridge_2)
 * - Loadouts: ship + core + policy + intents, with inline variants
 * - Policies: below-deck fill rules (stats_then_bda, pinned_only, stat_fill_only)
 * - Reservations: officer locks (soft/hard) for conflict prevention
 *
 * @module  views/crews
 * @layer   view
 * @domain  crews
 * @depends api/crews, api/catalog, utils/escape, router, components/confirm-dialog
 */

import {
    fetchBridgeCores, createBridgeCore, updateBridgeCore, deleteBridgeCore, setBridgeCoreMembers,
    fetchBelowDeckPolicies, createBelowDeckPolicy, updateBelowDeckPolicy, deleteBelowDeckPolicy,
    fetchCrewLoadouts, createCrewLoadout, updateCrewLoadout, deleteCrewLoadout,
    fetchVariants, createVariant, updateVariant, deleteVariant,
    fetchReservations, setReservation, deleteReservation,
} from 'api/crews.js';
import { fetchCatalogOfficers, fetchCatalogShips } from 'api/catalog.js';
import { esc } from 'utils/escape.js';
import { registerView } from 'router';
import { showConfirmDialog } from 'components/confirm-dialog.js';

// ─── Constants ──────────────────────────────────────────────

const SLOT_NAMES = { captain: 'Captain', bridge_1: 'Bridge 1', bridge_2: 'Bridge 2' };
const MODE_LABELS = {
    stats_then_bda: 'Stats → BDA',
    pinned_only: 'Pinned Only',
    stat_fill_only: 'Stats Fill Only',
};

const INTENT_CATALOG = [
    { key: 'general', label: 'General', icon: '⚙️', category: 'utility' },
    { key: 'mining-gas', label: 'Gas Mining', icon: '⛽', category: 'mining' },
    { key: 'mining-crystal', label: 'Crystal Mining', icon: '💎', category: 'mining' },
    { key: 'mining-ore', label: 'Ore Mining', icon: '⛏️', category: 'mining' },
    { key: 'mining-tri', label: 'Tritanium', icon: '🔩', category: 'mining' },
    { key: 'mining-dil', label: 'Dilithium', icon: '🔮', category: 'mining' },
    { key: 'mining-para', label: 'Parasteel', icon: '🛡️', category: 'mining' },
    { key: 'mining-lat', label: 'Latinum', icon: '💰', category: 'mining' },
    { key: 'mining-iso', label: 'Isogen', icon: '☢️', category: 'mining' },
    { key: 'mining-data', label: 'Data', icon: '📊', category: 'mining' },
    { key: 'grinding', label: 'Hostile Grinding', icon: '⚔️', category: 'combat' },
    { key: 'grinding-swarm', label: 'Swarm', icon: '🐝', category: 'combat' },
    { key: 'grinding-eclipse', label: 'Eclipse', icon: '🌑', category: 'combat' },
    { key: 'armada', label: 'Armada', icon: '🎯', category: 'combat' },
    { key: 'armada-solo', label: 'Solo Armada', icon: '🎯', category: 'combat' },
    { key: 'pvp', label: 'PvP/Raiding', icon: '💀', category: 'combat' },
    { key: 'base-defense', label: 'Base Defense', icon: '🏰', category: 'combat' },
    { key: 'exploration', label: 'Exploration', icon: '🔭', category: 'utility' },
    { key: 'cargo-run', label: 'Cargo Run', icon: '📦', category: 'utility' },
    { key: 'events', label: 'Events', icon: '🎪', category: 'utility' },
    { key: 'voyages', label: 'Voyages', icon: '🚀', category: 'utility' },
    { key: 'away-team', label: 'Away Team', icon: '🖖', category: 'utility' },
];

// ─── State ──────────────────────────────────────────────────

let bridgeCores = [];
let belowDeckPolicies = [];
let loadouts = [];
let reservations = [];
let officers = [];
let ships = [];
let activeTab = 'cores';  // 'cores' | 'loadouts' | 'policies' | 'reservations'
let loading = false;
let formError = '';

// Editing state
let editingCoreId = null;      // core id or 'new'
let editingLoadoutId = null;   // loadout id or 'new'
let editingPolicyId = null;    // policy id or 'new'
let editingReservation = null; // officer id or 'new'
let expandedLoadoutId = null;  // loadout id whose variants are shown
let editingVariantId = null;   // variant id or 'new'
let loadoutVariants = {};      // { loadoutId: variant[] }

const $ = (sel) => document.querySelector(sel);

// ─── View Registration ─────────────────────────────────────

registerView('crews', {
    area: $('#crews-area'),
    icon: '⚓', title: 'Crews', subtitle: 'Composition workshop — cores, loadouts, policies & reservations',
    cssHref: 'views/crews/crews.css',
    init, refresh,
});

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $('#crews-area');
    if (!area) return;
}

export async function refresh() {
    if (loading) return;
    loading = true;
    try {
        const [coresData, policiesData, loadoutsData, reservationsData, officerData, shipData] = await Promise.all([
            fetchBridgeCores(),
            fetchBelowDeckPolicies(),
            fetchCrewLoadouts(),
            fetchReservations(),
            fetchCatalogOfficers({ ownership: 'owned' }),
            fetchCatalogShips(),
        ]);
        bridgeCores = coresData?.bridgeCores ?? coresData ?? [];
        belowDeckPolicies = policiesData?.belowDeckPolicies ?? policiesData ?? [];
        loadouts = loadoutsData?.loadouts ?? loadoutsData ?? [];
        reservations = reservationsData?.reservations ?? reservationsData ?? [];
        officers = Array.isArray(officerData) ? officerData : (officerData?.officers ?? []);
        ships = Array.isArray(shipData) ? shipData : (shipData?.ships ?? []);
        render();
    } catch (err) {
        console.error('Crews refresh failed:', err);
        const area = $('#crews-area');
        if (area) area.innerHTML = `<div class="crews-error">Failed to load crews: ${esc(err.message)}</div>`;
    } finally {
        loading = false;
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $('#crews-area');
    if (!area) return;

    area.innerHTML = `
        ${renderTabBar()}
        <div class="crews-content">
            ${activeTab === 'cores' ? renderCoresTab() : ''}
            ${activeTab === 'loadouts' ? renderLoadoutsTab() : ''}
            ${activeTab === 'policies' ? renderPoliciesTab() : ''}
            ${activeTab === 'reservations' ? renderReservationsTab() : ''}
        </div>
    `;
    bindEvents();
}

function renderTabBar() {
    return `
        <div class="crews-tabs">
            <button class="crews-tab ${activeTab === 'cores' ? 'active' : ''}" data-tab="cores">
                Bridge Cores <span class="crews-tab-count">${bridgeCores.length}</span>
            </button>
            <button class="crews-tab ${activeTab === 'loadouts' ? 'active' : ''}" data-tab="loadouts">
                Loadouts <span class="crews-tab-count">${loadouts.length}</span>
            </button>
            <button class="crews-tab ${activeTab === 'policies' ? 'active' : ''}" data-tab="policies">
                Policies <span class="crews-tab-count">${belowDeckPolicies.length}</span>
            </button>
            <button class="crews-tab ${activeTab === 'reservations' ? 'active' : ''}" data-tab="reservations">
                Reservations <span class="crews-tab-count">${reservations.length}</span>
            </button>
        </div>
    `;
}

function renderEmpty(msg) {
    return `<div class="crews-empty"><p>${esc(msg)}</p></div>`;
}

// ═══════════════════════════════════════════════════════════
// BRIDGE CORES TAB
// ═══════════════════════════════════════════════════════════

function renderCoresTab() {
    return `
        <div class="crews-section">
            <div class="crews-toolbar">
                <h3 class="crews-toolbar-title">Bridge Cores</h3>
                <button class="crews-create-btn" data-action="create-core">+ New Core</button>
            </div>
            ${editingCoreId === 'new' ? renderCoreForm(null) : ''}
            <div class="crews-list">
                ${bridgeCores.length === 0
            ? renderEmpty('No bridge cores yet. Create one to assign captain and bridge officer trios.')
            : bridgeCores.map(c => renderCoreCard(c)).join('')}
            </div>
        </div>
    `;
}

function coreUsedIn(coreId) {
    return loadouts.filter(l => l.bridgeCoreId === coreId);
}

function renderCoreCard(core) {
    if (editingCoreId === core.id) return renderCoreForm(core);

    const membersBySlot = {};
    for (const m of core.members || []) {
        membersBySlot[m.slot] = m.officerId;
    }

    const slotsHtml = ['captain', 'bridge_1', 'bridge_2']
        .filter(slot => membersBySlot[slot])
        .map(slot => {
            const off = officerById(membersBySlot[slot]);
            const display = off ? `${esc(off.name)} (L${off.userLevel || '?'})` : esc(membersBySlot[slot]);
            return `<div class="crews-slot">
                <span class="crews-slot-label">${SLOT_NAMES[slot]}</span>
                <span class="crews-slot-value">${display}</span>
            </div>`;
        }).join('');

    const usedIn = coreUsedIn(core.id);
    const usedInHtml = usedIn.length > 0
        ? `<div class="crews-xref">
            <span class="crews-xref-label">Used in:</span>
            ${usedIn.map(l => `<span class="crews-xref-chip">${esc(l.name)}</span>`).join('')}
           </div>`
        : '';

    return `
        <div class="crews-card" data-id="${core.id}">
            <div class="crews-card-header">
                <div class="crews-card-title">
                    <span class="crews-card-name">${esc(core.name)}</span>
                    <span class="crews-card-count">${(core.members || []).length}/3 slots</span>
                </div>
                <div class="crews-card-actions">
                    <button class="crews-action-btn" data-action="edit-core" data-id="${core.id}" title="Edit">✎</button>
                    <button class="crews-action-btn crews-action-danger" data-action="delete-core" data-id="${core.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crews-card-body">
                ${slotsHtml || '<div class="crews-muted">No officers assigned</div>'}
            </div>
            ${usedInHtml}
            ${core.notes ? `<div class="crews-card-notes">${esc(core.notes)}</div>` : ''}
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

    const slotInputs = ['captain', 'bridge_1', 'bridge_2']
        .map(slot => `
        <label class="crews-form-field">
            <span class="crews-form-label">${SLOT_NAMES[slot]}</span>
            <select class="crews-form-select" data-form-field="slot_${slot}">
                <option value="">— Select officer —</option>
                ${officers.map(off => `<option value="${esc(off.id)}" ${membersBySlot[slot] === off.id ? 'selected' : ''}>${esc(off.name)} (L${off.userLevel || '?'})</option>`).join('')}
            </select>
        </label>
        `).join('');

    return `
        <div class="crews-form" data-form-id="${isNew ? 'new' : c.id}">
            <div class="crews-form-header">
                <h3>${isNew ? 'Create Bridge Core' : `Edit: ${esc(c.name)}`}</h3>
                <button class="crews-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crews-form-error">${esc(formError)}</div>` : ''}
            <div class="crews-form-grid">
                <label class="crews-form-field">
                    <span class="crews-form-label">Name *</span>
                    <input type="text" class="crews-form-input" data-form-field="name"
                           value="${esc(c.name)}" placeholder="e.g. Kirk Trio" maxlength="100" required />
                </label>
                ${slotInputs}
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Notes</span>
                    <textarea class="crews-form-input crews-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(c.notes || '')}</textarea>
                </label>
            </div>
            <div class="crews-form-actions">
                <button class="crews-btn crews-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crews-btn crews-btn-primary" data-action="save-core">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// LOADOUTS TAB
// ═══════════════════════════════════════════════════════════

function renderLoadoutsTab() {
    return `
        <div class="crews-section">
            <div class="crews-toolbar">
                <h3 class="crews-toolbar-title">Crew Loadouts</h3>
                <button class="crews-create-btn" data-action="create-loadout">+ New Loadout</button>
            </div>
            ${editingLoadoutId === 'new' ? renderLoadoutForm(null) : ''}
            <div class="crews-list">
                ${loadouts.length === 0
            ? renderEmpty('No crew loadouts yet. Create one to combine a ship, bridge core, policy and intents.')
            : loadouts.map(l => renderLoadoutCard(l)).join('')}
            </div>
        </div>
    `;
}

function renderLoadoutCard(loadout) {
    if (editingLoadoutId === loadout.id) return renderLoadoutForm(loadout);

    const coreName = getBridgeCoreName(loadout.bridgeCoreId) || '—';
    const policyName = getPolicyName(loadout.belowDeckPolicyId) || '—';
    const shipName = getShipName(loadout.shipId) || loadout.shipId || '—';
    const intents = (loadout.intentKeys || []);
    const tags = (loadout.tags || []);
    const isExpanded = expandedLoadoutId === loadout.id;
    const variants = loadoutVariants[loadout.id] || [];

    const intentChips = intents.length > 0
        ? intents.map(k => {
            const intent = INTENT_CATALOG.find(i => i.key === k);
            return `<span class="crews-intent-chip" title="${esc(k)}">${intent ? intent.icon : '⚙️'} ${esc(intent ? intent.label : k)}</span>`;
        }).join('')
        : '<span class="crews-muted">None</span>';

    const tagChips = tags.length > 0
        ? tags.map(t => `<span class="crews-tag-chip">${esc(t)}</span>`).join('')
        : '';

    return `
        <div class="crews-card ${loadout.isActive ? 'crews-card-active' : ''}" data-id="${loadout.id}">
            <div class="crews-card-header">
                <div class="crews-card-title">
                    <span class="crews-card-name">${esc(loadout.name)}</span>
                    ${loadout.isActive ? '<span class="crews-badge crews-badge-active">Active</span>' : ''}
                    ${loadout.priority ? `<span class="crews-badge crews-badge-priority">P${loadout.priority}</span>` : ''}
                </div>
                <div class="crews-card-actions">
                    <button class="crews-action-btn" data-action="toggle-variants" data-id="${loadout.id}" title="${isExpanded ? 'Collapse' : 'Expand variants'}">${isExpanded ? '▾' : '▸'}</button>
                    <button class="crews-action-btn" data-action="edit-loadout" data-id="${loadout.id}" title="Edit">✎</button>
                    <button class="crews-action-btn crews-action-danger" data-action="delete-loadout" data-id="${loadout.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crews-card-body">
                <div class="crews-row"><span class="crews-label">Ship</span> <span class="crews-value">${esc(shipName)}</span></div>
                <div class="crews-row"><span class="crews-label">Bridge Core</span> <span class="crews-value">${esc(coreName)}</span></div>
                <div class="crews-row"><span class="crews-label">Below Deck</span> <span class="crews-value">${esc(policyName)}</span></div>
                <div class="crews-row"><span class="crews-label">Intents</span> <div class="crews-intent-list">${intentChips}</div></div>
                ${tagChips ? `<div class="crews-row"><span class="crews-label">Tags</span> <div class="crews-tag-list">${tagChips}</div></div>` : ''}
            </div>
            ${loadout.notes ? `<div class="crews-card-notes">${esc(loadout.notes)}</div>` : ''}
            ${isExpanded ? renderVariantSection(loadout.id, variants) : ''}
        </div>
    `;
}

function renderVariantSection(loadoutId, variants) {
    return `
        <div class="crews-variant-section" data-loadout-id="${loadoutId}">
            <div class="crews-variant-header">
                <h4 class="crews-variant-title">Variants (${variants.length})</h4>
                <button class="crews-create-btn crews-create-btn-sm" data-action="create-variant" data-loadout="${loadoutId}">+ Add Variant</button>
            </div>
            ${editingVariantId === 'new' ? renderVariantForm(loadoutId, null) : ''}
            <div class="crews-variant-list">
                ${variants.length === 0
            ? '<div class="crews-muted crews-variant-empty">No variants. Variants let you patch bridge or policy for specific scenarios.</div>'
            : variants.map(v => renderVariantCard(loadoutId, v)).join('')}
            </div>
        </div>
    `;
}

function renderVariantCard(loadoutId, variant) {
    if (editingVariantId === variant.id) return renderVariantForm(loadoutId, variant);

    const patchSummary = describePatch(variant.patch);
    return `
        <div class="crews-variant-card" data-variant-id="${variant.id}">
            <div class="crews-variant-card-header">
                <span class="crews-variant-name">${esc(variant.name)}</span>
                <div class="crews-card-actions">
                    <button class="crews-action-btn" data-action="edit-variant" data-id="${variant.id}" data-loadout="${loadoutId}" title="Edit">✎</button>
                    <button class="crews-action-btn crews-action-danger" data-action="delete-variant" data-id="${variant.id}" data-loadout="${loadoutId}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crews-variant-body">
                ${patchSummary ? `<div class="crews-patch-summary">${patchSummary}</div>` : '<div class="crews-muted">No patches</div>'}
            </div>
            ${variant.notes ? `<div class="crews-card-notes">${esc(variant.notes)}</div>` : ''}
        </div>
    `;
}

function describePatch(patch) {
    if (!patch) return '';
    const parts = [];
    if (patch.bridge) {
        for (const [slot, officerId] of Object.entries(patch.bridge)) {
            const off = officerById(officerId);
            const name = off ? off.name : officerId;
            parts.push(`<span class="crews-patch-item">${esc(SLOT_NAMES[slot] || slot)} → ${esc(name)}</span>`);
        }
    }
    if (patch.below_deck_policy_id != null) {
        const pName = getPolicyName(patch.below_deck_policy_id) || `#${patch.below_deck_policy_id}`;
        parts.push(`<span class="crews-patch-item">Policy → ${esc(pName)}</span>`);
    }
    if (patch.intent_keys && patch.intent_keys.length > 0) {
        parts.push(`<span class="crews-patch-item">Intents → ${patch.intent_keys.map(k => esc(k)).join(', ')}</span>`);
    }
    return parts.join(' · ');
}

function renderVariantForm(loadoutId, variant) {
    const isNew = !variant;
    const v = variant || { name: '', patch: {}, notes: '' };
    const patch = v.patch || {};
    const bridgePatch = patch.bridge || {};

    return `
        <div class="crews-form crews-variant-form" data-form-id="${isNew ? 'new' : v.id}" data-loadout="${loadoutId}">
            <div class="crews-form-header">
                <h3>${isNew ? 'Create Variant' : `Edit: ${esc(v.name)}`}</h3>
                <button class="crews-action-btn" data-action="cancel-variant" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crews-form-error">${esc(formError)}</div>` : ''}
            <div class="crews-form-grid">
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Name *</span>
                    <input type="text" class="crews-form-input" data-form-field="name"
                           value="${esc(v.name)}" placeholder="e.g. Swap McCoy for T'Laan" maxlength="100" required />
                </label>
                ${['captain', 'bridge_1', 'bridge_2'].map(slot => `
                <label class="crews-form-field">
                    <span class="crews-form-label">${SLOT_NAMES[slot]} (patch)</span>
                    <select class="crews-form-select" data-form-field="patch_${slot}">
                        <option value="">— No change —</option>
                        ${officers.map(off => `<option value="${esc(off.id)}" ${bridgePatch[slot] === off.id ? 'selected' : ''}>${esc(off.name)}</option>`).join('')}
                    </select>
                </label>
                `).join('')}
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Policy Override</span>
                    <select class="crews-form-select" data-form-field="patch_policy">
                        <option value="">— No change —</option>
                        ${belowDeckPolicies.map(p => `<option value="${p.id}" ${patch.below_deck_policy_id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Notes</span>
                    <textarea class="crews-form-input crews-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(v.notes || '')}</textarea>
                </label>
            </div>
            <div class="crews-form-actions">
                <button class="crews-btn crews-btn-secondary" data-action="cancel-variant">Cancel</button>
                <button class="crews-btn crews-btn-primary" data-action="save-variant" data-loadout="${loadoutId}">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

function renderLoadoutForm(loadout) {
    const isNew = !loadout;
    const l = loadout || { name: '', shipId: '', bridgeCoreId: null, belowDeckPolicyId: null, intentKeys: [], tags: [], priority: 0, isActive: false, notes: '' };
    const selectedIntents = l.intentKeys || [];
    const selectedTags = (l.tags || []).join(', ');

    return `
        <div class="crews-form" data-form-id="${isNew ? 'new' : l.id}">
            <div class="crews-form-header">
                <h3>${isNew ? 'Create Loadout' : `Edit: ${esc(l.name)}`}</h3>
                <button class="crews-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crews-form-error">${esc(formError)}</div>` : ''}
            <div class="crews-form-grid">
                <label class="crews-form-field">
                    <span class="crews-form-label">Name *</span>
                    <input type="text" class="crews-form-input" data-form-field="name"
                           value="${esc(l.name)}" placeholder="e.g. Kumari Grinder" maxlength="100" required />
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Ship</span>
                    <select class="crews-form-select" data-form-field="shipId">
                        <option value="">— Select ship —</option>
                        ${ships.map(s => `<option value="${esc(s.id)}" ${l.shipId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Bridge Core</span>
                    <select class="crews-form-select" data-form-field="bridgeCoreId">
                        <option value="">— Select core —</option>
                        ${bridgeCores.map(c => `<option value="${c.id}" ${l.bridgeCoreId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Below Deck Policy</span>
                    <select class="crews-form-select" data-form-field="belowDeckPolicyId">
                        <option value="">— Select policy —</option>
                        ${belowDeckPolicies.map(p => `<option value="${p.id}" ${l.belowDeckPolicyId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
                    </select>
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Priority</span>
                    <input type="number" class="crews-form-input" data-form-field="priority"
                           value="${l.priority || 0}" min="0" max="99" />
                </label>
                <label class="crews-form-field crews-form-checkbox-field">
                    <input type="checkbox" data-form-field="isActive" ${l.isActive ? 'checked' : ''} />
                    <span class="crews-form-label">Active</span>
                </label>
                <fieldset class="crews-form-field crews-form-wide crews-intent-fieldset">
                    <legend class="crews-form-label">Intents</legend>
                    <div class="crews-intent-grid">
                        ${INTENT_CATALOG.map(intent => `
                            <label class="crews-intent-option">
                                <input type="checkbox" data-intent-key="${esc(intent.key)}" ${selectedIntents.includes(intent.key) ? 'checked' : ''} />
                                <span>${intent.icon} ${esc(intent.label)}</span>
                            </label>
                        `).join('')}
                    </div>
                </fieldset>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Tags <span class="crews-hint">(comma-separated)</span></span>
                    <input type="text" class="crews-form-input" data-form-field="tags"
                           value="${esc(selectedTags)}" placeholder="e.g. pvp, armada, daily" maxlength="200" />
                </label>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Notes</span>
                    <textarea class="crews-form-input crews-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(l.notes || '')}</textarea>
                </label>
            </div>
            <div class="crews-form-actions">
                <button class="crews-btn crews-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crews-btn crews-btn-primary" data-action="save-loadout">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// POLICIES TAB
// ═══════════════════════════════════════════════════════════

function renderPoliciesTab() {
    return `
        <div class="crews-section">
            <div class="crews-toolbar">
                <h3 class="crews-toolbar-title">Below Deck Policies</h3>
                <button class="crews-create-btn" data-action="create-policy">+ New Policy</button>
            </div>
            ${editingPolicyId === 'new' ? renderPolicyForm(null) : ''}
            <div class="crews-list">
                ${belowDeckPolicies.length === 0
            ? renderEmpty('No below deck policies yet. Create one to control below-deck auto-fill behavior.')
            : belowDeckPolicies.map(p => renderPolicyCard(p)).join('')}
            </div>
        </div>
    `;
}

function policyUsedIn(policyId) {
    return loadouts.filter(l => l.belowDeckPolicyId === policyId);
}

function renderPolicyCard(policy) {
    if (editingPolicyId === policy.id) return renderPolicyForm(policy);

    const spec = policy.spec || {};
    const pinned = Array.isArray(spec.pinned) ? spec.pinned : [];
    const pinnedNames = pinned.map(id => {
        const off = officerById(id);
        return off ? off.name : id;
    });

    const usedIn = policyUsedIn(policy.id);
    const usedInHtml = usedIn.length > 0
        ? `<div class="crews-xref">
            <span class="crews-xref-label">Used in:</span>
            ${usedIn.map(l => `<span class="crews-xref-chip">${esc(l.name)}</span>`).join('')}
           </div>`
        : '';

    return `
        <div class="crews-card" data-id="${policy.id}">
            <div class="crews-card-header">
                <div class="crews-card-title">
                    <span class="crews-card-name">${esc(policy.name)}</span>
                    <span class="crews-badge crews-badge-mode">${esc(MODE_LABELS[policy.mode] || policy.mode)}</span>
                </div>
                <div class="crews-card-actions">
                    <button class="crews-action-btn" data-action="edit-policy" data-id="${policy.id}" title="Edit">✎</button>
                    <button class="crews-action-btn crews-action-danger" data-action="delete-policy" data-id="${policy.id}" title="Delete">✕</button>
                </div>
            </div>
            <div class="crews-card-body">
                <div class="crews-row">
                    <span class="crews-label">Mode</span>
                    <span class="crews-value">${esc(MODE_LABELS[policy.mode] || policy.mode)}</span>
                </div>
                ${pinned.length > 0 ? `
                <div class="crews-row">
                    <span class="crews-label">Pinned (${pinned.length})</span>
                    <span class="crews-value">${pinnedNames.map(n => esc(n)).join(', ')}</span>
                </div>` : ''}
                ${spec.prefer_modifiers ? `
                <div class="crews-row">
                    <span class="crews-label">Prefer Modifiers</span>
                    <span class="crews-value">${esc(JSON.stringify(spec.prefer_modifiers))}</span>
                </div>` : ''}
                ${spec.max_slots != null ? `
                <div class="crews-row">
                    <span class="crews-label">Max Slots</span>
                    <span class="crews-value">${spec.max_slots}</span>
                </div>` : ''}
            </div>
            ${usedInHtml}
            ${policy.notes ? `<div class="crews-card-notes">${esc(policy.notes)}</div>` : ''}
        </div>
    `;
}

function renderPolicyForm(policy) {
    const isNew = !policy;
    const p = policy || { name: '', mode: 'stats_then_bda', spec: {}, notes: '' };
    const spec = p.spec || {};
    const pinned = Array.isArray(spec.pinned) ? spec.pinned : [];

    return `
        <div class="crews-form" data-form-id="${isNew ? 'new' : p.id}">
            <div class="crews-form-header">
                <h3>${isNew ? 'Create Below Deck Policy' : `Edit: ${esc(p.name)}`}</h3>
                <button class="crews-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crews-form-error">${esc(formError)}</div>` : ''}
            <div class="crews-form-grid">
                <label class="crews-form-field">
                    <span class="crews-form-label">Name *</span>
                    <input type="text" class="crews-form-input" data-form-field="name"
                           value="${esc(p.name)}" placeholder="e.g. Combat BD" maxlength="100" required />
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Mode *</span>
                    <select class="crews-form-select" data-form-field="mode" required>
                        <option value="stats_then_bda" ${p.mode === 'stats_then_bda' ? 'selected' : ''}>Stats then BDA</option>
                        <option value="pinned_only" ${p.mode === 'pinned_only' ? 'selected' : ''}>Pinned Only</option>
                        <option value="stat_fill_only" ${p.mode === 'stat_fill_only' ? 'selected' : ''}>Stats Fill Only</option>
                    </select>
                </label>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Pinned Officers <span class="crews-hint">(hold Ctrl/Cmd to multi-select)</span></span>
                    <select class="crews-form-select crews-form-multi" data-form-field="pinned" multiple size="5">
                        ${officers.map(off =>
        `<option value="${esc(off.id)}" ${pinned.includes(off.id) ? 'selected' : ''}>${esc(off.name)} (L${off.userLevel || '?'})</option>`
    ).join('')}
                    </select>
                </label>
                <label class="crews-form-field">
                    <span class="crews-form-label">Max Slots</span>
                    <input type="number" class="crews-form-input" data-form-field="maxSlots"
                           value="${spec.max_slots ?? ''}" min="1" max="20" placeholder="Leave empty for no limit" />
                </label>
                <label class="crews-form-field crews-form-wide crews-form-checkbox-field">
                    <input type="checkbox" data-form-field="avoidReserved" ${spec.avoid_reserved ? 'checked' : ''} />
                    <span class="crews-form-label">Avoid reserved officers</span>
                </label>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Notes</span>
                    <textarea class="crews-form-input crews-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(p.notes || '')}</textarea>
                </label>
            </div>
            <div class="crews-form-actions">
                <button class="crews-btn crews-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crews-btn crews-btn-primary" data-action="save-policy">${isNew ? 'Create' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// RESERVATIONS TAB
// ═══════════════════════════════════════════════════════════

function renderReservationsTab() {
    return `
        <div class="crews-section">
            <div class="crews-toolbar">
                <h3 class="crews-toolbar-title">Officer Reservations</h3>
                <button class="crews-create-btn" data-action="create-reservation">+ Reserve Officer</button>
            </div>
            ${editingReservation === 'new' ? renderReservationForm(null) : ''}
            <div class="crews-list">
                ${reservations.length === 0
            ? renderEmpty('No officer reservations. Reserve officers to prevent accidental assignment conflicts.')
            : reservations.map(r => renderReservationRow(r)).join('')}
            </div>
        </div>
    `;
}

function renderReservationRow(res) {
    if (editingReservation === res.officerId) return renderReservationForm(res);

    const off = officerById(res.officerId);
    const name = off ? off.name : res.officerId;
    const lockIcon = res.locked ? '🔒' : '🔓';
    const lockLabel = res.locked ? 'Hard lock' : 'Soft lock';

    return `
        <div class="crews-reservation-row" data-officer-id="${esc(res.officerId)}">
            <div class="crews-reservation-info">
                <span class="crews-reservation-name">${esc(name)}</span>
                <span class="crews-reservation-for">${esc(res.reservedFor || '—')}</span>
                <span class="crews-reservation-lock" title="${lockLabel}">${lockIcon}</span>
            </div>
            <div class="crews-card-actions">
                <button class="crews-action-btn" data-action="toggle-lock" data-officer="${esc(res.officerId)}" title="Toggle lock">
                    ${res.locked ? '🔓 Unlock' : '🔒 Lock'}
                </button>
                <button class="crews-action-btn" data-action="edit-reservation" data-officer="${esc(res.officerId)}" title="Edit">✎</button>
                <button class="crews-action-btn crews-action-danger" data-action="delete-reservation" data-officer="${esc(res.officerId)}" title="Remove">✕</button>
            </div>
        </div>
    `;
}

function renderReservationForm(res) {
    const isNew = !res;
    const r = res || { officerId: '', reservedFor: '', locked: false, notes: '' };

    return `
        <div class="crews-form" data-form-id="${isNew ? 'new' : r.officerId}">
            <div class="crews-form-header">
                <h3>${isNew ? 'Reserve Officer' : `Edit Reservation`}</h3>
                <button class="crews-action-btn" data-action="cancel-form" title="Cancel">✕</button>
            </div>
            ${formError ? `<div class="crews-form-error">${esc(formError)}</div>` : ''}
            <div class="crews-form-grid">
                ${isNew ? `
                <label class="crews-form-field">
                    <span class="crews-form-label">Officer *</span>
                    <select class="crews-form-select" data-form-field="officerId" required>
                        <option value="">— Select officer —</option>
                        ${officers
        .filter(off => !reservations.some(rv => rv.officerId === off.id))
        .map(off => `<option value="${esc(off.id)}">${esc(off.name)} (L${off.userLevel || '?'})</option>`)
        .join('')}
                    </select>
                </label>` : `
                <div class="crews-form-field">
                    <span class="crews-form-label">Officer</span>
                    <div class="crews-form-static">${esc(officerById(r.officerId)?.name || r.officerId)}</div>
                </div>`}
                <label class="crews-form-field">
                    <span class="crews-form-label">Reserved For *</span>
                    <input type="text" class="crews-form-input" data-form-field="reservedFor"
                           value="${esc(r.reservedFor || '')}" placeholder="e.g. Swarm Grinding, PvP" maxlength="100" required />
                </label>
                <label class="crews-form-field crews-form-checkbox-field">
                    <input type="checkbox" data-form-field="locked" ${r.locked ? 'checked' : ''} />
                    <span class="crews-form-label">Hard lock (🔒 prevent all reassignment)</span>
                </label>
                <label class="crews-form-field crews-form-wide">
                    <span class="crews-form-label">Notes</span>
                    <textarea class="crews-form-input crews-form-textarea" data-form-field="notes"
                              maxlength="500" placeholder="Optional notes…">${esc(r.notes || '')}</textarea>
                </label>
            </div>
            <div class="crews-form-actions">
                <button class="crews-btn crews-btn-secondary" data-action="cancel-form">Cancel</button>
                <button class="crews-btn crews-btn-primary" data-action="save-reservation">${isNew ? 'Reserve' : 'Save'}</button>
            </div>
        </div>
    `;
}

// ═══════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════

function bindEvents() {
    const area = $('#crews-area');
    if (!area) return;

    // ─── Tab switching ──────────────────────────────────────
    area.querySelectorAll('.crews-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeTab = btn.dataset.tab;
            editingCoreId = null;
            editingLoadoutId = null;
            editingPolicyId = null;
            editingReservation = null;
            editingVariantId = null;
            formError = '';
            render();
        });
    });

    // ─── Bridge Cores ───────────────────────────────────────

    bindAction('create-core', () => {
        editingCoreId = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-core"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingCoreId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-core"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const core = bridgeCores.find(c => c.id === id);
            if (!core) return;
            const usedIn = coreUsedIn(id);
            const confirmed = await showConfirmDialog({
                title: `Delete bridge core "${core.name}"?`,
                subtitle: 'This action cannot be undone.',
                sections: usedIn.length > 0 ? [{ label: 'Used by loadouts', items: usedIn.map(l => l.name) }] : [],
                severity: usedIn.length > 0 ? 'warning' : 'info',
            });
            if (!confirmed) return;
            try {
                await deleteBridgeCore(id);
                bridgeCores = bridgeCores.filter(c => c.id !== id);
                render();
            } catch (err) {
                console.error('Delete core failed:', err);
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    bindAction('save-core', () => handleSaveCore());

    // ─── Loadouts ───────────────────────────────────────────

    bindAction('create-loadout', () => {
        editingLoadoutId = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-loadout"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingLoadoutId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-loadout"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const lo = loadouts.find(l => l.id === id);
            if (!lo) return;
            const confirmed = await showConfirmDialog({
                title: `Delete loadout "${lo.name}"?`,
                subtitle: 'This will also delete all variants.',
                severity: 'warning',
            });
            if (!confirmed) return;
            try {
                await deleteCrewLoadout(id);
                loadouts = loadouts.filter(l => l.id !== id);
                delete loadoutVariants[id];
                render();
            } catch (err) {
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    bindAction('save-loadout', () => handleSaveLoadout());

    // Toggle variants
    area.querySelectorAll('[data-action="toggle-variants"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            if (expandedLoadoutId === id) {
                expandedLoadoutId = null;
                editingVariantId = null;
            } else {
                expandedLoadoutId = id;
                editingVariantId = null;
                // Lazy-load variants
                if (!loadoutVariants[id]) {
                    try {
                        const data = await fetchVariants(id);
                        loadoutVariants[id] = data?.variants ?? data ?? [];
                    } catch (err) {
                        console.error('Failed to load variants:', err);
                        loadoutVariants[id] = [];
                    }
                }
            }
            render();
        });
    });

    // ─── Variants ───────────────────────────────────────────

    area.querySelectorAll('[data-action="create-variant"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingVariantId = 'new';
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="edit-variant"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingVariantId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-variant"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const loadoutId = parseInt(btn.dataset.loadout, 10);
            const confirmed = await showConfirmDialog({
                title: 'Delete this variant?',
                subtitle: 'This action cannot be undone.',
                severity: 'info',
            });
            if (!confirmed) return;
            try {
                await deleteVariant(id);
                if (loadoutVariants[loadoutId]) {
                    loadoutVariants[loadoutId] = loadoutVariants[loadoutId].filter(v => v.id !== id);
                }
                render();
            } catch (err) {
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    area.querySelectorAll('[data-action="save-variant"]').forEach(btn => {
        btn.addEventListener('click', () => {
            const loadoutId = parseInt(btn.dataset.loadout, 10);
            handleSaveVariant(loadoutId);
        });
    });

    area.querySelectorAll('[data-action="cancel-variant"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingVariantId = null;
            formError = '';
            render();
        });
    });

    // ─── Policies ───────────────────────────────────────────

    bindAction('create-policy', () => {
        editingPolicyId = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-policy"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingPolicyId = parseInt(btn.dataset.id, 10);
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="delete-policy"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = parseInt(btn.dataset.id, 10);
            const policy = belowDeckPolicies.find(p => p.id === id);
            if (!policy) return;
            const usedIn = policyUsedIn(id);
            const confirmed = await showConfirmDialog({
                title: `Delete policy "${policy.name}"?`,
                subtitle: 'This action cannot be undone.',
                sections: usedIn.length > 0 ? [{ label: 'Used by loadouts', items: usedIn.map(l => l.name) }] : [],
                severity: usedIn.length > 0 ? 'warning' : 'info',
            });
            if (!confirmed) return;
            try {
                await deleteBelowDeckPolicy(id);
                belowDeckPolicies = belowDeckPolicies.filter(p => p.id !== id);
                render();
            } catch (err) {
                formError = err.message || 'Delete failed.';
                render();
            }
        });
    });

    bindAction('save-policy', () => handleSavePolicy());

    // ─── Reservations ───────────────────────────────────────

    bindAction('create-reservation', () => {
        editingReservation = 'new';
        formError = '';
        render();
    });

    area.querySelectorAll('[data-action="edit-reservation"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            editingReservation = btn.dataset.officer;
            formError = '';
            render();
        });
    });

    area.querySelectorAll('[data-action="toggle-lock"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const officerId = btn.dataset.officer;
            const res = reservations.find(r => r.officerId === officerId);
            if (!res) return;
            try {
                await setReservation(officerId, res.reservedFor, !res.locked, res.notes);
                res.locked = !res.locked;
                render();
            } catch (err) {
                console.error('Toggle lock failed:', err);
            }
        });
    });

    area.querySelectorAll('[data-action="delete-reservation"]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const officerId = btn.dataset.officer;
            const off = officerById(officerId);
            const confirmed = await showConfirmDialog({
                title: `Remove reservation for ${off?.name || officerId}?`,
                severity: 'info',
            });
            if (!confirmed) return;
            try {
                await deleteReservation(officerId);
                reservations = reservations.filter(r => r.officerId !== officerId);
                render();
            } catch (err) {
                console.error('Delete reservation failed:', err);
            }
        });
    });

    bindAction('save-reservation', () => handleSaveReservation());

    // ─── Cancel form (shared) ───────────────────────────────

    area.querySelectorAll('[data-action="cancel-form"]').forEach(btn => {
        btn.addEventListener('click', () => {
            editingCoreId = null;
            editingLoadoutId = null;
            editingPolicyId = null;
            editingReservation = null;
            formError = '';
            render();
        });
    });

    // ─── Enter-to-save ──────────────────────────────────────

    const formEl = area.querySelector('.crews-form:not(.crews-variant-form)');
    if (formEl) {
        formEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') {
                e.preventDefault();
                if (editingCoreId) handleSaveCore();
                else if (editingLoadoutId) handleSaveLoadout();
                else if (editingPolicyId) handleSavePolicy();
                else if (editingReservation) handleSaveReservation();
            }
        });
    }
}

/** Bind a single-instance action button by data-action value */
function bindAction(action, handler) {
    const area = $('#crews-area');
    const btn = area?.querySelector(`[data-action="${action}"]`);
    if (btn) btn.addEventListener('click', handler);
}

// ═══════════════════════════════════════════════════════════
// SAVE HANDLERS
// ═══════════════════════════════════════════════════════════

async function handleSaveCore() {
    const area = $('#crews-area');
    const form = area?.querySelector('.crews-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }

    const members = [];
    for (const slot of ['captain', 'bridge_1', 'bridge_2']) {
        const officerId = getValue(`slot_${slot}`);
        if (officerId) members.push({ officerId, slot });
    }
    if (members.length === 0) { formError = 'Assign at least one officer.'; render(); return; }

    const notes = getValue('notes') || null;

    try {
        if (editingCoreId === 'new') {
            const resp = await createBridgeCore(name, members, notes);
            const created = resp?.bridgeCore ?? resp;
            bridgeCores.push(created);
        } else {
            await updateBridgeCore(editingCoreId, { name, notes });
            await setBridgeCoreMembers(editingCoreId, members);
            const idx = bridgeCores.findIndex(c => c.id === editingCoreId);
            if (idx !== -1) bridgeCores[idx] = { ...bridgeCores[idx], name, notes, members };
        }
        editingCoreId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSaveLoadout() {
    const area = $('#crews-area');
    const form = area?.querySelector('.crews-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }

    const shipId = getValue('shipId') || null;
    const bridgeCoreId = getValue('bridgeCoreId') ? parseInt(getValue('bridgeCoreId'), 10) : null;
    const belowDeckPolicyId = getValue('belowDeckPolicyId') ? parseInt(getValue('belowDeckPolicyId'), 10) : null;
    const priority = parseInt(getValue('priority'), 10) || 0;
    const isActive = getValue('isActive');
    const notes = (getValue('notes') || '').trim() || null;

    // Collect checked intents
    const intentKeys = [];
    form.querySelectorAll('[data-intent-key]').forEach(cb => {
        if (cb.checked) intentKeys.push(cb.dataset.intentKey);
    });

    // Parse comma-separated tags
    const tagsRaw = (getValue('tags') || '').trim();
    const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

    const data = { name, shipId, bridgeCoreId, belowDeckPolicyId, priority, isActive, intentKeys, tags, notes };

    try {
        if (editingLoadoutId === 'new') {
            const resp = await createCrewLoadout(data);
            const created = resp?.loadout ?? resp;
            loadouts.push(created);
        } else {
            await updateCrewLoadout(editingLoadoutId, data);
            const idx = loadouts.findIndex(l => l.id === editingLoadoutId);
            if (idx !== -1) loadouts[idx] = { ...loadouts[idx], ...data };
        }
        editingLoadoutId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSaveVariant(loadoutId) {
    const area = $('#crews-area');
    const form = area?.querySelector('.crews-variant-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        return el ? el.value : '';
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }

    // Build patch
    const patch = {};
    const bridge = {};
    for (const slot of ['captain', 'bridge_1', 'bridge_2']) {
        const val = getValue(`patch_${slot}`);
        if (val) bridge[slot] = val;
    }
    if (Object.keys(bridge).length > 0) patch.bridge = bridge;

    const policyOverride = getValue('patch_policy');
    if (policyOverride) patch.below_deck_policy_id = parseInt(policyOverride, 10);

    const notes = (getValue('notes') || '').trim() || null;

    try {
        if (editingVariantId === 'new') {
            const resp = await createVariant(loadoutId, name, patch, notes);
            const created = resp?.variant ?? resp;
            if (!loadoutVariants[loadoutId]) loadoutVariants[loadoutId] = [];
            loadoutVariants[loadoutId].push(created);
        } else {
            await updateVariant(editingVariantId, { name, patch, notes });
            const variants = loadoutVariants[loadoutId] || [];
            const idx = variants.findIndex(v => v.id === editingVariantId);
            if (idx !== -1) variants[idx] = { ...variants[idx], name, patch, notes };
        }
        editingVariantId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSavePolicy() {
    const area = $('#crews-area');
    const form = area?.querySelector('.crews-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const name = (getValue('name') || '').trim();
    if (!name) { formError = 'Name is required.'; render(); return; }

    const mode = getValue('mode') || 'stats_then_bda';
    const pinnedSelect = form.querySelector('[data-form-field="pinned"]');
    const pinned = pinnedSelect
        ? Array.from(pinnedSelect.selectedOptions).map(o => o.value)
        : [];
    const maxSlots = getValue('maxSlots') ? parseInt(getValue('maxSlots'), 10) : undefined;
    const avoidReserved = getValue('avoidReserved');
    const notes = (getValue('notes') || '').trim() || null;

    const spec = {};
    if (pinned.length > 0) spec.pinned = pinned;
    if (maxSlots) spec.max_slots = maxSlots;
    if (avoidReserved) spec.avoid_reserved = true;

    try {
        if (editingPolicyId === 'new') {
            const resp = await createBelowDeckPolicy(name, mode, spec, notes);
            const created = resp?.belowDeckPolicy ?? resp;
            belowDeckPolicies.push(created);
        } else {
            await updateBelowDeckPolicy(editingPolicyId, { name, mode, spec, notes });
            const idx = belowDeckPolicies.findIndex(p => p.id === editingPolicyId);
            if (idx !== -1) belowDeckPolicies[idx] = { ...belowDeckPolicies[idx], name, mode, spec, notes };
        }
        editingPolicyId = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

async function handleSaveReservation() {
    const area = $('#crews-area');
    const form = area?.querySelector('.crews-form');
    if (!form) return;

    const getValue = (f) => {
        const el = form.querySelector(`[data-form-field="${f}"]`);
        if (!el) return '';
        if (el.type === 'checkbox') return el.checked;
        return el.value;
    };

    const officerId = editingReservation === 'new' ? getValue('officerId') : editingReservation;
    if (!officerId) { formError = 'Select an officer.'; render(); return; }

    const reservedFor = (getValue('reservedFor') || '').trim();
    if (!reservedFor) { formError = 'Reserved for is required.'; render(); return; }

    const locked = getValue('locked');
    const notes = (getValue('notes') || '').trim() || null;

    try {
        await setReservation(officerId, reservedFor, locked, notes);
        const idx = reservations.findIndex(r => r.officerId === officerId);
        const updated = { officerId, reservedFor, locked, notes };
        if (idx !== -1) {
            reservations[idx] = updated;
        } else {
            reservations.push(updated);
        }
        editingReservation = null;
        formError = '';
        render();
    } catch (err) {
        formError = err.message || 'Save failed.';
        render();
    }
}

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function officerById(id) {
    return officers.find(o => o.id === id) ?? null;
}

function getBridgeCoreName(id) {
    if (id == null) return null;
    const core = bridgeCores.find(c => c.id === id);
    return core ? core.name : null;
}

function getPolicyName(id) {
    if (id == null) return null;
    const policy = belowDeckPolicies.find(p => p.id === id);
    return policy ? policy.name : null;
}

function getShipName(id) {
    if (id == null) return null;
    const ship = ships.find(s => s.id === id);
    return ship ? ship.name : null;
}
