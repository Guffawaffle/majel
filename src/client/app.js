/**
 * app.js — Majel Frontend Shell
 *
 * Majel — STFC Fleet Intelligence System
 * Named in honor of Majel Barrett-Roddenberry (1932–2008)
 *
 * Thin initialization shell that coordinates modules:
 * - Health check & view switching (setup vs chat)
 * - Diagnostic & recall dialogs
 * - History & roster refresh tools
 */

import * as api from './api.js';
import * as chat from './chat.js';
import * as sessions from './sessions.js';
import * as drydock from './drydock.js';
import * as catalog from './catalog.js';
import * as fleet from './fleet.js';
import * as diagnostics from './diagnostics.js';

// ─── DOM Elements ───────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const statusDot = $("#status-indicator");
const mobileStatusDot = $("#mobile-status-dot");
const statusText = $("#status-text");
const chatInput = $("#chat-input");
const sendBtn = $("#send-btn");

// Dialogs & tools
const historyBtn = $("#history-btn");
const recallBtn = $("#recall-btn");
const recallDialog = $("#recall-dialog");
const recallForm = $("#recall-form");
const recallInput = $("#recall-input");
const recallResults = $("#recall-results");
const recallClose = $("#recall-close");
const titleBackBtn = $("#title-back-btn");

// View switching elements
const setupGuide = $("#setup-guide");
const chatArea = $("#chat-area");
const inputArea = $("#input-area");
const setupGemini = $("#setup-gemini");
const drydockArea = $("#drydock-area");
const catalogArea = $("#catalog-area");
const fleetArea = $("#fleet-area");
const diagnosticsArea = $("#diagnostics-area");
const titleBar = $("#title-bar");
const titleBarHeading = $("#title-bar-heading");
const titleBarSubtitle = $("#title-bar-subtitle");
const sidebarNavBtns = document.querySelectorAll(".sidebar-nav-btn[data-view]");

// Mobile sidebar
const sidebar = $("#sidebar");
const sidebarOverlay = $("#sidebar-overlay");

// ─── State ──────────────────────────────────────────────────
let isOnline = false;
let currentMode = "loading";
let opsLevel = 1;
let userRole = null; // set after getMe()
let viewHistory = []; // stack for back button

// ─── Ops Level ──────────────────────────────────────────────
async function initOpsLevel() {
    try {
        const settings = await api.loadFleetSettings();
        if (settings.settings) {
            const ol = settings.settings.find(s => s.key === "fleet.opsLevel");
            if (ol) opsLevel = parseInt(ol.value, 10) || 1;
        }
    } catch { /* ignore — will show 1 */ }
    updateOpsDisplay();
}

function updateOpsDisplay() {
    const el = $("#ops-level-value");
    if (el) el.textContent = opsLevel;
}

/** Exported so drydock can read the current ops level */
export function getOpsLevel() { return opsLevel; }

// ─── Health Check & Status Updates ─────────────────────────
async function checkHealthAndUpdateUI() {
    const data = await api.checkHealth();

    if (!data) {
        // Offline
        isOnline = false;
        statusDot.className = "status-dot offline";
        if (mobileStatusDot) mobileStatusDot.className = "status-dot offline";
        statusText.textContent = "Offline";
        chatInput.disabled = true;
        sendBtn.disabled = true;
        return null;
    }

    isOnline = data.status === "online";

    // Status dots
    const dotClass = isOnline && data.gemini === "connected"
        ? "status-dot online"
        : isOnline
            ? "status-dot loading"
            : "status-dot loading";

    statusDot.className = dotClass;
    if (mobileStatusDot) mobileStatusDot.className = dotClass;

    statusText.textContent = isOnline && data.gemini === "connected"
        ? "Online"
        : isOnline
            ? "Setup needed"
            : "Initializing...";

    // Enable/disable input
    const canChat = data.gemini === "connected";
    chatInput.disabled = !canChat;
    if (!canChat) sendBtn.disabled = true;

    return data;
}

// ─── History Tool ───────────────────────────────────────────
async function loadHistory() {
    try {
        const data = await api.loadHistory();

        if (data.lex && data.lex.length > 0) {
            chat.addMessage("system", `── Lex Memory: ${data.lex.length} past conversations ──`);
            data.lex.forEach((item) => {
                const time = new Date(item.timestamp).toLocaleString();
                chat.addMessage("system", `[${time}] ${item.summary}`);
            });
        } else {
            chat.addMessage("system", "No conversation history found in Lex memory.");
        }
    } catch (err) {
        chat.addMessage("error", `Failed to load history: ${err.message}`);
    }
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
}

// ─── Recall Search ──────────────────────────────────────────
async function searchRecall(query) {
    recallResults.innerHTML = '<p style="color: var(--text-muted); padding: 8px 0;">Searching...</p>';

    try {
        const result = await api.searchRecall(query);

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

// ─── View Switching & Hash Routing ──────────────────────────
const VALID_VIEWS = ['chat', 'drydock', 'catalog', 'fleet', 'diagnostics'];

function setActiveNav(view) {
    sidebarNavBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
}

function updateHash(view) {
    if (window.location.hash !== `#/${view}`) {
        history.replaceState(null, '', `#/${view}`);
    }
}

function getViewFromHash() {
    const hash = window.location.hash.replace(/^#\/?/, '');
    return VALID_VIEWS.includes(hash) ? hash : null;
}

function setTitleBar(icon, heading, subtitle = "") {
    if (titleBarHeading) titleBarHeading.textContent = `${icon} ${heading}`;
    if (titleBarSubtitle) titleBarSubtitle.textContent = subtitle;
    if (titleBar) titleBar.classList.remove("hidden");
}

/**
 * Show/hide sidebar items based on the current userRole.
 * - Diagnostics: Admiral only
 * - Lex Memory + Memory Recall: hidden (not yet wired to user accounts)
 */
function applySidebarGating() {
    // Diagnostics — Admiral only
    const diagBtn = document.querySelector('.sidebar-nav-btn[data-view="diagnostics"]');
    if (diagBtn) diagBtn.classList.toggle("hidden", userRole !== "admiral");

    // Lex Memory & Recall — hidden for now (QA-001-6)
    if (historyBtn) historyBtn.classList.add("hidden");
    if (recallBtn) recallBtn.classList.add("hidden");
}

function showSetup(health) {
    setupGuide.classList.remove("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    if (fleetArea) fleetArea.classList.add("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.add("hidden");
    if (titleBar) titleBar.classList.add("hidden");

    if (health.gemini === "connected") {
        setupGemini.classList.add("done");
    } else {
        setupGemini.classList.remove("done");
    }
}

function showChat() {
    setupGuide.classList.add("hidden");
    chatArea.classList.remove("hidden");
    inputArea.classList.remove("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    if (fleetArea) fleetArea.classList.add("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.add("hidden");
    setActiveNav("chat");
    setTitleBar("💬", "Chat", "Gemini-powered fleet advisor");
    updateHash("chat");
}

function showDrydock() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.remove("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    if (fleetArea) fleetArea.classList.add("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.add("hidden");
    setActiveNav("drydock");
    setTitleBar("🔧", "Drydock", "Configure docks, ships & crew");
    updateHash("drydock");
    drydock.refresh();
}

function showCatalog() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.remove("hidden");
    if (fleetArea) fleetArea.classList.add("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.add("hidden");
    setActiveNav("catalog");
    setTitleBar("📋", "Catalog", "Reference data & ownership tracking");
    updateHash("catalog");
    catalog.refresh();
}

function showDiagnostics() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    if (fleetArea) fleetArea.classList.add("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.remove("hidden");
    setActiveNav("diagnostics");
    setTitleBar("⚡", "Diagnostics", "System health, data summary & query console");
    updateHash("diagnostics");
    diagnostics.refresh();
}

function showFleet() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    if (fleetArea) fleetArea.classList.remove("hidden");
    if (diagnosticsArea) diagnosticsArea.classList.add("hidden");
    setActiveNav("fleet");
    setTitleBar("🚀", "Fleet", "Your owned roster — levels, ranks & power");
    updateHash("fleet");
    fleet.refresh();
}

function navigateToView(view, { pushHistory = true } = {}) {
    // Track view history for back button
    if (pushHistory && currentMode && currentMode !== "loading" && currentMode !== "setup" && currentMode !== view) {
        viewHistory.push(currentMode);
        if (viewHistory.length > 20) viewHistory.shift();
    }

    if (view === 'drydock') { showDrydock(); currentMode = 'drydock'; }
    else if (view === 'catalog') { showCatalog(); currentMode = 'catalog'; }
    else if (view === 'fleet') { showFleet(); currentMode = 'fleet'; }
    else if (view === 'diagnostics' && userRole === 'admiral') { showDiagnostics(); currentMode = 'diagnostics'; }
    else { showChat(); currentMode = 'chat'; }

    // Back button: visible when there's history and not on chat (home)
    if (titleBackBtn) {
        titleBackBtn.classList.toggle("hidden", viewHistory.length === 0 || currentMode === 'chat');
    }
}

// ─── Event Handlers ─────────────────────────────────────────
historyBtn.addEventListener("click", () => loadHistory());

// Sidebar navigation
sidebarNavBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        navigateToView(btn.dataset.view);
        // Close sidebar on mobile
        sidebar.classList.remove("open");
        sidebarOverlay.classList.add("hidden");
    });
});

// Hash-based routing: browser back/forward + refresh
window.addEventListener('hashchange', () => {
    const view = getViewFromHash();
    if (view && view !== currentMode) navigateToView(view);
});

// Ops level badge click
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
        api.saveFleetSetting("fleet.opsLevel", val);
        updateOpsDisplay();
    });
}

recallBtn.addEventListener("click", () => {
    recallResults.innerHTML = "";
    recallInput.value = "";
    recallDialog.showModal();
    recallInput.focus();
    // Close sidebar on mobile
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
});

recallForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = recallInput.value.trim();
    if (q) searchRecall(q);
});

recallClose.addEventListener("click", () => recallDialog.close());

// Back button
if (titleBackBtn) {
    titleBackBtn.addEventListener("click", () => {
        const prev = viewHistory.pop();
        if (prev) navigateToView(prev, { pushHistory: false });
    });
}

// ─── Init ───────────────────────────────────────────────────
(async () => {
    // Initialize all modules
    chat.init(sessions.refreshSessionList);
    sessions.init();
    await initOpsLevel();
    await drydock.init();
    await catalog.init();
    await fleet.init();
    await diagnostics.init();

    // Fetch user identity for sidebar gating
    const me = await api.getMe();
    userRole = me?.role ?? null;
    applySidebarGating();

    // Initial health check
    const health = await checkHealthAndUpdateUI();

    if (!health) {
        chatArea.classList.remove("hidden");
        inputArea.classList.add("hidden");
        chat.addMessage("error", "Could not connect to Ariadne server. Is it running?");
        chat.addMessage("system", "Expected: npm run dev");
        currentMode = "loading";
    } else if (health.gemini !== "connected") {
        showSetup(health);
        currentMode = "setup";
    } else {
        // Restore view from URL hash, default to chat
        const savedView = getViewFromHash();
        if (savedView && savedView !== 'chat') {
            navigateToView(savedView);
        } else {
            showChat();
            currentMode = "chat";
            chatInput.focus();
        }
    }

    // Poll health every 10s
    setInterval(async () => {
        const h = await checkHealthAndUpdateUI();
        if (!h) return;

        if (currentMode === "setup" && h.gemini === "connected") {
            showChat();
            currentMode = "chat";
            chat.addMessage("system", "✅ Configuration detected — Aria is online, Admiral.");
            chatInput.focus();
        } else if (currentMode !== "setup" && currentMode !== "drydock" && currentMode !== "catalog" && currentMode !== "fleet" && currentMode !== "diagnostics" && h.gemini !== "connected") {
            showSetup(h);
            currentMode = "setup";
        }
    }, 10000);
})();
