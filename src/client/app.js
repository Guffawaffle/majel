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
import * as fleetManager from './fleet-manager.js';
import * as catalog from './catalog.js';

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
const diagnosticBtn = $("#diagnostic-btn");
const diagnosticDialog = $("#diagnostic-dialog");
const diagnosticClose = $("#diagnostic-close");
const diagnosticContent = $("#diagnostic-content");

// View switching elements
const setupGuide = $("#setup-guide");
const chatArea = $("#chat-area");
const inputArea = $("#input-area");
const setupGemini = $("#setup-gemini");
const drydockArea = $("#drydock-area");
const fleetManagerArea = $("#fleet-manager-area");
const catalogArea = $("#catalog-area");
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

// ─── Diagnostic ─────────────────────────────────────────────
function renderDiagnostic(d) {
    const status = (s) => s === "connected" || s === "active" || s === "loaded"
        ? `<span class="diag-ok">${s}</span>`
        : `<span class="diag-warn">${s}</span>`;

    let html = '<div class="diag-grid">';

    // System
    html += '<div class="diag-section">';
    html += '<h4>System</h4>';
    html += `<div class="diag-row"><span>Version</span><span>${d.system?.version || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Uptime</span><span>${d.system?.uptime || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Node</span><span>${d.system?.nodeVersion || "?"}</span></div>`;
    html += `<div class="diag-row"><span>Timestamp</span><span>${d.system?.timestamp?.slice(0, 19).replace("T", " ") || "?"}</span></div>`;
    html += '</div>';

    // Gemini
    html += '<div class="diag-section">';
    html += '<h4>Gemini Engine</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.gemini?.status)}</div>`;
    if (d.gemini?.model) html += `<div class="diag-row"><span>Model</span><span>${d.gemini.model}</span></div>`;
    if (d.gemini?.sessionMessageCount !== undefined) html += `<div class="diag-row"><span>Session msgs</span><span>${d.gemini.sessionMessageCount}</span></div>`;
    html += '</div>';

    // Memory
    html += '<div class="diag-section">';
    html += '<h4>Lex Memory</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.memory?.status)}</div>`;
    if (d.memory?.frameCount !== undefined) html += `<div class="diag-row"><span>Frames</span><span>${d.memory.frameCount}</span></div>`;
    html += '</div>';

    // Settings
    html += '<div class="diag-section">';
    html += '<h4>Settings Store</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.settings?.status)}</div>`;
    if (d.settings?.userOverrides !== undefined) html += `<div class="diag-row"><span>Overrides</span><span>${d.settings.userOverrides}</span></div>`;
    html += '</div>';

    // Fleet
    html += '<div class="diag-section">';
    html += '<h4>Fleet Data</h4>';
    html += `<div class="diag-row"><span>Status</span>${status(d.fleet?.status)}</div>`;
    if (d.fleet?.totalChars) html += `<div class="diag-row"><span>Size</span><span>${d.fleet.totalChars.toLocaleString()} chars</span></div>`;
    if (d.fleet?.sections) html += `<div class="diag-row"><span>Sections</span><span>${d.fleet.sections.length}</span></div>`;
    if (d.fleet?.fetchedAt) html += `<div class="diag-row"><span>Fetched</span><span>${d.fleet.fetchedAt.slice(0, 19).replace("T", " ")}</span></div>`;
    if (d.fleet?.error) html += `<div class="diag-row"><span>Error</span><span class="diag-warn">${d.fleet.error}</span></div>`;
    html += '</div>';

    html += '</div>';
    return html;
}

// ─── View Switching ─────────────────────────────────────────
function setActiveNav(view) {
    sidebarNavBtns.forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
}

function setTitleBar(icon, heading, subtitle = "") {
    if (titleBarHeading) titleBarHeading.textContent = `${icon} ${heading}`;
    if (titleBarSubtitle) titleBarSubtitle.textContent = subtitle;
    if (titleBar) titleBar.classList.remove("hidden");
}

function showSetup(health) {
    setupGuide.classList.remove("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (fleetManagerArea) fleetManagerArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
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
    if (fleetManagerArea) fleetManagerArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    setActiveNav("chat");
    setTitleBar("💬", "Chat", "Gemini-powered fleet advisor");
}

function showDrydock() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.remove("hidden");
    if (fleetManagerArea) fleetManagerArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    setActiveNav("drydock");
    setTitleBar("🔧", "Drydock", "Configure docks, ships & crew");
    drydock.refresh();
}

function showFleetManager() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (fleetManagerArea) fleetManagerArea.classList.remove("hidden");
    if (catalogArea) catalogArea.classList.add("hidden");
    setActiveNav("fleet");
    setTitleBar("🚀", "Fleet Roster", "Officers & ships");
    fleetManager.refresh();
}

function showCatalog() {
    setupGuide.classList.add("hidden");
    chatArea.classList.add("hidden");
    inputArea.classList.add("hidden");
    if (drydockArea) drydockArea.classList.add("hidden");
    if (fleetManagerArea) fleetManagerArea.classList.add("hidden");
    if (catalogArea) catalogArea.classList.remove("hidden");
    setActiveNav("catalog");
    setTitleBar("📋", "Catalog", "Reference data & ownership tracking");
    catalog.refresh();
}

// ─── Event Handlers ─────────────────────────────────────────
historyBtn.addEventListener("click", () => loadHistory());

// Sidebar navigation
sidebarNavBtns.forEach(btn => {
    btn.addEventListener("click", () => {
        const view = btn.dataset.view;
        if (view === "drydock") {
            showDrydock();
            currentMode = "drydock";
        } else if (view === "fleet") {
            showFleetManager();
            currentMode = "fleet";
        } else if (view === "catalog") {
            showCatalog();
            currentMode = "catalog";
        } else {
            showChat();
            currentMode = "chat";
        }
        // Close sidebar on mobile
        sidebar.classList.remove("open");
        sidebarOverlay.classList.add("hidden");
    });
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

diagnosticBtn.addEventListener("click", async () => {
    diagnosticContent.innerHTML = '<p class="diagnostic-loading">Querying subsystems...</p>';
    diagnosticDialog.showModal();
    sidebar.classList.remove("open");
    sidebarOverlay.classList.add("hidden");
    try {
        const res = await fetch("/api/diagnostic");
        const data = (await res.json()).data;
        diagnosticContent.innerHTML = renderDiagnostic(data);
    } catch {
        diagnosticContent.innerHTML = '<p class="diagnostic-error">Failed to reach /api/diagnostic</p>';
    }
});

diagnosticClose.addEventListener("click", () => diagnosticDialog.close());

// ─── Init ───────────────────────────────────────────────────
(async () => {
    // Initialize all modules
    chat.init(sessions.refreshSessionList);
    sessions.init();
    await initOpsLevel();
    await drydock.init();
    await fleetManager.init();
    await catalog.init();

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
        showChat();
        currentMode = "chat";
        chatInput.focus();
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
        } else if (currentMode !== "setup" && currentMode !== "drydock" && currentMode !== "fleet" && currentMode !== "catalog" && h.gemini !== "connected") {
            showSetup(h);
            currentMode = "setup";
        }
    }, 10000);
})();
