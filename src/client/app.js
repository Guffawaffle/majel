/**
 * app.js — Majel Frontend Shell
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Thin initialization shell:
 * - View registration & router setup
 * - Health check & setup guide
 * - Ops level management
 * - Recall dialog
 * - Auth & logout
 */

import { getMe } from 'api/auth.js';
import { checkHealth } from 'api/health.js';
import { searchRecall as apiSearchRecall } from 'api/chat.js';
import { saveFleetSetting, loadFleetSettings } from 'api/settings.js';
import { _fetch } from 'api/_fetch.js';
import * as chat from 'views/chat/chat.js';
import * as sessions from 'views/chat/sessions.js';
import * as drydock from 'views/drydock/drydock.js';
import * as catalog from 'views/catalog/catalog.js';
import * as fleet from 'views/fleet/fleet.js';
import * as diagnostics from 'views/diagnostics/diagnostics.js';
import * as admin from 'views/admiral/admiral.js';
import * as router from 'router';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusDot = $("#status-indicator");
const mobileStatusDot = $("#mobile-status-dot");
const statusText = $("#status-text");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");

// Recall dialog
const recallDialog = $("#recall-dialog");
const recallForm = $("#recall-form");
const recallInput = $("#recall-input");
const recallResults = $("#recall-results");
const recallClose = $("#recall-close");
const logoutBtn = $("#logout-btn");

// View areas (for registration — views self-register in Phase 3b)
const setupGuide = $("#setup-guide");
const chatArea = $("#chat-area");
const inputArea = $("#input-area");
const setupGemini = $("#setup-gemini");
const drydockArea = $("#drydock-area");
const catalogArea = $("#catalog-area");
const fleetArea = $("#fleet-area");
const diagnosticsArea = $("#diagnostics-area");
const adminArea = $("#admin-area");

// ─── State ──────────────────────────────────────────────────
let isOnline = false;
let appState = "loading"; // "loading" | "setup" | "active"
let opsLevel = 1;
let userRole = null;

// ─── Ops Level ──────────────────────────────────────────────
async function initOpsLevel() {
    try {
        const settings = await loadFleetSettings();
        if (settings.settings) {
            const ol = settings.settings.find(s => s.key === "fleet.opsLevel");
            if (ol) opsLevel = parseInt(ol.value, 10) || 1;
        }
    } catch { /* ignore */ }
    updateOpsDisplay();
}

function updateOpsDisplay() {
    const el = $("#ops-level-value");
    if (el) el.textContent = opsLevel;
}

/** Exported so drydock can read the current ops level */
export function getOpsLevel() { return opsLevel; }

// ─── Health Check ───────────────────────────────────────────
async function checkHealthAndUpdateUI() {
    const data = await checkHealth();

    if (!data) {
        isOnline = false;
        statusDot.className = "status-dot offline";
        if (mobileStatusDot) mobileStatusDot.className = "status-dot offline";
        statusText.textContent = "Offline";
        chatInput.disabled = true;
        sendBtn.disabled = true;
        return null;
    }

    isOnline = data.status === "online";

    const dotClass = isOnline && data.gemini === "connected"
        ? "status-dot online"
        : "status-dot loading";

    statusDot.className = dotClass;
    if (mobileStatusDot) mobileStatusDot.className = dotClass;

    statusText.textContent = isOnline && data.gemini === "connected"
        ? "Online"
        : isOnline
            ? "Setup needed"
            : "Initializing...";

    const canChat = data.gemini === "connected";
    chatInput.disabled = !canChat;
    if (!canChat) sendBtn.disabled = true;

    return data;
}

// ─── Recall Search ──────────────────────────────────────────
async function searchRecall(query) {
    recallResults.innerHTML = '<p style="color: var(--text-muted); padding: 8px 0;">Searching...</p>';

    try {
        const result = await apiSearchRecall(query);

        if (!result.ok) {
            recallResults.innerHTML = `<p class="recall-item" style="color: var(--accent-red)">${result.error?.message || "Error"}</p>`;
            return;
        }

        if (result.data.results.length === 0) {
            recallResults.innerHTML = '<p class="recall-item" style="color: var(--text-muted)">No results found.</p>';
            return;
        }

        recallResults.innerHTML = result.data.results
            .map(
                (r) => `
        <div class="recall-item">
          <div>${r.summary}</div>
          <div class="timestamp">${new Date(r.timestamp).toLocaleString()}</div>
          ${r.keywords?.length ? `<div class="timestamp">Keywords: ${r.keywords.join(", ")}</div>` : ""}
        </div>
      `
            )
            .join("");
    } catch (err) {
        recallResults.innerHTML = `<p class="recall-item" style="color: var(--accent-red)">Error: ${err.message}</p>`;
    }
}

// ─── Setup Guide ────────────────────────────────────────────
function showSetup(health) {
    // Hide all registered view areas
    for (const [, v] of router.getRegisteredViews()) {
        if (v.area) v.area.classList.add('hidden');
        for (const extra of v.extraAreas) {
            if (extra) extra.classList.add('hidden');
        }
    }
    setupGuide.classList.remove("hidden");
    const titleBar = $("#title-bar");
    if (titleBar) titleBar.classList.add("hidden");

    if (health.gemini === "connected") {
        setupGemini.classList.add("done");
    } else {
        setupGemini.classList.remove("done");
    }
}

// ─── Event Handlers ─────────────────────────────────────────

// Ops level badge
const opsBtn = $("#ops-level-global");
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
        saveFleetSetting("fleet.opsLevel", val);
        updateOpsDisplay();
    });
}

// Recall dialog
const recallBtn = $("#recall-btn");
if (recallBtn) {
    recallBtn.addEventListener("click", () => {
        recallResults.innerHTML = "";
        recallInput.value = "";
        recallDialog.showModal();
        recallInput.focus();
        // Close sidebar on mobile
        const sidebar = $("#sidebar");
        const overlay = $("#sidebar-overlay");
        if (sidebar) sidebar.classList.remove("open");
        if (overlay) overlay.classList.add("hidden");
    });
}

recallForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = recallInput.value.trim();
    if (q) searchRecall(q);
});

recallClose.addEventListener("click", () => recallDialog.close());

// Logout
if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
        try { await _fetch("/api/auth/logout", { method: "POST" }); } catch { }
        window.location.href = "/";
    });
}

// ─── Init ───────────────────────────────────────────────────
(async () => {
    // ── Register views ──
    router.registerView('chat', {
        area: chatArea,
        extraAreas: [inputArea],
        icon: '💬', title: 'Chat', subtitle: 'Gemini-powered fleet advisor',
        cssHref: 'views/chat/chat.css',
        refresh: () => { },
    });
    router.registerView('drydock', {
        area: drydockArea,
        icon: '🔧', title: 'Drydock', subtitle: 'Configure docks, ships & crew',
        cssHref: 'views/drydock/drydock.css',
        refresh: () => drydock.refresh(),
    });
    router.registerView('catalog', {
        area: catalogArea,
        icon: '📋', title: 'Catalog', subtitle: 'Reference data & ownership tracking',
        cssHref: 'views/catalog/catalog.css',
        refresh: () => catalog.refresh(),
    });
    router.registerView('fleet', {
        area: fleetArea,
        icon: '🚀', title: 'Fleet', subtitle: 'Your owned roster — levels, ranks & power',
        cssHref: 'views/fleet/fleet.css',
        refresh: () => fleet.refresh(),
    });
    router.registerView('diagnostics', {
        area: diagnosticsArea,
        icon: '⚡', title: 'Diagnostics', subtitle: 'System health, data summary & query console',
        cssHref: 'views/diagnostics/diagnostics.css',
        refresh: () => diagnostics.refresh(),
        gate: 'admiral',
    });
    router.registerView('admin', {
        area: adminArea,
        icon: '🛡️', title: 'Admiral Console', subtitle: 'User management, invites & sessions',
        cssHref: 'views/admiral/admiral.css',
        refresh: () => admin.refresh(),
        gate: 'admiral',
    });

    // ── Initialize routing ──
    router.initRouting();

    // ── Eager-initialize all modules (lazy init deferred to Phase 3b) ──
    chat.init(sessions.refreshSessionList);
    sessions.init();
    await initOpsLevel();
    await drydock.init();
    await catalog.init();
    await fleet.init();
    await diagnostics.init();
    await admin.init();

    // Mark all as initialized (router won't re-init on first navigation)
    ['chat', 'drydock', 'catalog', 'fleet', 'diagnostics', 'admin'].forEach(
        v => router.markInitialized(v)
    );

    // ── Auth & gating ──
    const me = await getMe();
    userRole = me?.role ?? null;
    router.setUserRoleFn(() => userRole);
    router.applySidebarGating();
    catalog.setAdminMode(userRole === 'admiral');
    admin.setCurrentUser(me?.email ?? null);

    // ── Initial health check ──
    const health = await checkHealthAndUpdateUI();

    if (!health) {
        // Offline — status indicators show state. Show chat with input hidden.
        await router.navigateToView('chat');
        if (inputArea) inputArea.classList.add('hidden');
        appState = "loading";
    } else if (health.gemini !== "connected") {
        showSetup(health);
        appState = "setup";
    } else {
        const savedView = router.getViewFromHash();
        if (savedView && savedView !== 'chat') {
            await router.navigateToView(savedView);
        } else {
            await router.navigateToView('chat');
            chatInput.focus();
        }
        appState = "active";
    }

    // ── Health polling (10s) ──
    setInterval(async () => {
        const h = await checkHealthAndUpdateUI();
        if (!h) return;

        if (appState === "setup" && h.gemini === "connected") {
            await router.navigateToView('chat');
            chatInput.focus();
            appState = "active";
        } else if (appState === "active" && h.gemini !== "connected"
            && router.getCurrentView() === 'chat') {
            // Only show setup when on chat — don't interrupt other views
            showSetup(h);
            appState = "setup";
        }
    }, 10000);
})();
