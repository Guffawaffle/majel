/**
 * diagnostics.js — Diagnostics Tab Module
 *
 * Majel — STFC Fleet Intelligence System
 *
 * Full diagnostics tab with four sections:
 * 1. System Health — subsystem status from /api/diagnostic
 * 2. Data Summary — reference + overlay counts from /api/diagnostic/summary
 * 3. Query Console — read-only SQL from /api/diagnostic/query
 * 4. Schema Browser — table structure from /api/diagnostic/schema
 */

import { _fetch } from 'api/_fetch.js';

// ─── State ──────────────────────────────────────────────────
let healthData = null;
let summaryData = null;
let schemaData = null;
let activeSection = 'health'; // 'health' | 'summary' | 'query' | 'schema'
let queryHistory = [];
let loading = false;

const $ = (sel) => document.querySelector(sel);

// ─── Preset Queries ─────────────────────────────────────────
const PRESET_QUERIES = [
    { label: "All Officers", sql: "SELECT id, name, rarity, group_name FROM reference_officers ORDER BY name LIMIT 50" },
    { label: "All Ships", sql: "SELECT id, name, ship_class, rarity, faction FROM reference_ships ORDER BY name LIMIT 50" },
    { label: "Ownership Stats", sql: "SELECT ownership_state, COUNT(*) AS count FROM officer_overlay GROUP BY ownership_state" },
    { label: "Recent Overlays", sql: "SELECT o.ref_id, r.name, o.ownership_state, o.updated_at FROM officer_overlay o JOIN reference_officers r ON o.ref_id = r.id ORDER BY o.updated_at DESC LIMIT 20" },
    { label: "Ship Overlays", sql: "SELECT o.ref_id, r.name, o.ownership_state, o.updated_at FROM ship_overlay o JOIN reference_ships r ON o.ref_id = r.id ORDER BY o.updated_at DESC LIMIT 20" },
    { label: "Dock Summary", sql: "SELECT d.dock_number, d.label, d.priority, COUNT(ds.ship_id) AS ships FROM docks d LEFT JOIN dock_ships ds ON d.dock_number = ds.dock_number GROUP BY d.dock_number ORDER BY d.dock_number" },
];

// ─── Public API ─────────────────────────────────────────────

export async function init() {
    const area = $("#diagnostics-area");
    if (!area) return;
    render();
}

export async function refresh() {
    if (loading) return;
    loading = true;
    render();
    try {
        // Load health + summary in parallel on first view
        const [healthRes, summaryRes] = await Promise.all([
            _fetch("/api/diagnostic").then(r => r.json()),
            _fetch("/api/diagnostic/summary").then(r => r.json()),
        ]);
        healthData = healthRes.data;
        summaryData = summaryRes.data;
    } catch (err) {
        console.error("Diagnostics fetch failed:", err);
    } finally {
        loading = false;
        render();
    }
}

// ─── Section Navigation ─────────────────────────────────────

function switchSection(section) {
    activeSection = section;
    render();
    // Lazy-load schema on first access
    if (section === 'schema' && !schemaData) {
        loadSchema();
    }
}

async function loadSchema() {
    try {
        const res = await _fetch("/api/diagnostic/schema");
        const json = await res.json();
        schemaData = json.data;
        render();
    } catch (err) {
        console.error("Schema fetch failed:", err);
    }
}

// ─── Query Console ──────────────────────────────────────────

async function executeQuery(sql) {
    const resultsEl = $("#diag-query-results");
    if (!resultsEl) return;
    resultsEl.innerHTML = '<p class="diag-loading">Executing...</p>';

    try {
        const res = await _fetch(`/api/diagnostic/query?sql=${encodeURIComponent(sql)}&limit=200`);
        const json = await res.json();

        if (json.status === "error") {
            resultsEl.innerHTML = `<p class="diag-error">${escapeHtml(json.message)}</p>`;
            return;
        }

        const data = json.data;
        queryHistory.unshift({ sql, rowCount: data.rowCount, time: new Date().toLocaleTimeString() });
        if (queryHistory.length > 20) queryHistory.pop();

        if (!data.rows || data.rows.length === 0) {
            resultsEl.innerHTML = '<p class="diag-muted">No results returned.</p>';
            return;
        }

        const cols = data.columns;
        let html = `<div class="diag-query-meta">${data.rowCount} row${data.rowCount !== 1 ? 's' : ''}${data.truncated ? ` (truncated from ${data.totalBeforeLimit})` : ''} · ${data.durationMs}ms</div>`;
        html += '<div class="diag-table-wrap"><table class="diag-table"><thead><tr>';
        for (const col of cols) {
            html += `<th>${escapeHtml(col)}</th>`;
        }
        html += '</tr></thead><tbody>';
        for (const row of data.rows) {
            html += '<tr>';
            for (const col of cols) {
                const val = row[col];
                html += `<td>${val === null ? '<span class="diag-null">NULL</span>' : escapeHtml(String(val))}</td>`;
            }
            html += '</tr>';
        }
        html += '</tbody></table></div>';
        resultsEl.innerHTML = html;
    } catch (err) {
        resultsEl.innerHTML = `<p class="diag-error">Query failed: ${escapeHtml(err.message)}</p>`;
    }
}

// ─── Rendering ──────────────────────────────────────────────

function render() {
    const area = $("#diagnostics-area");
    if (!area) return;

    let html = '<div class="diag-tabs">';
    const tabs = [
        { key: 'health', icon: '💓', label: 'System Health' },
        { key: 'summary', icon: '📊', label: 'Data Summary' },
        { key: 'query', icon: '🔍', label: 'Query Console' },
        { key: 'schema', icon: '🗂️', label: 'Schema Browser' },
    ];
    for (const tab of tabs) {
        const active = activeSection === tab.key ? ' active' : '';
        html += `<button class="diag-tab${active}" data-section="${tab.key}">${tab.icon} ${tab.label}</button>`;
    }
    html += '</div>';

    if (loading && !healthData) {
        html += '<div class="diag-body"><p class="diag-loading">Loading diagnostics...</p></div>';
    } else if (activeSection === 'health') {
        html += renderHealthSection();
    } else if (activeSection === 'summary') {
        html += renderSummarySection();
    } else if (activeSection === 'query') {
        html += renderQuerySection();
    } else if (activeSection === 'schema') {
        html += renderSchemaSection();
    }

    area.innerHTML = html;
    bindEvents();
}

function renderHealthSection() {
    if (!healthData) return '<div class="diag-body"><p class="diag-muted">No health data loaded yet.</p></div>';

    const d = healthData;
    const status = (s) => s === "connected" || s === "active" || s === "loaded"
        ? `<span class="diag-ok">${s}</span>`
        : `<span class="diag-warn">${s}</span>`;

    let html = '<div class="diag-body"><div class="diag-grid">';

    // System
    html += '<div class="diag-section"><h4>System</h4>';
    html += `<div class="diag-row"><span>Version</span><span>${d.system?.version || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Uptime</span><span>${d.system?.uptime || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Node</span><span>${d.system?.nodeVersion || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Timestamp</span><span>${d.system?.timestamp?.slice(0, 19).replace("T", " ") || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Startup</span>${status(d.system?.startupComplete ? "active" : "pending")}</div>`;
    html += '</div>';

    // Gemini
    html += '<div class="diag-section"><h4>Gemini Engine</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.gemini?.status)}</div>`;
    if (d.gemini?.model) html += `<div class="diag-row"><span>Model</span><span>${d.gemini.model}</span></div>`;
    if (d.gemini?.activeSessions !== undefined) html += `<div class="diag-row"><span>Sessions</span><span>${d.gemini.activeSessions}</span></div>`;
    html += '</div>';

    // Memory
    html += '<div class="diag-section"><h4>Lex Memory</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.memory?.status)}</div>`;
    if (d.memory?.frameCount !== undefined) html += `<div class="diag-row"><span>Frames</span><span>${d.memory.frameCount}</span></div>`;
    if (d.memory?.dbPath) html += `<div class="diag-row"><span>DB Path</span><span class="diag-path">${d.memory.dbPath}</span></div>`;
    html += '</div>';

    // Settings
    html += '<div class="diag-section"><h4>Settings Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.settings?.status)}</div>`;
    if (d.settings?.userOverrides !== undefined) html += `<div class="diag-row"><span>Overrides</span><span>${d.settings.userOverrides}</span></div>`;
    html += '</div>';

    // Sessions
    html += '<div class="diag-section"><h4>Sessions</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.sessions?.status)}</div>`;
    if (d.sessions?.count !== undefined) html += `<div class="diag-row"><span>Count</span><span>${d.sessions.count}</span></div>`;
    html += '</div>';

    // Reference Store
    html += '<div class="diag-section"><h4>Reference Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.referenceStore?.status)}</div>`;
    if (d.referenceStore?.officers !== undefined) html += `<div class="diag-row"><span>Officers</span><span>${d.referenceStore.officers}</span></div>`;
    if (d.referenceStore?.ships !== undefined) html += `<div class="diag-row"><span>Ships</span><span>${d.referenceStore.ships}</span></div>`;
    html += '</div>';

    // Overlay Store
    html += '<div class="diag-section"><h4>Overlay Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.overlayStore?.status)}</div>`;
    if (d.overlayStore?.officerOverlays !== undefined) html += `<div class="diag-row"><span>Officer Overlays</span><span>${d.overlayStore.officerOverlays}</span></div>`;
    if (d.overlayStore?.shipOverlays !== undefined) html += `<div class="diag-row"><span>Ship Overlays</span><span>${d.overlayStore.shipOverlays}</span></div>`;
    html += '</div>';

    // Dock Store
    html += '<div class="diag-section"><h4>Dock Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.dockStore?.status)}</div>`;
    if (d.dockStore?.intents !== undefined) html += `<div class="diag-row"><span>Intents</span><span>${d.dockStore.intents}</span></div>`;
    if (d.dockStore?.docks !== undefined) html += `<div class="diag-row"><span>Docks</span><span>${d.dockStore.docks}</span></div>`;
    html += '</div>';

    html += '</div></div>';
    return html;
}

function renderSummarySection() {
    if (!summaryData) return '<div class="diag-body"><p class="diag-muted">No summary data loaded yet.</p></div>';

    const s = summaryData;
    let html = '<div class="diag-body">';

    // Reference counts
    html += '<div class="diag-summary-grid">';

    // Officers summary
    html += '<div class="diag-summary-card">';
    html += `<h4>Officers <span class="diag-badge">${s.reference?.officers?.total || 0}</span></h4>`;
    if (s.reference?.officers?.byRarity?.length) {
        html += '<div class="diag-breakdown">';
        for (const r of s.reference.officers.byRarity) {
            html += `<div class="diag-breakdown-row"><span>${r.rarity || 'Unknown'}</span><span>${r.count}</span></div>`;
        }
        html += '</div>';
    }
    html += '</div>';

    // Ships summary
    html += '<div class="diag-summary-card">';
    html += `<h4>Ships <span class="diag-badge">${s.reference?.ships?.total || 0}</span></h4>`;
    if (s.reference?.ships?.byClass?.length) {
        html += '<div class="diag-breakdown">';
        for (const c of s.reference.ships.byClass) {
            html += `<div class="diag-breakdown-row"><span>${c.ship_class || 'Unknown'}</span><span>${c.count}</span></div>`;
        }
        html += '</div>';
    }
    html += '</div>';

    // Officer overlay
    html += '<div class="diag-summary-card">';
    html += `<h4>Officer Overlays <span class="diag-badge">${s.overlay?.officers?.total || 0}</span></h4>`;
    if (s.overlay?.officers?.byOwnership?.length) {
        html += '<div class="diag-breakdown">';
        for (const o of s.overlay.officers.byOwnership) {
            html += `<div class="diag-breakdown-row"><span>${o.ownership_state}</span><span>${o.count}</span></div>`;
        }
        html += '</div>';
    } else {
        html += '<p class="diag-muted">No overlays yet</p>';
    }
    html += '</div>';

    // Ship overlay
    html += '<div class="diag-summary-card">';
    html += `<h4>Ship Overlays <span class="diag-badge">${s.overlay?.ships?.total || 0}</span></h4>`;
    if (s.overlay?.ships?.byOwnership?.length) {
        html += '<div class="diag-breakdown">';
        for (const o of s.overlay.ships.byOwnership) {
            html += `<div class="diag-breakdown-row"><span>${o.ownership_state}</span><span>${o.count}</span></div>`;
        }
        html += '</div>';
    } else {
        html += '<p class="diag-muted">No overlays yet</p>';
    }
    html += '</div>';

    html += '</div>'; // summary-grid

    // Sample data
    if (s.samples?.officers?.length || s.samples?.ships?.length) {
        html += '<div class="diag-section"><h4>Sample Data</h4>';
        if (s.samples.officers?.length) {
            html += '<h5>Officers (first 5)</h5>';
            html += '<div class="diag-table-wrap"><table class="diag-table"><thead><tr><th>ID</th><th>Name</th><th>Rarity</th><th>Group</th></tr></thead><tbody>';
            for (const o of s.samples.officers) {
                html += `<tr><td>${escapeHtml(o.id)}</td><td>${escapeHtml(o.name)}</td><td>${escapeHtml(o.rarity || '-')}</td><td>${escapeHtml(o.groupName || '-')}</td></tr>`;
            }
            html += '</tbody></table></div>';
        }
        if (s.samples.ships?.length) {
            html += '<h5>Ships (first 5)</h5>';
            html += '<div class="diag-table-wrap"><table class="diag-table"><thead><tr><th>ID</th><th>Name</th><th>Class</th><th>Rarity</th><th>Faction</th></tr></thead><tbody>';
            for (const sh of s.samples.ships) {
                html += `<tr><td>${escapeHtml(sh.id)}</td><td>${escapeHtml(sh.name)}</td><td>${escapeHtml(sh.shipClass || '-')}</td><td>${escapeHtml(sh.rarity || '-')}</td><td>${escapeHtml(sh.faction || '-')}</td></tr>`;
            }
            html += '</tbody></table></div>';
        }
        html += '</div>';
    }

    html += '</div>'; // diag-body
    return html;
}

function renderQuerySection() {
    let html = '<div class="diag-body">';

    // Preset query buttons
    html += '<div class="diag-presets">';
    for (const p of PRESET_QUERIES) {
        html += `<button class="diag-preset-btn" data-sql="${escapeAttr(p.sql)}">${p.label}</button>`;
    }
    html += '</div>';

    // SQL input
    html += '<div class="diag-query-input">';
    html += '<textarea id="diag-sql-input" class="diag-sql-textarea" rows="3" placeholder="SELECT * FROM reference_officers LIMIT 10" spellcheck="false"></textarea>';
    html += '<button id="diag-run-query" class="diag-run-btn">▶ Run Query</button>';
    html += '</div>';

    // Results area
    html += '<div id="diag-query-results" class="diag-query-results">';
    html += '<p class="diag-muted">Run a query or click a preset to see results.</p>';
    html += '</div>';

    html += '</div>';
    return html;
}

function renderSchemaSection() {
    if (!schemaData) return '<div class="diag-body"><p class="diag-loading">Loading schema...</p></div>';

    let html = '<div class="diag-body">';
    html += `<p class="diag-muted">Database: ${escapeHtml(schemaData.dbPath || '?')}</p>`;

    for (const table of schemaData.tables) {
        html += '<div class="diag-schema-table">';
        html += `<div class="diag-schema-header" data-table="${escapeAttr(table.table)}">`;
        html += `<span class="diag-schema-toggle">▶</span>`;
        html += `<strong>${escapeHtml(table.table)}</strong>`;
        html += `<span class="diag-badge">${table.rowCount} rows</span>`;
        html += '</div>';
        html += `<div class="diag-schema-detail hidden" data-detail="${escapeAttr(table.table)}">`;
        html += '<table class="diag-table"><thead><tr><th>Column</th><th>Type</th><th>Nullable</th><th>PK</th><th>Default</th></tr></thead><tbody>';
        for (const col of table.columns) {
            html += '<tr>';
            html += `<td><strong>${escapeHtml(col.name)}</strong></td>`;
            html += `<td>${escapeHtml(col.type || 'TEXT')}</td>`;
            html += `<td>${col.nullable ? '✓' : ''}</td>`;
            html += `<td>${col.primaryKey ? '🔑' : ''}</td>`;
            html += `<td>${col.defaultValue !== null ? escapeHtml(String(col.defaultValue)) : ''}</td>`;
            html += '</tr>';
        }
        html += '</tbody></table>';
        if (table.indexes?.length) {
            html += '<div class="diag-indexes">';
            for (const idx of table.indexes) {
                html += `<span class="diag-index">${idx.unique ? '🔒' : '📇'} ${escapeHtml(idx.name)}</span>`;
            }
            html += '</div>';
        }
        html += '</div></div>';
    }

    html += '</div>';
    return html;
}

// ─── Event Binding ──────────────────────────────────────────

function bindEvents() {
    // Tab switching
    document.querySelectorAll('.diag-tab').forEach(btn => {
        btn.addEventListener('click', () => switchSection(btn.dataset.section));
    });

    // Query presets
    document.querySelectorAll('.diag-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sqlInput = $('#diag-sql-input');
            if (sqlInput) sqlInput.value = btn.dataset.sql;
            executeQuery(btn.dataset.sql);
        });
    });

    // Run query button
    const runBtn = $('#diag-run-query');
    if (runBtn) {
        runBtn.addEventListener('click', () => {
            const sqlInput = $('#diag-sql-input');
            if (sqlInput && sqlInput.value.trim()) {
                executeQuery(sqlInput.value.trim());
            }
        });
    }

    // SQL textarea keyboard shortcut (Ctrl+Enter to run)
    const sqlInput = $('#diag-sql-input');
    if (sqlInput) {
        sqlInput.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault();
                if (sqlInput.value.trim()) executeQuery(sqlInput.value.trim());
            }
        });
    }

    // Schema table toggles
    document.querySelectorAll('.diag-schema-header').forEach(header => {
        header.addEventListener('click', () => {
            const tableName = header.dataset.table;
            const detail = document.querySelector(`.diag-schema-detail[data-detail="${tableName}"]`);
            const toggle = header.querySelector('.diag-schema-toggle');
            if (detail) {
                detail.classList.toggle('hidden');
                if (toggle) toggle.textContent = detail.classList.contains('hidden') ? '▶' : '▼';
            }
        });
    });
}

// ─── Helpers ────────────────────────────────────────────────

function escapeHtml(str) {
    const el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
}

function escapeAttr(str) {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
